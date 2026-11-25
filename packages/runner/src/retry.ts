import { atLimit, type Job, type RateLimitWindow, type RunEvent } from '@nolzu/protocol';
import { retryInRunLog } from './log.ts';
import { resumeJob, runJob, type RunEngine, type RunOptions } from './run.ts';

type Failed = Extract<RunEvent, { type: 'failed' }>;

// The wait before a given retry, from the retry waits setting, or null when the attempts are used up.
// Attempt 1 is the first retry.
export function retryDelay(attempt: number, waits: readonly number[]): number | null {
  return waits[attempt - 1] ?? null;
}

// Statuses a second try can change: too many requests, a server error, an overloaded service.
const RETRIED = [429, 500, 529];

// Whether a failed run is worth resuming. It needs a session to resume, and a failure a later try can
// change. An API error with no status is a lost connection. Codex gives no status at all, and its
// sentences for a model at capacity and for high demand are the overload Claude Code reports as 529.
// Max turns, a refused permission and a failed login come back the same every time, and each retry
// loads the whole project context again.
export function retryable(failed: Failed, sessionId: string | null): boolean {
  if (sessionId === null || sessionId === '') return false;
  // A run stopped for what it left on disk. The next attempt would read that as the state before it,
  // and the reason can hold a name the run chose, such as a file called `overloaded`.
  if (failed.halted === true) return false;
  if (failed.status !== null) return RETRIED.includes(failed.status);
  // A request error other than too many requests, or an account out of credit, comes back the same.
  if (/\b4(?!29)\d\d\b|credit|billing/i.test(failed.reason)) return false;
  return /^API Error|at capacity|high demand|overloaded/i.test(failed.reason) && !/authentication|unauthorized|forbidden/i.test(failed.reason);
}

/**
 * The full usage windows a failed run ran into, one entry per window, and none for a failure of
 * another kind.
 *
 * A usage limit is read from the status and the windows the engine reported, never from the words
 * of the reason. A run whose text mentions a usage limit, in a plan or in an error of its own, has
 * not hit one, and reading that sentence would stop the retries of a run that could still finish.
 *
 * Every run reports its windows, full or not, so only a full one is a limit the run ran into. Full
 * means what it means on the Engines screen, which is why this asks `atLimit`: a window the engine
 * refused counts even where it reported no share for it.
 *
 * Claude Code reports its windows. Codex has never been seen to report
 * one, and no usage limit has been hit on the Codex account here, so nothing of its limit text is
 * known. Cursor reports no window in its stream. All of it is written down in `docs/engines/`.
 */
export function limitWindows(events: readonly RunEvent[], failed: Failed): readonly RateLimitWindow[] {
  if (failed.status !== 429) return [];
  const readings = events.flatMap((event) => (event.type === 'rate_limit' ? event.windows : [])).filter(atLimit);
  // One entry per window and not per reading: Claude Code reports its windows again and again
  // inside one attempt, and `events` holds every attempt of the run. Two readings of one window
  // would name the limit twice, and a later one with no reset time would take the sentence's reset
  // time with it. The last reading of a window wins, which is the rule the stored reading behind
  // the Engines screen follows, so the card and that screen cannot disagree.
  return [...new Map(readings.map((window) => [window.name, window])).values()];
}

// The usage window a 429 ran into, when it resets after the whole schedule would be over. A usage limit
// resets hours later, so every resume would fail, and the card is better off saying when to try again.
export function limitReached(events: readonly RunEvent[], failed: Failed, now: number, waits: readonly number[]): Reset | null {
  const scheduleEnds = now + waits.reduce((sum, wait) => sum + wait, 0);
  // A window with no reset time cannot be waited out, so the retries run as they would otherwise.
  const late = limitWindows(events, failed).filter((window) => window.resetsAt !== null && window.resetsAt * 1000 > scheduleEnds);
  // The window that frees up last is the one the run has to wait for.
  return (late as Reset[]).reduce<Reset | null>((last, window) => (last === null || window.resetsAt > last.resetsAt ? window : last), null);
}

const LABELS: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit' };

// A window this version has no label for is named as the engine named it, which says more than
// dropping it would.
const limitLabel = (window: RateLimitWindow): string => LABELS[window.name] ?? window.name;

/**
 * What the card says about a run that stopped on a usage limit, or null when it stopped on
 * something else.
 *
 * The limit is named always. The reset time is the engine's own, and the latest one when two
 * windows are full, because the account is free again when the last of them resets. A full window
 * the engine gave no reset time for leaves the whole sentence without one, which is the rule the
 * Engines screen follows too: a time that covers one window and not the other would send a person
 * into a run that is refused again.
 */
export function limitText(windows: readonly RateLimitWindow[], now: number, timeZone?: string): string | null {
  if (windows.length === 0) return null;
  if (windows.some((window) => window.resetsAt === null)) {
    return `${windows.map(limitLabel).join(' and ')} reached. The engine reported no reset time, so when it frees up is not known.`;
  }
  const last = (windows as Reset[]).reduce((later, window) => (window.resetsAt > later.resetsAt ? window : later));
  return resetText(last, now, timeZone);
}

// A window the engine gave a reset time for. Only such a window can be waited out, so it is the
// one shape both functions below take.
export type Reset = RateLimitWindow & { resetsAt: number };

