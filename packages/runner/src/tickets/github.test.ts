import { describe, expect, it } from 'vitest';
import { isPlainName } from '../git/worktree.ts';
import { BATCH, branchPullsQuery, mergeQuery, readMergeStates, discussionsQuery, findBranchPulls, getPull, githubIssues, issueKey, issueQuery, listOpenPulls, openPullsQuery, pullKey, pullQuery, readBranchPulls, readIssues, readOpenPulls, readPullDiscussions, readPulls, stateOf, threadCommentsQuery, type RunGh } from './github.ts';

// Built from what the real API answered on 2026-09-24, not from documentation: a missing
// repository leaves its alias null, a missing issue leaves `issueOrPullRequest` null, both show up
// in `errors` as NOT_FOUND, and `gh` exits 1 while `data` still holds every alias that worked.
const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  __typename: 'Issue',
  number,
  title,
  body: 'what is wrong',
  state: 'OPEN',
  url: `https://github.com/acme/app/issues/${number}`,
  parent: null,
  ...extra,
});

const answered = (data: Record<string, unknown>, errors?: unknown[]): string =>
  JSON.stringify(errors === undefined ? { data } : { data, errors });

const ref = (number: number, repo = 'app', owner = 'acme') => ({ owner, repo, number });

// A `gh` that answers with what it was handed, and records what it was asked.
const gh = (stdout: string, code = 0): { run: RunGh; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return { code, stdout, stderr: '' };
    },
  };
};

describe('issueQuery', () => {
  it('asks for every ref in one document, under an alias each', () => {
    const query = issueQuery([ref(1), ref(2, 'other')]);

    expect(query).toContain('t0: repository(owner: "acme", name: "app")');
    expect(query).toContain('t1: repository(owner: "acme", name: "other")');
    expect(query).toContain('issueOrPullRequest(number: 1)');
  });

  // `issue` answers not found on a pull request number, which reads as a ticket that is gone
  // rather than as a number that is not a ticket.
  it('asks for an issue or a pull request, so the two can be told apart', () => {
    expect(issueQuery([ref(1)])).toContain('__typename');
    expect(issueQuery([ref(1)])).toContain('issueOrPullRequest');
  });

  // Without this the selection set can be cut to `number` alone and every test stays green,
  // because each readIssues fixture carries the fields whatever the query asked for. Production
  // would then make cards with an empty title and no url.
  it('asks for every field a ticket is built from', () => {
    const query = issueQuery([ref(1)]);

    for (const field of ['number', 'title', 'body', 'state', 'url', 'parent { number }']) {
      expect(query, field).toContain(field);
    }
  });

  it('refuses a name that would break out of the query', () => {
    expect(() => issueQuery([ref(1, 'app") { x } evil(owner: "a')])).toThrow(/not a repository name/);
    expect(() => issueQuery([ref(1, 'app', 'a b')])).toThrow(/not a repository name/);
  });

  // The top of the range matters as much as the bottom: a number past a GraphQL Int reaches the
  // document in exponent form, and the document then fails to parse as a whole.
  it.each([0, -1, 1.5, 2_147_483_648, 1e23])('refuses %s, which is no number to look up', (number) => {
    expect(() => issueQuery([ref(number)])).toThrow(/is not a number Nolzu can look up/);
  });

  it('takes the largest number GraphQL can carry', () => {
    expect(issueQuery([ref(2_147_483_647)])).toContain('number: 2147483647');
  });
});

describe('readIssues', () => {
  it('reads a ticket back with the fields a card needs', () => {
    const [found] = readIssues([ref(1)], answered({ t0: { issueOrPullRequest: issue(1, 'Retry drops a 429') } }));

    // Keyed like a pull request, with no owner, so the card gets a folder and a checkout.
    expect(found?.ticket).toEqual({
      key: 'app#1',
      title: 'Retry drops a 429',
      body: 'what is wrong',
      state: 'open',
      url: 'https://github.com/acme/app/issues/1',
      parentKey: null,
    });
    expect(found?.notFound).toBe(false);
  });

  // The whole reason this reads stdout rather than the exit code. `gh` exits 1 when one alias
  // failed, and throwing the body away would lose every ticket that worked.
  it('keeps the tickets that worked when another alias failed', () => {
    const results = readIssues(
      [ref(1), ref(2), ref(3, 'gone')],
      answered(
        { t0: { issueOrPullRequest: issue(1, 'First') }, t1: { issueOrPullRequest: null }, t2: null },
        [
          { type: 'NOT_FOUND', path: ['t1', 'issueOrPullRequest'] },
          { type: 'NOT_FOUND', path: ['t2'] },
        ],
      ),
    );

    expect(results[0]?.ticket?.title).toBe('First');
    // A missing issue and a repository that is not there, or that this login cannot see. The API
    // answers the same for all three, so all three read as not found.
    expect(results[1]).toMatchObject({ ticket: null, notFound: true });
    expect(results[2]).toMatchObject({ ticket: null, notFound: true });
  });

  // A pull request shares the number space with issues, and nothing but the answer tells the two
  // apart. The PR reviews board reads the same ref through `readPulls` instead.
  it('refuses a pull request, which is not a ticket', () => {
    const [found] = readIssues([ref(7)], answered({ t0: { issueOrPullRequest: { __typename: 'PullRequest', number: 7 } } }));

    expect(found?.ticket).toBeNull();
    expect(found?.notFound).toBe(true);
  });

  it('reads a closed issue as closed, and the parent of a sub-issue', () => {
    const [found] = readIssues(
      [ref(2)],
      answered({ t0: { issueOrPullRequest: issue(2, 'Done', { state: 'CLOSED', parent: { number: 1 } }) } }),
    );

    expect(found?.ticket?.state).toBe('closed');
    expect(found?.ticket?.parentKey).toBe('app#1');
  });

  // Not found would be a claim. A body nobody could read says nothing about whether the issue is
  // there, and a caller that believed it would put a card on the board for a ticket never read.
  it('says nothing about a ref when the answer is not readable', () => {
    const [found] = readIssues([ref(1)], 'gh: could not connect');

    expect(found?.ticket).toBeNull();
    expect(found?.notFound).toBe(false);
  });
});

