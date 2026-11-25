import { formatCost } from './strip.ts';

/**
 * What a start will likely cost and take.
 *
 * It comes from this project's own completed first runs of the same phase, model and effort once
 * there are enough of them, and from the preset's measured range before that. A start with neither
 * carries no estimate at all, because a screen never shows a number nobody measured.
 */
export interface Estimate {
  // The median over the runs that reported a cost. Null when fewer than the minimum did, which
  // includes an engine that reports tokens only, and the line then shows the time alone.
  costUsd: number | null;
  // Wall time from the slot to the end, the 25th to the 75th percentile, in milliseconds.
  lowMs: number;
  highMs: number;
  from: 'history' | 'preset';
  // How many of this project's runs the figure is taken over. 0 for the preset.
  runs: number;
}

// Five, because under five runs the slowest one moves the top of the range. From five on it
// does not.
export const ESTIMATE_MIN_RUNS = 5;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

function timeText(estimate: Estimate): string {
  const low = minutes(estimate.lowMs);
  const high = Math.max(low, minutes(estimate.highMs));
  return estimate.highMs < 60_000 ? 'under a minute' : low === high ? `${low} min` : `${low} to ${high} min`;
}

// "about $0.004" reads as precise, and "about $0.00" as free.
const costText = (usd: number) => (usd < 0.01 ? 'under $0.01' : `about ${formatCost(usd)}`);

// The drawn form, "about $0.40 · 6 to 10 min", or the time alone when no run reported a cost.
export function estimateText(estimate: Estimate): string {
  const time = timeText(estimate);
  return estimate.costUsd === null ? time : `${costText(estimate.costUsd)} · ${time}`;
}

// The estimate line of Learn your repositories, per repository. Before any Learn run is measured it
// names a Refine run on the same model and effort, which reads less, so the person still sees a
// number and knows it is the low end.
export function learnEstimateText(starts: { estimate?: Estimate; like?: Estimate }): string {
  if (starts.estimate !== undefined) return `${estimateText(starts.estimate)} per repository, ${estimateFrom(starts.estimate)}.`;
  if (starts.like !== undefined) return `No Learn run measured yet. A Refine run on this model and effort is ${estimateText(starts.like)}, and a Learn run reads more files, so expect more per repository.`;
  return 'No estimate yet: this project has no measured run of this kind.';
}

// One figure, for a column header with room for one, as the board draws it: the cost, or the time
// when no run reported a cost.
export function estimateShort(estimate: Estimate): string {
  return estimate.costUsd === null ? timeText(estimate) : costText(estimate.costUsd);
}

// The column header's figure in the drawn short form, "~$0.05". The drop box keeps "about".
export function estimateBrief(estimate: Estimate): string {
  if (estimate.costUsd === null) return timeText(estimate);
  return estimate.costUsd < 0.01 ? costText(estimate.costUsd) : `~${formatCost(estimate.costUsd)}`;
}

// Where the figure came from, for a screen with room to say it.
export function estimateFrom(estimate: Estimate): string {
  return estimate.from === 'history'
    ? `from ${estimate.runs} runs in this project`
    : `from the preset, until this project has ${ESTIMATE_MIN_RUNS} runs of this phase on this model and effort`;
}

// Two runs one press starts, such as Fix it's Implement and then QA. Nothing
// unless both were measured, because a sum with a made-up half is a made-up number, and the cost
// only when both reported one.
// Limit: the quartiles of each run added, not the quartiles of their sum. Close enough for a range.
export function estimateSum(first: Estimate | undefined, second: Estimate | undefined): Estimate | undefined {
  if (first === undefined || second === undefined) return undefined;
  return {
    costUsd: first.costUsd === null || second.costUsd === null ? null : first.costUsd + second.costUsd,
    lowMs: first.lowMs + second.lowMs,
    highMs: first.highMs + second.highMs,
    from: first.from === 'history' && second.from === 'history' ? 'history' : 'preset',
    runs: Math.min(first.runs, second.runs),
  };
}
