import { boardFor, phaseOnEnter } from '@nolzu/core';
import { type BoardSnapshot, cardStarts, type CardView, type Effort, formatCost, formatDuration, type ProfileLimit, repoOfLearnKey, type RunActivity, type RunState, type SetupView, type SlotMeter, type StageView, type Verdict } from '@nolzu/protocol';
import { age, chainTarget, dropTarget, elapsed, fixItOf, type Live, nearLimits, ordinal, retryLine, type RetryWait, startsCommand, waitingOnMe } from '@nolzu/ui';
import { stageBack, stageForward } from './board-page.ts';
import type { ChainView } from './chain.ts';
import type { FirstRun } from './getting-started.ts';
import type { NotificationsView } from './notifications.ts';
import type { QaSetup } from './qa-setup.ts';
import { isBoard } from './snapshot-client.ts';
import { retryStage } from './ticket.ts';

// What a board snapshot does not carry about a card that waits on the person.
export interface WaitingExtra {
  // When it started to wait: the end of its newest run or its last move, whichever came later. Null
  // when neither is known.
  since: string | null;
  // "What changed, in plain words" of its newest run that wrote one.
  summary: string | null;
  // An answer resumes the session of the run that asked. A run with no session cannot go on, and
  // sending the answer then fails the card with the reason.
  resumable: boolean;
  // Why the chain the person turned on did not start the next stage after the newest run. Absent
  // when it did, or never tried.
  chainRefused?: string;
  // Why a ready card stays short of the archive after its run, such as a knowledge change that waits
  // for review (`cardHolds`). Absent on a card whose next column is not the archive.
  holds?: string;
}

// One job of the scheduler: a card's run, or a run that belongs to no card, such as knowledge upkeep
// or a Scout assessment. Built from the queue, so a run on a board that is off still shows here.
export interface RunRow {
  runId: number;
  key: string;
  // The card's title. Null for a run with no card, which the page names by its kind.
  title: string | null;
  kind: 'card' | 'maintenance' | 'assessment';
  // The phase as a person reads it, such as "Implement".
  phase: string;
  state: 'running' | 'queued';
  runState: RunState | null;
  // Counted from one, for a queued job only.
  position: number | null;
  startedAt: string | null;
  // The engine profile the run is on. Optional, because a test row built before it carries none.
  engine?: string | null;
  model: string | null;
  effort: Effort | null;
  lane: string | null;
  // The wait a run sits in after an API error, with the time the next try starts. Left out by a
  // sender built before it, and by a wait from before the countdown, which then reads by its kind.
  retry?: RetryWait | null;
}

// A card that went past the person's last column today, into a column that waits on another system
// or into the archive, with what its runs that ended today cost and took.
export interface DoneRow {
  key: string;
  title: string;
  summary: string | null;
  // Null when none of those runs reported a cost, which is never summed as zero.
  costUsd: number | null;
  durationMs: number;
}

// Every run that ended today, and every move.
export interface TodayView {
  runs: number;
  // How many of the runs reported a cost.
  reported: number;
  costUsd: number | null;
  durationMs: number;
  moved: number;
}

// An engine profile with no folder in it: the usage panel names it and nothing more.
export interface NowProfile {
  id: string;
  label: string;
  // Its engine reports no usage window at all, which is normal and not a gap.
  silent: boolean;
}

export interface ScoutTeaser {
  sources: number;
  // Findings first seen since the Scout page was last opened, muted ones left out. The rail's blue dot
  // on Scout shows while there is one.
  fresh: number;
  // The finding seen last, in the words the Scout inbox prints on its row: "Sentry · seen 12 times in
  // 2 days", and the label of its source, which Scout's toast names. The label is left out by a sender
  // built before it.
  newest: { title: string; line: string; source?: string } | null;
}

