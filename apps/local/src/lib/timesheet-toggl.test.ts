// The Toggl exporter, driven by hand and through the export loop. No call leaves the process: every
// test hands over its own `fetch`. The test setup refuses every tracker host, so a test that
// forgets its stub fails by name.
//
// NOT RECORDED. Toggl has never answered this project. Every body here is written by hand from the
// documented API v9 shape, and the header of `timesheet-toggl.ts` names what a first real call has
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
import type { ExportFetch } from './timesheet-call.ts';
import { EXPORT_ADAPTERS, type ExportAdapters, exportEntries, saveExporter, sentEntries } from './timesheet-export.ts';
import { exportToggl, findTogglEntry, TOGGL_ORIGIN, togglBody, togglDayPath, togglRefusal } from './timesheet-toggl.ts';

const PROJECT = 'proj-studio';
const WEEK = '2026-03-02';
const NOW = Date.parse('2026-03-09T10:00:00Z');
// Not a real token. Words on purpose, so the secret scanner in CI leaves it alone, and long enough
// that a leak into a url, a sentence or a log is plain to see.
const TOKEN = 'tgl_not-a-real-token-for-the-toggl-tests';
const BASIC = `Basic ${btoa(`${TOKEN}:api_token`)}`;
const SETTINGS = { workspace: '42' };
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

// A row of the day list as the documentation describes one, for the entry above.
const row = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  workspace_id: 42,
  start: '2026-03-02T14:00:00+00:00',
  duration: 5400,
  description: 'APP-7 Fix the login form',
  ...over,
});

interface Call {
  url: string;
  init: Parameters<ExportFetch>[1];
}

// Answers the calls in order, one response per call. Nothing leaves the process.
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
 * A Toggl that keeps what it is sent, so a second export can find it. `hang` holds a post back until
 * its signal fires, after the entry is stored, which is the timeout the export loop cannot see past.
 */
