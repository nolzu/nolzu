import { effortInModel, engineName, estimateFrom, estimateSum, estimateText, goneSentence, missingProfileText, NEAR_LIMIT, profileName, type ProfileLimit, type StageView, type StartsDescriptor } from '@nolzu/protocol';
import type { Allowed, Drag } from './drag.ts';
import { dropped } from './drag.ts';

// Kept here so the screens that already read them from this file need no change; they live in protocol for the server.
export { engineName, goneSentence, ranOn } from '@nolzu/protocol';

// What the column draws while a card is dragged over it: a box that says what the drop starts, one
// that says what else the drop does, or one that refuses it. The model and the effort come from the
// snapshot, which resolved them with the same call that builds the job, so the box and the run
// cannot disagree. The command is "Claude Code · sonnet · high". The estimate is the
// line and where its figure came from, absent when nothing measured the start. The usage window is
// absent when the engine reported none, and on every board but the local one.
export type DropTarget =
  | { kind: 'starts'; command: string; estimate?: { text: string; from: string }; usage?: string }
  | { kind: 'nothing'; says: string }
  | { kind: 'refused'; reason: string };

const STARTS_NOTHING = 'Move here, starts nothing';

// Said under the Starts line of the confirm a key opens. The drop box has no room for it.
export const RUNS_HERE = 'Runs on this machine, in your checkout.';

// What the engines last reported about their usage windows, by profile id, and the clock to read them
// by. Only the local board has it: the readings never leave this machine.
export interface Usage {
  limits: Readonly<Record<string, ProfileLimit>>;
  now: number;
  timeZone?: string;
}

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// The windows whose length is known. A reading older than its window is from a window that has reset
// since, even when the engine gave no reset time.
const KNOWN_WINDOWS: Readonly<Record<string, { name: string; lasts: number }>> = {
  five_hour: { name: '5-hour window', lasts: FIVE_HOURS },
  seven_day: { name: 'weekly window', lasts: 7 * DAY },
};

export interface NearLimit {
  // The engine's own name for the window, such as "five_hour", and the one a person reads, such as
  // "5-hour window".
  window: string;
  name: string;
  // Unix seconds, or null when the engine gave no time. With the profile and the window it tells one
  // window from the next, so a warning is raised once per window.
  resetsAt: number | null;
  // "5-hour window 99% used, resets 19:00".
  text: string;
}

/**
 * The windows of one profile's last reading that are at 90% or more and have not reset since.
 *
 * The share is the one the engine measured, and nothing shows without a reading.
 * The reset time carries the day when it is a day or more away, as a weekly window's is.
 */
export function nearLimits(limit: ProfileLimit | undefined, now: number, timeZone?: string): NearLimit[] {
  if (limit === undefined) return [];
  return limit.windows.flatMap((window) => {
    const known = KNOWN_WINDOWS[window.name];
    if (known === undefined || window.used === null || window.used < NEAR_LIMIT || now - limit.seenAt > known.lasts) return [];
    const resets = window.resetsAt === null ? null : window.resetsAt * 1000;
    if (resets !== null && resets <= now) return [];
    const used = `${known.name} ${Math.round(window.used * 100)}% used`;
    if (resets === null) return [{ window: window.name, name: known.name, resetsAt: null, text: used }];
    const day = resets - now >= DAY ? { day: 'numeric', month: 'short' } as const : {};
    const at = new Intl.DateTimeFormat('en-GB', { timeZone, ...day, hour: '2-digit', minute: '2-digit', hour12: false }).format(resets);
    return [{ window: window.name, name: known.name, resetsAt: window.resetsAt, text: `${used}, resets ${at}` }];
  });
}


