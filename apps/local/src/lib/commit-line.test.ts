import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { checkoutPath, GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

// The prompt names the commit the run reads, so Refine and Plan, which have no shell, can stamp it.
let dir = '';
let project = '';
let live: Loop;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const line = (cwd: string, rev: string) => `The code you read is at commit ${git(cwd, 'log', '-1', '--format=%h (%cs).', rev)}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-commit-line-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  writeSetting(live.db, 'projectPath', project);
  writeSetting(live.db, 'baseBranch', 'main');
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'delivery', 'refine', 'Search')").run();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('names the base branch before the checkout exists, then the checkout itself', () => {
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = line(project, 'main');
  // The person works on another branch in the project folder. The card is still cut from the base.
  git(project, 'checkout', '-q', '-b', 'mine');
  git(project, 'commit', '-q', '--allow-empty', '-m', 'mine');
  expect(live.buildJob('APP-1', 'refine', 1).prompt).toContain(base);

  const checkout = checkoutPath(project, 'APP-1', '.');
  git(project, 'worktree', 'add', '-q', '-b', 'app-1', checkout, 'main');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'card work');
  expect(live.buildJob('APP-1', 'plan', 2).prompt).toContain(line(checkout, 'HEAD'));
});

it('names no commit for a project folder that is no repository', () => {
  expect(live.buildJob('APP-1', 'refine', 1).prompt).not.toContain('The code you read is at commit');
});
