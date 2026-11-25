import type { TimesheetEntry } from '@nolzu/protocol';
import {
  DAY_MS,
  callDestination,
  detail,
  entrySecond,
  type ExportFetch,
  idSetting,
  isHtml,
  requiredId,
  startSecond,
  utcSecond,
  webPage,
} from './timesheet-call.ts';

/**
 * The Clockify exporter: one timesheet entry becomes one Clockify time entry. The `clockify` entry
 * of `EXPORT_ADAPTERS`, with the same contract as `exportToggl`.
 *
 * LOOK BEFORE POSTING, for the reason the Toggl file gives. Clockify has no field for somebody
 * else's id either, so an entry is recognised the way Toggl's is, by what this file wrote: the
 * start and the end to the second and the description. The list is per user, so each post first
 * asks Clockify who the token belongs to, which makes three calls per entry.
 *
 * NOT RECORDED. Clockify has never answered this project. Every path, header, field and status below
 * is written from Clockify's API v1 documentation, and every body in the test file beside this one
 * is written by hand from the same. A first real call has to confirm:
 *  1. That `POST /api/v1/workspaces/{workspace}/time-entries` creates one entry and answers 201 with
 *     that entry as a JSON object whose `id` is a string.
 *  2. That the API key goes in the `X-Api-Key` header.
 *  3. The body: `start` and `end` as UTC times to the second, `description`, and `projectId`.
 *  4. That `GET /api/v1/user` answers the key owner as an object with an `id`.
 *  5. That `GET /api/v1/workspaces/{workspace}/user/{user}/time-entries?start=&end=&page-size=`
 *     answers a bare list of that user's entries starting inside the window, at most `page-size`
 *     of them.
 *  6. That each listed row carries `id`, `description` and `timeInterval.start` and
 *     `timeInterval.end` under those names, with the times to the second as they were posted.
 *  7. That 401 is a bad key, 403 a workspace the key cannot use, 404 an unknown workspace or
 *     project, 400 a refused field with a `message`, and 429 a rate limit.
 */

export const CLOCKIFY_ORIGIN = 'https://api.clockify.me';

// A Clockify id as a person copies it out of an address: 24 hex digits.
const ID = /^[0-9a-f]{24}$/;

// A read holds this many rows. A full page with no match is refused, because the entry could be on
// the next one.
const PAGE_SIZE = 200;

/** The workspace an entry goes into. A connection without one is refused before any call. */
export const clockifyWorkspace = (settings: Record<string, unknown>): string => requiredId('Clockify', settings, 'workspace', ID);

/** The Clockify project, which is optional: an entry without one still lands in the workspace. */
export const clockifyProject = (settings: Record<string, unknown>): string | null => idSetting('Clockify', settings, 'project', ID);

/** The card key first, so a person can find the card, then the title the grid drew. */
export const clockifyDescription = (entry: TimesheetEntry): string => `${entry.card} ${entry.title}`;

/** The body of one post. Nothing in it comes from the token. */
export function clockifyBody(entry: TimesheetEntry, project: string | null): Record<string, unknown> {
  const at = entrySecond(entry.start) * 1000;
  return {
    start: utcSecond(at),
    end: utcSecond(at + entry.minutes * 60_000),
    description: clockifyDescription(entry),
    ...(project === null ? {} : { projectId: project }),
  };
}

/** The read that looks for an entry before it is posted: a day either side of its start. */
export function clockifyDayPath(workspace: string, user: string, start: string): string {
  const at = entrySecond(start) * 1000;
  const window = new URLSearchParams({ start: utcSecond(at - DAY_MS), end: utcSecond(at + DAY_MS), 'page-size': String(PAGE_SIZE) });
  return `/api/v1/workspaces/${workspace}/user/${encodeURIComponent(user)}/time-entries?${window}`;
}

/** The sentence one refused call leaves on the entry. One per status, because each fix differs. */
export function clockifyRefusal(status: number, body: string, secrets: string[] = []): string {
  if (isHtml(body)) return webPage('Clockify');
  if (status === 401) {
    return 'Clockify refused the API key, so the entry was not sent. Generate an API key in your Clockify profile and save the Clockify connection again.';
  }
  if (status === 403) {
    return 'Clockify says this API key cannot use that workspace, so the entry was not sent. Check the workspace on the Clockify connection.';
  }
  if (status === 404) {
    return 'Clockify does not know that workspace or project, or the key cannot see it, so the entry was not sent. Check the Clockify connection.';
  }
  if (status === 429) return 'Clockify is rate limiting this API key, so the entry was not sent. Export again in a minute.';
  if (status >= 500) return `Clockify answered ${status}, so the entry was not sent. Export again later.`;
  return `Clockify refused the entry with ${status}, so it was not sent.${detail('Clockify', body, secrets)}`;
}

