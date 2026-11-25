import type { Ticket, TicketAdapter, TicketQuery, TicketRef, TicketResult } from '@nolzu/protocol';

/**
 * The Linear adapter, over the GraphQL API at api.linear.app.
 *
 * NOT RECORDED. Every field name, filter name and enum word below is written from Linear's
 * documentation and not from a real answer: no Linear account was used, so no call was
 * ever made. `linear.test.ts` names what a first real call has to confirm, and until
 * somebody records one, treat a Linear ticket as unverified.
 *
 * Read-only, the rule for every ticket adapter in the free client. Nothing here creates an issue,
 * comments on one or moves one.
 *
 * The structure is `jira.ts`: a call seam so a test opens no socket, a mapper into the shared `Ticket`
 * shape, and a refusal that is loud rather than an empty list. The one thing Linear adds is that a
 * refused query comes back as HTTP 200 with an `errors` array, so the status alone says nothing.
 */

// One endpoint for the whole API, unlike Jira, where every customer has their own site. So nothing
// here collects a host and nothing has to check one.
export const LINEAR_API = 'https://api.linear.app/graphql';

export interface LinearAnswer {
  status: number;
  body: string;
}

/**
 * How one call is made. A query document and its variables, and nothing else, because nothing here
 * writes to Linear.
 *
 * The condition the implementation has to keep and this file cannot: the API key goes into the
 * Authorization header and never into the document, the variables or a message, so nothing that
 * reaches a log carries the key.
 */
