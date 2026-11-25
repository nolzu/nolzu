import type { DatabaseSync } from 'node:sqlite';
import { atLimit, type EngineName, LIMIT_SIGNAL, NEAR_LIMIT, type ProfileLimit, profileName, type RateLimitWindow } from '@nolzu/protocol';
import { addNotification, getSetting, writeSetting } from '@nolzu/core/node';

/**
 * The five states one profile's limit block can be in.
 *
 * `share` is a number with the time it was seen. `until` is at the limit until a time, `open` is at
 * the limit with no reset time the engine gave. `unknown` is an engine that could report a window
 * and has reported none here. `unavailable` is an engine that reports none at all.
 */
export type LimitState = 'share' | 'until' | 'open' | 'unknown' | 'unavailable';

export interface LimitBlock {
  state: LimitState;
  // The line that names the state, with the time the numbers were seen where there are numbers.
  headline: string;
  // One line per window the engine reported, empty in the two states with nothing to show.
  windows: string[];
  // The percent used of each window in `windows`, for the bar under its line. Null where the engine
  // gave no share.
  shares: (number | null)[];
  // Why the block says what it says.
  note: string;
}

const WINDOW: Record<string, string> = { five_hour: '5-hour window', seven_day: 'weekly window' };

// The sentence that goes under every block built from real numbers. The engine counts the whole
// account, so a run on another machine moves these numbers without Nolzu seeing it happen.
const LAST_SEEN = 'The number is the last one seen and not a live one. It covers the whole account, so a run on another device moves it too.';

// Written out rather than relative, because "2 hours ago" needs the clock and the whole point of
// this block is that it shows what was seen and not what the clock says now.
function when(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

function line(window: RateLimitWindow, timeZone?: string): string {
  const used = window.used === null ? 'share not reported' : `${Math.round(window.used * 100)}% used`;
  const resets = window.resetsAt === null ? 'no reset time reported' : `resets ${when(window.resetsAt * 1000, timeZone)}`;
  // A window this version has no label for is named as the engine named it. The name is the
  // engine's own word, and a row missing from the block would be worse than a raw word in it.
  return `${WINDOW[window.name] ?? window.name}: ${used}, ${resets}`;
}

/**
 * The limit block for one profile, from what its engine last reported.
 *
 * The time the numbers were seen comes from the stored reading and never from the clock, so the
 * block says the same thing tomorrow as it says today. Nothing here asks a vendor anything: the
 * numbers come from what the CLI printed in its own run.
 */
export function limitBlock(vendor: EngineName, seen: ProfileLimit | undefined, timeZone?: string): LimitBlock {
  const signal = LIMIT_SIGNAL[vendor];
  if (signal.knownSilent) return { state: 'unavailable', headline: 'Not available for this engine.', windows: [], shares: [], note: signal.note };
  if (seen === undefined || seen.windows.length === 0) return { state: 'unknown', headline: 'Unknown. No usage window has been seen for this profile.', windows: [], shares: [], note: signal.note };

  const windows = seen.windows.map((window) => line(window, timeZone));
  const shares = seen.windows.map((window) => (window.used === null ? null : Math.round(window.used * 100)));
  const full = seen.windows.filter(atLimit);
  const at = when(seen.seenAt, timeZone);
  if (full.length === 0) return { state: 'share', headline: `Seen ${at}.`, windows, shares, note: LAST_SEEN };

  // The account is free again when the last of the full windows resets. One full window with no
  // reset time leaves the whole block without one, because a time that covers only part of the
  // block would let a person start a run that is refused again.
  const resets = full.map((window) => window.resetsAt);
  if (resets.some((reset) => reset === null)) {
    return { state: 'open', headline: `At its limit. The engine reported no reset time. Seen ${at}.`, windows, shares, note: LAST_SEEN };
  }
  const last = Math.max(...(resets as number[]));
  return { state: 'until', headline: `At its limit until ${when(last * 1000, timeZone)}. Seen ${at}.`, windows, shares, note: LAST_SEEN };
}

/**
 * Keeps what a run's engine reported about one profile's usage windows.
 *
 * The time is passed in rather than read here, so the reading carries the moment the run read the
 * line and not the moment the row was written. The last reading wins: the block says the last one
 * seen, and an older reading is of no use next to a newer one.
 */
export function saveLimit(db: DatabaseSync, profile: string, windows: readonly RateLimitWindow[], seenAt: number, card?: string): void {
  const stored = getSetting(db, 'engineLimits');
  // A run can report the same numbers again, and every setting write makes every open board fetch
  // its snapshot again. Nothing changed, so nothing is written and the reading keeps the time those
  // numbers were first seen.
  if (JSON.stringify(stored[profile]?.windows) === JSON.stringify(windows)) return;
  writeSetting(db, 'engineLimits', { ...stored, [profile]: { seenAt, windows, ...(card === undefined ? {} : { card }) } });
  // Kept for the bell as the toast warns: once per profile, window and reset time. A window with no
  // reset time is kept when it crosses 90%, or its first crossing would be the only one ever kept.
  for (const window of windows) {
    if (WINDOW[window.name] === undefined || window.used === null || window.used < NEAR_LIMIT || (window.resetsAt !== null && window.resetsAt * 1000 <= seenAt)) continue;
    const before = stored[profile]?.windows.find((one) => one.name === window.name);
    if (window.resetsAt === null && before?.resetsAt === null && before.used !== null && before.used >= NEAR_LIMIT) continue;
    addNotification(db, { id: `near:${profile}:${window.name}:${window.resetsAt ?? seenAt}`, kind: 'warning', text: `${profileName(profile)}, ${line(window)}`, card: card ?? null, href: '/settings/engines' });
  }
}

// Drops the readings of profiles that are gone. A removed id is free again, so the same label makes
// the same id, and without this the new profile would open with another login's numbers on it.
export function keepLimitsOf(db: DatabaseSync, ids: readonly string[]): void {
  const stored = getSetting(db, 'engineLimits');
  const left = Object.entries(stored).filter(([id]) => ids.includes(id));
  if (left.length !== Object.keys(stored).length) writeSetting(db, 'engineLimits', Object.fromEntries(left));
}
