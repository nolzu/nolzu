import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Effort, RunRecord, RunState } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bumpVersion, openDatabase } from './db.ts';
import { cardEstimate, startEstimate } from './estimates.ts';
import { saveRun, startRun } from './runs.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-estimates-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const minute = 60_000;
const START = Date.parse('2026-10-01T10:00:00.000Z');

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  sessionId: 'engine-reported-this-id',
  // What the engine reports, which is not the name the start line shows.
  model: 'claude-sonnet-4-5',
  costUsd: 0.4,
  durationMs: 18_240,
  tokens: { input: 9, output: 412, cacheRead: 14_820, cacheCreation: 3_310 },
  question: null,
  failureReason: null,
  failureStatus: null,
  state: 'complete',
  cardState: 'ready',
  retry: null,
  ...over,
});

interface Run {
  card?: string;
  // The profile id the runs table keeps.
  engine?: string;
  phase?: string;
  model?: string;
  effort?: Effort;
  costUsd?: number | null;
  minutes?: number;
  resumed?: boolean;
  state?: RunState;
}

// A run that went from queued to its end, with a fixed wall time.
function run(over: Run = {}): number {
  const id = startRun(db, {
    cardKey: over.card ?? 'APP-1',
    phase: over.phase ?? 'implement',
    engine: over.engine ?? 'claude-code',
    model: over.model ?? 'sonnet',
    effort: over.effort ?? 'high',
    sessionId: null,
    logPath: '',
    lane: null,
    resumed: over.resumed,
  });
  saveRun(db, id, record({ state: over.state ?? 'complete', costUsd: over.costUsd === undefined ? 0.4 : over.costUsd }));
  const ended = new Date(START + (over.minutes ?? 8) * minute).toISOString();
  db.prepare('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?').run(new Date(START).toISOString(), ended, id);
  return id;
}

const fiveRuns = (over: Run = {}) => {
  [[0.3, 10], [0.5, 4], [0.4, 8], [0.2, 12], [0.6, 6]].forEach(([costUsd, minutes]) => run({ ...over, costUsd, minutes }));
};

const implement = () => startEstimate(db, { phase: 'implement', model: 'sonnet', effort: 'high', vendor: 'claude-code' });

