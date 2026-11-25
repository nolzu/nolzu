import { type Segment, spendOf, type StripRun } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { pipOf, runWord } from './pips.ts';

const run = (id: number, phase: string, over: Partial<StripRun> = {}): StripRun => ({
  id,
  phase,
  state: 'complete',
  model: 'sonnet',
  effort: 'low',
  costUsd: 0.12,
  durationMs: 64_000,
  tokens: null,
  question: null,
  ...over,
});
// The strip core builds for the Delivery board, by hand, because this package reads only the protocol.
const PHASES: readonly [string, string][] = [
  ['refine', 'Refine'],
  ['plan', 'Plan'],
  ['implement', 'Implement'],
  ['qa', 'QA'],
  ['wrapup', 'Wrap-up'],
];
const strip = (runs: StripRun[]): Segment[] =>
  PHASES.map(([phase, label]) => {
    const mine = runs.filter((one) => one.phase === phase).sort((a, b) => b.id - a.id);
    return { phase, label, run: mine[0] ?? null, count: mine.length, spend: spendOf(mine) };
  });
const segment = (over: Partial<StripRun> | null): Segment => strip(over === null ? [] : [run(1, 'plan', over)])[1]!;

describe('pipOf', () => {
  it('draws a phase with no run as empty', () => {
    expect(pipOf(segment(null))).toBe('none');
  });

  it('draws a finished phase as done', () => {
    expect(pipOf(segment({}))).toBe('done');
  });

  it.each(['running', 'retrying'] as const)('draws a %s phase as the phase now', (state) => {
    expect(pipOf(segment({ state }))).toBe('now');
  });

  // Amber means an agent works. A queued phase has not started, so it stays empty. The words
  // "Plan queued" still name it.
  it.each(['queued', 'waiting_lane', null] as const)('draws a %s phase as empty, since no agent works on it yet', (state) => {
    expect(pipOf(segment({ state }))).toBe('none');
  });

  it.each(['stopped', 'interrupted'] as const)('draws a %s phase as empty, since it did not do its work', (state) => {
    expect(pipOf(segment({ state }))).toBe('none');
  });

  // Nothing runs while the agent waits for an answer, so the phase is violet like the blocked card,
  // not amber.
  it('draws a phase that asked a question as asked', () => {
    expect(pipOf(segment({ question: 'Stars or thumbs?' }))).toBe('asked');
  });

  it('draws a failed run as failed', () => {
    expect(pipOf(segment({ state: 'failed' }))).toBe('failed');
  });

  // A QA run that returns FAIL ends as a complete run. The verdict is what failed.
  it('draws a QA run with a FAIL verdict as failed, and other verdicts as done', () => {
    expect(pipOf(segment({ verdict: 'FAIL' }))).toBe('failed');
    expect(pipOf(segment({ verdict: 'PASS' }))).toBe('done');
    expect(pipOf(segment({ verdict: null }))).toBe('done');
  });

  // QA saves a null verdict when its run printed no verdict line. That is not a pass, so it is not
  // drawn as one. A sender built before the field sends no verdict, and its runs draw as before.
  it('draws a QA run that gave no verdict as empty, and one from an older sender as done', () => {
    const qa = (over: Partial<StripRun>) => strip([run(1, 'qa', over)])[3]!;

    expect(pipOf(qa({ verdict: null }))).toBe('none');
    expect(pipOf(qa({ verdict: null, question: 'Which browser?' }))).toBe('asked');
    expect(pipOf(qa({ verdict: 'PASS' }))).toBe('done');
    expect(pipOf(qa({}))).toBe('done');
  });
});

describe('runWord', () => {
  it.each([
    [{}, 'done'],
    [{ question: 'Stars or thumbs?' }, 'asked a question'],
    [{ state: 'waiting_lane' }, 'waiting'],
    [{ state: null }, 'queued'],
    [{ state: 'running' }, 'running'],
    [{ state: 'stopped' }, 'stopped'],
  ] as const)('says %j as %s', (over, word) => {
    expect(runWord(run(1, 'plan', over))).toBe(word);
  });
});
