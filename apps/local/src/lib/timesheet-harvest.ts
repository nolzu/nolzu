import type { TimesheetEntry } from '@nolzu/protocol';
import { callDestination, detail, type ExportFetch, isHtml, requiredId, webPage } from './timesheet-call.ts';

/**
 * The Harvest exporter: one timesheet entry becomes one Harvest time entry. The `harvest` entry of
 * `EXPORT_ADAPTERS`, with the same contract as `exportToggl`.
 *
 * LOOK BEFORE POSTING, for the reason the Toggl file gives: a timeout after Harvest took an entry
 * reads as a failure here, and the next press would bill the hours again. Harvest has a field for
 * somebody else's id, `external_reference`, so every entry goes in carrying Nolzu's external id and
 * every post starts with a read of that day for it. That is the skip by external id, done at the
 * destination as well as in the sent rows. The read is the whole day and not Harvest's own filter on
 * the reference: if Harvest drops the reference, the filter would hide the entry and the hours would
 * be posted again, while the whole day still shows it and the same day, hours and notes refuse.
 *
 * A DAY, NOT AN INSTANT. Harvest keeps a time entry as a date and hours, so the date sent is the UTC
 * day the grid drew the cell under, and the entry's start is not sent.
 *
 * NOT RECORDED. Harvest has never answered this project. Every path, header, field and status below
 * is written from Harvest's API v2 documentation, and every body in the test file beside this one is
 * written by hand from the same. A first real call has to confirm:
 *  1. That `POST /v2/time_entries` creates one entry and answers 201 with that entry as a JSON object
 *     whose `id` is a number.
 *  2. The headers: `Authorization: Bearer <token>`, `Harvest-Account-Id: <account>`, and a
 *     `User-Agent` naming the app, which Harvest asks every client to send.
 *  3. The body: `project_id`, `task_id`, `spent_date` as YYYY-MM-DD, `hours` as a decimal, `notes`,
 *     and `external_reference` as an object with an `id`. That a personal token may set
 *     `external_reference` at all, and that `hours` is taken on an account set to track time with
 *     start and end times. A fraction such as a third of an hour is sent as it is.
 *  4. That `GET /v2/time_entries?from=<day>&to=<day>&per_page=2000` answers an object whose
 *     `time_entries` is a list of that day's entries, with `next_page` null on the last page.
 *  5. That each listed row carries `id`, `spent_date`, `hours`, `notes` and `external_reference.id`
 *     under those names.
 *  6. That 401 is a bad token, 403 a token that cannot use that account, 404 a project or task the
 *     token cannot see, 422 a refused field with a `message`, and 429 a rate limit.
 */

export const HARVEST_ORIGIN = 'https://api.harvestapp.com';

/** Who Harvest is told is calling. Its documentation asks every client for a name and a contact. */
export const HARVEST_USER_AGENT = 'Nolzu (https://nolzu.com)';

// A Harvest id: digits only, and never 0. The project and task ids are in their addresses in
// Harvest, and the account id is on the developers page where the token is made.
const ID = /^[1-9]\d{0,15}$/;

/** The three ids a Harvest connection needs. All three are refused before any call when missing. */
export function harvestIds(settings: Record<string, unknown>): { account: string; project: number; task: number } {
  return {
    account: requiredId('Harvest', settings, 'account', ID, 'the Harvest developers page, where the token was made'),
    project: Number(requiredId('Harvest', settings, 'project', ID)),
    task: Number(requiredId('Harvest', settings, 'task', ID)),
  };
}

/** The card key first, so a person can find the card, then the title the grid drew. */
export const harvestNotes = (entry: TimesheetEntry): string => `${entry.card} ${entry.title}`;

/** The body of one post. Nothing in it comes from the token. */
export function harvestBody(entry: TimesheetEntry, project: number, task: number): Record<string, unknown> {
  return {
    project_id: project,
    task_id: task,
    spent_date: entry.day,
    hours: entry.minutes / 60,
    notes: harvestNotes(entry),
    external_reference: { id: entry.externalId },
  };
}

/** The read that looks for an entry before it is posted: that whole day, on one page. */
export const harvestDayPath = (entry: TimesheetEntry): string =>
  `/v2/time_entries?${new URLSearchParams({ from: entry.day, to: entry.day, per_page: '2000' })}`;

