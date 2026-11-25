import { describe, expect, it } from 'vitest';
import { type Estimate, estimateBrief, ESTIMATE_MIN_RUNS, estimateFrom, estimateShort, estimateSum, estimateText, learnEstimateText } from './estimate.ts';

const minute = 60_000;
const estimate = (over: Partial<Estimate> = {}): Estimate => ({ costUsd: 0.4, lowMs: 6 * minute, highMs: 10 * minute, from: 'history', runs: 8, ...over });

describe('estimateText', () => {
  it('writes the drawn form: about the cost, then the minutes', () => {
    expect(estimateText(estimate())).toBe('about $0.40 · 6 to 10 min');
  });

  it('rounds the minutes to the nearest one', () => {
    expect(estimateText(estimate({ lowMs: 5 * minute + 40_000, highMs: 9 * minute + 50_000 }))).toBe('about $0.40 · 6 to 10 min');
  });

  it('says under a minute when the slow end is under one', () => {
    expect(estimateText(estimate({ costUsd: 0.053, lowMs: 21_000, highMs: 37_000 }))).toBe('about $0.05 · under a minute');
  });

  it('writes one number when both ends round to the same minute', () => {
    expect(estimateText(estimate({ lowMs: 50_000, highMs: 80_000 }))).toBe('about $0.40 · 1 min');
  });

  // An engine that reports tokens and no cost. A dollar figure here would be one nobody reported.
  it('shows the time alone when no run reported a cost', () => {
    expect(estimateText(estimate({ costUsd: null }))).toBe('6 to 10 min');
  });

  it('says under a cent rather than about nothing', () => {
    expect(estimateText(estimate({ costUsd: 0.004 }))).toBe('under $0.01 · 6 to 10 min');
    // A reported nought is an answer, and it is under a cent too.
    expect(estimateText(estimate({ costUsd: 0 }))).toBe('under $0.01 · 6 to 10 min');
    // A cent exactly is not under one.
    expect(estimateText(estimate({ costUsd: 0.01 }))).toBe('about $0.01 · 6 to 10 min');
  });
});

describe('estimateShort', () => {
  it('gives the cost alone, as a column header draws it', () => {
    expect(estimateShort(estimate())).toBe('about $0.40');
    expect(estimateShort(estimate({ costUsd: 0.004 }))).toBe('under $0.01');
  });

  it('gives the time when no run reported a cost, never a made up cost', () => {
    expect(estimateShort(estimate({ costUsd: null }))).toBe('6 to 10 min');
  });
});

// The column header's drawn short form, "~$0.05", where the drop box keeps "about".
describe('estimateBrief', () => {
  it('gives the cost after a tilde', () => {
    expect(estimateBrief(estimate({ costUsd: 0.053 }))).toBe('~$0.05');
    expect(estimateBrief(estimate({ costUsd: 0.004 }))).toBe('under $0.01');
  });

  it('gives the time when no run reported a cost', () => {
    expect(estimateBrief(estimate({ costUsd: null }))).toBe('6 to 10 min');
  });
});

describe('estimateFrom', () => {
  it('names the runs a history figure was taken over', () => {
    expect(estimateFrom(estimate({ runs: 8 }))).toBe('from 8 runs in this project');
  });

  it('names the preset, and how many runs replace it', () => {
    expect(estimateFrom(estimate({ from: 'preset', runs: 0 }))).toBe(`from the preset, until this project has ${ESTIMATE_MIN_RUNS} runs of this phase on this model and effort`);
  });
});

// Fix it starts Implement and then QA with one press, so its button shows both
// runs as one figure. A half nobody measured makes the whole figure a guess.
describe('estimateSum', () => {
  it('adds the cost and both ends of the time', () => {
    const sum = estimateSum(estimate(), estimate({ costUsd: 0.1, lowMs: 2 * minute, highMs: 3 * minute, runs: 5 }));

    expect(sum).toEqual({ costUsd: 0.5, lowMs: 8 * minute, highMs: 13 * minute, from: 'history', runs: 5 });
    expect(estimateText(sum!)).toBe('about $0.50 · 8 to 13 min');
  });

  it('gives nothing when either run has no estimate', () => {
    expect(estimateSum(estimate(), undefined)).toBeUndefined();
    expect(estimateSum(undefined, estimate())).toBeUndefined();
  });

  // A null cost is never added as nought.
  it('keeps the time and drops the cost when either run reported none', () => {
    expect(estimateSum(estimate({ costUsd: null }), estimate())).toMatchObject({ costUsd: null, lowMs: 12 * minute, highMs: 20 * minute });
  });

  it('reads as the preset when either figure came from one', () => {
    expect(estimateSum(estimate({ from: 'preset', runs: 0 }), estimate())?.from).toBe('preset');
  });
});

describe('learnEstimateText', () => {
  it('reads the Learn run measured, then a Refine run on the same model as the low end, then none', () => {
    expect(learnEstimateText({ estimate: estimate(), like: estimate() })).toBe('about $0.40 · 6 to 10 min per repository, from 8 runs in this project.');
    expect(learnEstimateText({ like: estimate({ costUsd: 0.048, lowMs: 21_000, highMs: 21_000, from: 'preset', runs: 0 }) })).toBe(
      'No Learn run measured yet. A Refine run on this model and effort is about $0.05 · under a minute, and a Learn run reads more files, so expect more per repository.',
    );
    expect(learnEstimateText({})).toBe('No estimate yet: this project has no measured run of this kind.');
  });
});
