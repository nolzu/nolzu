import type { RunEvent } from '@nolzu/protocol';
import { formatCost, formatDuration, formatTokens, NEEDS_INPUT_PREFIX, SENTINEL_COMPLETE, tokensSoFar } from '@nolzu/protocol';
import { elapsed } from '../board/elapsed.ts';

// One line of the log tab. It reads engine-neutral events and not CLI lines, so a rename in the
// vendor's stream never reaches this tab.
export interface LogRow {
  kind: 'session' | 'text' | 'tool' | 'result' | 'usage' | 'retry' | 'limit' | 'question' | 'denied' | 'complete' | 'failed';
  text: string;
  // Shown folded, such as a tool's input.
  detail?: string;
  // How far into the run the line came, "0:04". Absent where the log noted no time.
  time?: string;
  // A figure at the right edge, such as the size of a result.
  aside?: string;
  // What a tool acted on, short, said beside its name. Only where the route read one off the input.
  subject?: string;
}

// An event as the log route sends it, with the time the runner noted for its line where it noted one.
// A tool event also carries what it acted on, which the route reads with the runner's `toolSubject`,
// because this package reads only the protocol.
export type TimedEvent = RunEvent & { at?: number; subject?: string | null };

// The word in the kind column, the one place the Log tab and the peek sheet name a row.
export const KIND_WORDS: Readonly<Record<LogRow['kind'], string>> = {
  session: 'session',
  text: 'says',
  tool: 'tool',
  result: 'result',
  usage: 'tokens',
  retry: 'retry',
  limit: 'limit',
  question: 'asks',
  denied: 'refused',
  complete: 'done',
  failed: 'failed',
};

// The full log's words for its rows. The peek sheet keeps the short ones.
export const LOG_WORDS: Readonly<Record<LogRow['kind'], string>> = { ...KIND_WORDS, text: 'assistant', tool: 'tool call' };

// One run in the Log tab's list, as its row keeps it. The figures are null where the engine reported
// none. Only the first four are sure to be there, so a caller that has no more still draws a list.
export interface LogRun {
  id: number;
  phase: string;
  state: string | null;
  startedAt: string | null;
  endedAt?: string | null;
  engine?: string;
  model?: string | null;
  effort?: string | null;
  // The wall that held the run (`WallKind`), null on a row made before the column.
  wall?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  // Input and output, the way the trail counts them.
  tokens?: number | null;
  // When it started, in the trail's words ("14:51"), written by the server.
  started?: string | null;
  // Why a failed run stopped, as the card's Next step says it. An engine that fails before its first
  // line leaves the log empty, and this is then the only trace of the reason.
  failureReason?: string | null;
}

// A run in one of these is over, so nothing about it counts on.
export const ENDED_RUN: readonly string[] = ['complete', 'failed', 'stopped', 'interrupted'];
const GOES = ['running', 'retrying'];

/**
 * The footer of the Log tab: how long the run took or has taken so far, and its tokens and cost only
 * where the engine reported them. A running run counts its tokens off its own usage lines, and an
 * ended one reads its row. Cost comes at the end or not at all, so a running run shows none.
 */
export function runTotals(run: LogRun, events: readonly RunEvent[], now: Date): { elapsed: string | null; tokens: string | null; cost: string | null; unpriced: boolean } {
  const ended = ENDED_RUN.includes(run.state ?? '');
  // An ended run with no end time stored has no length to show. Counting it to now would make one up.
  const until = run.endedAt != null ? new Date(run.endedAt) : ended ? null : now;
  const tokens = run.tokens ?? tokensSoFar(events);
  return {
    elapsed: run.startedAt === null || until === null ? null : elapsed(run.startedAt, until),
    tokens: tokens === null ? null : formatTokens(tokens),
    cost: run.costUsd == null ? null : formatCost(run.costUsd),
    // An ended run with no cost will never report one, as Codex never does, so the footer says so.
    unpriced: ended && run.costUsd == null,
  };
}

// The short line beside a run in the list: "running", "queued", or how a run ended, then what it took
// and cost.
export function runTag(run: LogRun): string {
  if (GOES.includes(run.state ?? '')) return 'running';
  if (!ENDED_RUN.includes(run.state ?? '')) return 'queued';
  const figures = [run.durationMs == null ? null : formatDuration(run.durationMs), run.costUsd == null ? null : formatCost(run.costUsd)].filter((one) => one !== null);
  return [run.state === 'complete' ? 'done' : run.state, ...figures].join(' · ');
}

export interface RunGroup {
  phase: string;
  // The phase's count of this run, from its first, or null for a phase that ran once.
  runs: { run: LogRun; attempt: number | null }[];
}

/**
 * The Log tab's run list, newest first as the page hands the runs: runs of one phase in a row sit under
 * one heading, and a phase that ran more than once numbers its runs.
 */
