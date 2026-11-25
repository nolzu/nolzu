// The export loop against a real sqlite file and a keychain held in memory, with stub adapters. No
// call leaves the process: no test in here has a `fetch` in it, and every adapter answers from an
// array. What each destination is sent is in its own file, `timesheet-toggl.test.ts` for Toggl.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { RUNNER_MESSAGES, type TimesheetEntry, type TimesheetRun, timesheetEntries, timesheetOf } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportSkipped } from './timesheet-call.ts';
import {
  EXPORT_TIMEOUT_SENTENCE,
  type ExportAdapter,
  type ExportAdapters,
  type ExportRequest,
  exportEntries,
  exporter,
  exporterSecretName,
  exporters,
  exportProjectId,
  exportSaid,
  exportWeek,
  MAX_ATTEMPTS,
  MAX_FAILURES_PER_EXPORT,
  MAX_SETTINGS_CHARS,
  postExporter,
  removeExporter,
  saveExporter,
  sentEntries,
  timesheetSync,
} from './timesheet-export.ts';

const PROJECT = 'proj-studio';
const WEEK = '2026-03-02';
const NOW = Date.parse('2026-03-09T10:00:00Z');
// A Toggl token has this prefix. The rest is words on purpose: the secret scanner in CI flags a
// random looking string, and no test here needs the entropy.
const TOKEN = 'tgl_not-a-real-token-for-the-export-tests';

const at = (now: number) => new Date(now).toISOString();

/** The OS keychain as a map, so a test can see every entry it holds. */
function memoryKeychain(): Keychain & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    read: async (name) => held.get(name) ?? null,
    write: async (name, secret) => {
      held.set(name, secret);
    },
    remove: async (name) => {
      held.delete(name);
    },
  };
}

const run = (start: string, key: string, minutes: number | null, source: string | null = 'local'): TimesheetRun => ({
  start,
  key,
  label: `${key} work`,
  source,
  durationMs: minutes === null ? null : minutes * 60_000,
  running: false,
});

// One week as the machine builds it: the published mapping, off the grid a person saw.
const week = (runs: TimesheetRun[]): TimesheetEntry[] => timesheetEntries(timesheetOf(runs, WEEK), PROJECT);

const WEEK_RUNS = [
  run('2026-03-02T14:00:00.000Z', 'APP-7', 90),
  run('2026-03-03T09:00:00.000Z', 'APP-7', 30),
  // A run that reported no duration. It adds nothing to its cell, so that day has no entry.
  run('2026-03-04T09:00:00.000Z', 'APP-7', null),
];

let dir = '';
let db: DatabaseSync;
let keychain: ReturnType<typeof memoryKeychain>;

