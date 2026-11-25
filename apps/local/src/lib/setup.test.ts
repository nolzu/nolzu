import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoKnowledge } from '@nolzu/core';
import { createCard, getSetting, notifications, readRun, writeSetting } from '@nolzu/core/node';
import { learnRepoKey } from '@nolzu/protocol';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { createLoop, type Loop } from './loop.ts';
import { learnFirst, postSetup, setupFor, setupView, startLearnRepos } from './setup.ts';
import { browserEntry, writeMcpList } from './mcp-store.ts';

// Set up the project: the steps read off the project, the Learn gate on the first run, its way
// out, and Learn and then start on the fake engine.
let dir = '';
let project = '';
let live: Loop;

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8' });
const repoFile = (repo: string) => join(project, '.nolzu', 'knowledge', repo, 'repository.md');
const stage = (key: string) => (live.db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string }).stage;
const post = (body: unknown) => postSetup(live, new Request('http://localhost/api/setup', { method: 'POST', body: JSON.stringify(body) }));
const states = () => Object.fromEntries(setupFor(live.db).map((step) => [step.id, step.state]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-setup-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-setup-project-'));
  git('init', '-q', '-b', 'main');
  for (const repo of ['api', 'web']) mkdirSync(join(project, repo));
  for (const repo of ['api', 'web']) mkdirSync(join(project, '.nolzu', 'knowledge', repo), { recursive: true });
  for (const repo of ['api', 'web']) writeFileSync(repoFile(repo), repoKnowledge({ path: repo, base: 'main' }));
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
  // What New project stores, which is what lets Learn hold the first run back.
  writeSetting(live.db, 'setupSteps', {});
  createCard(live.db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'Add a search box' });
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the steps', () => {
  it('reads every step open on a new project, and each from its own row once done', () => {
    expect(states()).toEqual({ learn: 'open', commands: 'open', qa: 'open', tickets: 'open' });
    writeMcpList(project, [browserEntry()]);
    writeSetting(live.db, 'ticketSystem', 'jira');
    expect(states()).toMatchObject({ qa: 'done', tickets: 'done' });
  });

  it('counts Learn done on a project made before the steps when no repository file is a stub, and never gates it', () => {
    writeSetting(live.db, 'setupSteps', null);
    expect(states().learn).toBe('open');
    expect(setupView(live.db).gates).toBe(false);
    for (const repo of ['api', 'web']) writeFileSync(repoFile(repo), `# ${repo}\n\nThe recipe ${repo}. Run it with make.\n`);
    expect(states().learn).toBe('done');
  });

  it('puts a recommended step away, and refuses that for the required one', async () => {
    expect((await post({ step: 'qa', mark: 'dismissed' })).status).toBe(200);
    expect(states().qa).toBe('dismissed');
    const refused = await post({ step: 'learn', mark: 'dismissed' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toContain('I will write it myself');
    expect((await post({ step: 'cook', mark: 'done' })).status).toBe(400);
  });
});

describe('the Learn gate', () => {
  it('refuses the first run while Learn is open, and lets a move that starts nothing through', async () => {
    expect(learnFirst(live.db, 'APP-1')).toContain('Learn your repositories comes before the first run');
    expect(await moveTo(live, 'APP-1', 'refine')).toEqual({ status: 409, message: expect.stringContaining('Learn your repositories') });
    expect(stage('APP-1')).toBe('inbox');
    expect(readRun(live.db, 1)).toBeNull();
  });

  it('"I will write it myself" marks the step done, and the move then starts the run', async () => {
    expect((await post({ step: 'learn', mark: 'self' })).status).toBe(200);
    expect(getSetting(live.db, 'setupSteps')).toEqual({ learn: 'self' });
    expect(setupView(live.db).gates).toBe(false);
    expect(await moveTo(live, 'APP-1', 'refine')).toBeNull();
    expect(stage('APP-1')).toBe('refine');
  });

  it('holds no later run back: a project where a person started a run already', async () => {
    writeSetting(live.db, 'setupSteps', { learn: 'self' });
    expect(await moveTo(live, 'APP-1', 'refine')).toBeNull();
    writeSetting(live.db, 'setupSteps', {});
    expect(setupView(live.db).gates).toBe(false);
  });
});

describe('Learn and then start', () => {
  it('queues a Learn run per repository not learned yet, and moves the card once they all left the queue', async () => {
    // web was learned already, so only api is read.
    writeFileSync(repoFile('web'), '# web\n\nThe recipe site. Run it with npm run dev.\n');
    const answer = await post({ then: { key: 'APP-1', to: 'refine' } });
    expect(answer.status).toBe(200);
    expect(getSetting(live.db, 'setupSteps')).toEqual({ learn: 'done' });
    const keys = () => [...live.scheduler.queue().waiting, ...live.scheduler.queue().running].map((job) => job.cardKey);
    expect(keys()).toEqual([learnRepoKey('api')]);
    // The card waits while its Learn run is in the queue, and the board says what for.
    expect(stage('APP-1')).toBe('inbox');
    expect(getSetting(live.db, 'afterLearn')).toEqual([{ key: 'APP-1', to: 'refine', at: expect.any(String) }]);
    expect(live.snapshot().cards.find((card) => card.key === 'APP-1')?.afterLearn).toEqual({ column: 'Refine', repo: 'api', since: getSetting(live.db, 'afterLearn')[0]?.at });
    for (let tries = 0; tries < 300 && stage('APP-1') !== 'refine'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stage('APP-1')).toBe('refine');
    const runs = live.db.prepare('SELECT card_key, phase FROM runs ORDER BY id').all() as { card_key: string; phase: string }[];
    expect(runs.map((run) => `${run.card_key} ${run.phase}`)).toEqual([`${learnRepoKey('api')} learn-repo`, 'APP-1 refine']);
    expect(getSetting(live.db, 'afterLearn')).toEqual([]);
  });

  // A Learn that fails raises no toast, so the bell keeps it, and the card it held says it started
  // without it.
  it('keeps a failed Learn run for the bell and starts the held card all the same', async () => {
    live.engine.spawn = async function* (job) {
      if (job.phase === 'learn-repo') throw new Error('The Cursor CLI engine stopped with exit code 1. It said: Error: EPERM');
      yield* [];
    };
    expect((await post({ then: { key: 'APP-1', to: 'refine' } })).status).toBe(200);
    for (let tries = 0; tries < 300 && stage('APP-1') !== 'refine'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stage('APP-1')).toBe('refine');
    const kept = notifications(live.db).map((one) => [one.kind, one.card, one.text, one.href]);
    // Neither repository was learned yet, so both ran and both failed.
    expect(kept).toContainEqual(['error', null, 'Learning api failed: The Cursor CLI engine stopped with exit code 1. It said: Error: EPERM', '/knowledge']);
    expect(kept).toContainEqual(['error', null, 'Learning web failed: The Cursor CLI engine stopped with exit code 1. It said: Error: EPERM', '/knowledge']);
    expect(kept).toContainEqual(['warning', 'APP-1', 'APP-1 started without Learn, because learning api, web did not finish: The Cursor CLI engine stopped with exit code 1. It said: Error: EPERM', '/knowledge']);
  });

  // The held move is in the project's database, so Nolzu stopped in the middle still starts the card.
  it('makes a held move when Nolzu starts again', async () => {
    // What the press stored before Nolzu stopped.
    writeSetting(live.db, 'setupSteps', { learn: 'done' });
    writeSetting(live.db, 'afterLearn', [{ key: 'APP-1', to: 'refine', at: new Date().toISOString() }]);
    live.close();
    live = createLoop(dir, { ...env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });

    for (let tries = 0; tries < 300 && stage('APP-1') !== 'refine'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stage('APP-1')).toBe('refine');
    expect(getSetting(live.db, 'afterLearn')).toEqual([]);
  });

  // The press asked for the card to start after Learn however it ended, and a failed Learn is said on
  // the card's bell entry. A Learn that failed before the press is no reason.
  it('says the card started without Learn when its Learn run failed', async () => {
    writeSetting(live.db, 'setupSteps', { learn: 'done' });
    const pressed = new Date(Date.now() - 60_000).toISOString();
    const fail = (key: string, endedAt: string) =>
      live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, error, started_at, ended_at) VALUES (?, 'learn-repo', 'claude-code', 'failed', ?, ?, ?)").run(key, 'Error: EPERM: operation not permitted', endedAt, endedAt);
    fail(learnRepoKey('web'), new Date(Date.now() - 120_000).toISOString());
    fail(learnRepoKey('api'), new Date().toISOString());
    writeSetting(live.db, 'afterLearn', [{ key: 'APP-1', to: 'refine', at: pressed }]);
    live.close();
    live = createLoop(dir, { ...env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });

    for (let tries = 0; tries < 300 && stage('APP-1') !== 'refine'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stage('APP-1')).toBe('refine');
    expect(notifications(live.db).filter((one) => one.card === 'APP-1' && one.kind === 'warning').map((one) => one.text)).toEqual([
      'APP-1 started without Learn, because learning api did not finish: Error: EPERM: operation not permitted',
    ]);
  });

  // Each repository counts by its newest Learn run: one started again from Knowledge that passed is
  // fine, and one a restart cut off did not finish.
  it('goes by the newest Learn run of each repository, and counts one a restart cut off', async () => {
    writeSetting(live.db, 'setupSteps', { learn: 'done' });
    const pressed = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    const add = (key: string, state: string, error: string | null) =>
      live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, error, started_at, ended_at) VALUES (?, 'learn-repo', 'claude-code', ?, ?, ?, ?)").run(key, state, error, now, now);
    add(learnRepoKey('api'), 'failed', 'Error: EPERM');
    add(learnRepoKey('api'), 'complete', null);
    add(learnRepoKey('web'), 'interrupted', null);
    writeSetting(live.db, 'afterLearn', [{ key: 'APP-1', to: 'refine', at: pressed }]);
    live.close();
    live = createLoop(dir, { ...env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });

    for (let tries = 0; tries < 300 && stage('APP-1') !== 'refine'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications(live.db).filter((one) => one.card === 'APP-1' && one.kind === 'warning').map((one) => one.text)).toEqual(['APP-1 started without Learn, because learning web did not finish.']);
  });

  it('marks the step done when Learn starts from Knowledge, and not when it is refused', () => {
    const form = (...repos: string[]) => {
      const body = new FormData();
      for (const repo of repos) body.append('repo', repo);
      return body;
    };
    expect(startLearnRepos(live, form()).ok).toBe(false);
    expect(getSetting(live.db, 'setupSteps')).toEqual({});
    expect(startLearnRepos(live, form('api')).ok).toBe(true);
    expect(getSetting(live.db, 'setupSteps')).toEqual({ learn: 'done' });
    expect(setupView(live.db).gates).toBe(false);
  });

  it('says why when no Learn run can start, and marks nothing', async () => {
    for (const repo of ['api', 'web']) writeFileSync(repoFile(repo), `# ${repo}\n\nLearned.\n`);
    writeSetting(live.db, 'setupSteps', {});
    const answer = await post({ then: { key: 'APP-1', to: 'refine' } });
    expect(answer.status).toBe(409);
    expect(getSetting(live.db, 'setupSteps')).toEqual({});
  });
});
