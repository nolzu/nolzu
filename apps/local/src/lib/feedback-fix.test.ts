import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTriage, cardDiscussions, type DiscussionInput, saveCardPull, storeDiscussions, writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { checkoutPath, GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixFeedback, moveTo } from '../routes/api/board/writes.ts';
import { discussionFor, messagesIn } from './discussion.ts';
import { openDiscussion } from './feedback.ts';
import { createLoop, fixOutcome, type Loop } from './loop.ts';

// Fix on a PRs tab row over the real loop and the fake engine: the implement session goes on with the
// discussion while the card stays on Pull request, the row goes fixing, then fixed with a note or new
// with the reason, and the card is back in the state it had.
let dir = '';
let loop: Loop;
let spawned: Job[] = [];
let replay: (job: Job, signal: AbortSignal) => AsyncIterable<string>;

const IMPLEMENT_SESSION = 'c5d9e2f1-7a3b-4c8d-9e0f-3b4a5c6d7e03';
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-feedback-fix-'));
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  spawned = [];
  replay = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    return replay(job, signal);
  };
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const card = (key: string) => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };
const row = (ref: string) => cardDiscussions(loop.db, 'APP-1').find((one) => one.ref === ref)!;
const say = (githubId: string, body: string, createdAt: string) => ({ githubId, author: 'dana', body, createdAt });
const thread = (githubId: string, body: string, createdAt: string): DiscussionInput => ({ kind: 'thread', githubId, path: 'src/search.ts', line: 12, resolved: false, outdated: false, messages: [say(`${githubId}-1`, body, createdAt)] });

async function settled(): Promise<void> {
  await vi.waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = loop.scheduler.queue();
    expect(queue.running.length + queue.waiting.length).toBe(0);
  }, WAIT);
}

// A card whose Implement run ended ready, then dragged on to Pull request, with two comments read.
async function onPullRequest(): Promise<void> {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'plan', 'ready', 'Search recipes')").run();
  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  await settled();
  loop.db.prepare("UPDATE cards SET stage = 'pr-watch', state = 'idle' WHERE key = 'APP-1'").run();
  const pull = saveCardPull(loop.db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
  storeDiscussions(loop.db, pull, 'pat', [thread('R1', 'The search misses capitals.', '2026-10-01T00:00:00Z'), thread('R2', 'Name the helper better.', '2026-10-02T00:00:00Z')]);
  applyTriage(loop.db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 'Case is ignored.', reason: 'The compare is case sensitive.', reply: 'Fixed.' }]);
  spawned = [];
}