// One machine with a Toggl connection and its token in the keychain.
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-timesheet-export-'));
  db = openDatabase(dir);
  keychain = memoryKeychain();
  await saveExporter(db, keychain, { destination: 'toggl', settings: { workspace: '42' }, token: TOKEN }, NOW - 60_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Call {
  entry: TimesheetEntry;
  secret: string;
  settings: Record<string, unknown>;
}

// The stub every test posts through. Nothing leaves the process.
function stubAdapter(answer?: (entry: TimesheetEntry) => string | null): { calls: Call[]; adapters: ExportAdapters } {
  const calls: Call[] = [];
  const toggl: ExportAdapter = async (entry, secret, settings) => {
    calls.push({ entry, secret, settings });
    return answer === undefined ? `remote-${calls.length}` : answer(entry);
  };
  return { calls, adapters: { toggl } };
}

function failingAdapter(message: string): { calls: Call[]; adapters: ExportAdapters } {
  const calls: Call[] = [];
  const toggl: ExportAdapter = async (entry, secret, settings) => {
    calls.push({ entry, secret, settings });
    throw new Error(message);
  };
  return { calls, adapters: { toggl } };
}

const request = (entries: TimesheetEntry[]): ExportRequest => ({ destination: 'toggl', entries });

// Everything the two tables hold, as one string, so a search for the token covers every column.
function storedText(): string {
  const rows = [...db.prepare('SELECT * FROM exporters').all(), ...db.prepare('SELECT * FROM export_entries').all()];
  return rows.map((row) => Object.values(row).map(String).join('|')).join('\n');
}

const entryRows = () => sentEntries(db, 'toggl', '2026-01-01', '2026-12-31');

const connection = () => exporters(db)[0];

describe('a week of entries', () => {
  it('posts one entry per card and day, with the id the machine built', async () => {
    const { calls, adapters } = stubAdapter();

    const entries = week(WEEK_RUNS);
    // Written out by hand. The id is nolzu:<project>:<card>:<day>, each part encoded, and every
    // stored row is keyed on it.
    expect(entries.map((entry) => entry.externalId)).toEqual(['nolzu:proj-studio:APP-7:2026-03-02', 'nolzu:proj-studio:APP-7:2026-03-03']);

    const result = await exportEntries(db, keychain, request(entries), NOW, adapters);

    expect(result).toEqual({ sent: 2, already: 0, changed: 0, failed: 0, skipped: 0, stuck: 0, left: 0, error: null });
    expect(calls.map((call) => [call.entry.externalId, call.entry.minutes])).toEqual([
      ['nolzu:proj-studio:APP-7:2026-03-02', 90],
      ['nolzu:proj-studio:APP-7:2026-03-03', 30],
    ]);
    // Every field the machine built arrives whole. The start instant keeps a post off the previous
    // day west of Greenwich, and the source is how a Jira card is told from a local one.
    expect(calls[0]?.entry).toEqual(entries[0]);
    expect(entries[0]).toMatchObject({ card: 'APP-7', source: 'local', title: 'APP-7 work', start: '2026-03-02T14:00:00.000Z' });
    // The connection's own settings reach the adapter, and nothing reads inside them here.
    expect(calls[0]?.settings).toEqual({ workspace: '42' });

    const rows = entryRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      external_id: 'nolzu:proj-studio:APP-7:2026-03-02',
      day: '2026-03-02',
      minutes: 90,
      sent_at: at(NOW),
      remote_id: 'remote-1',
      attempts: 1,
      last_error: null,
    });
    expect(connection()).toMatchObject({ lastError: null, lastExportAt: at(NOW) });
  });

  it('leaves out a day whose runs reported no duration', async () => {
    const { calls, adapters } = stubAdapter();

    const entries = week(WEEK_RUNS);
    expect(entries.map((entry) => entry.day)).toEqual(['2026-03-02', '2026-03-03']);

    await exportEntries(db, keychain, request(entries), NOW, adapters);

    expect(calls.map((call) => call.entry.day)).toEqual(['2026-03-02', '2026-03-03']);
  });
});

describe('the same week twice', () => {
  it('sends nothing a second time', async () => {
    const { calls, adapters } = stubAdapter();
    const entries = week(WEEK_RUNS);

    await exportEntries(db, keychain, request(entries), NOW, adapters);
    const again = await exportEntries(db, keychain, request(entries), NOW + 60_000, adapters);

    expect(calls).toHaveLength(2);
    expect(again).toMatchObject({ sent: 0, already: 2, changed: 0 });
    expect(entryRows()).toHaveLength(2);
    // The first run's time, so nothing was written over a row that had gone out.
    expect(entryRows()[0]).toMatchObject({ sent_at: at(NOW), attempts: 1 });
  });

  it('posts nothing twice when two presses overlap', async () => {
    const calls: string[] = [];
    const adapters: ExportAdapters = {
      toggl: async (entry) => {
        calls.push(entry.externalId);
        // A destination that takes a moment to answer. The wait is what a second press lands in,
        // and it is why the row cannot be written after the post alone.
        await new Promise((go) => setTimeout(go, 20));
        return null;
      },
    };
    const entries = week(WEEK_RUNS);

    // Two presses of one panel. The first is still waiting on the destination when the second
    // arrives, and sqlite answers both at once, so both would read an entry that has no row yet.
    const first = exportEntries(db, keychain, request(entries), NOW, adapters);
    const second = exportEntries(db, keychain, request(entries), NOW + 1_000, adapters);

    expect(await first).toMatchObject({ sent: 2, already: 0 });
    expect(await second).toMatchObject({ sent: 0, already: 2 });
    expect(calls).toHaveLength(2);
  });

  it('sends the same week to a second destination', async () => {
    await saveExporter(db, keychain, { destination: 'harvest', settings: {}, token: 'hvst_not-a-real-token-for-the-export-tests' }, NOW);
    const calls: string[] = [];
    const adapter: ExportAdapter = async (entry) => {
      calls.push(entry.externalId);
      return null;
    };
    const adapters: ExportAdapters = { toggl: adapter, harvest: adapter };
    const entries = week(WEEK_RUNS);

    await exportEntries(db, keychain, request(entries), NOW, adapters);
    const harvest = await exportEntries(db, keychain, { destination: 'harvest', entries }, NOW, adapters);

    // The id says nothing about where it went, so what Toggl holds may not stop Harvest.
    expect(harvest).toMatchObject({ sent: 2, already: 0 });
    expect(calls).toHaveLength(4);
    expect(sentEntries(db, 'harvest', '2026-01-01', '2026-12-31')).toHaveLength(2);
  });

  it('reads back the week a screen asks for and not the whole history', async () => {
    const { adapters } = stubAdapter();
    await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, adapters);

    // The two rows are 2026-03-02 and 2026-03-03.
    expect(sentEntries(db, 'toggl', '2026-03-02', '2026-03-02')).toHaveLength(1);
    expect(sentEntries(db, 'toggl', '2026-03-09', '2026-03-15')).toHaveLength(0);
  });

  it('says so when the hours changed after they went out, and still sends nothing', async () => {
    const { calls, adapters } = stubAdapter();

    await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, adapters);
    // A run added to a day that was already exported. The id has no figure in it, so it is the
    // same id and the same row.
    const longer = week([...WEEK_RUNS, run('2026-03-02T17:00:00.000Z', 'APP-7', 30)]);
    expect(longer[0]?.minutes).toBe(120);
    const second = await exportEntries(db, keychain, request(longer), NOW + 60_000, adapters);

    expect(calls).toHaveLength(2);
    expect(second).toMatchObject({ sent: 0, already: 2, changed: 1 });
    // The row still says what was billed, not what the week says now.
    expect(entryRows()[0]).toMatchObject({ minutes: 90 });
  });
});

