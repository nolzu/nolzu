import { describe, expect, it } from 'vitest';
import {
  flattenAdf,
  JIRA_FIELDS,
  type JiraAnswer,
  jiraState,
  LOGIN_REASON,
  readIssue,
  refusalSays,
  searchPath,
  tokenRefused,
} from './jira-tickets.ts';

// Every fixture here is built from what a real site answered on 2026-09-25. The site, the account
// and the issue text are made up: `PROJ-123` on https://example.atlassian.net. The adapter tests in
// `packages/runner/src/tickets/jira.test.ts` build the same fixtures, because a fixture shared
// across two packages would have to ship from `src`.
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
// Written out twice on purpose, so the test below claims something about the 2026-09-25 reads rather
// than comparing one constant with itself.
const MISSING_BODY = JSON.stringify({
  errorMessages: ['Issue does not exist or you do not have permission to see it.'],
  errors: {},
});

const REFUSED_TOKEN_BODY = JSON.stringify({
  errorMessages: ['Issue does not exist or you do not have permission to see it.'],
  errors: {},
});

const RATE_LIMIT = { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '999' };

const missing = (): JiraAnswer => ({ status: 404, headers: RATE_LIMIT, body: MISSING_BODY });
const refusedToken = (): JiraAnswer => ({
  status: 404,
  headers: { ...RATE_LIMIT, [LOGIN_REASON]: 'AUTHENTICATED_FAILED' },
  body: REFUSED_TOKEN_BODY,
});

describe('tokenRefused', () => {
  // The main reason this adapter exists.
  it('tells a refused token from a missing issue, which answer the same 404 and the same sentence', () => {
    expect(missing().body).toBe(refusedToken().body);
    expect(missing().status).toBe(refusedToken().status);

    expect(tokenRefused(missing().headers)).toBe(false);
    expect(tokenRefused(refusedToken().headers)).toBe(true);
  });

  it('reads the header whatever case it arrives in, and whatever it is listed with', () => {
    expect(tokenRefused({ 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' })).toBe(true);
    expect(tokenRefused({ [LOGIN_REASON]: 'AUTHENTICATED_FAILED,AUTHENTICATION_DENIED' })).toBe(true);
  });

  it('is not tripped by another reason, such as a login that worked', () => {
    expect(tokenRefused({ [LOGIN_REASON]: 'OK' })).toBe(false);
    expect(tokenRefused({})).toBe(false);
  });
});

describe('flattenAdf', () => {
  it('reads a document as the text a person wrote', () => {
    expect(flattenAdf(adf('Match ingredients too.', 'Fuzzy is fine.'))).toBe('Match ingredients too.\n\nFuzzy is fine.');
  });

  // The v2 API answers a plain string for the same field, and an empty description is null on both.
  it('takes a plain string and nothing as they are', () => {
    expect(flattenAdf('already text')).toBe('already text');
    expect(flattenAdf(null)).toBe('');
    expect(flattenAdf(undefined)).toBe('');
  });

  it('keeps the words of a link, a list, a heading and a code block', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open the box' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read the docs', marks: [{ type: 'link', attrs: { href: `${SITE}/docs` } }] }] }] },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'pnpm test' }] },
      ],
    };

    expect(flattenAdf(doc)).toBe('Steps\n\nOpen the box\n\nRead the docs\n\npnpm test');
  });

  it('keeps a mention and an emoji as their words, and a line break as a line break', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: '1', text: '@Reviewer' } },
            { type: 'text', text: ' please look' },
            { type: 'hardBreak' },
            { type: 'text', text: 'today' },
            { type: 'emoji', attrs: { shortName: ':wave:', text: 'wave' } },
          ],
        },
      ],
    };

    expect(flattenAdf(doc)).toBe('@Reviewer please look\ntodaywave');
  });

  // Named rather than hidden: these carry no text, so the flattener drops them.
  it('drops a node that has neither text nor content', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'a', type: 'file' } }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'After the picture' }] },
      ],
    };

    expect(flattenAdf(doc)).toBe('After the picture');
  });

  // A shape nobody planned for must not take the read down with it, and must not leave the word
  // "undefined" in a card body either.
  it('answers nothing for something that is not a document', () => {
    expect(flattenAdf(42)).toBe('');
    expect(flattenAdf({ type: 'doc', content: 'not a list' })).toBe('');
    expect(flattenAdf({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] })).toBe('');
  });

  // What a table reads as on a card, which is one cell to a line. Every cell holds a paragraph, so
  // the flattener names no cell of its own, and this test pins the reading rather than a branch.
  it('reads a table as one cell to a line', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Flour' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '200g' }] }] },
              ],
            },
          ],
        },
      ],
    };

    expect(flattenAdf(doc)).toBe('Flour\n\n200g');
  });
});

