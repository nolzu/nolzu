import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, startRun } from '@nolzu/core/node';
import type { RunEvent } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRunLine } from '@nolzu/runner';
import { logRows } from '@nolzu/ui';
import { logFor, logResponse, rawLog } from './run-log.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-run-log-'));
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Sort the list' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const run = (key: string, logPath: string) =>
  startRun(db, { cardKey: key, phase: 'plan', engine: 'fake', model: 'sonnet', effort: 'medium', sessionId: null, logPath, lane: null });

// Each line of the file is one text event, so the stream is easy to read back.
const parse = (line: string): RunEvent[] => [{ type: 'text', text: line }];

async function read(stream: ReadableStream<Uint8Array>, lines: number): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (text.split('\n').filter(Boolean).length < lines) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split('\n').filter(Boolean);
}

it('replays the lines already there as events, then the lines added after', async () => {
  const path = join(dir, 'APP-1-plan-1.ndjson');
  writeFileSync(path, 'one\ntwo\n');
  const id = run('APP-1', path);
  const controller = new AbortController();

  const response = await logResponse(db, parse, 'APP-1', String(id), controller.signal, { raw: false, pollMs: 10 });
  const body = response.body!;

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  expect(await read(body, 2)).toEqual([JSON.stringify({ type: 'text', text: 'one' }), JSON.stringify({ type: 'text', text: 'two' })]);
  appendFileSync(path, 'three\nfour\n');
  expect(await read(body, 2)).toEqual([JSON.stringify({ type: 'text', text: 'three' }), JSON.stringify({ type: 'text', text: 'four' })]);

  // Aborting ends the stream, which is what lets go of the file.
  controller.abort();
  const reader = body.getReader();
  expect((await reader.read()).done).toBe(true);
});

// The log file holds the lines of the engine that wrote it. Read with whatever engine the setting
// names today, a stored Codex log would fall through the Claude parser and the tab would be empty.
it('reads a stored log with the parser of the engine the run ran on', async () => {
  const codexLog = join(dir, 'APP-1-plan-codex.ndjson');
  writeFileSync(codexLog, '{"type":"thread.started","thread_id":"01a0d87e"}\n');
  const codex = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'codex#work', model: 'gpt-5.6-sol', effort: 'xhigh', sessionId: null, logPath: codexLog, lane: null });
  const claudeLog = join(dir, 'APP-1-plan-claude.ndjson');
  writeFileSync(claudeLog, '{"type":"system","subtype":"init","session_id":"b41e9a07","model":"sonnet","tools":[]}\n');
  const claude = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: null, logPath: claudeLog, lane: null });

  const fromCodex = await logResponse(db, parseRunLine, 'APP-1', String(codex), new AbortController().signal, { raw: false });
  const fromClaude = await logResponse(db, parseRunLine, 'APP-1', String(claude), new AbortController().signal, { raw: false });

  expect(await read(fromCodex.body!, 1)).toEqual([JSON.stringify({ type: 'session', sessionId: '01a0d87e', model: null, apiKeyMode: null })]);
  expect(await read(fromClaude.body!, 1)).toEqual([JSON.stringify({ type: 'session', sessionId: 'b41e9a07', model: 'sonnet', apiKeyMode: false })]);
});

it('refuses a run that belongs to another card, with 404', async () => {
  const id = run('APP-2', join(dir, 'APP-2-plan-1.ndjson'));

  const response = await logResponse(db, parse, 'APP-1', String(id), new AbortController().signal, { raw: false });

  expect(response.status).toBe(404);
});

it.each(['', 'x', '1.5', '-1'])('refuses a run id that is not one, %j, with 400', async (id) => {
  expect((await logResponse(db, parse, 'APP-1', id, new AbortController().signal, { raw: false })).status).toBe(400);
});

