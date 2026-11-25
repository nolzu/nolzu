// The Jira worklog exporter, driven by hand and through the export loop. No call leaves the
// process: every test hands over its own `fetch`. The test setup refuses every tracker host, so a
// test that forgets its stub fails by name.
//
// NOT RECORDED. No Jira site has ever answered this exporter. Every body here is written by hand
// from the documented REST API v3 shape, and the header of `timesheet-jira.ts` names what a first
// real call has to confirm. A green run here says this file reads what the documentation describes,
// and nothing more than that.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@nolzu/core/node';
import { type TimesheetEntry, type TimesheetRun, timesheetEntries, timesheetOf } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExportFetch, ExportSkipped } from './timesheet-call.ts';
import { EXPORT_ADAPTERS, type ExportAdapters, exportEntries, saveExporter, sentEntries } from './timesheet-export.ts';
import { exportJira, findJiraWorklog, JIRA_PROPERTY, jiraIssue, jiraRefusal } from './timesheet-jira.ts';

const PROJECT = 'proj-studio';
const WEEK = '2026-03-02';
const NOW = Date.parse('2026-03-09T10:00:00Z');
const SITE = 'https://example.atlassian.net';
// Not a real token. Words on purpose, so the secret scanner in CI leaves it alone.
const TOKEN = 'jira_not-a-real-token-for-the-worklog-tests';
const EMAIL = 'person@example.com';
const BASIC = `Basic ${btoa(`${EMAIL}:${TOKEN}`)}`;
const SETTINGS = { site: SITE, email: EMAIL };
const SIGNAL = new AbortController().signal;
const ID = 'nolzu:proj-studio:PROJ-12:2026-03-02';

const entry = (over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  externalId: ID,
  project: PROJECT,
  day: '2026-03-02',
  start: '2026-03-02T14:00:00.250Z',
  card: 'PROJ-12',
  source: 'jira',
  title: 'Fix the login form',
  minutes: 90,
  ...over,
});

const worklog = (id: string, externalId: string | null) => ({
  id,
  started: '2026-03-02T14:00:00.000+0000',
  timeSpentSeconds: 5400,
  properties: externalId === null ? [] : [{ key: JIRA_PROPERTY, value: { externalId } }],
});
const page = (rows: unknown[], total = rows.length) => JSON.stringify({ startAt: 0, maxResults: 5000, total, worklogs: rows });

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