it('goes on in the implement session with the discussion, keeps the card on Pull request, and ends fixed with the note', async () => {
  await onPullRequest();

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  // Queued: the row is fixing from the press, and the card waits where it is.
  expect(row('T1').status).toBe('fixing');
  expect(card('APP-1').stage).toBe('pr-watch');
  expect(loop.db.prepare("SELECT phase, thread FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ phase: 'implement', thread: 'T1' });
  await settled();

  expect(spawned.map((job) => job.phase)).toEqual(['implement']);
  const job = spawned[0]!;
  expect(job.resumeFrom).toBe(IMPLEMENT_SESSION);
  expect(job.prompt).toContain('T1: A review thread on cook/recipes#12, on src/search.ts:12.');
  expect(job.prompt).toContain('The search misses capitals.');
  expect(job.prompt).toContain('Triage summary: Case is ignored.');
  expect(job.prompt).toContain('Do not commit, do not push and do not reply on GitHub.');
  expect(job.prompt).not.toContain('Name the helper better.');

  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect([row('T1').status, row('T1').fixNote, row('T1').fixFailed]).toEqual(['fixed', 'The change is made and its tests pass. It is not committed yet, so it can still be read first.', null]);
  expect(row('T2').status).toBe('new');
  // No chain and no move: the card's trail has no move after the drag.
  expect(loop.db.prepare("SELECT to_stage FROM card_events WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ to_stage: 'implement' });

  // Fix again on the fixed row goes on in the same session.
  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();
  expect(spawned[1]?.resumeFrom).toBe(IMPLEMENT_SESSION);
  expect(row('T1').status).toBe('fixed');
});

it('runs one fix at a time, and the refusal names the one that runs', async () => {
  await onPullRequest();
  loop.engine.spawn = (job, signal) => {
    spawned.push(job);
    return (async function* () {
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve));
      yield* [];
    })();
  };

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  expect(() => loop.fixFeedback('APP-1', 'T2')).toThrow('T1 is being fixed now. One fix runs at a time, so wait for it to end.');
  const refused = fixFeedback(loop, 'APP-1', { ref: 'T2' });
  expect(refused.status).toBe(409);
  expect(row('T2').status).toBe('new');
  await vi.waitFor(() => expect(spawned.length).toBe(1), WAIT);
  loop.stop((loop.db.prepare("SELECT max(id) AS id FROM runs WHERE card_key = 'APP-1'").get() as { id: number }).id);
  await settled();
  // Once it ended, the next one may start.
  expect(row('T1').status).toBe('new');
  loop.engine.spawn = replay;
  expect(() => loop.fixFeedback('APP-1', 'T2')).not.toThrow();
  await settled();
});

it('sets the row back to new with the reason when the run fails, and the card back as it was', async () => {
  await onPullRequest();
  loop.db.prepare("UPDATE cards SET state = 'ready' WHERE key = 'APP-1'").run();
  // A stream that ends with no result is a failed run.
  loop.engine.spawn = (job) => {
    spawned.push(job);
    return (async function* () {
      yield* [];
    })();
  };

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();

  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'ready' });
  expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', 'The engine stopped and gave no result line, so the run cannot count as done.']);
});

it('sets the row back to new when the run is stopped', async () => {
  await onPullRequest();
  loop.engine.spawn = (job, signal) => {
    spawned.push(job);
    return (async function* () {
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve));
      yield* [];
    })();
  };

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await vi.waitFor(() => expect(spawned.length).toBe(1), WAIT);
  const runId = (loop.db.prepare("SELECT max(id) AS id FROM runs WHERE card_key = 'APP-1'").get() as { id: number }).id;
  loop.stop(runId);
  await settled();

  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', 'The fix was stopped.']);
});

it('says why a start failed on the row, and leaves the card as it was', async () => {
  await onPullRequest();
  // The profile that holds the session is gone from this machine, so the resume cannot be built.
  loop.db.prepare("UPDATE runs SET engine = 'gone-login' WHERE card_key = 'APP-1'").run();

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(false);
  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect(row('T1').status).toBe('new');
  expect(row('T1').fixFailed).toContain('gone-login');
  expect(spawned).toEqual([]);
});

it('refuses a card a question holds, a done row and a ref the card does not have, and writes nothing', async () => {
  await onPullRequest();
  loop.db.prepare("UPDATE pr_discussions SET status = 'done' WHERE ref = 'T2'").run();

  expect(() => loop.fixFeedback('APP-1', 'T2')).toThrow('T2 is done. Reopen it first if it still needs a fix.');
  expect(() => loop.fixFeedback('APP-1', 'T9')).toThrow('APP-1 has no discussion T9.');
  loop.db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
  expect(() => loop.fixFeedback('APP-1', 'T1')).toThrow('APP-1 is blocked. Answer the question on the overview first.');
  expect(fixFeedback(loop, 'APP-1', {}).status).toBe(400);
  expect(row('T1').status).toBe('new');
  expect(spawned).toEqual([]);
});