// The five-hour window as the engine last reported it: "5h window 62% · resets 19:00". Nothing when it
// reported no share, or when the window has reset since the reading, because the share then says
// nothing about the window now and a figure nobody measured is never shown. A
// window near its limit says so in full instead, the weekly one too. The drop still works.
export function usageLine(limit: ProfileLimit | undefined, now: number, timeZone?: string): string | null {
  const near = nearLimits(limit, now, timeZone);
  if (near.length > 0) return near.map((one) => one.text).join(' · ');
  const window = limit?.windows.find((one) => one.name === 'five_hour');
  if (limit === undefined || window === undefined || window.used === null || now - limit.seenAt > FIVE_HOURS) return null;
  if (window.resetsAt !== null && window.resetsAt * 1000 <= now) return null;
  const share = `5h window ${Math.round(window.used * 100)}%`;
  if (window.resetsAt === null) return share;
  // The time alone: a five-hour window resets within five hours of the reading.
  return `${share} · resets ${new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(window.resetsAt * 1000)}`;
}

// In protocol, because the server words a notification with it too.
export { profileName };

// "Claude Code · sonnet · high": what a start runs on, the engine by its vendor's name, or the
// profile when more than one is configured. The card page's picker shows it also for a row that is
// refused, so the person sees what to change.
export const startsCommand = (starts: Pick<StartsDescriptor, 'engine' | 'model' | 'effort' | 'severalProfiles'>): string =>
  [starts.severalProfiles === true ? profileName(starts.engine) : engineName(starts.engine), starts.model, ...(effortInModel(starts.engine) ? [] : [starts.effort])].join(' · ');

export function dropTarget(stage: StageView, startsRun: boolean, usage?: Usage): DropTarget {
  const starts = stage.starts;
  // A move back returns the card for more work and does nothing else, whatever the column does on
  // the way forward.
  if (!startsRun) return { kind: 'nothing', says: STARTS_NOTHING };
  // A stage with no phase starts no agent, so the column promises nothing.
  if (starts === null) return { kind: 'nothing', says: STARTS_NOTHING };

  // A login this machine does not hold. Named apart from a gone model, because the fix differs:
  // one needs another model, the other needs the row set back to inherit.
  if (starts.modelState === 'no-profile') {
    return { kind: 'refused', reason: `${missingProfileText(starts.engine)} Set the row back to inherit in the card settings, or in Settings, Models.` };
  }

  // A phase the vendor of this row's profile cannot run. The sentence comes with the snapshot,
  // because the rule lives in core and this package reads only the protocol. It is the sentence the
  // spawn would have thrown after the click, so the drop and the run say one thing.
  if (starts.refusal !== null) return { kind: 'refused', reason: starts.refusal };

  // A stored model the engine no longer reports. The drop must not read as if it would start
  // anything, and the person needs the name and the place to fix it.
  if (starts.modelState === 'gone') return { kind: 'refused', reason: `${starts.model} is gone. Pick another model in the card settings, or in Settings, Models.` };

  const estimate = starts.estimate;
  const window = usage === undefined ? null : usageLine(usage.limits[starts.engine], usage.now, usage.timeZone);
  return {
    kind: 'starts',
    command: startsCommand(starts),
    estimate: estimate === undefined ? undefined : { text: estimateText(estimate), from: estimateFrom(estimate) },
    usage: window ?? undefined,
  };
}

// Two runs one press starts, the second once the first ends ready: Fix it's Implement, then QA. One
// press is the consent for both. Refused when either one is. The estimate is the sum, only when both were measured.
export function chainTarget(first: StageView, then: StageView, usage?: Usage): DropTarget {
  const one = dropTarget(first, true, usage);
  if (one.kind !== 'starts') return one;
  const two = dropTarget(then, true);
  if (two.kind !== 'starts') return two;
  const sum = estimateSum(first.starts?.estimate, then.starts?.estimate);
  return {
    kind: 'starts',
    command: `${one.command}, then ${two.command}`,
    estimate: sum === undefined ? undefined : { text: estimateText(sum), from: `${first.label} and ${then.label} together` },
    usage: one.usage,
  };
}

