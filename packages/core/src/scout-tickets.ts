/**
 * The adapter behind the ticket query: what to ask a ticket system, and what its answer becomes.
 *
 * Two halves, both pure and both synchronous, the way `scout-paste.ts` is. `ticketPlan` turns the
 * settings a person saved into the query one of four systems takes. `fetchTickets` takes the rows
 * that came back and folds them into items. So the calls stay in the packages that may make them,
 * this machine and Nolzu cloud derive the same query from the same settings, and everything the
 * fingerprint depends on is testable with no process and no socket.
 */

import type { FailedRun, ScoutSourceKind, Ticket, TicketQuery } from '@nolzu/protocol';
import { type JiraSite, siteOrigin } from './jira-site.ts';
import type { ScoutItem } from './scout.ts';

// Pinned to the kind list, the same way the paste adapter pins its own. This kind is the prefix of
// every finding id both ticket systems make, so a rename later is a data migration, not an edit.
const TICKETS: ScoutSourceKind = 'tickets';

// The cursor is these ids with a space between them. A ticket key is `app#42` or `PROJ-123` and a
// run id is digits, so no id can hold the separator and no split can go wrong.
const SEPARATOR = ' ';

// What a failed run is called in the cursor, so a run id can never be read as a ticket key.
const runId = (id: number): string => `ci:${id}`;

/**
 * The ticket one item is about, or null where the item is no ticket.
 *
 * It lives here because this file is the only one that writes `sourceId` on a ticket, and a reader
 * that guessed from the stored line would have to tell `PROJ-123` from `acme/app@main`, which a
 * failed run writes into the same field. A run carries no `sourceId`, so it answers null.
 */
export const ticketKeyOf = (item: ScoutItem): string | null =>
  item.sourceKind === TICKETS && item.sourceId !== undefined && item.sourceId !== '' ? item.sourceId : null;

export interface TicketFetch {
  items: ScoutItem[];
  /**
   * The ids this query answered with, sorted, or null when it answered nothing.
   *
   * Rebuilt from the answer on every check rather than added to, so it stays as short as the page
   * the caller asked for and a ticket that has been closed drops out of it. A person can read it:
   * `migrations.ts` promises the column is short text and not a blob.
   *
   * Limit: a query whose backlog is longer than the caller's limit rotates ids in and out of the
   * page, and an id that rotated out is reported again when it comes back. The way out is a store of
   * its own for what has been reported, which is a second findings table in disguise. The limit is
   * the bound, so raise the limit before writing that.
   */
  cursor: string | null;
}

/**
 * One answered query, as the occurrences behind it.
 *
 * A ticket is not an event stream: it exists once and a check meets it once. So the cursor holds
 * what the last check reported, and only an id that is not in it becomes an item. Without that, every
 * check would add one to the occurrence count of every open ticket, and both lists on the Scout
 * screen are ordered by the time a finding was last seen.
 *
 * The first check, with no cursor, therefore reports the whole page the caller asked for. The page
 * is what bounds it: a backlog of five hundred tickets becomes as many findings as the caller's
 * limit, and the next check adds only what came in since.
 *
 * A ticket sets `sourceId` to its own key, so the fingerprint is the key and a reworded title keeps
 * the finding it already has. A failed run sets none: its id changes on every run, so the run number
 * would give one finding per run. Without an id the fingerprint is built from `errorType`, the
 * message and the location, which are the workflow and the branch, so one workflow that keeps
 * failing is one finding with a count.
 */
export function fetchTickets(tickets: readonly Ticket[], runs: readonly FailedRun[], cursor: string | null): TicketFetch {
  const reported = new Set(cursor === null || cursor === '' ? [] : cursor.split(SEPARATOR));
  const items: ScoutItem[] = [];
  const ids: string[] = [];

  for (const ticket of tickets) {
    ids.push(ticket.key);
    if (reported.has(ticket.key)) continue;
    items.push({
      sourceKind: TICKETS,
      errorType: '',
      // The title alone. A ticket whose title is empty would leave a finding with nothing to read
      // on it, so the key stands in.
      message: ticket.title === '' ? ticket.key : ticket.title,
      location: ticket.key,
      sourceId: ticket.key,
    });
  }

  for (const run of runs) {
    const id = runId(run.id);
    ids.push(id);
    if (reported.has(id)) continue;
    items.push({
      sourceKind: TICKETS,
      errorType: 'ci',
      message: `${run.workflow} failed on ${run.branch}`,
      // Part of the fingerprint, because a run carries no `sourceId`. So it holds the repository and
      // the branch and nothing that changes per run: a run number or a run address here would give
      // a finding per run.
      location: `${run.repo}@${run.branch}`,
    });
  }

  ids.sort();
  return { items, cursor: ids.length === 0 ? null : ids.join(SEPARATOR) };
}