export function runGroups(runs: readonly LogRun[]): RunGroup[] {
  const left = new Map<string, number>();
  for (const one of runs) left.set(one.phase, (left.get(one.phase) ?? 0) + 1);
  const total = new Map(left);
  const groups: RunGroup[] = [];
  for (const run of runs) {
    const attempt = left.get(run.phase)!;
    left.set(run.phase, attempt - 1);
    const row = { run, attempt: total.get(run.phase)! > 1 ? attempt : null };
    const last = groups.at(-1);
    if (last?.phase === run.phase) last.runs.push(row);
    else groups.push({ phase: run.phase, runs: [row] });
  }
  return groups;
}

// The word a numbered run takes in the list. A triage is pressed again on purpose and each press is a
// run of its own, so its runs are counted and not called attempts, which read as retries of one run.
export const runCount = (phase: string, n: number): string => `${phase === 'feedback' ? 'Run' : 'Attempt'} ${n}`;

// A wait Nolzu holds, as the run row stores it and the log line carries it.
export interface RetryWait {
  attempt: number;
  maxRetries: number | null;
  reason: string | null;
  // When the next try starts, in Unix milliseconds.
  until: number;
}

const wait = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const WINDOW: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' };

// Bytes under one kilobyte, then kilobytes with one decimal under ten.
// The Discussion tab's tool rows say a result's size in the same words.
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const why = (reason: string | null) => reason ?? 'No reason given';
const tries = (one: Pick<RetryWait, 'attempt' | 'maxRetries'>) => `attempt ${one.attempt}${one.maxRetries === null ? '' : ` of ${one.maxRetries}`}`;

/**
 * A wait Nolzu holds, counted down to the stored time the next try starts: "API Error: 529
 * Overloaded, retrying in 2m 14s, attempt 2 of 3". Whole seconds, rounded up, so the count never
 * reads 0s while the wait still runs. Now, the card and the log say it in these words.
 */
export function retryLine(one: RetryWait, now: number): string {
  const left = one.until - now;
  const when = left > 0 ? `retrying in ${formatDuration(Math.ceil(left / 1000) * 1000)}` : 'retrying now';
  return `${why(one.reason)}, ${when}, ${tries(one)}`;
}

function row(event: RunEvent, now: number, over: boolean, ended: boolean): LogRow | null {
  switch (event.type) {
    case 'session':
      // An engine that names no model in its stream leaves the model out of the line. The card's
      // own row says which model it asked for, so nothing is missing from the page.
      return {
        kind: 'session',
        text: `Session ${event.sessionId}${event.model === null ? '' : ` on ${event.model}`}${event.apiKeyMode === true ? ', with an API key' : ''}`,
      };
    case 'text': {
      // The closing marker is for the runner, and a question line has its own row, so neither is
      // said twice. A message that was only the marker makes no row.
      const said = event.text
        .split('\n')
        .filter((line) => line.trim() !== SENTINEL_COMPLETE && !line.trim().startsWith(NEEDS_INPUT_PREFIX))
        .join('\n')
        .trim();
      return said === '' ? null : { kind: 'text', text: said };
    }
    case 'tool':
      return { kind: 'tool', text: event.name, detail: JSON.stringify(event.input, null, 2) };
    case 'tool_result': {
      // The kind column already says result, so the row says how much came back: its lines where the
      // answer was text, and its size at the edge.
      const lines = event.lines === undefined ? null : event.lines === 1 ? '1 line' : `${event.lines} lines`;
      return { kind: 'result', text: [event.error ? 'Error' : null, lines].filter((one) => one !== null).join(', '), aside: byteSize(event.bytes) };
    }
    case 'api_retry':
      // A wait Nolzu held counts down while it lasts, and once the run moved past it says how long
      // it waited. A run stopped in the wait, or by a restart, writes no later line, so its wait says
      // it ended. The engine's own retries carry no time and keep their short line.
      if (event.until !== undefined) {
        const one = { attempt: event.attempt, maxRetries: event.maxRetries, reason: event.reason, until: event.until };
        const said = over
          ? `${why(event.reason)}, tried again after ${wait(event.delayMs)}, ${tries(one)}`
          : ended
            ? `${why(event.reason)}, stopped waiting to try again, ${tries(one)}`
            : retryLine(one, now);
        return { kind: 'retry', text: `${said}${event.status === null ? '' : `, status ${event.status}`}` };
      }
      return {
        kind: 'retry',
        text: `Retry ${event.attempt} after ${wait(event.delayMs)}, ${event.reason?.replaceAll('_', ' ') ?? 'no reason given'}, ${event.status === null ? 'no status' : `status ${event.status}`}`,
      };
    case 'rate_limit':
      return {
        kind: 'limit',
        // A share or a reset time the engine left out is said to be missing. A zero in its place
        // would read as a measurement, and "resets 01/01/1970" is what that looked like.
        text: event.windows
          .map((one) => {
            const used = one.used === null ? 'share not reported' : `${Math.round(one.used * 100)}% used`;
            const resets = one.resetsAt === null ? 'no reset time reported' : `resets ${new Date(one.resetsAt * 1000).toLocaleString()}`;
            return `${WINDOW[one.name] ?? one.name} limit ${used}, ${resets}`;
          })
          .join('; '),
      };
    case 'needs_input':
      return { kind: 'question', text: `Asked: ${event.question}` };
    case 'permission_denied': {
      // The engine's reasons after the list, each without its own full stop, so none ends twice.
      const reasons = event.denied.flatMap((one) => (one.reason === undefined ? [] : [one.reason.replace(/\.$/, '')]));
      const because = reasons.length === 0 ? '' : `. ${reasons.join('. ')}`;
      return { kind: 'denied', text: `Refused: ${event.denied.map((one) => (one.path === null ? one.tool : `${one.tool} on ${one.path}`)).join(', ')}${because}${variableHint(event.denied)}` };
    }
    case 'complete':
      // A time or a cost the engine did not report is left out of the line. Codex reports neither,
      // and "no cost yet estimated" would read as a number still on its way.
      return {
        kind: 'complete',
        text: `Done${event.durationMs === null ? '' : ` in ${formatDuration(event.durationMs)}`}${event.costUsd === null ? '' : `, ${formatCost(event.costUsd)} estimated`}`,
      };
    case 'failed':
      return { kind: 'failed', text: `Failed: ${event.reason}${event.status === null ? '' : `, status ${event.status}`}` };
  }
  // A type this version does not know yet, from a newer engine.
  return null;
}