describe('jiraState', () => {
  // Every project names its own statuses, so only the category reads the same across sites.
  it('reads the category and not the status name', () => {
    expect(jiraState({ statusCategory: { key: 'done' } })).toBe('closed');
    expect(jiraState({ statusCategory: { key: 'indeterminate' } })).toBe('open');
    expect(jiraState({ statusCategory: { key: 'new' } })).toBe('open');
    expect(jiraState(undefined)).toBe('open');
  });
});

describe('readIssue', () => {
  it('reads a ticket back with the fields a card needs', () => {
    expect(readIssue(issue('PROJ-123'))).toEqual({
      key: 'PROJ-123',
      title: 'Search by ingredient',
      body: 'Match ingredients too.',
      state: 'open',
      url: `${SITE}/browse/PROJ-123`,
      parentKey: null,
    });
  });

  it('reads a closed ticket as closed, and the parent of a sub-task', () => {
    const found = readIssue(issue('PROJ-124', {}, { status: { statusCategory: { key: 'done' } }, parent: { key: 'PROJ-1' } }));

    expect(found).toMatchObject({ state: 'closed', parentKey: 'PROJ-1' });
  });

  // A card with a relative link on it is a link that goes nowhere, so no link is the honest answer.
  it('leaves the link empty for an issue that does not name its own site', () => {
    expect(readIssue(issue('PROJ-123', { self: undefined }))).toMatchObject({ key: 'PROJ-123', url: null });
    expect(readIssue(issue('PROJ-123', { self: 'not an address' }))).toMatchObject({ url: null });
  });

  it('answers nothing for a body that is not an issue', () => {
    expect(readIssue('<html>a proxy page</html>')).toBeNull();
    expect(readIssue(JSON.stringify({ errorMessages: ['nope'] }))).toBeNull();
  });
});

describe('the path of one issue', () => {
  it('asks for the fields a ticket is built from, and no others', () => {
    expect(JIRA_FIELDS.split(',').sort()).toEqual(['description', 'parent', 'status', 'summary']);
    expect(JIRA_FIELDS).not.toContain('labels');
  });
});

describe('searchPath', () => {
  it('caps the page at a hundred, whatever limit it was handed', () => {
    expect(searchPath(['PROJ'], 5000, null)).toContain('maxResults=100');
    expect(searchPath(['PROJ'], 0, null)).toContain('maxResults=1');
  });

  // The keys are pasted into the query as text, so a name that is not a key would add a clause of
  // its own and read projects nobody asked for. An empty list asks `project in ()`, which is a 400.
  it('refuses a name that is not a project key, and an empty list', () => {
    expect(() => searchPath(['A) OR project = OPS AND (1=1'], 30, null)).toThrow(/reads a project by its key/);
    expect(() => searchPath([], 30, null)).toThrow(/reads a project by its key/);
  });

  // A query the person typed names its own projects, so the guard above must not fire on it.
  it('takes the query the person typed with no projects beside it', () => {
    expect(searchPath([], 30, null, 'project = PROJ AND status = Open')).toContain('jql=project+%3D+PROJ+AND+status+%3D+Open');
  });
});

describe('refusalSays', () => {
  it('gives Jira its own words back', () => {
    expect(refusalSays(JSON.stringify({ errorMessages: ['Unbounded JQL queries are not allowed here.'] }))).toBe(
      'Unbounded JQL queries are not allowed here.',
    );
  });

  it('gives nothing when there is nothing to quote', () => {
    expect(refusalSays('<html>gateway timeout</html>')).toBeNull();
    expect(refusalSays(JSON.stringify({ errorMessages: [] }))).toBeNull();
    expect(refusalSays(JSON.stringify({ errorMessages: ['  '] }))).toBeNull();
  });
});
