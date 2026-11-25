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
 * The Toggl exporter: one timesheet entry becomes one Toggl time entry. The `toggl` entry of
 * `EXPORT_ADAPTERS`.
 *
 * `timesheet-export.ts` owns everything around this: the connection, the token in the keychain, the
 * sent rows that skip an entry by its external id, the timeout and the cap on failures. This file
 * owns the address, the two calls, the body, and the sentence each refusal leaves on the entry.
 *
 * LOOK BEFORE POSTING. The export loop writes the sent row after the post returns, so a timeout
 * after Toggl accepted an entry reads as a failure and the next press would post the same hours
 * again. The `ExportAdapter` contract hands that case to this file. So every post starts with a read
 * of the token owner's entries on that day, and an entry Toggl already holds is answered with its id
 * and not posted. Toggl has no field for somebody else's id, and a tag per entry would fill the
 * workspace with tags nobody made, so the entry is recognised by what this file wrote: the
 * workspace, the start to the second, the duration and the description. A person who edited one of
 * those in Toggl gets a second entry only after a failed press, never after a press that worked,
 * because a sent row is skipped before this file is asked.
 *
 * NOT RECORDED. Toggl has never answered this project. Every path, header, field and status below is
 * written from Toggl's API v9 documentation, and every body in the test file beside this one is
 * written by hand from the same. A first real call has to confirm:
 *  1. That `POST /api/v9/workspaces/{workspace_id}/time_entries` creates one entry and answers 200
 *     with that entry as a JSON object whose `id` is a number.
 *  2. That the API token goes in as Basic auth with `<token>:api_token`.
 *  3. The body: `created_with` is required, `workspace_id` is a number, `start` is an RFC 3339 time
 *     in UTC, `duration` is in seconds, and a positive duration with no `stop` makes a finished
 *     entry. `description` and `project_id` go in under those names.
 *  4. That `GET /api/v9/me/time_entries?start_date=<RFC 3339>&end_date=<RFC 3339>` takes full UTC
 *     times and not only bare dates, answers a bare JSON array of the token owner's entries that
 *     start inside that window, and how far back it reaches. An older week may be refused there
 *     with a 400. A bare date would be read in the profile's time zone, which is why the window is
 *     given as times.
 *  5. That each listed row carries `id`, `workspace_id`, `start`, `duration` and `description`
 *     under those names, and that `start` comes back to the second as it was posted.
 *  6. That 401 or 403 is a bad token, 402 is a used up API quota, 404 is a workspace the token
 *     cannot see, and 429 is a rate limit.
 */

export const TOGGL_ORIGIN = 'https://api.track.toggl.com';

/** What Toggl is told made the entry. Its documentation asks every client to say. */
export const TOGGL_CREATED_WITH = 'Nolzu';

// A Toggl id as a person copies it out of an address: digits only, and never 0.
const ID = /^[1-9]\d{0,15}$/;

/** The workspace an entry goes into. A connection without one is refused before any call. */
export const togglWorkspace = (settings: Record<string, unknown>): number => Number(requiredId('Toggl', settings, 'workspace', ID));

/** The Toggl project, which is optional: an entry without one still lands in the workspace. */
export function togglProject(settings: Record<string, unknown>): number | null {
  const project = idSetting('Toggl', settings, 'project', ID);
  return project === null ? null : Number(project);
}

/** The card key first, so a person can find the card, then the title the grid drew. */
export const togglDescription = (entry: TimesheetEntry): string => `${entry.card} ${entry.title}`;

/** The body of one post. Nothing in it comes from the token or the connection row but the ids. */
export function togglBody(entry: TimesheetEntry, workspace: number, project: number | null): Record<string, unknown> {
  const second = entrySecond(entry.start);
  return {
    created_with: TOGGL_CREATED_WITH,
    workspace_id: workspace,
    start: new Date(second * 1000).toISOString(),
    duration: entry.minutes * 60,
    description: togglDescription(entry),
    ...(project === null ? {} : { project_id: project }),
  };
}

/**
 * The read that looks for an entry before it is posted: the token owner's entries from a day before
 * its start to a day after. Given as UTC times, because a bare date is a day in the profile's time
 * zone and an entry near midnight would fall outside it. The match is on the exact second, so the
 * wider window finds nothing extra.
 */
export function togglDayPath(start: string): string {
  const at = entrySecond(start) * 1000;
  return `/api/v9/me/time_entries?${new URLSearchParams({ start_date: utcSecond(at - DAY_MS), end_date: utcSecond(at + DAY_MS) })}`;
}

export const togglPostPath = (workspace: number): string => `/api/v9/workspaces/${workspace}/time_entries`;