describe('an export that failed', () => {
  it('keeps its last error and stops trying after the ceiling', async () => {
    const { calls, adapters } = failingAdapter('401 Unauthorized');
    const entries = [week(WEEK_RUNS)[0] as TimesheetEntry];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let press = 0; press < MAX_ATTEMPTS; press++) {
      const answer = await exportEntries(db, keychain, request(entries), NOW + press, adapters);
      expect(answer).toMatchObject({ sent: 0, failed: 1, stuck: 0, error: '401 Unauthorized' });
    }
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(entryRows()[0]).toMatchObject({ attempts: MAX_ATTEMPTS, sent_at: null, last_error: '401 Unauthorized' });

    const past = await exportEntries(db, keychain, request(entries), NOW + 99, adapters);

    // The press after the ceiling asks the destination nothing and still says what is wrong.
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(past).toMatchObject({ sent: 0, failed: 0, stuck: 1, error: '401 Unauthorized' });
    expect(entryRows()[0]).toMatchObject({ attempts: MAX_ATTEMPTS });
  });

  it('stops the run after three failures in a row and leaves the rest untried', async () => {
    const { calls, adapters } = failingAdapter('503 Service Unavailable');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entries = week([
      run('2026-03-02T09:00:00.000Z', 'APP-1', 10),
      run('2026-03-03T09:00:00.000Z', 'APP-2', 10),
      run('2026-03-04T09:00:00.000Z', 'APP-3', 10),
      run('2026-03-05T09:00:00.000Z', 'APP-4', 10),
      run('2026-03-06T09:00:00.000Z', 'APP-5', 10),
    ]);
    expect(entries).toHaveLength(5);

    const result = await exportEntries(db, keychain, request(entries), NOW, adapters);

    expect(calls).toHaveLength(MAX_FAILURES_PER_EXPORT);
    expect(result).toMatchObject({ sent: 0, failed: 3, left: 2, error: '503 Service Unavailable' });
    // Two entries were never tried, so they carry no attempt and no sentence.
    expect(entryRows()).toHaveLength(3);
  });

  it('starts the count again after an entry goes out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entries = week([
      run('2026-03-02T09:00:00.000Z', 'APP-1', 10),
      run('2026-03-03T09:00:00.000Z', 'APP-2', 10),
      run('2026-03-04T09:00:00.000Z', 'APP-3', 10),
      run('2026-03-05T09:00:00.000Z', 'APP-4', 10),
      run('2026-03-06T09:00:00.000Z', 'APP-5', 10),
      run('2026-03-07T09:00:00.000Z', 'APP-6', 10),
    ]);
    expect(entries).toHaveLength(6);
    const calls: string[] = [];
    const refused = ['APP-1', 'APP-2', 'APP-5'];
    const adapters: ExportAdapters = {
      toggl: async (entry) => {
        calls.push(entry.externalId);
        if (refused.some((card) => entry.externalId.includes(`:${card}:`))) throw new Error('422 Unprocessable');
        return null;
      },
    };

    const result = await exportEntries(db, keychain, request(entries), NOW, adapters);

    // Two refusals, then two entries that went out, then one more refusal. Never three in a row,
    // so the run reached the last entry and left nothing untried.
    expect(calls).toHaveLength(6);
    expect(result).toMatchObject({ sent: 3, failed: 3, left: 0 });
  });

  it('gives up on an adapter that does not answer in time', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapters: ExportAdapters = { toggl: () => new Promise<string>(() => {}) };

    const result = await exportEntries(db, keychain, request([week(WEEK_RUNS)[0] as TimesheetEntry]), NOW, adapters, 5);

    expect(result).toMatchObject({ failed: 1, error: EXPORT_TIMEOUT_SENTENCE });
  });
});

