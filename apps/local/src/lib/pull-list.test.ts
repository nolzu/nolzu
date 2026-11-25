import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createQueue, deliveryBoard } from '@nolzu/core';
import { boardSnapshot, boardVersion, cardDiscussions, cardPullRows, createCard, deleteCardRows, getSetting, openDatabase, recordMove, reposOfCard, saveCardPull, setCardRepos, setDiscussionStatus, writeSetting } from '@nolzu/core/node';
import { branchName, type PullRequest, type RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubSync } from './hub-sync.ts';
import { cardPull, cardPulls, deletePullLink, linkOpenPulls, patchDiscussion, postCardDiscussions, postDeliveryPulls, postDiscussionsSeen, postPullLink, postPullRefresh, readCardDiscussions, refreshDeliveryPulls, refreshPulls, unlinkedCards } from './pull-list.ts';

// A DOCUMENTED SHAPE NOBODY HAS MEASURED. The `gh` here is a stub, and no test calls GitHub. Both
// answers are written from the GitHub GraphQL schema, the way the fixtures in
// `packages/runner/src/tickets/github.test.ts` are, and that file names the fields one recorded answer
// has to confirm.
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest',
  number,
  title: `Change ${number}`,
  body: '',
  url: `https://github.com/cook/recipes/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  author: { login: 'dana' },
  reviewDecision: null,
  commits: { nodes: [{ commit: { committedDate: '2026-09-25T09:00:00.000Z' } }] },
  ...extra,
});

const REPO = { owner: 'cook', repo: 'recipes' };

let dir = '';
let db: DatabaseSync;
// What the stub answers: the open list, and one pull request read by number.
let open: unknown[] = [];
let single: Record<number, string> = {};
let listAnswer: string | null = null;
// The numbers that ask for the person's review. Null is every open one.
let asked: number[] | null = null;
let calls: string[] = [];
const askedOf = (list: unknown[]) => ({ nodes: (asked ?? list.map((one) => (one as { number: number }).number)).map((number) => ({ number })) });

const gh: RunGh = async (args) => {
  const query = args[3] ?? '';
  calls.push(query);
  if (query.includes('pullRequests(states: OPEN')) {
    return { code: 0, stdout: listAnswer ?? JSON.stringify({ data: { repository: { pullRequests: { nodes: open, pageInfo: { hasNextPage: false } } }, asked: askedOf(open) } }), stderr: '' };
  }
  const number = Number(/issueOrPullRequest\(number: (\d+)\)/.exec(query)?.[1]);
  // GONE stands for a number GitHub answers with nothing, such as a deleted repository's pull request.
  if (single[number] === 'GONE') return { code: 0, stdout: JSON.stringify({ data: { t0: { issueOrPullRequest: null } } }), stderr: '' };
  return { code: 0, stdout: JSON.stringify({ data: { t0: { issueOrPullRequest: pull(number, { state: single[number] ?? 'OPEN' }) } } }), stderr: '' };
};

const refresh = () => refreshPulls(db, gh, REPO, AbortSignal.timeout(1000));
const cards = () =>
  db.prepare("SELECT key, stage, source_ref AS ref, pr_state AS state FROM cards WHERE board = 'prreview' ORDER BY key").all() as {
    key: string;
    stage: string;
    ref: string;
    state: string | null;
  }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-pull-list-'));
  db = openDatabase(dir);
  open = [pull(41), pull(42)];
  single = {};
  listAnswer = null;
  asked = null;
  calls = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Delete card on a pull request card: the next read leaves it off while it is still open, and adding it
// again by hand takes the record off, so the read after that keeps it.
it('leaves a deleted pull request off the next read, until it is added again by hand', async () => {
  await refresh();
  expect(deleteCardRows(db, 'recipes#41')).toEqual({ logs: [] });

  const done = await refresh();

  expect(cards().map((card) => card.key)).toEqual(['recipes#42']);
  expect(done.added).toEqual([]);

  createCard(db, { key: 'recipes#41', board: 'prreview', stage: 'incoming', title: 'Change 41', source: 'github-pr', sourceRef: 'cook/recipes#41' });
  expect(db.prepare('SELECT count(*) AS n FROM deleted_tickets').get()).toEqual({ n: 0 });
  db.prepare("DELETE FROM cards WHERE key = 'recipes#41'").run();
  await refresh();
  expect(cards().map((card) => card.key)).toEqual(['recipes#41', 'recipes#42']);
});

it('draws a card for each of two open pull requests, on Incoming', async () => {
  const done = await refresh();

  expect(cards()).toEqual([
    { key: 'recipes#41', stage: 'incoming', ref: 'cook/recipes#41', state: 'open' },
    { key: 'recipes#42', stage: 'incoming', ref: 'cook/recipes#42', state: 'open' },
  ]);
  expect(done.added).toEqual(['recipes#41', 'recipes#42']);
});

// On a team's repository most open pull requests are someone else's to review.
it('draws a card only for a pull request that asks for your review', async () => {
  asked = [42];

  const done = await refresh();

  expect(done.added).toEqual(['recipes#42']);
  expect(cards().map((card) => card.key)).toEqual(['recipes#42']);
  expect(done.said).toBe('cook/recipes has 2 open pull requests, 1 asking for your review, 1 new on the board.');
});

// An older read added a card for every open pull request. Those nobody touched go once, and are not
// recorded as deleted, so a review request later brings one back.
it('removes once the untouched cards an older read added, and keeps every other card', async () => {
  for (const number of [41, 42, 43, 44, 45]) createCard(db, { key: `recipes#${number}`, board: 'prreview', stage: 'incoming', title: `Change ${number}`, source: 'github-pr', sourceRef: `cook/recipes#${number}` });
  db.prepare("UPDATE cards SET stage = 'my-review' WHERE key = 'recipes#42'").run();
  db.prepare("UPDATE cards SET extra_context = 'Check the cache' WHERE key = 'recipes#43'").run();
  recordMove(db, 'recipes#45', 'incoming', 'my-review', 'you', null);
  open = [41, 42, 43, 44, 45].map((number) => pull(number));
  asked = [44];

  const done = await refresh();

  expect(cards().map((card) => card.key)).toEqual(['recipes#42', 'recipes#43', 'recipes#44', 'recipes#45']);
  expect(done.said).toContain('Removed 1 card an older read added for pull requests that do not ask for your review.');
  expect(db.prepare('SELECT count(*) AS n FROM deleted_tickets').get()).toEqual({ n: 0 });

  // A read that finished under the rule turns the sweep off, and a card added by hand stays.
  writeSetting(db, 'pullsAskOnly', true);
  createCard(db, { key: 'recipes#41', board: 'prreview', stage: 'incoming', title: 'Change 41', source: 'github-pr', sourceRef: 'cook/recipes#41' });
  await refresh();
  expect(cards().map((card) => card.key)).toContain('recipes#41');
});

it('adds a new pull request on a refresh and does not repeat an old one', async () => {
  await refresh();
  db.prepare("UPDATE cards SET stage = 'my-review' WHERE key = 'recipes#41'").run();
  open = [pull(41), pull(42), pull(43)];

  const done = await refresh();

  expect(done.added).toEqual(['recipes#43']);
  expect(cards().map((card) => card.key)).toEqual(['recipes#41', 'recipes#42', 'recipes#43']);
  // A refresh never moves a card a person moved.
  expect(cards()[0]?.stage).toBe('my-review');
});

it('keeps the card of a pull request that closed, and marks it closed or merged', async () => {
  await refresh();
  open = [];
  single = { 41: 'CLOSED', 42: 'MERGED' };

  const done = await refresh();

  expect(cards().map((card) => [card.key, card.state])).toEqual([
    ['recipes#41', 'closed'],
    ['recipes#42', 'merged'],
  ]);
  expect(done.closed).toEqual(['recipes#41', 'recipes#42']);
  // The line says what each card says, so the merged one is not called closed.
  expect(done.said).toBe('cook/recipes has no open pull request. Closed since the last read: recipes#41. Merged since the last read: recipes#42.');
  // Marked once. A third refresh asks GitHub for nothing it already knows ended.
  calls = [];
  await refresh();
  expect(calls).toHaveLength(1);
});

