import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, getSetting, saveRun, savePlainSummary, startRun, writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before
// the module is imported. The loop is only told that something changed.
const data = mkdtempSync(join(tmpdir(), 'nolzu-peek-route-'));
process.env.NOLZU_DATA_DIR = data;
const told = vi.hoisted(() => ({ count: 0 }));
vi.mock('$lib/loop.ts', () => ({ loop: () => ({ changed: () => (told.count += 1) }) }));

const { GET } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const peek = (key = 'APP-1', headers: Record<string, string> = {}) =>
  (GET as unknown as (event: { params: { key: string }; request: Request }) => Promise<Response>)({ params: { key }, request: new Request('http://localhost/api/card/peek', { headers }) });

afterAll(() => rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Getting started's "Read what changed": the sheet shows a finished run's plain summary.
it('marks the plain summary read when the sheet shows one, and tells the streams once', async () => {
  const db = database();
  writeSetting(db, 'projectPath', data);
  writeSetting(db, 'gettingStarted', []);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Add a search box' });

  expect((await peek()).status).toBe(200);
  expect(getSetting(db, 'gettingStarted')).toEqual([]);

  // A running phase's own summary file is live, not what changed, so it marks nothing.
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'refine', title: 'Sort by rating' });
  const running = startRun(db, { cardKey: 'APP-2', phase: 'refine', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(running);
  mkdirSync(join(data, '.tasks', 'APP-2', 'refine'), { recursive: true });
  writeFileSync(join(data, '.tasks', 'APP-2', 'refine', 'summary.md'), 'Reading the recipe list.\n');
  expect(((await (await peek('APP-2')).json()) as { summary: { live: boolean } | null }).summary?.live).toBe(true);
  expect(getSetting(db, 'gettingStarted')).toEqual([]);
  expect(told.count).toBe(0);

  const run = startRun(db, { cardKey: 'APP-1', phase: 'refine', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  saveRun(db, run, { sessionId: null, model: 'haiku', costUsd: 0, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
  savePlainSummary(db, run, 'The ticket says what done means now.');
  // Another site's request, an image pointed here, marks nothing.
  await peek('APP-1', { 'sec-fetch-site': 'cross-site' });
  expect(getSetting(db, 'gettingStarted')).toEqual([]);
  await peek();
  await peek();

  expect(getSetting(db, 'gettingStarted')).toEqual(['summary']);
  expect(told.count).toBe(1);
});
