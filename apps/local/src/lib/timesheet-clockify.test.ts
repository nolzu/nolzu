// The Clockify exporter, driven by hand and through the export loop, and one export to Harvest and
// Clockify side by side. No call leaves the process: every test hands over its own `fetch`. The
// test setup refuses every tracker host, so a test that forgets its stub fails by name.
//
// NOT RECORDED. Clockify has never answered this project. Every body here is written by hand from
// the documented API v1 shape, and the header of `timesheet-clockify.ts` names what a first real
// call has to confirm. A green run here says this file reads what the documentation describes, and
// nothing more than that.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@nolzu/core/node';
import { type TimesheetEntry, type TimesheetRun, timesheetEntries, timesheetOf } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportFetch } from './timesheet-call.ts';
import { CLOCKIFY_ORIGIN, clockifyBody, clockifyRefusal, exportClockify, findClockifyEntry } from './timesheet-clockify.ts';
import { EXPORT_ADAPTERS, type ExportAdapters, type ExportDestination, exportEntries, saveExporter, sentEntries } from './timesheet-export.ts';
import { exportHarvest } from './timesheet-harvest.ts';

const PROJECT = 'proj-studio';
const WEEK = '2026-03-02';
const NOW = Date.parse('2026-03-09T10:00:00Z');
// Not a real key. Words on purpose, so the secret scanner in CI leaves it alone.
const TOKEN = 'clk_not-a-real-key-for-the-clockify-tests';
const WORKSPACE = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const PROJECT_ID = 'f6e5d4c3b2a1f6e5d4c3b2a1';
const USER = '0123456789abcdef01234567';
const SETTINGS = { workspace: WORKSPACE };
const SIGNAL = new AbortController().signal;
const ME = JSON.stringify({ id: USER, name: 'Test person' });

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
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  description: 'APP-7 Fix the login form',
  timeInterval: { start: '2026-03-02T14:00:00Z', end: '2026-03-02T15:30:00Z', duration: 'PT1H30M' },
  ...over,
});

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