// A closed or merged pull request is done, so a push GitHub still shows on it moves nothing back.
it('leaves a card that waits on the author where it is when its pull request closed', async () => {
  await refresh();
  db.prepare("UPDATE cards SET stage = 'awaiting-author', pr_head_sha = 'old' WHERE key = 'recipes#41'").run();
  open = [pull(42)];
  single = { 41: 'MERGED' };

  const done = await refresh();

  expect(cards()[0]).toMatchObject({ stage: 'awaiting-author', state: 'merged' });
  expect(done.said).not.toContain('went back');
});

// Gone from the list is not closed. The second read says what happened, and a pull request that
// answers open there (past the first page, say) keeps its card as it was.
it('marks nothing closed that GitHub still answers open', async () => {
  await refresh();
  open = [pull(42)];

  await refresh();

  expect(cards()[0]?.state).toBe('open');
});

// The one thing a refresh must never do: an answer it cannot read drawn as an empty repository.
it('refuses an answer it cannot read, and leaves the board as it was', async () => {
  await refresh();
  listAnswer = JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] });

  await expect(refresh()).rejects.toThrow(/could not read/);
  expect(cards().map((card) => card.state)).toEqual(['open', 'open']);
});

// A card key carries no owner, so another repository's recipes#41 cannot share the board with it.
it('leaves a card of another repository with the same key alone, and says so', async () => {
  db.prepare(
    "INSERT INTO cards (key, board, stage, title, source, source_ref, pr_decision) VALUES ('recipes#41', 'prreview', 'incoming', 'Other', 'github-pr', 'someone/recipes#41', 'APPROVED')",
  ).run();

  const done = await refresh();

  expect(done.added).toEqual(['recipes#42']);
  expect(done.said).toContain('recipes#41 on the board is someone/recipes#41');
  expect(cards()[0]?.ref).toBe('someone/recipes#41');
});

it('writes author, decision, draft and head commit again on a card that is already there', async () => {
  await refresh();
  open = [pull(41, { author: { login: 'eli' }, reviewDecision: 'APPROVED', isDraft: true, commits: { nodes: [{ commit: { committedDate: '2026-09-30T09:00:00.000Z' } }] } }), pull(42)];

  await refresh();

  expect(db.prepare("SELECT pr_author AS author, pr_decision AS decision, pr_draft AS draft, pr_head_at AS head FROM cards WHERE key = 'recipes#41'").get()).toEqual({
    author: 'eli',
    decision: 'APPROVED',
    draft: 1,
    head: '2026-09-30T09:00:00.000Z',
  });
});

// A pull request closed and opened again is open, so its card stops saying Closed.
it('marks a card open again when its pull request is back on the open list', async () => {
  await refresh();
  open = [pull(42)];
  single = { 41: 'CLOSED' };
  await refresh();
  open = [pull(41), pull(42)];

  await refresh();

  expect(cards().map((card) => card.state)).toEqual(['open', 'open']);
});

it('leaves a card as it was when its pull request answers not found', async () => {
  await refresh();
  open = [pull(42)];
  single = { 41: 'GONE' };

  const done = await refresh();

  expect(done.closed).toEqual([]);
  expect(cards()[0]?.state).toBe('open');
});

// The board holds pull requests of other repositories too. A refresh of this one asks nothing about them.
it('does not read or mark a card of another repository', async () => {
  db.prepare(
    "INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES ('other#7', 'prreview', 'incoming', 'Other', 'github-pr', 'someone/other#7')",
  ).run();
  single = { 7: 'CLOSED' };

  await refresh();

  expect(calls.some((query) => query.includes('number: 7'))).toBe(false);
  expect(cards().find((card) => card.key === 'other#7')?.state).toBeNull();
});

// No remote is no repository to read, and the person gets the other way to put a card on the board.
it('refuses a refresh in a project with no GitHub remote, and calls nothing', async () => {
  const told: string[] = [];

  const response = await postPullRefresh(db, () => told.push('told'), gh);

  expect(response.status).toBe(409);
  expect(((await response.json()) as { message: string }).message).toContain('has a GitHub remote');
  expect(calls).toEqual([]);
  expect(told).toEqual([]);
});

it('says how many pull requests are open and how many are new', async () => {
  await expect(refresh()).resolves.toMatchObject({ said: 'cook/recipes has 2 open pull requests, 2 asking for your review, 2 new on the board.' });
  open = [pull(41)];
  single = { 42: 'OPEN' };
  await expect(refresh()).resolves.toMatchObject({ said: 'cook/recipes has 1 open pull request, 1 asking for your review, 0 new on the board.' });
});

it('says the board read only the oldest 100 when GitHub has more', async () => {
  listAnswer = JSON.stringify({ data: { repository: { pullRequests: { nodes: open, pageInfo: { hasNextPage: true } } }, asked: askedOf(open) } });

  expect((await refresh()).said).toContain('The board read the oldest 100. The rest are on GitHub.');
});