describe('an export that never reaches a destination', () => {
  it('says there is no connection and writes nothing', async () => {
    const { calls, adapters } = stubAdapter();

    const result = await exportEntries(db, keychain, { destination: 'clockify', entries: week(WEEK_RUNS) }, NOW, { clockify: adapters.toggl });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ sent: 0, left: 2, error: 'There is no Clockify connection on this machine.' });
    expect(sentEntries(db, 'clockify', '2026-01-01', '2026-12-31')).toHaveLength(0);
  });

  it('says this client has no adapter for the destination yet', async () => {
    // A map with nothing in it, which is what a destination with no adapter meets.
    const result = await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, {});

    expect(result).toMatchObject({ sent: 0, left: 2, error: 'Nolzu does not post to Toggl yet.' });
    expect(connection()).toMatchObject({ lastError: 'Nolzu does not post to Toggl yet.' });
  });

  it('says the token is missing when the keychain holds none, and posts nothing', async () => {
    const { calls, adapters } = stubAdapter();
    keychain.held.clear();

    const result = await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, adapters);

    const sentence = 'There is no Toggl token on this machine. Save the Toggl connection again with its API token.';
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ sent: 0, left: 2, error: sentence });
    expect(connection()).toMatchObject({ lastError: sentence });
    expect(entryRows()).toHaveLength(0);
  });

  it('leaves the keychain sentence on the connection when the keychain cannot be read', async () => {
    const { calls, adapters } = stubAdapter();
    const locked: Keychain = { ...keychain, read: () => Promise.reject(new Error('The keychain could not read export-toggl: it is locked.')) };

    const result = await exportEntries(db, locked, request(week(WEEK_RUNS)), NOW, adapters);

    expect(calls).toHaveLength(0);
    expect(result.error).toBe('The keychain could not read export-toggl: it is locked.');
    expect(connection()?.lastError).toBe('The keychain could not read export-toggl: it is locked.');
  });
});

describe('the token', () => {
  it('reaches the adapter and nothing else', async () => {
    const { calls, adapters } = stubAdapter();

    const result = await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, adapters);

    expect(calls[0]?.secret).toBe(TOKEN);
    expect(keychain.held.get(exporterSecretName('toggl'))).toBe(TOKEN);
    // The answer the button prints, the connection the panel draws, and every column of both tables.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(exporters(db))).not.toContain(TOKEN);
    expect(storedText()).not.toContain(TOKEN);
  });

  it('is taken out of a sentence the destination echoed back, and out of the log line', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { adapters } = failingAdapter(`401 for token ${TOKEN}, check the workspace`);

    const result = await exportEntries(db, keychain, request([week(WEEK_RUNS)[0] as TimesheetEntry]), NOW, adapters);

    expect(result.error).toBe('401 for token …, check the workspace');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(storedText()).not.toContain(TOKEN);
    // The log line as well, which is the one place a sentence lands that nobody reviewed.
    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.flat().map(String).join('\n')).not.toContain(TOKEN);
  });

  it('is taken out of a sentence too long to store whole', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The token starts before the 300 character ceiling and ends after it. A run that shortened
    // the sentence first would cut the token in half and keep the front of it on the row.
    const { adapters } = failingAdapter(`${'upstream refused. '.repeat(16)}${TOKEN}`);

    const result = await exportEntries(db, keychain, request([week(WEEK_RUNS)[0] as TimesheetEntry]), NOW, adapters);

    expect(result.error).not.toContain('tgl_');
    expect(storedText()).not.toContain('tgl_');
  });

  it('never reaches the Data sync list: it is in no table the hub sync reads, and no message to the hub carries an export', async () => {
    const { adapters } = stubAdapter();
    await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, adapters);

    // Everything the hub sync sends is read from this database, so the token in no row of any table,
    // settings included, is what keeps it off every line of the list.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((table) => table.name)).toContain('settings');
    for (const { name } of tables) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      expect(text, name).not.toContain(TOKEN);
      expect(text, name).not.toContain(btoa(`${TOKEN}:api_token`));
    }
    // The export runs on this machine alone, so the wire has no message for it to ride on.
    expect(RUNNER_MESSAGES.filter((type) => /export|timesheet|toggl|harvest|clockify|worklog/i.test(type))).toEqual([]);
  });
});

