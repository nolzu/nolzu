import { basicAuth, siteOrigin } from '@nolzu/core';
import type { TimesheetEntry } from '@nolzu/protocol';
import { DAY_MS, ExportSkipped, type ExportFetch, callDestination, detail, entrySecond, isHtml, startSecond, webPage } from './timesheet-call.ts';

/**
 * The Jira worklog exporter: one timesheet entry becomes one worklog on the card's Jira issue. The
 * `jira` entry of `EXPORT_ADAPTERS`, with the same contract as `exportToggl`. It is not the Jira
 * ticket reader in `@nolzu/runner` and shares no token with it: that one reads issues with the
 * `jira-token` entry, and this one writes hours with the token a person saved for exporting.
 *
 * ONLY A JIRA CARD. An entry whose card came from Jira goes to the issue with that key. Every other
 * entry is skipped with its reason, never posted: a local key is spelled like a Jira key, and
 * posting on the spelling alone would put a person's hours on a stranger's issue. An entry with no
 * source is a card that is gone, and is skipped too.
 *
 * LOOK BEFORE POSTING, for the reason the Toggl file gives. Jira keeps properties on a worklog, so
 * every worklog goes in carrying Nolzu's external id under the property `nolzu`, and every post
 * starts with a read of that issue's worklogs around the start, properties included, for it.
 *
 * NOT RECORDED. No Jira site has ever answered this exporter. Every path, header, field and status
 * below is written from the Jira Cloud REST API v3 documentation, and every body in the test file
 * beside this one is written by hand from the same. A first real call has to confirm:
 *  1. That `POST /rest/api/3/issue/{key}/worklog?notifyUsers=false` adds one worklog and answers 201
 *     with it as a JSON object whose `id` is a string of digits, and that `notifyUsers=false` is
 *     allowed for a person who is not a Jira admin.
 *  2. That Basic auth with the account email and the API token is taken, the same as the ticket read.
 *  3. The body: `started` as `2026-03-02T14:00:00.000+0000`, `timeSpentSeconds`, `comment` as an
 *     Atlassian document, and `properties` as a list of `key` and `value`.
 *  4. That `GET /rest/api/3/issue/{key}/worklog?startedAfter=<ms>&startedBefore=<ms>&expand=properties`
 *     answers an object whose `worklogs` is a list and whose `total` counts them all, and that each
 *     worklog carries `id` and `properties` under those names, an empty list when it has none.
 *  5. That 401 is a bad token, 403 an issue the account may not log work on, 404 an issue that is
 *     gone or hidden from the account, 400 a refused field with `errorMessages` or `errors`, and 429
 *     a rate limit.
 */

/** The worklog property that carries Nolzu's external id. */
export const JIRA_PROPERTY = 'nolzu';

// A Jira issue key: a project key, a dash, and a number that is never 0.
const KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

const MAX_WORKLOGS = 5000;

/**
 * The issue an entry goes to, or `ExportSkipped` with the reason. Thrown before any call and before
 * the connection is read, so a local card costs nothing.
 */
export function jiraIssue(entry: TimesheetEntry): string {
  if (entry.source === null) {
    throw new ExportSkipped(`The card ${entry.card} is gone, so Nolzu cannot tell whether it is a Jira issue and did not send its hours to Jira.`);
  }
  if (entry.source !== 'jira') throw new ExportSkipped(`${entry.card} is not a Jira issue, so its hours were not sent to Jira.`);
  if (!KEY.test(entry.card)) throw new Error(`${entry.card} came from Jira and is not a Jira issue key, so the entry was not sent.`);
  return entry.card;
}

function textSetting(settings: Record<string, unknown>, name: string, says: string): string {
  const value = settings[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`This Jira connection names no ${says}, so the entry was not sent. Save the Jira connection again with it.`);
  }
  return value.trim();
}

/** Jira's own time form: milliseconds and a zone with no colon. It refuses a bare Z. */
export const jiraStarted = (second: number): string => new Date(second * 1000).toISOString().replace('Z', '+0000');

/** The body of one worklog. The comment is the title, because the issue already says the card. */
export function jiraBody(entry: TimesheetEntry): Record<string, unknown> {
  return {
    started: jiraStarted(entrySecond(entry.start)),
    timeSpentSeconds: entry.minutes * 60,
    comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: entry.title }] }] },
    properties: [{ key: JIRA_PROPERTY, value: { externalId: entry.externalId } }],
  };
}

const worklogPath = (key: string): string => `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`;

/** The read that looks for a worklog before it is posted: a day either side of its start. */
export function jiraDayPath(key: string, start: string): string {
  const at = entrySecond(start) * 1000;
  const window = new URLSearchParams({
    startedAfter: String(at - DAY_MS),
    startedBefore: String(at + DAY_MS),
    expand: 'properties',
    maxResults: String(MAX_WORKLOGS),
  });
  return `${worklogPath(key)}?${window}`;
}

