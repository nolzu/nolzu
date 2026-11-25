import { ESTIMATE_MIN_RUNS } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { type EstimateSample, estimateOf, historyEstimate, quantile } from './estimate.ts';
import { presetRange } from './models.ts';

const minute = 60_000;
const sample = (costUsd: number | null, minutes: number): EstimateSample => ({ costUsd, wallMs: minutes * minute });

describe('quantile', () => {
  it('reads the middle and the quartiles off sorted rows, between ranks where it falls between them', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBe(4);
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([10, 20, 30, 40], 0.25)).toBe(17.5);
    expect(quantile([7], 0.75)).toBe(7);
  });
});

describe('historyEstimate', () => {
  it('takes the median cost and the 25th to 75th percentile of wall time, whatever order the rows came in', () => {
    const rows = [sample(0.3, 10), sample(0.5, 4), sample(0.4, 8), sample(0.2, 12), sample(0.6, 6)];

    expect(historyEstimate(rows)).toEqual({ costUsd: 0.4, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  it(`gives nothing under ${ESTIMATE_MIN_RUNS} runs, so the preset answers instead`, () => {
    const rows = [sample(0.3, 10), sample(0.5, 4), sample(0.4, 8), sample(0.2, 12)];

    expect(historyEstimate(rows)).toBeNull();
    expect(historyEstimate([...rows, sample(0.6, 6)])).not.toBeNull();
  });

  // Five of seven reported a cost. Counted as zero, the two others would pull the median to $0.40.
  it('never counts a missing cost as zero', () => {
    const rows = [sample(0.4, 4), sample(null, 5), sample(null, 6), sample(0.6, 7), sample(0.5, 8), sample(0.3, 9), sample(0.7, 10)];

    expect(historyEstimate(rows)?.costUsd).toBe(0.5);
    // The time still comes from all seven.
    expect(historyEstimate(rows)).toMatchObject({ lowMs: 5.5 * minute, highMs: 8.5 * minute, runs: 7 });
  });

  // One run of five reported $0.90. Shown, that would read as the median of five runs.
  it(`gives the time alone when fewer than ${ESTIMATE_MIN_RUNS} runs reported a cost`, () => {
    const rows = [sample(null, 4), sample(null, 6), sample(0.9, 8), sample(null, 10), sample(null, 12)];

    expect(historyEstimate(rows)).toEqual({ costUsd: null, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  it('gives the time alone when no run reported a cost', () => {
    const rows = [4, 6, 8, 10, 12].map((minutes) => sample(null, minutes));

    expect(historyEstimate(rows)).toEqual({ costUsd: null, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 5 });
  });

  // cost_estimate is a plain column. A value that is no number is missing, the way the spend roll-up reads it.
  it('reads a cost that is no finite number as missing', () => {
    const rows = [sample(Number.NaN, 4), sample(0.2, 6), sample(0.3, 8), sample(Number.POSITIVE_INFINITY, 10), sample(0.4, 12), sample(0.5, 14), sample(0.6, 16)];

    expect(historyEstimate(rows)?.costUsd).toBe(0.4);
  });
});

describe('estimateOf', () => {
  const range = { costUsd: 0.05, lowMs: 21_000, highMs: 37_000 };
  const few = [sample(0.3, 10), sample(0.5, 4)];
  const enough = [sample(0.3, 10), sample(0.5, 4), sample(0.4, 8), sample(0.2, 12), sample(0.6, 6)];

  it('falls back to the preset range while the project has too few runs', () => {
    expect(estimateOf(few, range)).toEqual({ ...range, from: 'preset', runs: 0 });
    expect(estimateOf([], range)).toEqual({ ...range, from: 'preset', runs: 0 });
  });

  it('gives no number when neither the history nor the preset has one', () => {
    expect(estimateOf(few, null)).toBeNull();
  });

  it('takes the history over the preset once there is enough of it', () => {
    expect(estimateOf(enough, range)?.from).toBe('history');
  });
});

describe('presetRange', () => {
  it('has the measured range for a row the built-in presets ship', () => {
    expect(presetRange('claude-code', 'refine', 'haiku', 'low')).toEqual({ costUsd: 0.048, lowMs: 21_000, highMs: 21_000 });
  });

  it('has none for a row nobody measured, a row that differs from the preset, or a vendor nobody measured', () => {
    expect(presetRange('claude-code', 'plan', 'sonnet', 'medium')).toBeNull();
    expect(presetRange('claude-code', 'refine', 'haiku', 'medium')).toBeNull();
    expect(presetRange('codex', 'refine', 'gpt-5.6-luna', 'low')).toBeNull();
    expect(presetRange(undefined, 'refine', 'haiku', 'low')).toBeNull();
  });
});