describe('the connections', () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it('replaces the settings and the token of a connection saved again', async () => {
    await saveExporter(db, keychain, { destination: 'toggl', settings: { workspace: '43' }, token: 'tgl_second-token-for-tests' }, NOW);

    expect(exporters(db)).toHaveLength(1);
    expect(exporter(db, 'toggl')?.settings).toEqual({ workspace: '43' });
    expect(keychain.held.get('export-toggl')).toBe('tgl_second-token-for-tests');
  });

  it('keeps the stored token when the form leaves it empty, and refuses a new connection without one', async () => {
    const kept = await postExporter(db, keychain, form({ do: 'save', destination: 'toggl', workspace: '44', project: '31' }), NOW);
    expect(kept).toMatchObject({ ok: true, did: 'save' });
    expect(exporter(db, 'toggl')?.settings).toEqual({ workspace: '44', project: '31' });
    expect(keychain.held.get('export-toggl')).toBe(TOKEN);

    const refused = await postExporter(db, keychain, form({ do: 'save', destination: 'clockify', workspace: 'a1b2c3d4e5f6a1b2c3d4e5f6' }), NOW);
    expect(refused).toMatchObject({ ok: false, message: 'A Clockify connection needs its API key.' });
    expect(exporter(db, 'clockify')).toBeNull();
  });

  it('keeps the token out of the settings, whatever the form posts', async () => {
    const answer = await postExporter(
      db,
      keychain,
      form({ do: 'save', destination: 'harvest', account: '555', project: '31', task: '7', secret: 'hvst_not-a-real-token', token: 'hvst_not-a-real-token' }),
      NOW,
    );

    expect(answer.ok).toBe(true);
    expect(exporter(db, 'harvest')?.settings).toEqual({ account: '555', project: '31', task: '7' });
    expect(keychain.held.get('export-harvest')).toBe('hvst_not-a-real-token');
    expect(storedText()).not.toContain('hvst_');
  });

  it('refuses a form that names no destination, a missing field, a word it does not know, and long settings', async () => {
    expect(await postExporter(db, keychain, form({ do: 'save', destination: 'timely' }), NOW)).toMatchObject({
      ok: false,
      message: 'Nolzu posts to Toggl, Harvest, Clockify and Jira, and this form names timely.',
    });
    expect(await postExporter(db, keychain, form({ do: 'save', destination: 'harvest', account: '1', task: '1', secret: 'x' }), NOW)).toMatchObject({
      ok: false,
      message: 'A Harvest connection needs the project id.',
    });
    expect(await postExporter(db, keychain, form({ do: 'rename', destination: 'toggl' }), NOW)).toMatchObject({ ok: false });
    await expect(saveExporter(db, keychain, { destination: 'jira', settings: { site: 'x'.repeat(MAX_SETTINGS_CHARS) }, token: 'jira_x' }, NOW)).rejects.toThrow(
      /may not be longer/,
    );
    expect(exporter(db, 'harvest')).toBeNull();
  });

  it('stores no row when the keychain refuses the token', async () => {
    const refusing: Keychain = { ...keychain, write: () => Promise.reject(new Error('The keychain could not store export-jira.')) };

    const answer = await postExporter(
      db,
      refusing,
      form({ do: 'save', destination: 'jira', site: 'https://example.atlassian.net', email: 'person@example.com', secret: 'jira_x' }),
      NOW,
    );

    expect(answer).toMatchObject({ ok: false, message: 'The connection was not saved. The keychain could not store export-jira.' });
    expect(exporter(db, 'jira')).toBeNull();
  });

  it('tries a stuck entry again once the connection is saved, and leaves the sent ones alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entries = week(WEEK_RUNS);
    await exportEntries(db, keychain, request(entries.slice(0, 1)), NOW, stubAdapter().adapters);
    const revoked = failingAdapter('401 Unauthorized');
    for (let press = 0; press < MAX_ATTEMPTS; press++) await exportEntries(db, keychain, request(entries.slice(1)), NOW + press, revoked.adapters);
    expect(await exportEntries(db, keychain, request(entries), NOW + 9, revoked.adapters)).toMatchObject({ already: 1, stuck: 1 });

    // A new token is the fix a person makes, and the save is the only way back for a stuck entry.
    expect(await postExporter(db, keychain, form({ do: 'save', destination: 'toggl', workspace: '42', secret: 'tgl_new-token-for-tests' }), NOW + 10)).toMatchObject({ ok: true });
    const { calls, adapters } = stubAdapter();
    const after = await exportEntries(db, keychain, request(entries), NOW + 11, adapters);

    expect(after).toMatchObject({ sent: 1, already: 1, stuck: 0 });
    expect(calls.map((call) => call.entry.externalId)).toEqual([entries[1]?.externalId]);
    expect(entryRows().map((row) => [row.day, row.sent_at])).toEqual([
      ['2026-03-02', at(NOW)],
      ['2026-03-03', at(NOW + 11)],
    ]);
  });

  it('takes the token with the connection and keeps what was already sent', async () => {
    const { adapters } = stubAdapter();
    await exportEntries(db, keychain, request(week(WEEK_RUNS)), NOW, adapters);

    expect(await removeExporter(db, keychain, 'toggl')).toBe(true);

    expect(exporters(db)).toHaveLength(0);
    expect(keychain.held.has('export-toggl')).toBe(false);
    // The sent rows stay, so a connection made again does not bill the week a second time.
    expect(entryRows()).toHaveLength(2);
    expect(await removeExporter(db, keychain, 'toggl')).toBe(false);
  });

  it('leaves a Scout token alone when the name is not a destination', async () => {
    keychain.held.set('scout-7', 'scout-token-for-the-export-tests');
    const removed = vi.spyOn(keychain, 'remove');

    expect(await removeExporter(db, keychain, '7')).toBe(false);
    expect(await removeExporter(db, keychain, 'scout-7')).toBe(false);

    expect(keychain.held.get('scout-7')).toBe('scout-token-for-the-export-tests');
    // No keychain entry at all is touched for a name that is no destination.
    expect(removed).not.toHaveBeenCalled();
  });
});

