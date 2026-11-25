// The Harvest exporter, driven by hand and through the export loop. No call leaves the process:
// every test hands over its own `fetch`. The test setup refuses every tracker host, so a test that
// forgets its stub fails by name.
//
// NOT RECORDED. Harvest has never answered this project. Every body here is written by hand from the
// documented API v2 shape, and the header of `timesheet-harvest.ts` names what a first real call has
// to confirm. A green run here says this file reads what the documentation describes, and nothing
// more than that.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@nolzu/core/node';
import { type TimesheetEntry, type TimesheetRun, timesheetEntries, timesheetOf } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callDestination, type ExportFetch } from './timesheet-call.ts';
import { EXPORT_ADAPTERS, type ExportAdapters, exportEntries, saveExporter, sentEntries } from './timesheet-export.ts';
import { exportHarvest, findHarvestEntry, HARVEST_ORIGIN, harvestBody, harvestRefusal } from './timesheet-harvest.ts';

const PROJECT = 'proj-studio';
const WEEK = '2026-03-02';
const NOW = Date.parse('2026-03-09T10:00:00Z');
// Not a real token. Words on purpose, so the secret scanner in CI leaves it alone.
const TOKEN = 'hvst_not-a-real-token-for-the-harvest-tests';
const SETTINGS = { account: '555', project: '31', task: 7 };
const SIGNAL = new AbortController().signal;

const entry = (over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  externalId: 'nolzu:proj-studio:APP-7:2026-03-02',
  project: PROJECT,
  day: '2026-03-02',
  start: '2026-03-02T14:00:00.250Z',
  card: 'APP-7',
  source: 'local',
  title: 'Fix the login form',
  minutes: 90,
  ...over,
});

// A row of the list as the documentation describes one, for the entry above.
const row = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  spent_date: '2026-03-02',
  hours: 1.5,
  notes: 'APP-7 Fix the login form',
  external_reference: { id: 'nolzu:proj-studio:APP-7:2026-03-02' },
  ...over,
});
const page = (rows: unknown[], next: number | null = null) => JSON.stringify({ time_entries: rows, next_page: next });

interface Call {
  url: string;
  init: Parameters<ExportFetch>[1];
}

function script(...answers: [number, string][]) {
  const calls: Call[] = [];
  const send: ExportFetch = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error('The test answered fewer calls than were made.');
    return new Response(next[1], { status: next[0] });
  };
  return { calls, send };
}

/**
 * A Harvest that keeps what it is sent and lists it by day, as documented. With `drop`, it keeps
 * the entry and not its reference, the case a personal token may run into.
 */
function fakeHarvest(hang = false, drop = false) {
  const held: Record<string, unknown>[] = [];
  const calls: Call[] = [];
  const send: ExportFetch = async (url, init) => {
    calls.push({ url, init });
    const at = new URL(url);
    if (init.method === 'GET') {
      const from = at.searchParams.get('from') ?? '';
      const to = at.searchParams.get('to') ?? '';
      const found = held.filter((one) => String(one.spent_date) >= from && String(one.spent_date) <= to);
      return new Response(page(found), { status: 200 });
    }
    const one: Record<string, unknown> = { ...(JSON.parse(init.body ?? '{}') as Record<string, unknown>), id: 5000 + held.length };
    if (drop) one.external_reference = null;
    held.push(one);
    if (hang) return new Promise<Response>((_, no) => init.signal.addEventListener('abort', () => no(new Error('aborted'))));
    return new Response(JSON.stringify(one), { status: 201 });
  };
  return { held, calls, send };
}

