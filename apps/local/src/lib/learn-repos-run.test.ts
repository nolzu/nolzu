import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRepoStub, recipeSectionOf, repoKnowledge, runRecipe } from '@nolzu/core';
import { knowledgeChangesOfRun, readRun, recordKnowledgeChanges, startRun, writeSetting } from '@nolzu/core/node';
import { learnRepoKey, type Job } from '@nolzu/protocol';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { approveKnowledge, readHeldNow } from './knowledge-review.ts';
import { createLoop, type Loop } from './loop.ts';

// Learn your repositories: one read-only run per repository, queued at once under a key per
// repository, run one after another on the knowledge lane, and held for review with review off.
let dir = '';
let project = '';
let live: Loop;

const CLEAN = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};
const env = { ...process.env, ...CLEAN };

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8' });
const knowledgeDir = () => join(project, '.nolzu', 'knowledge');
const read = (path: string) => readFileSync(join(knowledgeDir(), path), 'utf8');
const runsOf = (key: string): number[] => (live.db.prepare('SELECT id FROM runs WHERE card_key = ? ORDER BY id').all(key) as { id: number }[]).map((row) => row.id);

async function untilEnd(runId: number): Promise<number> {
  for (let tries = 0; tries < 300; tries += 1) {
    const state = readRun(live.db, runId)?.state;
    if (state === 'complete' || state === 'failed' || state === 'stopped') return runId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the learn-repo run did not end');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-learn-repos-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-learn-repos-project-'));
  git('init', '-q', '-b', 'main');
  for (const repo of ['api', 'web']) mkdirSync(join(project, repo));
  for (const repo of ['api', 'web']) {
    mkdirSync(join(knowledgeDir(), repo), { recursive: true });
    writeFileSync(join(knowledgeDir(), repo, 'repository.md'), repoKnowledge({ path: repo, base: 'main' }));
  }
  writeFileSync(join(knowledgeDir(), 'run-recipe.md'), runRecipe([{ path: 'api', scripts: null, files: [] }, { path: 'web', scripts: null, files: [] }], null) ?? '');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes. The fake engine runs no hook.\n');
  live = createLoop(dir, { ...env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', project);
  writeSetting(live.db, 'repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  writeSetting(live.db, 'reviewKnowledge', false);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('runs in the project folder on its own row, read only, naming one repository and its two files', () => {
  const job: Job = live.buildJob(learnRepoKey('api'), 'learn-repo', 0);

  expect(job.cwd).toBe(project);
  expect(job.lane).toBe('knowledge');
  expect(job.knowledgeDir).toBe(knowledgeDir());
  expect(job.tools).not.toContain('Bash');
  // The cheap row: the ask row's small model.
  expect(job.model).toBe('haiku');
  expect(job.prompt).toContain('## This run');
  expect(job.prompt).toContain('kb-learn-api: Learn the api repository');
  expect(job.prompt).toContain('Learn the repository `api` at `api/`. Write `.nolzu/knowledge/api/repository.md`');
  expect(job.prompt).toContain('.tasks/kb-learn-api/learn-repo/instructions.md');
  // The key and the phase go together, so neither kind of run reads the other's files.
  expect(() => live.buildJob(learnRepoKey('api'), 'orient', 0)).toThrow('Learn this project cannot run under the key kb-learn-api.');
  expect(() => live.buildJob('kb-maintenance', 'learn-repo', 0)).toThrow('Learn your repositories cannot run under the key kb-maintenance.');
});

it('queues a run per repository, runs them one after another, and holds each for review', async () => {
  const head = git('rev-parse', 'HEAD').trim();

  // A repository named twice is one run.
  expect(live.learnRepos(['api', 'web', 'api'])).toBe(2);
  // Both are in the queue at once, and the knowledge lane lets one of them run at a time.
  const queue = live.scheduler.queue();
  expect([...queue.running, ...queue.waiting].map((job) => job.cardKey).sort()).toEqual([learnRepoKey('api'), learnRepoKey('web')]);
  expect(queue.running.filter((job) => job.lane === 'knowledge').length).toBeLessThanOrEqual(1);
  expect(() => live.learnRepos(['web'])).toThrow('web is being learned already. Wait for that run to end, then start again.');

  const [api] = runsOf(learnRepoKey('api'));
  const [web] = runsOf(learnRepoKey('web'));
  await untilEnd(api ?? 0);
  await untilEnd(web ?? 0);

  for (const [runId, repo] of [
    [api, 'api'],
    [web, 'web'],
  ] as const) {
    expect(readRun(live.db, runId ?? 0)?.state).toBe('complete');
    expect(knowledgeChangesOfRun(live.db, runId ?? 0).map((row) => [row.filePath, row.status]).sort()).toEqual([
      ['.nolzu/knowledge/' + repo + '/repository.md', 'pending'],
      ['.nolzu/knowledge/run-recipe.md', 'pending'],
    ].sort());
  }
  // Held with review off: no commit, and the files as they were.
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(isRepoStub(read('api/repository.md'))).toBe(true);

  // Each change shows its own section alone against the recipe, and applying both keeps both.
  const before = read('run-recipe.md');
  const held = readHeldNow(live.db, dir, api ?? 0)?.files.find((file) => file.path.endsWith('run-recipe.md'))?.content ?? '';
  expect(recipeSectionOf(held, 'web')).toBe(recipeSectionOf(before, 'web'));

  for (const runId of [web, api]) {
    const answer = await approveKnowledge(live.db, { dataDir: dir, runId: runId ?? 0, busy: null, env });
    expect(answer.ok, answer.message).toBe(true);
  }
  const recipe = read('run-recipe.md');
  expect(recipeSectionOf(recipe, 'api')).toContain('- Test: `node --test`. (from the ci.yml workflow)');
  expect(recipeSectionOf(recipe, 'web')).toContain('- Test: `node --test`. (from the ci.yml workflow)');
  expect(isRepoStub(read('api/repository.md'))).toBe(false);
  expect(read('web/repository.md')).toContain('(from README.md)');
});

it('starts none when one cannot start, and says why', () => {
  expect(() => live.learnRepos([])).toThrow('No repository was picked, so there is nothing to learn.');
  expect(() => live.learnRepos(['api', 'docs'])).toThrow('There is no repository "docs" in this project, so there is nothing to learn.');
  // A change still waiting means a second run would write against knowledge nobody applied yet.
  const runId = startRun(live.db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'claude-code', model: 'sonnet', effort: 'low', sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(live.db, { cardKey: 'APP-1', runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/rows.md', summary: 'added' }] });
  expect(() => live.learnRepos(['api'])).toThrow(/still waiting for a person: \.nolzu\/knowledge\/rows\.md\. .* then start Learn your repositories again\.$/);
  expect(runsOf(learnRepoKey('api'))).toEqual([]);
  expect(existsSync(join(project, '.tasks', learnRepoKey('api')))).toBe(false);
});
