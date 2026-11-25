import type { DatabaseSync } from 'node:sqlite';
import { boardFor, canMove, projectRepos, tabsFor } from '@nolzu/core';
import { boardOfCard, bumpVersion, cardDiscussions, cardPullRows, cardRepos, createCard, detachCardPull, type DiscussionInput, getSetting, markDiscussion, markDiscussionsSeen, recordMove, reposOfCard, saveCardPull, setCardRepos, type StoredCardPull, storeDiscussions, writeSetting } from '@nolzu/core/node';
import { type CardState, pullRequestRef, type PullDecision, type PullState } from '@nolzu/protocol';
import { branchPullsQuery, checkoutPath, findBranchPulls, getPull, ghRunner, git, gitEnv, isPlainName, issueKey, listOpenPulls, type PullDiscussions, type PullRequest, readPullDiscussions, type RunGh } from '@nolzu/runner';
import { cardBranch, cardCheckouts } from './checkout.ts';
import { READ_TIMEOUT_MS, remoteRepo } from './create-card.ts';

export interface PullRefresh {
  added: string[];
  closed: string[];
  // What the board says after the press, with every card it left alone named.
  said: string;
}

// The one column a read moves a card out of, and where the person's own approval takes it.
const WAITS_ON_AUTHOR = 'awaiting-author';
const APPROVED = 'approved';

/**
 * Where a card that waits on the author goes after a read, or null when it stays.
 *
 * The person's own approval takes it to Approved, and it counts only when it was given on the head
 * the pull request has now. The commit says the approval saw the code, so a push after it is code
 * nobody approved. Approving often comes before the drag to Awaiting author, from My review, so the
 * approval may be older than that move. Once the card has left Approved, though (`left`, the newest
 * move out of it), the approval has to be newer than that move: an approval from before it is the one
 * the person already took the card back from, so the card stays where they put it. Anything else
 * takes the push rule: Incoming when the head moved since the last round, or no move. `decision` is
 * not asked, because GitHub says APPROVED there once anybody's approvals meet the rule.
 */
function onward(found: PullRequest, moved: boolean, first: string, left: string | null): string | null {
  const review = found.ownReview;
  const approves =
    review?.state === 'APPROVED' &&
    review.oid !== null &&
    review.oid === found.headSha &&
    (left === null || (review.at !== null && Date.parse(review.at) > Date.parse(left)));
  if (approves) return APPROVED;
  return moved ? first : null;
}

/**
 * The PR reviews board reads the open pull requests of a repository.
 *
 * A pull request that is new and asks for the person's review, or a team's they are in, gets a card on
 * the first column. Others get none: on a team's repository most open pull requests are someone
 * else's to review, and Add pull request takes one by its number. One that has a card gets its author,
 * decision, head commit, commit count and draft flag written again. A card that waits on the author
 * and whose head moved since its last review round goes back to Incoming, because the push is what
 * it waited for, and one the person approved themselves goes on to Approved (`onward`). Either move
 * is `auto` and starts nothing: the next round is still a person's drop on Agent pre-review. A card
 * with no saved round head never moves back, because nothing says what its review read. A card
 * anywhere else stays where a person put it, and the push is what its "1 new commit" and the sentence
 * say. A card whose pull request left the open list is read once more by number, because gone from
 * the list is not proof of closed, and is marked closed or merged when GitHub says so. The card stays:
 * a review written on it is still worth reading.
 *
 * The list is read before anything is written, and an answer the reader cannot read throws, so a
 * failed read leaves the board as it was rather than drawing an empty repository.
 *
 * Until one read has finished under that rule (`pullsAskOnly`), a read also removes the cards an older
 * read added for every open pull request: on the first column, never moved, never run, with no text
 * of the person's, and not asking for their review now. They are not recorded as deleted, so a later
 * review request still brings the pull request back.
 */
