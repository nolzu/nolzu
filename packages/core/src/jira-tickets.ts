import type { Ticket } from '@nolzu/protocol';

/**
 * What a Jira Cloud site is asked, and what its answer reads as.
 *
 * Pure, so the hosted service can read a Jira answer the same way this machine does. The call
 * itself is not here, because it needs a credential and a socket: `@nolzu/runner` makes it on this
 * machine, and the server makes its own.
 *
 * Two things stay local. The order of the calls is `jiraIssues` in `@nolzu/runner`, which the
 * server cannot import, and a Jira API token stays in this machine's keychain. So today
 * only this machine reads a Jira source, which is what the source on the Scout page tells the person.
 *
 * Everything below was built against what a real site answered on 2026-09-25, not against
 * documentation. The one thing worth reading twice is `tokenRefused`.
 */

export interface JiraAnswer {
  status: number;
  // Header names in lower case, the way `fetch` gives them back. `tokenRefused` reads them in any
  // case anyway, because a header name is case insensitive on the wire.
  headers: Readonly<Record<string, string>>;
  body: string;
}

/**
 * The trap this adapter exists for.
 *
 * A refused API token answers 404, not 401, and its body is the same sentence a missing issue
 * gives: "Issue does not exist or you do not have permission to see it." A key in a project that
 * is not there answers the same 404 and the same sentence. Three states, one answer.
 *
 * The only signal is this header. Without it Nolzu tells a person their ticket is gone when their
 * token is wrong, and they go looking in Jira instead of at their token.
 */
export const LOGIN_REASON = 'x-seraph-loginreason';
const AUTH_FAILED = 'AUTHENTICATED_FAILED';

export function tokenRefused(headers: Readonly<Record<string, string>>): boolean {
  const said = Object.entries(headers).find(([name]) => name.toLowerCase() === LOGIN_REASON)?.[1] ?? '';
  // A comma list, because Jira can name more than one reason in the one header.
  return said.split(',').some((reason) => reason.trim().toUpperCase() === AUTH_FAILED);
}

// Never "the ticket is not there", which is the same 404. The person is sent to their token, not
// to Jira. The token is a field on the source on the Scout page, so the sentence names that place:
// it is the only place this text is read, and a person with no terminal can act on it there.
//
// `JIRA_` because `@nolzu/protocol` exports a `TOKEN_REFUSED` of its own, the WebSocket close code
// 4401. An app imports both packages, and two names meaning a sentence and a number is a trap.
export const JIRA_TOKEN_REFUSED =
  'Jira refused the API token, so nothing was read. Open the source on the Scout page, paste a token this site still accepts, and save it.';

/**
 * A call Jira refused outright, which is not a ticket that is gone and not a call to repeat.
 *
 * The site answered, so "try again" would be the same wrong pointer the 404 trap is: the person
 * would retry a call that can only fail. 401 means the account email and the token do not go
 * together, and 403 means the site wants a sign in from a browser before it takes the API again.
 *
 * Neither status came out of the 2026-09-25 reads, so the two sentences are written from what each
 * status means and not from a recording.
 */
export const accountRefused = (status: number): string =>
  status === 403
    ? 'Jira refused the call. Open the site in a browser, sign in there, then try again.'
    : 'Jira refused the account, so nothing was read. Check the account email and the API token for this site.';

// An issue key, the shape `parseTicketRef` keeps as an external ref. Also what goes into a path, so
// nothing a person types can add a segment or a query of its own. Exported because the caller that
// makes the calls skips a ref of the wrong shape before it asks for one.
export const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * The fields a card is built from, and no more.
 *
 * The recorded read also asked for `issuetype` and `labels`. Nothing here shows either, and a field
 * nobody reads is a field that rots, so they are not asked for.
 */
export const JIRA_FIELDS = 'summary,description,status,parent';

export const issuePath = (key: string): string => `/rest/api/3/issue/${key}?fields=${JIRA_FIELDS}`;

export const SEARCH_PATH = '/rest/api/3/search/jql';

// A project key, which is what goes into the JQL `searchPath` builds by hand. Exported for the same
// reason as `JIRA_KEY`: the caller that makes the calls drops a name of the wrong shape before it
// asks for a page, and it reads better where the query is built than one package away.
export const JIRA_PROJECT = /^[A-Z][A-Z0-9]*$/;

// A page of our own choosing, not a number the site reported. The search answer carries no `total`
// and no `startAt`, so nothing here can check it against the site.
const MAX_PAGE = 100;