// The same answer as one line, in the words of core `startsLabel`, for the ticket page's Move forward
// button. It names the phase where the drop box names the engine.
export function dropLabel(stage: StageView, startsRun: boolean): string {
  const target = dropTarget(stage, startsRun);
  if (target.kind === 'refused') return target.reason;
  if (target.kind === 'nothing') return target.says;
  const starts = stage.starts;
  return starts === null ? STARTS_NOTHING : `Starts: /${starts.phase} · ${starts.model} · ${starts.effort}`;
}

// What the board shows instead of sending the move. The message names the problem and the fix names
// what to do about it, which is the shape Toast takes.
export interface Refusal {
  message: string;
  // What to do about it, when the message does not already say. Null leaves the toast one line.
  fix: string | null;
  // The column a refused move did not reach, for the toast's "APP-1 did not move to Plan". Absent on
  // a refusal that moved nothing, such as a retry's.
  stage?: string;
  // The word of the message set in mono, such as a gone model's name.
  code?: string;
  // The fix without its place, such as "Pick another". A toast whose link names the one place that
  // fixes this card says that place alone.
  act?: string;
}

// Reads the same two fields `dropTarget` reads, so a column cannot draw a refusal and send the move
// anyway. Both are asked, because a snapshot that ever paired `ok` with a refusal would otherwise
// split the two. A move back starts no run, so there is nothing to refuse.
export function refuseDrop(stage: StageView, direction: 'forward' | 'back' | false): Refusal | null {
  const starts = stage.starts;
  if (direction !== 'forward' || starts === null || (starts.modelState === 'ok' && starts.refusal === null)) return null;

  if (starts.modelState === 'no-profile') {
    return {
      message: `${missingProfileText(starts.engine)} ${stage.label} cannot start a run.`,
      fix: 'Set the row back to inherit in the card settings, or in Settings, Models.',
      act: 'Set the row back to inherit',
    };
  }
  // The whole sentence comes from the snapshot, and it already names what to do, so nothing is
  // added under it.
  if (starts.refusal !== null) return { message: starts.refusal, fix: null };
  // The words, short enough that the reason and the fix fit the toast's two lines.
  return {
    message: goneSentence(stage.label, starts.model, starts.engine),
    fix: 'Pick another in the card settings, or in Settings, Models.',
    code: starts.model,
    act: 'Pick another',
  };
}

// What a key that starts a run does with the stage it runs in: ask first, the way a drop shows its box
// first; refuse the way a drop refuses; or send at once when the stage starts nothing to ask about.
export type KeyStart = { kind: 'ask' } | { kind: 'refused'; refusal: Refusal } | { kind: 'send' };

export function keyStart(stage: StageView): KeyStart {
  const refusal = refuseDrop(stage, 'forward');
  if (refusal !== null) return { kind: 'refused', refusal };
  return dropTarget(stage, true).kind === 'starts' ? { kind: 'ask' } : { kind: 'send' };
}

// What a drop on this column comes to: a move to send, a refusal to show, or nothing.
export type DropOutcome = { kind: 'move'; key: string; stage: string } | { kind: 'refused'; refusal: Refusal } | null;

// One decision, so a column cannot render a refusal and send the move anyway. The component asks
// once and does what this says, which keeps the rule somewhere a test can reach it.
export function dropOutcome(drag: Drag | null, stage: StageView, allowed: Allowed): DropOutcome {
  const refusal = refuseDrop(stage, drag === null ? false : allowed(stage.id));
  if (refusal !== null) return { kind: 'refused', refusal: { ...refusal, stage: stage.label } };
  const move = dropped(drag, stage.id, allowed);

  return move === null ? null : { kind: 'move', key: move.key, stage: move.stage };
}

// A refusal the server sent back. The server writes the whole sentence, including what to do about
// it, so nothing is added here: a second line invented on this side would name the wrong fix for
// every refusal that is a rule rather than a stale board.
export function refusalFromServer(message: string): Refusal {
  const said = message.trim();

  return { message: said === '' ? 'The move was refused.' : said, fix: null };
}