// `path` is the project repository the list came from, which each card's review then works in.
export async function refreshPulls(db: DatabaseSync, run: RunGh, repo: { owner: string; repo: string; path?: string }, signal: AbortSignal): Promise<PullRefresh> {
  const list = await listOpenPulls(run, repo, signal);
  const full = (number: number) => issueKey(repo.owner, repo.repo, number);
  const listed = new Set(list.pulls.map((found) => full(found.number)));

  const mine = (
    db.prepare("SELECT key, source_ref AS ref, pr_state AS state FROM cards WHERE board = 'prreview' AND source = 'github-pr'").all() as {
      key: string;
      ref: string | null;
      state: string | null;
    }[]
  ).filter((card) => card.ref?.startsWith(`${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}#`));
  // Limit: one gh call per card that left the list. Few cards leave between two presses; batch through pullQuery if many do.
  const left = await Promise.all(
    mine
      .filter((card) => (card.state ?? 'open') === 'open' && card.ref !== null && !listed.has(card.ref))
      .map(async (card) => ({ card, found: await getPull(run, { ...repo, number: Number(card.ref?.split('#')[1]) }, signal) })),
  );

  const board = boardFor('prreview', getSetting(db, 'deliveryFlow'));
  const first = board.stages[0]?.id ?? 'incoming';
  const added: string[] = [];
  const closed: string[] = [];
  const merged: string[] = [];
  const pushed: string[] = [];
  const back: string[] = [];
  const approved: string[] = [];
  const clashes: string[] = [];
  const swept: string[] = [];
  // When the card last moved out of Approved, from its timeline, or null when it never did.
  const leftApproved = (key: string): string | null =>
    (db.prepare('SELECT at FROM card_events WHERE card_key = ? AND from_stage = ? ORDER BY id DESC LIMIT 1').get(key, APPROVED) as { at: string } | undefined)?.at ?? null;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const found of list.pulls) {
      const ref = full(found.number);
      const taken = db.prepare('SELECT source_ref AS ref, pr_head_sha AS reviewed, stage, state FROM cards WHERE key = ?').get(found.key) as
        | { ref: string | null; reviewed: string | null; stage: string; state: CardState }
        | undefined;
      const pull = {
        author: found.author,
        decision: found.decision,
        headCommittedAt: found.headCommittedAt,
        draft: found.draft,
        ...(found.headSha === undefined ? {} : { headSha: found.headSha }),
        ...(found.commits === undefined ? {} : { commits: found.commits }),
      };
      if (taken === undefined && !list.asked.has(found.number)) continue;
      // A pull request whose card a person deleted stays off the board. Adding it by hand brings it back.
      if (taken === undefined && db.prepare('SELECT 1 FROM deleted_tickets WHERE source_ref = ?').get(ref) !== undefined) continue;
      if (taken === undefined) {
        createCard(db, { key: found.key, board: 'prreview', stage: first, title: found.title, summary: found.body === '' ? null : found.body, source: 'github-pr', sourceRef: ref, pull });
        db.prepare("UPDATE cards SET pr_state = 'open' WHERE key = ?").run(found.key);
        if (repo.path !== undefined) setCardRepos(db, found.key, [repo.path], 'person');
        added.push(found.key);
      } else if (taken.ref === ref) {
        // A card added before Nolzu set the repository gets it now, and a list the person picked stays.
        if (repo.path !== undefined && cardRepos(db, found.key) === null) setCardRepos(db, found.key, [repo.path], 'person');
        // What this read saw, a missing head too, so a card never claims a push from an older read.
        db.prepare("UPDATE cards SET pr_author = ?, pr_decision = ?, pr_head_at = ?, pr_draft = ?, pr_seen_sha = ?, pr_seen_commits = ?, pr_state = 'open' WHERE key = ?").run(
          pull.author,
          pull.decision,
          pull.headCommittedAt,
          pull.draft ? 1 : 0,
          found.headSha ?? null,
          found.commits ?? null,
          found.key,
        );
        const moved = found.headSha !== undefined && taken.reviewed !== null && found.headSha !== taken.reviewed;
        const target = taken.stage === WAITS_ON_AUTHOR ? onward(found, moved, first, leftApproved(found.key)) : null;
        // The real move through the board's own rule, so a queued or running card stays where it is.
        const to = target !== null && canMove(board, taken, target) ? target : null;
        if (to !== null) {
          recordMove(db, found.key, taken.stage, to, 'auto', null);
          db.prepare('UPDATE cards SET stage = ? WHERE key = ?').run(to, found.key);
          (to === APPROVED ? approved : back).push(found.key);
        } else if (moved) pushed.push(found.key);
      } else {
        // The rule `createCardFrom` holds: a key carries no owner, so one name holds one pull request.
        clashes.push(`${found.key} on the board is ${taken.ref ?? 'a card of its own'}, so ${ref} was left off.`);
      }
    }
    // Limit: runs once per project, for the boards an older read filled.
    if (!getSetting(db, 'pullsAskOnly')) {
      const untouched = db.prepare(
        "SELECT 1 FROM cards c WHERE c.key = ? AND c.stage = ? AND c.state = 'idle' AND coalesce(c.extra_context, '') = '' AND NOT EXISTS (SELECT 1 FROM card_events WHERE card_key = c.key) AND NOT EXISTS (SELECT 1 FROM runs WHERE card_key = c.key)",
      );
      for (const card of mine) {
        if (card.ref === null || !listed.has(card.ref) || list.asked.has(Number(card.ref.split('#')[1])) || untouched.get(card.key, first) === undefined) continue;
        db.prepare('DELETE FROM notifications WHERE card_key = ?').run(card.key);
        db.prepare('DELETE FROM cards WHERE key = ?').run(card.key);
        swept.push(card.key);
      }
    }
    for (const { card, found } of left) {
      if (found.pull === null || found.pull.state === 'open') continue;
      db.prepare('UPDATE cards SET pr_state = ? WHERE key = ?').run(found.pull.state, card.key);
      closed.push(card.key);
      if (found.pull.state === 'merged') merged.push(card.key);
    }
    bumpVersion(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }

  const name = `${repo.owner}/${repo.repo}`;
  const parts = [
    list.pulls.length === 0
      ? `${name} has no open pull request.`
      : `${name} has ${list.pulls.length === 1 ? '1 open pull request' : `${list.pulls.length} open pull requests`}, ${list.asked.size} asking for your review, ${added.length} new on the board.`,
    ...(swept.length === 0 ? [] : [`Removed ${swept.length === 1 ? '1 card' : `${swept.length} cards`} an older read added for pull requests that do not ask for your review.`]),
    // The sentence says what the card says, so a merged pull request is not called closed here.
    ...(closed.length === merged.length ? [] : [`Closed since the last read: ${closed.filter((key) => !merged.includes(key)).join(', ')}.`]),
    ...(merged.length === 0 ? [] : [`Merged since the last read: ${merged.join(', ')}.`]),
    ...back.map((key) => `${key} has new commits and went back to ${board.stages[0]?.label ?? first}.`),
    ...approved.map((key) => `${key} is approved by you and moved to ${board.stages.find((stage) => stage.id === APPROVED)?.label ?? APPROVED}.`),
    ...(pushed.length === 0 ? [] : [`New commits since the last review round: ${pushed.join(', ')}.`]),
    ...(list.more ? ['The board read the oldest 100. The rest are on GitHub.'] : []),
    ...clashes,
  ];
  return { added, closed, said: parts.join(' ') };
}