/** The sentence one refused call leaves on the entry. One per status, because each fix differs. */
export function jiraRefusal(status: number, body: string, secrets: string[] = []): string {
  if (isHtml(body)) return webPage('Jira');
  if (status === 401) {
    return 'Jira refused the API token, so the entry was not sent. Create an API token for the account email and save the Jira connection again.';
  }
  if (status === 403) {
    return 'Jira says this account may not log work on that issue, so the entry was not sent. Check the account on the Jira connection.';
  }
  // Jira answers a refused token with the same 404 as a missing issue, so the sentence names both.
  if (status === 404) {
    return 'Jira does not show that issue to this account, so the entry was not sent. The issue may be gone, or the email or API token on the Jira connection is wrong.';
  }
  if (status === 429) return 'Jira is rate limiting this API token, so the entry was not sent. Export again in a minute.';
  if (status >= 500) return `Jira answered ${status}, so the entry was not sent. Export again later.`;
  return `Jira refused the worklog with ${status}, so it was not sent.${detail('Jira', body, secrets)}`;
}

// Jira's ids are strings of digits.
const idOf = (value: unknown): string | null =>
  (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)) || (typeof value === 'number' && Number.isInteger(value) && value > 0) ? String(value) : null;

/**
 * The id of the worklog Jira already holds for this entry, or null when it holds none.
 *
 * A worklog at the same start and length with no `nolzu` property is refused, because that is what
 * this entry looks like if Jira did not keep the property. An answer with no list of worklogs is
 * refused, and so is a list in which no worklog carries a list of properties, because that is the
 * expand being ignored and every match would be missed. So is a `total` larger than the list,
 * because the worklog could be past the part that came back.
 */
export function findJiraWorklog(body: string, entry: TimesheetEntry): string | null {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    throw new Error('Jira answered the worklogs with something Nolzu could not read, so the entry was not sent.');
  }
  const page = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const rows = page.worklogs;
  if (!Array.isArray(rows)) throw new Error('Jira answered the worklogs with something that is not a list, so the entry was not sent.');
  let readable = 0;
  let unmarked = false;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const one = row as Record<string, unknown>;
    if (!Array.isArray(one.properties)) continue;
    readable += 1;
    const ours = one.properties.find(
      (property: unknown) => property !== null && typeof property === 'object' && (property as { key?: unknown }).key === JIRA_PROPERTY,
    ) as { value?: unknown } | undefined;
    if (ours === undefined) {
      // The same start and length with no property of ours: a worklog of ours whose property Jira
      // did not keep looks exactly like this, and passing over it would log the hours twice.
      unmarked ||=
        typeof one.started === 'string' && startSecond(one.started) === entrySecond(entry.start) && one.timeSpentSeconds === entry.minutes * 60;
      continue;
    }
    const value = ours.value;
    if (value === null || typeof value !== 'object' || (value as { externalId?: unknown }).externalId !== entry.externalId) continue;
    const id = idOf(one.id);
    if (id === null) throw new Error('Jira already holds this worklog and Nolzu could not read its id, so the entry was not sent again.');
    return id;
  }
  if (unmarked) {
    throw new Error(
      'Jira holds a worklog with the same start and length and without the Nolzu property, so the entry was not sent. It may be this one with its property dropped.',
    );
  }
  if (rows.length > 0 && readable === 0) {
    throw new Error(
      'Jira answered the worklogs without their properties, so Nolzu could not tell whether it already holds this one and did not send it. Nolzu is reading the answer wrongly.',
    );
  }
  if (typeof page.total === 'number' && page.total > rows.length) {
    throw new Error('Jira holds more worklogs around that day than one read returns, so Nolzu could not tell whether it already holds this one and did not send it.');
  }
  return null;
}

/**
 * Posts one entry as a worklog on its Jira issue and answers with the id Jira gave it.
 *
 * The connection settings are `site` and `email`, the same two a Jira ticket query keeps, and the
 * token is the API token of that email.
 */
export async function exportJira(
  entry: TimesheetEntry,
  secret: string,
  settings: Record<string, unknown>,
  signal: AbortSignal,
  fetcher?: ExportFetch,
): Promise<string | null> {
  const key = jiraIssue(entry);
  const origin = siteOrigin(textSetting(settings, 'site', 'Jira site address'));
  const authorization = basicAuth(textSetting(settings, 'email', 'account email'), secret);
  const to = { label: 'Jira', origin, headers: { authorization }, secrets: [secret, authorization.slice('Basic '.length)], refusal: jiraRefusal, fetcher };

  const held = findJiraWorklog(await callDestination(to, 'GET', jiraDayPath(key, entry.start), undefined, signal), entry);
  if (held !== null) return held;

  const body = JSON.stringify(jiraBody(entry));
  const posted = await callDestination(to, 'POST', `${worklogPath(key)}?notifyUsers=false`, body, signal, 201);
  let id: string | null = null;
  try {
    id = idOf((JSON.parse(posted) as { id?: unknown } | null)?.id);
  } catch {
    // Read as no id below.
  }
  if (id === null) {
    throw new Error(
      'Jira answered the worklog with something Nolzu could not read, so the entry is not marked as sent. The next export looks for it in Jira before it posts again.',
    );
  }
  return id;
}
