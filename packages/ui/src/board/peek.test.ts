import { type Segment, spendOf, type StripRun } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { cardFixture } from './fixture.ts';
import { ago, peekFacts, trailSteps, trailTotal } from './peek.ts';

const NOW = new Date('2026-10-14T14:03:10Z');

const run = (id: number, phase: string, over: Partial<StripRun> = {}): StripRun => ({
  id,
  phase,
  state: 'complete',
  model: 'sonnet',
  effort: 'medium',
  costUsd: null,
  durationMs: null,
  tokens: null,
  question: null,
  ...over,
});

const segment = (phase: string, label: string, runs: StripRun[]): Segment => ({
  phase,
  label,
  run: runs.at(-1) ?? null,
  count: runs.length,
  spend: spendOf(runs),
});

// Refine and Plan done, Implement running, QA and Wrap-up not run yet: REC-16.
const TRAIL: Segment[] = [
  segment('refine', 'Refine', [run(1, 'refine', { model: 'haiku', costUsd: 0.03, durationMs: 21_000 })]),
  segment('plan', 'Plan', [run(2, 'plan', { costUsd: 0.12, durationMs: 65_000 })]),
  segment('implement', 'Implement', [run(3, 'implement', { state: 'running' })]),
  segment('qa', 'QA', []),
  segment('wrapup', 'Wrap-up', []),
];
const RUNNING = cardFixture({ key: 'APP-16', stage: 'implement', state: 'running', runStartedAt: '2026-10-14T14:00:56Z', engine: 'claude-code', model: 'sonnet', effort: 'high' });

describe('trailSteps', () => {
  it('gives each phase its state, its model, its time and its measured cost', () => {
    expect(trailSteps(TRAIL, RUNNING, NOW, { qa: 'sonnet', wrapup: 'haiku' })).toEqual([
      { phase: 'refine', label: 'Refine', state: 'done', model: 'haiku', time: '21s', cost: '$0.03' },
      { phase: 'plan', label: 'Plan', state: 'done', model: 'sonnet', time: '1m 05s', cost: '$0.12' },
      { phase: 'implement', label: 'Implement', state: 'now', model: 'sonnet', time: '2m 14s', cost: null },
      { phase: 'qa', label: 'QA', state: 'next', model: 'sonnet', time: 'next', cost: null },
      { phase: 'wrapup', label: 'Wrap-up', state: 'later', model: 'haiku', time: 'after QA', cost: null },
    ]);
  });

  // Each phase may have run on another engine, so a run's step names it before the model.
  it('names the engine of each phase that ran', () => {
    const steps = trailSteps(
      [segment('refine', 'Refine', [run(1, 'refine', { engine: 'codex#work', model: 'gpt-5.6-sol' })]), segment('implement', 'Implement', [run(2, 'implement', { state: 'running', engine: 'claude-code' })])],
      RUNNING,
      NOW,
    );

    expect(steps.map((step) => step.model)).toEqual(['Codex · gpt-5.6-sol', 'Claude Code · sonnet']);
  });

  // Running cost stays off, and an estimate is no measured cost: the phase
  // that runs and the phases to come show none, and a run that reported none shows none either.
  it('shows no cost for a run that reported none, and no figure for a phase that has not run', () => {
    const steps = trailSteps([segment('refine', 'Refine', [run(1, 'refine', { costUsd: null, durationMs: 9000 })]), segment('plan', 'Plan', [])], cardFixture({ key: 'APP-2', stage: 'refine', state: 'ready' }), NOW);

    expect(steps.map((step) => step.cost)).toEqual([null, null]);
    expect(steps[1]).toMatchObject({ state: 'next', model: null });
  });

  // Color means state: a failed or stopped phase is not drawn as done, and says so in words.
  it('marks a phase that failed or was stopped apart from one that is done', () => {
    const steps = trailSteps(
      [
        segment('refine', 'Refine', [run(1, 'refine', { durationMs: 21_000 })]),
        segment('plan', 'Plan', [run(2, 'plan', { state: 'stopped', durationMs: 9000 })]),
        segment('implement', 'Implement', [run(3, 'implement', { state: 'failed', durationMs: 41_000, costUsd: 0.2 })]),
        segment('qa', 'QA', [run(4, 'qa', { verdict: 'FAIL' })]),
        segment('wrapup', 'Wrap-up', [run(5, 'wrapup', { state: 'interrupted' })]),
      ],
      RUNNING,
      NOW,
    );

    expect(steps.map((step) => [step.state, step.time])).toEqual([
      ['done', '21s'],
      ['stopped', 'stopped · 9s'],
      ['failed', 'failed · 41s'],
      ['failed', 'failed'],
      ['stopped', 'interrupted'],
    ]);
    expect(steps[2]?.cost).toBe('$0.20');
  });

  it('adds up only what the runs reported', () => {
    expect(trailTotal(TRAIL)).toBe('$0.15');
    expect(trailTotal([segment('plan', 'Plan', [run(2, 'plan')])])).toBeNull();
  });
});

