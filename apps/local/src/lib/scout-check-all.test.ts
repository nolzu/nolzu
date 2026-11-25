import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addScoutSource, openDatabase, scoutSources, setScoutSource } from '@nolzu/core/node';
import type { Keychain } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Checks, checkAllSources, saveAndCheck } from './scout-check-all.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-check-all-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// No test here reads a keychain or reaches a service: every check is handed in.
const keychain: Keychain = { read: () => Promise.reject(new Error('A test reached the keychain.')), write: () => Promise.resolve(), remove: () => Promise.resolve() };

// A check that opens one finding for the source it is asked about, or fails with a sentence.
let asked: number[] = [];
const finds = async (_db: DatabaseSync, _keychain: Keychain, form: FormData) => {
  const id = Number(form.get('id'));
  asked.push(id);
  db.prepare(
    "INSERT INTO scout_findings (source_id, fingerprint, occurrences, first_seen, last_seen, first_message, last_message, location) VALUES (?, ?, 1, '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z', 'Timeout', 'Timeout', '')",
  ).run(id, `f-${id}-${asked.length}`);
  return { ok: true, checked: 'Checked.', message: null };
};
const fails = async (_db: DatabaseSync, _keychain: Keychain, form: FormData) => {
  asked.push(Number(form.get('id')));
  return { ok: false, checked: null, message: 'Sentry refused the token.' };
};
const checks = (over: Partial<Checks> = {}): Checks => ({ tickets: finds, sentry: finds, search: finds, ...over });

beforeEach(() => {
  asked = [];
});

it('reads every source a press can read, one after the other, and counts what is new', async () => {
  const github = addScoutSource(db, { kind: 'tickets', label: 'GitHub issues and failed CI', config: { system: 'github', repo: 'owner/recipes', query: 'is:issue' } });
  const sentry = addScoutSource(db, { kind: 'sentry', label: 'Sentry · recipes-web', config: { org: 'your-org', project: 'recipes-web' } });

  const answer = await checkAllSources(db, keychain, checks());

  expect(asked).toEqual([github, sentry]);
  expect(answer).toEqual({ ok: true, said: 'Checked 2 sources. 2 new findings.', failed: [] });
});

// A pasted source takes its text in its own box, and a source that is off is not checked by any press.
it('leaves out a pasted text source and a source that is turned off, and says so', async () => {
  addScoutSource(db, { kind: 'paste', label: 'Pasted logs' });
  const off = addScoutSource(db, { kind: 'search', label: 'Logs · OpenSearch', config: { endpoint: 'https://logs.example.com:9200', index: 'logs-*', query: 'level:error' } });
  setScoutSource(db, off, { enabled: false });
  addScoutSource(db, { kind: 'sentry', label: 'Sentry · recipes-web', config: { org: 'your-org', project: 'recipes-web' } });

  const answer = await checkAllSources(db, keychain, checks({ sentry: async () => ({ ok: true, checked: 'Checked.', message: null }) }));

  expect(asked).toEqual([]);
  expect(answer).toEqual({ ok: true, said: 'Checked 1 source. No new finding. A pasted text source takes its text in its own box, so it was left out.', failed: [] });
});

// A source that failed says why under its own name, and the others are still read.
it('names each source it could not read, and still reads the rest', async () => {
  addScoutSource(db, { kind: 'sentry', label: 'Sentry · recipes-web', config: { org: 'your-org', project: 'recipes-web' } });
  addScoutSource(db, { kind: 'tickets', label: 'GitHub issues and failed CI', config: { system: 'github', repo: 'owner/recipes', query: 'is:issue' } });

  const answer = await checkAllSources(db, keychain, checks({ sentry: fails }));

  expect(answer).toEqual({ ok: true, said: 'Checked 1 source. 1 new finding.', failed: ['Sentry · recipes-web: Sentry refused the token.'] });
});

it('refuses when every read failed', async () => {
  addScoutSource(db, { kind: 'sentry', label: 'Sentry · recipes-web', config: { org: 'your-org', project: 'recipes-web' } });

  expect(await checkAllSources(db, keychain, checks({ sentry: fails }))).toEqual({ ok: false, said: 'No source could be read.', failed: ['Sentry · recipes-web: Sentry refused the token.'] });
});

it('refuses with nothing a press can read, and names why', async () => {
  expect(await checkAllSources(db, keychain, checks())).toEqual({ ok: false, said: 'There is no source to check yet. Add one first.', failed: [] });

  addScoutSource(db, { kind: 'paste', label: 'Pasted logs' });

  expect(await checkAllSources(db, keychain, checks())).toEqual({
    ok: false,
    said: 'No source here can be checked in one press. A pasted text source takes its text in its own box, and a source that is turned off is not checked.',
    failed: [],
  });
  expect(asked).toEqual([]);
});

describe('Add and check now', () => {
  // No hub here: an add sends no schedule, and nothing below is scheduled.
  const hub = { projectId: null, send: () => false };
  const add = (body: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(body)) form.set(name, value);
    return saveAndCheck(db, keychain, form, hub, checks());
  };
  const GITHUB = { do: 'add', form: 'tickets-github', label: 'GitHub issues and failed CI', repo: 'owner/recipes', query: 'is:issue' };

  // The dialog's main button posts check=now, and the new source is read once, through its own check.
  it('reads the new source once when the add asks for a check', async () => {
    const { answer, checked } = await add({ ...GITHUB, check: 'now' });

    expect(answer).toMatchObject({ ok: true, did: 'add' });
    expect(asked).toEqual([scoutSources(db)[0]?.id]);
    expect(checked).toEqual({ ok: true, checked: 'Checked.', message: null });
  });

  // Another source is there already, so the new one is not id 1 and the check must follow the new id.
  it('reads the source it just added and not an older one', async () => {
    addScoutSource(db, { kind: 'paste', label: 'Older pasted logs' });

    const { answer } = await add({ ...GITHUB, check: 'now' });

    const added = scoutSources(db).find((one) => one.kind === 'tickets')?.id;
    expect(added).toBeGreaterThan(1);
    expect(answer).toMatchObject({ ok: true, id: added });
    expect(asked).toEqual([added]);
  });

  // Any other poster of the add sets off no check, so no test and no older form reaches a service.
  it('reads nothing on an add that asks for no check', async () => {
    const { answer, checked } = await add(GITHUB);

    expect(answer.ok).toBe(true);
    expect(asked).toEqual([]);
    expect(checked).toBeNull();
  });

  it('reads nothing when the add is refused, or the new source is pasted text', async () => {
    expect((await add({ ...GITHUB, label: '', check: 'now' })).checked).toBeNull();
    expect((await add({ do: 'add', form: 'paste', label: 'Pasted logs', check: 'now' })).checked).toBeNull();
    expect(asked).toEqual([]);
    expect(scoutSources(db).map((one) => one.kind)).toEqual(['paste']);
  });
});
