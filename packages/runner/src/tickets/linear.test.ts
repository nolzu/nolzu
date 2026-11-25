import type { TicketRef } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CallLinear,
  ISSUES_QUERY,
  KEY_REFUSED,
  LINEAR_API,
  type LinearAnswer,
  type LinearFetch,
  linearCall,
  linearIssues,
  linearState,
  linearTicket,
  MAX_REFS,
  readPage,
  reasonOf,
} from './linear.ts';

/**
 * HAND WRITTEN, AND NOT RECORDED.
 *
 * No answer from Linear has been read here, and none exists anywhere in this project: the adapter
 * was built without a Linear account on purpose. Every fixture
 * below is written from Linear's documentation. Treat a Linear ticket as unverified until somebody
 * records one real answer, and read these fixtures as what the parser expects rather than as evidence
 * of what Linear sends.
 *
 * The first real call has to confirm eleven things the code and these tests are built on.
 *
 * About the call: that a POST of `{ query, variables }` to https://api.linear.app/graphql is how a
 * read is made, that the Authorization header carries a personal API key on its own with no Bearer in
 * front of it, that a key Linear refuses answers HTTP 401 rather than 200 with an `errors` array, and
 * what a throttled call answers, which this version reads as a plain refusal.
 *
 * About the query: that `issues` takes `filter`, `first`, `after` and `orderBy`, that `orderBy`
 * accepts the enum word `updatedAt` and sorts newest first, that `first: 50` is inside the page cap,
 * and that the answer carries `pageInfo { hasNextPage endCursor }` with `endCursor` continuing the
 * list through `after`.
 *
 * About the node: that an issue answers `identifier` as PROJ-123, `title`, `description` as markdown
 * or null, `url`, and `state { type }`, and that the state types are the words triage, backlog,
 * unstarted, started, completed and canceled, with canceled spelled with one l.
 *
 * About the filter: that `IssueFilter` holds `team: { key: { eq } }` and `{ key: { in } }`,
 * `number: { eq }`, `state: { type: { nin } }`, `title: { containsIgnoreCase }` and `or` as a list of
 * filters, and that two fields of one filter are an AND.
 *
 * And the one that decides whether a refusal can read as an empty backlog: that a query Linear
 * refuses answers HTTP 200 with a non-empty `errors` array and a null `data`.
 */

const issue = (identifier: string, extra: Record<string, unknown> = {}) => ({
  identifier,
  title: 'Search by ingredient',
  description: 'Match ingredients too.',
  url: `https://linear.app/example/issue/${identifier}`,
  state: { type: 'started' },
  ...extra,
});