const answer = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The POST /api/board/pulls handler. `told` tells the open boards, because new cards change what they
// show and no run starts to say so. Every project repository with a GitHub origin is read, one after
// the other, because a workspace from New project has no origin of its own and its repositories do.
// A repository whose read failed is named and left as it was, and the others still count.
export async function postPullRefresh(db: DatabaseSync, told: () => void, run: RunGh = ghRunner()): Promise<Response> {
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  const origins = (await Promise.all(repos.map(async (one) => ({ origin: await remoteRepo(db, one.path), path: one.path })))).flatMap(({ origin, path }) => (origin === null ? [] : [{ ...origin, path }]));
  const unique = [...new Map(origins.map((one) => [`${one.owner}/${one.repo}`.toLowerCase(), one])).values()];
  if (unique.length === 0) {
    return answer(409, { message: 'No repository of this project has a GitHub remote, so the board has no repository to read pull requests from. Add a card by its pull request number instead.' });
  }
  const done: PullRefresh = { added: [], closed: [], said: '' };
  const said: string[] = [];
  const failed: string[] = [];
  for (const repo of unique) {
    try {
      const one = await refreshPulls(db, run, repo, AbortSignal.timeout(READ_TIMEOUT_MS));
      done.added.push(...one.added);
      done.closed.push(...one.closed);
      said.push(one.said);
    } catch (error) {
      failed.push((error as Error).message);
    }
  }
  if (said.length === 0) return answer(409, { message: failed.join(' ') });
  // Only a press where every read finished, for the "read 12m ago" beside the button.
  if (failed.length === 0) {
    writeSetting(db, 'pullsReadAt', new Date().toISOString());
    writeSetting(db, 'pullsAskOnly', true);
  }
  told();
  return answer(200, { ...done, said: [...said, ...failed].join(' ') });
}

// A Delivery card's pull request, as the `pr_` columns hold it.
export interface CardPull {
  state: PullState;
  author: string | null;
  decision: PullDecision;
  headCommittedAt: string | null;
  draft: boolean;
}

/**
 * What a Delivery card's pull requests add up to, one per repository, or null when none was found.
 *
 * Open while any one is open, merged once every one is merged, and closed when none is open and one
 * closed without a merge. The rest of the line describes the open ones while there are any, because
 * those are what the person waits on. The decision is the weakest of them, so an approval in one
 * repository never hides a request for changes in another.
 */
export function cardPull(found: readonly PullRequest[]): CardPull | null {
  if (found.length === 0) return null;
  const open = found.filter((pull) => pull.state === 'open');
  const pool = open.length > 0 ? open : found;
  const decision: PullDecision = pool.some((pull) => pull.decision === 'CHANGES_REQUESTED')
    ? 'CHANGES_REQUESTED'
    : pool.every((pull) => pull.decision === 'APPROVED')
      ? 'APPROVED'
      : 'REVIEW_REQUIRED';
  return {
    state: open.length > 0 ? 'open' : found.every((pull) => pull.state === 'merged') ? 'merged' : 'closed',
    author: pool[0]?.author ?? null,
    decision,
    // ISO timestamps sort as text.
    headCommittedAt: pool.flatMap((pull) => (pull.headCommittedAt === null ? [] : [pull.headCommittedAt])).sort().at(-1) ?? null,
    draft: pool.some((pull) => pull.draft),
  };
}