// What the Export button runs: the week on screen, once to every connection.
describe('the Export button', () => {
  const sheet = (runs: TimesheetRun[]) => timesheetOf(runs, WEEK);

  beforeEach(() => {
    writeSetting(db, 'projectPath', dir);
  });

  it('posts the week once to every connection, and a second press writes nothing new', async () => {
    await saveExporter(db, keychain, { destination: 'harvest', settings: { account: '1', project: '2', task: '3' }, token: 'hvst_not-a-real-token' }, NOW);
    const posted: string[] = [];
    const adapter =
      (name: string): ExportAdapter =>
      async (entry) => {
        posted.push(`${name} ${entry.day}`);
        return `${name}-${posted.length}`;
      };
    const adapters: ExportAdapters = { toggl: adapter('toggl'), harvest: adapter('harvest') };

    const first = await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW, adapters);
    const before = storedText();
    const second = await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW + 60_000, adapters);

    expect(first).toEqual({ ok: true, lines: ['Toggl: posted 2 entries.', 'Harvest: posted 2 entries.'] });
    expect(posted).toEqual(['toggl 2026-03-02', 'toggl 2026-03-03', 'harvest 2026-03-02', 'harvest 2026-03-03']);
    expect(second).toEqual({
      ok: true,
      lines: ['Toggl: posted nothing new. Skipped 2 entries that were sent before.', 'Harvest: posted nothing new. Skipped 2 entries that were sent before.'],
    });
    // Nothing new written on the entries: the second press only stamps when each connection last ran.
    const entriesOnly = (text: string) => text.split('\n').filter((line) => line.startsWith('toggl|nolzu') || line.startsWith('harvest|nolzu'));
    expect(entriesOnly(storedText())).toEqual(entriesOnly(before));
    expect(posted).toHaveLength(4);
  });

  it('says nothing was sent, and why, when the run never reached a call', async () => {
    const { calls, adapters } = stubAdapter();
    keychain.held.clear();

    const answer = await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW, adapters);

    expect(calls).toHaveLength(0);
    // No failure in a row happened, so the line names none.
    expect(answer.lines).toEqual(['Toggl: nothing was sent. There is no Toggl token on this machine. Save the Toggl connection again with its API token.']);
  });

  it('holds back a cell with a run still going, and says so', async () => {
    const { calls, adapters } = stubAdapter();
    const going = [...WEEK_RUNS, { ...run('2026-03-03T11:00:00.000Z', 'APP-7', null), running: true }];

    const answer = await exportWeek(db, keychain, sheet(going), NOW, adapters);

    // Tuesday holds 30 finished minutes and a run that has not ended, so only Monday goes.
    expect(calls.map((call) => call.entry.day)).toEqual(['2026-03-02']);
    expect(answer).toEqual({
      ok: true,
      lines: ['Toggl: posted 1 entry.', 'Held back 1 entry with a run still going, because the minutes are not final. Export again once nothing is running.'],
    });
    const alone = await exportWeek(db, keychain, sheet([{ ...run('2026-03-04T11:00:00.000Z', 'APP-7', 10), running: true }]), NOW, adapters);
    expect(alone).toEqual({ ok: false, lines: ['Held back 1 entry with a run still going, because the minutes are not final. Export again once nothing is running.'] });
  });

  it('holds back only the card with the run going, and sends another card on that day', async () => {
    const { calls, adapters } = stubAdapter();
    const going = [...WEEK_RUNS, run('2026-03-03T10:00:00.000Z', 'APP-8', 20), { ...run('2026-03-03T11:00:00.000Z', 'APP-8', null), running: true }];

    const answer = await exportWeek(db, keychain, sheet(going), NOW, adapters);

    // Tuesday holds a finished APP-7 and an APP-8 with a run that has not ended. The cell is the card
    // and the day, so only APP-8 waits.
    expect(calls.map((call) => `${call.entry.card} ${call.entry.day}`).sort()).toEqual(['APP-7 2026-03-02', 'APP-7 2026-03-03']);
    expect(answer.lines).toContain('Held back 1 entry with a run still going, because the minutes are not final. Export again once nothing is running.');
  });

  it('says what it skipped and what failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runs = [...WEEK_RUNS, run('2026-03-05T09:00:00.000Z', 'APP-8', 20)];
    await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW, stubAdapter().adapters);
    const longer = [...runs, run('2026-03-02T17:00:00.000Z', 'APP-7', 30)];

    const answer = await exportWeek(db, keychain, sheet(longer), NOW + 1, failingAdapter('Toggl answered 502, so the entry was not sent. Export again later.').adapters);

    expect(answer.lines).toEqual([
      'Toggl: posted nothing new. Skipped 2 entries that were sent before. 1 of them has other minutes now, and only you can fix that in Toggl. 1 entry failed, and the next press tries again. Toggl answered 502, so the entry was not sent. Export again later.',
    ]);
  });

  it('files every entry under an id minted once, and leaves the machine unregistered', async () => {
    const { calls, adapters } = stubAdapter();
    expect(getSetting(db, 'exportProjectId')).toBeNull();

    await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW, adapters);
    const id = getSetting(db, 'exportProjectId');

    expect(id).not.toBeNull();
    expect(calls[0]?.entry.externalId).toBe(`nolzu:${id}:APP-7:2026-03-02`);
    expect(exportProjectId(db)).toBe(id);
    // `projectId` says the hub has this project, and the Scout answers read it that way.
    expect(getSetting(db, 'projectId')).toBeNull();
  });

  it('refuses before any call with no connection, no project folder or an empty week', async () => {
    const { calls, adapters } = stubAdapter();

    expect(await exportWeek(db, keychain, sheet([]), NOW, adapters)).toEqual({ ok: false, lines: ['This week has no timed runs, so there is nothing to send.'] });
    writeSetting(db, 'projectPath', null);
    expect((await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW, adapters)).lines[0]).toMatch(/no project folder/);
    await removeExporter(db, keychain, 'toggl');
    expect((await exportWeek(db, keychain, sheet(WEEK_RUNS), NOW, adapters)).lines[0]).toMatch(/No time tracker is connected/);
    expect(calls).toHaveLength(0);
  });
});

