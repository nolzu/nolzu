import type { RunState, RunTokens } from './run.ts';
import type { Verdict } from './sentinels.ts';
import type { Spend } from './spend.ts';
import type { WallKind } from './engine.ts';

// What the phase strip reads from a run row. Here and not in core, so the ticket page and the board
// can draw it and format its numbers.
export interface StripRun {
  id: number;
  phase: string;
  state: RunState | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  durationMs: number | null;
  tokens: RunTokens | null;
  question: string | null;
  // What a QA run decided. A FAIL ends as a complete run, so the state alone draws it as done.
  // Optional, because a sender built before the field carries none.
  verdict?: Verdict | null;
  // The sentence QA gave with its verdict, and when the run ended: the trail's "FAIL, empty list,
  // 15:40". Optional for the reason above.
  verdictReason?: string | null;
  endedAt?: string | null;
  // The engine profile the run was on, and the wall that held it (null on a row made before the
  // column). Optional for the reason above.
  engine?: string;
  wall?: WallKind | null;
}

export interface Segment {
  // The phase the stage runs, which the run rows and the log link are matched on. Not the stage id:
  // an investigation runs `investigate` on a stage called `research`, and one segment carries
  // `pr-review` for two stages.
  phase: string;
  // What the stage is called on its board, or the phase's own name where two stages share one
  // segment. The phase is not what a person reads, so an investigation shows Research and not
  // "investigate".
  label: string;
  // The newest run of the phase, or null for a phase that has not run.
  run: StripRun | null;
  count: number;
  // What every run of the phase cost and took, earlier tries included.
  spend: Spend;
}

// What a pip reads of a segment. The card page trail passes a whole Segment, which fits it.
export interface PipSegment {
  phase: string;
  label: string;
  run: Pick<StripRun, 'phase' | 'state' | 'question' | 'verdict'> | null;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

// A cost under a cent keeps three decimals, so a small run never reads as free. A missing cost says
// so in words, never "$0.00".
export function formatCost(usd: number | null): string {
  if (usd === null) return 'no cost yet';
  // A reported nought is an answer, so it reads like money. "no cost yet" above is the missing one.
  if (usd === 0) return '$0.00';
  if (usd > 0 && usd < 0.0005) return 'under $0.001';
  if (usd < 0.01) return `$${Number(usd.toFixed(3))}`;
  // Rounded through the decimal text, the way the board card rounds it. `toFixed` rounds the binary
  // double, so an exact half cent such as 2.675 goes down and the two screens show different money
  // for one run.
  return `$${Number(`${Math.round(Number(`${usd}e2`))}e-2`).toFixed(2)}`;
}

// Rounded before the unit is picked, so 999,950 reads 1M and not 1000k.
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = Math.round(count / 100) / 10;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(count / 100_000) / 10}M`;
}