describe('the adapter', () => {
  it('reads what gh printed even when gh exited non-zero', async () => {
    const { run } = gh(answered({ t0: { issueOrPullRequest: issue(1, 'Still here') } }), 1);

    const [found] = await githubIssues({ run, defaultOwner: null }).get(
      [{ kind: 'github', owner: 'acme', repo: 'app', number: 1 }],
      AbortSignal.timeout(1000),
    );

    expect(found?.ticket?.title).toBe('Still here');
  });

  // Both sides of the owner rule. A ref that names one is read; a ref that does not takes the
  // project's own remote, and with no remote it is left alone rather than read under a guess.
  it('fills a missing owner from the project remote, and skips the ref without one', async () => {
    const withRemote = gh(answered({ t0: { issueOrPullRequest: issue(5, 'From the remote') } }));
    const [found] = await githubIssues({ run: withRemote.run, defaultOwner: 'acme' }).get(
      [{ kind: 'github', owner: null, repo: 'app', number: 5 }],
      AbortSignal.timeout(1000),
    );
    expect(found?.ticket?.key).toBe('app#5');
    expect(withRemote.calls[0]?.join(' ')).toContain('owner: "acme"');

    const noRemote = gh(answered({}));
    const [none] = await githubIssues({ run: noRemote.run, defaultOwner: null }).get(
      [{ kind: 'github', owner: null, repo: 'app', number: 5 }],
      AbortSignal.timeout(1000),
    );
    // A result, not a gap: nothing was asked, so nothing is known, and `notFound` would be a claim.
    expect(none).toMatchObject({ ticket: null, notFound: false });
    // And it asked nothing at all, rather than reading a repository under a guessed owner.
    expect(noRemote.calls).toEqual([]);
  });

  it('leaves a ref of another ticket system alone', async () => {
    const { run, calls } = gh(answered({}));

    const results = await githubIssues({ run, defaultOwner: 'acme' }).get(
      [{ kind: 'external', key: 'PROJ-123' }],
      AbortSignal.timeout(1000),
    );

    expect(results).toMatchObject([{ ticket: null, notFound: false }]);
    expect(calls).toEqual([]);
  });

  // The positional trap. A caller that sends several refs and reads them back by index would put
  // the wrong ticket on the wrong card if a ref it cannot read were dropped.
  it('answers one result per ref, in the order they came', async () => {
    const { run } = gh(answered({ t0: { issueOrPullRequest: issue(9, 'Readable') } }));

    const results = await githubIssues({ run, defaultOwner: null }).get(
      [
        { kind: 'external', key: 'PROJ-123' },
        { kind: 'github', owner: 'acme', repo: 'app', number: 9 },
        { kind: 'github', owner: null, repo: 'app', number: 4 },
      ],
      AbortSignal.timeout(1000),
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.ticket).toBeNull();
    expect(results[1]?.ticket?.title).toBe('Readable');
    expect(results[2]?.ticket).toBeNull();
  });

  // One bad ref used to reject the whole read through Promise.all, so a hundred refs failed
  // because of one. It is left out of the query instead, and the rest come back.
  it('reads the good refs when one of them is a name the API would refuse', async () => {
    const { run, calls } = gh(answered({ t0: { issueOrPullRequest: issue(1, 'Fine') } }));

    const results = await githubIssues({ run, defaultOwner: null }).get(
      [
        { kind: 'github', owner: 'acme', repo: 'app', number: 1 },
        { kind: 'github', owner: 'acme', repo: 'app") { x } evil(owner: "a', number: 2 },
      ],
      AbortSignal.timeout(1000),
    );

    expect(results[0]?.ticket?.title).toBe('Fine');
    expect(results[1]).toMatchObject({ ticket: null, notFound: false });
    expect(calls[0]?.join(' ')).not.toContain('evil');
  });

  // Pinned, not derived. The test below counts against BATCH itself, so it stays green whatever
  // the number is, and a document of a thousand aliases would be refused by the API rather than
  // by anything here. The known pitfalls in `ARCHITECTURE.md` name twenty.
  it('asks for twenty at a time', () => {
    expect(BATCH).toBe(20);
  });

  it('splits a long read into documents of twenty', async () => {
    const { run, calls } = gh(answered({}));
    const refs = Array.from({ length: BATCH + 5 }, (_, at) => ({
      kind: 'github' as const,
      owner: 'acme',
      repo: 'app',
      number: at + 1,
    }));

    await githubIssues({ run, defaultOwner: null }).get(refs, AbortSignal.timeout(1000));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.join(' ')).toContain(`t${BATCH - 1}:`);
    expect(calls[0]?.join(' ')).not.toContain(`t${BATCH}:`);
  });

  it('searches open issues in the repositories it was given, and no pull requests', async () => {
    const { run, calls } = gh(
      JSON.stringify({
        items: [
          { number: 3, title: 'Cache drops rows', state: 'open', html_url: 'https://github.com/acme/app/issues/3', repository_url: 'https://api.github.com/repos/acme/app' },
        ],
      }),
    );

    const found = await githubIssues({ run, defaultOwner: null }).search({ limit: 10, repos: ['acme/app'] }, AbortSignal.timeout(1000));

    expect(found[0]?.key).toBe('app#3');
    const asked = calls[0]?.join(' ') ?? '';
    expect(asked).toContain('is:issue');
    expect(asked).toContain('repo:acme/app');
  });

  // `-X GET` is what keeps this read-only. `gh api` with `-f` fields defaults to POST, so three
  // deleted arguments would turn a search into a write and nothing else here would notice.
  it('searches with GET, open issues only, and a page the API will accept', async () => {
    const { run, calls } = gh(JSON.stringify({ items: [] }));

    await githubIssues({ run, defaultOwner: null }).search({ limit: 500, repos: ['acme/app'] }, AbortSignal.timeout(1000));

    const asked = calls[0] ?? [];
    expect(asked).toContain('-X');
    expect(asked).toContain('GET');
    expect(asked.join(' ')).toContain('is:open');
    // The API refuses a page above 100, so a limit above it is cut rather than sent.
    expect(asked.join(' ')).toContain('per_page=100');
  });

  /**
   * An unreadable answer is a refusal, not an empty backlog.
   *
   * A rate limited or unauthorised `gh api` prints readable JSON with no `items` in it, so this path is
   * reached with nothing wrong with the parse. An empty list there tells the caller the repository has
   * no open issues, and a Scout source built on it would report a clear backlog it never read.
   */
  it('asks nothing when no repository is named, and refuses a body it cannot read', async () => {
    const empty = gh(JSON.stringify({ items: [] }));
    expect(await githubIssues({ run: empty.run, defaultOwner: null }).search({ limit: 10, repos: [] }, AbortSignal.timeout(1000))).toEqual([]);
    expect(empty.calls).toEqual([]);

    const broken = gh('gh: rate limited');
    await expect(githubIssues({ run: broken.run, defaultOwner: null }).search({ limit: 10, repos: ['acme/app'] }, AbortSignal.timeout(1000))).rejects.toThrow(
      /could not read/,
    );

    // The case the paragraph above is really about, and the one the line before it does not reach:
    // a rate limited or unauthorised `gh api` prints READABLE JSON with no `items`, so it parses and
    // a catch around the parse never sees it. Without the array check that reads as a clear backlog.
    for (const message of ['API rate limit exceeded', 'Bad credentials']) {
      const refused = gh(JSON.stringify({ message }));
      await expect(githubIssues({ run: refused.run, defaultOwner: null }).search({ limit: 10, repos: ['acme/app'] }, AbortSignal.timeout(1000))).rejects.toThrow(
        /could not read/,
      );
    }
  });

  // The person's own qualifiers reach the API, after the two this adapter always sends. A source whose
  // screen collects a search field and then ignores it is worse than one that collects none.
  it('sends the qualifiers the caller was given, after its own', async () => {
    const { run, calls } = gh(JSON.stringify({ items: [] }));

    await githubIssues({ run, defaultOwner: null }).search({ limit: 10, repos: ['acme/app'], terms: 'label:bug' }, AbortSignal.timeout(1000));

    const asked = calls[0]?.join(' ') ?? '';
    expect(asked).toContain('label:bug');
    expect(asked.indexOf('is:issue')).toBeLessThan(asked.indexOf('label:bug'));
  });
});

