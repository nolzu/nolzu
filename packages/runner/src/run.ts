import type { Job, RunEvent } from '@nolzu/protocol';
import type { Engine } from './engine.ts';
import { openRunLog, type RunLog, timeInRunLog } from './log.ts';
import { npmScopeRefusal } from './npm-refusal.ts';

// The two things a run needs from an engine. `parse` already carries the sentinel check, which
// is part of the engine contract, so it is not applied a second time here.
//
// The other half of the contract: `spawn` ends soon after its signal is aborted, and starts nothing
// when the signal is aborted already. A run waits for that end rather than walking away from it,
// because an engine left running would go on changing the checkout with nobody reading what it does.
export type RunEngine = Pick<Engine, 'spawn' | 'parse'>;

export interface RunOptions {
  // The wall clock. Injected, so a test can let an hour pass without waiting for it.
  now?: () => number;
  // How often the quiet is measured. A run is stopped at most this long after its timeout.
  checkEveryMs?: number;
  // Opens the run log. Injected, so a test can make a write fail in the middle of a run the way a
  // full disk does, which no file on this machine can be made to do on demand.
  openLog?: (path: string) => RunLog;
  // How long an engine may stay up after its result line before it is stopped.
  afterResultMs?: number;
}

// A failure the engine's own result does not cover: something the run left on disk makes Nolzu's next
// step unsafe. It fails the run even after a result line.
export class RunHalted extends Error {}

const CHECK_EVERY_MS = 5000;
// An engine that printed its result and stays up, saying nothing, is waiting on something it started,
// such as a server Claude Code ran in the background. After this long of quiet past the result it is
// stopped with everything it started, and the card moves on. Each line after the result starts the
// count again, in case the engine goes on with a turn of its own.
const AFTER_RESULT_MS = 10_000;
// The time column says whole seconds, so a time once a second is enough, and a burst of lines costs
// one mark.
const MARK_EVERY_MS = 1000;

// The job that continues an earlier session: a blocked card's answer, or a retry. The message is the
// whole prompt, because the session already holds the card, and the run takes the same spawn and the
// same wrapper as a fresh one.
//
// The run id and the log path are kept as given. A retry of the same run wants that, and writes on into
// the same row and log. A blocked card's answer is a new run, so it passes a job built for a new row:
// the blocked run's own job would append the answer to its log and overwrite the row that holds its
// question.
export interface ResumeOptions {
  // The profile the earlier run recorded. A session lives inside one login.
  engine?: string;
  // A model for this message alone, which the discussion composer offers. Left out, the job keeps
  // the model the action table resolved.
  model?: string;
}

export function resumeJob(job: Job, sessionId: string, message: string, options: ResumeOptions = {}): Job {
  // The same rule the argument builder applies, checked here so a bad id stops before the spawn.
  if (!/^[^\s-]\S*$/.test(sessionId)) {
    throw new Error(`There is no session ${JSON.stringify(sessionId)} to resume for ${job.cardKey}. Start the ${job.phase} phase again instead.`);
  }
  if (message.trim() === '') {
    throw new Error(`The message to ${job.cardKey} is empty, so there is nothing to continue the session with.`);
  }
  // The profile the earlier run recorded, when the caller knows it. A session lives inside one
  // login: the engine keeps it under that profile's config folder, so resuming under another
  // profile finds nothing to continue. The action table may say something else by now, and it
  // does not get a say here.
  return {
    ...job,
    sessionId: null,
    resumeFrom: sessionId,
    prompt: message,
    engine: options.engine ?? job.engine,
    model: options.model ?? job.model,
  };
}