describe('peekFacts', () => {
  it('names the engine by its vendor, then the model, the effort and the tokens so far', () => {
    expect(peekFacts(RUNNING, 41_800)).toEqual(['Claude Code · sonnet · high', '41.8k tok']);
    expect(peekFacts({ ...RUNNING, engine: 'codex#work', model: 'gpt-5.5', effort: null }, null)).toEqual(['Codex · gpt-5.5']);
  });

  it('says nothing it does not know', () => {
    expect(peekFacts(cardFixture({ key: 'APP-1' }), null)).toEqual([]);
  });
});

describe('ago', () => {
  it('says how long ago in seconds, then minutes, then hours', () => {
    expect(ago('2026-10-14T14:02:40Z', NOW)).toBe('30s ago');
    expect(ago('2026-10-14T13:58:10Z', NOW)).toBe('5m ago');
    expect(ago('2026-10-14T11:03:10Z', NOW)).toBe('3h ago');
    expect(ago('2026-10-13T14:03:10Z', NOW)).toBe('24h ago');
    expect(ago('2026-10-11T14:03:10Z', NOW)).toBe('3d ago');
    expect(ago('not a time', NOW)).toBeNull();
  });

  it('says it in words for the trail, with days from the second day on', () => {
    expect(ago('2026-10-14T14:02:58Z', NOW, true)).toBe('12 seconds ago');
    expect(ago('2026-10-14T14:02:11Z', NOW, true)).toBe('59 seconds ago');
    expect(ago('2026-10-14T14:02:10Z', NOW, true)).toBe('1 minute ago');
    expect(ago('2026-10-14T13:58:10Z', NOW, true)).toBe('5 minutes ago');
    expect(ago('2026-10-14T13:02:10Z', NOW, true)).toBe('1 hour ago');
    expect(ago('2026-10-14T11:03:10Z', NOW, true)).toBe('3 hours ago');
    expect(ago('2026-10-13T14:03:10Z', NOW, true)).toBe('yesterday');
    expect(ago('2026-10-10T14:03:10Z', NOW, true)).toBe('4 days ago');
    expect(ago('2026-10-14T14:03:10Z', NOW, true)).toBe('now');
    expect(ago('not a time', NOW, true)).toBeNull();
  });

  // The suite runs with TZ=UTC, so a local date here is the UTC date.
  it('counts local dates from the first day on, not 24 hour blocks', () => {
    const evening = new Date('2026-10-14T21:00:00Z');
    expect(ago('2026-10-12T20:59:00Z', evening, true)).toBe('2 days ago');
    expect(ago('2026-10-12T21:01:00Z', evening, true)).toBe('2 days ago');
    expect(ago('2026-10-12T00:00:00Z', evening, true)).toBe('2 days ago');
    expect(ago('2026-10-11T23:59:59Z', evening, true)).toBe('3 days ago');
    // Saturday evening read on Monday morning.
    const monday = new Date('2026-10-19T08:00:00Z');
    expect(ago('2026-10-17T20:00:00Z', monday, true)).toBe('2 days ago');
    expect(ago('2026-10-18T07:59:00Z', monday, true)).toBe('yesterday');
    // Under 24 hours it stays in hours, even across midnight.
    expect(ago('2026-10-18T08:00:01Z', monday, true)).toBe('23 hours ago');
  });
});
