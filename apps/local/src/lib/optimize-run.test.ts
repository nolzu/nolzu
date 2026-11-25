import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allKnowledgeChanges, knowledgeChangesOfRun, readRun, writeSetting } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY, type Job } from '@nolzu/protocol';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { knowledgePage } from './knowledge-page.ts';
import { revertKnowledge } from './knowledge-revert.ts';
import { createLoop, type Loop } from './loop.ts';

// Every wait below watches a run that spawns a real shell, so the window is the machine's and not
// the product's. vitest waits one second by default, and a full suite run on a busy machine takes
// longer than that to write the first row. `qa-run.test.ts` was given this window for the same
// reason, and these three files were missed.
const WAIT = { timeout: 10_000 };

// The Optimize run. It belongs to no card, so everything a card's run reads from its row has
// to come from somewhere else: the reserved key, the file the button named, and the knowledge lane.
let dir = '';
let project = '';
let live: Loop;

// No config of the person's own, and one author, so the test runs the same on every machine.
const CLEAN = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...CLEAN }, encoding: 'utf8' });

const knowledgeDir = () => join(project, '.nolzu', 'knowledge');
// The knowledge folder alone. The run's own folder under `.tasks/` is untracked work of this
// machine, as it is for every card run, and it is not what this suite asks about.
const knowledgeStatus = () => git('status', '--porcelain', '-uall', '--', '.nolzu/knowledge').trim();
const FILE = 'browser-filtering.md';
const PATH_IN_REPO = '.nolzu/knowledge/browser-filtering.md';
const WAS = '---\ndescription: An old note\n---\n\nThe list is filtered in the browser.\nThe list is filtered in the browser, again.\n';

// The guard file the wizard writes. A maintenance run works in the project itself, so this file is
// the only thing holding it to the knowledge folder, and a project without it starts no such run.
function writeGuard(): void {
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes. The fake engine runs no hook.\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-optimize-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-optimize-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  writeGuard();
  live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', project);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// One knowledge file a wrap-up could have left, committed, so the Optimize run has something to
// rewrite and git has a state to compare against.
function seedKnowledge(): void {
  mkdirSync(knowledgeDir(), { recursive: true });
  writeFileSync(join(knowledgeDir(), FILE), WAS);
  git('add', '-A');
  git('commit', '-q', '-m', 'knowledge: written by hand');
}

const addCard = (key: string, stage = 'pr-watch') =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);