const page = (rows: object[], next: string | null = null): string =>
  JSON.stringify({
    data: { issues: { nodes: rows, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
  });

// What a refused query looks like: HTTP 200, a reason in `errors`, and no data at all.
const refusedQuery = (message = 'Argument Validation Error'): string => JSON.stringify({ data: null, errors: [{ message }] });

const ok = (body: string): LinearAnswer => ({ status: 200, body });

const answers = (...given: LinearAnswer[]): { call: CallLinear; asked: { query: string; variables: Readonly<Record<string, unknown>> }[] } => {
  const asked: { query: string; variables: Readonly<Record<string, unknown>> }[] = [];
  return {
    asked,
    call: async (query, variables) => {
      const answer = given[Math.min(asked.length, given.length - 1)];
      asked.push({ query, variables });
      if (answer === undefined) throw new Error('the test gave no answer');
      return answer;
    },
  };
};

const ref = (key: string): TicketRef => ({ kind: 'external', key });
const signal = (): AbortSignal => AbortSignal.timeout(1000);

describe('ISSUES_QUERY', () => {
  // Without this the selection can be cut and every test below stays green, because the fixtures
  // carry the fields whatever the query asked for. A card would then be drawn with no body and no
  // state.
  it('asks for every field a card is built from, and for the page cursor', () => {
    for (const field of ['identifier', 'title', 'description', 'url', 'state { type }', 'hasNextPage', 'endCursor', 'orderBy: updatedAt']) {
      expect(ISSUES_QUERY, field).toContain(field);
    }
  });

  it('is a read, and carries no value of its own', () => {
    expect(ISSUES_QUERY).not.toContain('mutation');
    // Every typed value travels as a variable, so there is no text to escape and no name rule to keep.
    expect(ISSUES_QUERY).toContain('$filter: IssueFilter');
  });
});

describe('linearState', () => {
  it.each([
    ['triage', 'open'],
    ['backlog', 'open'],
    ['unstarted', 'open'],
    ['started', 'open'],
    ['completed', 'closed'],
    ['canceled', 'closed'],
    // A type this version does not know reads as open, because a ticket wrongly called closed drops
    // off the board with nothing saying why.
    ['somethingElse', 'open'],
  ])('reads %s as %s', (type, state) => {
    expect(linearState({ type })).toBe(state);
  });

  it('reads a missing state as open', () => {
    expect(linearState(null)).toBe('open');
    expect(linearState(undefined)).toBe('open');
  });
});

describe('linearTicket', () => {
  it('maps an issue into the shared ticket shape', () => {
    expect(linearTicket(issue('PROJ-123'))).toEqual({
      key: 'PROJ-123',
      title: 'Search by ingredient',
      body: 'Match ingredients too.',
      state: 'open',
      url: 'https://linear.app/example/issue/PROJ-123',
      parentKey: null,
    });
  });

  it('takes an issue with no description and no url', () => {
    expect(linearTicket(issue('PROJ-9', { description: null, url: null }))).toMatchObject({ body: '', url: null });
  });

  // A row with no identifier is no ticket. A card keyed on an empty string would collide with every
  // other such card.
  it.each([{}, { identifier: '' }, { identifier: 'proj-1' }, { identifier: 'PROJ' }, { identifier: 7 }])('refuses the row %j', (row) => {
    expect(linearTicket(row as { identifier?: string })).toBeNull();
  });
});

describe('readPage', () => {
  it('reads the rows and the cursor of a page that has more', () => {
    expect(readPage(page([issue('PROJ-1')], 'cursor-2'))).toMatchObject({ after: 'cursor-2' });
    expect(readPage(page([issue('PROJ-1')], 'cursor-2')).rows).toHaveLength(1);
  });

  // An `endCursor` on the last page would cost one call per check that answers the same rows again.
  it('keeps no cursor once Linear says there is no next page', () => {
    expect(readPage(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: 'cursor-2' } } } })).after).toBeNull();
  });

  /**
   * The bug this whole file exists to keep out.
   *
   * A refused query is HTTP 200, so the status says nothing. Read as data, it is a null `issues` and
   * no rows, which a caller reads as a team with no open tickets. The same shape was found in the
   * GitHub adapter this phase.
   */
  it('throws on a refusal that came back as 200, and says what Linear said', () => {
    expect(() => readPage(refusedQuery('Access denied'))).toThrow(/refused the query. Access denied/);
  });

  it('throws on an errors array with nothing readable in it', () => {
    expect(() => readPage(JSON.stringify({ data: null, errors: [{}] }))).toThrow(/gave no reason/);
  });

  // The sentence and not a bare throw. A crash inside the parser would pass a bare `toThrow()`, and
  // its message is what reaches the Scout screen.
  it.each([
    ['nothing readable', 'not json at all', /could not read/],
    ['a body of the word null', 'null', /could not read/],
    ['no data', JSON.stringify({}), /without a list of issues/],
    ['a null issues', JSON.stringify({ data: { issues: null } }), /without a list of issues/],
    ['no nodes', JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false } } } }), /without a list of issues/],
    ['nodes that are not a list', JSON.stringify({ data: { issues: { nodes: { message: 'slow down' } } } }), /without a list of issues/],
  ])('throws rather than answer an empty backlog to %s', (_what, body, said) => {
    expect(() => readPage(body)).toThrow(said);
  });

  // There is more and there is no way to ask for it. Handing this page back would be a part of the
  // list that the caller reads as all of it.
  it('throws when Linear says there is more and sends no cursor', () => {
    const body = JSON.stringify({ data: { issues: { nodes: [issue('PROJ-1')], pageInfo: { hasNextPage: true, endCursor: null } } } });

    expect(() => readPage(body)).toThrow(/no cursor/);
  });

  // `({}).length` is undefined, so a length test on its own reads a field level refusal with a partial
  // answer as a clean answer.
  it('throws on an errors value that is not an array', () => {
    const body = JSON.stringify({
      data: { issues: { nodes: [issue('PROJ-1')], pageInfo: { hasNextPage: false } } },
      errors: { message: 'permission denied on one field' },
    });

    expect(() => readPage(body)).toThrow(/refused the query/);
  });

  it('answers an empty list only where Linear answered one', () => {
    expect(readPage(page([]))).toEqual({ rows: [], after: null });
  });
});

describe('reasonOf', () => {
  it('is what Linear said, and null where it said nothing', () => {
    expect(reasonOf(refusedQuery('Rate limit exceeded'))).toBe('Rate limit exceeded');
    expect(reasonOf('<html>502</html>')).toBeNull();
    expect(reasonOf(JSON.stringify({ errors: [{ message: '   ' }] }))).toBeNull();
  });
});