export function searchPath(projects: readonly string[], limit: number, after: string | null, terms?: string): string {
  const typed = (terms ?? '').trim();
  // Checked here and not only in the caller, because the keys are pasted into the query as text. A
  // name that is not a key could add a clause of its own, and an empty list asks for `project in ()`
  // which the site answers 400 for. Only the branch that builds the query cares: a query the person
  // typed names its own projects, so an empty list is right there.
  if (typed === '' && (projects.length === 0 || !projects.every((name) => JIRA_PROJECT.test(name)))) {
    throw new Error(`Jira reads a project by its key, such as PROJ. This asked for: ${projects.join(', ')}.`);
  }
  // Bounded on purpose. An unbounded query is refused with 400, and asking a whole site for every
  // issue is not what any caller meant.
  //
  // The site drops the closed ones, not this code. A project whose newest issues are all closed
  // would otherwise answer page after page that the caller throws away, and the caller would read
  // the empty result as a project with no tickets.
  //
  // What the person typed is the whole query where they typed one, because a screen that collects a
  // JQL field and then queries something else is a screen that lies. Their own query is bounded by
  // them: an unbounded one is refused with 400 and the site's own words say so.
  const jql = typed === '' ? `project in (${projects.join(',')}) AND statusCategory != Done ORDER BY created DESC` : typed;
  const query = new URLSearchParams({ jql, fields: JIRA_FIELDS, maxResults: String(Math.min(Math.max(limit, 1), MAX_PAGE)) });
  // By token, not by offset. This search answers `nextPageToken` and `isLast`, and has no `startAt`.
  if (after !== null) query.set('nextPageToken', after);
  return `${SEARCH_PATH}?${query}`;
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: { text?: string };
  content?: AdfNode[];
}

// A node whose text stands on its own, with a blank line after it. Everything else runs into the
// text around it.
const BLOCK = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'listItem', 'panel', 'rule', 'tableRow']);

const nodeText = (node: AdfNode): string => {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  // Both carry the words a reader sees in `attrs.text`, and neither has children.
  if (node.type === 'emoji' || node.type === 'mention') return node.attrs?.text ?? '';
  // Not `node.content ?? []`: a document Nolzu did not build can carry anything under that name,
  // and a card read must not fail on it.
  const inside = Array.isArray(node.content) ? node.content.map(nodeText).join('') : '';
  return BLOCK.has(node.type ?? '') ? `${inside}\n\n` : inside;
};

/**
 * A description as readable text.
 *
 * The v3 API answers a description as Atlassian Document Format, a nested document. The same issue
 * on v2 answers a plain string. Flattening here beats keeping a second API version alive for one
 * field, and a card summary needs text a person can read rather than a tree.
 *
 * It handles `text`, `hardBreak`, `emoji` and `mention`, walks the content of every other node, and
 * leaves a blank line after a paragraph, a heading, a code block, a quote, a list item, a panel, a
 * rule and a table row. A link keeps its words and loses its address, because a link is a mark on
 * the text and not a node. It drops a node that carries neither text nor content: media, a date, a
 * status badge, an inline card. Bullets and numbers go too, so a list reads as one line each, and a
 * table reads as one cell each rather than as rows and columns: a cell is not named here because
 * every cell holds a paragraph, which is.
 */
export function flattenAdf(description: unknown): string {
  // A plain string is the v2 answer, and an empty description is null on both versions.
  if (typeof description === 'string') return description;
  if (description === null || typeof description !== 'object') return '';
  return nodeText(description as AdfNode)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Exported for the caller that reads a search page: it holds one row of `issues` and hands it to
// `ticketFrom`.
export interface JiraIssue {
  key?: string;
  // The API address of this issue, which carries the site it came from.
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { statusCategory?: { key?: string } };
    parent?: { key?: string };
  };
}

/**
 * Open or closed.
 *
 * Every Jira project names its own statuses, so the name says nothing across sites. The category is
 * the same everywhere, and `done` is the only closed one: `new` and `indeterminate` are both open.
 */
export const jiraState = (status: { statusCategory?: { key?: string } } | undefined): 'open' | 'closed' =>
  status?.statusCategory?.key?.toLowerCase() === 'done' ? 'closed' : 'open';

// The answer names its own site in `self`, so nothing here has to be told the host a second time.
const browseUrl = (self: string | undefined, key: string): string | null => {
  try {
    return `${new URL(self ?? '').origin}/browse/${key}`;
  } catch {
    return null;
  }
};

export const ticketFrom = (issue: JiraIssue): Ticket | null => {
  if (typeof issue.key !== 'string' || !JIRA_KEY.test(issue.key)) return null;
  const fields = issue.fields ?? {};
  return {
    key: issue.key,
    title: fields.summary ?? '',
    body: flattenAdf(fields.description),
    state: jiraState(fields.status),
    url: browseUrl(issue.self, issue.key),
    // A sub-task and a child of an epic both report a parent, and the Add card dialog offers the
    // siblings from it.
    parentKey: fields.parent?.key ?? null,
  };
};

export function readIssue(body: string): Ticket | null {
  try {
    return ticketFrom(JSON.parse(body) as JiraIssue);
  } catch {
    return null;
  }
}

// What Jira said it refused a call for, in its own words, so a person reads the reason and not a
// status code.
export function refusalSays(body: string): string | null {
  try {
    const [first] = (JSON.parse(body) as { errorMessages?: unknown[] }).errorMessages ?? [];
    // A blank first line is no reason, and the caller says what the status was instead.
    return typeof first === 'string' && first.trim() !== '' ? first.trim() : null;
  } catch {
    return null;
  }
}