it('opens a Discuss thread under the ref once, starts its read-only session with the discussion first, and never changes the row', async () => {
  await onPullRequest();
  const before = row('T1');

  expect(openDiscussion(loop.db, 'APP-1', 'T1')).toEqual({ ok: true, thread: 'T1' });
  expect(openDiscussion(loop.db, 'APP-1', 'T1')).toEqual({ ok: true, thread: 'T1' });
  expect(openDiscussion(loop.db, 'APP-1', 'T9')).toEqual({ ok: false, reason: 'APP-1 has no comment T9. Read the comments again.' });
  const opened = messagesIn(loop.db, 'APP-1', 'T1');
  expect(opened).toHaveLength(1);
  expect(opened[0]?.body).toContain('Triage summary: Case is ignored.');

  const tab = discussionFor(loop.db, 'APP-1', 'T1', loop.models());
  expect(tab.current).toBe('T1');
  const thread = tab.threads.find((one) => one.id === 'T1')!;
  expect(thread).toMatchObject({ kind: 'feedback', sessionId: null });
  expect(loop.discuss('APP-1', thread, 'Is the reviewer right?')).toBe(true);
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'T1').some((one) => one.author === 'agent')).toBe(true), WAIT);

  const job = spawned.find((one) => one.phase === 'ask')!;
  expect(job.prompt).toContain('The search misses capitals.');
  expect(job.prompt.indexOf('Triage summary: Case is ignored.')).toBeLessThan(job.prompt.indexOf('Is the reviewer right?'));
  expect(row('T1')).toEqual(before);
  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
});

it('takes a Discuss message about the comment a fix runs on', async () => {
  await onPullRequest();
  loop.engine.spawn = (job, signal) => {
    spawned.push(job);
    if (job.phase !== 'implement') return replay(job, signal);
    return (async function* () {
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve));
      yield* [];
    })();
  };

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  openDiscussion(loop.db, 'APP-1', 'T1');
  const thread = discussionFor(loop.db, 'APP-1', 'T1', loop.models()).threads.find((one) => one.id === 'T1')!;
  expect(loop.discuss('APP-1', thread, 'Why does it fail?')).toBe(true);
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'T1').some((one) => one.author === 'agent')).toBe(true), WAIT);
  expect(row('T1').status).toBe('fixing');

  loop.stop((loop.db.prepare("SELECT id FROM runs WHERE card_key = 'APP-1' AND phase = 'implement' ORDER BY id DESC LIMIT 1").get() as { id: number }).id);
  await settled();
});

it('sets the row back to new when the run is stopped while it waits', async () => {
  await onPullRequest();
  // No slot is free, so the fix waits in the queue.
  loop.scheduler.resize(0);

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  expect(card('APP-1').state).toBe('queued');
  loop.stop((loop.db.prepare("SELECT max(id) AS id FROM runs WHERE card_key = 'APP-1'").get() as { id: number }).id);

  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', 'The fix was stopped before it started.']);
  expect(spawned).toEqual([]);
});

// The first fix run asks, as the needs-input replay does, and every later run is the phase's own.
const fixAsksFirst = () => {
  loop.engine.spawn = (job, signal) => {
    spawned.push(job);
    return replay(spawned.length === 1 ? { ...job, phase: 'needs-input' } : job, signal);
  };
};
const QUESTION = 'Should the search match ingredients as well as recipe titles?';

