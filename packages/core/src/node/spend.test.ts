import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { RunRecord } from '@nolzu/protocol';
import { openDatabase } from './db.ts';
import { saveRun, startRun } from './runs.ts';
import { writeSetting } from './settings-store.ts';
import { spendReport } from './spend.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-spend-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ended = (over: Partial<RunRecord>): RunRecord => ({
  sessionId: 'engine-reported-this-id',
  model: 'claude-sonnet-4-5',
  costUsd: null,
  durationMs: null,
  tokens: null,
  question: null,
  failureReason: null,
  failureStatus: null,
  state: 'complete',
  cardState: 'ready',
  retry: null,
  ...over,
});

// What Claude Code reports: a cost with its counts.
const claude = ended({ costUsd: 0.0412, durationMs: 18_240, tokens: { input: 9, output: 412, cacheRead: 14_820, cacheCreation: 3_310 } });
// What Codex reports: counts and no cost. Its input count already holds the cached tokens.
const codex = ended({ costUsd: null, durationMs: null, tokens: { input: 21_430, output: 1_208, cacheRead: 18_944, cacheCreation: 0 } });

// One run, ended as the engine reported it. The start time is set by hand where the day matters,
// because the column is stamped by the database clock.
const run = (over: { card?: string; phase?: string; engine?: string; started?: string | null }, record: RunRecord): number => {
  const id = startRun(db, {
    cardKey: over.card ?? 'APP-1',
    phase: over.phase ?? 'implement',
    engine: over.engine ?? 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    sessionId: null,
    logPath: join(dir, 'logs', 'run.ndjson'),
    lane: null,
  });
  saveRun(db, id, record);
  if (over.started !== undefined) db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(over.started, id);
  return id;
};

// The main case: the project shows the cost it knows, the tokens of both runs, and
// says the cost does not cover every run.
it('shows one cost and one token count for a project with a Claude run and a Codex run', () => {
  run({}, claude);
  run({ phase: 'qa', engine: 'codex' }, codex);

  const spend = spendReport(db).project;

  expect(spend.costUsd).toBe(0.0412);
  expect(spend.tokens).toBe(23_059);
  expect(spend.partial).toBe(true);
  expect(spend.reported).toBe(1);
  expect(spend.runs).toBe(2);
  expect(spend.tokensOnly).toBe(1);
  // In the same test, because this is the assertion that dies when a missing cost is summed as
  // nought: the group whose only run reported none must show no figure at all, not $0.
  expect(spendReport(db).byProfile.get('codex')?.costUsd).toBeNull();
});

it('has no numbers and no groups for a project with no runs', () => {
  const report = spendReport(db);

  expect(report.project).toEqual({ runs: 0, reported: 0, costUsd: null, tokensOnly: 0, tokens: null, durationMs: 0, partial: false });
  expect(report.byCard.size).toBe(0);
  expect(report.byDay.size).toBe(0);
  expect(report.byProfile.size).toBe(0);
});

// The rows are interleaved on purpose. A grouping that started a new bucket whenever the key changed
// would pass on rows that sit together and lose half of APP-1 here.
it('rolls up per card, and keeps each card its own partial answer', () => {
  run({ card: 'APP-1' }, claude);
  run({ card: 'APP-2' }, claude);
  run({ card: 'APP-1', engine: 'codex' }, codex);

  const byCard = spendReport(db).byCard;

  expect(byCard.get('APP-1')).toMatchObject({ costUsd: 0.0412, runs: 2, partial: true, tokensOnly: 1 });
  expect(byCard.get('APP-2')).toMatchObject({ costUsd: 0.0412, runs: 1, partial: false });
});