/**
 * How many tickets one check reads, and how many failed runs.
 *
 * The bound on the first check of a real backlog. Thirty findings on the first press is a list a
 * person can read; the adapter would allow a hundred, and a person who presses a button does not
 * expect a hundred new rows.
 *
 * It is also what keeps `gh` inside its own cap. `gh` drops an answer over 4,000,000 characters
 * whole, and GitHub allows 65,536 characters in one issue body, so a hundred bodies can pass the cap
 * and thirty cannot: 30 times 65,536 is under 2,000,000.
 *
 * Limit: not a setting. The source form collects no limit, and a field added to a source form
 * becomes required on every save. Make it a setting when somebody asks for a different number.
 */
export const SCOUT_TICKET_LIMIT = 30;
export const SCOUT_CI_LIMIT = 20;

const OWNER_REPO = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/**
 * The team keys a person typed, as the adapter takes them.
 *
 * Commas or spaces, because both are how a person writes a short list. Upper case, because a Linear
 * team key is upper case and the case somebody typed is not worth a refusal.
 */
const teamKeys = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .filter((one) => one !== '')
    .map((one) => one.toUpperCase());

/**
 * What one ticket source is asked for, per system.
 *
 * `query` is what the system's own adapter takes, so a caller hands it over and adds nothing. GitHub
 * carries `owner` and `repo` beside it, which are the same name split in two, because the CI read
 * takes the halves and the issue search takes the whole. GitLab carries no `query`, because `glab`
 * takes the project, the search and the page one by one.
 */
export type TicketPlan =
  | { system: 'github'; owner: string; repo: string; query: TicketQuery; ciLimit: number }
  | { system: 'gitlab'; project: string; terms: string | undefined; limit: number }
  | { system: 'jira'; site: JiraSite; query: TicketQuery }
  | { system: 'linear'; query: TicketQuery };

/**
 * The settings a person saved, as the query their system answers.
 *
 * Every check of a ticket source starts here, on this machine and on the server, so the two cannot
 * ask GitHub two different questions from one saved source. It reaches nothing: no process, no
 * socket, no keychain, no database. That is also what makes it the right place for the cheap checks.
 * A repository that is not `owner/repo`, a site address that is not https and a teams field that
 * holds no key are all refused here, and the caller reads a keychain only after this has answered.
 * A keychain read can put an OS password dialog in front of the person, and a typo must not cost
 * them that.
 *
 * The four systems and their settings keys are the ones the Scout source forms collect. A stored
 * system this version does not know is what a source added by a later version looks like after a
 * downgrade, so the last sentence says what to do about it.
 */
export function ticketPlan(config: Readonly<Record<string, string>>): TicketPlan {
  const system = config.system ?? '';
  if (system === 'github') {
    const named = OWNER_REPO.exec(config.repo ?? '');
    if (named === null) {
      throw new Error(`${config.repo ?? 'The repository'} is not a repository name. Open the source on the Scout page and write it as owner/repo, such as acme/app.`);
    }
    return {
      system,
      owner: named[1] ?? '',
      repo: named[2] ?? '',
      query: { limit: SCOUT_TICKET_LIMIT, repos: [config.repo ?? ''], terms: config.query },
      ciLimit: SCOUT_CI_LIMIT,
    };
  }
  if (system === 'gitlab') {
    // The project path is not checked here. `glab` is asked for a path and the GitLab adapter already
    // refuses one that is not a path, with a sentence of its own.
    return { system, project: config.project ?? '', terms: config.query, limit: SCOUT_TICKET_LIMIT };
  }
  if (system === 'jira') {
    const site = config.site ?? '';
    // Thrown away: this call is here for what it refuses, and every caller builds its own origin.
    siteOrigin(site);
    // No project keys: this form collects a query and not a project, so the query names its own.
    return { system, site: { url: site, email: config.email ?? '' }, query: { limit: SCOUT_TICKET_LIMIT, repos: [], terms: config.jql } };
  }
  if (system === 'linear') {
    // A field of commas alone passes the form, because the form only refuses an empty one. The
    // adapter would then read no team, make no call, and the check would stamp the source green.
    const teams = teamKeys(config.teams ?? '');
    if (teams.length === 0) {
      throw new Error(`"${config.teams ?? ''}" holds no Linear team key. Open the source on the Scout page and write them as PROJ, OPS.`);
    }
    // No terms: this form collects team keys and nothing else, because Linear has no query language.
    return { system, query: { limit: SCOUT_TICKET_LIMIT, repos: teams } };
  }
  throw new Error(`This version does not know the ticket system "${system}". Remove the source on the Scout page and add it again as GitHub, GitLab, Jira or Linear.`);
}