const lastRun = (): number => (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;

async function untilEnd(runId: number): Promise<number> {
  for (let tries = 0; tries < 300; tries += 1) {
    const state = readRun(live.db, runId)?.state;
    if (state === 'complete' || state === 'failed' || state === 'stopped') return runId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the optimize run did not end');
}

async function optimizeToEnd(file = FILE): Promise<number> {
  live.optimize(file);
  return untilEnd(lastRun());
}

// The whole point of the run: the file is different afterwards, and the difference is one commit in
// the person's own repository, read back from git and not from a row.
it('commits the rewrite, and names the reserved key and the run in the message', async () => {
  seedKnowledge();

  const runId = await optimizeToEnd();

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(readFileSync(join(knowledgeDir(), FILE), 'utf8')).not.toBe(WAS);
  expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: ${KB_MAINTENANCE_KEY} run ${runId}`);
  expect(git('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe(PATH_IN_REPO);
  expect(knowledgeStatus()).toBe('');
});

// The rows are what the Knowledge screen reads. A run with no card still writes one row per file,
// under the reserved key, so the screen can show the change and offer to take it back.
it('writes one row under the reserved key, on the commit it made', async () => {
  seedKnowledge();

  const runId = await optimizeToEnd();

  const head = git('rev-parse', 'HEAD').trim();
  expect(knowledgeChangesOfRun(live.db, runId)).toEqual([
    { id: 1, cardKey: KB_MAINTENANCE_KEY, runId, filePath: PATH_IN_REPO, commitSha: head, summary: 'corrected', status: 'applied', note: null, movedFrom: null },
  ]);
});

// A maintenance run has no branch and no card, so making it a checkout would leave a worktree
// nothing ever removes.
it('makes no checkout of its own', async () => {
  seedKnowledge();

  await optimizeToEnd();

  expect(existsSync(join(project, 'worktrees', KB_MAINTENANCE_KEY))).toBe(false);
});

// The prompt is the only place the run is told which file to rewrite, because the skill reads it
// there and the job carries no card text.
it('names the one file in the prompt of the run', async () => {
  seedKnowledge();
  const prompts: string[] = [];
  const real = live.engine.spawn;
  live.engine.spawn = function (job: Job, signal: AbortSignal) {
    prompts.push(job.prompt);
    return real(job, signal);
  };

  await optimizeToEnd();

  expect(prompts).toHaveLength(1);
  // The folder is named from where the run works, so this line also says it works in the project
  // itself. A run given a checkout it has no branch for would read `../../.nolzu/knowledge/` here.
  expect(prompts[0]).toContain(`Rewrite \`.nolzu/knowledge/${FILE}\` and no other file.`);
  expect(prompts[0]).toContain('The card folder is `.tasks/kb-maintenance/`');
  expect(prompts[0]).toContain('.tasks/kb-maintenance/optimize/instructions.md');
});

// The name comes off a form, so anything at all can arrive in it. Nothing runs and nothing is
// committed, and the sentence names what was asked for.
it('starts nothing for a file that is not in the folder', async () => {
  seedKnowledge();
  const head = git('rev-parse', 'HEAD').trim();

  expect(() => live.optimize('../../etc/hosts')).toThrow(/nothing to rewrite/);

  expect(live.scheduler.queue().running).toEqual([]);
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(allKnowledgeChanges(live.db)).toEqual([]);
});

// The refusal sits in buildJob and not in one caller, so it holds however the run is started.
it('starts nothing when no file is named', () => {
  seedKnowledge();

  expect(() => live.optimize('  ')).toThrow(/No knowledge file was named/);
  expect(() => live.buildJob(KB_MAINTENANCE_KEY, 'optimize', 0)).toThrow(/No knowledge file was named/);
});

// The guard is what holds the run to the knowledge folder, because a maintenance run works in the
// person's own tree and holds Edit. Without the file it would be free in that tree, and only the
// knowledge folder is ever committed, so the rest would sit there with nobody told.
it('starts nothing in a project that has no run guard', () => {
  seedKnowledge();
  rmSync(join(project, GUARD_PATH));
  const head = git('rev-parse', 'HEAD').trim();

  expect(() => live.optimize(FILE)).toThrow(`This project has no run guard at ${GUARD_PATH}, so nothing would hold a maintenance run to the knowledge folder. Press Write the project files in Project settings.`);

  expect(live.scheduler.queue().running).toEqual([]);
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
});

// The reserved key is bookkeeping. A person reads "the Optimize run", which is the button they
// pressed, and never the key, the way the change rows read "maintenance".
it('names the button and not the reserved key when a change is still waiting', async () => {
  seedKnowledge();
  writeSetting(live.db, 'reviewKnowledge', true);
  await optimizeToEnd();

  expect(() => live.optimize(FILE)).toThrow(/start the Optimize run again/);
  expect(() => live.optimize(FILE)).not.toThrow(new RegExp(KB_MAINTENANCE_KEY));
});

// The lane, proved the way the wrap-up tests prove it for two wrap-ups: an Optimize run holds it, a wrap-up
// queued behind it waits, and work that has nothing to do with knowledge goes past both.
it('takes the knowledge lane, so a wrap-up queued at the same time waits', async () => {
  seedKnowledge();
  addCard('APP-1');
  addCard('APP-3', 'inbox');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'optimize') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.optimize(FILE);
  const maintenance = lastRun();
  live.start('APP-1', 'wrapup');
  const wrapup = lastRun();
  live.start('APP-3', 'refine');
  const unrelated = lastRun();

  expect(live.scheduler.queue().running.map((job) => job.runId)).toEqual([maintenance, unrelated]);
  expect(live.scheduler.queue().running.map((job) => job.lane)).toEqual(['knowledge', null]);
  // The wrap-up waits outside the queue until the knowledge run has left it.
  expect(readRun(live.db, wrapup)?.state).toBe('waiting_review');
  await vi.waitFor(() => expect(readRun(live.db, unrelated)?.state).toBe('complete'), WAIT);

  release();
  const wrapupOf = () => (live.db.prepare("SELECT state FROM runs WHERE card_key = 'APP-1' AND phase = 'wrapup' ORDER BY id DESC LIMIT 1").get() as { state: string } | undefined)?.state;
  await vi.waitFor(() => expect(wrapupOf()).toBe('complete'), WAIT);
});

// This is what proves the two agree: the commit the run made is one a revert can take back, and the
// file reads what it read before.
it("lets the Knowledge screen's Revert take an Optimize commit back", async () => {
  seedKnowledge();
  const runId = await optimizeToEnd();
  const applied = git('rev-parse', 'HEAD').trim();
  const change = allKnowledgeChanges(live.db)[0];

  const answer = await revertKnowledge(live.db, { changeId: change?.id ?? 0, env: { ...process.env, ...CLEAN } });

  expect(answer.ok).toBe(true);
  expect(readFileSync(join(knowledgeDir(), FILE), 'utf8')).toBe(WAS);
  expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge revert: ${PATH_IN_REPO} from ${KB_MAINTENANCE_KEY} run ${runId}`);
  expect(git('rev-parse', 'HEAD~1').trim()).toBe(applied);
  expect(allKnowledgeChanges(live.db).map((row) => row.status)).toEqual(['reverted']);
});

// With review on, an Optimize change waits exactly as a wrap-up's does, and the screen shows it as
// maintenance where a card's change carries a link.
it('holds the rewrite for review, and the screen reads maintenance where a card link would be', async () => {
  seedKnowledge();
  writeSetting(live.db, 'reviewKnowledge', true);
  const head = git('rev-parse', 'HEAD').trim();

  const runId = await optimizeToEnd();

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(readFileSync(join(knowledgeDir(), FILE), 'utf8')).toBe(WAS);
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(knowledgeStatus()).toBe('');
  expect(knowledgeChangesOfRun(live.db, runId).map((row) => [row.filePath, row.status, row.commitSha])).toEqual([[PATH_IN_REPO, 'pending', null]]);

  const view = await knowledgePage(live.db, { file: FILE, env: { ...process.env, ...CLEAN } });
  expect(view.pending.map((change) => change.source)).toEqual([{ kind: 'maintenance', key: null, title: null }]);
  expect(view.pending.map((change) => change.path)).toEqual([FILE]);
});
