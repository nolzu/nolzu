import { type PullDecision, pullKey, type Ticket, type TicketAdapter, type TicketQuery, type TicketRef, type TicketResult } from '@nolzu/protocol';

/**
 * The GitHub Issues adapter, through `gh`.
 *
 * `gh` holds its own login, so nothing of GitHub goes into the keychain. A second credential for
 * the same account would be one more secret to keep and to revoke, and the person already has
 * `gh` for the git host.
 *
 * Read-only. Nothing here writes to GitHub, which is the rule for every ticket adapter in the
 * free client.
 */
/**
 * How `gh` is run. Two conditions the implementation has to keep, because nothing here can.
 *
 * The arguments go to the process as an array and never through a shell. A query document holds
 * newlines and quotes, and a shell would take them apart.
 *
 * `gh` is looked up on the login shell's PATH, the way the engine binary is. The known pitfalls in
 * `ARCHITECTURE.md` name `gh` among the tools a process started outside a login shell may not find.
 */
export type RunGh = (args: readonly string[], signal: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GitHubOptions {
  run: RunGh;
  // The owner a ref without one belongs to, read from the project's git remote. A ref such as
  // `repo#42` carries no owner, and guessing one would read somebody else's repository.
  defaultOwner: string | null;
}

// One document per twenty, which is what the known pitfalls in `ARCHITECTURE.md` ask for. Twenty aliases is well
// inside GitHub's query cost budget, and a read of a hundred refs costs five calls rather than a
// hundred.
export const BATCH = 20;

interface GraphNode {
  __typename?: string;
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  url?: string;
  // The issue this one is a sub-issue of, which is what the Add card dialog offers siblings from.
  parent?: { number?: number } | null;
  // Only a pull request answers these five.
  isDraft?: boolean;
  author?: { login?: string } | null;
  reviewDecision?: string | null;
  headRefOid?: string | null;
  // The newest APPROVED or CHANGES_REQUESTED review of each reviewer, which only the open list asks for.
  latestOpinionatedReviews?: {
    nodes?: ({ author?: { login?: string } | null; state?: string; submittedAt?: string | null; commit?: { oid?: string } | null } | null)[] | null;
  } | null;
  commits?: { totalCount?: number; nodes?: ({ commit?: { committedDate?: string } | null } | null)[] | null } | null;
  // True for a pull request from a fork. Only the branch lookup asks for it.
  isCrossRepository?: boolean;
  // What a closed card's pull request block says. Only the branch lookup asks for these.
  mergedBy?: { login?: string } | null;
  mergedAt?: string | null;
  createdAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string | null;
  baseRefName?: string | null;
}

interface GraphAnswer {
  data?: Record<string, { issueOrPullRequest?: GraphNode | null } | null> | null;
  // Present when any alias failed, and present on its own when the whole query did.
  errors?: { message?: string; type?: string; path?: (string | number)[] }[];
}

// The full name of an issue or a pull request, which a card keeps as its source ref. Not the card
// key: that is `pullKey`, which has no owner. Lower case, because GitHub names are case insensitive
// and the API answers in the canonical case whatever case was asked. Without this, `Acme/App#1`
// typed by hand and the same issue found by search are two refs.
export const issueKey = (owner: string, repo: string, number: number): string =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;

// One rule for both paths, so a closed issue reads the same whether it was asked for by number or
// found by search. GraphQL answers CLOSED and the REST search answers closed.
export const stateOf = (value: string | undefined): 'open' | 'closed' =>
  value?.toLowerCase() === 'closed' ? 'closed' : 'open';

// Only what a GitHub name may hold, so nothing a person types can close the quoted string in the
// query and add a field of its own. GitHub itself refuses anything else in these positions.
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * One GraphQL document for up to twenty refs.
 *
 * `issueOrPullRequest` rather than `issue`, because the number space is shared: asking for `issue`
 * on a pull request number answers not found, which would read as a ticket that is gone rather
 * than as a number that is not a ticket. The `__typename` tells the two apart.
 */
function checkRef(ref: { owner: string; repo: string; number: number }): void {
  if (!NAME.test(ref.owner) || !NAME.test(ref.repo)) {
    throw new Error(`${ref.owner}/${ref.repo} is not a repository name, so it cannot be looked up.`);
  }
  // A GraphQL Int stops at 2147483647, and anything past 2^53 reaches the document as 1e+23,
  // which is no integer literal at all: the whole document then fails to parse and every ref in
  // it is lost. The same rule on every path, because every document goes through here.
  if (!Number.isSafeInteger(ref.number) || ref.number < 1 || ref.number > 2_147_483_647) {
    throw new Error(`${ref.number} is not a number Nolzu can look up. An issue or a pull request number is a whole number from 1 to 2147483647.`);
  }
}

function document(refs: readonly { owner: string; repo: string; number: number }[], selection: string): string {
  const parts = refs.map((ref, index) => {
    checkRef(ref);
    return `  t${index}: repository(owner: "${ref.owner}", name: "${ref.repo}") { issueOrPullRequest(number: ${ref.number}) { __typename ${selection} } }`;
  });
  return `query {\n${parts.join('\n')}\n}`;
}

export const issueQuery = (refs: readonly { owner: string; repo: string; number: number }[]): string =>
  document(refs, '... on Issue { number title body state url parent { number } }');

// The fields a pull request card is built from, read by one number or in the open list.
const PULL_FIELDS = 'number title body url state isDraft author { login } reviewDecision headRefOid commits(last: 1) { totalCount nodes { commit { committedDate } } }';

/**
 * The same document, for pull requests.
 *
 * This selection and the node shape under it were written from the GitHub schema and never read
 * from the API. Nothing here is measured, unlike the issue answers above, and `github.test.ts`
 * names what the first real recording has to confirm.
 *
 * `commits(last: 1)` is how the head commit time is read: GitHub answers no timestamp on the pull
 * request itself, and `updatedAt` moves when anybody comments. The card says how old the code is,
 * so it has to be the commit.
 */
export const pullQuery = (refs: readonly { owner: string; repo: string; number: number }[]): string =>
  document(refs, `... on PullRequest { ${PULL_FIELDS} }`);

/**
 * The open pull requests of one repository, oldest first, in one document.
 *
 * Written from the GitHub schema like `pullQuery`, and never read from the API. `github.test.ts` names
 * the fields one recorded answer has to confirm.
 *
 * `latestOpinionatedReviews` is each reviewer's newest review that approves or asks for changes, with
 * the commit it was given on, and `viewer` the login gh runs as. Together they tell the board the
 * person approved a pull request themselves. A plain comment after an approval is not in that list,
 * so it never hides the approval, which the newest review of any kind would.
 *
 * Limit: one page of 100. A repository with more says so through `more`, and paging waits for one.
 */
// Limit: the newest 20 reviewers who approved or asked for changes. On a pull request with more, the
// person's row can fall out, and the card then does not move on their approval, which is the safe side.
// Page the connection if a real repository needs it.
const OWN_REVIEW_FIELDS = 'latestOpinionatedReviews(last: 20) { nodes { author { login } state submittedAt commit { oid } } }';

export const openPullsQuery = (repo: { owner: string; repo: string }): string => {
  if (!NAME.test(repo.owner) || !NAME.test(repo.repo)) throw new Error(`${repo.owner}/${repo.repo} is not a repository name, so it cannot be looked up.`);
  // `asked` is GitHub's own Review requests filter, a team the login is in included.
  const asked = `repo:${repo.owner}/${repo.repo} is:pr is:open review-requested:@me`;
  return `query {\n  viewer { login }\n  repository(owner: "${repo.owner}", name: "${repo.repo}") { pullRequests(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ${PULL_FIELDS} ${OWN_REVIEW_FIELDS} } pageInfo { hasNextPage } } }\n  asked: search(query: "${asked}", type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } }\n}`;
};

// The owner is not in the key, for the reason `pullKey` gives. The caller keeps it as the source ref.
const ticketFrom = (repo: string, node: GraphNode): Ticket => ({
  key: pullKey(repo, node.number ?? 0),
  title: node.title ?? '',
  body: node.body ?? '',
  state: stateOf(node.state),
  url: node.url ?? null,
  parentKey: node.parent?.number === undefined ? null : pullKey(repo, node.parent.number),
});

/**
 * Read the answer, whatever the exit code said.
 *
 * `gh api graphql` exits 1 when any alias failed, and still prints every alias that worked. A
 * reader that trusted the exit code would throw away nineteen good tickets because the twentieth
 * was deleted. Measured against the real API on 2026-09-24: a missing repository leaves its alias
 * null, a missing issue leaves `issueOrPullRequest` null, and both appear in `errors` as NOT_FOUND
 * while `data` still holds the rest.
 */
export function readIssues(
  refs: readonly { owner: string; repo: string; number: number }[],
  stdout: string,
): readonly TicketResult[] {
  let answer: GraphAnswer;
  try {
    answer = JSON.parse(stdout) as GraphAnswer;
  } catch {
    // Nothing readable came back, so nothing is known about any of them. Not found would be a
    // claim, and the caller would put cards on the board for tickets nobody read.
    return refs.map((ref) => ({ ref: asRef(ref), ticket: null, notFound: false }));
  }

  const slots = answer.data ?? {};
  return refs.map((ref, index) => {
    // Whether the query ran for this ref at all. A whole query that failed on bad credentials, a
    // rate limit or a validation error answers `errors` with no `data`, and reading that as "every
    // one of these tickets is gone" is the same claim the unreadable case above refuses to make.
    const asked = Object.hasOwn(slots, `t${index}`);
    const node = slots[`t${index}`]?.issueOrPullRequest ?? null;
    // A pull request is not a ticket, whatever the number space says. The PR reviews board reads
    // the same ref through `readPulls` instead, so nothing here has to tell the two apart.
    const isIssue = node !== null && node.__typename === 'Issue';
    return {
      ref: asRef(ref),
      ticket: isIssue ? ticketFrom(ref.repo, node) : null,
      // The API answers 404 for a repository that is not there and for one this login cannot see,
      // and nothing tells them apart. Both read as not found, which is what a person can act on.
      // A ref the query never reached is not one of them.
      notFound: asked && !isIssue,
    };
  });
}

/**
 * A pull request, as the PR reviews board draws it.
 *
 * The key holds no owner, unlike `issueKey`. A key with a slash in it is not one plain name, and a
 * card with such a key gets no card folder and no checkout, which is where the review round has to
 * live. The owner is kept on the card as its source ref. An issue card is keyed the same way.
 */
export interface PullRequest {
  key: string;
  number: number;
  title: string;
  // What the author wrote the pull request for. The review judges the change against it, so the
  // card keeps it as its ticket text. Empty when the author wrote no description.
  body: string;
  url: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  // Null when the answer carried no login, such as an account that is gone.
  author: string | null;
  decision: PullDecision;
  headCommittedAt: string | null;
  // The head commit and how many commits the pull request holds, which tell a later read that the
  // author pushed since the last review round. Left out when the answer carried none, so a missing
  // field never reads as a push.
  headSha?: string;
  commits?: number;
  // Who merged it and when, when it was opened, its size and its two branches. Only the branch
  // lookup reads them, for a closed card, and each is left out when the answer carried none.
  mergedBy?: string;
  mergedAt?: string;
  createdAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRef?: string;
  baseRef?: string;
  // The newest review of the login running gh that approves or asks for changes, when it went in and
  // the commit it was given on. Only the open list reads it, and it is left out when that login gave
  // none. Not `decision`: GitHub says APPROVED there once the required approvals are in, from anyone.
  ownReview?: { state: string; at: string | null; oid: string | null };
}

export interface PullResult {
  ref: TicketRef;
  pull: PullRequest | null;
  notFound: boolean;
}

// The card key of a pull request and of an issue, kept in the protocol so Add card shows the same key.
export { pullKey };

// Not `stateOf`, which answers open for anything that is not closed. A merged pull request would
// read as one still waiting for a review.
const pullState = (value: string | undefined): PullRequest['state'] => {
  const word = value?.toLowerCase();
  if (word === 'merged') return 'merged';
  if (word === 'closed') return 'closed';
  return 'open';
};

// GitHub answers null when nobody has reviewed yet, and a card showing nothing there would read as
// a pull request nobody has to look at. Anything this version does not know reads the same way,
// because the one thing that must never happen is an unreviewed pull request reading as approved.
const decisionOf = (value: string | null | undefined): PullDecision => {
  if (value === 'APPROVED') return 'APPROVED';
  if (value === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  return 'REVIEW_REQUIRED';
};

// A field the answer carried, or nothing, so a missing one never reads as empty or nought.
const text = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  typeof value === 'string' && value !== '' ? ({ [key]: value } as Record<K, string>) : {};
const count = <K extends string>(key: K, value: unknown): Partial<Record<K, number>> =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? ({ [key]: value } as Record<K, number>) : {};

const pullFrom = (repo: string, node: GraphNode): PullRequest => ({
  key: pullKey(repo, node.number ?? 0),
  number: node.number ?? 0,
  title: node.title ?? '',
  body: node.body ?? '',
  url: node.url ?? null,
  state: pullState(node.state),
  draft: node.isDraft === true,
  author: node.author?.login ?? null,
  decision: decisionOf(node.reviewDecision),
  // `commits(last: 1)` answers one node, and an empty list or a null in it both mean no commit
  // to read a time from. Every step is optional, so neither shape throws.
  headCommittedAt: node.commits?.nodes?.at(-1)?.commit?.committedDate ?? null,
  ...(typeof node.headRefOid === 'string' && node.headRefOid !== '' ? { headSha: node.headRefOid } : {}),
  ...(Number.isSafeInteger(node.commits?.totalCount) ? { commits: node.commits?.totalCount } : {}),
  ...text('mergedBy', node.mergedBy?.login),
  ...text('mergedAt', node.mergedAt),
  ...text('createdAt', node.createdAt),
  ...count('additions', node.additions),
  ...count('deletions', node.deletions),
  ...count('changedFiles', node.changedFiles),
  ...text('headRef', node.headRefName),
  ...text('baseRef', node.baseRefName),
});

// The viewer's own row of a pull request's opinionated reviews, the newest when there are more. Logins
// compare without case, as GitHub's do.
function ownReviewOf(node: GraphNode, viewer: string | null): Pick<PullRequest, 'ownReview'> {
  if (viewer === null) return {};
  const mine = (node.latestOpinionatedReviews?.nodes ?? []).filter((one) => one?.author?.login?.toLowerCase() === viewer.toLowerCase() && typeof one.state === 'string');
  const newest = mine.at(-1);
  if (newest == null || typeof newest.state !== 'string') return {};
  return { ownReview: { state: newest.state, at: newest.submittedAt ?? null, oid: typeof newest.commit?.oid === 'string' && newest.commit.oid !== '' ? newest.commit.oid : null } };
}

/**
 * Read the answer, whatever the exit code said. The three rules of `readIssues`, for the same
 * reasons: an unreadable body claims nothing, a ref the query never reached claims nothing, and
 * the exit code is not looked at.
 */
export function readPulls(
  refs: readonly { owner: string; repo: string; number: number }[],
  stdout: string,
): readonly PullResult[] {
  let answer: GraphAnswer;
  try {
    answer = JSON.parse(stdout) as GraphAnswer;
  } catch {
    return refs.map((ref) => ({ ref: asRef(ref), pull: null, notFound: false }));
  }

  const slots = answer.data ?? {};
  return refs.map((ref, index) => {
    const asked = Object.hasOwn(slots, `t${index}`);
    const node = slots[`t${index}`]?.issueOrPullRequest ?? null;
    // An issue number on the PR board is refused the way a pull request number is refused on the
    // ticket path. Both are numbers of the wrong thing, and nothing but `__typename` tells them apart.
    const isPull = node !== null && node.__typename === 'PullRequest';
    return {
      ref: asRef(ref),
      pull: isPull ? pullFrom(ref.repo, node) : null,
      notFound: asked && !isPull,
    };
  });
}

export interface OpenPulls {
  pulls: readonly PullRequest[];
  // The numbers of the open pull requests that ask for the login's review, its teams' included.
  asked: ReadonlySet<number>;
  // True when the repository has more open pull requests than the one page that was read.
  more: boolean;
}

/**
 * Read the open list, or throw. Unlike `readPulls` there is no ref to answer "nothing known" for, and
 * an empty list is a claim: the board would say the repository has nothing to review. So anything
 * short of a list whose every node has a number is refused with a sentence, and nothing is written.
 */
export function readOpenPulls(repo: { owner: string; repo: string }, stdout: string): OpenPulls {
  const full = `${repo.owner}/${repo.repo}`;
  const refused = new Error(`GitHub answered the list of open pull requests of ${full} with something Nolzu could not read, so the board was left as it was. Run gh auth status in a terminal to check the login, then read the list again.`);
  let answer: {
    data?: { viewer?: { login?: unknown } | null; repository?: { pullRequests?: { nodes?: unknown; pageInfo?: { hasNextPage?: boolean } } } | null; asked?: { nodes?: unknown } | null } | null;
    errors?: unknown[];
  };
  try {
    answer = JSON.parse(stdout) as typeof answer;
  } catch {
    throw refused;
  }
  // Only a `data` that holds the alias as null is GitHub saying the repository is not there. A query
  // that failed whole has no `data`, and is the refusal above.
  if (answer.data?.repository === null) {
    throw new Error(`GitHub has no repository ${full}, or this login cannot open it, so there are no pull requests to read.`);
  }
  const nodes = answer.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) throw refused;
  // No login, no own review: nothing then says who approved.
  const login = answer.data?.viewer?.login;
  const viewer = typeof login === 'string' && login !== '' ? login : null;
  const pulls = nodes.map((node: unknown) => {
    const read = node as GraphNode | null;
    if (read === null || typeof read !== 'object' || !Number.isSafeInteger(read.number) || (read.number ?? 0) < 1) throw refused;
    return { ...pullFrom(repo.repo, read), ...ownReviewOf(read, viewer) };
  });
  // Without this list nothing says which pull requests are the person's to review, so the read stops
  // rather than add every one, or none.
  const asked = answer.data?.asked?.nodes;
  if (!Array.isArray(asked)) throw refused;
  const numbers = new Set(asked.flatMap((node: unknown) => (Number.isSafeInteger((node as { number?: unknown } | null)?.number) ? [(node as { number: number }).number] : [])));
  return { pulls, asked: numbers, more: answer.data?.repository?.pullRequests?.pageInfo?.hasNextPage === true };
}

// The exit code is not looked at, for the reason `readIssues` gives.
export async function listOpenPulls(run: RunGh, repo: { owner: string; repo: string }, signal: AbortSignal): Promise<OpenPulls> {
  const answer = await run(['api', 'graphql', '-f', `query=${openPullsQuery(repo)}`], signal);
  return readOpenPulls(repo, answer.stdout);
}

/**
 * The pull requests whose head is one branch, newest first, for up to twenty repositories in one
 * document. This is how PR watch finds a Delivery card's pull request, which nobody gave Nolzu a
 * number for.
 *
 * Written from the GitHub schema like `pullQuery`, and never read from the API. `github.test.ts`
 * names the fields one recorded answer has to confirm.
 *
 * The branch goes in through `JSON.stringify`, which writes a valid GraphQL string literal. `NAME`
 * cannot guard it, because a branch may hold a slash or a quote.
 *
 * Limit: the newest ten per branch, which is plenty once forks are passed over. A branch reused
 * for more pull requests than that reads its newest ten.
 */
// What a closed card's pull request block reads besides the card fields.
const BRANCH_FIELDS = 'mergedBy { login } mergedAt createdAt additions deletions changedFiles headRefName baseRefName';

export const branchPullsQuery = (asks: readonly { owner: string; repo: string; branch: string }[]): string => {
  const parts = asks.map((ask, index) => {
    if (!NAME.test(ask.owner) || !NAME.test(ask.repo)) throw new Error(`${ask.owner}/${ask.repo} is not a repository name, so it cannot be looked up.`);
    return `  t${index}: repository(owner: "${ask.owner}", name: "${ask.repo}") { pullRequests(headRefName: ${JSON.stringify(ask.branch)}, first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { isCrossRepository ${BRANCH_FIELDS} ${PULL_FIELDS} } } }`;
  });
  // The login gh runs as, so a closed card can say "merged by you".
  return `query {\n  viewer { login }\n${parts.join('\n')}\n}`;
};

export interface BranchPull {
  // The newest pull request from the branch in that repository itself. Null when it has none.
  pull: PullRequest | null;
  // False when nothing is known: GitHub has no such repository, this login cannot open it, or the
  // answer did not hold this one. A card is never changed on a repository it knows nothing of.
  read: boolean;
  // The login gh runs as, when the answer named it.
  viewer?: string;
}

/**
 * Read the answer, whatever the exit code said, one result per ask in the order they came.
 *
 * A query that failed whole, such as a lost login or a rate limit, throws a sentence, so nothing is
 * written. Inside an answer that parsed, a repository that is not readable answers `read: false` on
 * its own and leaves the others alone.
 */
export function readBranchPulls(asks: readonly { owner: string; repo: string }[], stdout: string): BranchPull[] {
  const refused = new Error('GitHub answered the pull request lookup with something Nolzu could not read, so no card was changed. Run gh auth status in a terminal to check the login, then read the pull requests again.');
  let answer: { data?: Record<string, { pullRequests?: { nodes?: unknown }; login?: unknown } | null> | null };
  try {
    answer = JSON.parse(stdout) as typeof answer;
  } catch {
    throw refused;
  }
  const slots = answer.data;
  if (typeof slots !== 'object' || slots === null) throw refused;
  const viewer = text('viewer', slots.viewer?.login);
  return asks.map((ask, index) => {
    const nodes = slots[`t${index}`]?.pullRequests?.nodes;
    const valid = (node: unknown): node is GraphNode =>
      typeof node === 'object' && node !== null && Number.isSafeInteger((node as GraphNode).number) && ((node as GraphNode).number ?? 0) >= 1;
    if (!Array.isArray(nodes) || !nodes.every(valid)) return { pull: null, read: false, ...viewer };
    const own = nodes.find((node) => node.isCrossRepository !== true);
    return { pull: own === undefined ? null : pullFrom(ask.repo, own), read: true, ...viewer };
  });
}

// One call per twenty repositories, the way the ticket reads are batched. The exit code is not looked
// at, for the reason `readIssues` gives.
export async function findBranchPulls(run: RunGh, asks: readonly { owner: string; repo: string; branch: string }[], signal: AbortSignal): Promise<BranchPull[]> {
  const batches = await Promise.all(
    chunk(asks, BATCH).map(async (batch) => readBranchPulls(batch, (await run(['api', 'graphql', '-f', `query=${branchPullsQuery(batch)}`], signal)).stdout)),
  );
  return batches.flat();
}

/**
 * One pull request, through `gh`. The same two arguments `githubIssues` reads an issue with, so
 * nothing here spawns a second way of talking to GitHub.
 */
export async function getPull(
  run: RunGh,
  ref: { owner: string; repo: string; number: number },
  signal: AbortSignal,
): Promise<PullResult> {
  const answer = await run(['api', 'graphql', '-f', `query=${pullQuery([ref])}`], signal);
  const [found] = readPulls([ref], answer.stdout);
  return found ?? { ref: asRef(ref), pull: null, notFound: false };
}

/** One comment of a review thread, or one issue comment on the pull request. */
export interface PullComment {
  // GitHub's node id, which stays the same across reads, so a second read adds nothing twice.
  id: string;
  // Null for an account that is gone.
  author: string | null;
  body: string;
  createdAt: string;
  // The comment on GitHub, for the PRs tab's link. Null when GitHub left it out.
  url: string | null;
}

/** A review thread on a line of the diff, with every comment in it. */
export interface PullThread {
  id: string;
  path: string | null;
  // The line in the current diff, or the line it was made on once the code under it moved.
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: PullComment[];
}

/** A submitted review that says something in its own body. */
export interface PullReview {
  id: string;
  author: string | null;
  state: string;
  body: string;
  submittedAt: string;
  url: string | null;
}

/** Everything people wrote on one pull request, and the login gh runs as. */
export interface PullDiscussions {
  viewer: string;
  threads: PullThread[];
  reviews: PullReview[];
  comments: PullComment[];
}

// Where each connection starts on the next page. A connection left out is read to its end already.
interface DiscussionPages {
  threads?: string | null;
  reviews?: string | null;
  comments?: string | null;
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const COMMENT_FIELDS = 'id author { login } body createdAt url';
// Fifty threads with fifty comments each. Typical comments keep that far under the stdout cap of
// `cli.ts`, but a page of very long ones can pass it, and then the whole read throws the cap's
// sentence: nothing is stored half read. Anything past a page is read on the next one.
// Limit: fixed page size. Halve it on a cap error and ask again if real pull requests trip it.
const PAGE = 50;
// A cursor is GitHub's own opaque string, written as one string literal for the reason a branch is.
const page = (first: number, after: string | null): string => (after === null ? `first: ${first}` : `first: ${first}, after: ${JSON.stringify(after)}`);

/**
 * One page of the discussion of one pull request: its review threads, its reviews and its issue
 * comments, each from where the last page stopped, and the login gh runs as, so the person's own
 * comments are never unread.
 *
 * Written from the GitHub schema like `pullQuery`, and never read from the API.
 */
export const discussionsQuery = (pull: { owner: string; repo: string; number: number }, after: DiscussionPages): string => {
  checkRef(pull);
  const parts = [
    ...('threads' in after
      ? [`reviewThreads(${page(PAGE, after.threads ?? null)}) { nodes { id path line originalLine isResolved isOutdated comments(first: ${PAGE}) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } ${PAGE_INFO} }`]
      : []),
    ...('reviews' in after ? [`reviews(${page(PAGE, after.reviews ?? null)}) { nodes { id author { login } state body submittedAt url } ${PAGE_INFO} }`] : []),
    ...('comments' in after ? [`comments(${page(PAGE, after.comments ?? null)}) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} }`] : []),
  ];
  return `query {\n  viewer { login }\n  repository(owner: "${pull.owner}", name: "${pull.repo}") { pullRequest(number: ${pull.number}) { ${parts.join(' ')} } }\n}`;
};

// The rest of a thread that holds more comments than the first page of the thread read.
export const threadCommentsQuery = (thread: string, after: string): string =>
  `query {\n  node(id: ${JSON.stringify(thread)}) { ... on PullRequestReviewThread { comments(${page(100, after)}) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } }\n}`;

interface RawConnection {
  nodes?: unknown;
  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
}

interface RawNode {
  id?: unknown;
  author?: { login?: unknown } | null;
  body?: unknown;
  createdAt?: unknown;
  path?: unknown;
  line?: unknown;
  originalLine?: unknown;
  isResolved?: unknown;
  isOutdated?: unknown;
  comments?: RawConnection | null;
  state?: unknown;
  submittedAt?: unknown;
  url?: unknown;
}

/**
 * Every review thread, review body and issue comment of one pull request, page after page until GitHub
 * says there is no next one, so a long discussion is never cut short.
 *
 * Read only: every call is a GraphQL query. Anything the reader cannot read throws a sentence, because
 * a half read would leave discussions out and look complete.
 */
export async function readPullDiscussions(run: RunGh, pull: { owner: string; repo: string; number: number }, signal: AbortSignal): Promise<PullDiscussions> {
  const name = `${pull.owner}/${pull.repo}#${pull.number}`;
  const refused = new Error(`GitHub answered the comments of ${name} with something Nolzu could not read, so none were stored. Run gh auth status in a terminal to check the login, then read the comments again.`);
  const ask = async (query: string): Promise<Record<string, unknown>> => {
    // The exit code is not looked at, for the reason `readIssues` gives. A whole failure has no data.
    const answer = await run(['api', 'graphql', '-f', `query=${query}`], signal);
    let data: unknown;
    try {
      data = (JSON.parse(answer.stdout) as { data?: unknown }).data;
    } catch {
      throw refused;
    }
    if (typeof data !== 'object' || data === null) throw refused;
    return data as Record<string, unknown>;
  };
  // The nodes of one page, and the cursor of the next one, or null at the end.
  const pageOf = (connection: unknown): { nodes: RawNode[]; next: string | null } => {
    const read = connection as RawConnection | null | undefined;
    if (typeof read !== 'object' || read === null || !Array.isArray(read.nodes)) throw refused;
    if (!read.nodes.every((node) => typeof node === 'object' && node !== null && typeof (node as RawNode).id === 'string')) throw refused;
    const more = read.pageInfo?.hasNextPage === true;
    const cursor = read.pageInfo?.endCursor;
    // A next page with no cursor would be asked from the start again, forever.
    if (more && (typeof cursor !== 'string' || cursor === '')) throw refused;
    return { nodes: read.nodes as RawNode[], next: more ? (cursor as string) : null };
  };
  const login = (node: RawNode): string | null => (typeof node.author?.login === 'string' && node.author.login !== '' ? node.author.login : null);
  // Only a GitHub page is linked, so a strange answer never puts another site on the PRs tab.
  const link = (node: RawNode): string | null => (typeof node.url === 'string' && node.url.startsWith('https://github.com/') ? node.url : null);
  const comment = (node: RawNode): PullComment => {
    if (typeof node.createdAt !== 'string') throw refused;
    return { id: node.id as string, author: login(node), body: typeof node.body === 'string' ? node.body : '', createdAt: node.createdAt, url: link(node) };
  };

  let viewer = '';
  const found = { threads: [] as RawNode[], reviews: [] as RawNode[], comments: [] as RawNode[] };
  const field = { threads: 'reviewThreads', reviews: 'reviews', comments: 'comments' } as const;
  let after: DiscussionPages = { threads: null, reviews: null, comments: null };
  while (Object.keys(after).length > 0) {
    const data = await ask(discussionsQuery(pull, after));
    const repository = data.repository as { pullRequest?: Record<string, unknown> | null } | null | undefined;
    if (repository === null || repository?.pullRequest === null) throw new Error(`GitHub has no pull request ${name}, or this login cannot open it, so its comments were not read.`);
    const pullRequest = repository?.pullRequest;
    if (pullRequest === undefined) throw refused;
    // Without the login, the person's own comments would all read as unread.
    const seen = (data.viewer as { login?: unknown } | null | undefined)?.login;
    if (typeof seen !== 'string' || seen === '') throw refused;
    viewer = seen;
    const next: DiscussionPages = {};
    for (const key of Object.keys(after) as (keyof DiscussionPages)[]) {
      const one = pageOf(pullRequest[field[key]]);
      found[key].push(...one.nodes);
      if (one.next !== null) next[key] = one.next;
    }
    after = next;
  }

  const threads: PullThread[] = [];
  for (const node of found.threads) {
    let one = pageOf(node.comments);
    const comments = one.nodes.map(comment);
    while (one.next !== null) {
      const data = await ask(threadCommentsQuery(node.id as string, one.next));
      one = pageOf((data.node as { comments?: unknown } | null | undefined)?.comments);
      comments.push(...one.nodes.map(comment));
    }
    const line = [node.line, node.originalLine].find((value) => Number.isSafeInteger(value) && (value as number) > 0) as number | undefined;
    threads.push({
      id: node.id as string,
      path: typeof node.path === 'string' && node.path !== '' ? node.path : null,
      line: line ?? null,
      resolved: node.isResolved === true,
      outdated: node.isOutdated === true,
      comments,
    });
  }
  // A review with no body of its own is only the container of its thread comments, read above. A
  // pending review is the viewer's draft, never sent, so it has no submittedAt.
  const reviews = found.reviews.flatMap((node): PullReview[] =>
    typeof node.body === 'string' && node.body.trim() !== '' && typeof node.submittedAt === 'string'
      ? [{ id: node.id as string, author: login(node), state: typeof node.state === 'string' ? node.state : '', body: node.body, submittedAt: node.submittedAt, url: link(node) }]
      : [],
  );
  return { viewer, threads, reviews, comments: found.comments.map(comment) };
}

const asRef = (ref: { owner: string; repo: string; number: number }): TicketRef => ({
  kind: 'github',
  owner: ref.owner,
  repo: ref.repo,
  number: ref.number,
});

// One ref, as a map key. The number alone is not unique across repositories.
const slot = (ref: TicketRef): string =>
  ref.kind === 'github' ? issueKey(ref.owner ?? '', ref.repo, ref.number) : JSON.stringify(ref);

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

export function githubIssues(options: GitHubOptions): TicketAdapter {
  const { run, defaultOwner } = options;

  // Which refs this adapter can read, and what to say about the ones it cannot. A ref with no
  // owner and no remote to take one from is left alone: guessing an owner would read somebody
  // else's repository and put its issue on the board. A name the API would refuse is left alone
  // too, so one bad ref cannot fail the whole read.
  const readable = (ref: TicketRef): { owner: string; repo: string; number: number } | null => {
    if (ref.kind !== 'github') return null;
    const owner = ref.owner ?? defaultOwner;
    if (owner === null || !NAME.test(owner) || !NAME.test(ref.repo)) return null;
    if (!Number.isInteger(ref.number) || ref.number < 1) return null;
    return { owner, repo: ref.repo, number: ref.number };
  };

  return {
    name: 'github',

    /**
     * One result per ref, in the order they came.
     *
     * A caller that sends several refs and matches by position would otherwise put the wrong
     * ticket on the wrong card, because a ref this adapter cannot read used to be dropped with no
     * result at all. A ref it cannot read now answers `notFound: false`: nothing was asked, so
     * nothing is known.
     */
    async get(refs, signal) {
      const wanted = refs.map(readable);
      const asked = wanted.filter((ref) => ref !== null);
      const found = new Map<string, TicketResult>();

      if (asked.length > 0) {
        const batches = await Promise.all(
          chunk(asked, BATCH).map(async (batch) => {
            const answer = await run(['api', 'graphql', '-f', `query=${issueQuery(batch)}`], signal);
            return readIssues(batch, answer.stdout);
          }),
        );
        for (const result of batches.flat()) found.set(slot(result.ref), result);
      }

      return refs.map((ref, index) => {
        const mine = wanted[index];
        const result = mine === null || mine === undefined ? undefined : found.get(slot(asRef(mine)));
        return result ?? { ref, ticket: null, notFound: false };
      });
    },

    async search(query: TicketQuery, signal) {
      const repos = query.repos.filter((repo) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo));
      if (repos.length === 0) return [];
      // `is:issue` keeps pull requests out, which share the search index with issues. Both it and
      // `is:open` stay in front of what the person typed: a source that asked for issues may not
      // start answering with pull requests because a qualifier was added after it.
      const asked = (query.terms ?? '').trim();
      const terms = ['is:issue', 'is:open', ...repos.map((repo) => `repo:${repo}`), ...(asked === '' ? [] : [asked])].join(' ');
      const answer = await run(
        ['api', '-X', 'GET', 'search/issues', '-f', `q=${terms}`, '-F', `per_page=${Math.min(query.limit, 100)}`],
        signal,
      );
      try {
        const body = JSON.parse(answer.stdout) as { items?: { number?: number; title?: string; body?: string; state?: string; html_url?: string; repository_url?: string }[] };
        // A body with no `items` array is a refusal and not an empty backlog. A rate limited or
        // unauthorised `gh api` prints readable JSON carrying `message` and no `items`, so it parses
        // and the catch below never sees it. Checked here, the way the CI reader checks
        // `workflow_runs`, or a Scout source would report a quiet repository it never read.
        if (!Array.isArray(body.items)) throw new Error('no items');
        return body.items.flatMap((item): Ticket[] => {
          // The search API names the repository by an API URL and nothing else, so the key is
          // built from its last segment. The owner before it has to be there, or the URL is no
          // repository at all.
          const parts = (item.repository_url ?? '').split('/');
          const repo = parts.at(-1);
          const owner = parts.at(-2);
          if (owner === undefined || repo === undefined || item.number === undefined) return [];
          return [
            {
              key: pullKey(repo, item.number),
              title: item.title ?? '',
              body: item.body ?? '',
              state: stateOf(item.state),
              url: item.html_url ?? null,
              // Search does not report a parent, and asking per row would be one call each.
              parentKey: null,
            },
          ];
        });
      } catch {
        // Not an empty backlog. A rate limited or unauthorised `gh api` prints readable JSON with no
        // `items` in it, and a caller that read that as nothing found would report a quiet repository.
        throw new Error(`GitHub answered the issue search with something Nolzu could not read. Run gh api -X GET search/issues -f q=${JSON.stringify(terms)} in a terminal to see what it says.`);
      }
    },
  };
}