// A card's run that ended ready or failed and has left the queue, for the toast it raises. The reason
// is a failed run's error, or what QA said beside its verdict.
export interface RunEnd {
  runId: number;
  key: string;
  // The phase as a person reads it, such as "QA".
  phase: string;
  state: 'complete' | 'failed';
  verdict: Verdict | null;
  reason: string | null;
  endedAt: string;
  // The engine profile the run was on. Optional, because a test row built before it carries none.
  engine?: string | null;
  model: string | null;
  durationMs: number | null;
  costUsd: number | null;
}

/**
 * The machine as Now draws it, sent whole on Now's own stream like a board.
 *
 * It never goes to the hub. The usage readings ride beside it as the stream's `limits` event, as they
 * do on a board stream, and the activity lines as its `activity` event.
 */
export interface NowSnapshot {
  version: number;
  // Every board that is on, Delivery first, each as its own board stream sends it.
  boards: readonly BoardSnapshot[];
  // By card key, for every card that waits on the person.
  waiting: Readonly<Record<string, WaitingExtra>>;
  // Running first, then the waiting jobs in queue order.
  running: readonly RunRow[];
  done: readonly DoneRow[];
  today: TodayView;
  profiles: readonly NowProfile[];
  scout: ScoutTeaser;
  // How many knowledge changes wait for a person's Apply or Return, for the rail's Knowledge item.
  // Optional, so a snapshot built before it reads as none.
  knowledgePending?: number;
  // The chain suggestion's slot. Optional, so a snapshot built before it still reads and shows none.
  chain?: ChainView;
  // Getting started, the first drag's coach note and the start-at-login offer, so the rail and the
  // board change the moment the step's event happens. Optional, as `chain` is.
  firstRun?: FirstRun;
  // What the question at the first QA shows, while a repository of the project has no answer. Null once
  // none is left, and left out by a sender built before the question, which then asks nothing.
  qaSetup?: QaSetup | null;
  // The cards whose move into QA asks the question. Left out by a sender built before answers were per
  // repository, which then asks for every card while `qaSetup` is set.
  qaAsks?: readonly string[];
  // Set up the project: every step, for the banner, and whether the next run a person starts opens the
  // Learn dialog first. Left out by a sender built before it, which then shows no banner and gates nothing.
  setup?: SetupView;
  // The newest card runs that ended, newest first. A page raises a toast for each one that ended after
  // it loaded. Left out by a sender built before it, which then raises none.
  ended?: readonly RunEnd[];
  // The bell's unread count and its newest few, kept server side so every tab shows one list. Left out
  // by a sender built before it, which then draws no count.
  notifications?: NotificationsView;
  // The project this stream serves, by its registry id. Every write from Now names it, because card
  // keys repeat across projects and another tab can pick another project. Left out by a sender built
  // before it, and then a write goes to the current project.
  project?: number;
  // Another project became the current one after this stream opened, so the page loads again on it.
  switched?: boolean;
}

// The QA stage a move would start, with the card's own models, while the project has not said how QA
// gets the app. Null when the move goes straight on: the question is answered, or the move starts no QA.
export function stackAsk(now: NowSnapshot | null, key: string, to: string): StageView | null {
  if (now?.qaSetup === undefined || now.qaSetup === null) return null;
  if (now.qaAsks !== undefined && !now.qaAsks.includes(key)) return null;
  for (const board of now.boards) {
    const card = board.cards.find((one) => one.key === key);
    if (card === undefined) continue;
    // A retry in the QA column asks too, once the answer was cleared because the scripts changed.
    const flow = boardFor(board.kind, board.flow);
    const retry = to === card.stage && flow.stages.find((one) => one.id === to)?.phase === 'qa';
    if (!retry && phaseOnEnter(flow, card.stage, to) !== 'qa') return null;
    const stage = board.stages.find((one) => one.id === to);
    return stage === undefined ? null : { ...stage, starts: cardStarts(stage, card) };
  }
  return null;
}