describe('POST /api/board/pulls', () => {
  beforeEach(() => {
    const folder = join(dir, 'project');
    mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/cook/recipes.git'], { cwd: folder });
    writeSetting(db, 'projectPath', folder);
  });

  // The open boards hear of the new cards, because no run starts to tell them.
  it('answers what the board read and tells the open boards', async () => {
    const told: string[] = [];

    const response = await postPullRefresh(db, () => told.push('told'), gh);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: ['recipes#41', 'recipes#42'], said: 'cook/recipes has 2 open pull requests, 2 asking for your review, 2 new on the board.' });
    expect(getSetting(db, 'pullsAskOnly')).toBe(true);
    expect(told).toEqual(['told']);
  });

  // The PR reviews header says "read 12m ago" from this, so a reload keeps it.
  it('writes when the read finished, and leaves it on a failed read', async () => {
    const before = Date.now();
    await postPullRefresh(db, () => undefined, gh);
    const read = getSetting(db, 'pullsReadAt');

    expect(read).not.toBeNull();
    expect(Date.parse(read!)).toBeGreaterThanOrEqual(before);
    listAnswer = 'not json';
    await postPullRefresh(db, () => undefined, gh);
    expect(getSetting(db, 'pullsReadAt')).toBe(read);
  });

  // A workspace from New project: the project folder has no origin, each repository has its own.
  const workspace = () => {
    const folder = join(dir, 'workspace');
    for (const [name, url] of [['api', 'https://github.com/cook/recipes.git'], ['web', 'https://github.com/cook/menus.git'], ['local', null]] as const) {
      mkdirSync(join(folder, name), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: join(folder, name) });
      if (url !== null) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: join(folder, name) });
    }
    execFileSync('git', ['init', '-q'], { cwd: folder });
    writeSetting(db, 'projectPath', folder);
    writeSetting(db, 'repos', ['api', 'web', 'local'].map((path) => ({ path, base: 'main' })));
  };
  const asked: string[] = [];
  // The menus repository answers with its own list, or with `menus` when that is set.
  let menus: string | null = null;
  const each: RunGh = async (args, signal) => {
    const query = args[3] ?? '';
    if (query.includes('pullRequests(states: OPEN')) asked.push(/name: "(\w+)"/.exec(query)?.[1] ?? '');
    if (query.includes('name: "menus"')) return { code: 0, stdout: menus ?? JSON.stringify({ data: { repository: { pullRequests: { nodes: [pull(7, { url: 'https://github.com/cook/menus/pull/7' })], pageInfo: { hasNextPage: false } } }, asked: { nodes: [{ number: 7 }] } } }), stderr: '' };
    return gh(args, signal);
  };
  beforeEach(() => {
    asked.length = 0;
    menus = null;
  });

  it('reads the open pull requests of every repository in a workspace', async () => {
    workspace();

    const response = await postPullRefresh(db, () => undefined, each);

    expect(response.status).toBe(200);
    expect(asked).toEqual(['recipes', 'menus']);
    expect(await response.json()).toMatchObject({
      added: ['recipes#41', 'recipes#42', 'menus#7'],
      said: 'cook/recipes has 2 open pull requests, 2 asking for your review, 2 new on the board. cook/menus has 1 open pull request, 1 asking for your review, 1 new on the board.',
    });
  });

  // Each review works in the repository its pull request came from, which nothing else names.
  it('gives each card the repository its pull request came from', async () => {
    workspace();

    await postPullRefresh(db, () => undefined, each);

    expect(reposOfCard(db, 'recipes#41')).toEqual(['api']);
    expect(reposOfCard(db, 'menus#7')).toEqual(['web']);
  });

  it('gives a card with no list its repository on the next read, and keeps a list the person picked', async () => {
    workspace();
    await postPullRefresh(db, () => undefined, each);
    db.prepare("UPDATE cards SET repos = NULL, repos_by = NULL WHERE key = 'recipes#41'").run();
    setCardRepos(db, 'menus#7', ['local'], 'person');

    await postPullRefresh(db, () => undefined, each);

    expect(reposOfCard(db, 'recipes#41')).toEqual(['api']);
    expect(reposOfCard(db, 'menus#7')).toEqual(['local']);
  });

  it('keeps what the other repositories read when one read fails, and names it', async () => {
    workspace();
    menus = 'not json';

    const response = await postPullRefresh(db, () => undefined, each);

    expect(response.status).toBe(200);
    const said = ((await response.json()) as { said: string }).said;
    expect(said).toMatch(/^cook\/recipes has 2 open pull requests, 2 asking for your review, 2 new on the board\. GitHub answered the list of open pull requests of cook\/menus with something Nolzu could not read/);
    // A read that failed for one repository leaves the sweep on for the next press.
    expect(getSetting(db, 'pullsAskOnly')).toBe(false);
    expect(cards().map((card) => card.key)).toEqual(['recipes#41', 'recipes#42']);
    expect(getSetting(db, 'pullsReadAt')).toBeNull();
  });

  it('refuses a workspace none of whose repositories has a GitHub remote', async () => {
    const folder = join(dir, 'bare');
    mkdirSync(join(folder, 'api'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(folder, 'api') });
    writeSetting(db, 'projectPath', folder);
    writeSetting(db, 'repos', [{ path: 'api', base: 'main' }]);

    const response = await postPullRefresh(db, () => undefined, gh);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toBe(
      'No repository of this project has a GitHub remote, so the board has no repository to read pull requests from. Add a card by its pull request number instead.',
    );
    expect(calls).toEqual([]);
  });

  it('hands the reader refusal to the person, and tells nobody', async () => {
    const told: string[] = [];
    listAnswer = 'not json';

    const response = await postPullRefresh(db, () => told.push('told'), gh);

    expect(getSetting(db, 'pullsReadAt')).toBeNull();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain('could not read, so the board was left as it was');
    expect(told).toEqual([]);
    expect(cards()).toEqual([]);
  });
});

/* PR watch looks up a Delivery card's pull request by the card's branch. */

describe('cardPull', () => {
  const found = (state: PullRequest['state'], extra: Partial<PullRequest> = {}): PullRequest => ({
    key: 'recipes#12',
    number: 12,
    title: 'Add a search box',
    body: '',
    url: null,
    state,
    draft: false,
    author: 'dana',
    decision: 'APPROVED',
    headCommittedAt: '2026-10-01T09:00:00.000Z',
    ...extra,
  });

  it('is nothing when no repository has a pull request', () => {
    expect(cardPull([])).toBeNull();
  });

  it('carries the one pull request there is', () => {
    expect(cardPull([found('open', { draft: true, decision: 'REVIEW_REQUIRED' })])).toEqual({
      state: 'open',
      author: 'dana',
      decision: 'REVIEW_REQUIRED',
      headCommittedAt: '2026-10-01T09:00:00.000Z',
      draft: true,
    });
  });

  // The state rule of the plan, one row per case. Two repositories each, and each mixed pair both
  // ways round, because one would pass a rule that read only the first or only the last.
  it.each([
    [['open', 'merged'], 'open'],
    [['merged', 'open'], 'open'],
    [['merged', 'merged'], 'merged'],
    [['merged', 'closed'], 'closed'],
    [['closed', 'merged'], 'closed'],
    [['closed', 'closed'], 'closed'],
  ] as const)('reads %j as %s', (states, want) => {
    expect(cardPull(states.map((state) => found(state)))?.state).toBe(want);
  });

  // The line describes what the person still waits on, so a merged pull request with no review does
  // not make an approved open one read as needing review.
  it('describes the open ones while any is open', () => {
    const pull = cardPull([found('merged', { author: 'sam', decision: 'REVIEW_REQUIRED', draft: true }), found('open', { headCommittedAt: '2026-09-30T09:00:00.000Z' })]);

    expect(pull).toEqual({ state: 'open', author: 'dana', decision: 'APPROVED', headCommittedAt: '2026-09-30T09:00:00.000Z', draft: false });
  });

  // One approval never hides a request for changes in another repository.
  it.each([
    [['APPROVED', 'CHANGES_REQUESTED'], 'CHANGES_REQUESTED'],
    [['CHANGES_REQUESTED', 'APPROVED'], 'CHANGES_REQUESTED'],
    [['APPROVED', 'REVIEW_REQUIRED'], 'REVIEW_REQUIRED'],
    [['REVIEW_REQUIRED', 'APPROVED'], 'REVIEW_REQUIRED'],
    [['APPROVED', 'APPROVED'], 'APPROVED'],
  ] as const)('reads the decisions %j as %s', (decisions, want) => {
    expect(cardPull(decisions.map((decision) => found('open', { decision })))?.decision).toBe(want);
  });

  // The newest is neither the first nor the last time in the list.
  it('reads the newest head commit, and draft when any is a draft', () => {
    const pull = cardPull([
      found('open'),
      found('open', { headCommittedAt: null }),
      found('open', { headCommittedAt: '2026-10-03T09:00:00.000Z', draft: true }),
      found('open', { headCommittedAt: '2026-10-02T09:00:00.000Z' }),
    ]);

    expect(pull).toMatchObject({ headCommittedAt: '2026-10-03T09:00:00.000Z', draft: true });
  });
});

