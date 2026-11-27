import type { DatabaseSync } from 'node:sqlite';
import { ASSIGNED_JQL, JIRA_TOKEN_REFUSED } from '@nolzu/core';
import { getSetting, resolveDataDir } from '@nolzu/core/node';
import { parseTicketRef, type Ticket, type TicketAdapter } from '@nolzu/protocol';
import { createKeychain, ghRunner, githubIssues, issueKey, type RunGh, runKeychain } from '@nolzu/runner';
import { githubOrigins, READ_TIMEOUT_MS } from './create-card.ts';
import { jiraReader, ON_INTEGRATIONS } from './ticket-system.ts';

/**
 * The tickets assigned to the person that have no card in this project yet, for the list in Add card.
 *
 * Read when the dialog opens and never in the background. A press on a row posts its `input` to
 * `/api/cards`, the link or the key a person would paste, so the card is made by `createCardFrom` the
 * same way. A source that fails gives its sentence in `problems` and the other source still answers.
 */

export interface MyTicket {
  key: string;
  title: string;
  // What a press posts as the card's input: a GitHub issue link, or a Jira key.
  input: string;
}

export interface MyTickets {
  // False when the project has no source to ask: no GitHub origin and no Jira.
  asked: boolean;
  tickets: MyTicket[];
  problems: string[];
}

export interface MySources {
  run?: RunGh;
  jira?: () => Promise<TicketAdapter | null>;
}

// How many rows the dialog shows.
export const MINE_SHOWN = 20;
// How many each source is asked for, more than are shown, because the ones with a card are dropped after.
const MINE_ASKED = 100;

export const GITHUB_ASSIGNED = 'assignee:@me';

// One row, with the ref Add card keeps as the card's source, so a card made by hand hides it too.
interface Found extends MyTicket {
  ref: string;
}

// The search names the repository only in the link, so the owner comes from there.
function fromGithub(ticket: Ticket): Found | null {
  const ref = ticket.url === null ? null : parseTicketRef(ticket.url);
  if (ticket.url === null || ref?.kind !== 'github' || ref.owner === null) return null;
  return { key: ticket.key, title: ticket.title, input: ticket.url, ref: issueKey(ref.owner, ref.repo, ref.number) };
}

export async function myTickets(db: DatabaseSync, sources: MySources = {}): Promise<MyTickets> {
  const origins = await githubOrigins(db);
  const jira = getSetting(db, 'ticketSystem') === 'jira';
  if (origins.length === 0 && !jira) return { asked: false, tickets: [], problems: [] };

  const problems: string[] = [];
  const read = async (from: () => Promise<Found[]>): Promise<Found[]> => {
    try {
      return await from();
    } catch (error) {
      // The token sentence sends a Scout source to the Scout page. Here the token is the one Connect Jira saved.
      const said = (error as Error).message;
      problems.push(said === JIRA_TOKEN_REFUSED ? `Jira refused the API token, so your tickets were not read. ${ON_INTEGRATIONS}` : said);
      return [];
    }
  };

  // Limit: one search for every repository. GitHub refuses a query over 256 characters, so a project
  // of about ten repositories or more gets the search's refusal as its sentence.
  const repos = [...new Set(origins.map((one) => `${one.owner}/${one.repo}`))];
  const fromGitHub = () =>
    read(async () => {
      if (repos.length === 0) return [];
      const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
      // Limit: GitHub orders by best match, not by the newest change, so the cap may drop a newer one.
      const found = await githubIssues({ run: sources.run ?? ghRunner(), defaultOwner: null }).search({ repos, terms: GITHUB_ASSIGNED, limit: MINE_ASKED }, signal);
      return found.map(fromGithub).filter((one) => one !== null);
    });
  const fromJira = () =>
    read(async () => {
      if (!jira) return [];
      const adapter = await (sources.jira ?? (() => jiraReader(db, createKeychain(process.platform, runKeychain, resolveDataDir(process.env)))))();
      if (adapter === null) return [];
      const prefix = getSetting(db, 'localKeyPrefix');
      const found = await adapter.search({ repos: [], terms: ASSIGNED_JQL, limit: MINE_ASKED }, AbortSignal.timeout(READ_TIMEOUT_MS));
      // A key with the local prefix reads as a local card, so Add card could not make it a Jira card.
      return found.filter((one) => parseTicketRef(one.key, prefix).kind === 'external').map((one) => ({ key: one.key, title: one.title, input: one.key, ref: one.key }));
    });

  // Jira first: on a Jira project it is where the tickets are, and the cap below cuts from the end.
  const found = (await Promise.all([fromJira(), fromGitHub()])).flat();
  // Every card counts, done ones too. A key held by a card also blocks Add card, which refuses a second card under it.
  const held = new Set((db.prepare('SELECT key, source_ref FROM cards').all() as { key: string; source_ref: string | null }[]).flatMap((one) => [one.key, one.source_ref]));
  const tickets = found
    .filter((one) => !held.has(one.key) && !held.has(one.ref))
    .slice(0, MINE_SHOWN)
    .map(({ key, title, input }) => ({ key, title, input }));
  return { asked: true, tickets, problems };
}