// Clockify's ids are strings. Anything that is not one is no id.
const idOf = (value: unknown): string | null => (typeof value === 'string' && /^[0-9A-Za-z]{1,64}$/.test(value) ? value : null);

/** The key owner's id, which the list of entries is filed under. */
export function readClockifyUser(body: string): string {
  let user: unknown;
  try {
    user = JSON.parse(body);
  } catch {
    // Read as no id below.
  }
  const id = user !== null && typeof user === 'object' ? idOf((user as { id?: unknown }).id) : null;
  if (id === null) throw new Error('Clockify answered who owns the API key with something Nolzu could not read, so the entry was not sent.');
  return id;
}

/**
 * The id of the entry Clockify already holds for this one, or null when it holds none.
 *
 * The same refusals as `findTogglEntry`: an answer that is not a list, a list whose rows carry no
 * time this file can read, and a row at this entry's times whose description or id it cannot read.
 * And a full page with no match, because the entry could be on the next one.
 */
export function findClockifyEntry(body: string, entry: TimesheetEntry): string | null {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error('Clockify answered the day with something Nolzu could not read, so the entry was not sent.');
  }
  if (!Array.isArray(rows)) {
    throw new Error('Clockify answered the day with something that is not a list of entries, so the entry was not sent.');
  }
  const start = entrySecond(entry.start);
  const end = start + entry.minutes * 60;
  const description = clockifyDescription(entry);
  let readable = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const one = row as Record<string, unknown>;
    const interval = one.timeInterval !== null && typeof one.timeInterval === 'object' ? (one.timeInterval as Record<string, unknown>) : {};
    const from = typeof interval.start === 'string' ? startSecond(interval.start) : null;
    const to = typeof interval.end === 'string' ? startSecond(interval.end) : null;
    if (from === null || to === null) continue;
    readable += 1;
    if (from !== start || to !== end) continue;
    if (!(typeof one.description === 'string' || one.description === null)) {
      throw new Error(
        'Clockify holds an entry at the same time on that day and Nolzu could not read its description, so the entry was not sent. Nolzu is reading the answer wrongly.',
      );
    }
    if (one.description !== description) continue;
    const id = idOf(one.id);
    if (id === null) throw new Error('Clockify already holds this entry and Nolzu could not read its id, so the entry was not sent again.');
    return id;
  }
  if (rows.length > 0 && readable === 0) {
    throw new Error(
      `Clockify answered ${rows.length === 1 ? 'one entry' : `${rows.length} entries`} on that day and Nolzu could read the time on none of them, so the entry was not sent. Nolzu is reading the answer wrongly.`,
    );
  }
  if (rows.length >= PAGE_SIZE) {
    throw new Error('Clockify answered a full page of entries around that day, so Nolzu could not tell whether it already holds the entry and did not send it.');
  }
  return null;
}

/**
 * Posts one entry to Clockify and answers with the id Clockify gave it.
 *
 * Limit: three calls per entry, the user read included. The user could be read once per export,
 * and the `ExportAdapter` contract gives this file one entry at a time. If the rate limit bites, the
 * upgrade is a batch seam on the contract, the same one the Toggl file names.
 */
export async function exportClockify(
  entry: TimesheetEntry,
  secret: string,
  settings: Record<string, unknown>,
  signal: AbortSignal,
  fetcher?: ExportFetch,
): Promise<string | null> {
  const workspace = clockifyWorkspace(settings);
  const project = clockifyProject(settings);
  const body = JSON.stringify(clockifyBody(entry, project));
  const to = { label: 'Clockify', origin: new URL(CLOCKIFY_ORIGIN), headers: { 'x-api-key': secret }, secrets: [secret], refusal: clockifyRefusal, fetcher };

  const user = readClockifyUser(await callDestination(to, 'GET', '/api/v1/user', undefined, signal));
  const day = await callDestination(to, 'GET', clockifyDayPath(workspace, user, entry.start), undefined, signal);
  const held = findClockifyEntry(day, entry);
  if (held !== null) return held;

  const posted = await callDestination(to, 'POST', `/api/v1/workspaces/${workspace}/time-entries`, body, signal, 201);
  let id: string | null = null;
  try {
    id = idOf((JSON.parse(posted) as { id?: unknown } | null)?.id);
  } catch {
    // Read as no id below.
  }
  if (id === null) {
    throw new Error(
      'Clockify answered the post with something Nolzu could not read, so the entry is not marked as sent. The next export looks for it in Clockify before it posts again.',
    );
  }
  return id;
}
