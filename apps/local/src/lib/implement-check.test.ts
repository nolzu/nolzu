import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTriage, commitWarningOf, saveCardPull, storeDiscussions, writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { checkoutPath, GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { createLoop, type Loop } from './loop.ts';
import { overviewFor } from './overview.ts';

// The commit check on every Implement run, over the real loop, the fake engine and a real
// checkout: a commit the run makes is named on the card and in the log, nothing is reset, and the card
// ends as it would.
let dir = '';
let project = '';
let loop: Loop;
let replay: (job: Job, signal: AbortSignal) => AsyncIterable<string>;

const WAIT = { timeout: 10_000 };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();
const checkout = () => checkoutPath(project, 'APP-1', '.');
const head = () => git(checkout(), 'rev-parse', '--short=7', 'HEAD');
const card = () => loop.db.prepare("SELECT stage, state FROM cards WHERE key = 'APP-1'").get() as { stage: string; state: string };
const logOf = () => readFileSync((loop.db.prepare("SELECT log_path FROM runs WHERE card_key = 'APP-1' ORDER BY id DESC LIMIT 1").get() as { log_path: string }).log_path, 'utf8');
const sentence = (from: string, to: string) =>
  `The implement run made a commit in the card checkout (${from} to ${to}). Nolzu does not commit for you. Look at git log in the checkout, keep or undo it, then commit from Changes.`;

// Each run does what `act` says in the checkout before the fake engine replays it.
const runs = (act: (count: number, job: Job) => Job | void) => {
  let count = 0;
  loop.engine.spawn = (job, signal) => replay(act(++count, job) ?? job, signal);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-implement-check-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-implement-project-'));
  git(project, 'init', '-q', '-b', 'main');
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'base');
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  replay = loop.engine.spawn.bind(loop.engine);
  writeSetting(loop.db, 'projectPath', project);
  writeSetting(loop.db, 'baseBranch', 'main');
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'plan', 'ready', 'Search recipes')").run();
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function settled(): Promise<void> {
  await vi.waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = loop.scheduler.queue();
    expect(queue.running.length + queue.waiting.length).toBe(0);
  }, WAIT);
}

it('warns about nothing when the run moved nothing', async () => {
  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  await settled();
  expect(card()).toEqual({ stage: 'implement', state: 'ready' });
  expect(commitWarningOf(loop.db, 'APP-1')).toBeNull();
  expect(logOf()).not.toContain('made a commit');
});

it('names a commit the run made on the card and in the log, keeps it, and ends the card as it would', async () => {
  let from = '';
  runs(() => {
    from = head();
    git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'the run');
  });
  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  await settled();

  const said = sentence(from, head());
  expect(card()).toEqual({ stage: 'implement', state: 'ready' });
  expect(git(checkout(), 'log', '-1', '--format=%s')).toBe('the run');
  expect(commitWarningOf(loop.db, 'APP-1')).toBe(said);
  expect(overviewFor(loop.db, 'APP-1')?.commitWarning).toBe(said);
  expect(logOf()).toContain(said);
});

it('checks the run an answer resumed, and the next Implement run clears the warning', async () => {
  let from = '';
  runs((count, job) => {
    if (count === 1) return { ...job, phase: 'needs-input' };
    if (count === 2) {
      from = head();
      git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'after the answer');
    }
  });
  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  await settled();
  expect(card().state).toBe('blocked');
  expect(loop.answer('APP-1', 'Titles only.')).toBe(true);
  await settled();
  expect(commitWarningOf(loop.db, 'APP-1')).toBe(sentence(from, head()));

  // A Send back starts the next Implement run, which commits nothing.
  loop.db
    .prepare("INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at) VALUES ('APP-1', '.', 'src/search.ts', 1, 'x', 'Match capitals too.', 'abc', '2026-10-29T08:00:00.000Z')")
    .run();
  expect(await loop.sendBack('APP-1')).toBe(true);
  await settled();
  expect(card()).toEqual({ stage: 'implement', state: 'ready' });
  expect(commitWarningOf(loop.db, 'APP-1')).toBeNull();
});

it('leaves a Fix run to its row, so the commit is not warned about twice', async () => {
  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  await settled();
  loop.db.prepare("UPDATE cards SET stage = 'pr-watch', state = 'idle' WHERE key = 'APP-1'").run();
  const pull = saveCardPull(loop.db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
  storeDiscussions(loop.db, pull, 'pat', [
    { kind: 'thread', githubId: 'R1', path: 'src/search.ts', line: 12, resolved: false, outdated: false, messages: [{ githubId: 'R1-1', author: 'dana', body: 'The search misses capitals.', createdAt: '2026-10-01T00:00:00Z' }] },
  ]);
  applyTriage(loop.db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 'Case is ignored.', reason: 'The compare is case sensitive.', reply: 'Fixed.' }]);
  runs(() => {
    git(checkout(), 'commit', '-q', '--allow-empty', '-m', 'the fix');
  });
  expect(loop.fixFeedback('APP-1', 'T1')).toBe(true);
  await settled();

  expect(commitWarningOf(loop.db, 'APP-1')).toBeNull();
  const log = logOf();
  expect(log.match(/made a commit/g)).toHaveLength(1);
  expect(log).toContain('The fix run made a commit in the card checkout');
});
