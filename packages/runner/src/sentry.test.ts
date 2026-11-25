import { describe, expect, it } from 'vitest';
import { readSentryIssues, sentryCall, type SentryHttp, sentryIssues, sentryIssuesPath, sentryRefused } from './sentry.ts';

/**
 * HAND WRITTEN, AND NOT RECORDED.
 *
 * Nothing here has been read from Sentry. No Sentry account was used, and the adapter
 * was built without one, so every path, header and field below comes from Sentry's
 * documentation. Treat a Sentry finding as unverified until somebody records one real call, and read
 * these fixtures as what the adapter expects rather than as what Sentry sends.
 *
 * The first real call has to confirm six things about the call itself: that
 * `GET https://sentry.io/api/0/projects/{org}/{project}/issues/` lists a project's issues, that an Auth
 * token goes in as `Authorization: Bearer <token>`, that the answer is a bare JSON array and not an
 * object with the rows under a name, that `query=is:unresolved` is what leaves out the resolved ones,
 * that `limit` caps the page and how large it may be, whether the answer is limited to a default time
 * window that has to be asked for with `statsPeriod`, and what the default sort order is, because that
 * order decides which issues a page of `limit` rows carries and so which ones get a finding at all.
 *
 * It has to confirm four things about a refusal: that a token Sentry does not know answers 401, that a
 * token without `project:read` answers 403 rather than an empty list, that a throttled call answers 429
 * with `retry-after` in whole seconds, and that a project name that is not there answers 404.
 *
 * `packages/core/src/scout-sentry.test.ts` names what a row of the list has to confirm.
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: '4501',
  shortId: 'RECIPES-API-7F',
  title: 'TypeError: cannot read length of undefined',
  culprit: 'GET /recipes/{id}',
  level: 'error',
  status: 'unresolved',
  // A string, the way the endpoint is documented to answer it. The adapter reads both forms.
  count: '12',
  userCount: 4,
  firstSeen: '2026-09-20T08:11:02.000Z',
  lastSeen: '2026-09-27T19:44:51.000Z',
  permalink: 'https://sentry.io/organizations/your-org/issues/4501/',
  ...over,
});

const list = (...rows: object[]): string => JSON.stringify(rows);

// A `fetch` that answers once and records what it was asked. Nothing here opens a socket: the call
// takes its fetcher as an argument, so a test that hands one in can never reach the real one.
const http = (status: number, body: string, headers: Record<string, string> = {}): { fetcher: SentryHttp; calls: { url: string; headers: Record<string, string> }[] } => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    fetcher: (url, init) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve(new Response(body, { status, headers }));
    },
  };
};

const signal = () => AbortSignal.timeout(5_000);

describe('the issue list', () => {
  it('reads the fields a finding shows and drops the rest', () => {
    expect(readSentryIssues(list(row()))).toEqual([
      {
        id: '4501',
        shortId: 'RECIPES-API-7F',
        title: 'TypeError: cannot read length of undefined',
        culprit: 'GET /recipes/{id}',
        level: 'error',
        count: 12,
        permalink: 'https://sentry.io/organizations/your-org/issues/4501/',
      },
    ]);
  });

  // The id is read in both forms for the same reason the count is: the shape is written from
  // documentation and not from an answer, and an id read wrong drops the whole row.
  it('reads the id whether it comes as a string or as a number', () => {
    expect(readSentryIssues(list(row({ id: 4501 })))[0]?.id).toBe('4501');
    expect(readSentryIssues(list(row({ id: '4501' })))[0]?.id).toBe('4501');
  });

  it('reads the count whether it comes as a string or as a number', () => {
    expect(readSentryIssues(list(row({ count: 40 })))[0]?.count).toBe(40);
    expect(readSentryIssues(list(row({ count: '40' })))[0]?.count).toBe(40);
    // A count nobody can read is zero here, and the fold in core opens the finding anyway.
    expect(readSentryIssues(list(row({ count: 'many' })))[0]?.count).toBe(0);
  });

  it('reads a row with no culprit and no level', () => {
    const [one] = readSentryIssues(list(row({ culprit: null, level: undefined })));

    expect(one?.culprit).toBe('');
    expect(one?.level).toBe('');
  });

  // The id is the fingerprint of the finding. A finding under a made-up id could never be merged with
  // the real issue again, and the cursor keeps these ids in a list separated by spaces.
  it('drops a row whose id is missing, empty or holds a space', () => {
    expect(readSentryIssues(list(row({ id: undefined }), row({ id: '' }), row({ id: '45 01' }), row()))).toHaveLength(1);
  });

  // The one thing an error tracker adapter may never do. An empty list reads as a project whose errors
  // are all resolved, so a refusal shaped as anything but rows has to throw.
  it('refuses an answer that is not a list of issues', () => {
    expect(() => readSentryIssues('{"detail":"Invalid token"}')).toThrow(/not a list of issues/);
    expect(() => readSentryIssues('')).toThrow(/could not read/);
  });

  // The same refusal as a body that is not an array, and for the same reason. One field name read
  // wrong drops every row at once, and an empty list would tell a person their project is clean.
  it('refuses an answer whose rows all failed to key', () => {
    expect(() => readSentryIssues(list(row({ id: undefined }), row({ id: '' })))).toThrow(/read an id on none of them/);
    expect(() => readSentryIssues(list({ detail: 'no access to this issue' }))).toThrow(/one issue/);
    // A project with nothing unresolved answers an empty array, which is not the same thing.
    expect(readSentryIssues(list())).toEqual([]);
  });

  // A proxy or a sign-in page in front of the API. It gets its own sentence, because the fix is on this
  // machine and not in Sentry.
  it('names a web page from the network as its own problem', () => {
    expect(() => readSentryIssues('<!doctype html><html><body>Sign in</body></html>')).toThrow(/web page instead of data/);
  });
});

describe('the path', () => {
  it('asks for the unresolved issues of one project, up to the limit', () => {
    expect(sentryIssuesPath('your-org', 'recipes-api', 30)).toBe('/api/0/projects/your-org/recipes-api/issues/?query=is%3Aunresolved&limit=30');
  });

  it('keeps the page inside what the API allows', () => {
    expect(sentryIssuesPath('your-org', 'recipes-api', 5_000)).toContain('limit=100');
    expect(sentryIssuesPath('your-org', 'recipes-api', 0)).toContain('limit=1');
  });

  // A typed name may not add a segment or a query of its own to the path.
  it('refuses an organization or a project that is not a slug', async () => {
    const { fetcher, calls } = http(200, list());

    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org/../other', 'recipes-api', 30, signal())).rejects.toThrow(/is not a Sentry organization and project/);
    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', 'recipes api', 30, signal())).rejects.toThrow(/is not a Sentry organization and project/);
    expect(calls).toEqual([]);
  });

  // `..` holds no character the slug test would catch on its own, and `new URL` resolves the segment
  // away, so the call would carry the Auth token to a path nobody wrote on the form.
  it('refuses a name that is only dots, which would move the path', async () => {
    const { fetcher, calls } = http(200, list());

    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), '..', 'recipes-api', 30, signal())).rejects.toThrow(/is not a Sentry organization and project/);
    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', '.', 30, signal())).rejects.toThrow(/is not a Sentry organization and project/);
    expect(calls).toEqual([]);
  });
});

describe('a refusal', () => {
  const refusal = (status: number, headers: Record<string, string> = {}) => sentryRefused({ status, headers, body: '{"detail":"no"}' });

  it('sends a refused token to a new token with the two scopes', () => {
    expect(refusal(401)).toContain('project:read and event:read');
    expect(refusal(401)).toContain('paste it into this source');
  });

  // 403 is the token that is real and may not read this project, which is a different fix from 401.
  it('sends a token without the scope to its scopes', () => {
    expect(refusal(403)).toContain('took the Auth token and refused the call');
    expect(refusal(403)).toContain('Check its scopes');
  });

  it('names the wait a rate limited call was given', () => {
    expect(refusal(429, { 'retry-after': '90' })).toContain('Wait 90 seconds');
    // A header that is a date, or no header at all, leaves a sentence with no number in it.
    expect(refusal(429, { 'retry-after': 'Mon, 28 Sep 2026 10:00:00 GMT' })).toContain('Wait a few minutes');
    expect(refusal(429)).toContain('Wait a few minutes');
  });

  it('sends a project that is not there to the two names on the form', () => {
    expect(refusal(404)).toContain('Check the organization and the project in the source on the Scout page');
  });

  it('names the status where it has no sentence of its own', () => {
    expect(refusal(500)).toContain('Sentry answered 500');
  });

  // A proxy answers its own status with a page. The status says nothing a person can act on and the
  // page does.
  it('names a web page from the network whatever status it came with', () => {
    expect(sentryRefused({ status: 502, headers: {}, body: '<html><body>Bad gateway</body></html>' })).toContain('web page instead of data');
    // Including a status Sentry has its own sentence for. A captive portal answers 401 with a sign-in
    // page, and sending the person to make a new token would replace a token that was never the problem.
    const portal = sentryRefused({ status: 401, headers: {}, body: '<!doctype html><html><body>Sign in</body></html>' });
    expect(portal).toContain('web page instead of data');
    expect(portal).not.toContain('Make a new token');
  });
});

describe('the call', () => {
  it('puts the Auth token in the header and never in the path', async () => {
    const { fetcher, calls } = http(200, list(row()));

    const issues = await sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', 'recipes-api', 30, signal());

    expect(issues).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://sentry.io/api/0/projects/your-org/recipes-api/issues/?query=is%3Aunresolved&limit=30');
    expect(calls[0]?.headers.authorization).toBe('Bearer abc123notatoken');
    expect(calls[0]?.url).not.toContain('abc123notatoken');
  });

  it('throws the refusal sentence for a status that is not 200', async () => {
    const { fetcher } = http(429, '{"detail":"rate limited"}', { 'retry-after': '30' });

    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', 'recipes-api', 30, signal())).rejects.toThrow(/Wait 30 seconds/);
  });

  // A transport error can carry the request that caused it, headers and all, so its own message and its
  // cause never travel. The sentence is this file's own.
  it('says it could not reach Sentry without repeating what the transport said', async () => {
    const fetcher: SentryHttp = () => Promise.reject(new Error('connect ECONNREFUSED with authorization: Bearer abc123notatoken'));

    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', 'recipes-api', 30, signal())).rejects.toThrow(
      /Nolzu could not reach sentry.io/,
    );
    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', 'recipes-api', 30, signal())).rejects.not.toThrow(/abc123notatoken/);
  });

  it('says so when Sentry did not answer in time', async () => {
    const stopped = AbortSignal.abort();
    const fetcher: SentryHttp = () => Promise.reject(new Error('aborted'));

    await expect(sentryIssues(sentryCall('abc123notatoken', fetcher), 'your-org', 'recipes-api', 30, stopped)).rejects.toThrow(/did not answer in time/);
  });
});
