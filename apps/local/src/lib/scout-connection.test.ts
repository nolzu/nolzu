import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addScoutSource, openDatabase, scoutFindings, scoutSources } from '@nolzu/core/node';
import type { Keychain, SentryHttp } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Probes, testConnection } from './scout-connection.ts';
import { logsReadable } from './scout-search.ts';
import { sentryReadable } from './scout-sentry.ts';
import { ticketsReadable } from './scout-tickets.ts';

// Not a token of anything. It only has to be a string nothing else here writes.
const TOKEN = 'abc123notatoken';

let dir = '';
let db: DatabaseSync;
let calls: string[] = [];
let kept = new Map<string, string>();

// A keychain of this test's own, so nothing here runs the OS tool and nobody is asked for their
// keychain password. A write or a remove fails the test: a test of the connection stores nothing.
const keychain: Keychain = {
  read: (name) => {
    calls.push(`read ${name}`);
    return Promise.resolve(kept.get(name) ?? null);
  },
  write: (name) => Promise.reject(new Error(`A test of the connection wrote ${name}.`)),
  remove: (name) => Promise.reject(new Error(`A test of the connection removed ${name}.`)),
};

// The answer of a Sentry project, written by hand and handed back by a fetch that opens no socket.
let urls: string[] = [];
const sentryAnswers = (status: number, body: string): SentryHttp => (url) => {
  urls.push(url);
  return Promise.resolve(new Response(body, { status }));
};
const TWO_ISSUES = JSON.stringify(
  ['4501', '4502'].map((id) => ({ id, shortId: `RECIPES-WEB-${id}`, title: `TypeError ${id}`, culprit: 'GET /recipes', level: 'error', count: '3' })),
);

