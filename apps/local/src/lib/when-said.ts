const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When something happened, as the trail says it: the time on the day it is, the weekday and time in
 * the week before, the date and time before that. The Files tab says a file's time the same way. Null
 * for a stamp that is no time, so the line leaves the time out rather than drawing a wrong one.
 */
export function whenSaid(at: string, now: Date, timeZone?: string): string | null {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return null;
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(then);
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const time = format({ hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(then) === day(now)) return time;
  if (now.getTime() - then.getTime() < 6 * DAY_MS) return `${format({ weekday: 'short' })} ${time}`;
  return `${format({ day: 'numeric', month: 'short' })} ${time}`;
}