function span(ms: number): string {
  const [count, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.round(ms / 1000), 'second'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

// One run from its first line to its end: the engine's lines, parsed, with the timeout held here.
//
// The timeout is idle time since the last line and not the length of the run, because an implement
// run can honestly take an hour while printing all the way. It rides on the job, so the setting
// is read and not stored and ignored.
//
// It ends in one of four ways. The engine gave a result, and nothing is added. The caller stopped
// it, and nothing is added either, because the caller knows and folds the run as stopped. It went
// quiet, or it ended with no result, and then a failed event says which, so a card never looks
// done by accident and never fails with nothing to read.
export async function* runJob(engine: RunEngine, job: Job, signal: AbortSignal, options: RunOptions = {}): AsyncGenerator<RunEvent> {
  const now = options.now ?? Date.now;

  // The raw stream, line by line as it arrives, so a run that is killed still leaves what it printed.
  // A log that cannot be opened stops the run before the engine starts: a run nobody can read back
  // is not one to spend an agent on.
  let log: RunLog;
  try {
    log = (options.openLog ?? openRunLog)(job.logPath);
  } catch (error) {
    yield { type: 'failed', reason: (error as Error).message, status: null };
    return;
  }

  // Nolzu's own reasons to stop the engine: it went quiet, or its log stopped taking lines.
  const stop = new AbortController();
  let lastLine = now();
  // When the last time mark went into the log. None yet, so the first line gets one.
  let marked = Number.NEGATIVE_INFINITY;
  let quietFor = 0;
  let logFailure: string | null = null;
  // The agent reads npm's 404 as a missing package, but the cause is a login on the person's side.
  // Kept from the line that showed it, and added to the reason or question the run ends with.
  let npmHint: string | null = null;
  const withHint = (event: RunEvent): RunEvent => {
    if (npmHint === null) return event;
    if (event.type === 'failed') return { ...event, reason: `${event.reason} ${npmHint}` };
    if (event.type === 'needs_input') return { ...event, question: `${event.question}\n\n${npmHint}` };
    return event;
  };

  // An interval that reads the wall clock, and not one timer as long as the timeout. Node timers
  // stand still while the machine sleeps, so a thirty minute timer fires thirty waking minutes
  // later, however long the lid was shut. The clock is what knows.
  const check = setInterval(() => {
    const idle = now() - lastLine;
    // A clock set back makes the quiet negative, and read as it is, a hung run would be allowed that
    // much longer. The count starts again instead.
    if (idle < 0) {
      lastLine = now();
      return;
    }
    if (idle < job.timeoutMs) return;
    // Stopped here, so the quiet reported is the quiet that stopped the run, and not a figure that
    // goes on growing while the engine shuts down.
    clearInterval(check);
    quietFor = idle;
    stop.abort();
  }, options.checkEveryMs ?? CHECK_EVERY_MS);
  // A check must never be what keeps the process alive.
  check.unref();

  // The engine's own result, complete or failed. It carries the cost, or the status a retry is
  // decided on, so nothing that happens after it may write over it.
  let ended = false;
  let lingering: NodeJS.Timeout | null = null;
  let thrown: Error | null = null;
  // True while a line's event is with the reader. A reader that stops there never comes back.
  let left = false;
  try {
    try {
      const linger = (): void => {
        if (lingering !== null) clearTimeout(lingering);
        lingering = setTimeout(() => stop.abort(), options.afterResultMs ?? AFTER_RESULT_MS);
        lingering.unref();
      };
      // An engine that reports no time of its own, such as Codex, is timed from here to its
      // result line, so the work Nolzu does around a run is not counted as the run's.
      const spawned = now();
      for await (const line of engine.spawn(job, AbortSignal.any([signal, stop.signal]))) {
        lastLine = now();
        if (ended) linger();
        try {
          // The mark goes in the same write as its line, so the file never holds a time with no line
          // after it.
          const mark = lastLine - marked >= MARK_EVERY_MS ? timeInRunLog(lastLine) : null;
          log.write(mark === null ? line : `${mark}\n${line}`);
          if (mark !== null) marked = lastLine;
        } catch (error) {
          logFailure = (error as Error).message;
        }
        // The line is parsed even when it could not be written, so nothing the engine already said
        // is lost. Nothing after it is read: leaving the loop below stops the engine.
        npmHint ??= npmScopeRefusal(line);
        for (const parsed of engine.parse(line)) {
          const ends = parsed.type === 'complete' || parsed.type === 'failed';
          const event = ends && (parsed.durationMs ?? null) === null ? { ...parsed, durationMs: lastLine - spawned } : parsed;
          if (ends) {
            ended = true;
            linger();
          }
          left = true;
          yield withHint(event);
          left = false;
        }
        if (logFailure !== null) break;
      }
    } catch (error) {
      thrown = error as Error;
    }

    if (thrown instanceof RunHalted) {
      // A reader that left would never take the event, and the run would hang here with its log open.
      if (left) throw thrown;
      yield withHint({ type: 'failed', reason: thrown.message, status: null, halted: true });
      return;
    }
    if (signal.aborted || ended) return;
    if (logFailure !== null) {
      yield withHint({ type: 'failed', reason: logFailure, status: null });
      return;
    }
    if (stop.signal.aborted) {
      yield withHint({
        type: 'failed',
        reason: `The run printed nothing for ${span(quietFor)}, so Nolzu stopped it. Raise the run timeout in Settings if this phase needs longer.`,
        status: null,
      });
      return;
    }
    // The engine reports an API error on its result line and then exits with a code, which is why
    // what it threw is read only when it gave no result.
    // An empty message is no reason at all, so it gets the same sentence as no message.
    yield withHint({ type: 'failed', reason: thrown?.message || 'The engine stopped and gave no result line, so the run cannot count as done.', status: null });
  } finally {
    clearInterval(check);
    if (lingering !== null) clearTimeout(lingering);
    // For a reader that walked away in the middle. The engine would otherwise keep working on the
    // checkout with nobody reading what it does.
    stop.abort();
    try {
      log.close();
    } catch {
      // Every line is written by now, and the run has ended one way or the other. A close that fails
      // late, as it can on a network folder, must not turn a finished card into a failed one.
    }
  }
}
