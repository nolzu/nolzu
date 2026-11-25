import { accountRefused, JIRA_FIELDS, type JiraAnswer, LOGIN_REASON } from '@nolzu/core';
import type { TicketRef } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { type CallJira, jiraIssues } from './jira.ts';

// Every fixture here is built from what a real site answered on 2026-09-25. The site, the account
// and the issue text are made up: `PROJ-123` on https://example.atlassian.net.
const SITE = 'https://example.atlassian.net';

const adf = (...paragraphs: string[]) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

const issue = (key: string, extra: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: '10001',
    key,
    self: `${SITE}/rest/api/3/issue/10001`,
    fields: {
      summary: 'Search by ingredient',
      description: adf('Match ingredients too.'),
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      parent: null,
      ...fields,
    },
    ...extra,
  });

// The answer three different states share: a refused token, a missing issue, and a key in a project
// that is not there. Byte for byte the same body, and only the header tells the first from the rest.
// Written out twice on purpose: the header is the only difference between them, and
// `packages/core/src/jira-tickets.test.ts` is where that claim is checked.
const MISSING_BODY = JSON.stringify({
  errorMessages: ['Issue does not exist or you do not have permission to see it.'],
  errors: {},
});

const REFUSED_TOKEN_BODY = JSON.stringify({
  errorMessages: ['Issue does not exist or you do not have permission to see it.'],
  errors: {},
});

const RATE_LIMIT = { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '999' };

const answers = (...given: JiraAnswer[]): { call: CallJira; paths: string[] } => {
  const paths: string[] = [];
  let at = 0;
  return {
    paths,
    call: async (path) => {
      paths.push(path);
      const answer = given[Math.min(at, given.length - 1)];
      at += 1;
      if (answer === undefined) throw new Error('the test gave no answer');
      return answer;
    },
  };
};

const ok = (body: string): JiraAnswer => ({ status: 200, headers: RATE_LIMIT, body });
const missing = (): JiraAnswer => ({ status: 404, headers: RATE_LIMIT, body: MISSING_BODY });
const refusedToken = (): JiraAnswer => ({
  status: 404,
  headers: { ...RATE_LIMIT, [LOGIN_REASON]: 'AUTHENTICATED_FAILED' },
  body: REFUSED_TOKEN_BODY,
});

const ref = (key: string): TicketRef => ({ kind: 'external', key });

// The query as the site reads it. The path is relative, so it takes a base to be parsed against.
const jqlOf = (path: string): string | null => new URL(path, SITE).searchParams.get('jql');
const live = (): AbortSignal => AbortSignal.timeout(1000);