describe('the key', () => {
  it('is the one the board shows', () => {
    expect(issueKey('acme', 'app', 42)).toBe('acme/app#42');
  });

  // GitHub names are case insensitive and the API answers in the canonical case. Without this,
  // `Acme/App#1` typed by hand and the same issue found by search are two cards.
  it('is the same whatever case a person typed', () => {
    expect(issueKey('Acme', 'App', 1)).toBe(issueKey('acme', 'app', 1));
  });
});

describe('the state', () => {
  // One rule for both paths, because GraphQL answers CLOSED and the search API answers closed.
  it('reads both spellings the two APIs use', () => {
    expect(stateOf('CLOSED')).toBe('closed');
    expect(stateOf('closed')).toBe('closed');
    expect(stateOf('OPEN')).toBe('open');
    expect(stateOf(undefined)).toBe('open');
  });
});

// The claim `readIssues` refuses to make through the parse failure, made through the other door.
// A query that failed whole, on bad credentials or a rate limit, answers errors with no data at
// all, and every ref would then read as a ticket that does not exist.
it('says nothing about any ref when the whole query failed', () => {
  const results = readIssues([ref(1), ref(2)], JSON.stringify({ errors: [{ message: 'Bad credentials' }] }));

  expect(results).toMatchObject([
    { ticket: null, notFound: false },
    { ticket: null, notFound: false },
  ]);
});