/** The sentence one refused call leaves on the entry. One per status, because each fix differs. */
export function harvestRefusal(status: number, body: string, secrets: string[] = []): string {
  if (isHtml(body)) return webPage('Harvest');
  if (status === 401) {
    return 'Harvest refused the API token, so the entry was not sent. Create a personal access token in Harvest and save the Harvest connection again.';
  }
  if (status === 403) {
    return 'Harvest says this token cannot use that account, so the entry was not sent. Check the account id on the Harvest connection.';
  }
  if (status === 404) {
    return 'Harvest does not know that project or task, or the token cannot see it, so the entry was not sent. Check the Harvest connection.';
  }
  if (status === 429) return 'Harvest is rate limiting this API token, so the entry was not sent. Export again in a minute.';
  if (status >= 500) return `Harvest answered ${status}, so the entry was not sent. Export again later.`;
  return `Harvest refused the entry with ${status}, so it was not sent.${detail('Harvest', body, secrets)}`;
}

// Harvest's ids are numbers. A string of digits is read the same way, and anything else is no id.
const idOf = (value: unknown): string | null =>
  (typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && ID.test(value)) ? String(value) : null;

/**
 * The id of the entry Harvest already holds for this one, or null when it holds none.
 *
 * An answer that is not a list is refused and never read as an empty day, because an empty day is
 * what lets the post go ahead. A row that is this entry by its day, hours and notes but carries no
 * readable reference is refused too: that is a reference Harvest did not keep or a field read under
 * the wrong name, and passing over it would post the hours again. So is a second page, because the
 * entry could be on it.
 */
export function findHarvestEntry(body: string, entry: TimesheetEntry): string | null {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    throw new Error('Harvest answered the day with something Nolzu could not read, so the entry was not sent.');
  }
  const page = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  if (!Array.isArray(page.time_entries)) {
    throw new Error('Harvest answered the day with something that is not a list of time entries, so the entry was not sent.');
  }
  for (const row of page.time_entries) {
    if (row === null || typeof row !== 'object') continue;
    const one = row as Record<string, unknown>;
    const reference = one.external_reference;
    const referenceId = reference !== null && typeof reference === 'object' ? (reference as Record<string, unknown>).id : undefined;
    if (referenceId === entry.externalId) {
      const id = idOf(one.id);
      if (id === null) throw new Error('Harvest already holds this entry and Nolzu could not read its id, so the entry was not sent again.');
      return id;
    }
    const same =
      one.spent_date === entry.day && typeof one.hours === 'number' && Math.abs(one.hours - entry.minutes / 60) < 0.01 && one.notes === harvestNotes(entry);
    if (same && typeof referenceId !== 'string') {
      throw new Error(
        'Harvest holds an entry with the same day, hours and notes and Nolzu could not read its reference, so the entry was not sent. Nolzu is reading the answer wrongly.',
      );
    }
  }
  if (page.next_page !== null && page.next_page !== undefined) {
    throw new Error('Harvest answered the day over more than one page, so Nolzu could not tell whether it already holds the entry and did not send it.');
  }
  return null;
}

/**
 * Posts one entry to Harvest and answers with the id Harvest gave it.
 *
 * The fetcher is the last parameter and optional, so this function is itself the adapter
 * `EXPORT_ADAPTERS` holds and a test still drives every call by hand.
 */
export async function exportHarvest(
  entry: TimesheetEntry,
  secret: string,
  settings: Record<string, unknown>,
  signal: AbortSignal,
  fetcher?: ExportFetch,
): Promise<string | null> {
  const { account, project, task } = harvestIds(settings);
  const to = {
    label: 'Harvest',
    origin: new URL(HARVEST_ORIGIN),
    headers: { authorization: `Bearer ${secret}`, 'harvest-account-id': account, 'user-agent': HARVEST_USER_AGENT },
    secrets: [secret],
    refusal: harvestRefusal,
    fetcher,
  };

  const day = await callDestination(to, 'GET', harvestDayPath(entry), undefined, signal);
  const held = findHarvestEntry(day, entry);
  if (held !== null) return held;

  const body = JSON.stringify(harvestBody(entry, project, task));
  const posted = await callDestination(to, 'POST', '/v2/time_entries', body, signal, 201);
  let id: string | null = null;
  try {
    id = idOf((JSON.parse(posted) as { id?: unknown } | null)?.id);
  } catch {
    // Read as no id below.
  }
  if (id === null) {
    // Harvest said yes and this file cannot read what it made. Thrown, the entry is marked failed,
    // and the next press finds it by its reference before it posts anything.
    throw new Error(
      'Harvest answered the post with something Nolzu could not read, so the entry is not marked as sent. The next export looks for it in Harvest before it posts again.',
    );
  }
  return id;
}