describe('PR watch', () => {
  const env = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  // The branch the template names for APP-1, which is what a card with no checkout is looked up by.
  const BRANCH = 'APP-1-add-a-search-box';

  let project = '';
  // What GitHub holds, by repository and head branch. A repository in `hidden` answers null, which
  // is how GitHub answers one this login cannot open.
  let heads: Record<string, unknown[]> = {};
  let hidden: string[] = [];
  let asked: string[] = [];
  // What people wrote, by repo#number: the pull request node of the discussions query. Empty when unset.
  let talk: Record<string, unknown> = {};
  let read: string[] = [];
  // Answers the branch lookup and the discussions read, and hands the PR reviews board's two queries to
  // the stub above.
  const both: RunGh = async (args, signal) => {
    const query = args[3] ?? '';
    const asking = /name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/.exec(query);
    if (asking !== null) {
      const at = `${asking[1]}#${asking[2]}`;
      read.push(at);
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const node = talk[at] === 'GONE' ? null : { reviewThreads: empty, reviews: empty, comments: empty, ...(talk[at] as object | undefined) };
      return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: 'pat' }, repository: { pullRequest: node } } }), stderr: '' };
    }
    if (!query.includes('headRefName')) return gh(args, signal);
    // The login gh runs as, which a closed card's "merged by you" is read against.
    const data: Record<string, unknown> = { viewer: { login: 'pat' } };
    for (const [, alias, repo, branch] of query.matchAll(/(t\d+): repository\(owner: "[^"]+", name: "([^"]+)"\) \{ pullRequests\(headRefName: ("(?:[^"\\]|\\.)*")/g)) {
      const head = `${repo}@${JSON.parse(branch ?? '""') as string}`;
      asked.push(head);
      data[alias ?? ''] = hidden.includes(repo ?? '') ? null : { pullRequests: { nodes: heads[head] ?? [] } };
    }
    return { code: 0, stdout: JSON.stringify({ data }), stderr: '' };
  };
  const lookUp = () => refreshDeliveryPulls(db, both, AbortSignal.timeout(5000));
  const delivery = () =>
    db.prepare("SELECT key, stage, pr_state AS state, pr_decision AS decision, pr_author AS author FROM cards WHERE board = 'delivery' ORDER BY key").all() as {
      key: string;
      stage: string;
      state: string | null;
      decision: string | null;
      author: string | null;
    }[];
  const stateOf = (key: string) => delivery().find((card) => card.key === key)?.state;

  beforeEach(() => {
    project = join(dir, 'recipes');
    mkdirSync(project, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'remote', 'add', 'origin', 'https://github.com/cook/recipes.git');
    writeSetting(db, 'projectPath', project);
    // The short names keep the lookups below readable. Which template names the branch does not matter here.
    writeSetting(db, 'branchTemplate', '{key}-{slug}');
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'pr-watch', title: 'Add a search box' });
    heads = {};
    hidden = [];
    asked = [];
    talk = {};
    read = [];
  });

  it('reads open while the branch has an open pull request, then merged once it merges, and never moves the card', async () => {
    heads[`recipes@${BRANCH}`] = [pull(12)];

    expect((await lookUp()).said).toBe('Looked up the pull requests of 1 card in the Pull request column or later. Open: APP-1.');
    expect(delivery()).toEqual([{ key: 'APP-1', stage: 'pr-watch', state: 'open', decision: 'REVIEW_REQUIRED', author: 'dana' }]);

    heads[`recipes@${BRANCH}`] = [pull(12, { state: 'MERGED', reviewDecision: 'APPROVED' })];

    expect((await lookUp()).said).toBe('Looked up the pull requests of 1 card in the Pull request column or later. Merged: APP-1.');
    expect(delivery()).toEqual([{ key: 'APP-1', stage: 'pr-watch', state: 'merged', decision: 'APPROVED', author: 'dana' }]);
    expect(asked).toEqual([`recipes@${BRANCH}`, `recipes@${BRANCH}`]);
  });

  // The same words a PR reviews card shows, from the same snapshot field.
  it('shows the state on the Delivery board the way a PR reviews card shows it', async () => {
    heads[`recipes@${BRANCH}`] = [pull(12, { state: 'MERGED' })];
    await lookUp();

    const card = boardSnapshot(db, { wall: { ready: true }, board: deliveryBoard('pull-request'), queue: createQueue(3), models: { 'claude-code': ['sonnet'] } }).cards.find((one) => one.key === 'APP-1');

    expect(card?.stage).toBe('pr-watch');
    expect(card?.pull).toMatchObject({ ended: 'merged', decision: 'REVIEW_REQUIRED', author: 'dana' });
  });

  it('leaves the state null for a branch with no pull request', async () => {
    expect((await lookUp()).said).toBe('Looked up the pull requests of 1 card in the Pull request column or later. No pull request found for APP-1.');
    expect(delivery()).toEqual([{ key: 'APP-1', stage: 'pr-watch', state: null, decision: null, author: null }]);
  });

  it('reads closed for a pull request closed without a merge', async () => {
    heads[`recipes@${BRANCH}`] = [pull(12, { state: 'CLOSED' })];

    expect((await lookUp()).said).toContain('Closed without a merge: APP-1.');
    expect(stateOf('APP-1')).toBe('closed');
  });

  // A branch reused after a pull request was closed: the newest one is the card's.
  it('reads the newest pull request of the branch', async () => {
    heads[`recipes@${BRANCH}`] = [pull(14), pull(12, { state: 'CLOSED' })];
    await lookUp();

    expect(stateOf('APP-1')).toBe('open');
  });

  // The sentence names each card under what was found for it, not the first card over again.
  it('names each card under its own state', async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Show the cooking time' });
    createCard(db, { key: 'APP-3', board: 'delivery', stage: 'pr-watch', title: 'Sort by rating' });
    createCard(db, { key: 'APP-4', board: 'delivery', stage: 'pr-watch', title: 'Print a recipe' });
    heads[`recipes@${BRANCH}`] = [pull(12)];
    heads['recipes@APP-2-show-the-cooking-time'] = [pull(15, { state: 'MERGED' })];
    heads['recipes@APP-3-sort-by-rating'] = [pull(16, { state: 'MERGED' })];

    expect((await lookUp()).said).toBe('Looked up the pull requests of 4 cards in the Pull request column or later. Open: APP-1. Merged: APP-2, APP-3. No pull request found for APP-4.');
  });

  // A card dragged on to Wrap-up before anyone pressed is still read, or its merge would be lost.
  // An archived card is read only while open, and a card before PR watch never is.
  it('looks up a card past PR watch while its pull request is open or not looked up yet', async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'wrapup', title: 'Show the cooking time' });
    db.prepare("UPDATE cards SET pr_state = 'open', pr_decision = 'APPROVED' WHERE key = 'APP-2'").run();
    createCard(db, { key: 'APP-3', board: 'delivery', stage: 'closed', title: 'Sort by rating' });
    createCard(db, { key: 'APP-4', board: 'delivery', stage: 'closed', title: 'Print a recipe' });
    db.prepare("UPDATE cards SET pr_state = 'merged', pr_decision = 'APPROVED' WHERE key = 'APP-4'").run();
    // Dragged back from PR watch, so it keeps the state it had there.
    createCard(db, { key: 'APP-5', board: 'delivery', stage: 'review', title: 'Rate a recipe' });
    db.prepare("UPDATE cards SET pr_state = 'open', pr_decision = 'APPROVED' WHERE key = 'APP-5'").run();
    createCard(db, { key: 'APP-6', board: 'delivery', stage: 'wrapup', title: 'Scale a recipe' });
    createCard(db, { key: 'APP-7', board: 'delivery', stage: 'wrapup', title: 'Share a recipe' });
    db.prepare("UPDATE cards SET pr_state = 'closed', pr_decision = 'APPROVED' WHERE key = 'APP-7'").run();
    heads['recipes@APP-2-show-the-cooking-time'] = [pull(15, { state: 'MERGED' })];
    heads['recipes@APP-6-scale-a-recipe'] = [pull(16, { state: 'MERGED' })];

    await lookUp();

    expect(asked).toEqual([`recipes@${BRANCH}`, 'recipes@APP-2-show-the-cooking-time', 'recipes@APP-6-scale-a-recipe']);
    expect(delivery().map((card) => [card.key, card.stage, card.state])).toEqual([
      ['APP-1', 'pr-watch', null],
      ['APP-2', 'wrapup', 'merged'],
      ['APP-3', 'closed', null],
      ['APP-4', 'closed', 'merged'],
      ['APP-5', 'review', 'open'],
      ['APP-6', 'wrapup', 'merged'],
      ['APP-7', 'wrapup', 'closed'],
    ]);
  });

  it('says no project folder is set, and calls nothing', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'projectPath'").run();

    expect((await lookUp()).said).toBe('No project folder is set, so there is no repository to look up pull requests in.');
    expect(asked).toEqual([]);
  });

  // A key that is not one plain name could name another card's checkout, so only the template counts.
  it('looks up a key that is not a plain name by the branch the template names', async () => {
    git(project, 'commit', '-q', '--allow-empty', '-m', 'first');
    createCard(db, { key: 'APP/8', board: 'delivery', stage: 'pr-watch', title: 'Sort by rating' });
    git(project, 'worktree', 'add', '-q', '-b', 'APP-9-other', join(project, 'worktrees', 'APP', '8'));

    await lookUp();

    expect(asked).toEqual([`recipes@${BRANCH}`, `recipes@${branchName(getSetting(db, 'branchTemplate'), 'APP/8', 'Sort by rating')}`]);
    expect(asked).not.toContain('recipes@APP-9-other');
  });

  it('says there is nothing to look up when no card waits on a pull request, and calls nothing', async () => {
    db.prepare("UPDATE cards SET stage = 'review' WHERE key = 'APP-1'").run();

    expect((await lookUp()).said).toBe('No card in the Pull request column or later waits on a pull request, so nothing was looked up.');
    expect(asked).toEqual([]);
  });

  it('leaves a card as it was on a repository GitHub does not show this login', async () => {
    heads[`recipes@${BRANCH}`] = [pull(12)];
    await lookUp();
    hidden = ['recipes'];

    expect((await lookUp()).said).toContain('GitHub did not answer for cook/recipes, so APP-1 was left as it was. A repository may be gone, or this login cannot open it.');
    expect(stateOf('APP-1')).toBe('open');
  });

  it('names each card a missing answer left as it was', async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Show the cooking time' });
    hidden = ['recipes'];

    const said = (await lookUp()).said;

    expect(said).toContain('GitHub did not answer for cook/recipes, so APP-1 was left as it was.');
    expect(said).toContain('GitHub did not answer for cook/recipes, so APP-2 was left as it was.');
  });

  it('does not look up a card whose repository has no GitHub origin', async () => {
    git(project, 'remote', 'set-url', 'origin', 'https://gitlab.com/cook/recipes.git');

    expect((await lookUp()).said).toBe('APP-1 has no repository with a GitHub origin, so its pull request was not looked up.');
    expect(asked).toEqual([]);
  });

  it('names each card that has no GitHub origin', async () => {
    git(project, 'remote', 'set-url', 'origin', 'https://gitlab.com/cook/recipes.git');
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Show the cooking time' });

    expect((await lookUp()).said).toBe(
      'APP-1 has no repository with a GitHub origin, so its pull request was not looked up. APP-2 has no repository with a GitHub origin, so its pull request was not looked up.',
    );
  });

  // The two reads share a route and a gh, and neither touches the other's cards.
  it('leaves the PR reviews board to its own read, and that read leaves the Delivery card alone', async () => {
    heads[`recipes@${BRANCH}`] = [pull(12, { state: 'MERGED' })];
    await refreshPulls(db, both, REPO, AbortSignal.timeout(1000));
    const reviews = cards();

    expect(reviews.map((card) => [card.key, card.state])).toEqual([
      ['recipes#41', 'open'],
      ['recipes#42', 'open'],
    ]);
    expect(stateOf('APP-1')).toBeNull();
    expect(asked).toEqual([]);

    await lookUp();

    expect(cards()).toEqual(reviews);
    expect(stateOf('APP-1')).toBe('merged');
  });

  // The PR reviews board has a Wrap-up stage too, and its cards are read by number, not by branch.
  it('leaves a PR reviews card on Wrap-up out of the Delivery lookup', async () => {
    await refreshPulls(db, both, REPO, AbortSignal.timeout(1000));
    db.prepare("UPDATE cards SET stage = 'wrapup' WHERE key = 'recipes#41'").run();
    heads[`recipes@${BRANCH}`] = [pull(12)];

    expect((await lookUp()).said).toBe('Looked up the pull requests of 1 card in the Pull request column or later. Open: APP-1.');
    expect(asked).toEqual([`recipes@${BRANCH}`]);
  });

  // The state goes up with the decision, which the hub needs to read a pull request at all.
  it('sends the Delivery card state on the board sync', async () => {
    heads[`recipes@${BRANCH}`] = [pull(12, { state: 'MERGED', reviewDecision: 'APPROVED' })];
    await lookUp();
    const frames: unknown[] = [];

    createHubSync(db, (_type, payload) => frames.push(payload) > 0, { runs: false }).board();

    const sent = frames.flatMap((frame) => (frame as { cards: { key: string; pull: unknown }[] }).cards).find((card) => card.key === 'APP-1');
    expect(sent?.pull).toEqual({ author: 'dana', decision: 'APPROVED', headCommittedAt: '2026-09-25T09:00:00.000Z', draft: false, state: 'merged' });
  });

  describe('the comments of a card', () => {
    const end = { hasNextPage: false, endCursor: null };
    const note = (id: string, login: string, createdAt: string) => ({ id, author: { login }, body: `said ${id}`, createdAt });
    const threads = (...nodes: unknown[]) => ({ reviewThreads: { nodes, pageInfo: end } });
    const thread = (id: string, comments: unknown[], isResolved = false) => ({ id, path: 'list.ts', line: 2, originalLine: 2, isResolved, isOutdated: false, comments: { nodes: comments, pageInfo: end } });

    it('finds the pull request by branch, stores each discussion once, and keeps the refs', async () => {
      heads[`recipes@${BRANCH}`] = [pull(12)];
      talk['recipes#12'] = {
        ...threads(thread('PRRT_1', [note('c1', 'dana', '2026-10-01T00:00:00Z'), note('c2', 'pat', '2026-10-01T01:00:00Z'), note('c5', 'dana', '2026-10-01T02:00:00Z')]), thread('PRRT_2', [note('c3', 'dana', '2026-10-02T00:00:00Z')], true)),
        reviews: { nodes: [{ id: 'R1', author: { login: 'dana' }, state: 'COMMENTED', body: 'Looks close.', submittedAt: '2026-10-03T00:00:00Z' }], pageInfo: end },
        comments: { nodes: [note('I1', 'dana', '2026-10-04T00:00:00Z')], pageInfo: end },
      };

      const first = await readCardDiscussions(db, 'APP-1', both);

      // Unread counts discussions, as the tab does: T1 holds two unread messages and counts once.
      expect(first).toEqual({ pulls: 1, added: 4, messages: 6, discussions: 4, unread: 4, said: 'Read the comments of 1 pull request: 6 new messages.' });
      expect(cardPullRows(db, 'APP-1').map((one) => [one.repo, one.number, one.foundBy])).toEqual([['cook/recipes', 12, 'branch']]);
      const rows = () => cardDiscussions(db, 'APP-1').map((one) => [one.ref, one.kind, one.githubId, one.status]);
      expect(rows()).toEqual([
        ['T1', 'thread', 'PRRT_1', 'new'],
        ['T2', 'thread', 'PRRT_2', 'done'],
        ['T3', 'review', 'R1', 'new'],
        ['T4', 'comment', 'I1', 'new'],
      ]);
      const before = rows();

      expect((await readCardDiscussions(db, 'APP-1', both)).messages).toBe(0);
      expect(rows()).toEqual(before);
    });

    it('reads an attached pull request too, and reopens a fixed discussion on a reviewer reply', async () => {
      saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 30, url: null, foundBy: 'attached' });
      talk['recipes#30'] = threads(thread('PRRT_9', [note('c1', 'dana', '2026-10-01T00:00:00Z')]));
      await readCardDiscussions(db, 'APP-1', both);
      setDiscussionStatus(db, cardDiscussions(db, 'APP-1')[0]?.id ?? 0, 'fixed');

      talk['recipes#30'] = threads(thread('PRRT_9', [note('c1', 'dana', '2026-10-01T00:00:00Z'), note('c2', 'dana', '2099-01-01T00:00:00Z')]));
      await readCardDiscussions(db, 'APP-1', both);

      expect(read).toEqual(['recipes#30', 'recipes#30']);
      expect(cardDiscussions(db, 'APP-1')[0]?.status).toBe('new');
    });

    // The PRs tab's writes: all local, none asks gh.
    it('marks the messages seen, and a discussion done or back to needing action', async () => {
      heads[`recipes@${BRANCH}`] = [pull(12)];
      talk['recipes#12'] = threads(thread('PRRT_1', [note('c1', 'dana', '2026-10-01T00:00:00Z')]));
      await readCardDiscussions(db, 'APP-1', both);
      const one = () => cardDiscussions(db, 'APP-1')[0];
      // The board is told of each write, because its card line counts the rows.
      const told = vi.fn();

      const version = boardVersion(db);
      expect(await postDiscussionsSeen(db, 'APP-1', told).json()).toEqual({ seen: 1 });
      expect(one()?.messages[0]?.unread).toBe(false);
      expect(told).toHaveBeenCalledTimes(1);
      expect(boardVersion(db)).toBeGreaterThan(version);
      // Nothing left unread changes nothing, so the board is not told again.
      expect(await postDiscussionsSeen(db, 'APP-1', told).json()).toEqual({ seen: 0 });
      expect(told).toHaveBeenCalledTimes(1);

      expect(patchDiscussion(db, 'APP-1', { ref: 'T1', action: 'done' }, told).status).toBe(200);
      expect(one()?.status).toBe('done');
      expect(told).toHaveBeenCalledTimes(2);
      expect(patchDiscussion(db, 'APP-1', { ref: 'T1', action: 'reopen' }, told).status).toBe(200);
      expect([one()?.status, one()?.needsAction]).toEqual(['new', true]);

      const missing = patchDiscussion(db, 'APP-1', { ref: 'T7', action: 'done' }, told);
      expect([missing.status, await missing.json()]).toEqual([404, { message: 'APP-1 has no comment T7. Read the comments again.' }]);
      expect(patchDiscussion(db, 'APP-1', { ref: 'T1', action: 'resolve' }, told).status).toBe(400);
      expect(patchDiscussion(db, 'APP-1', null, told).status).toBe(400);
      setDiscussionStatus(db, one()?.id ?? 0, 'fixing');
      expect(patchDiscussion(db, 'APP-1', { ref: 'T1', action: 'done' }, told).status).toBe(409);
      expect(told).toHaveBeenCalledTimes(3);
    });

    it('says when the card has no pull request, and refuses a card that is not on Delivery', async () => {
      expect((await readCardDiscussions(db, 'APP-1', both)).said).toBe('No pull request was found for APP-1, so there are no comments to read.');
      const told = vi.fn();
      expect((await postCardDiscussions(db, 'APP-1', told, both)).status).toBe(200);
      expect(told).toHaveBeenCalledTimes(1);
      createCard(db, { key: 'recipes#5', board: 'prreview', stage: 'incoming', title: 'Other' });
      const response = await postCardDiscussions(db, 'recipes#5', () => {}, both);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: 'recipes#5 is not a Delivery card, so it has no pull request comments to read.' });
    });

    it('answers the plain gh sentence and keeps what an earlier read stored', async () => {
      heads[`recipes@${BRANCH}`] = [pull(12)];
      talk['recipes#12'] = threads(thread('PRRT_1', [note('c1', 'dana', '2026-10-01T00:00:00Z')]));
      await readCardDiscussions(db, 'APP-1', both);
      const reason = 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.';

      const told = vi.fn();
      const response = await postCardDiscussions(db, 'APP-1', told, async () => {
        throw new Error(reason);
      });
      expect(told).not.toHaveBeenCalled();

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: reason });
      expect(cardDiscussions(db, 'APP-1')).toHaveLength(1);
    });

    it('is read by the board press for each card it found, and one card failing does not fail the rest', async () => {
      createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Sort recipes' });
      heads[`recipes@${BRANCH}`] = [pull(12)];
      heads['recipes@APP-2-sort-recipes'] = [pull(13)];
      talk['recipes#12'] = 'GONE';
      talk['recipes#13'] = threads(thread('PRRT_5', [note('c1', 'dana', '2026-10-01T00:00:00Z')]));

      const response = await postDeliveryPulls(db, () => {}, both);

      expect(response.status).toBe(200);
      expect(((await response.json()) as { said: string }).said).toBe(
        'Looked up the pull requests of 2 cards in the Pull request column or later. Open: APP-1, APP-2. New comments: APP-2. The comments of APP-1 were not read. GitHub has no pull request cook/recipes#12, or this login cannot open it, so its comments were not read.',
      );
      expect(cardDiscussions(db, 'APP-2')).toHaveLength(1);
    });
  });

  // The pull request is found without a press. Only for a card whose branch is pushed and that has
  // none linked yet, and only an open one is linked.
  describe('the pull request found by itself', () => {
    const checkout = () => {
      writeFileSync(join(project, 'list.ts'), 'export const list = [];\n');
      git(project, 'add', '-A');
      git(project, 'commit', '-q', '-m', 'first');
      const at = join(project, 'worktrees', 'APP-1');
      git(project, 'worktree', 'add', '-q', '-b', BRANCH, at);
      return at;
    };
    const linked = () => db.prepare("SELECT card_key, repo, number, found_by, state FROM card_pulls ORDER BY id").all();

    it('links the open pull request of a pushed branch, and asks nothing for a branch not pushed', async () => {
      const at = checkout();
      heads[`recipes@${BRANCH}`] = [pull(12)];

      expect(await linkOpenPulls(db, ['APP-1'], both, AbortSignal.timeout(5000))).toEqual([]);
      expect(asked).toEqual([]);

      // Pushed: the branch has an upstream, here a remote ref written by hand.
      git(at, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
      git(at, 'branch', `--set-upstream-to=origin/${BRANCH}`);
      expect(await linkOpenPulls(db, ['APP-1'], both, AbortSignal.timeout(5000))).toEqual(['APP-1']);
      expect(linked()).toEqual([{ card_key: 'APP-1', repo: 'cook/recipes', number: 12, found_by: 'branch', state: 'open' }]);
      expect(stateOf('APP-1')).toBe('open');
    });

    it('links nothing for a pull request that is not open, and leaves the card as it was when gh fails', async () => {
      const at = checkout();
      git(at, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
      git(at, 'branch', `--set-upstream-to=origin/${BRANCH}`);
      heads[`recipes@${BRANCH}`] = [pull(12, { state: 'CLOSED' })];

      expect(await linkOpenPulls(db, ['APP-1'], both, AbortSignal.timeout(5000))).toEqual([]);
      expect(linked()).toEqual([]);
      const failing: RunGh = async () => {
        throw new Error('gh: not logged in');
      };
      await expect(linkOpenPulls(db, ['APP-1'], failing, AbortSignal.timeout(5000))).rejects.toThrow('not logged in');
      expect(linked()).toEqual([]);
    });

    it('watches the cards from Review to Wrap-up that have no pull request linked', () => {
      createCard(db, { key: 'APP-2', board: 'delivery', stage: 'review', title: 'Two' });
      createCard(db, { key: 'APP-3', board: 'delivery', stage: 'implement', title: 'Three' });
      createCard(db, { key: 'APP-4', board: 'delivery', stage: 'closed', title: 'Four' });
      createCard(db, { key: 'APP-5', board: 'delivery', stage: 'wrapup', title: 'Five' });
      saveCardPull(db, 'APP-5', { repo: 'cook/recipes', number: 3, url: null, foundBy: 'attached' });

      expect(unlinkedCards(db)).toEqual(['APP-1', 'APP-2']);
    });
  });

  describe('POST /api/board/pulls?board=delivery', () => {
    it('answers what it looked up and tells the open boards', async () => {
      heads[`recipes@${BRANCH}`] = [pull(12)];
      const told: string[] = [];

      const version = boardVersion(db);
      const response = await postDeliveryPulls(db, () => told.push('told'), both);

      expect(response.status).toBe(200);
      // Once for the lookup and once more for the comments read after it.
      expect(boardVersion(db)).toBe(version + 2);
      expect(await response.json()).toEqual({ said: 'Looked up the pull requests of 1 card in the Pull request column or later. Open: APP-1.' });
      expect(told).toEqual(['told']);
    });

    // gh's own sentence, the one the PR reviews board shows for the same fault.
    it.each([
      ['no gh', 'gh is not on the PATH, so Nolzu cannot read GitHub. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.'],
      ['a gh that is logged out', 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.'],
    ])('with %s, keeps the state and says why', async (_what, reason) => {
      heads[`recipes@${BRANCH}`] = [pull(12)];
      await lookUp();
      const told: string[] = [];
      const broken: RunGh = async () => {
        throw new Error(reason);
      };

      const response = await postDeliveryPulls(db, () => told.push('told'), broken);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: reason });
      expect(told).toEqual([]);
      expect(stateOf('APP-1')).toBe('open');
    });
  });

  describe('a card on two repositories', () => {
    // A root on main and an api on develop, each with its own origin, and the card's checkouts on the
    // branch a run made, which is not the one the template names now.
    beforeEach(() => {
      writeFileSync(join(project, 'list.ts'), 'first\n');
      writeFileSync(join(project, '.gitignore'), 'api/\nworktrees/\n');
      git(project, 'add', '-A');
      git(project, 'commit', '-q', '-m', 'first');
      const api = join(project, 'api');
      mkdirSync(api);
      git(api, 'init', '-q', '-b', 'develop');
      writeFileSync(join(api, 'server.ts'), 'first\n');
      git(api, 'add', '-A');
      git(api, 'commit', '-q', '-m', 'first');
      git(api, 'remote', 'add', 'origin', 'git@github.com:cook/recipe-api.git');
      const root = join(project, 'worktrees', 'APP-1');
      git(project, 'worktree', 'add', '-q', '-b', 'APP-1-search', root);
      git(api, 'worktree', 'add', '-q', '-b', 'APP-1-search', join(root, 'api'));
      writeSetting(db, 'repos', [
        { path: '.', base: null },
        { path: 'api', base: 'develop' },
      ]);
      setCardRepos(db, 'APP-1', ['.', 'api'], 'person');
    });

    it('reads open while one is open, and merged only when both are merged', async () => {
      heads['recipes@APP-1-search'] = [pull(12, { state: 'MERGED' })];
      heads['recipe-api@APP-1-search'] = [pull(3)];

      await lookUp();

      expect(asked).toEqual(['recipes@APP-1-search', 'recipe-api@APP-1-search']);
      expect(stateOf('APP-1')).toBe('open');

      heads['recipe-api@APP-1-search'] = [pull(3, { state: 'MERGED' })];
      await lookUp();

      expect(stateOf('APP-1')).toBe('merged');
    });

    it('reads closed when none is open and one closed without a merge', async () => {
      heads['recipes@APP-1-search'] = [pull(12, { state: 'MERGED' })];
      heads['recipe-api@APP-1-search'] = [pull(3, { state: 'CLOSED' })];

      await lookUp();

      expect(stateOf('APP-1')).toBe('closed');
    });

    // A repository with no pull request yet is no vote either way: the one that has one decides.
    it('reads the one repository that has a pull request', async () => {
      heads['recipes@APP-1-search'] = [pull(12, { state: 'MERGED' })];

      await lookUp();

      expect(stateOf('APP-1')).toBe('merged');
    });

    it('reads closed the other way round too, a closed root and a merged api', async () => {
      heads['recipes@APP-1-search'] = [pull(12, { state: 'CLOSED' })];
      heads['recipe-api@APP-1-search'] = [pull(3, { state: 'MERGED' })];

      await lookUp();

      expect(stateOf('APP-1')).toBe('closed');
    });

    it('changes nothing while one repository cannot be read', async () => {
      heads['recipes@APP-1-search'] = [pull(12, { state: 'MERGED' })];
      hidden = ['recipe-api'];

      expect((await lookUp()).said).toContain('GitHub did not answer for cook/recipe-api, so APP-1 was left as it was.');
      expect(stateOf('APP-1')).toBeNull();
    });

    it('names both repositories when neither answers', async () => {
      hidden = ['recipes', 'recipe-api'];

      expect((await lookUp()).said).toContain(
        'GitHub did not answer for cook/recipes and cook/recipe-api, so APP-1 was left as it was. A repository may be gone, or this login cannot open it.',
      );
    });

    // Each repository is asked by the branch its own checkout is on, not by the root's.
    it('asks each repository by the branch of its own checkout', async () => {
      git(join(project, 'worktrees', 'APP-1', 'api'), 'switch', '-q', '-c', 'APP-1-api');
      heads['recipe-api@APP-1-api'] = [pull(3, { state: 'MERGED' })];

      await lookUp();

      expect(asked).toEqual(['recipes@APP-1-search', 'recipe-api@APP-1-api']);
      expect(stateOf('APP-1')).toBe('merged');
    });

    // A root that is not on GitHub does not stop the child repositories that are.
    it('asks the repositories with a GitHub origin when the root has none', async () => {
      git(project, 'remote', 'set-url', 'origin', 'https://gitlab.com/cook/recipes.git');
      heads['recipe-api@APP-1-search'] = [pull(3)];

      await lookUp();

      expect(asked).toEqual(['recipe-api@APP-1-search']);
      expect(stateOf('APP-1')).toBe('open');
    });

    // The loop refuses such a card too, and a guess would ask a repository the card never changed.
    it('does not look up a card when nothing says which repositories it changes', async () => {
      createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Show the cooking time' });

      const said = (await lookUp()).said;

      expect(said).toContain('APP-2 was not looked up. Nothing says which repositories APP-2 changes yet. Pick them on its Settings tab.');
      expect(asked).toEqual(['recipes@APP-1-search', 'recipe-api@APP-1-search']);
    });

    // One origin GitHub cannot hold costs only the card that has it.
    it('looks up the other cards when one card has an origin that is not a repository name', async () => {
      git(join(project, 'api'), 'remote', 'set-url', 'origin', 'https://github.com/cook/sub/recipe-api.git');
      createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Show the cooking time' });
      setCardRepos(db, 'APP-2', ['.'], 'person');
      heads['recipes@APP-2-show-the-cooking-time'] = [pull(15, { state: 'MERGED' })];

      const said = (await lookUp()).said;

      expect(said).toContain('APP-1 was not looked up. cook/sub/recipe-api is not a repository name, so it cannot be looked up.');
      expect(asked).toEqual(['recipes@APP-2-show-the-cooking-time']);
      expect(stateOf('APP-2')).toBe('merged');
    });
  });

  // The closed card reads its pull request state through gh when the page asks, from the same lookup
  // PR watch makes, and writes nothing. The answers are the recorded ones above.
  describe('the closed card', () => {
    const read = (run: RunGh = both) => cardPulls(db, 'APP-1', run, AbortSignal.timeout(5000));
    const LINK = `https://github.com/cook/recipes/pulls?q=${encodeURIComponent(`is:pr head:${BRANCH}`)}`;

    beforeEach(() => {
      db.prepare("UPDATE cards SET stage = 'closed' WHERE key = 'APP-1'").run();
    });

    it('reads merged from the recorded answer, and leaves the card as it was', async () => {
      heads[`recipes@${BRANCH}`] = [pull(12, { state: 'MERGED' })];

      expect(await read()).toEqual({
        pulls: [{ repo: 'cook/recipes', branch: BRANCH, number: 12, url: 'https://github.com/cook/recipes/pull/12', state: 'merged' }],
        said: null,
      });
      expect(stateOf('APP-1')).toBeNull();
    });

    // Parity line 453: the merger, the merge time, the size and the base, as the block draws them.
    it('reads who merged it, when, its size and its base, and says you for the gh login', async () => {
      const merged = { state: 'MERGED', mergedBy: { login: 'pat' }, mergedAt: '2026-10-20T10:36:00Z', createdAt: '2026-10-20T10:02:00Z', additions: 48, deletions: 6, changedFiles: 3, headRefName: BRANCH, baseRefName: 'main' };
      heads[`recipes@${BRANCH}`] = [pull(42, merged)];

      expect((await read()).pulls).toEqual([
        { repo: 'cook/recipes', branch: BRANCH, number: 42, url: 'https://github.com/cook/recipes/pull/42', state: 'merged', mergedBy: 'you', mergedAt: '2026-10-20T10:36:00Z', openedAt: '2026-10-20T10:02:00Z', additions: 48, deletions: 6, files: 3, base: 'main' },
      ]);

      heads[`recipes@${BRANCH}`] = [pull(42, { ...merged, mergedBy: { login: 'dana' } })];
      expect((await read()).pulls[0]?.mergedBy).toBe('dana');
    });

    it('reads open and closed as they are, never merged', async () => {
      heads[`recipes@${BRANCH}`] = [pull(12)];
      expect((await read()).pulls[0]?.state).toBe('open');
      heads[`recipes@${BRANCH}`] = [pull(12, { state: 'CLOSED' })];
      expect((await read()).pulls[0]?.state).toBe('closed');
    });

    // The branch asked about is the one of the card named, not of the first card.
    it('asks for the branch of the card it is given', async () => {
      createCard(db, { key: 'APP-2', board: 'delivery', stage: 'closed', title: 'Show the cooking time' });
      heads['recipes@APP-2-show-the-cooking-time'] = [pull(15, { state: 'MERGED' })];

      const answer = await cardPulls(db, 'APP-2', both, AbortSignal.timeout(5000));

      expect(answer.pulls).toEqual([{ repo: 'cook/recipes', branch: 'APP-2-show-the-cooking-time', number: 15, url: 'https://github.com/cook/recipes/pull/15', state: 'merged' }]);
    });

    // A gh that is not signed in, or not there, claims no state: the link stays, and the sentence says why.
    it('keeps the link with no state when gh fails', async () => {
      const loggedOut: RunGh = async () => {
        throw new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.');
      };

      expect(await read(loggedOut)).toEqual({
        pulls: [{ repo: 'cook/recipes', branch: BRANCH, number: null, url: LINK, state: null }],
        said: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.',
      });
    });

    it('keeps the link with no state for a repository GitHub did not answer for', async () => {
      hidden = ['recipes'];
      const answer = await read();

      expect(answer.pulls).toEqual([{ repo: 'cook/recipes', branch: BRANCH, number: null, url: LINK, state: null }]);
      expect(answer.said).toContain('GitHub did not answer for cook/recipes.');
    });

    it('says the branch has no pull request', async () => {
      expect(await read()).toEqual({ pulls: [], said: `cook/recipes has no pull request from ${BRANCH}.` });
    });

    it('asks nothing for a card with no GitHub origin', async () => {
      git(project, 'remote', 'set-url', 'origin', 'https://example.com/cook/recipes.git');

      expect(await read()).toEqual({ pulls: [], said: null });
      expect(asked).toEqual([]);
    });
  });
});