// The summary pass has its own run row and its own cost. A card total without it is short of real
// money, so the roll-up counts every row of the card.
it('counts a pseudo-ticket run, which belongs to no card row', () => {
  run({ card: 'APP-1' }, claude);
  run({ card: 'summary', phase: 'extract-summary' }, ended({ costUsd: 0.002, durationMs: 900, tokens: null }));

  // The row count as well as the sum, or a filter that dropped the summary pass would still pass
  // here: 0.0412 plus nothing rounds to the same two decimals a person reads.
  expect(spendReport(db).project).toMatchObject({ runs: 2, reported: 2, partial: false });
  expect(spendReport(db).project.costUsd).toBeCloseTo(0.0432, 10);
  expect(spendReport(db).byCard.get('summary')?.costUsd).toBe(0.002);
});

it('rolls up per engine profile, by the id the row holds', () => {
  run({ engine: 'claude-code' }, claude);
  run({ engine: 'codex#work' }, codex);

  const byProfile = spendReport(db).byProfile;

  expect([...byProfile.keys()]).toEqual(['claude-code', 'codex#work']);
  expect(byProfile.get('codex#work')).toMatchObject({ costUsd: null, tokens: 22_638, tokensOnly: 1, partial: true });
});

// A profile the person removed still has runs, and dropping them would lose what they cost.
it('keeps a group for a profile id this machine has no profile for', () => {
  run({ engine: 'gone#old' }, claude);

  expect(spendReport(db).byProfile.get('gone#old')?.costUsd).toBe(0.0412);
});

// The day is the UTC day the run started, the digits the stored timestamp carries. A run started at
// 23:30 UTC belongs to that day, not to the next one, and the run after midnight belongs to the next.
it('splits a day at midnight UTC', () => {
  run({ started: '2026-03-01T23:30:00.000Z' }, claude);
  run({ started: '2026-03-02T00:30:00.000Z', engine: 'codex' }, codex);

  const byDay = spendReport(db).byDay;

  expect([...byDay.keys()]).toEqual(['2026-03-01', '2026-03-02']);
  expect(byDay.get('2026-03-01')).toMatchObject({ runs: 1, costUsd: 0.0412, partial: false });
  // A day with two paid runs, so the day bucket is proven to add rather than to overwrite.
  run({ started: '2026-03-01T08:00:00.000Z' }, claude);
  expect(spendReport(db).byDay.get('2026-03-01')).toMatchObject({ runs: 2, reported: 2, partial: false });
  expect(spendReport(db).byDay.get('2026-03-01')?.costUsd).toBeCloseTo(0.0824, 10);
  expect(byDay.get('2026-03-02')).toMatchObject({ runs: 1, costUsd: null, tokensOnly: 1, partial: true });
});

// A run that never left the queue has no start time. Putting it under today would say it ran today.
it('puts a run that never started in no day, and still counts it in the project', () => {
  run({ started: null }, ended({ state: 'stopped' }));
  run({ started: '2026-03-01T10:00:00.000Z' }, claude);

  expect([...spendReport(db).byDay.keys()]).toEqual(['2026-03-01']);
  expect(spendReport(db).project).toMatchObject({ runs: 2, reported: 1, partial: true });
});

// The share of a usage window is not a cost. It lives in the settings and never on a run, and no
// roll-up reads it, so a run on a subscription adds no money anywhere.
it('adds no money for a run whose engine spent a usage window share', () => {
  writeSetting(db, 'engineLimits', {
    codex: { seenAt: Date.parse('2026-03-01T10:00:00.000Z'), windows: [{ name: 'weekly', used: 0.8, resetsAt: null, status: 'ok' }] },
  });
  run({ engine: 'codex' }, codex);

  const report = spendReport(db);

  expect(report.project.costUsd).toBeNull();
  expect(report.byProfile.get('codex')?.costUsd).toBeNull();
  expect(report.byProfile.get('codex')?.tokens).toBe(22_638);
});

it('adds a known cost of nought, and does not call it missing', () => {
  run({}, ended({ costUsd: 0, durationMs: 1200, tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 } }));

  expect(spendReport(db).project).toMatchObject({ costUsd: 0, reported: 1, runs: 1, partial: false });
});