// Whether a move opens the Learn dialog first: the project gates its first run, and the move starts a
// phase. A move that starts nothing, such as one back to the inbox, goes straight on.
export function learnAsk(now: NowSnapshot | null, key: string, to: string): boolean {
  if (now?.setup?.gates !== true) return false;
  for (const board of now.boards) {
    const card = board.cards.find((one) => one.key === key);
    if (card !== undefined) return phaseOnEnter(boardFor(board.kind, board.flow), card.stage, to) !== undefined;
  }
  return false;
}

/**
 * The run that holds the knowledge lane now, as the Knowledge screen names it: Learn this project or
 * Optimize by its phase, a Learn your repositories run with its repository, and a card by its key.
 * With its start and its last tool action, from the Now stream. Null while the lane is free.
 */
export function knowledgeRun(now: Pick<NowSnapshot, 'boards' | 'running'> | null, activity: Readonly<Record<string, RunActivity>>): { name: string; since: string | null; line: string | null } | null {
  const holder = now?.boards.flatMap((board) => board.lanes).find((lane) => lane.name === 'knowledge')?.heldBy ?? null;
  const row = holder === null ? undefined : now?.running.find((one) => one.key === holder && one.state === 'running');
  if (row === undefined) return null;
  const repo = repoOfLearnKey(row.key);
  const name = row.kind !== 'maintenance' ? row.key : repo === null ? row.phase : `${row.phase}, ${repo}`;
  const act = activity[row.key];
  return { name, since: row.startedAt, line: act?.runId === row.runId ? act.line : null };
}

export const isNow = (value: unknown): value is NowSnapshot => {
  const now = value as NowSnapshot | null;
  return typeof now === 'object' && now !== null && typeof now.version === 'number' && Array.isArray(now.boards) && now.boards.every(isBoard) && Array.isArray(now.running) && Array.isArray(now.done);
};

// `tasks-done` is an epic whose every task is done: it stays in In delivery.
export type ItemKind = 'asks' | 'ready' | 'qa-failed' | 'failed' | 'tasks-done' | 'review';

export interface NowItem {
  card: CardView;
  board: BoardSnapshot;
  kind: ItemKind;
  extra: WaitingExtra;
}

const NO_EXTRA: WaitingExtra = { since: null, summary: null, resumable: false };

// QA's FAIL ends its run as complete, so the card reads ready. For a person it is a failure, as the
// board draws it.
function kindOf(card: CardView): ItemKind {
  // A wrap-up that waits for the person to answer a knowledge change on Knowledge. One held only behind
  // a knowledge run arrives from the snapshot as a wait for the Knowledge lane instead.
  if (card.runState === 'waiting_review') return 'review';
  if (card.finished === true) return 'tasks-done';
  if (card.state === 'blocked') return 'asks';
  if (card.state === 'failed') return 'failed';
  return card.verdict === 'FAIL' ? 'qa-failed' : 'ready';
}

/**
 * The cards that wait on the person on every board that is on, the one who waited longest first. A
 * card that never ran and never moved has no time, so it goes last. The rule is the board's
 * own `waitingOnMe`, so this list, its count and the rail's count are one number.
 */
export function waitingItems(now: Pick<NowSnapshot, 'boards' | 'waiting'>): NowItem[] {
  const items = now.boards.flatMap((board) => board.cards.filter(waitingOnMe).map((card) => ({ card, board, kind: kindOf(card), extra: now.waiting[card.key] ?? NO_EXTRA })));
  const time = (item: NowItem) => (item.extra.since === null ? Number.POSITIVE_INFINITY : Date.parse(item.extra.since));
  return items.sort((a, b) => time(a) - time(b) || a.card.key.localeCompare(b.card.key));
}

// The rail's count, and the section's, of the current project. Null before the first snapshot, so
// nothing shows a guess.
export const waitingCount = (now: NowSnapshot | null): number | null => (now === null ? null : waitingItems(now).length);