describe('the adapter reading one key', () => {
  it('makes a ticket from a key that is there', async () => {
    const { call, paths } = answers(ok(issue('PROJ-123')));

    const [found] = await jiraIssues(call).get([ref('PROJ-123')], live());

    expect(found?.ticket?.title).toBe('Search by ingredient');
    expect(found?.notFound).toBe(false);
    expect(paths[0]).toBe(`/rest/api/3/issue/PROJ-123?fields=${JIRA_FIELDS}`);
  });

  it('says a key that is not there is not there', async () => {
    const { call } = answers(missing());

    const [found] = await jiraIssues(call).get([ref('PROJ-404')], live());

    expect(found).toMatchObject({ ticket: null, notFound: true });
  });

  // The failure this whole task exists to stop. Without the header this reads as a ticket that is
  // gone, and the person goes looking in Jira while their token is the problem.
  it('refuses a token Jira turned down, and never reads it as a missing ticket', async () => {
    const { call } = answers(refusedToken());

    await expect(jiraIssues(call).get([ref('PROJ-123')], live())).rejects.toThrow(/refused the API token/);
  });

  /**
   * Both are permanent, and neither is a ticket that is gone.
   *
   * 401 is what a wrong account email in the site setting gives, and 403 is what the site gives
   * after several refused logins. Telling a person to try again would point them at the one thing
   * that cannot help, which is the mistake the 404 trap above is.
   */
  it('refuses the account rather than asking the person to try a call that can only fail', async () => {
    const wrongEmail = answers({ status: 401, headers: RATE_LIMIT, body: JSON.stringify({ message: 'Client must be authenticated to access this resource.' }) });

    await expect(jiraIssues(wrongEmail.call).get([ref('PROJ-123')], live())).rejects.toThrow(/Check the account email and the API token/);

    const captcha = answers({ status: 403, headers: { ...RATE_LIMIT, 'x-authentication-denied-reason': 'CAPTCHA_CHALLENGE' }, body: '' });

    await expect(jiraIssues(captcha.call).get([ref('PROJ-123')], live())).rejects.toThrow(/sign in there/);
  });

  it('never reads a refused account as a ticket that is gone, and never asks for a retry', async () => {
    const refusals = { 401: 'the account email and the token do not go together', 403: 'the site wants a sign in first' };
    expect(Object.keys(refusals)).toHaveLength(2);

    for (const [status, why] of Object.entries(refusals)) {
      const { call } = answers({ status: Number(status), headers: RATE_LIMIT, body: '' });

      const said = await jiraIssues(call)
        .get([ref('PROJ-123')], live())
        .then(() => '', (error: Error) => error.message);

      expect(said, why).toBe(accountRefused(Number(status)));
      expect(said, why).not.toMatch(/not there|Try again/);
    }
  });

  // Same 404, same sentence, no header. It is not the token, so it reads as not found.
  it('reads a key in a project that is not there as not found', async () => {
    const { call } = answers(missing());

    const [found] = await jiraIssues(call).get([ref('NOPE-1')], live());

    expect(found).toMatchObject({ ticket: null, notFound: true });
  });

  // Not found would be a claim, and a caller that believed it would make a card for a ticket that
  // was never read.
  it('says nothing about a key when the site answered with a failure of its own', async () => {
    const { call } = answers({ status: 503, headers: {}, body: 'service unavailable' });

    const [found] = await jiraIssues(call).get([ref('PROJ-123')], live());

    expect(found).toMatchObject({ ticket: null, notFound: false });
  });

  it('says nothing about a key when the site could not be reached at all', async () => {
    const call: CallJira = () => Promise.reject(new Error('Nolzu could not reach example.atlassian.net.'));

    // It fails loudly rather than answering "the ticket is gone" for a site that never answered.
    await expect(jiraIssues(call).get([ref('PROJ-123')], live())).rejects.toThrow(/could not reach/);
  });

  it('leaves a ref of another ticket system alone, and asks nothing for it', async () => {
    const { call, paths } = answers(ok(issue('PROJ-123')));

    const results = await jiraIssues(call).get(
      [{ kind: 'github', owner: 'acme', repo: 'app', number: 1 }, { kind: 'text', text: 'a title' }, ref('lower-1')],
      live(),
    );

    expect(results).toMatchObject([
      { ticket: null, notFound: false },
      { ticket: null, notFound: false },
      { ticket: null, notFound: false },
    ]);
    expect(paths).toEqual([]);
  });

  // The key goes straight into the path `issuePath` builds, so the shape check is what stops a typed
  // ref adding a segment or a query of its own. Un-anchoring `JIRA_KEY` passes every other test in
  // this repository, which is why this one asks for the call list and not just the result.
  it('asks nothing for a key that would add a path or a query of its own', async () => {
    const { call, paths } = answers(ok(issue('PROJ-123')));

    const results = await jiraIssues(call).get(
      [ref('PROJ-1/../../rest/api/3/myself'), ref('PROJ-1?fields=summary'), ref('x PROJ-1')],
      live(),
    );

    expect(results).toMatchObject([
      { ticket: null, notFound: false },
      { ticket: null, notFound: false },
      { ticket: null, notFound: false },
    ]);
    expect(paths).toEqual([]);
  });

  // The positional trap. A caller that sends several refs and matches them back by index would put
  // the wrong ticket on the wrong card if a ref it cannot read were dropped.
  it('answers one result per ref, in the order they came', async () => {
    const byKey: Record<string, JiraAnswer> = { 'PROJ-1': ok(issue('PROJ-1')), 'PROJ-2': missing() };
    const call: CallJira = async (path) => byKey[path.slice('/rest/api/3/issue/'.length).split('?')[0] ?? ''] ?? missing();

    const results = await jiraIssues(call).get([{ kind: 'text', text: 'free' }, ref('PROJ-1'), ref('PROJ-2')], live());

    expect(results).toHaveLength(3);
    expect(results[0]?.ticket).toBeNull();
    expect(results[1]?.ticket?.key).toBe('PROJ-1');
    expect(results[2]).toMatchObject({ ticket: null, notFound: true });
  });
});