const pad = (value: number) => String(value).padStart(2, '0');

// How far into the run, as the time column says it: "0:04", "12:30", "1:02:03". A line stamped a
// moment before the start, by two clocks that differ, reads 0:00 and not a minus.
export function sinceStart(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

// The time of day a line came, "14:02:31", as the peek sheet says it. The server formats it, so the
// zone is the machine's, as the trail's times are.
export function clockTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
}

// Claude Code matches an allow rule past only a few known variables set in front of a command, so
// `PORT=3000 npm start` is refused under `npm *`. One plain command gets the rule that would allow
// it, word for word, since a wider one is the person's call; a chained one gets none, because each
// part needs its own rule. A quote or a backslash makes a value hold spaces, which the split below
// cannot see, so such a command gets none either.
function variableHint(denied: readonly { tool: string; path: string | null }[]): string {
  for (const one of denied) {
    if (one.tool !== 'Bash' || one.path === null || /[;&|<>`$()*?[\]\n"'\\]/.test(one.path)) continue;
    const words = one.path.trim().split(/\s+/);
    const first = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (first < 1 || words[first]!.startsWith('-')) continue;
    return `. A command with a variable in front matches only a rule that names the variable too. To allow it, add ${words.join(' ')} to the project's allowed commands, with a * at the end for any arguments.`;
  }
  return '';
}

// `now` is the clock a retry wait counts down against. `ended` says the run is over, so a wait it
// ended in counts down no more. `start` is when the run started, in Unix milliseconds, which the
// time column counts from; null draws no times. `clock`, where given, says each noted time its own
// way instead, which is how the peek sheet gets the time of day.
export function logRows(events: readonly TimedEvent[], now: number = Date.now(), ended = false, start: number | null = null, clock?: (at: number) => string): LogRow[] {
  // The tokens so far after each usage event that changed them. A call repeated on a second line, and
  // a run whose engine reports no usage, make no row.
  const totals = new Map<number, number>();
  tokensSoFar(events, (at, total) => totals.set(at, total));
  return events.flatMap((event, at): LogRow[] => {
    const time = event.at === undefined ? {} : clock !== undefined ? { time: clock(event.at) } : start === null ? {} : { time: sinceStart(event.at - start) };
    if (event.type !== 'usage') {
      const one = row(event, now, at < events.length - 1, ended);
      if (one === null) return [];
      const subject = event.type === 'tool' && typeof event.subject === 'string' && event.subject !== '' ? { subject: event.subject } : {};
      return [{ ...one, ...subject, ...time }];
    }
    const total = totals.get(at);
    return total === undefined ? [] : [{ kind: 'usage', text: `${formatTokens(total)} tokens so far`, ...time }];
  });
}

// The tool calls are most of a run's lines. Hiding them hides what they gave back too, and says how
// many calls went, so the log never looks shorter than the run was.
export function withoutTools(rows: readonly LogRow[]): { rows: LogRow[]; hidden: number } {
  const shown = rows.filter((one) => one.kind !== 'tool' && one.kind !== 'result');
  return { rows: shown, hidden: rows.filter((one) => one.kind === 'tool').length };
}
