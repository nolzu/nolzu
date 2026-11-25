import { type Estimate, ESTIMATE_MIN_RUNS, reportedCost } from '@nolzu/protocol';
import type { PresetRange } from './models.ts';

// One completed first run, as the estimate reads it.
export interface EstimateSample {
  costUsd: number | null;
  // From the slot to the end, which is what a person waits. The engine's own duration leaves out the
  // worktree, the stack and every wait before a retry.
  wallMs: number;
}

// Linear between the two nearest ranks, the way a spreadsheet's PERCENTILE reads sorted rows.
export function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const below = Math.floor(at);
  const low = sorted[below] ?? 0;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;
  return low + (high - low) * (at - below);
}

const ascending = (a: number, b: number) => a - b;

// The history figure, or null under the minimum. A missing cost is left out of the median and never
// counted as zero, so the cost reads over the runs that reported one while the time reads over all.
// The cost needs the same minimum of its own, or a median of two runs would read as one of five.
export function historyEstimate(samples: readonly EstimateSample[]): Estimate | null {
  if (samples.length < ESTIMATE_MIN_RUNS) return null;
  const walls = samples.map((one) => one.wallMs).sort(ascending);
  const costs = samples.flatMap((one) => {
    const cost = reportedCost(one.costUsd);
    return cost === null ? [] : [cost];
  });
  return {
    costUsd: costs.length < ESTIMATE_MIN_RUNS ? null : quantile(costs.sort(ascending), 0.5),
    lowMs: quantile(walls, 0.25),
    highMs: quantile(walls, 0.75),
    from: 'history',
    runs: samples.length,
  };
}

// The history when there is enough of it, the preset's measured range before that, and nothing when
// neither has a number.
export function estimateOf(samples: readonly EstimateSample[], range: PresetRange | null): Estimate | null {
  return historyEstimate(samples) ?? (range === null ? null : { ...range, from: 'preset', runs: 0 });
}