function fakeToggl(hang = false) {
  const held: Record<string, unknown>[] = [];
  const calls: Call[] = [];
  const send: ExportFetch = async (url, init) => {
    calls.push({ url, init });
    const at = new URL(url);
    if (init.method === 'GET') {
      // Times, not dates: a bare date is a day in the profile's zone, which this fake cannot know.
      const from = Date.parse(at.searchParams.get('start_date') ?? '');
      const to = Date.parse(at.searchParams.get('end_date') ?? '');
      if (!/T.*Z$/.test(at.searchParams.get('start_date') ?? '')) throw new Error('A bare date was sent.');
      const day = held.filter((one) => {
        const start = Date.parse(String(one.start));
        return start >= from && start < to;
      });
      return new Response(JSON.stringify(day), { status: 200 });
    }
    const one = { ...(JSON.parse(init.body ?? '{}') as Record<string, unknown>), id: 5000 + held.length };
    held.push(one);
    if (hang) return new Promise<Response>((_, no) => init.signal.addEventListener('abort', () => no(new Error('aborted'))));
    return new Response(JSON.stringify(one), { status: 200 });
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
  it('reads the day, then posts the entry the mapping built, and answers with the Toggl id', async () => {
    const { calls, send } = script([200, '[]'], [200, JSON.stringify(row({ id: 777 }))]);

    const id = await exportToggl(entry(), TOKEN, { workspace: '42', project: 31 }, SIGNAL, send);

    expect(id).toBe('777');
    expect(calls.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', `${TOGGL_ORIGIN}/api/v9/me/time_entries?start_date=2026-03-01T14%3A00%3A00Z&end_date=2026-03-03T14%3A00%3A00Z`],
      ['POST', `${TOGGL_ORIGIN}/api/v9/workspaces/42/time_entries`],
    ]);
    expect(JSON.parse(calls[1]?.init.body ?? '')).toEqual({
      created_with: 'Nolzu',
      workspace_id: 42,
      // To the second, which is what Toggl keeps and what the read matches on.
      start: '2026-03-02T14:00:00.000Z',
      duration: 5400,
      description: 'APP-7 Fix the login form',
      project_id: 31,
    });
    for (const one of calls) {
      expect(one.init.headers.authorization).toBe(BASIC);
      expect(one.init.redirect).toBe('manual');
      expect(one.init.signal).toBe(SIGNAL);
      expect(one.url).not.toContain(TOKEN);
    }
  });

  it('sends no project when the connection names none', () => {
    expect(togglBody(entry(), 42, null)).not.toHaveProperty('project_id');
  });

  it('answers with the id of an entry Toggl already holds, and posts nothing', async () => {
    const { calls, send } = script([200, JSON.stringify([row({ id: 1, duration: 60 }), row({ id: 9001 })])]);

    await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('9001');
    expect(calls).toHaveLength(1);
  });

  it('finds it by the workspace, not the project, and by the start cut to the second', async () => {
    const { calls, send } = script([200, JSON.stringify([row()])]);
    const late = entry({ start: '2026-03-02T14:00:00.750Z' });

    await expect(exportToggl(late, TOKEN, { workspace: '42', project: 31 }, SIGNAL, send)).resolves.toBe('9001');
    expect(calls).toHaveLength(1);
  });

  it('posts when the rows on that day are some other work', async () => {
    const others = [row({ workspace_id: 43 }), row({ duration: 5460 }), row({ start: '2026-03-02T14:00:01Z' }), row({ description: 'APP-8 Fix the login form' })];
    const { calls, send } = script([200, JSON.stringify(others)], [200, JSON.stringify(row({ id: 12 }))]);

    await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('12');
    expect(calls).toHaveLength(2);
  });

  it('refuses a day it cannot read, and posts nothing', async () => {
    const renamed = [
      { begin: '2026-03-02T14:00:00Z', duration: 5400 },
      { start: '2026-03-02T14:00:00Z', seconds: 5400 },
    ];
    for (const body of ['{"data":[]}', 'not json', '[null]', ...renamed.map((one) => JSON.stringify([one]))]) {
      const { calls, send } = script([200, body]);
      await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/so the entry was not sent/);
      expect(calls).toHaveLength(1);
    }
    // Only a 200 is a day. Any other answer read as one could be read as empty.
    const { calls, send } = script([202, '[]']);
    await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/was not sent/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a row at the same time whose workspace, description or id it cannot read', async () => {
    const unread = [
      { ...row(), workspace_id: undefined, wid: 42 },
      { ...row(), description: undefined, text: 'APP-7 Fix the login form' },
      row({ id: 'toggl-9001' }),
      row({ workspace_id: '42' }),
    ];
    for (const one of unread) {
      const { calls, send } = script([200, JSON.stringify([one])]);
      await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/was not sent/);
      expect(calls).toHaveLength(1);
    }
    // Toggl's null description is a readable one: some other entry, so the post goes ahead.
    const { calls, send } = script([200, JSON.stringify([row({ description: null })])], [200, '{"id":3}']);
    await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('3');
    expect(calls).toHaveLength(2);
  });

  it('refuses a post it cannot read rather than marking the entry sent', async () => {
    for (const posted of ['{"ok":true}', '{"id":0}']) {
      const { send } = script([200, '[]'], [200, posted]);
      await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(
        'Toggl answered the post with something Nolzu could not read, so the entry is not marked as sent. The next export looks for it in Toggl before it posts again.',
      );
    }
  });

  it('refuses a connection with no workspace or a workspace that is not an id, before any call', async () => {
    const { calls, send } = script();
    for (const settings of [{}, { workspace: 'studio' }, { workspace: '42/../../users' }, { workspace: 0 }]) {
      await expect(exportToggl(entry(), TOKEN, settings, SIGNAL, send)).rejects.toThrow(/workspace/);
    }
    await expect(exportToggl(entry(), TOKEN, { workspace: 42, project: 'x' }, SIGNAL, send)).rejects.toThrow(/project/);
    expect(calls).toHaveLength(0);
  });

  it('names what is wrong for each refusal Toggl answers', () => {
    expect(togglRefusal(401, '')).toMatch(/refused the API token/);
    expect(togglRefusal(403, '')).toMatch(/refused the API token/);
    expect(togglRefusal(402, '')).toMatch(/API quota/);
    expect(togglRefusal(404, '')).toMatch(/does not know that workspace/);
    expect(togglRefusal(429, '')).toMatch(/rate limiting/);
    expect(togglRefusal(503, '')).toBe('Toggl answered 503, so the entry was not sent. Export again later.');
    expect(togglRefusal(400, '"Invalid project_id"')).toBe('Toggl refused the entry with 400, so it was not sent. Toggl said: Invalid project_id');
    expect(togglRefusal(400, '{"message":"start is too old"}')).toMatch(/Toggl said: start is too old$/);
    expect(togglRefusal(401, '<html>sign in</html>')).toMatch(/web page/);
  });

  it('takes the token out before the cut and after the decode', () => {
    const long = togglRefusal(400, JSON.stringify(`${'x'.repeat(190)}${TOKEN}`), [TOKEN]);
    expect(long).not.toContain(TOKEN.slice(0, 10));
    // A base64 form with an escaped slash gets past a split on the raw text, not past this one.
    const escaped = togglRefusal(400, '{"message":"bad header YWJj\\/ZA=="}', ['YWJj/ZA==']);
    expect(escaped).toMatch(/bad header …$/);
  });

  it('does not follow a redirect and does not read a web page as a day', async () => {
    for (const status of [300, 302]) {
      await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, script([status, '']).send)).rejects.toThrow(
        'Toggl answered with a redirect, so the entry was not sent.',
      );
    }
    await expect(exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, script([200, '<!doctype html>']).send)).rejects.toThrow(/web page/);
  });

  it('keeps the transport error, and the token inside it, out of its sentence', async () => {
    const send: ExportFetch = async () => {
      throw new Error(`connect failed with authorization ${BASIC}`);
    };
    const failure = exportToggl(entry(), TOKEN, SETTINGS, SIGNAL, send);
    await expect(failure).rejects.toThrow('Nolzu could not reach Toggl, so the entry was not sent. Export again later.');
    // The whole sentence and nothing after it, so no part of the transport error rides along.
    await expect(failure).rejects.toHaveProperty('message', 'Nolzu could not reach Toggl, so the entry was not sent. Export again later.');
    await expect(failure).rejects.not.toHaveProperty('cause');
  });

  it('reads a day with no entries as a day with nothing to find', () => {
    expect(findTogglEntry('[]', entry(), 42)).toBeNull();
    // Near midnight, the window still holds the start whatever zone the profile is in.
    expect(decodeURIComponent(togglDayPath('2026-02-28T23:59:30.400Z'))).toBe(
      '/api/v9/me/time_entries?start_date=2026-02-27T23:59:30Z&end_date=2026-03-01T23:59:30Z',
    );
  });
});