// Attach and detach on a Delivery card. The stub answers any repository, so two repositories need no
// second fixture.
describe('a pull request attached by link', () => {
  beforeEach(() => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'pr-watch', title: 'Add a search box' });
  });

  const attach = async (link: unknown, run: RunGh = gh) => {
    const response = await postPullLink(db, 'APP-1', { link }, run);
    return { status: response.status, body: (await response.json()) as { message?: string; pulls?: { repo: string; number: number; state: string | null; title: string | null; foundBy: string }[] } };
  };
  const told = vi.fn();
  const detach = async (link: unknown) => {
    const response = deletePullLink(db, 'APP-1', { link }, told);
    return { status: response.status, body: (await response.json()) as { message?: string } };
  };

  it('attaches several, across repositories, by link and by owner/repo#N, read from GitHub first', async () => {
    single[41] = 'MERGED';

    expect((await attach('https://github.com/Cook/Recipes/pull/41')).status).toBe(200);
    const second = await attach(' cook/api#7 ');

    expect(second.status).toBe(200);
    expect(second.body.pulls?.map((one) => [one.repo, one.number, one.state, one.title, one.foundBy])).toEqual([
      ['cook/recipes', 41, 'merged', 'Change 41', 'attached'],
      ['cook/api', 7, 'open', 'Change 7', 'attached'],
    ]);
    expect(calls.every((query) => query.startsWith('query'))).toBe(true);
  });

  it.each([
    ['', 'Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
    ['APP-4', 'Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
    [42, 'Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
    ['recipes#41', 'Type the owner as well, as in owner/recipes#41.'],
    // An issue link is refused before GitHub is asked.
    ['https://github.com/cook/recipes/issues/3', 'That link is to an issue. Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
  ])('refuses %j with a sentence and stores nothing', async (link, message) => {
    expect(await attach(link)).toEqual({ status: 400, body: { message } });
    expect(cardPullRows(db, 'APP-1')).toEqual([]);
    expect(calls).toEqual([]);
  });

  // The card page offers attach from Pull request on, and the route holds the same line.
  it('refuses a Delivery card that has not reached Pull request', async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'inbox', title: 'Show the cooking time' });
    const response = await postPullLink(db, 'APP-2', { link: 'cook/recipes#41' }, gh);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'APP-2 has not reached Pull request yet, so no pull request can be attached to it.' });
    expect(cardPullRows(db, 'APP-2')).toEqual([]);
    expect(calls).toEqual([]);

    // One moved back that holds a pull request still shows the tab, so the route takes the attach.
    saveCardPull(db, 'APP-2', { repo: 'cook/api', number: 3, url: null, foundBy: 'branch' });
    expect((await postPullLink(db, 'APP-2', { link: 'cook/recipes#41' }, gh)).status).toBe(200);
  });

  it('says when GitHub has no such pull request, and when gh did not answer', async () => {
    single[9] = 'GONE';
    expect((await attach('cook/recipes#9')).body.message).toBe(
      'GitHub has no pull request cook/recipes#9. The number may belong to an issue, the pull request may be gone, or this login may not open that repository.',
    );
    const failed = await attach('cook/recipes#10', async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' }));
    expect(failed).toEqual({ status: 409, body: { message: 'cook/recipes#10 could not be read from GitHub. The call failed, so the pull request may still be there. Try again.' } });
    expect(cardPullRows(db, 'APP-1')).toEqual([]);
  });

  it('refuses one the card has already and a card that is not on Delivery', async () => {
    await attach('cook/recipes#41');
    expect((await attach('https://github.com/Cook/Recipes/pull/41')).body.message).toBe('cook/recipes#41 is on APP-1 already.');
    // A link copied from a tab of the pull request names the same one.
    expect((await attach('https://github.com/cook/recipes/pull/41/files#diff-1')).body.message).toBe('cook/recipes#41 is on APP-1 already.');
    createCard(db, { key: 'recipes#5', board: 'prreview', stage: 'incoming', title: 'Other' });
    const response = await postPullLink(db, 'recipes#5', { link: 'cook/recipes#41' }, gh);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'recipes#5 is not a Delivery card, so no pull request can be attached to it.' });
  });

  it('detaches an attached one with its comments, and never one the branch found', async () => {
    await attach('cook/api#7');
    const attached = cardPullRows(db, 'APP-1')[0]?.id ?? 0;
    db.prepare("INSERT INTO pr_discussions (card_key, pull_id, ref, kind, github_id, status) VALUES ('APP-1', ?, 'T1', 'comment', 'I1', 'fixing')").run(attached);
    expect(await detach('cook/api#7')).toEqual({ status: 409, body: { message: 'A fix is running on a comment of cook/api#7. Detach it once the fix is done.' } });
    db.prepare("UPDATE pr_discussions SET status = 'new'").run();
    saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });

    expect(await detach('cook/recipes#12')).toEqual({
      status: 409,
      body: { message: "cook/recipes#12 was found by the card's branch, so it would come back on the next read. Only a pull request you attached can be detached." },
    });
    // Only the detach that dropped rows tells the board, whose card line counted them.
    expect(told).not.toHaveBeenCalled();
    expect((await detach('https://github.com/cook/api/pull/7')).status).toBe(200);
    expect(told).toHaveBeenCalledTimes(1);
    expect(await detach('cook/api#7')).toEqual({ status: 409, body: { message: 'cook/api#7 is not on APP-1.' } });
    expect(told).toHaveBeenCalledTimes(1);
    expect(cardPullRows(db, 'APP-1').map((one) => one.number)).toEqual([12]);
    expect(cardDiscussions(db, 'APP-1')).toEqual([]);
  });
});