// A write's address naming the project its card belongs to, so it reaches that project's card and
// never the current project's card with the same key.
export const projectPath = (path: string, project: number | undefined): string => (project === undefined ? path : `${path}?project=${project}`);

const stageOf = (item: NowItem) => item.board.stages.find((stage) => stage.id === item.card.stage)?.label ?? item.card.stage;

// "Plan · waiting 12m", "Plan done 3m ago" and "QA · 22m ago". The stage alone without a
// time or a clock.
/**
 * Whether a run summary is long enough to hold to its first lines on Now.
 *
 * Counted in the source, not measured on screen, so the server and the browser agree. Each source
 * line takes at least one drawn line, and a long one is counted as it wraps at 72 characters, about a
 * card's width on a laptop, so more than three of those waits behind Show all and two or three cards
 * fit on a laptop screen. A wider card (the summary may run to 120ch) draws fewer lines, so the guess
 * errs toward a needless Show all, never toward text cut with no way to open it.
 * Limit: a guess by size; measure the shown height if short summaries get a needless Show all.
 */
export const longSummary = (summary: string): boolean => summary.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / 72)), 0) > 3;

export function whenLine(item: NowItem, clock: Date | undefined): string {
  const stage = stageOf(item);
  const raw = item.extra.since === null || clock === undefined ? null : age(item.extra.since, clock);
  // "0m" reads as no time at all.
  const waited = raw === '0m' ? 'under a minute' : raw;
  if (waited === null) return stage;
  // A ready card a run moved on by itself sits on a person's column, where nothing was done: it waits.
  const ranHere = item.board.stages.find((one) => one.id === item.card.stage)?.role === 'agent';
  if (item.kind === 'asks' || item.kind === 'tasks-done' || item.kind === 'review' || (item.kind === 'ready' && !ranHere)) return `${stage} · waiting ${waited}`;
  if (item.kind === 'ready') return `${stage} done ${waited} ago`;
  return `${stage} · ${waited} ago`;
}

/**
 * The start a waiting card offers, in the words the drop box and the R confirm use: the go button
 * with engine, model and effort, and the estimate only where one was measured. A ready card goes one
 * column on, a failed run is retried in its column. A column that starts nothing is a plain move.
 * A QA failure offers Fix it, which names both of its runs. Null for a question, which is answered.
 */
export type StartStep =
  | { kind: 'go'; label: string; line: string; to: string }
  | { kind: 'retry'; label: string; line: string }
  | { kind: 'fix'; label: string; line: string }
  | { kind: 'move'; label: string; to: string }
  | { kind: 'refused'; reason: string }
  | null;

export function startStep(item: NowItem): StartStep {
  // A review is answered on Knowledge, and the wrap-up then starts by itself.
  if (item.kind === 'asks' || item.kind === 'review') return null;
  if (item.kind === 'qa-failed') {
    const fix = fixItOf(item.card, item.board.stages);
    if (fix === null) return null;
    const target = chainTarget(fix.implement, fix.qa);
    if (target.kind !== 'starts') return target.kind === 'refused' ? { kind: 'refused', reason: target.reason } : null;
    // The row the first run starts on, and the figure for both runs together.
    const command = startsCommand(fix.implement.starts!);
    return { kind: 'fix', label: fix.label, line: target.estimate === undefined ? command : `${command} · ${target.estimate.text} for both runs` };
  }
  // A finished epic goes on as a ready card does, and nothing is left to approve: its tasks are done.
  const onward = item.kind === 'ready' || item.kind === 'tasks-done';
  const stage = onward ? stageForward(item.board, item.card.key) : retryStage(item.board, item.card.key);
  if (stage === null) return null;
  const target = dropTarget(stage, true);
  if (target.kind === 'refused') return { kind: 'refused', reason: target.reason };
  if (target.kind === 'nothing') return onward ? { kind: 'move', label: `Move to ${stage.label}`, to: stage.id } : null;
  const line = target.estimate === undefined ? target.command : `${target.command} · ${target.estimate.text}`;
  if (!onward) return { kind: 'retry', label: `Retry ${stage.label}`, line };
  return { kind: 'go', label: item.kind === 'tasks-done' ? `Start ${stage.label}` : `Approve and start ${stage.label}`, line, to: stage.id };
}