interface BranchAsk {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * What GitHub is asked for one card's pull requests: each card repository with a GitHub `origin`, by
 * the card's branch. Throws the sentence for a card that names no repositories yet.
 */
async function branchAsks(db: DatabaseSync, project: string, key: string, env: Record<string, string>): Promise<BranchAsk[]> {
  const repos = reposOfCard(db, key);
  // The loop refuses such a card too. A guess would ask a repository the card never changed.
  if (repos === null) throw new Error(`Nothing says which repositories ${key} changes yet. Pick them on its Settings tab.`);
  // A key that is not one plain name could name another card's checkout, so it reads the template.
  const checkouts = isPlainName(key) ? repos.map((repo) => checkoutPath(project, key, repo)) : [];
  const mine: BranchAsk[] = [];
  for (const [index, repo] of repos.entries()) {
    const origin = await remoteRepo(db, repo);
    if (origin === null) continue;
    // The repository's own checkout first, because its branch is the one pushed from it.
    const own = checkouts[index];
    const ask = { ...origin, branch: await cardBranch(db, key, own === undefined ? checkouts : [own, ...checkouts], env) };
    // The query refuses a name GitHub cannot hold. Asked here, one odd origin costs its own card
    // and not the whole press.
    branchPullsQuery([ask]);
    mine.push(ask);
  }
  return mine;
}

/**
 * PR watch looks up the pull request of each Delivery card that waits on one: every card on PR watch,
 * and a card further on while its pull request is open or not looked up yet. Nobody gave Nolzu a
 * number for it, so each of the card's repositories with a GitHub `origin` is asked for the pull
 * request whose head is the card's branch.
 *
 * The card's `pr_` columns are written the way the PR reviews board writes its own, so the board, the
 * Review tab and the board sync read them with no rule of their own. The card never moves: the person
 * drags it on to Wrap-up. A card with any repository GitHub did not answer for is left as it was, and
 * so is one with no pull request found, because gone is not proof of anything.
 */
export async function refreshDeliveryPulls(db: DatabaseSync, run: RunGh, signal: AbortSignal): Promise<{ said: string; read: string[] }> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return { said: 'No project folder is set, so there is no repository to look up pull requests in.', read: [] };
  const stages = boardFor('delivery', getSetting(db, 'deliveryFlow')).stages;
  const later = stages.slice(stages.findIndex((stage) => stage.id === 'pr-watch') + 1);
  // A card dragged on before anyone pressed has no state yet, and its merge would never be read. So a
  // later stage asks while the state is unknown too, except the archive, where old cards with no
  // pull request would be asked on every press.
  const waits = (card: { stage: string; state: PullState | null }): boolean =>
    card.stage === 'pr-watch' || later.some((stage) => stage.id === card.stage && (card.state === 'open' || (card.state === null && stage.role !== 'archive')));
  const due = (
    db.prepare("SELECT key, stage, pr_state AS state FROM cards WHERE board = 'delivery' ORDER BY key").all() as { key: string; stage: string; state: PullState | null }[]
  ).filter(waits);
  if (due.length === 0) return { said: 'No card in the Pull request column or later waits on a pull request, so nothing was looked up.', read: [] };

  const env = gitEnv(process.env);
  const asks: BranchAsk[] = [];
  const looked: { key: string; asks: number[] }[] = [];
  const notes: string[] = [];
  for (const card of due) {
    try {
      // Joined to the batch only once every repository is asked, so a refused card asks nothing.
      const mine = await branchAsks(db, project, card.key, env);
      if (mine.length === 0) notes.push(`${card.key} has no repository with a GitHub origin, so its pull request was not looked up.`);
      else looked.push({ key: card.key, asks: mine.map((ask) => asks.push(ask) - 1) });
    } catch (error) {
      notes.push(`${card.key} was not looked up. ${(error as Error).message}`);
    }
  }

  // Throws for a missing or logged-out gh and for an answer it cannot read, before anything is written.
  const found = asks.length === 0 ? [] : await findBranchPulls(run, asks, signal);
  const writes: { key: string; pull: CardPull }[] = [];
  const named = { open: [] as string[], merged: [] as string[], closed: [] as string[], none: [] as string[] };
  for (const card of looked) {
    const unread = card.asks.filter((at) => found[at]?.read !== true).map((at) => `${asks[at]?.owner}/${asks[at]?.repo}`);
    if (unread.length > 0) {
      notes.push(`GitHub did not answer for ${unread.join(' and ')}, so ${card.key} was left as it was. A repository may be gone, or this login cannot open it.`);
      continue;
    }
    const pull = cardPull(card.asks.flatMap((at) => found[at]?.pull ?? []));
    if (pull === null) {
      named.none.push(card.key);
      continue;
    }
    named[pull.state].push(card.key);
    writes.push({ key: card.key, pull });
  }