const opened: { db: DatabaseSync; dir: string }[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const one of opened.splice(0)) {
    one.db.close();
    rmSync(one.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('one entry', () => {
  it('reads the day for its reference, then posts the entry the mapping built', async () => {
    const { calls, send } = script([200, page([])], [201, JSON.stringify(row({ id: 777 }))]);

    await expect(exportHarvest(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('777');

    expect(calls.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', 'https://api.harvestapp.com/v2/time_entries?from=2026-03-02&to=2026-03-02&per_page=2000'],
      ['POST', `${HARVEST_ORIGIN}/v2/time_entries`],
    ]);
    expect(JSON.parse(calls[1]?.init.body ?? '')).toEqual({
      project_id: 31,
      task_id: 7,
      spent_date: '2026-03-02',
      hours: 1.5,
      notes: 'APP-7 Fix the login form',
      external_reference: { id: 'nolzu:proj-studio:APP-7:2026-03-02' },
    });
    for (const one of calls) {
      expect(one.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(one.init.headers['harvest-account-id']).toBe('555');
      expect(one.init.headers['user-agent']).toMatch(/^Nolzu/);
      expect(one.init.redirect).toBe('manual');
      expect(one.init.signal).toBe(SIGNAL);
      expect(one.url).not.toContain(TOKEN);
    }
  });

  it('sends a fraction of an hour as it is', () => {
    expect(harvestBody(entry({ minutes: 20 }), 31, 7).hours).toBe(20 / 60);
  });

  it('answers with the id of an entry Harvest already holds by its reference, and posts nothing', async () => {
    const { calls, send } = script([200, page([row({ id: 1, external_reference: { id: 'other' } }), row()])]);

    await expect(exportHarvest(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('9001');
    expect(calls).toHaveLength(1);
  });

  it('posts when the rows of that day are some other work', async () => {
    const others = [
      row({ external_reference: null, notes: 'APP-8 Fix the login form' }),
      row({ external_reference: { id: 'other' } }),
      // The same card and day with no reference, but other hours: somebody else's entry.
      row({ external_reference: null, hours: 0.5 }),
      row({ external_reference: null, spent_date: '2026-03-01' }),
    ];
    const { calls, send } = script([200, page(others)], [201, '{"id":12}']);

    await expect(exportHarvest(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('12');
    expect(calls).toHaveLength(2);
  });

  it('refuses a day it cannot read, and posts nothing', async () => {
    const unread = [
      '[]',
      '{"data":[]}',
      'not json',
      // The same work with a reference it cannot read: kept by Harvest under another name.
      page([row({ external_reference: undefined, externalReference: { id: 'x' } })]),
      page([row({ id: 'h-1' })]),
      page([row({ external_reference: { id: null } })]),
      page([row({ external_reference: { id: 42 } })]),
      // A second page, which could hold the entry.
      page([], 2),
    ];
    for (const body of unread) {
      const { calls, send } = script([200, body]);
      await expect(exportHarvest(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/not sen[dt]/);
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses a post it cannot read rather than marking the entry sent', async () => {
    for (const [status, posted, said] of [
      [
        201,
        '{"ok":true}',
        'Harvest answered the post with something Nolzu could not read, so the entry is not marked as sent. The next export looks for it in Harvest before it posts again.',
      ],
      [
        200,
        '{"id":3}',
        'Harvest answered 200 where 201 was expected, so the entry is not marked as sent. The next export looks for it in Harvest before it posts again.',
      ],
    ] as [number, string, string][]) {
      const { send } = script([200, page([])], [status, posted]);
      await expect(exportHarvest(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(said);
    }
  });

  it('refuses a connection missing an id, before any call', async () => {
    const { calls, send } = script();
    for (const [settings, name] of [
      [{ project: 1, task: 1 }, /account/],
      [{ account: 1, task: 1 }, /project/],
      [{ account: 1, project: 1 }, /task/],
      [{ account: '1/../x', project: 1, task: 1 }, /account/],
    ] as [Record<string, unknown>, RegExp][]) {
      await expect(exportHarvest(entry(), TOKEN, settings, SIGNAL, send)).rejects.toThrow(name);
    }
    // The account id is not in any address in Harvest, so the sentence says where it is.
    await expect(exportHarvest(entry(), TOKEN, { account: 'recipes', project: 1, task: 1 }, SIGNAL, send)).rejects.toThrow(
      'Save the Harvest connection again with the id from the Harvest developers page, where the token was made.',
    );
    expect(calls).toHaveLength(0);
  });

  it('names what is wrong for each refusal Harvest answers', () => {
    expect(harvestRefusal(401, '')).toMatch(/refused the API token/);
    expect(harvestRefusal(403, '')).toMatch(/cannot use that account/);
    expect(harvestRefusal(404, '')).toMatch(/does not know that project or task/);
    expect(harvestRefusal(429, '')).toMatch(/rate limiting/);
    expect(harvestRefusal(502, '')).toBe('Harvest answered 502, so the entry was not sent. Export again later.');
    expect(harvestRefusal(422, '{"message":"Spent date is locked"}')).toBe(
      'Harvest refused the entry with 422, so it was not sent. Harvest said: Spent date is locked',
    );
    expect(harvestRefusal(400, `{"error_description":"bad ${TOKEN}"}`, [TOKEN])).toMatch(/said: bad …$/);
    expect(harvestRefusal(401, '<html>sign in</html>')).toMatch(/web page/);
  });

  it('reads an empty day as nothing to find', () => {
    expect(findHarvestEntry(page([]), entry())).toBeNull();
  });

  it('never sends a call to a host other than the destination', async () => {
    const { calls, send } = script();
    const to = { label: 'Harvest', origin: new URL(HARVEST_ORIGIN), headers: {}, secrets: [], refusal: harvestRefusal, fetcher: send };
    await expect(callDestination(to, 'GET', '//elsewhere.example/v2/time_entries', undefined, SIGNAL)).rejects.toThrow(
      'A Harvest call names a path on api.harvestapp.com, and not another address.',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('a week through the export loop', () => {
  const run = (start: string, key: string, minutes: number): TimesheetRun => ({
    start,
    key,
    label: `${key} work`,
    source: 'local',
    durationMs: minutes * 60_000,
    running: false,
  });
  const entries = timesheetEntries(
    timesheetOf([run('2026-03-02T14:00:00.000Z', 'APP-7', 90), run('2026-03-03T09:00:00.000Z', 'APP-7', 30), run('2026-03-03T11:00:00.000Z', 'APP-8', 45)], WEEK),
    PROJECT,
  );
  const request = () => ({ destination: 'harvest' as const, entries });

  async function machine() {
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-harvest-'));
    const db = openDatabase(dir);
    opened.push({ db, dir });
    const held = new Map<string, string>();
    const keychain: Keychain = {
      read: async (name) => held.get(name) ?? null,
      write: async (name, secret) => void held.set(name, secret),
      remove: async (name) => void held.delete(name),
    };
    await saveExporter(db, keychain, { destination: 'harvest', settings: { account: '555', project: '31', task: '7' }, token: TOKEN }, NOW - 60_000);
    return { db, keychain };
  }

  const through = (send: ExportFetch): ExportAdapters => ({
    harvest: (one, secret, settings, signal) => exportHarvest(one, secret, settings, signal, send),
  });

  it('is the adapter the export loop holds', () => {
    expect(EXPORT_ADAPTERS.harvest).toBe(exportHarvest);
  });

  it('posts the entries the mapping produced, and a second export posts nothing', async () => {
    const { db, keychain } = await machine();
    const harvest = fakeHarvest();

    const first = await exportEntries(db, keychain, request(), NOW, through(harvest.send));
    expect(first).toMatchObject({ sent: 3, already: 0, failed: 0, error: null });
    expect(harvest.held.map((one) => [one.spent_date, one.hours, one.notes])).toEqual(
      entries.map((one) => [one.day, one.minutes / 60, `${one.card} ${one.title}`]),
    );

    const before = harvest.calls.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(harvest.send));
    expect(second).toMatchObject({ sent: 0, already: 3 });
    expect(harvest.calls).toHaveLength(before);
    expect(sentEntries(db, 'harvest', WEEK, '2026-03-08').map((one) => one.remote_id)).toEqual(['5000', '5001', '5002']);
  });

  it('finds an entry Harvest took before the timeout by its reference, and does not post it again', async () => {
    const { db, keychain } = await machine();
    const slow = fakeHarvest(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await exportEntries(db, keychain, request(), NOW, through(slow.send), 20);
    expect(first.sent).toBe(0);
    expect(slow.held.length).toBeGreaterThan(0);

    const now = fakeHarvest();
    now.held.push(...slow.held);
    const kept = slow.held.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(now.send));
    expect(second).toMatchObject({ sent: 3, failed: 0 });
    expect(now.held).toHaveLength(3);
    expect(now.calls.filter((one) => one.init.method === 'POST')).toHaveLength(3 - kept);
  });

  it('refuses, and does not post again, an entry Harvest took before the timeout without its reference', async () => {
    const { db, keychain } = await machine();
    const slow = fakeHarvest(true, true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await exportEntries(db, keychain, request(), NOW, through(slow.send), 20);
    const kept = slow.held.length;
    expect(kept).toBeGreaterThan(0);

    const now = fakeHarvest(false, true);
    now.held.push(...slow.held);
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(now.send));
    expect(second).toMatchObject({ sent: 3 - kept, failed: kept });
    expect(second.error).toMatch(/same day, hours and notes/);
    expect(now.held).toHaveLength(3);
  });

  it('never lets the token reach the result, a stored row or a log line, even when Harvest echoes it', async () => {
    const { db, keychain } = await machine();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const echo: ExportFetch = async (_url, init) =>
      init.method === 'GET'
        ? new Response(page([]), { status: 200 })
        : new Response(JSON.stringify({ message: `Bad request for ${init.headers.authorization}` }), { status: 422 });

    const result = await exportEntries(db, keychain, request(), NOW, through(echo));

    expect(result.failed).toBeGreaterThan(0);
    expect(result.error).toMatch(/^Harvest refused the entry with 422/);
    const stored = [...db.prepare('SELECT * FROM exporters').all(), ...db.prepare('SELECT * FROM export_entries').all()]
      .map((one) => Object.values(one).join('|'))
      .join('\n');
    const logs = logged.mock.calls.flat().map(String).join('\n');
    expect(logs).toContain('An export to harvest failed on one entry.');
    for (const text of [JSON.stringify(result), stored, logs]) expect(text).not.toContain(TOKEN);
  });
});