it('keeps a fix that asks on the row, and the answer on the overview goes on as the same fix', async () => {
  await onPullRequest();
  fixAsksFirst();

  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();
  // The card waits on the answer where it sits, and the row says what was asked, not a failure.
  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'blocked' });
  expect([row('T1').status, row('T1').fixAsks, row('T1').fixFailed]).toEqual(['fixing', QUESTION, null]);
  expect(() => loop.fixFeedback('APP-1', 'T2')).toThrow('T1 is being fixed now.');

  expect(loop.answer('APP-1', 'Titles only.')).toBe(true);
  expect(loop.db.prepare("SELECT phase, thread FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ phase: 'implement', thread: 'T1' });
  await settled();

  expect(spawned[1]).toMatchObject({ phase: 'implement', prompt: expect.stringMatching(/^Titles only\.\n\n## Before you end\n[\s\S]*`implement\/summary\.md`[\s\S]*share\/SUMMARY\.md/), resumeFrom: 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03' });
  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect([row('T1').status, row('T1').fixNote, row('T1').fixAsks]).toEqual(['fixed', 'The change is made and its tests pass. It is not committed yet, so it can still be read first.', null]);
  // The exchange is on the Implement thread, as any answer's is, and the hub gets neither run's words.
  expect(messagesIn(loop.db, 'APP-1', 'implement').map((one) => one.body)).toEqual(expect.arrayContaining([QUESTION, 'Titles only.']));
});

it('ends the fix with the reason when its answer cannot start, and puts the card back', async () => {
  await onPullRequest();
  fixAsksFirst();
  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();
  // A session nobody can resume, so the answer fails at its start.
  loop.db.prepare("UPDATE runs SET session_id = NULL WHERE card_key = 'APP-1' AND thread = 'T1'").run();

  expect(loop.answer('APP-1', 'Titles only.')).toBe(false);
  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', expect.stringMatching(/^There is no session "" to resume for APP-1\./)]);
  expect(() => loop.fixFeedback('APP-1', 'T2')).not.toThrow();
  await settled();
});

it('keeps the ref on the answer after a restart dropped the waiting fix, and lands it as a plain run', async () => {
  await onPullRequest();
  fixAsksFirst();
  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();
  loop.close();
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  expect(row('T1').status).toBe('new');

  expect(loop.answer('APP-1', 'Titles only.')).toBe(true);
  expect(loop.db.prepare("SELECT thread FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ thread: 'T1' });
  await settled();
  expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'ready' });
  expect(row('T1').status).toBe('new');
});

it('sets a fix that asked back to new when the card leaves the question another way', async () => {
  await onPullRequest();
  // The fake's own switch this time, as a run in fake mode turns it on.
  loop.close();
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', NOLZU_FAKE_FIX_ASKS: '1' });
  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();

  // A move back starts nothing, so no answer will ever come.
  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  expect(row('T1').status).toBe('new');
  expect(row('T1').fixFailed).toBe(`The card moved before the fix's question was answered. The fix asked: ${QUESTION}`);
  expect(() => loop.fixFeedback('APP-1', 'T2')).not.toThrow();
  await settled();
});

it('words how a fix ended for its row', () => {
  const ended = { state: 'complete', cardState: 'ready', question: null, failureReason: null };
  expect(fixOutcome(ended, '\nLower cased both sides.\nThe tests pass.')).toEqual({ ok: true, note: 'Lower cased both sides.' });
  expect(fixOutcome(ended, null)).toEqual({ ok: true, note: 'The fix ended without a summary. Read its edits on the Changes tab.' });
  expect(fixOutcome({ ...ended, state: 'failed', cardState: 'failed', failureReason: 'Rate limited.' }, null)).toEqual({ ok: false, reason: 'Rate limited.' });
  expect(fixOutcome({ ...ended, state: 'stopped', cardState: 'idle' }, null)).toEqual({ ok: false, reason: 'The fix was stopped.' });
  expect(fixOutcome({ ...ended, cardState: 'blocked', question: 'Which side?' }, null)).toEqual({ ok: false, reason: 'The fix asked: Which side?' });
});

describe('a fix run that commits or pushes', () => {
  let project = '';
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();
  const checkout = () => checkoutPath(project, 'APP-1', '.');
  const logOf = () => readFileSync((loop.db.prepare("SELECT log_path FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get() as { log_path: string }).log_path, 'utf8');

  // The card on Pull request with a real checkout, made by its Implement run.
  async function withCheckout(): Promise<void> {
    project = mkdtempSync(join(tmpdir(), 'nolzu-fix-project-'));
    git(project, 'init', '-q', '-b', 'main');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'base');
    writeSetting(loop.db, 'projectPath', project);
    writeSetting(loop.db, 'baseBranch', 'main');
    await onPullRequest();
    expect(existsSync(join(checkout(), '.git'))).toBe(true);
  }
  // The fix run does `act` in the checkout, then ends as `end` says.
  const fixDoes = (act: () => void, end: 'ready' | 'failed' | 'stopped' = 'ready') => {
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      act();
      if (end === 'ready') return replay(job, signal);
      return (async function* () {
        if (end === 'stopped' && !signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve));
        yield* [];
      })();
    };
  };

  afterEach(() => rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('ends fixed when nothing moved', async () => {
    await withCheckout();
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();
    expect(row('T1').status).toBe('fixed');
  });

  it('sets the row back to new, keeps the commit and writes the sentence to the log', async () => {
    await withCheckout();
    const from = git(checkout(), 'rev-parse', '--short=7', 'HEAD');
    fixDoes(() => git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'the run'));
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();

    const to = git(checkout(), 'rev-parse', '--short=7', 'HEAD');
    const sentence = `The fix run made a commit in the card checkout (${from} to ${to}). Nolzu does not commit for you. Look at git log in the checkout, keep or undo it, then commit from Changes.`;
    expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', sentence]);
    expect(git(checkout(), 'log', '-1', '--format=%s')).toBe('the run');
    expect(logOf()).toContain(sentence);
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  });

  it('checks a failed and a stopped run too, and keeps the failure reason after the sentence', async () => {
    await withCheckout();
    fixDoes(() => git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'the run'), 'failed');
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();
    expect(row('T1').fixFailed).toMatch(/^The fix run made a commit in the card checkout .* The engine stopped and gave no result line/);

    fixDoes(() => git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'again'), 'stopped');
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await vi.waitFor(() => expect(spawned.length).toBe(2), WAIT);
    loop.stop((loop.db.prepare("SELECT max(id) AS id FROM runs WHERE card_key = 'APP-1'").get() as { id: number }).id);
    await settled();
    expect(row('T1').fixFailed).toMatch(/^The fix run made a commit in the card checkout .* The fix was stopped\.$/);
  });

  it('checks a run that asks too, and then the row does not wait on an answer', async () => {
    await withCheckout();
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'the run');
      return replay({ ...job, phase: 'needs-input' }, signal);
    };
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();
    expect(row('T1').fixFailed).toMatch(/^The fix run made a commit in the card checkout .* The fix asked: Should the search match/);
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
  });

  it('checks the run the answer started', async () => {
    await withCheckout();
    let runs = 0;
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      runs += 1;
      if (runs === 2) git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'after the answer');
      return replay(runs === 1 ? { ...job, phase: 'needs-input' } : job, signal);
    };
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();
    expect(loop.answer('APP-1', 'Titles only.')).toBe(true);
    await settled();
    expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', expect.stringMatching(/^The fix run made a commit in the card checkout/)]);
  });

  it('gives a reason when the checkout is gone at the end', async () => {
    await withCheckout();
    fixDoes(() => rmSync(join(checkout(), '.git'), { force: true }));
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();
    expect(row('T1').status).toBe('new');
    expect(row('T1').fixFailed).toContain('Nolzu could not read the card checkout when the fix run ended (');
  });
});