describe('the adapter searching', () => {
  const page = (keys: string[], extra: Record<string, unknown> = {}) =>
    ok(JSON.stringify({ issues: keys.map((key) => JSON.parse(issue(key)) as unknown), isLast: true, ...extra }));

  it('asks only inside the projects it was given, and never for the whole site', async () => {
    const { call, paths } = answers(page(['PROJ-1']));

    const found = await jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live());

    expect(found[0]?.key).toBe('PROJ-1');
    expect(paths[0]?.startsWith('/rest/api/3/search/jql?')).toBe(true);
    // The site drops the closed ones. Dropping them here only, after the page came back, would
    // answer nothing at all for a project whose newest tickets are closed.
    expect(jqlOf(paths[0] ?? '')).toBe('project in (PROJ) AND statusCategory != Done ORDER BY created DESC');
  });

  it('asks nothing when no project is named, because that query is the unbounded one', async () => {
    const { call, paths } = answers(page([]));

    expect(await jiraIssues(call).search({ limit: 10, repos: [] }, live())).toEqual([]);
    expect(paths).toEqual([]);
  });

  // Names were given and none of them is a project key. An empty list would read as "these
  // projects have no tickets" about a question the site never got.
  it('says a name is not a project key instead of answering no tickets', async () => {
    const { call, paths } = answers(page([]));

    await expect(jiraIssues(call).search({ limit: 10, repos: ['not a key'] }, live())).rejects.toThrow(
      /reads a project by its key.*not a key/,
    );
    expect(paths).toEqual([]);
  });

  it('says so when the site answered the search with something it could not read', async () => {
    const { call } = answers(ok('<html>a proxy page</html>'));

    // An empty list here is the same lie as an empty list for a refused query.
    await expect(jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live())).rejects.toThrow(/could not read/);
  });

  // A 200 that parses and carries no list of issues. `issues ?? []` would read it as a project with
  // no tickets, which is the same lie a refused query answered as an empty list is.
  it('says so when the search answered JSON with no list of issues', async () => {
    const { call } = answers(ok(JSON.stringify({ isLast: true })));

    await expect(jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live())).rejects.toThrow(/without a list of issues/);
  });

  // An empty list would read as "this project has no tickets", which is the same class of lie the
  // 404 trap is.
  it('says why an unbounded query was refused instead of answering no tickets', async () => {
    const { call } = answers({
      status: 400,
      headers: RATE_LIMIT,
      body: JSON.stringify({ errorMessages: ['Unbounded JQL queries are not allowed here.'], errors: {} }),
    });
    // The adapter builds a bounded query, so this is the site refusing one it did not expect.
    const search = jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live());

    await expect(search).rejects.toThrow(/Unbounded JQL queries are not allowed here/);
  });

  // The recorded answer, header and all. A refused token on the search is the same 404 as on a
  // read, and the status alone says nothing.
  it('refuses a searched token the same way a read does', async () => {
    const { call } = answers(refusedToken());

    await expect(jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live())).rejects.toThrow(/refused the API token/);
  });

  it('refuses the account on a search Jira turned down without that header', async () => {
    const { call } = answers({ status: 401, headers: RATE_LIMIT, body: JSON.stringify({ message: 'Client must be authenticated to access this resource.' }) });

    await expect(jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live())).rejects.toThrow(
      /Check the account email and the API token/,
    );
  });

  // Paging is by token here. There is no `total` and no `startAt` to count from.
  it('follows the next page token until the site says it is the last', async () => {
    const { call, paths } = answers(page(['PROJ-1'], { isLast: false, nextPageToken: 'second' }), page(['PROJ-2']));

    const found = await jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live());

    expect(found.map((ticket) => ticket.key)).toEqual(['PROJ-1', 'PROJ-2']);
    expect(paths[0]).not.toContain('nextPageToken');
    expect(paths[1]).toContain('nextPageToken=second');
  });

  // `isLast` decides, not the token. A last page that still carries one would otherwise be read
  // again, and the same tickets would come back up to the page cap.
  it('stops at the last page even when it still carries a next page token', async () => {
    const { call, paths } = answers(page(['PROJ-1'], { isLast: true, nextPageToken: 'second' }));

    const found = await jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live());

    expect(found.map((ticket) => ticket.key)).toEqual(['PROJ-1']);
    expect(paths).toHaveLength(1);
  });

  // A site that keeps offering pages with nothing on them would otherwise answer an empty list,
  // which reads as a project with no tickets.
  it('says it stopped rather than handing back a part of the list as all of it', async () => {
    const { call, paths } = answers(page([], { isLast: false, nextPageToken: 'more' }));

    await expect(jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live())).rejects.toThrow(/stopped before it had the whole list/);
    expect(paths).toHaveLength(10);
  });

  it('stops at the limit it was given', async () => {
    const { call } = answers(page(['PROJ-1', 'PROJ-2', 'PROJ-3']));

    expect(await jiraIssues(call).search({ limit: 2, repos: ['PROJ'] }, live())).toHaveLength(2);
  });

  it('leaves closed tickets out', async () => {
    const closed = JSON.parse(issue('PROJ-9', {}, { status: { statusCategory: { key: 'done' } } })) as unknown;
    const { call } = answers(ok(JSON.stringify({ issues: [closed, JSON.parse(issue('PROJ-1')) as unknown], isLast: true })));

    const found = await jiraIssues(call).search({ limit: 10, repos: ['PROJ'] }, live());

    expect(found.map((ticket) => ticket.key)).toEqual(['PROJ-1']);
  });
});