// "Send back": the column before, by the rule a drop there follows. Moving back never starts a run.
export function backStep(item: NowItem): { to: string; label: string } | null {
  // An epic with every task done has nothing to send back for.
  // A waiting wrap-up is queued, so its card moves back from its own page, which stops the wait first.
  if (item.kind === 'asks' || item.kind === 'tasks-done' || item.kind === 'review') return null;
  const board = boardFor(item.board.kind, item.board.flow);
  const to = stageBack(board, item.card);
  return to === null ? null : { to, label: item.board.stages.find((stage) => stage.id === to)?.label ?? to };
}

// The rail foot's "2 of 3 slots busy".
export const slotsLine = (slots: SlotMeter): string => `${slots.busy} of ${slots.total} ${slots.total === 1 ? 'slot' : 'slots'} busy`;

// One pip of the board header's slot meter. `key` is a card of the current project a click can open;
// a slot another project holds opens nothing.
export interface SlotPip {
  label: string;
  key: string | null;
  busy: boolean;
}

// The machine's slots, busy ones first, each naming the run in it. The scheduler is shared, and Now
// carries the current project's runs only, so a busy slot no row names is another project's.
export function slotPips(now: NowSnapshot): SlotPip[] {
  const slots = now.boards[0]?.slots ?? { busy: 0, total: 0 };
  const name = (row: RunRow) => (row.kind === 'card' ? `${row.key} · ${row.phase}` : row.phase);
  const runs = now.running.filter((row) => row.state === 'running').map((row) => ({ label: name(row), key: row.kind === 'card' ? row.key : null, busy: true }));
  return Array.from({ length: slots.total }, (_, at) => (at < slots.busy ? (runs[at] ?? { label: 'Busy in another project', key: null, busy: true }) : { label: 'Free slot', key: null, busy: false }));
}

// The pill of a row, in the board card's words. Quiet replaces the run time once the run has said
// nothing for the set time, so a stuck run never looks busy.
export function rowPill(row: RunRow, live: Live | null, clock: Date | undefined): { state: 'running' | 'queued' | 'quiet'; word: string | null; detail: string | null } {
  if (live !== null && live.quiet !== null) return { state: 'quiet', word: null, detail: live.quiet };
  if (row.state === 'queued') return { state: 'queued', word: null, detail: row.position === null ? null : ordinal(row.position) };
  if (row.runState === 'retrying') return { state: 'running', word: 'Retrying', detail: null };
  return { state: 'running', word: null, detail: row.startedAt === null || clock === undefined ? null : elapsed(row.startedAt, clock) };
}

// The line under a row's title: what the run did last, or why a queued one waits. A retry wait counts
// down to the stored time the next try starts; a wait with none stored says only what kind it is.
export function rowSays(row: RunRow, live: Live | null, clock?: Date): string | null {
  if (row.state === 'queued') {
    if (row.runState === 'waiting_lane' && row.lane !== null) return `Waits for the ${row.lane.charAt(0).toUpperCase()}${row.lane.slice(1)} lane`;
    return 'Starts when a slot is free';
  }
  if (row.runState === 'retrying') return row.retry != null && clock !== undefined ? retryLine(row.retry, clock.getTime()) : 'Waits to try again after an API error';
  if (live === null || live.line === null) return null;
  return live.since === null ? live.line : `${live.line} · ${live.since}`;
}

export const doneLine = (row: DoneRow): string => `${row.costUsd === null ? 'no cost reported' : formatCost(row.costUsd)} · ${formatDuration(row.durationMs)}`;