describe('startEstimate', () => {
  it('reads completed first runs of the phase, model and effort the start line shows', () => {
    fiveRuns();

    expect(implement()).toEqual({ costUsd: 0.4, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  it('leaves out answers, discussion messages and retries', () => {
    fiveRuns();
    // Five resumed runs, cheap and quick, which would pull both numbers down.
    for (let i = 0; i < 5; i += 1) run({ resumed: true, costUsd: 0.01, minutes: 1 });

    expect(implement()).toMatchObject({ costUsd: 0.4, lowMs: 6 * minute, runs: 5 });
  });

  it('leaves out a run that waited out an API error, whose row holds the last attempt alone', () => {
    fiveRuns();
    const waited = run({ costUsd: 0.01, minutes: 1 });
    saveRun(db, waited, record({ state: 'retrying', retry: { attempt: 1, delayMs: 30_000, reason: 'overloaded' } }));
    saveRun(db, waited, record({ costUsd: 0.01 }));

    expect(db.prepare('SELECT resumed FROM runs WHERE id = ?').get(waited)).toEqual({ resumed: 1 });
    expect(implement()).toMatchObject({ costUsd: 0.4, runs: 5 });
  });

  it('leaves out runs that did not complete, and rows from before the resumed column', () => {
    for (let i = 0; i < 4; i += 1) run();
    run({ state: 'failed' });
    run({ state: 'stopped' });
    db.prepare('UPDATE runs SET resumed = NULL WHERE id = ?').run(run());

    expect(implement()).toBeUndefined();
  });

  it('groups by the model the run asked for, and by effort', () => {
    fiveRuns();

    expect(startEstimate(db, { phase: 'implement', model: 'sonnet', effort: 'medium', vendor: 'claude-code' })).toBeUndefined();
    expect(startEstimate(db, { phase: 'implement', model: 'claude-sonnet-4-5', effort: 'high', vendor: 'claude-code' })).toBeUndefined();
    expect(startEstimate(db, { phase: 'plan', model: 'sonnet', effort: 'high', vendor: 'claude-code' })).toBeUndefined();
  });

  // One model name can run on two vendors, at two prices. A second login of the same vendor is the
  // same run.
  it('groups by the vendor of the engine the run ran on', () => {
    fiveRuns({ engine: 'cursor' });
    expect(implement()).toBeUndefined();
    expect(startEstimate(db, { phase: 'implement', model: 'sonnet', effort: 'high', vendor: 'cursor' })).toMatchObject({ costUsd: 0.4, runs: 5 });

    fiveRuns({ engine: 'claude-code#work' });
    bumpVersion(db);
    expect(implement()).toMatchObject({ costUsd: 0.4, runs: 5 });
  });

  // Codex and Cursor report tokens and no cost. Their time is still worth showing.
  it('shows the time alone for an engine that reports no cost, never a cost of nothing', () => {
    for (const minutes of [4, 6, 8, 10, 12]) run({ costUsd: null, minutes });

    expect(implement()).toEqual({ costUsd: null, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  it('takes the median over the runs that reported a cost, with the missing ones left out', () => {
    for (const [costUsd, minutes] of [[0.4, 4], [null, 6], [null, 8], [0.6, 10], [0.5, 12], [0.3, 14], [0.7, 16]] as const) run({ costUsd, minutes });

    expect(implement()).toMatchObject({ costUsd: 0.5, runs: 7 });
  });

  // A clock set back during a run gives an end before the start.
  it('leaves out a run whose end is before its start', () => {
    fiveRuns();
    db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(new Date(START - minute).toISOString(), run({ costUsd: 9.99 }));

    expect(implement()).toEqual({ costUsd: 0.4, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  it('falls back to the preset range with no history, and to nothing where the preset has none', () => {
    run({ phase: 'refine', model: 'haiku', effort: 'low' });

    expect(startEstimate(db, { phase: 'refine', model: 'haiku', effort: 'low', vendor: 'claude-code' })).toEqual({
      costUsd: 0.048,
      lowMs: 21_000,
      highMs: 21_000,
      from: 'preset',
      runs: 0,
    });
    expect(implement()).toBeUndefined();
    // The range was measured on Claude Code, so the same row on another vendor has none.
    expect(startEstimate(db, { phase: 'refine', model: 'haiku', effort: 'low', vendor: 'cursor' })).toBeUndefined();
    // A pass is no action with a preset row, and has no range.
    expect(startEstimate(db, { phase: 'commit-message', model: 'haiku', effort: 'low', vendor: 'claude-code' })).toBeUndefined();
  });

  // Refine on haiku at low effort is the one start with a preset range, so it is the one where the
  // two sources compete.
  it('keeps the preset range under five runs and takes the history from the fifth on', () => {
    const refine = () => startEstimate(db, { phase: 'refine', model: 'haiku', effort: 'low', vendor: 'claude-code' });
    for (const minutes of [10, 4, 8, 12]) run({ phase: 'refine', model: 'haiku', effort: 'low', costUsd: 0.3, minutes });
    expect(refine()).toMatchObject({ from: 'preset', costUsd: 0.048 });

    run({ phase: 'refine', model: 'haiku', effort: 'low', costUsd: 0.3, minutes: 6 });
    bumpVersion(db);
    expect(refine()).toEqual({ costUsd: 0.3, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  it('keeps the figures until the board version moves, then reads the runs again', () => {
    fiveRuns();
    expect(implement()?.costUsd).toBe(0.4);

    // Written behind the cache's back, with no version bump.
    db.exec(`INSERT INTO runs (card_key, phase, engine, model, asked_model, effort, state, resumed, cost_estimate, started_at, ended_at) VALUES
      ('APP-2', 'implement', 'claude-code', 'sonnet', 'sonnet', 'high', 'complete', 0, 0.9, '2026-10-01T10:00:00.000Z', '2026-10-01T10:08:00.000Z'),
      ('APP-2', 'implement', 'claude-code', 'sonnet', 'sonnet', 'high', 'complete', 0, 0.9, '2026-10-01T10:00:00.000Z', '2026-10-01T10:08:00.000Z')`);
    expect(implement()?.costUsd).toBe(0.4);

    bumpVersion(db);
    expect(implement()).toMatchObject({ costUsd: 0.5, runs: 7 });
  });
});

describe('cardEstimate', () => {
  // The five agent steps of a Delivery card, on the rows one preset names.
  const STEPS = [
    { engine: 'claude-code', phase: 'refine', model: 'haiku', effort: 'low' },
    { engine: 'claude-code', phase: 'plan', model: 'sonnet', effort: 'medium' },
    { engine: 'claude-code', phase: 'implement', model: 'sonnet', effort: 'medium' },
    { engine: 'claude-code', phase: 'qa', model: 'sonnet', effort: 'medium' },
    { engine: 'claude-code', phase: 'wrapup', model: 'sonnet', effort: 'low' },
  ] as const;
  const card = (key: string, size: string | null) => db.prepare('INSERT INTO cards (key, board, stage, title, size) VALUES (?, ?, ?, ?, ?)').run(key, 'delivery', 'closed', key, size);
  // Five cards, each taken through every step once at the cost given.
  const fiveCards = (costs: Record<string, number | null>, size: string | null = null, prefix = 'APP') => {
    for (let i = 1; i <= 5; i += 1) {
      card(`${prefix}-${i}`, size);
      for (const step of STEPS) run({ card: `${prefix}-${i}`, phase: step.phase, model: step.model, effort: step.effort, costUsd: costs[step.phase] ?? null, minutes: 2 });
    }
    bumpVersion(db);
  };
  const COSTS = { refine: 0.05, plan: 0.1, implement: 0.25, qa: 0.1, wrapup: 0.05 };

  it('adds the median of each step over the cards of this project', () => {
    fiveCards(COSTS);

    expect(cardEstimate(db, STEPS)?.costUsd).toBeCloseTo(0.55);
    expect(cardEstimate(db, STEPS)).toMatchObject({ lowMs: 10 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  // No one picks a size any more, so a size an older row kept changes nothing.
  it('counts every card, whatever size an older row kept', () => {
    fiveCards(COSTS, 'medium', 'MED');

    expect(cardEstimate(db, STEPS)?.costUsd).toBeCloseTo(0.55);
  });

  // A screen never shows a made-up number, so a step with no measured runs leaves no
  // figure at all, never the sum of the steps that were measured.
  it('gives no figure while one step has fewer than five measured runs', () => {
    fiveCards(COSTS);

    expect(cardEstimate(db, [...STEPS, { engine: 'claude-code', phase: 'implement', model: 'opus', effort: 'high' }])).toBeUndefined();
    expect(cardEstimate(db, [])).toBeUndefined();
  });

  it('counts a step only on the vendor it ran on', () => {
    fiveCards(COSTS);

    expect(cardEstimate(db, STEPS.map((step) => ({ ...step, engine: 'claude-code#work' })))?.costUsd).toBeCloseTo(0.55);
    expect(cardEstimate(db, STEPS.map((step) => ({ ...step, engine: 'cursor' })))).toBeUndefined();
  });

  it('leaves the cost out when one step reported none, and keeps the time', () => {
    fiveCards({ ...COSTS, qa: null });

    expect(cardEstimate(db, STEPS)).toMatchObject({ costUsd: null, lowMs: 10 * minute });
  });
});
