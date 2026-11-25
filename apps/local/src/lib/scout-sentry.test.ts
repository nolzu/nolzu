import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dismissScoutFinding, openDatabase, scoutFindings, scoutSources } from '@nolzu/core/node';
import type { Keychain, SentryHttp } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkSentryIssues, type SentrySeams } from './scout-sentry.ts';
import { saveScoutSource, scoutEntry } from './scout-sources.ts';

// Not a token of anything. It only has to be a string nothing else here writes.
const TOKEN = 'abc123notatoken';

let dir = '';
let db: DatabaseSync;
let calls: string[] = [];
let kept = new Map<string, string>();

// A keychain of this test's own, so nothing here runs the OS tool and nobody is asked for their
// keychain password.
const keychain: Keychain = {
  read: (name) => {
    calls.push(`read ${name}`);
    return Promise.resolve(kept.get(name) ?? null);
  },
  write: (name, secret) => {
    calls.push(`write ${name}`);
    kept.set(name, secret);
    return Promise.resolve();
  },
  remove: (name) => {
    calls.push(`remove ${name}`);
    kept.delete(name);
    return Promise.resolve();
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-sentry-'));
  db = openDatabase(dir);
  calls = [];
  kept = new Map();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const post = (body: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  // Registered nowhere, so nothing here builds a schedule frame. What a remove sends is tested in
  // `scout-sources.test.ts`.
  return saveScoutSource(db, keychain, form, { projectId: null, send: () => false });
};

const id = () => scoutSources(db)[0]?.id ?? 0;

const check = (seams: SentrySeams) => {
  const form = new FormData();
  form.set('id', String(id()));
  return checkSentryIssues(db, keychain, form, seams);
};

const SENTRY = { do: 'add', form: 'sentry', label: 'The recipe app', org: 'your-org', project: 'recipes-api', secret: TOKEN };

/**
 * HAND WRITTEN, AND NOT RECORDED. No answer from Sentry has been read in this project, because there is
 * no account here yet. `packages/runner/src/sentry.test.ts` and `packages/core/src/scout-sentry.test.ts`
 * name what a first real call has to confirm.
 */
const issues = (...rows: { id: string; count: number }[]): string =>
  JSON.stringify(
    rows.map((one) => ({
      id: one.id,
      shortId: `RECIPES-API-${one.id}`,
      title: `TypeError in the recipe reader ${one.id}`,
      culprit: 'GET /recipes/{id}',
      level: 'error',
      count: String(one.count),
      permalink: `https://sentry.io/organizations/your-org/issues/${one.id}/`,
    })),
  );

const answered = (status: number, body: string, headers: Record<string, string> = {}): { fetcher: SentryHttp; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    fetcher: (url) => {
      urls.push(url);
      return Promise.resolve(new Response(body, { status, headers }));
    },
  };
};

it('reads its token from its own keychain entry and keys the finding on the Sentry issue id', async () => {
  await post(SENTRY);
  const asked = answered(200, issues({ id: '4501', count: 12 }));

  const answer = await check({ fetcher: asked.fetcher });

  expect(answer).toMatchObject({ ok: true, message: null });
  expect(answer.checked).toContain('1 new finding');
  // Its own name, so two Sentry sources keep two tokens.
  expect(calls).toEqual([`write sentry-recipes-api-${id()}`, `read sentry-recipes-api-${id()}`]);
  expect(asked.urls[0]).toContain('/api/0/projects/your-org/recipes-api/issues/');
  // The page limit reaches the call. Without this line the constant could be any number and every test
  // would still pass, and that limit is how many findings one press can open.
  expect(asked.urls[0]).toContain('limit=30');
  const [finding] = scoutFindings(db, id());
  expect(finding?.fingerprint).toBe('sentry:4501');
  // Sentry's own count, not how many times a check saw the issue. This is the difference from the paste
  // source, where one line seen once is one occurrence.
  expect(finding?.occurrences).toBe(12);
  expect(finding?.location).toBe('GET /recipes/{id}');
  expect(finding?.lastMessage).toContain('https://sentry.io/organizations/your-org/issues/4501/');
});

// The whole reason the cursor holds the count. Without it the second check would add the whole total
// again and the finding would read as twenty-four.
it('adds only the events that arrived since the last check', async () => {
  await post(SENTRY);
  await check({ fetcher: answered(200, issues({ id: '4501', count: 12 })).fetcher });

  const again = await check({ fetcher: answered(200, issues({ id: '4501', count: 20 })).fetcher });

  expect(again.checked).toContain('1 finding seen again');
  expect(scoutFindings(db, id())[0]?.occurrences).toBe(20);
});

it('says the count did not move rather than printing a zero', async () => {
  await post(SENTRY);
  await check({ fetcher: answered(200, issues({ id: '4501', count: 12 })).fetcher });

  const again = await check({ fetcher: answered(200, issues({ id: '4501', count: 12 })).fetcher });

  expect(again).toMatchObject({ ok: true, message: null });
  expect(again.checked).toContain('no new events');
  expect(scoutFindings(db, id())[0]?.occurrences).toBe(12);
});

// Two different facts, and the sentence has to tell them apart. A count that did not move names issues
// this source has reported. An answer with no issue in it names none, and printing the first sentence
// there would claim findings that do not exist.
it('says the project has nothing unresolved rather than naming issues it never read', async () => {
  await post(SENTRY);

  const answer = await check({ fetcher: answered(200, issues()).fetcher });

  expect(answer).toMatchObject({ ok: true, message: null });
  expect(answer.checked).toBe('Checked. Sentry answered no unresolved issue for this project.');
});

// A refused token is a sentence a person reads later on the Scout page, so it is stamped on the row.
// Nothing is written to the findings and the cursor stays where it was.
it('keeps a refused Auth token on the source and writes no finding', async () => {
  await post(SENTRY);

  const answer = await check({ fetcher: answered(401, '{"detail":"Invalid token"}').fetcher });

  expect(answer).toMatchObject({ ok: false, checked: null });
  expect(answer.message).toContain('project:read and event:read');
  expect(scoutFindings(db, id())).toEqual([]);
  expect(scoutSources(db)[0]).toMatchObject({ cursor: null, lastError: expect.stringContaining('Auth token') });
});

it('names the wait when Sentry is rate limiting the token', async () => {
  await post(SENTRY);

  const answer = await check({ fetcher: answered(429, '{"detail":"rate limited"}', { 'retry-after': '60' }).fetcher });

  expect(answer.message).toContain('Wait 60 seconds');
  expect(scoutSources(db)[0]?.lastError).toContain('Wait 60 seconds');
});

// The one mistake an error tracker adapter may not make. A page from a proxy read as no issues would
// tell a person their project is clean.
it('refuses a web page from the network instead of reading it as no issues', async () => {
  await post(SENTRY);

  const answer = await check({ fetcher: answered(200, '<!doctype html><html><body>Sign in</body></html>').fetcher });

  expect(answer).toMatchObject({ ok: false, checked: null });
  expect(answer.message).toContain('web page instead of data');
  expect(scoutFindings(db, id())).toEqual([]);
});

// A source whose token was taken out of the keychain by hand. The sentence names the entry, because
// that is where the person has to put it back.
it('names the keychain entry when the Auth token is not there', async () => {
  await post(SENTRY);
  kept.clear();

  const answer = await check({ fetcher: answered(200, issues({ id: '4501', count: 1 })).fetcher });

  // The full entry and the stop after it, so a bare name does not pass.
  expect(answer.message).toContain(`under ${scoutEntry(`sentry-recipes-api-${id()}`)}.`);
  expect(answer.message).toContain('on the Scout page');
});

// The settings are checked before the keychain, because that check costs nothing and a keychain read
// can put an OS password dialog in front of the person.
it('refuses a source with no organization, and reads no token for it', async () => {
  await post(SENTRY);
  db.prepare(`UPDATE scout_sources SET config_json = '{"project":"recipes-api"}' WHERE id = ?`).run(id());
  calls = [];
  const asked = answered(200, issues({ id: '4501', count: 1 }));

  const answer = await check({ fetcher: asked.fetcher });

  expect(answer.message).toContain('organization');
  expect(calls).toEqual([]);
  expect(asked.urls).toEqual([]);
});

// The paste path names a mute in its own clause. An issue whose finding is muted was met, so saying
// nothing moved would be wrong twice over.
it('names the muted finding when Sentry answered only one that is dismissed', async () => {
  await post(SENTRY);
  await check({ fetcher: answered(200, issues({ id: '4501', count: 4 })).fetcher });
  dismissScoutFinding(db, scoutFindings(db, id())[0]?.id ?? 0);

  const again = await check({ fetcher: answered(200, issues({ id: '4501', count: 9 })).fetcher });

  expect(again.checked).toContain('1 finding left muted');
  expect(scoutFindings(db, id())[0]?.occurrences).toBe(4);
});

// A Sentry source checked through the ticket button, which is what a hand written post can do. Each
// kind has a cursor of its own, and a check of the wrong kind would overwrite it.
it('refuses a source of another kind', async () => {
  await post({ do: 'add', form: 'paste', label: 'What I pasted' });

  const answer = await check({ fetcher: answered(200, issues()).fetcher });

  expect(answer).toMatchObject({ ok: false, checked: null });
  expect(answer.message).toContain('is not a Sentry project');
});