  if (writes.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const write = db.prepare("UPDATE cards SET pr_author = ?, pr_decision = ?, pr_head_at = ?, pr_draft = ?, pr_state = ? WHERE key = ? AND board = 'delivery'");
      for (const { key, pull } of writes) write.run(pull.author, pull.decision, pull.headCommittedAt, pull.draft ? 1 : 0, pull.state, key);
      bumpVersion(db);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  const list = (keys: string[], words: string) => (keys.length === 0 ? [] : [`${words}${keys.join(', ')}.`]);
  const parts = [
    ...(looked.length === 0 ? [] : [`Looked up the pull requests of ${looked.length === 1 ? '1 card' : `${looked.length} cards`} in the Pull request column or later.`]),
    ...list(named.open, 'Open: '),
    ...list(named.merged, 'Merged: '),
    ...list(named.closed, 'Closed without a merge: '),
    ...list(named.none, 'No pull request found for '),
    ...notes,
  ];
  return { said: parts.join(' '), read: writes.map((write) => write.key) };
}

// The columns where a Delivery card's pull request is looked for by itself: once a person reads the
// change, until the card is closed.
const WATCHED = ['review', 'pr-watch', 'wrapup'];

/** The Delivery cards from Review to Wrap-up that have no pull request linked yet, by key. */
export function unlinkedCards(db: DatabaseSync): string[] {
  return (
    db
      .prepare(`SELECT key FROM cards WHERE board = 'delivery' AND stage IN (${WATCHED.map(() => '?').join(', ')}) AND key NOT IN (SELECT card_key FROM card_pulls) ORDER BY key`)
      .all(...WATCHED) as { key: string }[]
  ).map((one) => one.key);
}

// Whether a checkout of the card has its branch on a remote: an upstream, which a push sets.
async function branchPushed(db: DatabaseSync, key: string, env: Record<string, string>): Promise<boolean> {
  for (const one of cardCheckouts(db, key)) {
    if ((await git(['rev-parse', '--verify', '--quiet', '@{upstream}'], { cwd: one.path, env })).code === 0) return true;
  }
  return false;
}

/**
 * Finds the open pull request of each card's pushed branch, without a press, and links it as found by
 * the branch, with the `pr_` columns Read pull requests writes. One gh document asks for every card, and
 * a card whose branch is not pushed is not asked for. Only an open pull request is linked. A gh that is
 * missing or logged out throws before anything is written, and the caller stays quiet about it.
 */
export async function linkOpenPulls(db: DatabaseSync, keys: readonly string[], run: RunGh, signal: AbortSignal): Promise<string[]> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return [];
  const env = gitEnv(process.env);
  const asks: BranchAsk[] = [];
  const cards: { key: string; asks: number[] }[] = [];
  for (const key of keys) {
    try {
      if (!(await branchPushed(db, key, env))) continue;
      const mine = await branchAsks(db, project, key, env);
      if (mine.length > 0) cards.push({ key, asks: mine.map((ask) => asks.push(ask) - 1) });
    } catch {
      // A card with no repository list yet, or an odd origin, is asked for on a press instead.
    }
  }
  if (asks.length === 0) return [];
  const found = await findBranchPulls(run, asks, signal);
  const linked: string[] = [];
  for (const card of cards) {
    const open = card.asks.flatMap((at) => {
      const one = found[at];
      const ask = asks[at];
      return one?.read === true && one.pull?.state === 'open' && ask !== undefined ? [{ ask, pull: one.pull }] : [];
    });
    if (open.length === 0) continue;
    for (const { ask, pull } of open) saveCardPull(db, card.key, { repo: `${ask.owner}/${ask.repo}`, number: pull.number, url: pull.url, foundBy: 'branch', title: pull.title, state: pull.state });
    const pull = cardPull(open.map((one) => one.pull));
    if (pull !== null) db.prepare("UPDATE cards SET pr_author = ?, pr_decision = ?, pr_head_at = ?, pr_draft = ?, pr_state = ? WHERE key = ? AND board = 'delivery'").run(pull.author, pull.decision, pull.headCommittedAt, pull.draft ? 1 : 0, pull.state, card.key);
    linked.push(card.key);
  }
  if (linked.length > 0) bumpVersion(db);
  return linked;
}