// The probes a press reaches, each with a local answer: nothing here reaches a real host or runs gh.
const probes = (sentry: SentryHttp): Probes => ({
  sentry: (source, held) => sentryReadable(source, held, { fetcher: sentry }),
  tickets: (source, held) => ticketsReadable(source, held, { run: () => Promise.reject(new Error('gh is not run in a test.')) }),
  search: (source, held) => logsReadable(source, held, { fetcher: () => Promise.reject(new Error('No cluster in a test.')) }),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-connection-'));
  db = openDatabase(dir);
  calls = [];
  kept = new Map();
  urls = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const form = (body: Record<string, string>) => {
  const sent = new FormData();
  for (const [name, value] of Object.entries(body)) sent.set(name, value);
  return sent;
};

const SENTRY = { form: 'sentry', label: 'The recipe app', org: 'recipes-app', project: 'recipes-web', secret: TOKEN };

describe('Test the connection', () => {
  // The dialog has not saved anything yet, so the read takes the settings and the token from the form.
  // A row stored under the same id says another project, and the read never sees it.
  it('reads with the unsaved form and uses no saved row', async () => {
    const id = addScoutSource(db, { kind: 'sentry', label: 'Stored', config: { org: 'stored-org', project: 'stored-project' } });
    let ticks = 0;

    const answer = await testConnection(keychain, form({ ...SENTRY, id: String(id) }), probes(sentryAnswers(200, TWO_ISSUES)), () => (ticks++ === 0 ? 1000 : 1800));

    expect(answer).toEqual({ ok: true, readable: '2 issues readable', where: 'recipes-app/recipes-web', took: '0.8s', message: null });
    expect(urls[0]).toContain('/api/0/projects/recipes-app/recipes-web/issues/');
    expect(urls.join(' ')).not.toContain('stored');
    // The typed token was used, so the keychain was not asked.
    expect(calls).toEqual([]);
    // Nothing was written: the stored row is as it was, and no finding came of the read.
    expect(scoutSources(db)[0]).toMatchObject({ config: { org: 'stored-org', project: 'stored-project' }, lastChecked: null, cursor: null });
    expect(scoutFindings(db, id)).toEqual([]);
  });

  it('asks a new source for its token first, and reaches for no keychain', async () => {
    const answer = await testConnection(keychain, form({ ...SENTRY, secret: '' }), probes(sentryAnswers(200, TWO_ISSUES)));

    expect(answer).toMatchObject({ ok: false, message: 'Paste the Auth token first, so the test has something to connect with.' });
    expect(calls).toEqual([]);
    expect(urls).toEqual([]);
  });

  // An open source with the token field left empty keeps its stored token, so the test reads that one
  // entry by the name the form gives, and only to read it.
  it('reads the stored token of an open source by the name the form gives it', async () => {
    kept.set('sentry-recipes-web-7', TOKEN);

    const answer = await testConnection(keychain, form({ ...SENTRY, id: '7', secret: '' }), probes(sentryAnswers(200, TWO_ISSUES)));

    expect(answer).toMatchObject({ ok: true, readable: '2 issues readable' });
    expect(calls).toEqual(['read sentry-recipes-web-7']);
  });

  // An older source still has its token under `scout-<id>`. The test reads it there and moves nothing:
  // the move belongs to a real check, and a test writes nothing.
  it('reads an older token under its old name and leaves it there', async () => {
    kept.set('scout-7', TOKEN);

    const answer = await testConnection(keychain, form({ ...SENTRY, id: '7', secret: '' }), probes(sentryAnswers(200, TWO_ISSUES)));

    expect(answer).toMatchObject({ ok: true });
    expect(calls).toEqual(['read sentry-recipes-web-7', 'read scout-7']);
    expect([...kept.keys()]).toEqual(['scout-7']);
  });

  // The keychain the probe gets is the test's own: one entry to read, nothing to write or remove. A
  // probe that reaches for more fails, so a bug in a kind's read cannot store or delete a token.
  it('hands the read a keychain that reads one entry and refuses every write and remove', async () => {
    kept.set('other-entry', 'someone else');
    kept.set('sentry-recipes-web-7', TOKEN);
    const seen: { source?: unknown; own?: string | null; other?: string | null; wrote?: string; removed?: string } = {};
    const spy: Probes = {
      ...probes(sentryAnswers(200, TWO_ISSUES)),
      sentry: async (source, held) => {
        seen.source = source;
        seen.own = await held.read('sentry-recipes-web-7');
        seen.other = await held.read('other-entry');
        await held.write('x', 'y').catch((error: Error) => (seen.wrote = error.message));
        await held.remove('other-entry').catch((error: Error) => (seen.removed = error.message));
        return '1 issue';
      },
    };

    const answer = await testConnection(keychain, form({ ...SENTRY, id: '7', secret: '' }), spy);

    expect(answer).toMatchObject({ ok: true, readable: '1 issue readable' });
    expect(seen.own).toBe(TOKEN);
    expect(seen.other).toBeNull();
    expect(seen.wrote).toBe('A test of the connection stores nothing.');
    expect(seen.removed).toBe('A test of the connection stores nothing.');
    expect(seen.source).toMatchObject({ id: 7, kind: 'sentry', cursor: null, lastChecked: null, enabled: true });
    expect(calls).toEqual(['read sentry-recipes-web-7']);
  });

  // A typed token wins over the stored one, and is the only thing read: the keychain is not asked.
  it('prefers the typed token to a stored one', async () => {
    kept.set('sentry-recipes-web-7', 'the stored one');
    let used: string | null = null;
    const spy: Probes = { ...probes(sentryAnswers(200, TWO_ISSUES)), sentry: async (_source, held) => ((used = await held.read('sentry-recipes-web-7')), '1 issue') };

    await testConnection(keychain, form({ ...SENTRY, id: '7' }), spy);

    expect(used).toBe(TOKEN);
    expect(calls).toEqual([]);
  });

  it('says what the service answered when it refuses the read', async () => {
    const answer = await testConnection(keychain, form(SENTRY), probes(sentryAnswers(401, '{"detail":"Invalid token"}')));

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('Sentry refused the Auth token');
    expect(answer.message).not.toContain(TOKEN);
  });

  it('refuses a form with a field missing, and a pasted text source, before any read', async () => {
    expect(await testConnection(keychain, form({ ...SENTRY, org: '' }), probes(sentryAnswers(200, TWO_ISSUES)))).toMatchObject({
      ok: false,
      message: 'A Sentry source needs the organization.',
    });
    expect(await testConnection(keychain, form({ form: 'paste' }), probes(sentryAnswers(200, TWO_ISSUES)))).toMatchObject({
      ok: false,
      message: 'A pasted text source has nothing to connect to. Paste a log into it and press Check now.',
    });
    expect(await testConnection(keychain, form({ form: 'nothing' }), probes(sentryAnswers(200, TWO_ISSUES)))).toMatchObject({ ok: false });
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('names a ticket query by its own setting, and passes a failed read on as its sentence', async () => {
    const answer = await testConnection(keychain, form({ form: 'tickets-github', repo: 'owner/recipes', query: 'is:issue is:open' }), probes(sentryAnswers(200, TWO_ISSUES)));

    expect(answer).toMatchObject({ ok: false, message: 'gh is not run in a test.' });
  });
});