// A run that says `text` and ends, as a QA run with its verdict line.
const says = (text: string) =>
  async function* () {
    yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 'qa-fixes-1', model: 'sonnet', cwd: '/workspace', tools: ['Read', 'Bash'] });
    yield JSON.stringify({ type: 'assistant', session_id: 'qa-fixes-1', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, duration_ms: 20, usage: {} });
  };

describe('Fix all', () => {
  it('fixes every row triage wants fixed in one run, each row with its own line, and a row with none goes back to new', async () => {
    await onPullRequest();
    applyTriage(loop.db, 'APP-1', [{ ref: 'T2', verdict: 'fix', summary: 'Rename it.', reason: 'Unclear name.', reply: null }]);
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      mkdirSync(join(job.taskDir, 'feedback'), { recursive: true });
      writeFileSync(join(job.taskDir, 'feedback', 'fixes.md'), 'T1: Lower-cased both sides.\n');
      return replay(job, signal);
    };

    expect(loop.fixAll('APP-1')).toBe(true);
    expect([row('T1').status, row('T2').status]).toEqual(['fixing', 'fixing']);
    expect(loop.db.prepare("SELECT phase, thread FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ phase: 'implement', thread: 'T1,T2' });
    expect(() => loop.fixFeedback('APP-1', 'T1')).toThrow('T1 is being fixed now.');
    await settled();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.resumeFrom).toBe(IMPLEMENT_SESSION);
    expect(spawned[0]!.prompt).toContain('Reviewers left these 2 comments');
    expect(spawned[0]!.prompt).toContain('The search misses capitals.');
    expect(spawned[0]!.prompt).toContain('Name the helper better.');
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
    expect([row('T1').status, row('T1').fixNote]).toEqual(['fixed', 'Lower-cased both sides.']);
    expect([row('T2').status, row('T2').fixFailed]).toEqual(['new', 'The run wrote no line for T2 in feedback/fixes.md. Read its edits on the Changes tab.']);
    expect(loop.db.prepare("SELECT to_stage FROM card_events WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ to_stage: 'implement' });

    // The second press takes only what is left, and a run that writes no file sends it back with that.
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      return replay(job, signal);
    };
    expect(loop.fixAll('APP-1')).toBe(true);
    await settled();
    expect(spawned[1]!.prompt).toContain('Reviewers left these comment on');
    expect(row('T1').status).toBe('fixed');
    expect(row('T2').fixFailed).toBe('The run wrote no feedback/fixes.md, so it does not say what it did for this comment. Read its edits on the Changes tab.');
  });

  it('waits on a question with every row fixing, and the answer goes on with the same rows and their notes', async () => {
    await onPullRequest();
    applyTriage(loop.db, 'APP-1', [{ ref: 'T2', verdict: 'fix', summary: 'Rename it.', reason: 'Unclear name.', reply: null }]);
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      if (spawned.length === 1) return replay({ ...job, phase: 'needs-input' }, signal);
      mkdirSync(join(job.taskDir, 'feedback'), { recursive: true });
      writeFileSync(join(job.taskDir, 'feedback', 'fixes.md'), 'T1: Lower-cased both sides.\nT2: Renamed it to matchTitle.\n');
      return replay(job, signal);
    };

    expect(loop.fixAll('APP-1')).toBe(true);
    await settled();
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'blocked' });
    expect([row('T1').fixAsks, row('T2').fixAsks]).toEqual([QUESTION, QUESTION]);

    expect(loop.answer('APP-1', 'Titles only.')).toBe(true);
    expect(loop.db.prepare("SELECT phase, thread FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ phase: 'implement', thread: 'T1,T2' });
    await settled();
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
    expect([row('T1').status, row('T1').fixNote, row('T2').status, row('T2').fixNote]).toEqual(['fixed', 'Lower-cased both sides.', 'fixed', 'Renamed it to matchTitle.']);
  });

  it('refuses with nothing left to fix, and writes nothing', async () => {
    await onPullRequest();
    loop.db.prepare("UPDATE pr_discussions SET verdict = 'reject' WHERE ref = 'T1'").run();
    const runs = () => loop.db.prepare("SELECT count(*) AS n FROM runs WHERE card_key = 'APP-1'").get();
    const before = runs();
    expect(() => loop.fixAll('APP-1')).toThrow('APP-1 has no comment left that triage wants fixed.');
    expect(runs()).toEqual(before);
    expect(row('T1').status).toBe('new');
  });
});

