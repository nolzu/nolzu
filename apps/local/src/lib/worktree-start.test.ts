import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun, writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

let dir = '';
let project = '';
let live: Loop;

// A plain git repository with one commit, and no config of the person's own, so the test runs the same
// on every machine.
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: project,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' },
    encoding: 'utf8',
  });

// What the engine saw when it started, kept by a stand-in spawn so no real engine is needed.
let seen: { cwd: string; existed: boolean; branch: string | null }[] = [];
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-start-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  // No git config of the person's own reaches the loop, so git behaves the same on every machine.
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  writeSetting(live.db, 'projectPath', project);
  seen = [];
  live.engine.spawn = async function* (job: Job) {
    // This stand-in writes no plain summary, so each ready run is followed by the extraction pass.
    // Only the phase runs are what these tests watch.
    if (job.phase === 'extract-summary') return;
    const existed = existsSync(join(job.cwd, '.git'));
    seen.push({ cwd: job.cwd, existed, branch: existed ? execFileSync('git', ['branch', '--show-current'], { cwd: job.cwd, encoding: 'utf8' }).trim() : null });
    yield RESULT;
  };
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, title: string) =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', 'refine', 'queued', ?)").run(key, title);

async function runToEnd(key: string): Promise<number> {
  live.start(key, 'refine');
  const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  // Thirty seconds, not two. The run makes a real git worktree and spawns the fake engine, and on a
  // loaded machine or a CI runner that is slower than a poll of two seconds. A budget is a guess
  // either way, so it is a generous one: a run that never ends still fails the test, just later.
  for (let tries = 0; tries < 3000; tries += 1) {
    const state = readRun(live.db, runId)?.state;
    // Out of the queue too: the summary pass and its git compare still hold the slot.
    if ((state === 'complete' || state === 'failed' || state === 'stopped') && !live.scheduler.queue().running.some((job) => job.runId === runId)) return runId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

it('makes the card its own checkout on its own branch before the engine starts', async () => {
  addCard('APP-1', 'Add a search box');

  await runToEnd('APP-1');

  expect(seen).toEqual([{ cwd: join(project, 'worktrees', 'APP-1'), existed: true, branch: 'feature/APP-1/add-a-search-box' }]);
});

it('uses the checkout it already made when the card runs again', async () => {
  addCard('APP-1', 'Add a search box');
  await runToEnd('APP-1');
  git('-C', join(project, 'worktrees', 'APP-1'), 'commit', '-q', '--allow-empty', '-m', 'work of the first run');
  live.db.prepare("UPDATE cards SET state = 'queued' WHERE key = 'APP-1'").run();

  await runToEnd('APP-1');

  expect(seen).toHaveLength(2);
  // The first run's commit is still there, so the second run continued in the same checkout.
  expect(git('-C', join(project, 'worktrees', 'APP-1'), 'log', '--format=%s', '-1').trim()).toBe('work of the first run');
});

// The branch is the card's from its first start. Worked out again from a new title or a new template,
// it no longer matched the checkout, every later start failed, and a checkout made again from the new
// name would have left the earlier phases' commits behind on the old branch.
it.each([
  ['the title', () => live.db.prepare("UPDATE cards SET title = 'Add a search field' WHERE key = 'APP-1'").run()],
  ['the branch template', () => writeSetting(live.db, 'branchTemplate', 'nolzu/{key}')],
  // A project that stored no template took the new default, and its started cards keep their names.
  ['the stored template to the default', () => live.db.prepare("DELETE FROM settings WHERE key = 'branchTemplate'").run()],
])('keeps the card on its first branch when %s changes', async (_, change) => {
  writeSetting(live.db, 'branchTemplate', '{key}-{slug}');
  addCard('APP-1', 'Add a search box');
  await runToEnd('APP-1');
  change();
  live.db.prepare("UPDATE cards SET state = 'queued' WHERE key = 'APP-1'").run();

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(seen.map((one) => one.branch)).toEqual(['APP-1-add-a-search-box', 'APP-1-add-a-search-box']);
});

// A job can wait long for its slot. Made in the new project while the engine starts in the old one, a
// real engine would write in a repository nobody chose for this run.
it('fails the run when the project changed while the job waited', async () => {
  addCard('APP-1', 'Add a search box');
  const other = mkdtempSync(join(tmpdir(), 'nolzu-other-'));
  const job = live.buildJob('APP-1', 'refine', 99);
  writeSetting(live.db, 'projectPath', other);
  try {
    const runId = live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'refine', 'fake', 'queued')").run().lastInsertRowid;
    live.scheduler.add({ ...job, runId: Number(runId) });
    for (let tries = 0; tries < 200 && (!['complete', 'failed'].includes(readRun(live.db, Number(runId))?.state ?? '') || live.scheduler.queue().running.some((job) => job.runId === Number(runId))); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(seen).toEqual([]);
    expect(readRun(live.db, Number(runId))?.failureReason).toMatch(/project changed/);
    expect(existsSync(join(other, 'worktrees'))).toBe(false);
  } finally {
    rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The card has to say what went wrong, and no engine may start in a folder that is not the card's.
it('fails the run with git reason and starts no engine when the checkout cannot be made', async () => {
  writeSetting(live.db, 'baseBranch', 'trunk');
  addCard('APP-1', 'Add a search box');

  const runId = await runToEnd('APP-1');

  expect(seen).toEqual([]);
  const run = readRun(live.db, runId);
  expect(run?.state).toBe('failed');
  expect(run?.failureReason).toMatch(/trunk/);
  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('failed');
});

it('makes no checkout when there is no project, which is the fake engine case', async () => {
  live.db.prepare("DELETE FROM settings WHERE key = 'projectPath'").run();
  addCard('APP-1', 'Add a search box');

  await runToEnd('APP-1');

  expect(seen).toHaveLength(1);
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
});

// createLoop is handed its environment so a caller decides what git sees, and nothing is read behind
// its back. A PATH given only to the loop leads to a git that notes it ran, then runs the real one.
it('runs git with the environment the loop was given', async () => {
  live.close();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${join(dir, 'git-trace')}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', PATH: `${bin}:${process.env.PATH ?? ''}` });
  live.engine.spawn = async function* () {
    yield RESULT;
  };
  addCard('APP-1', 'Add a search box');

  await runToEnd('APP-1');

  expect(existsSync(join(dir, 'git-trace'))).toBe(true);
});

// A single repository's refine runs in the checkout, so the branch is made before Refine wrote the
// kind and words the template takes. The branch takes them right after, while nothing else knows it.
describe('the branch name after Refine', () => {
  const branchOf = () => git('-C', join(project, 'worktrees', 'APP-1'), 'branch', '--show-current').trim();
  const writesBrief = () => {
    live.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      seen.push({ cwd: job.cwd, existed: true, branch: execFileSync('git', ['branch', '--show-current'], { cwd: job.cwd, encoding: 'utf8' }).trim() });
      mkdirSync(join(job.taskDir, 'refine'), { recursive: true });
      writeFileSync(join(job.taskDir, 'refine', 'refined.md'), '# APP-1: Search the recipe list\nKind: fix\nBranch: search-box\n\nThe problem.\n');
      yield RESULT;
    };
  };

  it('renames a branch with no upstream and no commit to the words Refine wrote', async () => {
    writeSetting(live.db, 'branchTemplate', '{type}/{key}/{desc}');
    addCard('APP-1', 'Add a search box');
    writesBrief();

    await runToEnd('APP-1');

    expect(seen.map((one) => one.branch)).toEqual(['feature/APP-1/add-a-search-box']);
    expect(branchOf()).toBe('fix/APP-1/search-box');
    expect(git('branch', '--list', 'feature/*').trim()).toBe('');
  });

  it('starts on the name the person typed, and Refine leaves it', async () => {
    writeSetting(live.db, 'branchTemplate', '{type}/{key}/{desc}');
    addCard('APP-1', 'Add a search box');
    live.db.prepare("UPDATE cards SET branch = 'APP-1-mine' WHERE key = 'APP-1'").run();
    writesBrief();

    await runToEnd('APP-1');

    expect(seen.map((one) => one.branch)).toEqual(['APP-1-mine']);
    expect(branchOf()).toBe('APP-1-mine');
  });

  it('keeps the name of a branch that has a commit of its own', async () => {
    writeSetting(live.db, 'branchTemplate', '{type}/{key}/{desc}');
    addCard('APP-1', 'Add a search box');
    await runToEnd('APP-1');
    git('-C', join(project, 'worktrees', 'APP-1'), 'commit', '-q', '--allow-empty', '-m', 'work of the first run');
    live.db.prepare("UPDATE cards SET state = 'queued' WHERE key = 'APP-1'").run();
    writesBrief();

    await runToEnd('APP-1');

    expect(branchOf()).toBe('feature/APP-1/add-a-search-box');
  });

  it('renames the branch of the card that ran, with that card title and brief', async () => {
    writeSetting(live.db, 'branchTemplate', '{type}/{key}/{desc}');
    addCard('APP-1', 'Add a search box');
    addCard('APP-2', 'Fix the login page');
    live.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      mkdirSync(join(job.taskDir, 'refine'), { recursive: true });
      const words = job.cardKey === 'APP-1' ? 'one-words' : 'two-words';
      writeFileSync(join(job.taskDir, 'refine', 'refined.md'), `# ${job.cardKey}: Title of ${job.cardKey}\nKind: chore\nBranch: ${words}\n\nThe problem.\n`);
      yield RESULT;
    };

    await runToEnd('APP-2');

    expect(git('-C', join(project, 'worktrees', 'APP-2'), 'branch', '--show-current').trim()).toBe('chore/APP-2/two-words');
    expect(git('branch', '--list', '*APP-1*').trim()).toBe('');
  });

  it('keeps an old {key}-{slug} branch as it is when the title stays', async () => {
    writeSetting(live.db, 'branchTemplate', '{key}-{slug}');
    addCard('APP-1', 'Add a search box');
    live.db.prepare("UPDATE cards SET source = 'github' WHERE key = 'APP-1'").run();
    writesBrief();

    await runToEnd('APP-1');

    expect(branchOf()).toBe('APP-1-add-a-search-box');
  });
});