describe('get', () => {
  it('asks for every ref in one call, by team key and number', async () => {
    const { call, asked } = answers(ok(page([issue('PROJ-1'), issue('OPS-7')])));

    const results = await linearIssues(call).get([ref('PROJ-1'), ref('OPS-7')], signal());

    expect(asked).toHaveLength(1);
    expect(asked[0]?.variables).toMatchObject({
      filter: {
        or: [
          { team: { key: { eq: 'PROJ' } }, number: { eq: 1 } },
          { team: { key: { eq: 'OPS' } }, number: { eq: 7 } },
        ],
      },
      first: 2,
    });
    expect(results.map((one) => one.ticket?.key)).toEqual(['PROJ-1', 'OPS-7']);
  });

  // A caller that sends several refs and matches them back by position would otherwise put the wrong
  // ticket on the wrong card.
  it('answers in the order the refs came, whatever order Linear used', async () => {
    const { call } = answers(ok(page([issue('OPS-7'), issue('PROJ-1')])));

    const results = await linearIssues(call).get([ref('PROJ-1'), ref('OPS-7')], signal());

    expect(results.map((one) => one.ticket?.key)).toEqual(['PROJ-1', 'OPS-7']);
  });

  it('reports the ref Linear did not answer as not found', async () => {
    const { call } = answers(ok(page([issue('PROJ-1')])));

    const results = await linearIssues(call).get([ref('PROJ-1'), ref('PROJ-2')], signal());

    expect(results).toMatchObject([
      { notFound: false, ticket: { key: 'PROJ-1' } },
      { notFound: true, ticket: null },
    ]);
  });

  // Nothing was asked about these, so nothing is known. `notFound: true` would be a claim, and the
  // caller would tell a person their ticket is gone.
  it('claims nothing about a ref it cannot read, and asks nothing when no ref is readable', async () => {
    const { call, asked } = answers(ok(page([])));

    const results = await linearIssues(call).get([{ kind: 'text', text: 'write the docs' }, ref('proj-1')], signal());

    expect(asked).toEqual([]);
    expect(results).toMatchObject([
      { notFound: false, ticket: null },
      { notFound: false, ticket: null },
    ]);
  });

  // Linear said this page is not the whole answer, so the refs it left out are not missing tickets.
  it('refuses a page Linear itself called incomplete, rather than calling the rest missing', async () => {
    const { call } = answers(ok(page([issue('PROJ-1')], 'cursor-2')));

    await expect(linearIssues(call).get([ref('PROJ-1'), ref('PROJ-2')], signal())).rejects.toThrow(/only a part of the tickets/);
  });

  // PROJ-007 asks for number 7 and Linear answers PROJ-7. Matching on the typed text would report a
  // ticket that was read in the same call as a ticket that is not there.
  it('matches a zero padded ref to the issue Linear answered', async () => {
    const { call } = answers(ok(page([issue('PROJ-7')])));

    const results = await linearIssues(call).get([ref('PROJ-007')], signal());

    expect(results).toMatchObject([{ notFound: false, ticket: { key: 'PROJ-7' } }]);
  });

  it('refuses a refused key rather than reporting every ticket as gone', async () => {
    const { call } = answers({ status: 401, body: JSON.stringify({ errors: [{ message: 'Authentication required' }] }) });

    await expect(linearIssues(call).get([ref('PROJ-1')], signal())).rejects.toThrow(KEY_REFUSED);
  });

  // 403 is what a key with no access to the workspace gets, and it is the case where the sentence
  // about the key is the one the person needs.
  it('refuses a key Linear answered 403 to', async () => {
    const { call } = answers({ status: 403, body: '' });

    await expect(linearIssues(call).get([ref('PROJ-1')], signal())).rejects.toThrow(KEY_REFUSED);
  });

  it('refuses a server error rather than reporting every ticket as gone', async () => {
    const { call } = answers({ status: 502, body: '<html>bad gateway</html>' });

    await expect(linearIssues(call).get([ref('PROJ-1')], signal())).rejects.toThrow(/answered 502/);
  });

  // What Linear said has to reach the person. The status alone sends them looking in the wrong place.
  it('carries what Linear said about a status it has no words of its own for', async () => {
    const { call } = answers({ status: 500, body: JSON.stringify({ errors: [{ message: 'Internal error' }] }) });

    await expect(linearIssues(call).get([ref('PROJ-1')], signal())).rejects.toThrow(/answered 500\. Internal error/);
  });

  // A throttle is the one refusal where waiting is the whole fix.
  it('says a 429 is a rate limit rather than something the person must fix', async () => {
    const { call } = answers({ status: 429, body: JSON.stringify({ errors: [{ message: 'Rate limit exceeded' }] }) });

    await expect(linearIssues(call).get([ref('PROJ-1')], signal())).rejects.toThrow(/rate limiting this key.*Rate limit exceeded/);
  });

  it('refuses more refs than one page holds, instead of cutting the list', async () => {
    const { call, asked } = answers(ok(page([])));
    // The literal, because a cap read from the module would hold at any value. 50 is what Linear
    // documents as one page, and `get` puts every ref into one page.
    expect(MAX_REFS).toBe(50);
    const many = Array.from({ length: 51 }, (_, at) => ref(`PROJ-${at + 1}`));

    await expect(linearIssues(call).get(many, signal())).rejects.toThrow(new RegExp(`${MAX_REFS} Linear tickets`));
    expect(asked).toEqual([]);
  });
});

