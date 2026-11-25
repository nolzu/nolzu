import { describe, expect, it } from 'vitest';
import { boardFor, deliveryBoard } from './board.ts';
import { type Board, formatCost, formatDuration, formatTokens, spendOf, type StripRun } from '@nolzu/protocol';
import { phaseStrip } from './strip.ts';

const board = deliveryBoard('pull-request');

const run = (id: number, phase: string, over: Partial<StripRun> = {}): StripRun => ({
  id,
  phase,
  state: 'complete',
  model: 'sonnet',
  effort: 'medium',
  costUsd: 0.12,
  durationMs: 64_000,
  tokens: { input: 10_000, output: 4_200, cacheRead: 0, cacheCreation: 0 },
  question: null,
  ...over,
});

describe('phaseStrip', () => {
  it('gives one segment per delivery phase, two of them with a run for a finished refine and a running plan', () => {
    const strip = phaseStrip(board, [run(1, 'refine'), run(2, 'plan', { state: 'running', costUsd: null, durationMs: null })]);

    expect(strip.map((segment) => segment.phase)).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup']);
    expect(strip.filter((segment) => segment.run !== null).map((segment) => segment.run?.id)).toEqual([1, 2]);
  });

  it('shows the newest run of a phase that ran twice, and counts both', () => {
    const plan = phaseStrip(board, [run(2, 'plan'), run(5, 'plan'), run(3, 'refine')]).find((segment) => segment.phase === 'plan');

    expect(plan?.run?.id).toBe(5);
    expect(plan?.count).toBe(2);
  });

  it('keeps a phase that never ran, with no run and a count of nought', () => {
    expect(phaseStrip(board, []).find((segment) => segment.phase === 'qa')).toEqual({ phase: 'qa', label: 'QA', run: null, count: 0, spend: spendOf([]) });
  });

  // The phase and the stage id differ on some boards, so the trail printed the phase would head the
  // segment of an investigation with "investigate". The label is what a person reads.
  it('carries the label of the stage, not its id', () => {
    const strip = phaseStrip(boardFor('investigations', 'pull-request'), []);

    expect(strip.map((segment) => [segment.phase, segment.label])).toEqual([
      ['investigate', 'Research'],
      ['wrapup', 'Wrap-up'],
    ]);
  });

  /**
   * The phase, not the stage id, is what a segment is about.
   *
   * An investigation runs `investigate` on a stage called research, so a strip built from the id would
   * match no run row at all: the runs carry the phase.
   */
  it('matches a run on the phase of the stage when the two are named differently', () => {
    const strip = phaseStrip(boardFor('investigations', 'pull-request'), [run(7, 'investigate')]);

    expect(strip[0]).toMatchObject({ phase: 'investigate', run: { id: 7 }, count: 1 });
  });

  /**
   * Every PR review round is one segment.
   *
   * Agent pre-review runs every round of `pr-review`, so a card reviewed twice shows one segment with
   * both runs counted and the newest drawn, and not the same phase under two headings.
   */
  it('draws every PR review round in one segment, under Agent pre-review', () => {
    const strip = phaseStrip(boardFor('prreview', 'pull-request'), [run(1, 'pr-review'), run(4, 'pr-review')]);

    expect(strip.map((segment) => [segment.phase, segment.label])).toEqual([
      ['pr-review', 'Agent pre-review'],
      ['wrapup', 'Wrap-up'],
    ]);
    expect(strip[0]).toMatchObject({ run: { id: 4 }, count: 2 });
  });

  // Two stages of one phase are one segment, headed by the phase, because neither stage's name is true
  // of both. No board that ships has two such stages now, so a board built here holds the rule.
  it('folds two stages of one phase into one segment, headed by the phase', () => {
    const twice: Board = {
      kind: 'prreview',
      stages: [
        { id: 'first', label: 'First round', role: 'agent', phase: 'pr-review' },
        { id: 'second', label: 'Second round', role: 'agent', phase: 'pr-review' },
      ],
    };

    expect(phaseStrip(twice, [run(1, 'pr-review'), run(2, 'pr-review')]).map((segment) => [segment.phase, segment.label, segment.count])).toEqual([['pr-review', 'PR review', 2]]);
  });

  // The other side of the fold: a phase one stage names keeps that stage's own label.
  it('keeps the stage label for a phase only one stage names', () => {
    expect(phaseStrip(boardFor('epics', 'pull-request'), []).map((segment) => [segment.phase, segment.label])).toEqual([
      ['refine', 'Refine'],
      ['architecture', 'Architecture'],
      ['design', 'Design'],
      ['plan', 'Plan'],
      ['wrapup', 'Wrap-up'],
    ]);
  });

  // A segment's spend is that phase's own runs. Taken over the card's runs instead, every segment
  // shows the card's whole total, and the one number the trail exists to break down stops being
  // broken down.
  it('gives each segment the spend of its own phase', () => {
    const strip = phaseStrip(board, [run(1, 'refine', { costUsd: 0.05 }), run(2, 'implement', { costUsd: 2.1 })]);
    const costOf = (phase: string) => strip.find((segment) => segment.phase === phase)?.spend.costUsd;

    expect(costOf('refine')).toBeCloseTo(0.05);
    expect(costOf('implement')).toBeCloseTo(2.1);
    expect(costOf('qa')).toBeNull();
  });

  it('follows the board order, not the order of the rows', () => {
    const strip = phaseStrip(board, [run(9, 'implement'), run(1, 'refine')]);

    expect(strip.map((segment) => segment.phase).slice(0, 3)).toEqual(['refine', 'plan', 'implement']);
  });

  // The summary pass is its own run row, and it is no phase of the card.
  it('leaves out runs that belong to no phase on the board', () => {
    const strip = phaseStrip(board, [run(4, 'extract-summary')]);

    expect(strip.every((segment) => segment.run === null)).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [71_000, '1m 11s'],
    [64_000, '1m 04s'],
    [900, '0.9s'],
    [0, '0s'],
    [12_400, '12s'],
    [3_780_000, '1h 03m'],
  ])('reads %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatCost', () => {
  it.each<[number | null, string]>([
    [0.008, '$0.008'],
    [1.2345, '$1.23'],
    [0.12, '$0.12'],
    [null, 'no cost yet'],
    [0.0004, 'under $0.001'],
    // A reported nought is an answer and reads like money. Only a MISSING cost says so in words.
    [0, '$0.00'],
    // Rounded through the decimal text, so an exact half cent goes up. `toFixed` rounds the binary
    // double and reads $2.67 here, which is a cent less than the board card shows for the same run.
    [2.675, '$2.68'],
    [1.005, '$1.01'],
  ])('reads %s as %s', (usd, text) => {
    expect(formatCost(usd)).toBe(text);
  });

  it('never reads a missing cost as nothing spent', () => {
    expect(formatCost(null)).not.toContain('$0');
  });
});

describe('formatTokens', () => {
  it.each([
    [12_400, '12.4k'],
    [900, '900'],
    [1_250_000, '1.3M'],
    [999_950, '1M'],
    [999_949, '999.9k'],
  ])('reads %i as %s', (count, text) => {
    expect(formatTokens(count)).toBe(text);
  });
});

describe('the card total', () => {
  // It is taken over the card's runs and never over the strip's segments. A run whose phase is no
  // stage of this board has no segment, so adding the segments would leave its cost out.
  it('counts a run whose phase is no stage of this board', () => {
    const runs = [run(1, 'implement', { costUsd: 0.5, durationMs: 1000 }), run(2, 'extract-summary', { costUsd: 0.25, durationMs: 900 })];

    // The summary pass is in no segment.
    expect(phaseStrip(board, runs).flatMap((segment) => (segment.run === null ? [] : [segment.run.phase]))).not.toContain('extract-summary');
    // The total has it, so the card reads $0.75 and not $0.50.
    expect(spendOf(runs).costUsd).toBeCloseTo(0.75);
    expect(spendOf(runs)).toMatchObject({ runs: 2, reported: 2, partial: false });
  });

  // A retry costs money too, so the total counts every run and not only the one each segment shows.
  it('adds up the cost and the time of every run, earlier tries included', () => {
    const total = spendOf([run(1, 'refine'), run(2, 'plan', { costUsd: 0.71, durationMs: 220_000 }), run(3, 'plan', { costUsd: 0.1, durationMs: 1000 })]);

    expect(total.costUsd).toBeCloseTo(0.93);
    expect(total.durationMs).toBe(285_000);
  });

  it('keeps what failed tries cost while the next try has no cost yet', () => {
    const total = spendOf([
      run(2, 'plan', { state: 'failed', costUsd: 0.5, durationMs: 1000 }),
      // A run still going has reported no counts either, so it is not a tokens-only run.
      run(4, 'plan', { state: 'running', costUsd: null, durationMs: null, tokens: null }),
    ]);

    expect(total).toEqual({ runs: 2, reported: 1, costUsd: 0.5, tokensOnly: 0, tokens: 14_200, durationMs: 1000, partial: true });
  });

  it('has no cost when no run has one yet', () => {
    expect(spendOf([run(1, 'refine', { costUsd: null })]).costUsd).toBeNull();
  });
});
