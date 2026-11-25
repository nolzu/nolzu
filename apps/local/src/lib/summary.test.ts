import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, readRun, startRun } from '@nolzu/core/node';
import type { Job, RunEvent } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordSummary } from './summary.ts';

let dir = '';
let db: DatabaseSync;
let phaseRun = 0;
let job: Job;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-summary-'));
  db = openDatabase(dir);
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'ready', 'Add a search box')").run();
  phaseRun = startRun(db, { cardKey: 'APP-1', phase: 'refine', engine: 'claude', model: 'haiku', effort: 'low', sessionId: 's-1', logPath: join(dir, 'refine.ndjson'), lane: null });
  job = {
    runId: phaseRun,
    cardKey: 'APP-1',
    engine: 'claude-code',
    phase: 'refine',
    cwd: dir,
    taskDir: join(dir, '.tasks', 'APP-1'),
    prompt: '/nolzu-refine APP-1',
    // The phase's own model, which the extraction pass must not copy.
    model: 'opus',
    effort: 'high',
    sessionId: null,
    resumeFrom: null,
    timeoutMs: 60_000,
    logPath: join(dir, 'refine.ndjson'),
    lane: null,
    mcpConfigPath: null,
    settingsPath: null,
    tools: ['Read'],
  };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ran: RunEvent[] = [{ type: 'text', text: 'I read the ticket and wrote refined.md.' }];
const stored = () => (db.prepare('SELECT plain_summary FROM runs WHERE id = ?').get(phaseRun) as { plain_summary: string | null }).plain_summary;
const extractionRow = () => db.prepare("SELECT id FROM runs WHERE phase = 'extract-summary'").get() as { id: number } | undefined;
const cardState = () => (db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state;

async function* answer(...events: RunEvent[]): AsyncGenerator<RunEvent> {
  yield* events;
}

it('stores the summary file the phase wrote, and runs no extraction', async () => {
  const extract = vi.fn(() => answer());

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => '## What changed, in plain words\n\nThe ticket is clearer now.\n', extract }, job, ran);

  expect(stored()).toBe('The ticket is clearer now.');
  expect(extract).not.toHaveBeenCalled();
  expect(extractionRow()).toBeUndefined();
});

it('reads the file from the card folder, under the phase', async () => {
  const read = vi.fn(() => 'Done.');

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read, extract: () => answer() }, job, ran);

  expect(read).toHaveBeenCalledWith(join(dir, '.tasks', 'APP-1', 'refine', 'summary.md'));
});

it('runs the extraction once when the file is missing, from the run text and with no skill named', async () => {
  const extract = vi.fn<(asked: Job) => AsyncGenerator<RunEvent>>(() => answer({ type: 'text', text: 'The ticket is clearer now.' }, { type: 'complete', costUsd: 0.01, durationMs: 900, tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } }));

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => null, extract }, job, ran);

  expect(extract).toHaveBeenCalledTimes(1);
  const asked = extract.mock.calls[0]![0];
  expect(asked.phase).toBe('extract-summary');
  // A two sentence rewrite does not need the phase's own model, which is opus for implement.
  expect([asked.model, asked.effort]).toEqual(['haiku', 'low']);
  expect(asked.prompt).toContain('I read the ticket and wrote refined.md.');
  expect(asked.prompt).toContain('What changed, in plain words');
  expect(asked.prompt).not.toMatch(/nolzu-|\/refine/);
  expect(stored()).toBe('The ticket is clearer now.');
  // Its own row, so its cost stays visible.
  const row = readRun(db, extractionRow()!.id);
  expect(row).toMatchObject({ phase: 'extract-summary', cardKey: 'APP-1', engine: 'claude', costUsd: 0.01, state: 'complete' });
});

it('starts the extraction in the checkout, not in a QA copy that is already deleted', async () => {
  const extract = vi.fn<(asked: Job) => AsyncGenerator<RunEvent>>(() => answer());

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => null, extract }, { ...job, qaCopy: join(dir, 'qa-copies', 'qa-APP-1-0a1b2c3d') }, ran);

  const asked = extract.mock.calls[0]![0];
  expect(asked.qaCopy ?? null).toBeNull();
  expect(asked.cwd).toBe(dir);
});

it('runs the extraction for a file that holds only the heading', async () => {
  const extract = vi.fn(() => answer({ type: 'text', text: 'Clearer.' }));

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => '## What changed, in plain words\n', extract }, job, ran);

  expect(extract).toHaveBeenCalledTimes(1);
  expect(stored()).toBe('Clearer.');
});

it('runs the extraction for a file that holds only whitespace', async () => {
  const extract = vi.fn(() => answer({ type: 'text', text: 'Clearer.' }));

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => '  \n', extract }, job, ran);

  expect(extract).toHaveBeenCalledTimes(1);
});

it('leaves the summary empty and the card ready when the extraction says nothing', async () => {
  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => null, extract: () => answer({ type: 'complete', costUsd: 0, durationMs: 1, tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 } }) }, job, ran);

  expect(stored()).toBeNull();
  expect(cardState()).toBe('ready');
});

it('writes a throwing extraction on its own row, never on the phase run, and leaves the card ready', async () => {
  // eslint-disable-next-line require-yield
  const extract = async function* (): AsyncGenerator<RunEvent> {
    throw new Error('The engine is not there.');
  };

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => null, extract }, job, ran);

  expect(readRun(db, extractionRow()!.id)).toMatchObject({ state: 'failed', failureReason: 'The engine is not there.' });
  expect(readRun(db, phaseRun)?.failureReason).toBeNull();
  expect(stored()).toBeNull();
  expect(cardState()).toBe('ready');
});

it('saves a pass that was stopped as stopped, not as failed with no reason', async () => {
  const stop = new AbortController();
  stop.abort();

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => null, extract: () => answer(), signal: stop.signal }, job, ran);

  expect(readRun(db, extractionRow()!.id)?.state).toBe('stopped');
});

// The run's MCP servers carry their secrets in memory. The pass reads only its prompt, so it gets none.
it('hands the extraction none of the run servers or their secrets', async () => {
  const extract = vi.fn<(asked: Job) => AsyncGenerator<RunEvent>>(() => answer({ type: 'text', text: 'Done.' }, { type: 'complete', costUsd: 0, durationMs: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }));
  const withServers: Job = { ...job, mcp: { stdio: { db: { command: 'db-mcp', args: [], env: { DB_LOGIN: 'hunter2' } } }, remote: {}, rules: {}, dir: join(dir, 'mcp-runs', '1') } };

  await recordSummary({ db, engine: 'claude', summaryModel: { model: 'haiku', effort: 'low' }, read: () => null, extract }, withServers, ran);

  const asked = extract.mock.calls[0]![0];
  expect(asked.mcp).toBeUndefined();
  expect(JSON.stringify(asked)).not.toContain('hunter2');
});
