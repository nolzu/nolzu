import { MAX_SCOUT_INTERVAL_MINUTES, MIN_SCOUT_INTERVAL_MINUTES } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { CUSTOM, SCHEDULE_FEATURE, SCHEDULE_OPTIONS, readScheduleForm, scheduleChoice } from './scout-schedule.ts';

const post = (body: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  return readScheduleForm(form);
};

// Written out, not read back from the module. This string is what the cloud's own feature map keys the
// schedule on (it maps `scout.schedule` to `scheduled-scout`), so the two repositories agree on it by
// this literal and nothing else. Swapping it for another feature
// name, `cloud-board` above all, would hand scheduled Scout to an account that never paid for it.
it('gates the schedule on the feature the cloud charges for', () => {
  expect(SCHEDULE_FEATURE).toBe('scheduled-scout');
});

it('offers off, the fastest interval, hourly and custom', () => {
  expect(SCHEDULE_OPTIONS.map((option) => option.id)).toEqual(['off', String(MIN_SCOUT_INTERVAL_MINUTES), '60', CUSTOM]);
  // The fast option is the protocol's minimum, so no option can name an interval the guard refuses.
  expect(SCHEDULE_OPTIONS[1]?.minutes).toBe(MIN_SCOUT_INTERVAL_MINUTES);
});

it('opens the control on the stored interval', () => {
  expect(scheduleChoice(0, false).pick).toBe('off');
  expect(scheduleChoice(MIN_SCOUT_INTERVAL_MINUTES, false).pick).toBe(String(MIN_SCOUT_INTERVAL_MINUTES));
  expect(scheduleChoice(60, true)).toEqual({ minutes: 60, notify: true, pick: '60', custom: '' });
  expect(scheduleChoice(240, false)).toEqual({ minutes: 240, notify: false, pick: CUSTOM, custom: '240' });
});

it('reads the three named choices and the notify flag', () => {
  expect(post({ every: 'off' })).toEqual({ intervalMinutes: 0, notify: false });
  expect(post({ every: '60', notify: 'on' })).toEqual({ intervalMinutes: 60, notify: true });
  expect(post({ every: String(MIN_SCOUT_INTERVAL_MINUTES) })).toEqual({ intervalMinutes: MIN_SCOUT_INTERVAL_MINUTES, notify: false });
});

it('ignores the minutes box unless the choice is custom', () => {
  // The box keeps the last custom number a person typed. Reading it on off would turn "stop checking
  // this" back into the old interval.
  expect(post({ every: 'off', minutes: '240' })).toEqual({ intervalMinutes: 0, notify: false });
  expect(post({ every: '60', minutes: '240' })).toEqual({ intervalMinutes: 60, notify: false });
  expect(post({ every: CUSTOM, minutes: '240' })).toEqual({ intervalMinutes: 240, notify: false });
});

it('refuses an interval outside the bounds, and says what the bounds are', () => {
  const fast = post({ every: CUSTOM, minutes: String(MIN_SCOUT_INTERVAL_MINUTES - 1) });
  expect(fast).toEqual({ message: expect.stringContaining(`every ${MIN_SCOUT_INTERVAL_MINUTES} minutes`) });
  const slow = post({ every: CUSTOM, minutes: String(MAX_SCOUT_INTERVAL_MINUTES + 1) });
  expect(slow).toEqual({ message: expect.stringContaining(`every ${MAX_SCOUT_INTERVAL_MINUTES} minutes`) });
  // Both bounds are taken, so the sentence is about what is outside them and not about every value.
  expect(post({ every: CUSTOM, minutes: String(MIN_SCOUT_INTERVAL_MINUTES) })).toEqual({ intervalMinutes: MIN_SCOUT_INTERVAL_MINUTES, notify: false });
  expect(post({ every: CUSTOM, minutes: String(MAX_SCOUT_INTERVAL_MINUTES) })).toEqual({ intervalMinutes: MAX_SCOUT_INTERVAL_MINUTES, notify: false });
});

it('refuses a minutes box that is not a whole number, and a choice nobody offers', () => {
  for (const typed of ['', ' ', 'hourly', '15.5', '-15', '1e4', '999999']) {
    expect(post({ every: CUSTOM, minutes: typed })).toHaveProperty('message');
  }
  expect(post({ every: 'weekly' })).toEqual({ message: expect.stringContaining('no schedule called weekly') });
  expect(post({})).toHaveProperty('message');
});