// The POST /api/board/pulls?board=delivery handler. A failed lookup writes nothing and tells nobody,
// and its sentence goes under the button the way the PR reviews board's does. The comments of each card
// it found a pull request for are read after, and one card that fails is named without failing the rest.
export async function postDeliveryPulls(db: DatabaseSync, told: () => void, run: RunGh = ghRunner()): Promise<Response> {
  let done: { said: string; read: string[] };
  try {
    done = await refreshDeliveryPulls(db, run, AbortSignal.timeout(READ_TIMEOUT_MS));
  } catch (error) {
    return answer(409, { message: (error as Error).message });
  }
  const fresh: string[] = [];
  const notes: string[] = [];
  // Limit: each card looks its pull requests up again, one more gh call per card. Hand the lookup in if presses get slow.
  for (const key of done.read) {
    try {
      if ((await readCardDiscussions(db, key, run)).messages > 0) fresh.push(key);
    } catch (error) {
      notes.push(`The comments of ${key} were not read. ${(error as Error).message}`);
    }
  }
  // The comments came in after the lookup bumped the version, and the card line counts them.
  boardTold(db, told);
  return answer(200, { said: [done.said, ...(fresh.length === 0 ? [] : [`New comments: ${fresh.join(', ')}.`]), ...notes].join(' ') });
}

export interface DiscussionsRead {
  pulls: number;
  // Discussions and messages this read added, and what the card holds after it.
  added: number;
  messages: number;
  discussions: number;
  unread: number;
  said: string;
}

// The runner's answer in the shape the store takes: one discussion per thread, per review body and per
// issue comment, each a message of its own.
const discussionInputs = (read: PullDiscussions): DiscussionInput[] => [
  ...read.threads.map((thread) => ({
    kind: 'thread' as const,
    githubId: thread.id,
    path: thread.path,
    line: thread.line,
    resolved: thread.resolved,
    outdated: thread.outdated,
    messages: thread.comments.map((one) => ({ githubId: one.id, author: one.author, body: one.body, createdAt: one.createdAt, url: one.url })),
  })),
  ...read.reviews.map((review) => ({
    kind: 'review' as const,
    githubId: review.id,
    path: null,
    line: null,
    resolved: false,
    outdated: false,
    messages: [{ githubId: review.id, author: review.author, body: review.body, createdAt: review.submittedAt, url: review.url }],
  })),
  ...read.comments.map((one) => ({
    kind: 'comment' as const,
    githubId: one.id,
    path: null,
    line: null,
    resolved: false,
    outdated: false,
    messages: [{ githubId: one.id, author: one.author, body: one.body, createdAt: one.createdAt, url: one.url }],
  })),
];

/**
 * Reads what people wrote on a Delivery card's pull requests and stores it. The pull requests are found
 * the way PR watch finds them, by the card's branch in each repository with a GitHub origin, and kept as
 * found by branch. Every pull request the card holds is then read, an attached one too.
 *
 * Only a press calls this, never a timer, and every gh call is a GraphQL query: Nolzu writes nothing to
 * GitHub. A gh that is missing or logged out throws its own sentence. Each pull request is stored as it
 * is read, so one that fails after another keeps the first.
 */
export async function readCardDiscussions(db: DatabaseSync, key: string, run: RunGh = ghRunner(), signal: AbortSignal = AbortSignal.timeout(READ_TIMEOUT_MS)): Promise<DiscussionsRead> {
  if (boardOfCard(db, key) !== 'delivery') throw new Error(`${key} is not a Delivery card, so it has no pull request comments to read.`);
  const project = getSetting(db, 'projectPath');
  if (project === null) throw new Error('No project folder is set, so there is no repository to look up pull requests in.');
  const asks = await branchAsks(db, project, key, gitEnv(process.env));
  const found = asks.length === 0 ? [] : await findBranchPulls(run, asks, signal);
  const notes: string[] = [];
  for (const [at, ask] of asks.entries()) {
    const one = found[at];
    if (one?.read !== true) notes.push(`GitHub did not answer for ${ask.owner}/${ask.repo}. The repository may be gone, or this login cannot open it.`);
    else if (one.pull !== null) saveCardPull(db, key, { repo: `${ask.owner}/${ask.repo}`, number: one.pull.number, url: one.pull.url, foundBy: 'branch', title: one.pull.title, state: one.pull.state });
  }

  const pulls = cardPullRows(db, key);
  const done = { added: 0, messages: 0 };
  for (const pull of pulls) {
    const [owner = '', repo = ''] = pull.repo.split('/');
    const read = await readPullDiscussions(run, { owner, repo, number: pull.number }, signal);
    const stored = storeDiscussions(db, pull.id, read.viewer, discussionInputs(read));
    done.added += stored.added;
    done.messages += stored.messages;
  }

  const held = cardDiscussions(db, key);
  // Counted in discussions, as the tab counts them, so the two numbers on it never disagree.
  const unread = held.filter((one) => one.messages.some((message) => message.unread)).length;
  const said =
    pulls.length === 0
      ? `No pull request was found for ${key}, so there are no comments to read.`
      : `Read the comments of ${pulls.length === 1 ? '1 pull request' : `${pulls.length} pull requests`}: ${done.messages === 1 ? '1 new message' : `${done.messages} new messages`}.`;
  return { pulls: pulls.length, ...done, discussions: held.length, unread, said: [said, ...notes].join(' ') };
}

