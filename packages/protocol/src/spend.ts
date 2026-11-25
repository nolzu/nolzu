import type { RunTokens } from './run.ts';

// What a roll-up reads from a run. Both the strip's run and the stored row fit it, so no level
// needs a shape of its own.
export interface SpendRun {
  costUsd: number | null;
  durationMs: number | null;
  tokens: RunTokens | null;
}

// One roll-up, for a run, a card, the project, a day or an engine profile. `costUsd` covers the
// runs that reported a cost and no others, because a cost nobody reported is never added as zero,
// and `partial` then says the figure is short of the group. `tokens` is null when no run in the
// group reported counts, which is not the same as a run that used none.
export interface Spend {
  runs: number;
  // How many of them reported a cost. A reported cost of 0 counts here: the engine said the run
  // cost nothing, which is an answer.
  reported: number;
  costUsd: number | null;
  // Runs that reported token counts and no cost. That is an engine reporting no cost at all, so
  // the number is never on its way and the group shows tokens instead.
  tokensOnly: number;
  tokens: number | null;
  durationMs: number;
  // The cost does not cover every run of the group. A caller says so in words rather than showing
  // the sum as the whole bill.
  partial: boolean;
}

// Input and output, the way the phase strip counts them. Codex already has its cached tokens in the
// input count and Claude Code does not, so adding the cache reads would count them twice on one
// engine and not the other.
const counted = (tokens: RunTokens | null) => (tokens === null ? null : tokens.input + tokens.output);

// `cost_estimate` is a plain column with no check on it, so a value that is no finite number counts
// as missing. Without that one bad row turns all five roll-ups into NaN.
export const reportedCost = (cost: number | null): number | null => (cost !== null && Number.isFinite(cost) ? cost : null);

function one(run: SpendRun): Spend {
  const cost = reportedCost(run.costUsd);
  const tokens = counted(run.tokens);
  return {
    runs: 1,
    reported: cost === null ? 0 : 1,
    costUsd: cost,
    tokensOnly: cost === null && tokens !== null ? 1 : 0,
    tokens,
    durationMs: run.durationMs ?? 0,
    partial: cost === null,
  };
}

const add = (numbers: readonly number[]) => numbers.reduce((total, number) => total + number, 0);

// The one place the rules live. Every level is these numbers added up, and a roll-up already folded
// adds the same way a list of runs does, so a day total and a project total agree to the cent a
// person is shown. Not bit for bit: doubles added in a different order differ in the last place.
export function mergeSpend(parts: readonly Spend[]): Spend {
  const costs = parts.flatMap((part) => (part.costUsd === null ? [] : [part.costUsd]));
  const tokens = parts.flatMap((part) => (part.tokens === null ? [] : [part.tokens]));
  const runs = add(parts.map((part) => part.runs));
  const reported = add(parts.map((part) => part.reported));
  return {
    runs,
    reported,
    costUsd: costs.length === 0 ? null : add(costs),
    tokensOnly: add(parts.map((part) => part.tokensOnly)),
    tokens: tokens.length === 0 ? null : add(tokens),
    durationMs: add(parts.map((part) => part.durationMs)),
    partial: reported < runs,
  };
}

// The roll-up of a group of runs: one run, a card, a day, an engine profile, or every run there is.
export function spendOf(runs: readonly SpendRun[]): Spend {
  return mergeSpend(runs.map(one));
}