// "5-hour limit, resets 19:00", with the day added when it is not today, in the person's own time.
export function resetText(window: Reset, now: number, timeZone?: string): string {
  const at = new Date(window.resetsAt * 1000);
  const day = (date: Date) => new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(at);
  return `${limitLabel(window)}, resets ${day(at) === day(new Date(now)) ? '' : `${weekday} `}${time}`;
}

export interface RetryOptions extends RunOptions {
  // The retry waits setting, in milliseconds, one per retry.
  waits: readonly number[];
  // The zone the reset time is written in. The person's own when not given.
  timeZone?: string;
  // Called when one of these waits starts and when the resumed attempt starts, so the caller can show
  // the wait. The engine's own sub-second retries arrive as events too, and are not these.
  onWait?: (wait: Extract<RunEvent, { type: 'api_retry' }>) => void;
  onResume?: () => void;
}

// What the resumed session is told. The session already holds the card and the work so far.
const RESUME = 'The last attempt stopped on an API error. Continue from where you stopped.';

const CHECK_EVERY_MS = 5000;

// Waits until the wall clock reaches `due`, or the signal is aborted. Node timers stand still while the
// machine sleeps, so the clock is read on a short interval rather than trusted to one long timer.
function waitUntil(until: number, now: () => number, checkEveryMs: number, signal: AbortSignal): Promise<void> {
  let due = until;
  return new Promise((resolve) => {
    const done = () => {
      clearInterval(check);
      signal.removeEventListener('abort', done);
      resolve();
    };
    let last = now();
    const check = setInterval(() => {
      const at = now();
      // A clock set back would stretch the wait by as much, so the time already waited is kept.
      if (at < last) due -= last - at;
      last = at;
      if (at >= due) done();
    }, checkEveryMs);
    check.unref();
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted || now() >= due) done();
  });
}

// One run with its retries: on an API error a later try can change, it waits and resumes the same
// session, so the work already done is kept. The engine retries on its own as well, so these waits are
// the second layer and are counted from the end of a failed attempt. Each wait is an `api_retry` event,
// so the card reads retrying. A failure is handed on only when no retry follows it, because a fold that
// saw an earlier failure would call the card failed although the last attempt finished.
export async function* runWithRetries(engine: RunEngine, job: Job, signal: AbortSignal, options: RetryOptions): AsyncGenerator<RunEvent> {
  const now = options.now ?? Date.now;
  const seen: RunEvent[] = [];
  let current = job;
  let sessionId: string | null = job.resumeFrom ?? job.sessionId;

  for (let attempt = 1; ; attempt += 1) {
    let failure: Extract<RunEvent, { type: 'failed' }> | null = null;
    for await (const event of runJob(engine, current, signal, options)) {
      if (event.type === 'failed') {
        failure = event;
        continue;
      }
      if (event.type === 'session' && event.sessionId !== '') sessionId = event.sessionId;
      seen.push(event);
      yield event;
    }
    // Finished, or stopped by the caller, who folds it as stopped. A check's halt still goes on, so
    // what the run left is not read as the state before the next run.
    if (failure === null) return;
    if (signal.aborted) {
      if (failure.halted === true) yield failure;
      return;
    }

    const left = options.waits.slice(attempt - 1);
    const reached = limitReached(seen, failure, now(), left);
    if (reached !== null) {
      yield { ...failure, reason: resetText(reached, now(), options.timeZone) };
      return;
    }
    // A usage limit this attempt ran into, named for the card. It covers the limit the schedule
    // cannot wait out either: a window with no reset time is retried, and when the retries are
    // used up the card still says which limit stopped the run.
    const stopped = limitText(limitWindows(seen, failure), now(), options.timeZone) ?? failure.reason;
    const delay = retryDelay(attempt, options.waits);
    if (!retryable(failure, sessionId)) {
      yield { ...failure, reason: stopped };
      return;
    }
    if (delay === null) {
      // No retry policy at all: the failure is the whole story, and "gave up after 0 retries" would
      // read as if something had been tried.
      if (options.waits.length === 0) {
        yield { ...failure, reason: stopped };
        return;
      }
      const retries = attempt - 1;
      const said = stopped.replace(/\.?$/, '.');
      yield { ...failure, reason: `${said} Gave up after ${retries} ${retries === 1 ? 'retry' : 'retries'}.` };
      return;
    }

    // When the next try starts, so the card, Now and the log can count down to it.
    const wait = { type: 'api_retry', attempt, delayMs: delay, status: failure.status, maxRetries: options.waits.length, reason: failure.reason, until: now() + delay } as const;
    try {
      retryInRunLog(current.logPath, wait, options.openLog);
    } catch {
      // The line is how the Log tab shows the wait. A log that takes no line here loses that row and
      // nothing else, and the next attempt meets the same log and says so if it is gone for good.
    }
    options.onWait?.(wait);
    yield wait;
    // Never checked less often than the wait is long, or a short wait would last a whole interval.
    await waitUntil(wait.until, now, Math.min(options.checkEveryMs ?? CHECK_EVERY_MS, delay), signal);
    if (signal.aborted) return;
    // retryable() has checked there is a session.
    current = resumeJob(current, sessionId ?? '', RESUME);
    options.onResume?.();
  }
}
