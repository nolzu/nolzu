import type { SentryIssue } from '@nolzu/core';

/**
 * The Sentry adapter, over the issues endpoint of the Sentry API.
 *
 * NOT RECORDED. Every field name, path and header below is written from Sentry's own documentation and
 * not from an answer this project has read, because Nolzu has not called the real Sentry API yet.
 * `sentry.test.ts` names what a first real call has to confirm. Until then treat a Sentry finding as
 * unverified.
 *
 * Read-only, the rule for every Scout source: one GET, and nothing here resolves, assigns or comments
 * on an issue.
 */

// The hosted service. A self-hosted Sentry lives on the company's own host, and the source form
// collects an organization and a project and no host, so this adapter reads the hosted one only. A
// host field on the form is what a self-hosted install needs, and that is a change to the form.
export const SENTRY_ORIGIN = 'https://sentry.io';

/** What one call answered. The headers are lower case, the way `fetch` gives them back. */
export interface SentryAnswer {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

/**
 * How one call is made. A GET and a path, because nothing here writes to Sentry.
 *
 * The condition the implementation has to keep and this file cannot: the Auth token goes into the
 * Authorization header and never into the path, so a path that reaches a log carries no secret.
 */
export type CallSentry = (path: string, signal: AbortSignal) => Promise<SentryAnswer>;

/** What this needs from `fetch`, so a test drives the calls by hand and opens no socket. */
export type SentryHttp = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

// An organization slug and a project slug, as Sentry writes them. Also what goes into a path, so
// nothing a person types on the form can add a segment or a query of its own. A name that is only dots
// is refused for the same reason: `..` holds no character this test would catch, and `new URL` in
// `sentryCall` resolves it away, so the Auth token would go to a path nobody on the form named.
const SLUG = /^(?!\.+$)[A-Za-z0-9._-]+$/;

// The API refuses a larger page and answers 400. Sentry's own default is smaller, so the caller's
// limit is what decides in practice.
const MAX_PAGE = 100;

/**
 * The path that lists a project's issues.
 *
 * `query` is spelled out rather than left to the endpoint's default, because a resolved issue is work
 * somebody has already finished and a finding for it would be noise. No time window is asked for: what
 * `statsPeriod` filters on this endpoint is not something this project has measured, and a wrong guess
 * would quietly hide issues.
 */
export const sentryIssuesPath = (org: string, project: string, limit: number): string =>
  `/api/0/projects/${org}/${project}/issues/?${new URLSearchParams({ query: 'is:unresolved', limit: String(Math.min(Math.max(limit, 1), MAX_PAGE)) })}`;

// A number Sentry may answer as a string. `count` is documented as a string on this endpoint, and a
// string would make every arithmetic on it a text join, so both forms are read here.
function asCount(value: unknown): number {
  const many = typeof value === 'string' ? Number(value) : value;
  return typeof many === 'number' && Number.isInteger(many) && many >= 0 ? many : 0;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

// The id may come as a JSON number. `count` is read in both forms already, and the id is the one field
// whose loss drops the whole row, so it gets the same tolerance rather than less.
const asId = (value: unknown): string => (Number.isInteger(value) ? String(value) : asText(value));

/**
 * One row of the answer, or null when it is not an issue this adapter can key.
 *
 * The id is the fingerprint of the finding, so a row without a usable one is dropped rather than
 * guessed at: a finding under a made-up id can never be merged with the real issue again. No
 * whitespace in it either, because the cursor keeps these ids in a list separated by spaces.
 */
export function sentryIssueFrom(row: unknown): SentryIssue | null {
  if (typeof row !== 'object' || row === null) return null;
  const one = row as Record<string, unknown>;
  const id = asId(one.id).trim();
  if (id === '' || /\s/.test(id)) return null;
  return {
    id,
    shortId: asText(one.shortId),
    title: asText(one.title),
    culprit: asText(one.culprit),
    level: asText(one.level),
    count: asCount(one.count),
    permalink: asText(one.permalink),
  };
}

/**
 * The issues in one answer.
 *
 * A body that is not an array of rows is refused and never read as an empty list. A proxy page, a
 * refusal shaped as an object and a truncated answer all carry no rows, and an empty list would read
 * as a project whose errors are all resolved, which is the one thing Scout may not claim by mistake.
 */
export function readSentryIssues(body: string): SentryIssue[] {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error(unreadable(body));
  }
  if (!Array.isArray(rows)) {
    throw new Error('Sentry answered the issue list with something that is not a list of issues, so nothing was read. Check the organization and the project in the source on the Scout page.');
  }
  const issues = rows.flatMap((row) => sentryIssueFrom(row) ?? []);
  // An answer full of rows this adapter cannot key reads as a project whose errors are all resolved,
  // which is the same wrong claim a body that is not an array would make. One field name read wrong
  // drops every row at once, so an answer that keyed nothing at all is refused here too. A few rows
  // dropped out of many is not: those are rows Sentry answered without an id, and the rest are real.
  if (issues.length === 0 && rows.length > 0) {
    throw new Error(
      `Sentry answered ${rows.length === 1 ? 'one issue' : `${rows.length} issues`} and Nolzu could read an id on none of them, so nothing was read. The project is not clear of errors, Nolzu is reading the answer wrongly.`,
    );
  }
  return issues;
}

// A body that is not JSON. A web page in front of the API is the common cause and it has its own fix,
// so it gets its own sentence instead of one about Sentry.
const unreadable = (body: string): string =>
  isHtml(body)
    ? `Something on the network answered for ${SENTRY_ORIGIN} with a web page instead of data, so nothing was read. Check whether a proxy or a sign-in page sits in front of Sentry on this machine.`
    : 'Sentry answered with something Nolzu could not read, so nothing was read. Try the check again, and look at the Sentry status page if it keeps happening.';

// A page, not data. The first character is what says so: a JSON answer starts with a bracket or a
// brace, and a proxy page starts with a doctype or a tag.
const isHtml = (body: string): boolean => body.trimStart().startsWith('<');

/**
 * How long Sentry asked the caller to wait, in whole seconds, or null when the answer named nothing.
 *
 * `retry-after` is read and `x-sentry-rate-limit-reset` is not, because the reset header is a moment
 * in epoch seconds and turning that into a wait needs this machine's clock to agree with Sentry's.
 */
export function retryAfter(headers: Readonly<Record<string, string>>): number | null {
  const said = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1] ?? '';
  const seconds = Number(said.trim());
  return said.trim() !== '' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * What a refused call tells the person to do next.
 *
 * Each status gets its own sentence, because the fix behind each is a different one: a new token, a
 * scope on the token, a wait, or a name on the form. A status with no sentence of its own says what it
 * was, so a person has something to search for.
 */
export function sentryRefused(answer: SentryAnswer): string {
  // Asked before any status, because a proxy or a captive portal answers its own 401 or 403 with a
  // sign-in page, and the fix for that is on this machine and not a new token in Sentry. A 200 never
  // reaches this function, so nothing here can be Sentry's own data.
  if (isHtml(answer.body)) return unreadable(answer.body);
  if (answer.status === 401) {
    return 'Sentry refused the Auth token, so nothing was read. Make a new token in Sentry with project:read and event:read, then paste it into this source on the Scout page.';
  }
  if (answer.status === 403) {
    return 'Sentry took the Auth token and refused the call, so nothing was read. The token needs project:read and event:read on this project. Check its scopes in Sentry, then paste a new token into this source.';
  }
  if (answer.status === 429) {
    const wait = retryAfter(answer.headers);
    return wait === null
      ? 'Sentry is rate limiting this Auth token, so nothing was read. Wait a few minutes and check again.'
      : `Sentry is rate limiting this Auth token, so nothing was read. Wait ${wait} seconds and check again.`;
  }
  if (answer.status === 404) {
    return 'Sentry does not have that project, so nothing was read. Check the organization and the project in the source on the Scout page against the address of the project in Sentry.';
  }
  // Anything left is a server error, and its status is all a person has to search for.
  return `Sentry answered ${answer.status} and read nothing. Try the check again, and look at the Sentry status page if it keeps happening.`;
}

/** The real call, with the Auth token from the OS keychain in the one header that carries it. */
export function sentryCall(token: string, fetcher: SentryHttp = fetch): CallSentry {
  const origin = new URL(SENTRY_ORIGIN);

  return async (path, signal): Promise<SentryAnswer> => {
    let answer: Response;
    let body: string;
    try {
      answer = await fetcher(new URL(path, origin).toString(), {
        // The token goes here and nowhere else. Never into the path, which reaches a log.
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal,
      });
      body = await answer.text();
    } catch {
      // Never the error's own message and never the error as a cause. A transport error can carry the
      // request that caused it, headers and all, and a printed cause chain would be the token in a log.
      throw new Error(
        signal.aborted
          ? `Sentry did not answer in time, so nothing was read from ${origin.host}.`
          : `Nolzu could not reach ${origin.host}. Check the network, then try the check again.`,
      );
    }

    const headers: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: answer.status, headers, body };
  };
}

/**
 * The unresolved issues of one project.
 *
 * One page and no paging. The caller's limit is the bound on how many findings one press can open, and
 * a person who presses a button does not expect a backlog of a thousand rows on the Scout screen.
 */
export async function sentryIssues(call: CallSentry, org: string, project: string, limit: number, signal: AbortSignal): Promise<readonly SentryIssue[]> {
  if (!SLUG.test(org) || !SLUG.test(project)) {
    throw new Error(`${org}/${project} is not a Sentry organization and project. Open the source on the Scout page and write each as it appears in the address of the project in Sentry.`);
  }
  const answer = await call(sentryIssuesPath(org, project, limit), signal);
  if (answer.status !== 200) throw new Error(sentryRefused(answer));
  return readSentryIssues(answer.body);
}