/** A Jira that keeps each issue's worklogs with their properties, or without them with `drop`. */
function fakeJira(drop = false) {
  const held = new Map<string, Record<string, unknown>[]>();
  const calls: Call[] = [];
  let next = 10000;
  const send: ExportFetch = async (url, init) => {
    calls.push({ url, init });
    const at = new URL(url);
    const key = decodeURIComponent(at.pathname.split('/')[5] ?? '');
    const logs = held.get(key) ?? [];
    if (init.method === 'GET') {
      const shown = at.searchParams.get('expand') === 'properties' ? logs : logs.map((one) => ({ ...one, properties: undefined }));
      return new Response(page(shown), { status: 200 });
    }
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    const one = { ...body, ...(drop ? { properties: [] } : {}), id: String((next += 1)) };
    held.set(key, [...logs, one]);
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
  it('reads the worklogs of the issue, then adds one carrying the external id', async () => {
    const { calls, send } = script([200, page([worklog('7', 'someone else')])], [201, '{"id":"10042"}']);

    await expect(exportJira(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('10042');

    expect(calls.map((one) => [one.init.method, one.url])).toEqual([
      ['GET', `${SITE}/rest/api/3/issue/PROJ-12/worklog?startedAfter=1772373600000&startedBefore=1772546400000&expand=properties&maxResults=5000`],
      ['POST', `${SITE}/rest/api/3/issue/PROJ-12/worklog?notifyUsers=false`],
    ]);
    expect(JSON.parse(calls[1]?.init.body ?? '')).toEqual({
      started: '2026-03-02T14:00:00.000+0000',
      timeSpentSeconds: 5400,
      comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fix the login form' }] }] },
      properties: [{ key: 'nolzu', value: { externalId: ID } }],
    });
    for (const one of calls) {
      expect(one.init.headers.authorization).toBe(BASIC);
      expect(one.init.redirect).toBe('manual');
      expect(one.init.signal).toBe(SIGNAL);
      expect(one.url).not.toContain(TOKEN);
    }
  });

  it('answers with the id of a worklog Jira already holds for this entry, and adds nothing', async () => {
    const { calls, send } = script([200, page([worklog('7', null), worklog('8', ID)])]);

    await expect(exportJira(entry(), TOKEN, SETTINGS, SIGNAL, send)).resolves.toBe('8');
    expect(calls).toHaveLength(1);
  });

  it('skips a card that is not a Jira issue, with its reason, before any call', async () => {
    const { calls, send } = script();

    const local = exportJira(entry({ card: 'APP-7', source: 'local' }), TOKEN, SETTINGS, SIGNAL, send);
    await expect(local).rejects.toBeInstanceOf(ExportSkipped);
    await expect(local).rejects.toThrow('APP-7 is not a Jira issue, so its hours were not sent to Jira.');
    // Spelled like a Jira key and from GitHub: the spelling is never enough.
    expect(() => jiraIssue(entry({ source: 'github' }))).toThrow(ExportSkipped);
    expect(() => jiraIssue(entry({ source: null }))).toThrow(
      'The card PROJ-12 is gone, so Nolzu cannot tell whether it is a Jira issue and did not send its hours to Jira.',
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a Jira card whose key is not an issue key, as a failure and not a skip', () => {
    for (const card of ['proj-12', 'PROJ-0', 'PROJ-12/../..', 'PROJ']) {
      let thrown: unknown;
      try {
        jiraIssue(entry({ card }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ExportSkipped);
    }
  });

  it('refuses worklogs it cannot read, and adds nothing', async () => {
    const unread = [
      'not json',
      '[]',
      // The expand was ignored, so no row says whose it is.
      JSON.stringify({ total: 1, worklogs: [{ id: '8', started: '2026-03-02T14:00:00.000+0000' }] }),
      // More than came back, so the one this entry made could be past the end.
      page([worklog('7', 'someone else')], 6000),
      page([worklog('7', 'someone else')], 2),
      page([{ ...worklog('8', ID), id: 'w-8' }]),
      // The same start and length with no property of ours: this entry, if Jira dropped the property.
      page([worklog('7', null)]),
      page([{ ...worklog('7', null), started: '2026-03-02T15:00:00.000+0100' }]),
    ];
    for (const body of unread) {
      const { calls, send } = script([200, body]);
      await expect(exportJira(entry(), TOKEN, SETTINGS, SIGNAL, send)).rejects.toThrow(/not sen[dt]/);
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses a connection with no site, an http site or no email, before any call', async () => {
    const { calls, send } = script();
    for (const [settings, said] of [
      [{ email: EMAIL }, /names no Jira site address/],
      [{ site: 'http://example.atlassian.net', email: EMAIL }, /https/],
      [{ site: SITE }, /names no account email/],
    ] as [Record<string, unknown>, RegExp][]) {
      await expect(exportJira(entry(), TOKEN, settings, SIGNAL, send)).rejects.toThrow(said);
    }
    expect(calls).toHaveLength(0);
  });

  it('names what is wrong for each refusal Jira answers', () => {
    expect(jiraRefusal(401, '')).toMatch(/refused the API token/);
    expect(jiraRefusal(403, '')).toMatch(/may not log work on that issue/);
    expect(jiraRefusal(404, '')).toMatch(/email or API token/);
    expect(jiraRefusal(429, '')).toMatch(/rate limiting/);
    expect(jiraRefusal(400, '{"errorMessages":["Time tracking is off"],"errors":{}}')).toBe(
      'Jira refused the worklog with 400, so it was not sent. Jira said: Time tracking is off',
    );
    expect(jiraRefusal(400, '{"errorMessages":[],"errors":{"started":"Bad date"}}')).toMatch(/said: Bad date$/);
    expect(jiraRefusal(401, '<html>log in</html>')).toMatch(/web page/);
  });

  it('takes the token out of what Jira says before the sentence is cut', async () => {
    // The cut lands inside the echoed token, so only this file can take it out whole.
    const echoed = JSON.stringify({ errorMessages: [`${'x'.repeat(190)}${TOKEN}`] });
    const { send } = script([200, page([])], [400, echoed]);
    const said = await exportJira(entry(), TOKEN, SETTINGS, SIGNAL, send).catch((error: Error) => error.message);
    expect(said).not.toContain(TOKEN.slice(0, 10));
  });

  it('reads an issue with no worklogs as nothing to find', () => {
    expect(findJiraWorklog(page([]), entry())).toBeNull();
    // Another length, or another start, with no property is somebody else's work.
    expect(findJiraWorklog(page([{ ...worklog('7', null), timeSpentSeconds: 1800 }]), entry())).toBeNull();
    expect(findJiraWorklog(page([{ ...worklog('7', null), started: '2026-03-02T15:00:00.000+0000' }]), entry())).toBeNull();
  });
});

describe('a week through the export loop', () => {
  const run = (start: string, key: string, source: string, minutes: number): TimesheetRun => ({
    start,
    key,
    label: `${key} work`,
    source,
    durationMs: minutes * 60_000,
    running: false,
  });
  // Three local cards come first, so a skip counted as a failure would end the run before Jira.
  const entries = timesheetEntries(
    timesheetOf(
      [
        run('2026-03-02T08:00:00.000Z', 'APP-1', 'local', 15),
        run('2026-03-02T09:00:00.000Z', 'APP-2', 'local', 15),
        run('2026-03-02T10:00:00.000Z', 'APP-3', 'local', 15),
        run('2026-03-02T14:00:00.000Z', 'PROJ-12', 'jira', 90),
        run('2026-03-03T09:00:00.000Z', 'PROJ-12', 'jira', 30),
        run('2026-03-04T09:00:00.000Z', 'PROJ-13', 'jira', 45),
      ],
      WEEK,
    ),
    PROJECT,
  );
  const request = () => ({ destination: 'jira' as const, entries });

  async function machine() {
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-jira-'));
    const db = openDatabase(dir);
    opened.push({ db, dir });
    const held = new Map<string, string>();
    const keychain: Keychain = {
      read: async (name) => held.get(name) ?? null,
      write: async (name, secret) => void held.set(name, secret),
      remove: async (name) => void held.delete(name),
    };
    await saveExporter(db, keychain, { destination: 'jira', settings: SETTINGS, token: TOKEN }, NOW - 60_000);
    return { db, keychain };
  }

  const through = (send: ExportFetch): ExportAdapters => ({
    jira: (one, secret, settings, signal) => exportJira(one, secret, settings, signal, send),
  });

  it('is the adapter the export loop holds', () => {
    expect(EXPORT_ADAPTERS.jira).toBe(exportJira);
  });

  it('writes one worklog per Jira card and day, skips the rest with a reason, and a re-run writes nothing', async () => {
    const { db, keychain } = await machine();
    const jira = fakeJira();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await exportEntries(db, keychain, request(), NOW, through(jira.send));

    expect(first).toMatchObject({ sent: 3, skipped: 3, failed: 0, error: null });
    expect(logged).not.toHaveBeenCalled();
    expect(jira.held.get('PROJ-12')?.map((one) => [one.started, one.timeSpentSeconds])).toEqual([
      ['2026-03-02T14:00:00.000+0000', 5400],
      ['2026-03-03T09:00:00.000+0000', 1800],
    ]);
    expect(jira.held.get('PROJ-13')).toHaveLength(1);
    expect([...jira.held.keys()].sort()).toEqual(['PROJ-12', 'PROJ-13']);
    const rows = sentEntries(db, 'jira', WEEK, '2026-03-08');
    const skipped = rows.filter((one) => one.sent_at === null);
    expect(skipped.map((one) => [one.attempts, one.last_error])).toEqual([
      [0, 'APP-1 is not a Jira issue, so its hours were not sent to Jira.'],
      [0, 'APP-2 is not a Jira issue, so its hours were not sent to Jira.'],
      [0, 'APP-3 is not a Jira issue, so its hours were not sent to Jira.'],
    ]);

    const before = jira.calls.length;
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(jira.send));
    expect(second).toMatchObject({ sent: 0, already: 3, skipped: 3, stuck: 0 });
    expect(jira.calls).toHaveLength(before);
  });

  it('finds a worklog Jira took on a press that failed, and does not add it again', async () => {
    const { db, keychain } = await machine();
    const jira = fakeJira();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Jira takes every post and this side reads each answer as a 502 from a proxy.
    const lost: ExportFetch = async (url, init) => {
      const answer = await jira.send(url, init);
      return init.method === 'POST' ? new Response('', { status: 502 }) : answer;
    };

    const first = await exportEntries(db, keychain, request(), NOW, through(lost));
    expect(first).toMatchObject({ sent: 0, failed: 3 });
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(jira.send));

    expect(second).toMatchObject({ sent: 3, failed: 0 });
    expect(jira.held.get('PROJ-12')).toHaveLength(2);
    expect(jira.held.get('PROJ-13')).toHaveLength(1);
  });

  it('refuses, and does not add again, a worklog Jira took on a failed press without its property', async () => {
    const { db, keychain } = await machine();
    const jira = fakeJira(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lost: ExportFetch = async (url, init) => {
      const answer = await jira.send(url, init);
      return init.method === 'POST' ? new Response('', { status: 502 }) : answer;
    };

    await exportEntries(db, keychain, request(), NOW, through(lost));
    const second = await exportEntries(db, keychain, request(), NOW + 1, through(jira.send));

    expect(second).toMatchObject({ sent: 0, failed: 3 });
    expect(second.error).toMatch(/same start and length/);
    expect(jira.held.get('PROJ-12')).toHaveLength(2);
    expect(jira.held.get('PROJ-13')).toHaveLength(1);
  });

  it('stops on the failure cap when local cards sit between the failures', async () => {
    const { db, keychain } = await machine();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down: ExportFetch = async () => new Response('', { status: 502 });
    const mixed = timesheetEntries(
      timesheetOf(
        [
          run('2026-03-02T08:00:00.000Z', 'PROJ-1', 'jira', 15),
          run('2026-03-02T09:00:00.000Z', 'APP-1', 'local', 15),
          run('2026-03-02T10:00:00.000Z', 'PROJ-2', 'jira', 15),
          run('2026-03-02T11:00:00.000Z', 'APP-2', 'local', 15),
          run('2026-03-02T12:00:00.000Z', 'PROJ-3', 'jira', 15),
          run('2026-03-02T13:00:00.000Z', 'PROJ-4', 'jira', 15),
        ],
        WEEK,
      ),
      PROJECT,
    ).sort((a, b) => a.start.localeCompare(b.start));

    const result = await exportEntries(db, keychain, { destination: 'jira', entries: mixed }, NOW, through(down));

    // A skip calls nothing, so it says nothing about whether Jira is back.
    expect(result).toMatchObject({ failed: 3, skipped: 2, left: 1 });
  });

  it('never lets the token reach the result, a stored row or a log line, even when Jira echoes it', async () => {
    const { db, keychain } = await machine();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const echo: ExportFetch = async (_url, init) =>
      init.method === 'GET'
        ? new Response(page([]), { status: 200 })
        : new Response(JSON.stringify({ errorMessages: [`Bad ${TOKEN} in ${init.headers.authorization}`] }), { status: 400 });

    const result = await exportEntries(db, keychain, request(), NOW, through(echo));

    expect(result.failed).toBeGreaterThan(0);
    expect(result.error).toMatch(/^Jira refused the worklog with 400/);
    const stored = [...db.prepare('SELECT * FROM exporters').all(), ...db.prepare('SELECT * FROM export_entries').all()]
      .map((one) => Object.values(one).join('|'))
      .join('\n');
    const logs = logged.mock.calls.flat().map(String).join('\n');
    expect(logs).toContain('An export to jira failed on one entry.');
    for (const text of [JSON.stringify(result), stored, logs]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(btoa(`${EMAIL}:${TOKEN}`));
    }
  });
});