// HAND WRITTEN, AND NOT RECORDED. No pull request answer has been read from the real API here: a
// read would be a call to GitHub, and the tests make none. The envelope around it is recorded
// (the same `data` and `errors` shapes the issue answers above were measured in), but the fields
// inside the node are written from the schema, not from a measurement. The first real recording
// has to confirm the five facts the tests below are built on: `reviewDecision` is null while
// nobody has reviewed, `author` is null for an account that is gone, `commits(last: 1)` answers
// the head commit, `state` answers the literal word MERGED for a merged pull request, and
// `commits(last: 1)` on a pull request with no commit answers an empty `nodes` or a `nodes`
// holding null.
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest',
  number,
  title: 'Cache the recipe list',
  body: 'The list is read on every page, so it is cached for a minute.',
  url: `https://github.com/acme/app/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  author: { login: 'dana' },
  reviewDecision: 'APPROVED',
  commits: { nodes: [{ commit: { committedDate: '2026-09-25T09:00:00.000Z' } }] },
  ...extra,
});

describe('pullQuery', () => {
  // Without this the selection set can be cut and every test below stays green, because the
  // fixture carries the fields whatever the query asked for. The board would then draw a card
  // with no author, no decision and no age.
  it('asks for every field the card is built from', () => {
    const query = pullQuery([ref(1)]);

    for (const field of ['number', 'title', 'body', 'url', 'state', 'isDraft', 'author { login }', 'reviewDecision', 'commits(last: 1)', 'committedDate']) {
      expect(query, field).toContain(field);
    }
  });

  it('asks under the same alias scheme, and refuses a name that would break out', () => {
    expect(pullQuery([ref(1), ref(2, 'other')])).toContain('t1: repository(owner: "acme", name: "other")');
    expect(() => pullQuery([ref(1, 'app") { x } evil(owner: "a')])).toThrow(/not a repository name/);
  });
});

describe('readPulls', () => {
  it('reads a pull request back with every field the card draws', () => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7) } }));

    expect(found?.pull).toEqual({
      key: 'app#7',
      number: 7,
      title: 'Cache the recipe list',
      body: 'The list is read on every page, so it is cached for a minute.',
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
      draft: false,
      author: 'dana',
      decision: 'APPROVED',
      headCommittedAt: '2026-09-25T09:00:00.000Z',
    });
    expect(found?.notFound).toBe(false);
  });

  // The description is what the review judges the change against, and GitHub answers an empty string
  // for a pull request the author wrote none for.
  it('reads an empty description as empty text', () => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { body: '' }) } }));

    expect(found?.pull?.body).toBe('');
  });

  // The one thing that must never happen: a pull request nobody has looked at reading as approved.
  it.each([
    ['nobody has reviewed', null, 'REVIEW_REQUIRED'],
    ['a review is required', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED'],
    ['a word this version does not know', 'SOMETHING_ELSE', 'REVIEW_REQUIRED'],
    ['it is approved', 'APPROVED', 'APPROVED'],
    ['changes were asked for', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED'],
  ])('says %s', (_what, answer, decision) => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { reviewDecision: answer }) } }));

    expect(found?.pull?.decision).toBe(decision);
  });

  it('reads a draft, and a pull request whose author the answer does not carry', () => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { isDraft: true, author: null }) } }));

    expect(found?.pull).toMatchObject({ draft: true, author: null });
  });

  // `stateOf` answers open for anything that is not closed, so a merged pull request would sit on
  // the board as one still waiting for a review.
  it.each([
    ['MERGED', 'merged'],
    ['CLOSED', 'closed'],
    ['OPEN', 'open'],
  ])('reads %s as %s', (answer, state) => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { state: answer }) } }));

    expect(found?.pull?.state).toBe(state);
  });

  // Two shapes for a pull request with no commit, and neither is measured. The parser survives
  // both and claims no time, which is what the card draws as unknown.
  it.each<[string, unknown[]]>([
    ['an empty list', []],
    ['a list holding null', [null]],
  ])('claims no head commit time when commits answers %s', (_what, nodes) => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { commits: { nodes } }) } }));

    expect(found?.pull?.headCommittedAt).toBeNull();
  });

  // The head and the commit count are how a later read tells that the author pushed since the last
  // review round. Written from the schema like the rest of the node: `headRefOid` is the head commit
  // and `commits.totalCount` counts every commit of the pull request, not the one node asked for.
  it('reads the head commit and the commit count', () => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { headRefOid: 'a1b2c3', commits: { totalCount: 4, nodes: [] } }) } }));

    expect(found?.pull).toMatchObject({ headSha: 'a1b2c3', commits: 4 });
  });

  // An answer without them claims nothing, so a card never reads as pushed to on a missing field.
  it('leaves the head and the count out when the answer carries neither', () => {
    const [found] = readPulls([ref(7)], answered({ t0: { issueOrPullRequest: pull(7, { headRefOid: null, commits: { totalCount: 'four', nodes: [] } }) } }));

    expect(found?.pull).not.toHaveProperty('headSha');
    expect(found?.pull).not.toHaveProperty('commits');
  });

  // The mirror of the issue path, where a pull request number is refused as a ticket.
  it('refuses an issue number, which is not a pull request', () => {
    const [found] = readPulls([ref(12)], answered({ t0: { issueOrPullRequest: { __typename: 'Issue', number: 12 } } }));

    expect(found?.pull).toBeNull();
    expect(found?.notFound).toBe(true);
  });

  it('reads a missing pull request and a missing repository as not found', () => {
    const results = readPulls(
      [ref(7), ref(8, 'gone')],
      answered({ t0: { issueOrPullRequest: null }, t1: null }, [{ type: 'NOT_FOUND', path: ['t0', 'issueOrPullRequest'] }]),
    );

    expect(results).toMatchObject([
      { pull: null, notFound: true },
      { pull: null, notFound: true },
    ]);
  });

  // Nothing readable came back, so nothing is known. Not found would be a claim, and the board
  // would tell the person their pull request is gone when the call was the thing that failed.
  it.each([
    ['a body that is not json', 'Bad credentials'],
    ['an empty answer', ''],
    ['a query that failed whole', JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] })],
  ])('says nothing about the ref for %s', (_what, stdout) => {
    expect(readPulls([ref(7)], stdout)).toMatchObject([{ pull: null, notFound: false }]);
  });
});

describe('getPull', () => {
  it('asks gh for one graphql document, and nothing else', async () => {
    const fake = gh(answered({ t0: { issueOrPullRequest: pull(7) } }));

    const found = await getPull(fake.run, ref(7), AbortSignal.timeout(1000));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
    expect(fake.calls[0]?.[3]).toContain('issueOrPullRequest(number: 7)');
    expect(found.pull?.key).toBe('app#7');
  });

  // `gh api graphql` exits 1 when an alias failed and still prints the ones that worked.
  it('reads the body although gh exited 1', async () => {
    const fake = gh(answered({ t0: { issueOrPullRequest: pull(7) } }), 1);

    await expect(getPull(fake.run, ref(7), AbortSignal.timeout(1000))).resolves.toMatchObject({ pull: { number: 7 } });
  });
});

describe('pullKey', () => {
  // A key with a slash in it is not one plain name, and a card with such a key gets no folder to
  // keep a review round in. This is why a pull request card carries no owner in its key.
  it('is one plain name, unlike the issue key', () => {
    expect(pullKey('App', 42)).toBe('app#42');
    expect(isPlainName(pullKey('app', 42))).toBe(true);
    expect(isPlainName(issueKey('acme', 'app', 42))).toBe(false);
  });
});

// A DOCUMENTED SHAPE NOBODY HAS MEASURED. No answer to this list query has been read from the
// real API: a read would be a call to GitHub, and no test may make one. The shape is written from the
// GitHub GraphQL schema. One recorded `gh api graphql` answer has to confirm these field names before
// the reader is trusted: `repository` (null for a repository that is not there),
// `pullRequests(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC })`, its `nodes` list and `pageInfo { hasNextPage }`, and in
// each node the fields `pull` above is written with, and `latestOpinionatedReviews(last: 20)` with each
// node's `author { login } state submittedAt commit { oid }`, beside the top-level `viewer { login }`,
// and `asked: search(query: "... review-requested:@me", type: ISSUE)` with each node's `number`.
const openList = (nodes: unknown[], hasNextPage = false, viewer: string | null = 'me', asked: number[] = []) =>
  answered({ ...(viewer === null ? {} : { viewer: { login: viewer } }), repository: { pullRequests: { nodes, pageInfo: { hasNextPage } } }, asked: { nodes: asked.map((number) => ({ number })) } });

describe('openPullsQuery', () => {
  it('asks for the open pull requests of one repository with every field the card is built from', () => {
    const query = openPullsQuery({ owner: 'acme', repo: 'app' });

    expect(query).toContain('repository(owner: "acme", name: "app")');
    expect(query).toContain('pullRequests(states: OPEN, first: 100');
    expect(query).toContain('pageInfo { hasNextPage }');
    for (const field of ['number', 'title', 'body', 'url', 'state', 'isDraft', 'author { login }', 'reviewDecision', 'commits(last: 1)', 'committedDate']) {
      expect(query, field).toContain(field);
    }
  });

  it('refuses a name that would break out of the document', () => {
    expect(() => openPullsQuery({ owner: 'acme', repo: 'app") { x } evil(owner: "a' })).toThrow(/not a repository name/);
  });

  // Read pull requests is the one read that tells a card its head moved, so the list asks for both.
  it('asks for the head commit and the commit count', () => {
    const query = openPullsQuery({ owner: 'acme', repo: 'app' });

    expect(query).toContain('headRefOid');
    expect(query).toContain('commits(last: 1) { totalCount');
  });

  // The person's own review, apart from reviewDecision, which reads APPROVED on anybody's approval: the
  // login gh runs as, and each reviewer's newest opinionated review with its commit.
  it('asks for the login that runs gh and every reviewer opinionated review with its commit', () => {
    const query = openPullsQuery({ owner: 'acme', repo: 'app' });

    expect(query).toContain('viewer { login }');
    expect(query).toContain('latestOpinionatedReviews(last: 20) { nodes { author { login } state submittedAt commit { oid } } }');
    expect(pullQuery([{ owner: 'acme', repo: 'app', number: 7 }])).not.toContain('latestOpinionatedReviews');
  });

  // GitHub's own Review requests filter, which counts a request to a team the login is in.
  it('asks which open pull requests request the review of the login that runs gh', () => {
    expect(openPullsQuery({ owner: 'acme', repo: 'app' })).toContain('asked: search(query: "repo:acme/app is:pr is:open review-requested:@me", type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } }');
  });
});

describe('readOpenPulls', () => {
  it('reads two open pull requests as two', () => {
    const list = readOpenPulls({ owner: 'acme', repo: 'app' }, openList([pull(7), pull(9, { title: 'Show the cooking time' })]));

    expect(list.pulls.map((found) => found.key)).toEqual(['app#7', 'app#9']);
    expect(list.pulls[1]).toMatchObject({ number: 9, title: 'Show the cooking time', state: 'open', author: 'dana' });
    expect(list.more).toBe(false);
  });

  it('reads which of them ask for the review of the login', () => {
    expect([...readOpenPulls({ owner: 'acme', repo: 'app' }, openList([pull(7), pull(9)], false, 'me', [9])).asked]).toEqual([9]);
  });

  const review = (login: string, state: string, oid = 'h1', at = '2026-11-04T10:00:00Z') => ({ author: { login }, state, submittedAt: at, commit: { oid } });
  const reviewed = (...nodes: unknown[]) => pull(7, { latestOpinionatedReviews: { nodes } });

  it('reads the viewer own row of the opinionated reviews, with its commit', () => {
    const list = readOpenPulls({ owner: 'acme', repo: 'app' }, openList([reviewed(review('dana', 'APPROVED', 'h0'), review('Me', 'APPROVED')), pull(9, { latestOpinionatedReviews: { nodes: [] } })]));

    expect(list.pulls[0]?.ownReview).toEqual({ state: 'APPROVED', at: '2026-11-04T10:00:00Z', oid: 'h1' });
    expect(list.pulls[1]).not.toHaveProperty('ownReview');
  });

  it('leaves the own review out when only somebody else reviewed, or when the answer names no viewer', () => {
    expect(readOpenPulls({ owner: 'acme', repo: 'app' }, openList([reviewed(review('dana', 'APPROVED'))])).pulls[0]).not.toHaveProperty('ownReview');
    expect(readOpenPulls({ owner: 'acme', repo: 'app' }, openList([reviewed(review('me', 'APPROVED'))], false, null)).pulls[0]).not.toHaveProperty('ownReview');
  });

  it('reads a review with no commit as one with no oid', () => {
    const list = readOpenPulls({ owner: 'acme', repo: 'app' }, openList([reviewed({ author: { login: 'me' }, state: 'CHANGES_REQUESTED', submittedAt: null, commit: null })]));

    expect(list.pulls[0]?.ownReview).toEqual({ state: 'CHANGES_REQUESTED', at: null, oid: null });
  });

  it('reads an empty list as a repository with no open pull request', () => {
    expect(readOpenPulls({ owner: 'acme', repo: 'app' }, openList([])).pulls).toEqual([]);
  });

  it('says when the repository has more open pull requests than one answer holds', () => {
    expect(readOpenPulls({ owner: 'acme', repo: 'app' }, openList([pull(7)], true)).more).toBe(true);
  });

  // Only a page that says it has a next one is more. No page info is not a claim of more.
  it('says nothing of more when the answer has no page info', () => {
    expect(readOpenPulls({ owner: 'acme', repo: 'app' }, answered({ repository: { pullRequests: { nodes: [pull(7)] } }, asked: { nodes: [] } })).more).toBe(false);
  });

  // An answer the reader cannot read is never an empty board. A rate limit, a lost login or a
  // changed shape would otherwise tell the person their repository has nothing to review.
  it.each([
    ['a body that is not json', 'Bad credentials'],
    ['an empty answer', ''],
    ['a query that failed whole', JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] })],
    ['an answer with no list in it', answered({ repository: { pullRequests: {} } })],
    ['a list that is not a list', answered({ repository: { pullRequests: { nodes: 'none' } } })],
    ['a node with no number', openList([pull(7), { __typename: 'PullRequest', title: 'No number' }])],
    ['a node that is null', openList([pull(7), null])],
    ['a node numbered 0', openList([pull(7), pull(0)])],
    // Without it nothing says which are the person's, and adding every one is what flooded a board.
    ['an answer with no review requests in it', answered({ repository: { pullRequests: { nodes: [pull(7)], pageInfo: { hasNextPage: false } } } })],
  ])('refuses %s', (_what, stdout) => {
    expect(() => readOpenPulls({ owner: 'acme', repo: 'app' }, stdout)).toThrow(/could not read/);
  });

  it('refuses a repository GitHub does not show this login, with its own sentence', () => {
    expect(() => readOpenPulls({ owner: 'acme', repo: 'app' }, answered({ repository: null }, [{ type: 'NOT_FOUND', path: ['repository'] }]))).toThrow(
      /has no repository acme\/app/,
    );
  });
});

describe('listOpenPulls', () => {
  it('asks gh for one graphql document, and reads the answer although gh exited 1', async () => {
    const fake = gh(openList([pull(7)]), 1);

    const list = await listOpenPulls(fake.run, { owner: 'acme', repo: 'app' }, AbortSignal.timeout(1000));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
    expect(list.pulls.map((found) => found.key)).toEqual(['app#7']);
  });
});

// A DOCUMENTED SHAPE NOBODY HAS MEASURED, like the open list above. One recorded answer has to
// confirm `pullRequests(headRefName: ...)` with `orderBy: { field: CREATED_AT, direction: DESC }`, its
// `nodes` list, and `isCrossRepository` on each node before the reader is trusted.
const branchList = (...repos: (unknown[] | null)[]) =>
  answered(Object.fromEntries(repos.map((nodes, index) => [`t${index}`, nodes === null ? null : { pullRequests: { nodes } }])));
const ask = (repo = 'app', branch = 'APP-1-search') => ({ owner: 'acme', repo, branch });

describe('branchPullsQuery', () => {
  it('asks each repository for the pull requests whose head is the branch, newest first, with every field the card is built from', () => {
    const query = branchPullsQuery([ask(), ask('api')]);

    expect(query).toContain('t0: repository(owner: "acme", name: "app") { pullRequests(headRefName: "APP-1-search"');
    expect(query).toContain('t1: repository(owner: "acme", name: "api")');
    expect(query).toContain('orderBy: { field: CREATED_AT, direction: DESC }');
    for (const field of ['isCrossRepository', 'number', 'title', 'body', 'url', 'state', 'isDraft', 'author { login }', 'reviewDecision', 'commits(last: 1)', 'committedDate']) {
      expect(query, field).toContain(field);
    }
  });

  // A branch may hold a slash or a quote, which NAME refuses. It goes in as one string literal, so a
  // quote in it cannot close the string and add a field of its own.
  // A closed card's pull request block: who merged it and when, its size and branches, and the login
  // gh runs as, so it can say "merged by you".
  it('asks for the merge, the size and the branches, and for the login gh runs as', () => {
    const query = branchPullsQuery([ask()]);

    expect(query).toContain('viewer { login }');
    for (const field of ['mergedBy { login }', 'mergedAt', 'createdAt', 'additions', 'deletions', 'changedFiles', 'headRefName', 'baseRefName']) {
      expect(query, field).toContain(field);
    }
  });

  // Why an open pull request cannot merge, in the same document, so the timer and the press need no
  // second call.
  it('asks why it cannot merge: the merge state and the checks with their links', () => {
    const query = branchPullsQuery([ask()]);

    for (const field of ['mergeable', 'mergeStateStatus', 'statusCheckRollup { state contexts(first: 20)', '... on CheckRun { name conclusion status detailsUrl }', '... on StatusContext { context state targetUrl }']) {
      expect(query, field).toContain(field);
    }
  });

  it('keeps a branch with a slash and a quote inside one string', () => {
    expect(branchPullsQuery([ask('app', 'cook/APP-1 "x") { y }')])).toContain('headRefName: "cook/APP-1 \\"x\\") { y }"');
  });

  it('refuses a repository name that would break out of the document', () => {
    expect(() => branchPullsQuery([ask('app") { x } evil(owner: "a')])).toThrow(/not a repository name/);
  });
});

describe('readBranchPulls', () => {
  it('reads the newest pull request of each branch, with every field the card draws', () => {
    const found = readBranchPulls([ask(), ask('api')], branchList([pull(9, { state: 'MERGED', isCrossRepository: false }), pull(7, { isCrossRepository: false })], [pull(3, { isCrossRepository: false })]));

    expect(found).toEqual([
      { read: true, pull: expect.objectContaining({ key: 'app#9', number: 9, state: 'merged', author: 'dana', decision: 'APPROVED', headCommittedAt: '2026-09-25T09:00:00.000Z', draft: false }) },
      { read: true, pull: expect.objectContaining({ key: 'api#3', state: 'open' }) },
    ]);
  });

  // A fork may open a pull request from a branch of the same name. It is somebody else's change, and
  // reading it as the card's would mark the card merged when a stranger's work merged.
  it('passes over a pull request from a fork', () => {
    const [found] = readBranchPulls([ask()], branchList([pull(9, { isCrossRepository: true, state: 'MERGED' }), pull(7, { isCrossRepository: false })]));

    expect(found?.pull?.number).toBe(7);
  });

  it('reads who merged it, when, its size, its branches and the viewer', () => {
    const merged = pull(42, {
      state: 'MERGED',
      isCrossRepository: false,
      mergedBy: { login: 'dana' },
      mergedAt: '2026-10-20T10:36:00Z',
      createdAt: '2026-10-20T10:02:00Z',
      additions: 48,
      deletions: 6,
      changedFiles: 3,
      headRefName: 'APP-1-search',
      baseRefName: 'main',
    });
    const stdout = JSON.stringify({ data: { viewer: { login: 'dana' }, t0: { pullRequests: { nodes: [merged] } } } });

    expect(readBranchPulls([ask()], stdout)).toEqual([
      {
        read: true,
        viewer: 'dana',
        pull: expect.objectContaining({ mergedBy: 'dana', mergedAt: '2026-10-20T10:36:00Z', createdAt: '2026-10-20T10:02:00Z', additions: 48, deletions: 6, changedFiles: 3, headRef: 'APP-1-search', baseRef: 'main' }),
      },
    ]);
  });

  // An open pull request has no merger, and an answer without the fields claims none of them.
  it('leaves out the merge fields the answer did not carry', () => {
    const [found] = readBranchPulls([ask()], branchList([pull(7, { isCrossRepository: false, mergedBy: null, mergedAt: null })]));

    for (const key of ['mergedBy', 'mergedAt', 'createdAt', 'additions', 'deletions', 'changedFiles', 'headRef', 'baseRef', 'viewer']) {
      expect(found?.pull ?? {}, key).not.toHaveProperty(key);
    }
    expect(found).not.toHaveProperty('viewer');
  });

  // A pull request of nought added lines still says nought, and an empty or negative figure says nothing.
  it('keeps a zero count and drops an empty text or a negative count', () => {
    const [zero] = readBranchPulls([ask()], branchList([pull(7, { isCrossRepository: false, additions: 0, deletions: 0, changedFiles: 0 })]));
    expect(zero?.pull).toMatchObject({ additions: 0, deletions: 0, changedFiles: 0 });
    const [odd] = readBranchPulls([ask()], branchList([pull(7, { isCrossRepository: false, mergedAt: '', baseRefName: '', additions: -1 })]));
    for (const key of ['mergedAt', 'baseRef', 'additions']) expect(odd?.pull ?? {}, key).not.toHaveProperty(key);
  });

  it('reads why it cannot merge when the answer carries the merge fields, and claims nothing when it does not', () => {
    const blocked = pull(7, { isCrossRepository: false, reviewDecision: 'REVIEW_REQUIRED', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } });
    const [found] = readBranchPulls([ask()], branchList([blocked]));
    expect(found?.pull?.merge).toEqual({ blockers: [{ kind: 'conflict', base: 'main' }, { kind: 'approval' }], running: false });

    const [plain] = readBranchPulls([ask()], branchList([pull(7, { isCrossRepository: false })]));
    expect(plain?.pull ?? {}).not.toHaveProperty('merge');
  });

  it('reads a branch with no pull request as found nothing', () => {
    expect(readBranchPulls([ask()], branchList([]))).toEqual([{ read: true, pull: null }]);
  });

  // A repository GitHub does not show this login is not a branch with no pull request. Read as none,
  // a card with two repositories would read merged on the one that answered.
  it.each([
    ['a repository GitHub does not show', branchList(null)],
    ['an alias the answer does not hold', answered({})],
    ['a list that is not a list', answered({ t0: { pullRequests: { nodes: 'none' } } })],
    ['a node with no number', branchList([{ __typename: 'PullRequest', title: 'No number' }])],
    ['a node that is null', branchList([pull(7), null])],
  ])('knows nothing of %s', (_what, stdout) => {
    expect(readBranchPulls([ask()], stdout)).toEqual([{ read: false, pull: null }]);
  });

  // A whole query that failed is a lost login or a rate limit, and says so rather than reading as
  // a board where no card has a pull request.
  it.each([
    ['a body that is not json', 'Bad credentials'],
    ['an empty answer', ''],
    ['a query that failed whole', JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] })],
  ])('refuses %s', (_what, stdout) => {
    expect(() => readBranchPulls([ask()], stdout)).toThrow(/could not read/);
  });
});

describe('findBranchPulls', () => {
  it('asks gh for one graphql document, and reads the answer although gh exited 1', async () => {
    const fake = gh(branchList([pull(7)], []), 1);

    const found = await findBranchPulls(fake.run, [ask(), ask('api')], AbortSignal.timeout(1000));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
    expect(found.map((one) => one.pull?.key ?? null)).toEqual(['app#7', null]);
  });

  it('asks twenty repositories per call and keeps each answer in its place', async () => {
    const calls: string[] = [];
    const run: RunGh = async (args) => {
      const query = args[3] ?? '';
      calls.push(query);
      const names = [...query.matchAll(/(t\d+): repository\(owner: "acme", name: "(r\d+)"\)/g)];
      return { code: 0, stdout: answered(Object.fromEntries(names.map(([, alias, name]) => [alias, { pullRequests: { nodes: [pull(Number(name?.slice(1)))] } }]))), stderr: '' };
    };

    const found = await findBranchPulls(run, Array.from({ length: BATCH + 1 }, (_, index) => ask(`r${index + 1}`)), AbortSignal.timeout(1000));

    expect(calls).toHaveLength(2);
    expect(found.map((one) => one.pull?.number)).toEqual(Array.from({ length: BATCH + 1 }, (_, index) => index + 1));
  });
});

describe('the discussions of a pull request', () => {
  const PULL = { owner: 'acme', repo: 'app', number: 7 };
  const note = (id: string, author: string | null, createdAt: string, body = `said ${id}`) => ({ id, author: author === null ? null : { login: author }, body, createdAt });
  const more = (cursor: string) => ({ hasNextPage: true, endCursor: cursor });
  const end = { hasNextPage: false, endCursor: null };

  // The whole document, so a renamed field shows here before it reaches GitHub. The names are the
  // GitHub GraphQL schema's own.
  it('asks one page of threads, reviews and issue comments, with the login gh runs as', () => {
    expect(discussionsQuery(PULL, { threads: null, reviews: null, comments: null })).toBe(
      'query {\n  viewer { login }\n  repository(owner: "acme", name: "app") { pullRequest(number: 7) { ' +
        'reviewThreads(first: 50) { nodes { id path line originalLine isResolved isOutdated comments(first: 50) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } ' +
        'reviews(first: 50) { nodes { id author { login } state body submittedAt url } pageInfo { hasNextPage endCursor } } ' +
        'comments(first: 50) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } } } }\n}',
    );
    expect(threadCommentsQuery('PRRT_1', 'c"2')).toBe(
      'query {\n  node(id: "PRRT_1") { ... on PullRequestReviewThread { comments(first: 100, after: "c\\"2") { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } } } }\n}',
    );
  });

  it('asks only the connections with a next page, from their cursors', () => {
    const query = discussionsQuery(PULL, { reviews: 'r1' });
    expect(query).toContain('reviews(first: 50, after: "r1")');
    expect(query).not.toContain('reviewThreads');
    expect(query).not.toContain('comments(first: 50) { nodes { id author');
  });

  it('refuses a repository name that would break out of the document', () => {
    expect(() => discussionsQuery({ ...PULL, repo: 'app") { x' }, {})).toThrow(/not a repository name/);
  });

  it('pages through every connection and the comments inside a long thread, and never writes', async () => {
    const queries: string[] = [];
    const run: RunGh = async (args) => {
      const query = args[3] ?? '';
      queries.push(query);
      if (query.includes('node(id: "T2")')) return { code: 0, stdout: answered({ node: { comments: { nodes: [note('c4', 'dana', '2026-10-02T00:00:00Z')], pageInfo: end } } }), stderr: '' };
      if (query.includes('reviewThreads(first: 50, after: "t1")')) {
        const thread = { id: 'T2', path: 'src/a.ts', line: null, originalLine: 9, isResolved: true, isOutdated: true, comments: { nodes: [note('c3', 'dana', '2026-10-01T00:00:00Z')], pageInfo: more('k1') } };
        return { code: 0, stdout: answered({ viewer: { login: 'pat' }, repository: { pullRequest: { reviewThreads: { nodes: [thread], pageInfo: end } } } }), stderr: '' };
      }
      const thread = { id: 'T1', path: 'src/b.ts', line: 3, originalLine: 3, isResolved: false, isOutdated: false, comments: { nodes: [{ ...note('c1', 'dana', '2026-09-30T00:00:00Z'), url: 'https://evil.example/c1' }, { ...note('c2', 'pat', '2026-09-30T01:00:00Z'), url: 'https://github.com/acme/app/pull/7#discussion_r2' }], pageInfo: end } };
      const reviews = [
        { id: 'R1', author: { login: 'dana' }, state: 'CHANGES_REQUESTED', body: 'Please split this.', submittedAt: '2026-09-29T00:00:00Z', url: 'https://github.com/acme/app/pull/7#pullrequestreview-1' },
        { id: 'R2', author: { login: 'dana' }, state: 'COMMENTED', body: ' ', submittedAt: '2026-09-29T00:00:00Z' },
        { id: 'R3', author: { login: 'pat' }, state: 'PENDING', body: 'draft', submittedAt: null },
      ];
      return {
        code: 1,
        stdout: answered({
          viewer: { login: 'pat' },
          repository: { pullRequest: { reviewThreads: { nodes: [thread], pageInfo: more('t1') }, reviews: { nodes: reviews, pageInfo: end }, comments: { nodes: [note('i1', null, '2026-09-28T00:00:00Z')], pageInfo: end } } },
        }),
        stderr: '',
      };
    };

    const read = await readPullDiscussions(run, PULL, AbortSignal.timeout(1000));

    expect(read.viewer).toBe('pat');
    expect(read.threads.map((one) => [one.id, one.path, one.line, one.resolved, one.outdated, one.comments.map((c) => c.id)])).toEqual([
      ['T1', 'src/b.ts', 3, false, false, ['c1', 'c2']],
      ['T2', 'src/a.ts', 9, true, true, ['c3', 'c4']],
    ]);
    // A link that is not a GitHub page is dropped.
    expect(read.threads[0]?.comments.map((c) => c.url)).toEqual([null, 'https://github.com/acme/app/pull/7#discussion_r2']);
    expect(read.reviews).toEqual([{ id: 'R1', author: 'dana', state: 'CHANGES_REQUESTED', body: 'Please split this.', submittedAt: '2026-09-29T00:00:00Z', url: 'https://github.com/acme/app/pull/7#pullrequestreview-1' }]);
    expect(read.comments).toEqual([{ id: 'i1', author: null, body: 'said i1', createdAt: '2026-09-28T00:00:00Z', url: null }]);
    expect(queries).toHaveLength(3);
    for (const query of queries) expect(query).toMatch(/^query=query \{/);
    for (const query of queries) expect(query).not.toMatch(/mutation/i);
  });

  it('throws a sentence for an answer it cannot read, a missing pull request, a next page with no cursor and no login', async () => {
    const answering = (stdout: string): RunGh => async () => ({ code: 0, stdout, stderr: '' });
    await expect(readPullDiscussions(answering('not json'), PULL, AbortSignal.timeout(1000))).rejects.toThrow(/could not read/);
    await expect(readPullDiscussions(answering(answered({ repository: { pullRequest: null } })), PULL, AbortSignal.timeout(1000))).rejects.toThrow(/has no pull request acme\/app#7/);
    const empty = { nodes: [], pageInfo: end };
    const stuck = answered({ viewer: { login: 'pat' }, repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } }, reviews: empty, comments: empty } } });
    await expect(readPullDiscussions(answering(stuck), PULL, AbortSignal.timeout(1000))).rejects.toThrow(/could not read/);
    // With no login, the person's own comments would read as unread.
    const nobody = answered({ viewer: null, repository: { pullRequest: { reviewThreads: empty, reviews: empty, comments: empty } } });
    await expect(readPullDiscussions(answering(nobody), PULL, AbortSignal.timeout(1000))).rejects.toThrow(/could not read/);
    await expect(readPullDiscussions(answering(answered({ viewer: { login: 'pat' }, repository: { pullRequest: { reviewThreads: empty, reviews: empty, comments: empty } } })), PULL, AbortSignal.timeout(1000))).resolves.toMatchObject({ viewer: 'pat' });
  });
});

// The timer reads linked pull requests again by number, twenty to a document, with the branch lookup's
// fields.
describe('readMergeStates', () => {
  it('asks for the merge fields by number, one call per twenty', async () => {
    expect(mergeQuery([ref(7)])).toContain('issueOrPullRequest(number: 7)');
    for (const field of ['mergeStateStatus', 'statusCheckRollup', 'reviewDecision', 'isDraft', 'baseRefName']) expect(mergeQuery([ref(7)]), field).toContain(field);

    const calls: string[] = [];
    const run: RunGh = async (args) => {
      const query = args[3] ?? '';
      calls.push(query);
      const numbers = [...query.matchAll(/issueOrPullRequest\(number: (\d+)\)/g)].map((one) => Number(one[1]));
      return { code: 0, stdout: answered(Object.fromEntries(numbers.map((number, at) => [`t${at}`, { issueOrPullRequest: pull(number, { mergeStateStatus: 'BEHIND', baseRefName: 'main' }) }]))), stderr: '' };
    };
    const found = await readMergeStates(run, Array.from({ length: BATCH + 1 }, (_, at) => ref(at + 1)), AbortSignal.timeout(1000));

    expect(calls).toHaveLength(2);
    expect(found).toHaveLength(BATCH + 1);
    expect(found[BATCH]?.pull?.merge).toEqual({ blockers: [{ kind: 'behind', base: 'main' }], running: false });
  });
});