// Through `exportEntries`, against a real sqlite file and a keychain held in memory.
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
  const request = () => ({ destination: 'toggl' as const, entries });

  async function machine() {
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-toggl-'));
    const db = openDatabase(dir);
    opened.push({ db, dir });
    const held = new Map<string, string>();
    const keychain: Keychain = {
      read: async (name) => held.get(name) ?? null,
      write: async (name, secret) => void held.set(name, secret),
      remove: async (name) => void held.delete(name),
    };
    await saveExporter(db, keychain, { destination: 'toggl', settings: SETTINGS, token: TOKEN }, NOW - 60_000);
    return { db, keychain };
  }

  const through = (send: ExportFetch): ExportAdapters => ({
    toggl: (one, secret, settings, signal) => exportToggl(one, secret, settings, signal, send),
  });

  it('is the adapter the export loop holds', () => {
    expect(EXPORT_ADAPTERS.toggl).toBe(exportToggl);
  });

  it('posts the entries the mapping produced, and a second export posts nothing', async () => {
    const { db, keychain } = await machine();
    const toggl = fakeToggl();

    const first = await exportEntries(db, keychain, request(), NOW, through(toggl.send));
    expect(first).toMatchObject({ sent: 3, already: 0, failed: 0, error: null });
    expect(toggl.held.map((one) => [one.description, one.duration, one.start])).toEqual(
      entries.map((one) => [`${one.card} ${one.title}`, one.minutes * 60, one.start]),
    );

    const before = toggl.calls.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(toggl.send));
    expect(second).toMatchObject({ sent: 0, already: 3 });
    // Skipped by the external id before Toggl is asked anything.
    expect(toggl.calls).toHaveLength(before);
    expect(toggl.held).toHaveLength(3);
    expect(sentEntries(db, 'toggl', WEEK, '2026-03-08').map((one) => one.remote_id)).toEqual(['5000', '5001', '5002']);
  });

  it('finds an entry Toggl took before the timeout, and does not post it again', async () => {
    const { db, keychain } = await machine();
    const slow = fakeToggl(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await exportEntries(db, keychain, request(), NOW, through(slow.send), 20);
    // Toggl holds the first entry, and this side saw a timeout.
    expect(first.sent).toBe(0);
    expect(slow.held.length).toBeGreaterThan(0);

    // The same Toggl, answering in time now.
    const now = fakeToggl();
    now.held.push(...slow.held);
    const kept = slow.held.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(now.send));
    expect(second).toMatchObject({ sent: 3, failed: 0 });
    expect(now.held).toHaveLength(3);
    expect(now.calls.filter((one) => one.init.method === 'POST')).toHaveLength(3 - kept);
  });

  it('never lets the token reach the result, a stored row or a log line, even when Toggl echoes it', async () => {
    const { db, keychain } = await machine();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const echo: ExportFetch = async (_url, init) =>
      init.method === 'GET'
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify(`Bad request for ${TOKEN} and ${init.headers.authorization}`), { status: 400 });

    const result = await exportEntries(db, keychain, request(), NOW, through(echo));

    expect(result.failed).toBeGreaterThan(0);
    expect(result.error).toMatch(/^Toggl refused the entry with 400/);
    const stored = [...db.prepare('SELECT * FROM exporters').all(), ...db.prepare('SELECT * FROM export_entries').all()]
      .map((one) => Object.values(one).join('|'))
      .join('\n');
    const logs = logged.mock.calls.flat().map(String).join('\n');
    expect(logs).toContain('An export to toggl failed on one entry.');
    for (const text of [JSON.stringify(result), stored, logs]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(btoa(`${TOKEN}:api_token`));
    }
  });
});
