import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { scoutSecretName } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.ts';
import { addScoutSource, finishScoutCheck, removeScoutSource, scoutSource, scoutSources, setScoutSource } from './scout-sources.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const add = (over: Partial<Parameters<typeof addScoutSource>[1]> = {}) =>
  addScoutSource(db, { kind: 'sentry', label: 'The recipe app', config: { project: 'recipes-api' }, ...over });

it('reads a source back as it was added', () => {
  const id = add();

  expect(scoutSource(db, id)).toEqual({
    id,
    kind: 'sentry',
    label: 'The recipe app',
    config: { project: 'recipes-api' },
    // Off until a person turns them on. A source that made cards or started runs the moment it was
    // added would act before anybody agreed to it.
    enabled: true,
    createCards: false,
    autoAssess: false,
    // No schedule either. A scheduled check runs on Nolzu cloud and costs money, so a new source
    // starts with none.
    scheduleMinutes: 0,
    notify: false,
    cursor: null,
    lastChecked: null,
    lastError: null,
  });
});

it('answers with nothing for a source that is not there', () => {
  expect(scoutSource(db, 404)).toBeNull();
});

// The order the screen lists them in, so a source does not move under a person's hand when they
// turn another one off.
it('lists sources in the order they were added', () => {
  const first = add({ label: 'The recipe app' });
  const second = add({ kind: 'paste', label: 'Pasted by hand', config: {} });
  setScoutSource(db, first, { enabled: false });

  expect(scoutSources(db).map((one) => one.id)).toEqual([first, second]);
});

it('changes only what it is given', () => {
  const id = add();

  setScoutSource(db, id, { createCards: true });

  expect(scoutSource(db, id)).toMatchObject({ createCards: true, autoAssess: false, enabled: true, label: 'The recipe app' });
});

it('changes nothing when it is given nothing', () => {
  const id = add();

  setScoutSource(db, id, {});

  expect(scoutSource(db, id)?.label).toBe('The recipe app');
});

// A source turned off keeps its row and its cursor, so turning it on again does not replay
// everything it has already seen.
it('keeps a source that is turned off', () => {
  const id = add();

  setScoutSource(db, id, { enabled: false });

  expect(scoutSource(db, id)?.enabled).toBe(false);
  expect(scoutSources(db)).toHaveLength(1);
});

it('takes a source away', () => {
  const id = add();

  removeScoutSource(db, id);

  expect(scoutSources(db)).toEqual([]);
});

/**
 * The three columns `setScoutSource` refuses, and the one function that writes them.
 *
 * They move together: a cursor written without a time would leave a source that looks unchecked
 * while it has already read everything, and the person would paste it all again.
 */
