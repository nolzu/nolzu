import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE, type Job } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

let dir = '';
let project = '';
let live: Loop;
// Every job the engine was handed, so a second run can be read for its profile and its session.
let seen: Job[] = [];

// A second login of the same vendor, which is the case the limit is about: a person with a work
// account and a personal one. Its folder is a name of this test and no login on this machine.
const SECOND = { id: 'claude-code#work', label: 'Claude work', vendor: 'claude-code' as const, configDir: '/tmp/nolzu-test-claude-work' };

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: project,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' },
    encoding: 'utf8',
  });

const checkout = () => join(project, 'worktrees', 'APP-1');
const inCheckout = (...args: string[]) => git('-C', checkout(), ...args);

const SESSION = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a-session', model: 'sonnet', apiKeySource: 'none' });
// The engine's own line, in the shape a real run recorded, with the documented refusal on the window it
// names. No usage limit has been hit on any login here, so the refusal is built from the fields and
// not from a run that was refused.
const refused = (resetsAt: number | null) =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.41, resetsAt: null } } },
    session_id: 'a-session',
  });
const REJECTED = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'API Error: 429 rate_limit_error' });

// The work the stopped run left in the checkout: one changed file and the progress file with two
// plan steps done. Nothing is committed, because Nolzu commits nothing on its own.
const WORK = 'export const recipes = [];\n';
const PROGRESS = '1. Wrote the failing test for the list.\n2. Wrote the list, the test passes.\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-limit-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  writeSetting(live.db, 'projectPath', project);
  writeSetting(live.db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);
  seen = [];
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'implement', 'queued', 'Add a search box')").run();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The engine of the first run: it changes the checkout, writes its progress, then runs into the
// limit. The second run writes nothing and ends well, so what the first one left can be read back.
const spawnUntilLimit = (resetsAt: number | null) => {
  live.engine.spawn = async function* (job: Job) {
    seen.push(job);
    if (job.phase === 'extract-summary') return;
    if (seen.filter((one) => one.phase === 'implement').length > 1) {
      yield SESSION;
      yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
      return;
    }
    writeFileSync(join(job.cwd, 'recipes.js'), WORK);
    mkdirSync(join(job.taskDir, 'implement'), { recursive: true });
    writeFileSync(join(job.taskDir, 'implement', 'progress.md'), PROGRESS);
    yield SESSION;
    yield refused(resetsAt);
    yield REJECTED;
  };
};

async function runToEnd(start: () => void, phase = 'implement'): Promise<number> {
  start();
  const runId = (live.db.prepare('SELECT max(id) AS id FROM runs WHERE phase = ?').get(phase) as { id: number }).id;
  for (let tries = 0; tries < 300; tries += 1) {
    const state = readRun(live.db, runId)?.state;
    if (state === 'complete' || state === 'failed' || state === 'stopped') return runId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

const hoursOut = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;

// The reset is four hours out and the whole retry schedule is 22 minutes, so every resume would be
// refused again. The retry schedule holds that rule; this is the card reading it.
it('names the limit and the reset time on a run that stopped on a usage limit', async () => {
  spawnUntilLimit(hoursOut(4));

  const runId = await runToEnd(() => live.start('APP-1', 'implement'));

  expect(readRun(live.db, runId)?.failureReason).toMatch(/^5-hour limit, resets /);
  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('failed');
});

// Nothing is invented for a reset the engine did not report. The waits are turned off here, so the
// run gives up at once and the sentence is the one the card keeps.
it('says the reset time is not known when the engine reported none', async () => {
  writeSetting(live.db, 'retryWaitsMs', []);
  spawnUntilLimit(null);

  const runId = await runToEnd(() => live.start('APP-1', 'implement'));

  expect(readRun(live.db, runId)?.failureReason).toBe('5-hour limit reached. The engine reported no reset time, so when it frees up is not known.');
});

/**
 * The rule that costs most if it breaks: Nolzu commits nothing on its own.
 *
 * A run that stopped on a usage limit leaves its work in the card's checkout, uncommitted, so the
 * next run of the phase goes on from there. This reads the checkout back after such a run.
 */
it('leaves the checkout exactly as the stopped run left it', async () => {
  spawnUntilLimit(hoursOut(4));

  await runToEnd(() => live.start('APP-1', 'implement'));

  expect(readFileSync(join(checkout(), 'recipes.js'), 'utf8')).toBe(WORK);
  // Still uncommitted and still not staged: the file is there as the run wrote it.
  expect(inCheckout('status', '--porcelain').trim()).toBe('?? recipes.js');
  expect(inCheckout('log', '--format=%s').trim()).toBe('first');
  expect(inCheckout('stash', 'list').trim()).toBe('');
});

// A session belongs to one profile, so this is a fresh run and never a resume. The checkout is the
// card's own and is not touched, which is what the fresh run reads its work out of.
it('starts the same phase on another profile as a fresh run in the same checkout', async () => {
  spawnUntilLimit(hoursOut(4));
  await runToEnd(() => live.start('APP-1', 'implement'));

  const second = await runToEnd(() => {
    expect(live.retry('APP-1', SECOND.id)).toBe(true);
  });

  const job = seen.filter((one) => one.phase === 'implement')[1];
  expect(job?.engine).toBe(SECOND.id);
  expect(job?.resumeFrom).toBeNull();
  expect(job?.sessionId).toBeNull();
  expect(job?.cwd).toBe(checkout());
  expect(readRun(live.db, second)?.engine).toBe(SECOND.id);
  // The first run's work is still there for the second one to read.
  expect(existsSync(join(checkout(), 'recipes.js'))).toBe(true);
});

// The fresh run has no session and no memory of the run that stopped, so the steps it already
// finished have to be in the prompt.
it('tells the fresh run to go on from the first step the progress file leaves open', async () => {
  spawnUntilLimit(hoursOut(4));
  await runToEnd(() => live.start('APP-1', 'implement'));

  await runToEnd(() => {
    expect(live.retry('APP-1', SECOND.id)).toBe(true);
  });

  const job = seen.filter((one) => one.phase === 'implement')[1];
  expect(job?.prompt).toContain('lists steps 1, 2 as done');
  expect(job?.prompt).toContain('go on from step 3');
});

// A login this machine does not hold would start a run nothing can spawn, and the card would be
// left queued with no job behind it.
it('refuses a profile this machine has no login for, and leaves the card failed', async () => {
  spawnUntilLimit(hoursOut(4));
  await runToEnd(() => live.start('APP-1', 'implement'));

  expect(() => live.retry('APP-1', 'codex#gone')).toThrow(/codex#gone/);
  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('failed');
});

/**
 * A card sent back to plan gets a new plan, and the steps of the old one name nothing any more.
 *
 * Left in the folder, that file would tell the next implement run to go on from a step nobody
 * planned, and to redo none of the steps it lists.
 */
it('drops the progress file of the old plan when a plan run starts', async () => {
  live.engine.spawn = async function* (job: Job) {
    seen.push(job);
    yield SESSION;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };
  const folder = join(project, '.tasks', 'APP-1', 'implement');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'progress.md'), PROGRESS);

  await runToEnd(() => {
    expect(live.start('APP-1', 'plan')).toBe(true);
  }, 'plan');

  expect(existsSync(join(folder, 'progress.md'))).toBe(false);
});
