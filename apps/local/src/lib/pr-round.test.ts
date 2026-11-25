import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import type { Engine, RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoop, type Loop } from './loop.ts';
import { refreshPulls } from './pull-list.ts';

// A DOCUMENTED SHAPE NOBODY HAS MEASURED. The `gh` here is a stub, and no test calls GitHub. The open
// list is written from the GitHub GraphQL schema, the way the fixtures in
// `packages/runner/src/tickets/github.test.ts` are, and that file names the fields one recorded answer
// has to confirm. `headRefOid` and `commits.totalCount` are two of them.
const pull = (number: number, head: string, count: number) => ({
  __typename: 'PullRequest',
  number,
  title: 'Add pagination to the recipe list',
  body: '',
  url: `https://github.com/cook/recipes/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  author: { login: 'ben' },
  reviewDecision: 'CHANGES_REQUESTED',
  headRefOid: head,
  commits: { totalCount: count, nodes: [{ commit: { committedDate: pushedAt } }] },
  latestOpinionatedReviews: { nodes: reviews },
  ...(decision === null ? {} : { reviewDecision: decision }),
});

const REPO = { owner: 'cook', repo: 'recipes' };
const KEY = 'recipes#41';
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '3b1c8f44-2d6e-4a91-8f0b-7c5e9a2d1b60', model: 'sonnet', apiKeySource: 'none' });
const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });

let folder = '';
let pr: Loop;
let spawned: Engine['spawn'];
// What GitHub holds now. A test pushes by changing both.
let head = 'a1';
let count = 3;
let pushedAt = '2026-10-15T09:00:00.000Z';
// Each reviewer's newest opinionated review, the decision GitHub sums over all of them, and whether the
// head read before a review's diff fails. The login gh runs as is `me`.
let reviews: { author: { login: string }; state: string; submittedAt: string; commit: { oid: string } }[] = [];
let decision: string | null = null;
let headFails = false;
// Whether the review run writes its round file, and how many it wrote.
let writes = true;
let rounds = 0;
let reads = 0;

const gh: RunGh = (args) => {
  // The diff a review run reads before its engine starts.
  if (args[0] === 'pr') return Promise.resolve({ code: 0, stdout: 'diff --git a/src/list.ts b/src/list.ts\n-one\n+two\n', stderr: '' });
  // The head a review run reads right before its diff, one pull request by number.
  if ((args[3] ?? '').includes('issueOrPullRequest') && headFails) return Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 502\n' });
  if ((args[3] ?? '').includes('issueOrPullRequest')) return Promise.resolve({ code: 0, stdout: JSON.stringify({ data: { t0: { issueOrPullRequest: pull(41, head, count) } } }), stderr: '' });
  reads += 1;
  return Promise.resolve({ code: 0, stdout: JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequests: { nodes: [pull(41, head, count)], pageInfo: { hasNextPage: false } } }, asked: { nodes: [{ number: 41 }] } } }), stderr: '' });
};

const read = () => refreshPulls(pr.db, gh, REPO, AbortSignal.timeout(1000));
const card = () => pr.snapshot('prreview').cards.find((one) => one.key === KEY);
const saved = () => pr.db.prepare('SELECT pr_head_sha AS head, pr_head_commits AS commits, pr_round AS round FROM cards WHERE key = ?').get(KEY);
const runCount = () => (pr.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;
// A person's drag. A move sets the card idle, as `moveCard` does; the test starts the review itself
// where a drop would. The read moves a card that waits on the author back to Incoming on a push.
const drag = (stage: string) => {
  pr.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who) SELECT key, stage, ?, 'you' FROM cards WHERE key = ?").run(stage, KEY);
  pr.db.prepare("UPDATE cards SET stage = ?, state = 'idle' WHERE key = ?").run(stage, KEY);
};

const review = async () => {
  expect(pr.start(KEY, 'pr-review')).toBe(true);
  const runId = (pr.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  // The run makes a real worktree first, which takes seconds on a busy machine, past vitest's one
  // second default.
  await vi.waitFor(() => expect(['complete', 'failed']).toContain(readRun(pr.db, runId)?.state), { timeout: 10_000 });
  expect(readRun(pr.db, runId)?.state).toBe('complete');
};

beforeEach(() => {
  head = 'a1';
  count = 3;
  pushedAt = '2026-10-15T09:00:00.000Z';
  reviews = [];
  decision = null;
  headFails = false;
  writes = true;
  rounds = 0;
  reads = 0;
  folder = mkdtempSync(join(tmpdir(), 'nolzu-pr-round-'));
  pr = createLoop(folder, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { gh });
  spawned = pr.engine.spawn.bind(pr.engine);
  pr.engine.spawn = async function* (job: Job) {
    // The extraction pass is not the review, and it writes no round.
    if (job.phase === 'extract-summary') return;
    if (writes) {
      rounds += 1;
      // The names the review skill writes: round.md first, then round-2.md beside it.
      mkdirSync(join(job.taskDir, 'pr-review'), { recursive: true });
      writeFileSync(join(job.taskDir, 'pr-review', rounds === 1 ? 'round.md' : `round-${rounds}.md`), '# Round\n');
    }
    yield INIT;
    yield DONE;
  };
});

afterEach(() => {
  pr.engine.spawn = spawned;
  pr.close();
  rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('saves the head the review read and its round', async () => {
  await read();
  drag('pre-review');

  await review();

  expect(saved()).toEqual({ head: 'a1', commits: 3, round: 1 });
  expect(card()?.pull).toMatchObject({ round: 1 });
  expect(card()?.pull).not.toHaveProperty('newCommits');
});

it('sends a card that waits on the author back to Incoming after a push, and starts nothing', async () => {
  await read();
  drag('pre-review');
  await review();
  drag('awaiting-author');

  // Before the push: the head is the one the round read.
  const before = await read();
  expect(card()?.pull).not.toHaveProperty('newCommits');
  expect(before.said).not.toContain('New commits');
  expect(card()?.stage).toBe('awaiting-author');

  head = 'b2';
  count = 4;
  const runs = runCount();
  const after = await read();

  expect(card()?.pull).toMatchObject({ round: 1, newCommits: 1 });
  expect(after.said).toContain('recipes#41 has new commits and went back to Incoming.');
  expect(after.said).not.toContain('New commits since');
  // The push moves the card and starts nothing: the next round is a person's drop on Agent pre-review.
  expect(card()).toMatchObject({ stage: 'incoming', state: 'idle' });
  expect(runCount()).toBe(runs);
  expect(pr.db.prepare('SELECT from_stage, to_stage, who, started_phase FROM card_events WHERE card_key = ? ORDER BY id DESC LIMIT 1').get(KEY)).toEqual({
    from_stage: 'awaiting-author',
    to_stage: 'incoming',
    who: 'auto',
    started_phase: null,
  });
});

// Only Awaiting author waits on a push. A card on My review keeps its column and says the push.
it('leaves a card on another column where it is after a push, and names the push', async () => {
  await read();
  drag('pre-review');
  await review();
  drag('my-review');

  head = 'b2';
  count = 4;
  const after = await read();

  expect(card()).toMatchObject({ stage: 'my-review', pull: { newCommits: 1 } });
  expect(after.said).toContain('New commits since the last review round: recipes#41.');
});

// A push after the last read and before the review is in the diff the review read, so the round saves
// that head. Saved as the read's older head, the next read would send the card back for a push the
// review already saw.
it('saves the head the diff was read at, so a push the review saw sends nothing back', async () => {
  await read();
  drag('pre-review');
  head = 'b2';
  count = 4;

  await review();

  expect(saved()).toEqual({ head: 'b2', commits: 4, round: 1 });
  drag('awaiting-author');
  const after = await read();
  expect(card()).toMatchObject({ stage: 'awaiting-author' });
  expect(card()?.pull).not.toHaveProperty('newCommits');
  expect(after.said).not.toContain('went back');
});

it('counts every commit pushed since the round', async () => {
  await read();
  drag('pre-review');
  await review();
  drag('awaiting-author');

  head = 'c3';
  count = 6;
  await read();

  expect(card()?.pull?.newCommits).toBe(3);
});

// Nothing polls. The board learns of a push only when a person presses Read pull requests.
it('reads GitHub only when Read pull requests is pressed', async () => {
  await read();
  drag('pre-review');
  await review();
  head = 'b2';

  expect(reads).toBe(1);
  expect(card()?.pull).not.toHaveProperty('newCommits');
});

it('saves round 2 and the new head on the next round, and the card says nothing new', async () => {
  await read();
  drag('pre-review');
  await review();
  drag('awaiting-author');
  head = 'b2';
  count = 4;
  await read();
  expect(card()?.stage).toBe('incoming');
  drag('pre-review');

  await review();

  expect(saved()).toEqual({ head: 'b2', commits: 4, round: 2 });
  expect(card()?.pull).toMatchObject({ round: 2 });
  expect(card()?.pull).not.toHaveProperty('newCommits');
});

// A run that ended without a round file has no review on the Review tab to point at.
it('saves no head and no round when the run wrote no round file', async () => {
  writes = false;
  await read();
  drag('pre-review');

  await review();

  expect(saved()).toEqual({ head: null, commits: null, round: null });
  expect(card()?.pull).toMatchObject({ round: null });
});

// The person approved the pull request themselves: the card that waited on the author goes on to
// Approved. GitHub's reviewDecision says APPROVED on anybody's approval, so it alone moves nothing. The
// approval counts on the head it was given on, and only when it came after the card entered Awaiting
// author.
describe('the person own approval', () => {
  const waiting = async () => {
    await read();
    drag('pre-review');
    await review();
    drag('awaiting-author');
  };
  // A minute ahead, so it is newer than any move a test makes.
  const soon = () => new Date(Date.now() + 60_000).toISOString();
  const by = (login: string, state = 'APPROVED', oid = head, at = soon()) => ({ author: { login }, state, submittedAt: at, commit: { oid } });
  const last = () => pr.db.prepare('SELECT to_stage, who FROM card_events WHERE card_key = ? ORDER BY id DESC LIMIT 1').get(KEY);

  it('moves a card from Awaiting author to Approved, and says so', async () => {
    await waiting();
    reviews = [by('me')];

    const after = await read();

    expect(card()?.stage).toBe('approved');
    expect(after.said).toContain('recipes#41 is approved by you and moved to Approved.');
    expect(last()).toEqual({ to_stage: 'approved', who: 'auto' });
  });

  it('leaves the card when somebody else approved it', async () => {
    await waiting();
    decision = 'APPROVED';
    reviews = [by('dana')];

    const after = await read();

    expect(card()?.stage).toBe('awaiting-author');
    expect(after.said).not.toContain('approved by you');
  });

  it('leaves the card when the person asked for changes', async () => {
    await waiting();
    reviews = [by('me', 'CHANGES_REQUESTED')];

    await read();

    expect(card()?.stage).toBe('awaiting-author');
  });

  // A reply in a review thread after an approval is a COMMENTED review, and the opinionated list leaves
  // it out, so the approval still counts. A DISMISSED approval is no approval.
  it('moves on an approval a later comment does not hide, and not on a dismissed one', async () => {
    await waiting();
    reviews = [by('me', 'DISMISSED')];
    await read();
    expect(card()?.stage).toBe('awaiting-author');

    // What the list answers after an approval and a later comment: the approval alone.
    reviews = [by('me')];
    await read();
    expect(card()?.stage).toBe('approved');
  });

  it('leaves a card on another column where it is', async () => {
    await read();
    drag('pre-review');
    await review();
    drag('my-review');
    reviews = [by('me')];

    await read();

    expect(card()?.stage).toBe('my-review');
  });

  // The board's own move rule: a card its run owns cannot move.
  it('leaves a queued or running card where it is', async () => {
    await waiting();
    reviews = [by('me')];
    for (const state of ['queued', 'running']) {
      pr.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, KEY);
      await read();
      expect(card()?.stage, state).toBe('awaiting-author');
    }
  });

  // An approval given on an older commit never saw the code there now. Whatever the clocks say, the
  // push rule decides: the head moved since the round, so the card goes back to Incoming.
  it('sends the card back to Incoming when the approval was given on an older commit', async () => {
    await waiting();
    reviews = [by('me', 'APPROVED', 'a1')];
    head = 'b2';
    count = 4;

    expect((await read()).said).toContain('went back to Incoming');
    expect(card()?.stage).toBe('incoming');
  });

  // Same head as the round, approved on an older commit: no push since the round, so the card stays.
  it('leaves the card when the approval was given on an older commit and nothing was pushed since the round', async () => {
    await waiting();
    reviews = [by('me', 'APPROVED', 'z9')];

    await read();

    expect(card()?.stage).toBe('awaiting-author');
  });

  it('takes the card to Approved when the approval is on the head the author pushed', async () => {
    await waiting();
    head = 'b2';
    count = 4;
    reviews = [by('me', 'APPROVED', 'b2')];

    await read();

    expect(card()?.stage).toBe('approved');
  });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  // The usual order: read the findings on My review, approve on GitHub, then drag the card on. The
  // approval is older than the move into Awaiting author, and it still counts.
  it('moves a card approved before it was dragged to Awaiting author', async () => {
    await read();
    drag('pre-review');
    await review();
    drag('my-review');
    reviews = [by('me', 'APPROVED', head, ago(60_000))];
    drag('awaiting-author');

    await read();

    expect(card()?.stage).toBe('approved');
  });

  // The author pushed B while the card sat on My review, and the person approved B. The head moved
  // since the round, and the approval on that head still wins over the push rule.
  it('moves a card whose approval is on a head pushed after the round', async () => {
    await read();
    drag('pre-review');
    await review();
    drag('my-review');
    head = 'b2';
    count = 4;
    reviews = [by('me', 'APPROVED', 'b2', ago(60_000))];
    drag('awaiting-author');

    await read();

    expect(card()?.stage).toBe('approved');
  });

  // The person took the card back from Approved, straight or through My review. The approval is the
  // one they took it back from, so the card stays where they put it.
  it('leaves a card the person took back from Approved where they put it', async () => {
    await waiting();
    reviews = [by('me', 'APPROVED', head, ago(60_000))];
    await read();
    expect(card()?.stage).toBe('approved');

    drag('awaiting-author');
    await read();
    expect(card()?.stage).toBe('awaiting-author');

    drag('approved');
    drag('my-review');
    drag('awaiting-author');
    await read();
    expect(card()?.stage).toBe('awaiting-author');
  });

  it('moves a card taken back from Approved on a new approval of the current head', async () => {
    await waiting();
    reviews = [by('me', 'APPROVED', head, ago(60_000))];
    await read();
    drag('awaiting-author');
    // A new approval, after the move out of Approved.
    await tick();
    reviews = [by('me', 'APPROVED', head, new Date().toISOString())];

    await read();

    expect(card()?.stage).toBe('approved');
  });
});

// A head that cannot be read before the diff saves the head the last Read pull requests saw, so a
// failed read never claims a push or hides one.
it('saves the head the last read saw when the head read before the diff fails', async () => {
  await read();
  drag('pre-review');
  headFails = true;

  await review();

  expect(saved()).toEqual({ head: 'a1', commits: 3, round: 1 });
});