// The POST /api/card/<key>/pr/comments handler. A failed read answers its sentence and keeps what an
// earlier read stored. The board is told, because the card's comments line counts what was read.
export async function postCardDiscussions(db: DatabaseSync, key: string, told: () => void, run: RunGh = ghRunner()): Promise<Response> {
  try {
    const read = await readCardDiscussions(db, key, run);
    boardTold(db, told);
    return answer(200, read);
  } catch (error) {
    return answer(409, { message: (error as Error).message });
  }
}

// A write the card's comments line on the board reads. A new version, so the stream's event id moves
// with what it sends.
function boardTold(db: DatabaseSync, told: () => void): void {
  bumpVersion(db);
  told();
}

// POST /api/card/<key>/pr/seen, which the PRs tab sends as it opens, so the dots it shows are gone the
// next time. A local write: GitHub is not asked.
export function postDiscussionsSeen(db: DatabaseSync, key: string, told: () => void): Response {
  const seen = markDiscussionsSeen(db, key);
  if (seen > 0) boardTold(db, told);
  return answer(200, { seen });
}

// PATCH /api/card/<key>/pr/discussions with { ref, action }: Mark done, or Reopen and Needs action,
// which are one write. Kept on this machine only, GitHub is not told.
export function patchDiscussion(db: DatabaseSync, key: string, body: unknown, told: () => void): Response {
  const { ref, action } = (body ?? {}) as { ref?: unknown; action?: unknown };
  if (typeof ref !== 'string' || (action !== 'done' && action !== 'reopen')) return answer(400, { message: 'Send the ref of the comment, as in T1, and done or reopen.' });
  const done = markDiscussion(db, key, ref, action);
  if (done === 'missing') return answer(404, { message: `${key} has no comment ${ref}. Read the comments again.` });
  if (done === 'fixing') return answer(409, { message: `A fix is running on ${ref}. Change it once the fix is done.` });
  boardTold(db, told);
  return answer(200, { ref });
}

// A refusal with the status its route answers.
class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The pull request a link or an owner/repo#N names, or the sentence that says what to type instead.
function pullLink(link: unknown): { owner: string; repo: string; number: number; full: string } {
  // Anything but text reads as an empty field, which gets the sentence that says what to paste.
  const ref = pullRequestRef(typeof link === 'string' ? link : '');
  if ('refused' in ref) throw new Refused(400, ref.refused);
  return { owner: ref.owner, repo: ref.repo, number: ref.number, full: ref.name };
}

const refusedAnswer = (error: unknown) => answer(error instanceof Refused ? error.status : 409, { message: (error as Error).message });

/**
 * Attaches a pull request a person names to a Delivery card, beside the ones its branch finds. It is
 * read from GitHub before anything is stored, a GraphQL query and never a write, so a pull request that
 * is not there or not readable leaves the card as it was.
 */
export async function attachPull(db: DatabaseSync, key: string, link: unknown, run: RunGh, signal: AbortSignal): Promise<StoredCardPull[]> {
  if (boardOfCard(db, key) !== 'delivery') throw new Error(`${key} is not a Delivery card, so no pull request can be attached to it.`);
  // The same rule that shows the PRs tab, so the route refuses what the card page does not offer.
  const { stage } = db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string };
  if (!tabsFor('delivery', stage, cardPullRows(db, key).length > 0).some((tab) => tab.id === 'prs')) throw new Error(`${key} has not reached Pull request yet, so no pull request can be attached to it.`);
  const ref = pullLink(link);
  if (cardPullRows(db, key).some((one) => one.repo === `${ref.owner}/${ref.repo}`.toLowerCase() && one.number === ref.number)) throw new Error(`${ref.full} is on ${key} already.`);
  const found = await getPull(run, ref, signal);
  if (found.pull === null) {
    throw new Error(
      found.notFound
        ? `GitHub has no pull request ${ref.full}. The number may belong to an issue, the pull request may be gone, or this login may not open that repository.`
        : `${ref.full} could not be read from GitHub. The call failed, so the pull request may still be there. Try again.`,
    );
  }
  saveCardPull(db, key, { repo: `${ref.owner}/${ref.repo}`, number: ref.number, url: found.pull.url, foundBy: 'attached', title: found.pull.title, state: found.pull.state });
  return cardPullRows(db, key);
}