// Whole minutes, as "47m", hours past sixty, and seconds under one minute, where "0m" would
// read as no time.
function shortTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return `${Math.floor(ms / 1000)}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The four figures of Today. The cost is an estimated value, as everywhere: it sums the runs that
 * reported one and says how many those were. With no run there is nothing to cost, which is $0.00;
 * with runs and no reported cost there is no figure.
 */
export function todayStats(today: TodayView): { value: string; label: string }[] {
  const cost =
    today.runs === 0
      ? { value: '$0.00', label: 'estimated value' }
      : today.costUsd === null
        ? { value: 'None', label: 'no run reported a cost' }
        : { value: formatCost(today.costUsd), label: today.reported < today.runs ? `estimated value of ${today.reported} of ${today.runs} runs` : 'estimated value' };
  return [
    { value: shortTime(today.durationMs), label: 'agent time' },
    { value: String(today.runs), label: today.runs === 1 ? 'run' : 'runs' },
    cost,
    { value: String(today.moved), label: today.moved === 1 ? 'card moved' : 'cards moved' },
  ];
}

export interface UsageRow {
  name: string;
  // Percent used. Null when there is no figure to show, and the note says why.
  share: number | null;
  note: string | null;
  // "resets 19:00 · seen 1m ago".
  detail: string | null;
}

// The near-limit warning on Now, one line per window at 90% or more, with the profile it belongs to:
// "Claude Code: 5-hour window 99% used, resets 19:00". Nothing shows without a reading.
export const nearLines = (profiles: readonly NowProfile[], limits: Readonly<Record<string, ProfileLimit>>, now: number, timeZone?: string): string[] =>
  profiles.flatMap((profile) => nearLimits(limits[profile.id], now, timeZone).map((near) => `${profile.label}: ${near.text}`));

const WINDOWS: Readonly<Record<string, string>> = { five_hour: '5 hours', seven_day: 'week' };
const DAY_MS = 24 * 60 * 60 * 1000;
// How long a known window lasts. A reading older than that is from a window that has reset since,
// even when the engine gave no reset time: the drop box's rule for the five-hour window.
const LASTS: Readonly<Record<string, number>> = { five_hour: 5 * 60 * 60 * 1000, seven_day: 7 * DAY_MS };

/**
 * What each engine profile last reported about its usage windows. These readings stay on this machine
 *. The figure is the last one seen and not a live one, so it carries the time it
 * was seen, and a window that reset since then shows no figure, because the share then says nothing
 * about the window now.
 */
export function usageRows(profiles: readonly NowProfile[], limits: Readonly<Record<string, ProfileLimit>>, now: number, timeZone?: string): UsageRow[] {
  const clock = (ms: number, withDay: boolean) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, ...(withDay ? { day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
  return profiles.flatMap((profile): UsageRow[] => {
    if (profile.silent) return [{ name: profile.label, share: null, note: 'reports no usage window', detail: null }];
    const seen = limits[profile.id];
    if (seen === undefined || seen.windows.length === 0) return [{ name: profile.label, share: null, note: 'not seen yet', detail: null }];
    const ago = now - seen.seenAt < 60_000 ? 'seen under a minute ago' : `seen ${age(new Date(seen.seenAt).toISOString(), new Date(now))} ago`;
    return seen.windows.map((window) => {
      const name = `${profile.label} · ${WINDOWS[window.name] ?? window.name}`;
      if (window.used === null) return { name, share: null, note: 'no share reported', detail: null };
      const resets = window.resetsAt === null ? null : window.resetsAt * 1000;
      const lasts = LASTS[window.name];
      if ((resets !== null && resets <= now) || (lasts !== undefined && now - seen.seenAt > lasts)) return { name, share: null, note: 'reset since it was seen', detail: null };
      const when = resets === null ? null : `resets ${clock(resets, resets - now >= DAY_MS)}`;
      return { name, share: Math.round(window.used * 100), note: null, detail: when === null ? ago : `${when} · ${ago}` };
    });
  });
}