describe('the marks on the grid', () => {
  beforeEach(() => {
    writeSetting(db, 'projectPath', dir);
  });

  it('marks each cell with what happened to its entry at that destination', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runs = [
      run('2026-03-02T09:00:00.000Z', 'APP-1', 10),
      run('2026-03-03T09:00:00.000Z', 'APP-2', 10),
      run('2026-03-04T09:00:00.000Z', 'PROJ-9', 10, null),
      run('2026-03-05T09:00:00.000Z', 'APP-4', 10),
    ];
    const adapters: ExportAdapters = {
      toggl: async (entry) => {
        if (entry.card === 'APP-2') throw new Error('Toggl refused the entry with 400, so it was not sent.');
        if (entry.source === null) throw new ExportSkipped('The card PROJ-9 is gone.');
        return '1';
      },
    };
    await exportWeek(db, keychain, timesheetOf(runs, WEEK), NOW, adapters);
    for (let press = 1; press < MAX_ATTEMPTS; press++) await exportWeek(db, keychain, timesheetOf(runs.slice(1, 2), WEEK), NOW + press, adapters);
    const later = timesheetOf([...runs, run('2026-03-05T11:00:00.000Z', 'APP-4', 5)], WEEK);

    expect(timesheetSync(db, later, 'toggl')).toEqual([
      { card: 'APP-1', day: '2026-03-02', state: 'sent', reason: null },
      { card: 'APP-2', day: '2026-03-03', state: 'stuck', reason: 'Toggl refused the entry with 400, so it was not sent.' },
      { card: 'PROJ-9', day: '2026-03-04', state: 'skipped', reason: 'The card PROJ-9 is gone.' },
      { card: 'APP-4', day: '2026-03-05', state: 'changed', reason: null },
    ]);
    // Another destination holds nothing for this week.
    expect(timesheetSync(db, later, 'harvest')).toEqual([]);
  });

  it('marks a day that failed and has tries left as failed, and a skip after a failure as skipped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runs = [run('2026-03-02T09:00:00.000Z', 'PROJ-5', 10, 'jira'), run('2026-03-03T09:00:00.000Z', 'PROJ-6', 10, 'jira')];
    await exportWeek(db, keychain, timesheetOf(runs, WEEK), NOW, failingAdapter('Jira answered 502, so the entry was not sent.').adapters);
    expect(entryRows().map((row) => row.attempts)).toEqual([1, 1]);

    // PROJ-5 is deleted after its failure, so its card has no source and Jira can never take it.
    const later = [{ ...runs[0], source: null } as TimesheetRun, runs[1] as TimesheetRun];
    const adapters: ExportAdapters = {
      toggl: async (entry) => {
        if (entry.source === null) throw new ExportSkipped('The card PROJ-5 is gone, so its hours were not sent.');
        throw new Error('Jira answered 502, so the entry was not sent.');
      },
    };
    await exportWeek(db, keychain, timesheetOf(later, WEEK), NOW + 1, adapters);

    expect(timesheetSync(db, timesheetOf(later, WEEK), 'toggl')).toEqual([
      { card: 'PROJ-5', day: '2026-03-02', state: 'skipped', reason: 'The card PROJ-5 is gone, so its hours were not sent.' },
      { card: 'PROJ-6', day: '2026-03-03', state: 'failed', reason: 'Jira answered 502, so the entry was not sent.' },
    ]);
    expect(entryRows().map((row) => row.attempts)).toEqual([0, 2]);
  });

  it('marks nothing and mints no id on a machine that never exported', () => {
    expect(timesheetSync(db, timesheetOf(WEEK_RUNS, WEEK), 'toggl')).toEqual([]);
    expect(getSetting(db, 'exportProjectId')).toBeNull();
  });
});