/** Takes an attached pull request off a card, with its discussions and messages. */
export function detachPull(db: DatabaseSync, key: string, link: unknown): StoredCardPull[] {
  const ref = pullLink(link);
  const done = detachCardPull(db, key, `${ref.owner}/${ref.repo}`, ref.number);
  if (done === 'branch') throw new Error(`${ref.full} was found by the card's branch, so it would come back on the next read. Only a pull request you attached can be detached.`);
  if (done === 'fixing') throw new Error(`A fix is running on a comment of ${ref.full}. Detach it once the fix is done.`);
  if (done === 'missing') throw new Error(`${ref.full} is not on ${key}.`);
  return cardPullRows(db, key);
}

// POST and DELETE /api/card/<key>/pr/links, with { link }. Both answer the card's pull requests after.
export async function postPullLink(db: DatabaseSync, key: string, body: unknown, run: RunGh = ghRunner()): Promise<Response> {
  try {
    return answer(200, { pulls: await attachPull(db, key, (body as { link?: unknown } | null)?.link, run, AbortSignal.timeout(READ_TIMEOUT_MS)) });
  } catch (error) {
    return refusedAnswer(error);
  }
}

// A detach drops the comments with it, so the board's card line is told.
export function deletePullLink(db: DatabaseSync, key: string, body: unknown, told: () => void): Response {
  try {
    const pulls = detachPull(db, key, (body as { link?: unknown } | null)?.link);
    boardTold(db, told);
    return answer(200, { pulls });
  } catch (error) {
    return refusedAnswer(error);
  }
}

// One pull request line of a closed card. The state is null when gh did not answer, and the link then
// opens GitHub's search for the branch, because no number was read to link to.
export interface CardPullLine {
  repo: string;
  branch: string;
  number: number | null;
  url: string;
  state: PullState | null;
  // Read only when gh answered with them: who merged it ("you" when it is the gh login), when it was
  // opened and merged, its size, and the branch it went into. The branch above is its head.
  mergedBy?: string;
  mergedAt?: string;
  openedAt?: string;
  additions?: number;
  deletions?: number;
  files?: number;
  base?: string;
}

const searchUrl = (ask: BranchAsk): string => `https://github.com/${ask.owner}/${ask.repo}/pulls?q=${encodeURIComponent(`is:pr head:${ask.branch}`)}`;

/**
 * The pull request state of a closed card, read through gh each time the card page asks, and written
 * nowhere. A gh that is missing, logged out or not answering keeps the links and claims no state, and
 * `said` names why. A repository with no pull request from the branch is named in `said` too.
 */
export async function cardPulls(db: DatabaseSync, key: string, run: RunGh, signal: AbortSignal): Promise<{ pulls: CardPullLine[]; said: string | null }> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return { pulls: [], said: null };
  let asks: BranchAsk[];
  try {
    asks = await branchAsks(db, project, key, gitEnv(process.env));
  } catch (error) {
    return { pulls: [], said: (error as Error).message };
  }
  if (asks.length === 0) return { pulls: [], said: null };
  const unread = (ask: BranchAsk): CardPullLine => ({ repo: `${ask.owner}/${ask.repo}`, branch: ask.branch, number: null, url: searchUrl(ask), state: null });
  let found: Awaited<ReturnType<typeof findBranchPulls>>;
  try {
    found = await findBranchPulls(run, asks, signal);
  } catch (error) {
    return { pulls: asks.map(unread), said: (error as Error).message };
  }
  const pulls: CardPullLine[] = [];
  const notes: string[] = [];
  for (const [at, ask] of asks.entries()) {
    const one = found[at];
    if (one?.read !== true) {
      pulls.push(unread(ask));
      notes.push(`GitHub did not answer for ${ask.owner}/${ask.repo}. The repository may be gone, or this login cannot open it.`);
    } else if (one.pull === null) notes.push(`${ask.owner}/${ask.repo} has no pull request from ${ask.branch}.`);
    else {
      const pull = one.pull;
      pulls.push({
        repo: `${ask.owner}/${ask.repo}`,
        branch: ask.branch,
        number: pull.number,
        url: pull.url ?? searchUrl(ask),
        state: pull.state,
        ...(pull.mergedBy === undefined ? {} : { mergedBy: pull.mergedBy === one.viewer ? 'you' : pull.mergedBy }),
        ...(pull.mergedAt === undefined ? {} : { mergedAt: pull.mergedAt }),
        ...(pull.createdAt === undefined ? {} : { openedAt: pull.createdAt }),
        ...(pull.additions === undefined ? {} : { additions: pull.additions }),
        ...(pull.deletions === undefined ? {} : { deletions: pull.deletions }),
        ...(pull.changedFiles === undefined ? {} : { files: pull.changedFiles }),
        ...(pull.baseRef === undefined ? {} : { base: pull.baseRef }),
      });
    }
  }
  return { pulls, said: notes.length === 0 ? null : notes.join(' ') };
}