describe('search', () => {
  it('asks for the open issues of the teams it was given', async () => {
    const { call, asked } = answers(ok(page([issue('PROJ-1'), issue('PROJ-2')])));

    const found = await linearIssues(call).search({ limit: 30, repos: ['PROJ', 'OPS'] }, signal());

    expect(asked[0]?.variables).toMatchObject({
      filter: { team: { key: { in: ['PROJ', 'OPS'] } }, state: { type: { nin: ['completed', 'canceled'] } } },
      first: 30,
      after: null,
    });
    expect(found.map((one) => one.key)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('matches what the person typed against the title, and asks for nothing of the kind when they typed nothing', async () => {
    const { call, asked } = answers(ok(page([])));
    const adapter = linearIssues(call);

    await adapter.search({ limit: 5, repos: ['PROJ'], terms: '  ingredient  ' }, signal());
    await adapter.search({ limit: 5, repos: ['PROJ'], terms: '   ' }, signal());

    expect(asked[0]?.variables).toMatchObject({ filter: { title: { containsIgnoreCase: 'ingredient' } } });
    expect(JSON.stringify(asked[1]?.variables)).not.toContain('title');
  });

  it('follows the cursor until Linear stops offering one, and stops at the limit', async () => {
    const { call, asked } = answers(ok(page([issue('PROJ-1'), issue('PROJ-2')], 'cursor-2')), ok(page([issue('PROJ-3')])));

    const found = await linearIssues(call).search({ limit: 3, repos: ['PROJ'] }, signal());

    expect(found.map((one) => one.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(asked[1]?.variables).toMatchObject({ after: 'cursor-2', first: 1 });
  });

  it('never answers more than the caller asked for', async () => {
    const { call } = answers(ok(page([issue('PROJ-1'), issue('PROJ-2'), issue('PROJ-3')])));

    expect(await linearIssues(call).search({ limit: 2, repos: ['PROJ'] }, signal())).toHaveLength(2);
  });

  // The filter already asks for the open ones. This is the same rule on the row that came back, so a
  // workspace that answered something else does not put a closed ticket on a board.
  it('drops a closed row Linear sent anyway', async () => {
    const { call } = answers(ok(page([issue('PROJ-1', { state: { type: 'completed' } }), issue('PROJ-2')])));

    expect((await linearIssues(call).search({ limit: 30, repos: ['PROJ'] }, signal())).map((one) => one.key)).toEqual(['PROJ-2']);
  });

  it('stops a workspace that keeps offering pages, rather than answering half a list', async () => {
    const { call, asked } = answers(ok(page([issue('PROJ-1')], 'cursor-on')));

    await expect(linearIssues(call).search({ limit: 500, repos: ['PROJ'] }, signal())).rejects.toThrow(/kept offering more pages/);
    expect(asked).toHaveLength(10);
  });

  // Names were given and none is a team key, so nothing was asked. An empty list would answer a
  // question Linear never got.
  it('refuses names that are not team keys, and asks nothing', async () => {
    const { call, asked } = answers(ok(page([])));

    await expect(linearIssues(call).search({ limit: 30, repos: ['acme/app', 'proj'] }, signal())).rejects.toThrow(/reads a team by its key/);
    expect(asked).toEqual([]);
  });

  // Dropping the bad name would ask for a part of what the person typed and hand the answer back as
  // the whole of it.
  it('refuses the whole query when one name of several is not a team key', async () => {
    const { call, asked } = answers(ok(page([])));

    await expect(linearIssues(call).search({ limit: 30, repos: ['PROJ', 'acme/app'] }, signal())).rejects.toThrow(/These are not keys: acme\/app/);
    expect(asked).toEqual([]);
  });

  // Linear answered rows and none of them carried an identifier. An empty list would read as a team
  // with no tickets.
  it('throws on a page of rows it cannot read, rather than answering an empty team', async () => {
    const { call } = answers(ok(page([{ title: 'no identifier at all' }])));

    await expect(linearIssues(call).search({ limit: 30, repos: ['PROJ'] }, signal())).rejects.toThrow(/could not read/);
  });

  it('answers nothing for no teams at all, because a whole workspace is not what a caller meant', async () => {
    const { call, asked } = answers(ok(page([])));

    expect(await linearIssues(call).search({ limit: 30, repos: [] }, signal())).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('throws on a refusal that came back as 200, so no source reads it as a quiet team', async () => {
    const { call } = answers(ok(refusedQuery('Rate limit exceeded')));

    await expect(linearIssues(call).search({ limit: 30, repos: ['PROJ'] }, signal())).rejects.toThrow(/Rate limit exceeded/);
  });

  it('throws on a refused key', async () => {
    const { call } = answers({ status: 401, body: '' });

    await expect(linearIssues(call).search({ limit: 30, repos: ['PROJ'] }, signal())).rejects.toThrow(KEY_REFUSED);
  });
});

describe('linearCall', () => {
  const KEY = 'lin_api_notarealkey';

  const spy = (answer: Response): { fetcher: LinearFetch; sent: { url: string; init: Parameters<LinearFetch>[1] }[] } => {
    const sent: { url: string; init: Parameters<LinearFetch>[1] }[] = [];
    return { sent, fetcher: async (url, init) => { sent.push({ url, init }); return answer; } };
  };

  it('posts the document and the variables to the API, with the key in the header alone', async () => {
    const { fetcher, sent } = spy(new Response(page([issue('PROJ-1')]), { status: 200 }));

    const answer = await linearCall(KEY, fetcher)(ISSUES_QUERY, { first: 1 }, signal());

    expect(answer.status).toBe(200);
    expect(sent[0]?.url).toBe(LINEAR_API);
    expect(sent[0]?.init.method).toBe('POST');
    // The key on its own, with no Bearer in front of it, which is what a personal API key takes.
    expect(sent[0]?.init.headers.authorization).toBe(KEY);
    expect(JSON.parse(sent[0]?.init.body ?? '{}')).toMatchObject({ variables: { first: 1 } });
  });

  // The key belongs in one header. In the body it would reach a log the first time a call is traced.
  it('keeps the key out of the body', async () => {
    const { fetcher, sent } = spy(new Response(page([]), { status: 200 }));

    await linearCall(KEY, fetcher)(ISSUES_QUERY, { first: 1 }, signal());

    expect(sent[0]?.init.body).not.toContain(KEY);
  });

  it('hands the status back whatever it is, because a refusal is read above', async () => {
    const { fetcher } = spy(new Response('nope', { status: 429 }));

    expect(await linearCall(KEY, fetcher)(ISSUES_QUERY, {}, signal())).toEqual({ status: 429, body: 'nope' });
  });

  it('refuses a key with a space or a newline in it, and does not repeat it', async () => {
    const pasted = 'lin_api_one two';

    expect(() => linearCall(pasted)).toThrow(/not a Linear API key/);
    expect(() => linearCall(`${KEY}\n`, async () => new Response(''))).not.toThrow();
    try {
      linearCall(pasted);
    } catch (error) {
      expect((error as Error).message).not.toContain('one two');
    }
  });

  // Scout reads with a 30 second timeout, so a slow workspace lands here. The network sentence would
  // send the person to check a network that is fine.
  it('says Linear ran out of time when the signal was the reason', async () => {
    const stop = new AbortController();
    stop.abort();
    const boom: LinearFetch = async () => {
      throw new Error('aborted');
    };

    await expect(linearCall(KEY, boom)(ISSUES_QUERY, {}, stop.signal)).rejects.toThrow(/did not answer in time/);
  });

  // Never the transport error's own message and never it as a cause: a transport error can carry the
  // request that caused it, headers and all, so a cause chain in a log would be the key.
  it('says the network failed without repeating the key', async () => {
    const boom: LinearFetch = async () => {
      throw new Error(`connect ECONNREFUSED with authorization ${KEY}`);
    };

    await expect(linearCall(KEY, boom)(ISSUES_QUERY, {}, signal())).rejects.toThrow(/could not reach Linear/);
    const failed: unknown = await linearCall(KEY, boom)(ISSUES_QUERY, {}, signal()).catch((error: unknown) => error);
    expect((failed as Error).message).not.toContain(KEY);
  });
});
