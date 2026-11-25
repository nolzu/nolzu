import { accountRefused, issuePath, JIRA_KEY, JIRA_PROJECT, JIRA_TOKEN_REFUSED, type JiraAnswer, type JiraIssue, readIssue, refusalSays, searchPath, ticketFrom, tokenRefused } from '@nolzu/core';
import type { Ticket, TicketAdapter, TicketQuery, TicketRef, TicketResult } from '@nolzu/protocol';

/**
 * The Jira adapter, over the REST API of a Jira Cloud site.
 *
 * Read-only, the rule for every ticket adapter in the free client. Nothing here transitions an
 * issue, writes a comment or logs work.
 *
 * The paths, the refusal sentences and everything that turns a body into a `Ticket` are in
 * `@nolzu/core`, so the server reads the same answer the same way. What is left here is the order
 * of the calls: which status throws, which one is a ticket that is gone, and when the next page is
 * asked for.
 */

/**
 * How one call is made. A GET and a path, and nothing else, because nothing here writes to Jira.
 *
 * The condition the implementation has to keep and this file cannot: the API token goes into the
 * Authorization header and never into the path, so a path that reaches a log carries no secret.
 */
export type CallJira = (path: string, signal: AbortSignal) => Promise<JiraAnswer>;

// A stop, so a site that keeps answering `isLast: false` with no rows cannot spin forever.
const MAX_PAGES = 10;

export function jiraIssues(call: CallJira): TicketAdapter {
  const refused = (answer: JiraAnswer, what: string): Error =>
    new Error(`Jira refused ${what}. ${refusalSays(answer.body) ?? `It answered ${answer.status}.`}`);

  return {
    name: 'jira',
    // The name a person reads, because `name` is an id and goes into the card row as one.
    title: 'Jira',

    /**
     * One result per ref, in the order they came.
     *
     * A caller that sends several refs and matches them back by position would otherwise put the
     * wrong ticket on the wrong card. A ref this adapter cannot read answers `notFound: false`:
     * nothing was asked, so nothing is known.
     *
     * Limit: one call per key. Jira has no batch read of arbitrary keys, and the recorded read
     * covers the single issue endpoint only. A JQL `key in (...)` search would fold many into one
     * call, and that is worth writing when a caller starts sending many.
     */
    async get(refs: readonly TicketRef[], signal: AbortSignal): Promise<readonly TicketResult[]> {
      return Promise.all(
        refs.map(async (ref): Promise<TicketResult> => {
          if (ref.kind !== 'external' || !JIRA_KEY.test(ref.key)) return { ref, ticket: null, notFound: false };

          const answer = await call(issuePath(ref.key), signal);
          // Before the status, because the status is 404 and a 404 read alone is the trap.
          if (tokenRefused(answer.headers)) throw new Error(JIRA_TOKEN_REFUSED);
          // A refusal, not a ticket. It is the same answer for every ref and it needs a fix from
          // the person, so it throws the way a refused token does.
          if (answer.status === 401 || answer.status === 403) throw new Error(accountRefused(answer.status));
          // The site answered and the issue is not there, the project is not there, or this account
          // cannot see it. All three read as not found, which is what a person can act on.
          if (answer.status === 404) return { ref, ticket: null, notFound: true };
          // A rate limit, a server error, a proxy page. Not found would be a claim, and a caller
          // that believed it would put a card on the board for a ticket nobody read.
          if (answer.status !== 200) return { ref, ticket: null, notFound: false };
          return { ref, ticket: readIssue(answer.body), notFound: false };
        }),
      );
    },

    /**
     * The open tickets of the projects named in `repos`, which for Jira are project keys.
     *
     * This throws where `get` stays quiet. A search that answers nothing reads as "this project has
     * no tickets", and a refused token or a refused query would then look like an empty backlog.
     */
    async search(query: TicketQuery, signal: AbortSignal): Promise<readonly Ticket[]> {
      const terms = (query.terms ?? '').trim();
      const projects = query.repos.filter((name) => JIRA_PROJECT.test(name));
      // A query of the person's own names its own projects, so none has to be given here.
      if (projects.length === 0 && terms === '') {
        // Names were given and none of them is a project key, so nothing was asked. An empty list
        // would answer a question the site never got.
        if (query.repos.length > 0) {
          throw new Error(`Jira reads a project by its key, such as PROJ. None of these is one: ${query.repos.join(', ')}.`);
        }
        return [];
      }

      const found: Ticket[] = [];
      let after: string | null = null;
      for (let page = 0; found.length < query.limit; page += 1) {
        if (page === MAX_PAGES) {
          // Stopping quietly would hand back a part of the list, and the caller would read it as
          // all of it.
          throw new Error(`Jira kept offering more pages after ${MAX_PAGES}, so Nolzu stopped before it had the whole list.`);
        }
        const answer = await call(searchPath(projects, query.limit - found.length, after, terms), signal);
        if (tokenRefused(answer.headers)) throw new Error(JIRA_TOKEN_REFUSED);
        if (answer.status === 401 || answer.status === 403) throw new Error(accountRefused(answer.status));
        if (answer.status !== 200) throw refused(answer, 'the search');

        let body: { issues?: unknown[]; nextPageToken?: string; isLast?: boolean };
        try {
          body = JSON.parse(answer.body) as typeof body;
        } catch {
          throw new Error('Jira answered the search with something Nolzu could not read.');
        }
        // Not `issues ?? []`. A 200 that parses but carries no list of issues would otherwise read as
        // a project with no tickets, which is the bug the Linear adapter was written against.
        if (!Array.isArray(body.issues)) {
          throw new Error('Jira answered the search without a list of issues, so nothing was read. Nolzu does not read that as an empty project.');
        }
        for (const row of body.issues) {
          const ticket = ticketFrom(row as JiraIssue);
          // The JQL already asks for the open ones. This is the same rule on the row that came
          // back, so a site that answered something else does not put a closed ticket on a board.
          if (ticket !== null && ticket.state === 'open' && found.length < query.limit) found.push(ticket);
        }
        after = body.isLast === true ? null : (body.nextPageToken ?? null);
        if (after === null) break;
      }
      return found;
    },
  };
}