describe('where a check ends', () => {
  it('writes the cursor, the time and no error when a check worked', () => {
    const id = add();

    finishScoutCheck(db, id, { cursor: 'abc123' });

    expect(scoutSource(db, id)).toMatchObject({ cursor: 'abc123', lastError: null });
    expect(scoutSource(db, id)?.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the error of a check that failed, in the words of the source', () => {
    const id = add();

    finishScoutCheck(db, id, { cursor: null, error: 'The host did not answer. Check the endpoint in the source settings.' });

    expect(scoutSource(db, id)).toMatchObject({ cursor: null, lastError: 'The host did not answer. Check the endpoint in the source settings.' });
  });

  // Null once one succeeds, so a person is not left reading yesterday's failure.
  it('clears the error of an earlier failure when the next check works', () => {
    const id = add();
    finishScoutCheck(db, id, { cursor: null, error: 'The host did not answer.' });

    finishScoutCheck(db, id, { cursor: 'abc123' });

    expect(scoutSource(db, id)?.lastError).toBeNull();
  });

  // Nothing else. A check does not rename a source or turn its opt-ins on.
  it('leaves the settings a person owns alone', () => {
    const id = add();
    setScoutSource(db, id, { createCards: true });

    finishScoutCheck(db, id, { cursor: 'abc123' });

    expect(scoutSource(db, id)).toMatchObject({ label: 'The recipe app', createCards: true, enabled: true, config: { project: 'recipes-api' } });
  });
});

/**
 * The rule the whole feature rests on: a secret is never in this file.
 *
 * A source token goes to the OS keychain, never into sqlite and never
 * into a log. This is the test that would catch a config field quietly carrying one.
 */
describe('what never reaches the database', () => {
  // A comment saying "no secret here" is not what holds it. The config is a map of whatever the
  // caller passes, so one forgotten field would put a token in the database file and in every
  // backup of it.
  it.each(['token', 'apiToken', 'api_key', 'password', 'clientSecret', 'privateKey'])('refuses a settings field called %s', (name) => {
    expect(() => addScoutSource(db, { kind: 'sentry', label: 'The recipe app', config: { [name]: 'sentry-token-value' } })).toThrow(/keychain/);
    expect(scoutSources(db)).toEqual([]);
  });

  it('refuses one on the way in as well', () => {
    const id = add();

    expect(() => setScoutSource(db, id, { config: { project: 'recipes-api', token: 'sentry-token-value' } })).toThrow(/keychain/);
    expect(scoutSource(db, id)?.config).toEqual({ project: 'recipes-api' });
  });

  // The other side. A settings field a person may read goes in, or the guard would refuse the
  // ordinary case and the form would have nowhere to put a project name.
  it('takes the settings a person may read', () => {
    const id = addScoutSource(db, { kind: 'search', label: 'The recipe app logs', config: { endpoint: 'http://localhost:9200', query: 'level:error', index: 'recipes-*' } });

    expect(scoutSource(db, id)?.config).toEqual({ endpoint: 'http://localhost:9200', query: 'level:error', index: 'recipes-*' });
  });

  // A refused add returns no id, so this reads every column of every row rather than one row: the
  // point is that the string is nowhere in the file, not that one row is clean.
  it('keeps no secret anywhere in the file', () => {
    expect(() => add({ config: { token: 'sentry-token-value' } })).toThrow(/keychain/);

    const columns = (db.prepare('SELECT * FROM scout_sources').all() as Record<string, unknown>[]).flatMap((row) => Object.values(row));

    expect(columns.join(' ')).not.toContain('sentry-token-value');
  });

  it('names one keychain entry per source, which the keychain will take', () => {
    const id = add();

    expect(scoutSecretName(id)).toBe(`scout-${id}`);
    // The keychain refuses a name that is not lower case letters, digits and hyphens.
    expect(scoutSecretName(id)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

// The column carries a CHECK, so a kind nothing knows cannot be written here at all.
it('refuses a kind that is not one of the four', () => {
  expect(() => db.prepare("INSERT INTO scout_sources (kind, label) VALUES ('slack', 'A channel')").run()).toThrow(/CHECK/);
});

// A config written by hand, or by a version that stored something else, is read as nothing rather
// than handed to an adapter that expects strings.
it('reads a config that is not an object of strings as nothing', () => {
  db.prepare("INSERT INTO scout_sources (kind, label, config_json) VALUES ('paste', 'By hand', '[1,2]')").run();
  db.prepare("INSERT INTO scout_sources (kind, label, config_json) VALUES ('paste', 'Also by hand', 'not json at all')").run();
  db.prepare(`INSERT INTO scout_sources (kind, label, config_json) VALUES ('paste', 'Half of one', '{"query":"timeout","limit":10}')`).run();

  expect(scoutSources(db).map((one) => one.config)).toEqual([{}, {}, { query: 'timeout' }]);
});

// The schedule is two columns of the source and not a settings row, so a removed source takes its
// schedule with it and a restart still shows what the person picked.
it('keeps a schedule on the source row, off until somebody sets one', () => {
  const id = addScoutSource(db, { kind: 'sentry', label: 'The recipe app' });
  expect(scoutSource(db, id)).toMatchObject({ scheduleMinutes: 0, notify: false });

  setScoutSource(db, id, { scheduleMinutes: 60, notify: true });
  expect(scoutSource(db, id)).toMatchObject({ scheduleMinutes: 60, notify: true });

  // A patch that says nothing about the schedule leaves it alone.
  setScoutSource(db, id, { label: 'Renamed' });
  expect(scoutSource(db, id)).toMatchObject({ label: 'Renamed', scheduleMinutes: 60, notify: true });

  setScoutSource(db, id, { scheduleMinutes: 0, notify: false });
  expect(scoutSource(db, id)).toMatchObject({ scheduleMinutes: 0, notify: false });

  removeScoutSource(db, id);
  expect(db.prepare('SELECT count(*) AS many FROM scout_sources').get()).toEqual({ many: 0 });
});