/** The sentence one refused call leaves on the entry. One per status, because each fix differs. */
export function togglRefusal(status: number, body: string, secrets: string[] = []): string {
  if (isHtml(body)) return webPage('Toggl');
  if (status === 401 || status === 403) {
    return 'Toggl refused the API token, so the entry was not sent. Copy the API token from your Toggl profile and save the Toggl connection again.';
  }
  if (status === 402) {
    return 'Toggl says this workspace has used up its API quota, so the entry was not sent. Export again when the quota resets.';
  }
  if (status === 404) {
    return 'Toggl does not know that workspace, or the token cannot see it, so the entry was not sent. Check the workspace on the Toggl connection.';
  }
  if (status === 429) return 'Toggl is rate limiting this API token, so the entry was not sent. Export again in a minute.';
  if (status >= 500) return `Toggl answered ${status}, so the entry was not sent. Export again later.`;
  return `Toggl refused the entry with ${status}, so it was not sent.${detail('Toggl', body, secrets)}`;
}

/** One call on api.track.toggl.com, with the token in the one header that carries it. */
function askToggl(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body: string | undefined,
  signal: AbortSignal,
  fetcher?: ExportFetch,
): Promise<string> {
  const header = btoa(`${token}:api_token`);
  return callDestination(
    { label: 'Toggl', origin: new URL(TOGGL_ORIGIN), headers: { authorization: `Basic ${header}` }, secrets: [token, header], refusal: togglRefusal, fetcher },
    method,
    path,
    body,
    signal,
  );
}

// Toggl's ids are numbers. A string of digits is read the same way, and anything else is no id.
const idOf = (value: unknown): string | null =>
  (typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && ID.test(value)) ? String(value) : null;

/**
 * The id of the entry Toggl already holds for this one, or null when it holds none.
 *
 * An answer that is not a list is refused and never read as an empty day, because an empty day is
 * what lets the post go ahead, and a misread one posts the hours a second time. The same goes for a
 * list whose rows carry no start or duration this file can read: a field name written from the
 * documentation is wrong on every row at once, so that is refused as well. A row with this entry's
 * start and duration is refused too when its workspace, description or id cannot be read, because
 * passing over it would post the hours again.
 */
export function findTogglEntry(body: string, entry: TimesheetEntry, workspace: number): string | null {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error('Toggl answered the day with something Nolzu could not read, so the entry was not sent.');
  }
  if (!Array.isArray(rows)) {
    throw new Error('Toggl answered the day with something that is not a list of entries, so the entry was not sent.');
  }
  const second = startSecond(entry.start);
  const description = togglDescription(entry);
  let readable = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const one = row as Record<string, unknown>;
    const start = typeof one.start === 'string' ? startSecond(one.start) : null;
    if (start === null || typeof one.duration !== 'number') continue;
    readable += 1;
    if (start !== second || one.duration !== entry.minutes * 60) continue;
    // Toggl sends null for an entry with no description. A missing field is a renamed one.
    if (typeof one.workspace_id !== 'number' || !(typeof one.description === 'string' || one.description === null)) {
      throw new Error(
        'Toggl holds an entry at the same time on that day and Nolzu could not read its workspace or description, so the entry was not sent. Nolzu is reading the answer wrongly.',
      );
    }
    if (one.workspace_id !== workspace || one.description !== description) continue;
    const id = idOf(one.id);
    if (id === null) throw new Error('Toggl already holds this entry and Nolzu could not read its id, so the entry was not sent again.');
    return id;
  }
  if (rows.length > 0 && readable === 0) {
    throw new Error(
      `Toggl answered ${rows.length === 1 ? 'one entry' : `${rows.length} entries`} on that day and Nolzu could read the time on none of them, so the entry was not sent. Nolzu is reading the answer wrongly.`,
    );
  }
  return null;
}

/**
 * Posts one entry to Toggl and answers with the id Toggl gave it.
 *
 * The fetcher is the last parameter and optional, so this function is itself the adapter
 * `EXPORT_ADAPTERS` holds and a test still drives every call by hand.
 *
 * Limit: one read and one post per entry, so a week of twenty entries is forty calls. One read per
 * day would do, and the `ExportAdapter` contract gives this file one entry at a time. If Toggl's
 * quota bites, the upgrade is a batch seam on the contract, not a cache in here.
 */
export async function exportToggl(
  entry: TimesheetEntry,
  secret: string,
  settings: Record<string, unknown>,
  signal: AbortSignal,
  fetcher?: ExportFetch,
): Promise<string | null> {
  const workspace = togglWorkspace(settings);
  const project = togglProject(settings);
  const body = JSON.stringify(togglBody(entry, workspace, project));

  const day = await askToggl(secret, 'GET', togglDayPath(entry.start), undefined, signal, fetcher);
  const held = findTogglEntry(day, entry, workspace);
  if (held !== null) return held;

  const posted = await askToggl(secret, 'POST', togglPostPath(workspace), body, signal, fetcher);
  let id: string | null = null;
  try {
    id = idOf((JSON.parse(posted) as { id?: unknown } | null)?.id);
  } catch {
    // Read as no id below.
  }
  if (id === null) {
    // Toggl said yes and this file cannot read what it made. Answering null would mark the entry
    // sent on a guess. Thrown, it is marked failed, and the next press finds it by the read above
    // before it posts anything.
    throw new Error(
      'Toggl answered the post with something Nolzu could not read, so the entry is not marked as sent. The next export looks for it in Toggl before it posts again.',
    );
  }
  return id;
}
