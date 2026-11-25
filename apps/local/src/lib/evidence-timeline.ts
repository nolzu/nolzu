import { type BoardSnapshot, type EvidenceBlock, type EvidenceDay, formatCost, formatDuration, formatTokens, mergeSpend } from '@nolzu/protocol';
import { cardPill, type Pill } from '@nolzu/ui';

/**
 * The Evidence day: an hour axis, one lane per card, and the four stat
 * tiles. Pure, so a test reads the lanes from fixture blocks and the component only places them.
 *
 * A position is a share of the axis in percent, so the drawing scales with the panel. The clock is
 * the UTC one, because the day is the UTC day `evidenceFor` folds by.
 */

export interface TimelineMark {
  block: EvidenceBlock;
  // Where it sits on the axis, 0 to 100.
  at: number;
}

// Runs close together sit side by side in one group, so Plan sits right after Refine.
// Each block is as wide as its word, so two runs a few minutes apart would cover each other otherwise.
export interface RunGroup {
  at: number;
  runs: EvidenceBlock[];
}

export interface TimelineLane {
  // Null for the work on no card: a maintenance run, a run whose card was deleted, a commit on a
  // branch that matches no card. It still happened, so it gets a lane of its own, last.
  card: string | null;
  title: string | null;
  runs: RunGroup[];
  moves: TimelineMark[];
  commits: TimelineMark[];
}

export interface Timeline {
  hours: { label: string; at: number }[];
  // Where the server's clock stood when the page loaded, on today only.
  now: number | null;
  nowLabel: string | null;
  lanes: TimelineLane[];
}

const HOUR = 3_600_000;

// Limit: a fixed share of the axis, because a pure rule cannot measure a block. On a wide panel
// six percent is about one "refine" block. Measure the words in the component if blocks start to
// cover each other on a narrow one.
const GROUP_SHARE = 6;

const share = (ms: number, from: number, span: number) => Math.round(Math.min(100, Math.max(0, ((ms - from) / span) * 100)) * 1000) / 1000;
const clock = (stamp: string) => stamp.slice(11, 16);

// Keys as a person counts them, so APP-9 comes before APP-11.
const byKey = (a: string | null, b: string | null) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'en', { numeric: true }));

/**
 * The day on an axis of whole hours: from the hour of the first block to the hour after the last one
 * ends. A run ends where its reported duration says, a run still going ends at now, and on today the
 * axis reaches now as well. One label per hour, or per two hours on a day longer than twelve.
 */
export function timelineOf(day: EvidenceDay, now: string | null): Timeline {
  if (day.blocks.length === 0) return { hours: [], now: null, nowLabel: null, lanes: [] };
  const midnight = Date.parse(`${day.day}T00:00:00Z`);
  const nowAt = now !== null && now.slice(0, 10) === day.day ? Date.parse(now) : null;
  const starts = day.blocks.map((one) => Date.parse(one.start));
  const ends = day.blocks.map((one, index) => (one.running && nowAt !== null ? nowAt : starts[index]! + (one.durationMs ?? 0)));
  const first = Math.floor((Math.min(...starts) - midnight) / HOUR);
  // Never past midnight: a run that crossed it belongs to this day, and its block runs off the end.
  const last = Math.min(24, Math.max(first + 1, Math.ceil((Math.max(...ends, nowAt ?? 0) - midnight) / HOUR)));
  const from = midnight + first * HOUR;
  const span = (last - first) * HOUR;
  const at = (stamp: string) => share(Date.parse(stamp), from, span);

  const step = Math.ceil((last - first) / 12);
  const hours = [];
  for (let hour = first; hour <= last; hour += step) hours.push({ label: `${String(hour).padStart(2, '0')}:00`, at: share(midnight + hour * HOUR, from, span) });

  return {
    hours,
    now: nowAt === null ? null : share(nowAt, from, span),
    nowLabel: nowAt === null || now === null ? null : clock(now),
    lanes: lanesOf(day.blocks, at),
  };
}

// One lane per card in key order, the work on no card last, each block placed by `at`.
function lanesOf(blocks: readonly EvidenceBlock[], at: (stamp: string) => number): TimelineLane[] {
  const lanes = new Map<string | null, TimelineLane>();
  for (const one of blocks) {
    let lane = lanes.get(one.card);
    if (lane === undefined) {
      lane = { card: one.card, title: one.cardTitle, runs: [], moves: [], commits: [] };
      lanes.set(one.card, lane);
    }
    if (one.source === 'move') lane.moves.push({ block: one, at: at(one.start) });
    else if (one.source === 'commit') lane.commits.push({ block: one, at: at(one.start) });
    else {
      const group = lane.runs.at(-1);
      // The blocks arrive earliest first, so only the last group can still reach this one.
      if (group !== undefined && at(one.start) < group.at + group.runs.length * GROUP_SHARE) group.runs.push(one);
      else lane.runs.push({ at: at(one.start), runs: [one] });
    }
  }
  return [...lanes.values()].sort((a, b) => byKey(a.card, b.card));
}

const DAY_MS = 24 * HOUR;

/**
 * The seven days of a week as one stretch of evidence, for the Week view. `day` is its Monday. The
 * spend is merged and not summed again, as the fold does for one day, and the first day that could
 * not be read whole says so for the week.
 */
export function weekEvidence(monday: string, days: readonly EvidenceDay[]): EvidenceDay {
  const ordered = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    day: monday,
    blocks: ordered.flatMap((one) => one.blocks),
    spend: mergeSpend(ordered.map((one) => one.spend)),
    problem: ordered.find((one) => one.problem !== null)?.problem ?? null,
  };
}