export type CallLinear = (query: string, variables: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<LinearAnswer>;

// Never "the ticket is gone" and never "the team is empty". Linear answers 401 for a key it refuses,
// which Jira does not, so this needs no header trap of its own.
export const KEY_REFUSED =
  'Linear refused the API key, so nothing was read. Check that the key is still valid, then paste it again.';

/**
 * The fields a card is built from, and no more.
 *
 * A field nobody reads is a field that rots, and an unconfirmed field is worse: one name Linear does
 * not know fails the whole document, and every ticket in the answer is lost with it. So this asks for
 * the five the card draws and leaves the rest.
 *
 * Limit: no `parent`. Linear documents a parent on an issue, and the Add card dialog offers the
 * siblings from one, the way it does for Jira and GitHub. Add `parent { identifier }` here once a
 * real call has confirmed the selection above, so a wrong guess cannot cost the whole read.
 */
const NODE = 'identifier title description url state { type }';

/**
 * One document for both paths: the filter says which issues, and nothing about the shape changes.
 *
 * Every value a person typed travels as a variable. Jira and GitHub build their query as text and
 * need a name rule each to stop a typed name from extending it. Nothing here is built from text, so
 * there is nothing to escape.
 *
 * `orderBy: updatedAt` is what makes paging stable, and the answer does not carry the time: the card
 * has nowhere to show it.
 */
export const ISSUES_QUERY = `query NolzuIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${NODE} }
    pageInfo { hasNextPage endCursor }
  }
}`;

// An issue identifier, such as PROJ-123. The same shape `parseTicketRef` keeps as an external ref, so
// a Linear key and a Jira key reach an adapter as the same kind and the source decides which reads it.
const IDENTIFIER = /^([A-Z][A-Z0-9]*)-(\d+)$/;

// A team key, which is the first half of every identifier.
const TEAM = /^[A-Z][A-Z0-9]*$/;

/**
 * The two workflow state types that mean the work is over.
 *
 * Every Linear team names its own states, so the name says nothing across workspaces. The type is the
 * same everywhere, and these two are the closed ones: triage, backlog, unstarted and started are all
 * open. A cancelled issue is closed as well as a completed one, which is where this differs from
 * Jira's single `done` category.
 */
const CLOSED = new Set(['completed', 'canceled']);

// Linear caps a page at 50 unless a call asks for more. Kept at the cap, so no answer can be cut by a
// number this code chose.
const MAX_PAGE = 50;

// A stop, so a workspace that keeps answering `hasNextPage: true` cannot spin forever.
const MAX_PAGES = 10;

interface LinearIssue {
  identifier?: string;
  title?: string;
  // Markdown, and null on an issue nobody described. No nested document to flatten, unlike Jira.
  description?: string | null;
  url?: string | null;
  state?: { type?: string } | null;
}

interface LinearBody {
  data?: { issues?: { nodes?: unknown; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null } | null } | null;
  // A refused query, a rate limit and a key with no access all arrive here, and HTTP 200 arrives with
  // them. Reading `data` without reading this is how a refusal becomes an empty backlog.
  errors?: { message?: unknown }[];
}

export const linearState = (state: { type?: string } | null | undefined): 'open' | 'closed' =>
  CLOSED.has(state?.type?.toLowerCase() ?? '') ? 'closed' : 'open';

export const linearTicket = (issue: LinearIssue): Ticket | null => {
  if (typeof issue.identifier !== 'string' || !IDENTIFIER.test(issue.identifier)) return null;
  return {
    key: issue.identifier,
    title: issue.title ?? '',
    body: issue.description ?? '',
    state: linearState(issue.state),
    url: issue.url ?? null,
    // Not asked for, so never claimed. The `NODE` comment says when to add it.
    parentKey: null,
  };
};

// What Linear said, in its own words, so a person reads the reason and not a status code. Used for a
// refusal at any status, because a GraphQL refusal carries the same array whatever the status was.
export function reasonOf(body: string): string | null {
  try {
    const [first] = (JSON.parse(body) as LinearBody).errors ?? [];
    const said = typeof first?.message === 'string' ? first.message.trim() : '';
    return said === '' ? null : said;
  } catch {
    return null;
  }
}

/**
 * One page of issues, or a throw.
 *
 * This is the whole reason the adapter exists in the shape it does. A GraphQL refusal is HTTP 200
 * with an `errors` array and a null `data`, so a reader that trusted the status and then took
 * `nodes ?? []` would answer "this team has no open tickets" to a rate limit, a refused key or a
 * field name Linear does not know. The same bug was found in the GitHub adapter this phase, where a
 * rate limited answer parses as JSON, carries `message` and no `items`.
 *
 * So: an unreadable body throws, an `errors` array throws, and anything but a real array of nodes
 * throws. Nothing here can answer an empty list unless Linear answered an empty list.
 */
export function readPage(body: string): { rows: LinearIssue[]; after: string | null } {
  let answer: LinearBody;
  try {
    const read: unknown = JSON.parse(body);
    // `JSON.parse('null')` answers null and throws nothing, and a gateway can send that. Reading a
    // field off it would put a raw TypeError on the Scout screen instead of the sentence below.
    if (typeof read !== 'object' || read === null) throw new Error('not an object');
    answer = read as LinearBody;
  } catch {
    throw new Error('Linear answered with something Nolzu could not read.');
  }
  // An `errors` that is not an array is still a refusal. `({}).length` is undefined, so a length
  // test alone would read a field level refusal with a partial answer as a clean answer.
  if (Array.isArray(answer.errors) ? answer.errors.length > 0 : answer.errors !== undefined) {
    throw new Error(`Linear refused the query. ${reasonOf(body) ?? 'It gave no reason.'}`);
  }
  const page = answer.data?.issues;
  if (page === null || page === undefined || !Array.isArray(page.nodes)) {
    throw new Error('Linear answered without a list of issues, so nothing was read. Nolzu does not read that as an empty backlog.');
  }
  // A cursor only where Linear said there is more. An `endCursor` on the last page would cost one
  // call per check that answers the same rows again.
  const more = page.pageInfo?.hasNextPage === true;
  const cursor = page.pageInfo?.endCursor ?? null;
  if (more && cursor === null) {
    // There is more and there is no way to ask for it. Handing back this page would be a part of
    // the list, and the caller would read it as all of it.
    throw new Error('Linear said there are more issues but sent no cursor for them, so nothing was read.');
  }
  return { rows: page.nodes as LinearIssue[], after: more ? cursor : null };
}

const refusal = (answer: LinearAnswer): Error => {
  if (answer.status === 401 || answer.status === 403) return new Error(KEY_REFUSED);
  const said = reasonOf(answer.body);
  // A throttle is the one refusal where waiting is the whole fix. The generic sentence would send
  // the person to look at a key that is fine.
  const lead =
    answer.status === 429
      ? 'Linear is rate limiting this key, so nothing was read. Check again in a few minutes.'
      : `Linear refused the call and answered ${answer.status}.`;
  return new Error(`${lead}${said === null ? '' : ` ${said}`}`);
};

// How many tickets one `get` may ask about. One document holds them all, so the bound is the page and
// not the cost of the call.
//
// Limit: refused rather than split. A caller that sends more gets a refusal it can read, which
// beats a silent cut where the tickets past the cap would read as tickets that are not there. Chunk
// the refs the way the GitHub adapter does once a caller needs more than one page.
export const MAX_REFS = MAX_PAGE;

export function linearIssues(call: CallLinear): TicketAdapter {
  // Which refs this adapter can read. A key it cannot read is left alone rather than guessed at, so
  // one bad ref cannot fail the whole read.
  const readable = (ref: TicketRef): { team: string; number: number } | null => {
    if (ref.kind !== 'external') return null;
    const named = IDENTIFIER.exec(ref.key);
    const team = named?.[1];
    const number = Number(named?.[2]);
    if (team === undefined || !Number.isSafeInteger(number) || number < 1) return null;
    return { team, number };
  };

  // What a ref and an answered issue are matched on. Not the typed string: a person who writes
  // PROJ-007 asks for number 7, Linear answers PROJ-7, and matching the text would call a ticket
  // that was just read a ticket that is not there.
  const slot = (team: string, number: number): string => `${team}-${number}`;

  return {
    name: 'linear',
    // The name a person reads, because `name` is an id and goes into the card row as one.
    title: 'Linear',

    /**
     * One result per ref, in the order they came.
     *
     * A caller that sends several refs and matches them back by position would otherwise put the
     * wrong ticket on the wrong card. A ref this adapter cannot read answers `notFound: false`:
     * nothing was asked, so nothing is known.
     *
     * One call for every ref, because Linear has no read by identifier: `issue(id:)` takes the
     * internal uuid, and a card only ever carries the identifier a person sees. So the refs become
     * one `or` filter of team key and number, which is also how a hundred cards cost one call.
     *
     * This throws where the Jira `get` stays quiet on a server error. Jira makes one call per ref, so
     * a failure there is about one ticket. Here one answer covers every ref, and a failure means
     * nothing is known about any of them.
     */
    async get(refs: readonly TicketRef[], signal: AbortSignal): Promise<readonly TicketResult[]> {
      const wanted = refs.map(readable);
      const asked = wanted.filter((ref) => ref !== null);
      const found = new Map<string, Ticket>();

      if (asked.length > MAX_REFS) {
        throw new Error(`Nolzu reads up to ${MAX_REFS} Linear tickets in one go, and it was asked for ${asked.length}.`);
      }
      if (asked.length > 0) {
        const filter = { or: asked.map((ref) => ({ team: { key: { eq: ref.team } }, number: { eq: ref.number } })) };
        const answer = await call(ISSUES_QUERY, { filter, first: asked.length, after: null }, signal);
        if (answer.status !== 200) throw refusal(answer);
        const read = readPage(answer.body);
        // Linear said this page is not the whole answer. The refs it left out are not missing
        // tickets, and reporting them as missing would tell a person their ticket is gone.
        if (read.after !== null) {
          throw new Error('Linear answered only a part of the tickets that were asked for, so nothing is known about the rest.');
        }
        for (const row of read.rows) {
          const ticket = linearTicket(row);
          const named = IDENTIFIER.exec(ticket?.key ?? '');
          if (ticket !== null && named !== null) found.set(slot(named[1] ?? '', Number(named[2])), ticket);
        }
      }

      return refs.map((ref, index): TicketResult => {
        const mine = wanted[index];
        if (mine === null || mine === undefined) return { ref, ticket: null, notFound: false };
        const ticket = found.get(slot(mine.team, mine.number)) ?? null;
        // Linear answered and this identifier was not in the answer. The issue is not there, or this
        // key may not see it, and nothing tells the two apart. Both read as not found, which is what
        // a person can act on.
        return { ref, ticket, notFound: ticket === null };
      });
    },

    /**
     * The open tickets of the teams named in `repos`, which for Linear are team keys.
     *
     * This throws where `get` reports a missing ticket. A search that answers nothing reads as "these
     * teams have no open tickets", so a refused key or a filter Linear does not know would look like
     * an empty backlog.
     */
    async search(query: TicketQuery, signal: AbortSignal): Promise<readonly Ticket[]> {
      const terms = (query.terms ?? '').trim();
      // Every name, not only the case where no name is a key. Dropping the bad ones would ask for a
      // part of what the person typed and hand the answer back as the whole of it.
      const teams = query.repos.filter((name) => TEAM.test(name));
      if (teams.length < query.repos.length) {
        const bad = query.repos.filter((name) => !TEAM.test(name));
        throw new Error(`Linear reads a team by its key, such as PROJ. These are not keys: ${bad.join(', ')}.`);
      }
      if (teams.length === 0) {
        // Linear has no query language to bound a workspace-wide read with, and every issue of a
        // whole workspace is not what any caller meant.
        return [];
      }

      // Linear drops the closed ones, not this code. A team whose newest issues are all done would
      // otherwise answer page after page that this adapter throws away, and the caller would read the
      // empty result as a team with no tickets.
      const filter = {
        team: { key: { in: teams } },
        state: { type: { nin: [...CLOSED] } },
        // Words the person typed, matched against the title. Linear has no query language, so this is
        // the whole of what a typed query can mean here.
        ...(terms === '' ? {} : { title: { containsIgnoreCase: terms } }),
      };

      const found: Ticket[] = [];
      let after: string | null = null;
      for (let page = 0; found.length < query.limit; page += 1) {
        if (page === MAX_PAGES) {
          // Stopping quietly would hand back a part of the list, and the caller would read it as all
          // of it.
          throw new Error(`Linear kept offering more pages after ${MAX_PAGES}, so Nolzu stopped before it had the whole list.`);
        }
        const first = Math.min(Math.max(query.limit - found.length, 1), MAX_PAGE);
        const answer = await call(ISSUES_QUERY, { filter, first, after }, signal);
        if (answer.status !== 200) throw refusal(answer);
        const read = readPage(answer.body);
        let readable = 0;
        for (const row of read.rows) {
          const ticket = linearTicket(row);
          if (ticket === null) continue;
          readable += 1;
          // The filter already asks for the open ones. This is the same rule on the row that came
          // back, so a workspace that answered something else does not put a closed ticket on a board.
          if (ticket.state === 'open' && found.length < query.limit) found.push(ticket);
        }
        // Linear answered issues and not one of them carried an identifier such as PROJ-123. An empty
        // list here would read as a team with no tickets, which is what this whole file is against.
        if (read.rows.length > 0 && readable === 0) {
          throw new Error('Linear answered issues Nolzu could not read: none of them had an identifier such as PROJ-123.');
        }
        after = read.after;
        if (after === null) break;
      }
      return found;
    },
  };
}

// What this needs from `fetch`, so a test drives the calls by hand and opens no socket. The same seam
// shape `jira-http.ts` uses.
export type LinearFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

// Printable characters and no space, which is what a key is. A key with a newline or a space in it
// would either throw inside `fetch` or be cut at the newline, and a pasted key picks both up easily.
// The refusal never repeats the key.
const KEY_SHAPE = /^[!-~]+$/;

/**
 * The real calls, with the API key from the caller.
 *
 * Authentication is the key on its own in the Authorization header, with no Bearer in front of it,
 * which is what Linear documents for a personal API key. An OAuth token is the other way around, and
 * Nolzu collects no OAuth token.
 *
 * The key goes into one header. It never reaches the document, the variables, the database or a log,
 * and no message built here repeats it.
 */
export function linearCall(key: string, fetcher: LinearFetch = fetch): CallLinear {
  const authorization = key.trim();
  if (!KEY_SHAPE.test(authorization)) {
    throw new Error('That is not a Linear API key. A key is one word with no spaces in it, and it is pasted whole.');
  }

  return async (query, variables, signal): Promise<LinearAnswer> => {
    let answer: Response;
    let body: string;
    try {
      answer = await fetcher(LINEAR_API, {
        // A GraphQL read is a POST, which is the one thing that makes this look like a write. Nothing
        // in `ISSUES_QUERY` is a mutation.
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal,
      });
      body = await answer.text();
    } catch {
      // Never the error's own message and never the error as a cause. A transport error can carry the
      // request that caused it, headers and all, and a printed cause chain would be the key in a log.
      throw new Error(
        signal.aborted ? 'Linear did not answer in time, so nothing was read.' : 'Nolzu could not reach Linear. Check the network.',
      );
    }
    // The rate limit headers are not read. Nothing here was ever throttled, so there is no measured
    // shape for a throttled answer to act on, and a refusal is already loud.
    return { status: answer.status, body };
  };
}
