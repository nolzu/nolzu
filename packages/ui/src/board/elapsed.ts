const pad = (value: number) => String(value).padStart(2, '0');

// The snapshot carries the run start, not a number counted up, so a tab that was throttled or a
// laptop that slept still shows the right figure the moment it draws again. The form is the running
// pill's, "0m 40s", with the second unit padded so the pill keeps its width as it counts.
export function elapsed(startedAt: string, now: Date): string | null {
  const started = Date.parse(startedAt);
  // Nothing is better than a wrong number: a start that cannot be read rendered as zero, which
  // reads as a run that began a moment ago.
  if (!Number.isFinite(started)) return null;
  // Two clocks are never exactly equal, and a start a moment in the future would otherwise read
  // as a minus. Zero is the honest floor.
  const seconds = Math.max(0, Math.floor((now.getTime() - started) / 1000));

  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/**
 * How old something is, in one unit.
 *
 * A sibling of `elapsed` and not the same function: a run is counted in seconds, and the head
 * commit of a pull request is days old, where a figure in seconds says nothing a person can use.
 */
export function age(at: string, now: Date): string | null {
  const then = Date.parse(at);
  // Nothing is better than a wrong number, the same rule `elapsed` keeps.
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