describe('QA the fixes', () => {
  // T1 fixed by a Fix, after a first QA that passed. Answers the card folder.
  async function fixedAfterQa(): Promise<string> {
    await onPullRequest();
    loop.db.prepare("INSERT INTO runs (card_key, phase, engine, state, started_at, verdict) VALUES ('APP-1', 'qa', 'claude-code', 'complete', '2026-11-16T09:00:00.000Z', 'PASS')").run();
    expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
    await settled();
    expect(row('T1').status).toBe('fixed');
    const folder = spawned[0]!.taskDir;
    spawned = [];
    return folder;
  }

  it('runs QA with the fixed comments, keeps the card where it is, and sends a failed comment back to new', async () => {
    await fixedAfterQa();
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      if (job.phase !== 'qa') return replay(job, signal);
      writeFileSync(join(job.taskDir, 'qa', 'report.md'), '## 1. Verdict\n\n- FAIL\n\n## 2. What QA checked\n\n1. pass: Run the tests\n2. fail: T1: The search ignores case now\n   Reason: capitals still miss\n');
      return says('NOLZU: verdict: FAIL T1 still misses capitals.\n\nNOLZU: complete')();
    };

    expect(loop.qaFixes('APP-1')).toBe(true);
    expect(loop.db.prepare("SELECT phase, thread FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get()).toEqual({ phase: 'qa', thread: 'T1' });
    await settled();

    expect(spawned[0]!.phase).toBe('qa');
    expect(spawned[0]!.resumeFrom ?? null).toBeNull();
    expect(spawned[0]!.prompt).toContain('This QA run checks the fixes made for review comments');
    expect(spawned[0]!.prompt).toContain('fixed since the QA of 2026-11-16');
    expect(spawned[0]!.prompt).toContain('The search misses capitals.');
    expect(spawned[0]!.prompt).not.toContain('Name the helper better.');
    // No chain and no move, and the card back to the state it had.
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
    expect(loop.db.prepare("SELECT verdict FROM runs WHERE card_key = 'APP-1' AND phase = 'qa' ORDER BY id DESC LIMIT 1").get()).toEqual({ verdict: 'FAIL' });
    expect([row('T1').status, row('T1').fixFailed]).toEqual(['new', 'QA says: capitals still miss']);
    // Nothing fixed since that QA, so it is refused until the next fix.
    expect(() => loop.qaFixes('APP-1')).toThrow('Nothing was fixed on APP-1 since its last QA, so QA has nothing new to check. Fix a comment first.');
  });

  it('keeps the report it writes over in qa/history, and leaves the rows fixed on a PASS', async () => {
    const folder = await fixedAfterQa();
    mkdirSync(join(folder, 'qa'), { recursive: true });
    writeFileSync(join(folder, 'qa', 'report.md'), 'first');
    let kept = '';
    loop.engine.spawn = (job, signal) => {
      spawned.push(job);
      if (job.phase !== 'qa') return replay(job, signal);
      kept = readFileSync(join(job.taskDir, 'qa', 'history', 'report-1.md'), 'utf8');
      writeFileSync(join(job.taskDir, 'qa', 'report.md'), 'second');
      return says('NOLZU: verdict: PASS\n\nNOLZU: complete')();
    };

    expect(loop.qaFixes('APP-1')).toBe(true);
    await settled();
    expect(kept).toBe('first');
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
    expect(row('T1').status).toBe('fixed');
    expect(() => loop.qaFixes('APP-1')).toThrow('Nothing was fixed on APP-1 since its last QA');
  });

  it('refuses a card with nothing fixed, and one a run holds, and writes nothing', async () => {
    await onPullRequest();
    expect(() => loop.qaFixes('APP-1')).toThrow('Nothing was fixed on APP-1 since its last QA');
    loop.db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
    expect(() => loop.qaFixes('APP-1')).toThrow('APP-1 is running. Wait for the run to end, then run QA of the fixes.');
    expect(loop.db.prepare("SELECT count(*) AS n FROM runs WHERE card_key = 'APP-1' AND phase = 'qa'").get()).toEqual({ n: 0 });
  });
});