describe('the line under the Export button', () => {
  const none = { sent: 0, already: 0, changed: 0, failed: 0, skipped: 0, stuck: 0, left: 0, error: null };

  it('names what the tracker does not take, what is stuck and what the run never reached', () => {
    expect(exportSaid('Jira', { ...none, sent: 1, skipped: 2 })).toBe('Jira: posted 1 entry. Skipped 2 entries that Jira does not take.');
    expect(exportSaid('Jira', { ...none, skipped: 1 })).toBe('Jira: posted nothing new. Skipped 1 entry that Jira does not take.');
    expect(exportSaid('Toggl', { ...none, stuck: 1, error: '401 Unauthorized' })).toBe(
      'Toggl: posted nothing new. 1 entry failed 5 times and was not tried again. Save the Toggl connection again and the next export tries it. 401 Unauthorized',
    );
    expect(exportSaid('Toggl', { ...none, stuck: 2, error: '401 Unauthorized' })).toBe(
      'Toggl: posted nothing new. 2 entries failed 5 times and were not tried again. Save the Toggl connection again and the next export tries them. 401 Unauthorized',
    );
    expect(exportSaid('Toggl', { ...none, failed: 3, left: 1, error: '503 Service Unavailable' })).toBe(
      'Toggl: posted nothing new. 3 entries failed, and the next press tries again. 1 entry was not tried, because the export stopped after 3 failures in a row. 503 Service Unavailable',
    );
    expect(exportSaid('Toggl', { ...none, failed: 3, left: 2, error: '503 Service Unavailable' })).toContain('2 entries were not tried, because');
  });
});