it('serves the raw file for download, named after the card and the run', async () => {
  const path = join(dir, 'APP-1-plan-1.ndjson');
  writeFileSync(path, '{"type":"system"}\n{"type":"result"}\n');
  const id = run('APP-1', path);

  const response = await logResponse(db, parse, 'APP-1', String(id), new AbortController().signal, { raw: true });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="APP-1-run-${id}.ndjson"`);
  expect(await response.text()).toBe('{"type":"system"}\n{"type":"result"}\n');
});

it('answers 404 with a plain reason for a run that has no log', async () => {
  const id = run('APP-1', '');

  const response = await logResponse(db, parse, 'APP-1', String(id), new AbortController().signal, { raw: true });

  expect(response.status).toBe(404);
  expect(await response.text()).toMatch(/no log/);
});

// The runner notes the time in front of the lines. The stream sends it with each event the lines give,
// for the time column, and sends no mark of its own.
it('sends each event with the time noted in front of its line', async () => {
  const path = join(dir, 'APP-1-plan-1.ndjson');
  writeFileSync(path, '{"type":"nolzu.at","at":1000}\none\ntwo\n{"type":"nolzu.at","at":3000}\nthree\n');
  const id = run('APP-1', path);
  const controller = new AbortController();

  const response = await logResponse(db, parse, 'APP-1', String(id), controller.signal, { raw: false, pollMs: 10 });
  const lines = await read(response.body!, 3);
  controller.abort();

  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { type: 'text', text: 'one', at: 1000 },
    { type: 'text', text: 'two', at: 1000 },
    { type: 'text', text: 'three', at: 3000 },
  ]);
});

// The Log tab reads only the protocol, so the route reads what each tool acted on, from the run's own
// folder, and the row says it beside the tool's name.
it('sends each tool event with what it acted on, short, from the run folder', async () => {
  const path = join(dir, 'APP-1-plan-1.ndjson');
  writeFileSync(path, 'read\n');
  const id = run('APP-1', path);
  db.prepare('UPDATE runs SET cwd = ? WHERE id = ?').run('/work/recipes', id);
  const tool = (): RunEvent[] => [{ type: 'tool', name: 'Read', input: { file_path: '/work/recipes/web/src/lib/RecipeCard.svelte' } }];
  const controller = new AbortController();

  const response = await logResponse(db, tool, 'APP-1', String(id), controller.signal, { raw: false, pollMs: 10 });
  const lines = await read(response.body!, 1);
  controller.abort();

  expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'tool', name: 'Read', subject: 'web/src/lib/RecipeCard.svelte' });
});

it('reads the subject against the cwd of the run asked for, not of another run', async () => {
  const first = run('APP-2', join(dir, 'other.ndjson'));
  db.prepare('UPDATE runs SET cwd = ? WHERE id = ?').run('/elsewhere', first);
  const path = join(dir, 'APP-1-plan-1.ndjson');
  writeFileSync(path, 'read\n');
  const id = run('APP-1', path);
  expect(id).not.toBe(first);
  db.prepare('UPDATE runs SET cwd = ? WHERE id = ?').run('/work/recipes', id);
  const tool = (): RunEvent[] => [{ type: 'tool', name: 'Read', input: { file_path: '/work/recipes/web/a.svelte' } }];
  const controller = new AbortController();

  const response = await logResponse(db, tool, 'APP-1', String(id), controller.signal, { raw: false, pollMs: 10 });
  const lines = await read(response.body!, 1);
  controller.abort();

  expect(JSON.parse(lines[0]!)).toMatchObject({ subject: 'web/a.svelte' });
});

describe('Download raw', () => {
  const ask = (query: string) => new URLSearchParams(query);

  it('serves that run\'s own log file', async () => {
    const path = join(dir, 'APP-1-plan-1.ndjson');
    writeFileSync(path, '{"type":"system"}\n');
    const id = run('APP-1', path);

    const response = await rawLog(db, 'APP-1', ask(`run=${id}`), new AbortController().signal);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"type":"system"}\n');
  });

  it('serves the log of the card it is asked for, whichever card that is', async () => {
    const path = join(dir, 'APP-2-plan-1.ndjson');
    writeFileSync(path, '{"type":"two"}\n');
    const id = run('APP-2', path);

    const response = await rawLog(db, 'APP-2', ask(`run=${id}`), new AbortController().signal);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"type":"two"}\n');
  });

  it('refuses a run of another card, with a sentence', async () => {
    const path = join(dir, 'APP-2-plan-1.ndjson');
    writeFileSync(path, '{"type":"system"}\n');
    const id = run('APP-2', path);

    const response = await rawLog(db, 'APP-1', ask(`run=${id}`), new AbortController().signal);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(`APP-1 has no run ${id}.`);
  });

  // The route reads the file the run row names, so a path in the ask has nothing to do. It is refused,
  // and nothing is read.
  it('refuses a path, or anything else beside the run, with a sentence', async () => {
    const path = join(dir, 'APP-1-plan-1.ndjson');
    writeFileSync(path, '{"type":"system"}\n');
    const id = run('APP-1', path);

    const response = await rawLog(db, 'APP-1', ask(`run=${id}&path=${encodeURIComponent('../../secrets.txt')}`), new AbortController().signal);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Download raw serves only a run\'s own log, named by its run id. It does not read "path".');
  });
});

describe('logFor', () => {
  it('carries what the run row knows, with the tokens counted as the trail counts them', () => {
    const id = startRun(db, { cardKey: 'APP-1', phase: 'ask', engine: 'claude-code', model: 'haiku', effort: 'low', sessionId: null, logPath: join(dir, 'a.ndjson'), lane: null, thread: 'ask-1' });

    expect(logFor(db, 'APP-1', null).runs).toEqual([
      { id, phase: 'ask', state: 'queued', startedAt: null, endedAt: null, engine: 'claude-code', model: 'haiku', effort: 'low', wall: null, costUsd: null, durationMs: null, tokens: null, started: null, failureReason: null },
    ]);
  });

  // An engine that stops before its first line leaves the log empty, so the reason the card's Next step
  // shows goes to the Log tab as well. Only a failed run carries one.
  it('carries why a failed run stopped, and no reason for a run that did not fail', () => {
    const failed = run('APP-1', join(dir, 'a.ndjson'));
    const done = run('APP-1', join(dir, 'b.ndjson'));
    const said = 'The Cursor CLI engine stopped with exit code 1. It said: Error: EPERM: operation not permitted';
    db.prepare("UPDATE runs SET state = 'failed', error = ? WHERE id = ?").run(said, failed);
    db.prepare("UPDATE runs SET state = 'complete', error = ? WHERE id = ?").run('an old note', done);

    const runs = logFor(db, 'APP-1', null).runs;
    expect(runs.find((one) => one.id === failed)?.failureReason).toBe(said);
    expect(runs.find((one) => one.id === done)?.failureReason).toBeNull();
  });

  // The run line says when the run started, in the trail's words.
  it('says when each run started, in the trail\'s words', () => {
    const id = run('APP-1', join(dir, 'a.ndjson'));
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(new Date(2026, 9, 15, 14, 51).toISOString(), id);

    expect(logFor(db, 'APP-1', null, new Date(2026, 9, 15, 18, 0)).runs[0]?.started).toBe('14:51');
  });

  it('lists the runs of the card newest first, and picks the newest when no run is asked for', () => {
    const first = run('APP-1', join(dir, 'a.ndjson'));
    run('APP-2', join(dir, 'b.ndjson'));
    const second = run('APP-1', join(dir, 'c.ndjson'));

    const log = logFor(db, 'APP-1', null);

    expect(log.runs.map((one) => one.id)).toEqual([second, first]);
    expect(log.selected).toBe(second);
  });

  it('lists the runs of the card it is asked for, whichever card that is', () => {
    run('APP-1', join(dir, 'a.ndjson'));
    const other = run('APP-2', join(dir, 'b.ndjson'));

    expect(logFor(db, 'APP-2', null).runs.map((one) => one.id)).toEqual([other]);
  });

  it('picks the run asked for when it is this card', () => {
    const first = run('APP-1', join(dir, 'a.ndjson'));
    run('APP-1', join(dir, 'c.ndjson'));

    expect(logFor(db, 'APP-1', String(first)).selected).toBe(first);
  });

  it('falls back to the newest run when the one asked for is not this card', () => {
    const own = run('APP-1', join(dir, 'a.ndjson'));
    const other = run('APP-2', join(dir, 'b.ndjson'));

    expect(logFor(db, 'APP-1', String(other)).selected).toBe(own);
  });

  it('selects nothing for a card with no run', () => {
    expect(logFor(db, 'APP-1', null)).toEqual({ runs: [], selected: null });
  });
});

it('refuses a download over the cap with 413, and names the cap', async () => {
  const path = join(dir, 'APP-1-plan-1.ndjson');
  writeFileSync(path, 'x'.repeat(40) + '\n');
  const id = run('APP-1', path);

  const response = await logResponse(db, parse, 'APP-1', String(id), new AbortController().signal, { raw: true, rawCap: 16 });

  expect(response.status).toBe(413);
  expect(await response.text()).toMatch(/16 bytes/);
});

// The rows the Log tab draws from a whole recorded run, read the way the log route reads it. The
// refine scenario's calls report no counts, so its log has no tokens row; the implement scenario's
// do, and the last total matches the input and output its result line reports.
describe('the tokens row of a recorded run', () => {
  const rowsOf = (phase: string) => {
    const lines = readFileSync(new URL(`../../../../packages/runner/fake/${phase}.ndjson`, import.meta.url), 'utf8').split('\n').filter((line) => line.trim() !== '');
    return logRows(lines.flatMap((line) => parseRunLine(line, 'claude-code')));
  };

  it('shows no tokens row for a fixture with no usage lines', () => {
    const rows = rowsOf('refine');

    expect(rows.filter((row) => row.kind === 'usage')).toEqual([]);
    expect(rows.filter((row) => row.kind === 'result').map((row) => [row.text, row.aside])).toEqual([[expect.stringMatching(/^\d+ lines?$/), expect.stringMatching(/^\d+ B$/)]]);
  });

  it('shows the tokens so far for a fixture whose calls report them', () => {
    const totals = rowsOf('implement').filter((row) => row.kind === 'usage').map((row) => row.text);

    expect(totals).toHaveLength(7);
    expect(totals.at(-1)).toBe('1.2k tokens so far');
  });
});
