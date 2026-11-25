import type { PipSegment } from '@nolzu/protocol';

// What a pip reads of a run. The card page trail passes a whole run.
type PipRun = NonNullable<PipSegment['run']>;

// How one phase is drawn. Amber is kept for the phase an agent works on now. A question is violet, as
// the blocked card is, because nothing runs while the agent waits for an answer.
export type Pip = 'done' | 'now' | 'asked' | 'failed' | 'none';

// The run's state in a word, so a mark is never the only sign of it. The card page's trail says the
// same words.
export function runWord(run: PipRun): string {
  if (run.state === 'complete') return run.question === null ? 'done' : 'asked a question';
  if (run.state === 'waiting_lane') return 'waiting';
  if (run.state === 'waiting_review') return 'waiting for Knowledge';
  return run.state ?? 'queued';
}

// QA stores a null verdict when its run printed no verdict line. The run is complete, but it is not a
// pass, and the card waits for a person. Undefined is a sender built before the field.
const noVerdict = (run: PipRun): boolean => run.phase === 'qa' && run.state === 'complete' && run.question === null && run.verdict === null;

// The word a run gets on the card page trail. A QA FAIL ends as a complete run,
// so the state alone would call it done.
export function runSaid(run: PipRun): string {
  if (run.verdict === 'FAIL') return 'failed';
  return noVerdict(run) ? 'gave no verdict' : runWord(run);
}

export function pipOf(segment: PipSegment): Pip {
  const run = segment.run;
  if (run === null) return 'none';
  if (run.state === 'failed' || run.verdict === 'FAIL') return 'failed';
  if (run.state === 'running' || run.state === 'retrying') return 'now';
  if (noVerdict(run)) return 'none';
  if (run.state === 'complete') return run.question === null ? 'done' : 'asked';
  // Queued, waiting for a lane, stopped or interrupted: the phase has not done its work, and no agent
  // works on it now.
  return 'none';
}