/** A Clockify that keeps what it is sent, so a second export can find it. */
function fakeClockify(hang = false) {
  const held: Record<string, unknown>[] = [];
  const calls: Call[] = [];
  const send: ExportFetch = async (url, init) => {
    calls.push({ url, init });
    const at = new URL(url);
    if (at.pathname === '/api/v1/user') return new Response(ME, { status: 200 });
    if (init.method === 'GET') {
      const from = Date.parse(at.searchParams.get('start') ?? '');
      const to = Date.parse(at.searchParams.get('end') ?? '');
      const day = held.filter((one) => {
        const start = Date.parse((one.timeInterval as { start: string }).start);
        return start >= from && start < to;
      });
      return new Response(JSON.stringify(day), { status: 200 });
    }
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    const one = { id: String(held.length).padStart(24, 'c'), description: body.description, timeInterval: { start: body.start, end: body.end } };
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
  it('asks who owns the key, reads the day, then posts the entry the mapping built', async () => {
    const { calls, send } = script([200, ME], [200, '[]'], [201, JSON.stringify(row({ id: 'b'.repeat(24) }))]);

    const id = await exportClockify(entry(), TOKEN, { workspace: WORKSPACE, project: PROJECT_ID }, SIGNAL, send);

    expect(id).toBe('b'.repeat(24));
    expect(calls.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', 'https://api.clockify.me/api/v1/user'],
      [
        'GET',
        `${CLOCKIFY_ORIGIN}/api/v1/workspaces/${WORKSPACE}/user/${USER}/time-entries?start=2026-03-01T14%3A00%3A00Z&end=2026-03-03T14%3A00%3A00Z&page-size=200`,
      ],
      ['POST', `${CLOCKIFY_ORIGIN}/api/v1/workspaces/${WORKSPACE}/time-entries`],
    ]);
    expect(JSON.parse(calls[2]?.init.body ?? '')).toEqual({
      start: '2026-03-02T14:00:00Z',
      end: '2026-03-02T15:30:00Z',
      description: 'APP-7 Fix the login form',
      projectId: PROJECT_ID,
    });
    for (const one of calls) {
      expect(one.init.headers['x-api-key']).toBe(TOKEN);
      expect(one.init.redirect).toBe('manual');
      expect(one.init.signal).toBe(SIGNAL);
      expect(one.url).not.toContain(TOKEN);
    }
  });

  it('sends no project when the connection names none', () => {
    expect(clockifyBody(entry(), null)).not.toHaveProperty('projectId');
  });

  it('answers with the id of an entry Clockify already holds, and posts nothing', async () => {
    const other = row({ id: 'd'.repeat(24), timeInterval: { start: '2026-03-02T14:00:00Z', end: '2026-03-02T14:01:00Z' } });
    const { calls, send } = script([200, ME], [200, JSON.stringify([other, row()])]);

    await expect(exportClockify(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('a'.repeat(24));
    expect(calls).toHaveLength(2);
  });

  it('posts when the rows around that day are some other work', async () => {
    const others = [
      row({ description: 'APP-8 Fix the login form' }),
      row({ description: null }),
      row({ timeInterval: { start: '2026-03-02T14:00:01Z', end: '2026-03-02T15:30:01Z' } }),
    ];
    const { calls, send } = script([200, ME], [200, JSON.stringify(others)], [201, JSON.stringify(row({ id: 'e'.repeat(24) }))]);

    await expect(exportClockify(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('e'.repeat(24));
    expect(calls).toHaveLength(3);
  });

  it('refuses a day it cannot read, and posts nothing', async () => {
    const unread = [
      '{"data":[]}',
      'not json',
      JSON.stringify([{ id: 'x', start: '2026-03-02T14:00:00Z', end: '2026-03-02T15:30:00Z' }]),
      JSON.stringify([row({ description: undefined, text: 'APP-7 Fix the login form' })]),
      JSON.stringify([row({ id: 42 })]),
      // A full page, which could leave the entry on the next one.
      JSON.stringify(Array.from({ length: 200 }, () => row({ description: 'other' }))),
    ];
    for (const body of unread) {
      const { calls, send } = script([200, ME], [200, body]);
      await expect(exportClockify(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/not sen[dt]/);
      expect(calls).toHaveLength(2);
    }
  });

  it('refuses a key owner it cannot read, and reads nothing else', async () => {
    const { calls, send } = script([200, '{"name":"no id"}']);
    await expect(exportClockify(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/who owns the API key/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a post it cannot read rather than marking the entry sent', async () => {
    const { send } = script([200, ME], [200, '[]'], [201, '{"ok":true}']);
    await expect(exportClockify(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/is not marked as sent/);
  });

  it('refuses a connection with no workspace or one that is not an id, before any call', async () => {
    const { calls, send } = script();
    for (const settings of [{}, { workspace: 'studio' }, { workspace: `${WORKSPACE}/../x` }]) {
      await expect(exportClockify(entry(), TOKEN, settings, SIGNAL, send)).rejects.toThrow(/workspace/);
    }
    await expect(exportClockify(entry(), TOKEN, { workspace: WORKSPACE, project: 42 }, SIGNAL, send)).rejects.toThrow(/project/);
    expect(calls).toHaveLength(0);
  });

  it('names what is wrong for each refusal Clockify answers', () => {
    expect(clockifyRefusal(401, '')).toMatch(/refused the API key/);
    expect(clockifyRefusal(403, '')).toMatch(/cannot use that workspace/);
    expect(clockifyRefusal(404, '')).toMatch(/does not know that workspace or project/);
    expect(clockifyRefusal(429, '')).toMatch(/rate limiting/);
    expect(clockifyRefusal(500, '')).toBe('Clockify answered 500, so the entry was not sent. Export again later.');
    expect(clockifyRefusal(400, '{"message":"Project is archived","code":501}')).toBe(
      'Clockify refused the entry with 400, so it was not sent. Clockify said: Project is archived',
    );
    expect(clockifyRefusal(401, '<html>sign in</html>')).toMatch(/web page/);
  });

  it('reads an empty day as nothing to find', () => {
    expect(findClockifyEntry('[]', entry())).toBeNull();
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
  const request = (destination: ExportDestination = 'clockify') => ({ destination, entries });

  async function machine() {
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-clockify-'));
    const db = openDatabase(dir);
    opened.push({ db, dir });
    const held = new Map<string, string>();
    const keychain: Keychain = {
      read: async (name) => held.get(name) ?? null,
      write: async (name, secret) => void held.set(name, secret),
      remove: async (name) => void held.delete(name),
    };
    await saveExporter(db, keychain, { destination: 'clockify', settings: SETTINGS, token: TOKEN }, NOW - 60_000);
    return { db, keychain };
  }

  const through = (send: ExportFetch): ExportAdapters => ({
    clockify: (one, secret, settings, signal) => exportClockify(one, secret, settings, signal, send),
  });

  it('is the adapter the export loop holds', () => {
    expect(EXPORT_ADAPTERS.clockify).toBe(exportClockify);
  });

  it('posts the entries the mapping produced, and a second export posts nothing', async () => {
    const { db, keychain } = await machine();
    const clockify = fakeClockify();

    const first = await exportEntries(db, keychain, request(), NOW, through(clockify.send));
    expect(first).toMatchObject({ sent: 3, already: 0, failed: 0, error: null });
    expect(clockify.held.map((one) => [one.description, (one.timeInterval as { start: string }).start])).toEqual(
      entries.map((one) => [`${one.card} ${one.title}`, `${one.start.slice(0, 19)}Z`]),
    );

    const before = clockify.calls.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(clockify.send));
    expect(second).toMatchObject({ sent: 0, already: 3 });
    expect(clockify.calls).toHaveLength(before);
    expect(clockify.held).toHaveLength(3);
  });

  it('finds an entry Clockify took before the timeout, and does not post it again', async () => {
    const { db, keychain } = await machine();
    const slow = fakeClockify(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await exportEntries(db, keychain, request(), NOW, through(slow.send), 20);
    expect(first.sent).toBe(0);
    expect(slow.held.length).toBeGreaterThan(0);

    const now = fakeClockify();
    now.held.push(...slow.held);
    const kept = slow.held.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(now.send));
    expect(second).toMatchObject({ sent: 3, failed: 0 });
    expect(now.held).toHaveLength(3);
    expect(now.calls.filter((one) => one.init.method === 'POST')).toHaveLength(3 - kept);
  });

  it('leaves the Clockify rows alone when the Harvest export of the same week fails', async () => {
    const { db, keychain } = await machine();
    await saveExporter(db, keychain, { destination: 'harvest', settings: { account: '1', project: '2', task: '3' }, token: 'hvst_not-a-real-token' }, NOW - 60_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const clockify = fakeClockify();
    const down: ExportFetch = async () => new Response('', { status: 503 });
    const both: ExportAdapters = {
      ...through(clockify.send),
      harvest: (one, secret, settings, signal) => exportHarvest(one, secret, settings, signal, down),
    };

    const sent = await exportEntries(db, keychain, request(), NOW, both);
    const failed = await exportEntries(db, keychain, request('harvest'), NOW + 1, both);

    expect(sent).toMatchObject({ sent: 3, failed: 0 });
    expect(failed).toMatchObject({ sent: 0, failed: 3, error: 'Harvest answered 503, so the entry was not sent. Export again later.' });
    const rows = sentEntries(db, 'clockify', WEEK, '2026-03-08');
    const at = new Date(NOW).toISOString();
    expect(rows.map((one) => [one.sent_at, one.attempts, one.last_error])).toEqual([
      [at, 1, null],
      [at, 1, null],
      [at, 1, null],
    ]);
    expect(sentEntries(db, 'harvest', WEEK, '2026-03-08').every((one) => one.sent_at === null)).toBe(true);
    // And the other way round: the Clockify week is still sent, so pressing it again posts nothing.
    const again = await exportEntries(db, keychain, request(), NOW + 2, both);
    expect(again).toMatchObject({ sent: 0, already: 3 });
  });

  it('never lets the token reach the result, a stored row or a log line, even when Clockify echoes it', async () => {
    const { db, keychain } = await machine();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const echo: ExportFetch = async (url, init) =>
      url.endsWith('/user')
        ? new Response(ME, { status: 200 })
        : init.method === 'GET'
          ? new Response('[]', { status: 200 })
          : new Response(JSON.stringify({ message: `Bad key ${init.headers['x-api-key']}` }), { status: 400 });

    const result = await exportEntries(db, keychain, request(), NOW, through(echo));

    expect(result.failed).toBeGreaterThan(0);
    expect(result.error).toMatch(/^Clockify refused the entry with 400/);
    const stored = [...db.prepare('SELECT * FROM exporters').all(), ...db.prepare('SELECT * FROM export_entries').all()]
      .map((one) => Object.values(one).join('|'))
      .join('\n');
    const logs = logged.mock.calls.flat().map(String).join('\n');
    expect(logs).toContain('An export to clockify failed on one entry.');
    for (const text of [JSON.stringify(result), stored, logs]) expect(text).not.toContain(TOKEN);
  });
});
