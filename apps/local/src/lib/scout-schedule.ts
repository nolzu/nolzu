import { MAX_SCOUT_INTERVAL_MINUTES, MIN_SCOUT_INTERVAL_MINUTES } from '@nolzu/protocol';

/**
 * The schedule a person picks per Scout source, as the screen reads and writes it.
 *
 * Pure: the bounds are the protocol's own, the options are built from them, and nothing here touches
 * the database or the socket. What one save does to both lives in `saveScoutSchedule` in
 * `scout-sources.ts`, beside the other writers of a source row.
 *
 * A schedule is stored on this machine and sent to Nolzu cloud, and it never runs here. The cloud
 * checks no source yet, so a schedule changes nothing today. A timer stays off the laptop,
 * and a timer never starts a run that changes code.
 */

// The Solo feature name the cloud gates scheduled checks on. Spelled once here, so the screen and the
// action ask the same question of the display document.
export const SCHEDULE_FEATURE = 'scheduled-scout';

export interface ScheduleOption {
  // What the select posts, and what `scheduleChoice` marks as the chosen one.
  id: string;
  label: string;
  minutes: number;
}

export const CUSTOM = 'custom';

/**
 * The four choices: off, every 15 minutes, hourly, custom.
 *
 * The fast option is the protocol's own minimum rather than the number 15, so a bound that moves
 * cannot leave an option behind that the guard would then refuse.
 */
export const SCHEDULE_OPTIONS: readonly ScheduleOption[] = [
  { id: 'off', label: 'Off', minutes: 0 },
  { id: String(MIN_SCOUT_INTERVAL_MINUTES), label: `Every ${MIN_SCOUT_INTERVAL_MINUTES} minutes`, minutes: MIN_SCOUT_INTERVAL_MINUTES },
  { id: '60', label: 'Hourly', minutes: 60 },
  { id: CUSTOM, label: 'Custom', minutes: 0 },
];

export interface ScheduleChoice {
  minutes: number;
  notify: boolean;
  // Which option the select opens on.
  pick: string;
  // What the minutes box holds. Empty unless the stored interval is a custom one, so a person who
  // picks Custom starts on an empty box rather than on a number that was never theirs.
  custom: string;
}

/** The stored interval as the control draws it. */
export function scheduleChoice(minutes: number, notify: boolean): ScheduleChoice {
  const named = SCHEDULE_OPTIONS.find((option) => option.id !== CUSTOM && option.minutes === minutes);
  const pick = minutes === 0 ? 'off' : (named?.id ?? CUSTOM);
  return { minutes, notify, pick, custom: pick === CUSTOM ? String(minutes) : '' };
}

export interface ScheduleRead {
  intervalMinutes: number;
  notify: boolean;
}

/**
 * What the person asked for, or the sentence it is refused with.
 *
 * The minutes box is read only when Custom is picked. Off means off: the box keeps whatever it was
 * last saved with, and reading it here would turn "stop checking this" into the old interval again.
 */
export function readScheduleForm(form: FormData): ScheduleRead | { message: string } {
  const notify = (form.get('notify')?.toString() ?? '') === 'on';
  const every = form.get('every')?.toString() ?? '';

  if (every === CUSTOM) {
    const typed = (form.get('minutes')?.toString() ?? '').trim();
    if (!/^\d{1,5}$/.test(typed)) {
      return { message: `The minutes between two checks are a whole number, from ${MIN_SCOUT_INTERVAL_MINUTES} to ${MAX_SCOUT_INTERVAL_MINUTES}.` };
    }
    const minutes = Number(typed);
    if (minutes < MIN_SCOUT_INTERVAL_MINUTES || minutes > MAX_SCOUT_INTERVAL_MINUTES) {
      return {
        message: `A check every ${minutes} minutes is outside what a schedule takes. The fastest is every ${MIN_SCOUT_INTERVAL_MINUTES} minutes, and the slowest is every ${MAX_SCOUT_INTERVAL_MINUTES} minutes, which is seven days.`,
      };
    }
    return { intervalMinutes: minutes, notify };
  }

  const chosen = SCHEDULE_OPTIONS.find((option) => option.id !== CUSTOM && option.id === every);
  if (chosen === undefined) return { message: `There is no schedule called ${every}. Pick one of the choices in the list.` };
  return { intervalMinutes: chosen.minutes, notify };
}