/** The week on an axis of seven days from its Monday, one label per day, the now line inside it. */
export function weekTimelineOf(week: EvidenceDay, now: string | null): Timeline {
  if (week.blocks.length === 0) return { hours: [], now: null, nowLabel: null, lanes: [] };
  const from = Date.parse(`${week.day}T00:00:00Z`);
  const span = 7 * DAY_MS;
  const nowAt = now === null ? null : Date.parse(now);
  const inside = nowAt !== null && nowAt >= from && nowAt < from + span;
  const days = Array.from({ length: 7 }, (_, index) => dayShift(week.day, index));
  return {
    hours: days.map((day, index) => ({ label: dayLabel(day).split(' ').slice(0, 2).join(' '), at: share(from + index * DAY_MS, from, span) })),
    now: inside ? share(nowAt, from, span) : null,
    nowLabel: inside && now !== null ? clock(now) : null,
    lanes: lanesOf(week.blocks, (stamp) => share(Date.parse(stamp), from, span)),
  };
}

export interface DayStat {
  label: string;
  // Null where the day holds no figure, and the note then says why in place of one.
  value: string | null;
  note: string;
  // A run is going, which the note marks with the running dot.
  live: boolean;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Agent time, runs, cards moved and cost. Every figure comes from the day's own blocks, and a tile
 * with nothing to count says so instead of showing a nought it never measured.
 */
export function dayStats(day: EvidenceDay, range: 'day' | 'week' = 'day'): DayStat[] {
  const onIt = range === 'week' ? 'this week' : 'on this day';
  const runs = day.blocks.filter((one) => one.source === 'run');
  const moves = day.blocks.filter((one) => one.source === 'move');
  const timed = runs.filter((one) => one.durationMs !== null);
  const running = runs.filter((one) => one.running).length;
  const untimed = runs.length - timed.length - running;
  const cards = new Set(runs.flatMap((one) => (one.card === null ? [] : [one.card]))).size;
  const spend = day.spend;

  const time: DayStat =
    runs.length === 0
      ? { label: 'Agent time', value: null, note: `No run ${onIt}`, live: false }
      : timed.length === 0
        ? { label: 'Agent time', value: null, note: running === runs.length ? 'Every run is still going' : 'No run reported its time', live: false }
        : {
            label: 'Agent time',
            value: formatDuration(timed.reduce((total, one) => total + (one.durationMs ?? 0), 0)),
            note: `${count(cards, 'card', 'cards')}${untimed > 0 ? `, ${untimed} not timed` : ''}`,
            live: false,
          };

  const cost: DayStat =
    spend.runs === 0
      ? { label: 'Cost', value: null, note: `No run ${onIt}`, live: false }
      : spend.costUsd !== null
        ? { label: 'Cost', value: formatCost(spend.costUsd), note: spend.partial ? 'estimated value, not every run reported one' : 'estimated value', live: false }
        : spend.tokens !== null
          ? { label: 'Cost', value: `${formatTokens(spend.tokens)} tokens`, note: 'tokens only, no cost reported', live: false }
          : { label: 'Cost', value: null, note: running > 0 ? 'No cost yet' : 'No run reported a cost', live: false };

  return [
    time,
    { label: 'Runs', value: String(runs.length), note: running > 0 ? `${running} running` : runs.length === 0 ? `None ${onIt}` : 'None running', live: running > 0 },
    {
      label: 'Cards moved',
      value: String(new Set(moves.map((one) => one.card ?? one.ref)).size),
      note: moves.length === 0 ? 'No card moved' : count(moves.length, 'move', 'moves'),
      live: false,
    },
    cost,
  ];
}

// Written out, because Intl names September differently from one version to the next.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);

/** "Sun 11 Oct", the day in the top bar's stepper. */
export function dayLabel(day: string): string {
  const at = dateOf(day);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** "5 to 11 Oct", or "28 Sep to 4 Oct" across a month, the week in the timesheet's head. */
export function weekLabel(first: string, last: string): string {
  const [a, b] = [dateOf(first), dateOf(last)];
  const month = (at: Date) => MONTHS[at.getUTCMonth()];
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()} to ${b.getUTCDate()} ${month(b)}` : `${a.getUTCDate()} ${month(a)} to ${b.getUTCDate()} ${month(b)}`;
}

/** The day a number of days away, in UTC, for the stepper's arrows. */
export function dayShift(day: string, days: number): string {
  const at = dateOf(day);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export interface LaneState {
  state: Pill['state'];
  // The state in words, for a screen reader beside the dot.
  word: string;
  closed: boolean;
}

const WORDS: Record<Pill['state'], string> = { idle: 'Idle', queued: 'Queued', running: 'Running', quiet: 'Quiet', ready: 'Ready', blocked: 'Blocked', failed: 'Failed', new: 'New' };

/**
 * Each card's state off the board snapshot, the board card's own rule, and whether it sits in its
 * board's archive. The lane dot reads this and never the page load, so it says what the board says.
 */
export function laneStates(boards: readonly BoardSnapshot[]): Record<string, LaneState> {
  const states: Record<string, LaneState> = {};
  for (const board of boards) {
    for (const card of board.cards) {
      const closed = board.stages.find((stage) => stage.id === card.stage)?.role === 'archive';
      const pill = cardPill(card, null, undefined);
      states[card.key] = { state: pill.state, word: closed ? 'Closed' : (pill.word ?? WORDS[pill.state]), closed };
    }
  }
  return states;
}
