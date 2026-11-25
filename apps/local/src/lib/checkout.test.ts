import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { ensureWorktree } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chosenBranch, renameCardBranch, templateBranch } from './checkout.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const env = Object.fromEntries(Object.entries(ENV).filter((entry): entry is [string, string] => entry[1] !== undefined));
const git = (at: string, ...args: string[]) => execFileSync('git', args, { cwd: at, env: ENV, encoding: 'utf8' }).trim();

let dir = '';
let project = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-checkout-')));
  project = join(dir, 'recipes');
  db = openDatabase(dir);
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'recipes\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'baseBranch', 'main');
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'idle', 'Add a search box')").run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const checkout = async (): Promise<string> => (await ensureWorktree({ projectPath: project, key: 'APP-1', branch: 'APP-1-add-a-search-box', baseBranch: 'main', repo: '.', env })).path;

it('stores the typed name on a card with no checkout, and the template gives way to it', async () => {
  expect(templateBranch(db, 'APP-1')).toBe('feature/APP-1/add-a-search-box');

  expect(await renameCardBranch(db, 'APP-1', 'APP-1-search', env)).toEqual({ ok: true });
  expect(chosenBranch(db, 'APP-1')).toBe('APP-1-search');
  expect(templateBranch(db, 'APP-1')).toBe('APP-1-search');
});

it('renames the checkout, commits of its own and all', async () => {
  const at = await checkout();
  writeFileSync(join(at, 'search.ts'), 'export const search = true;\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', 'work');

  expect(await renameCardBranch(db, 'APP-1', 'feature/APP-1-search', env)).toEqual({ ok: true });
  expect(git(at, 'branch', '--show-current')).toBe('feature/APP-1-search');
  expect(chosenBranch(db, 'APP-1')).toBe('feature/APP-1-search');
});

it('refuses once the branch was pushed, and stores nothing', async () => {
  const at = await checkout();
  const bare = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', bare);
  git(project, 'remote', 'add', 'origin', bare);
  git(at, 'push', '-q', '-u', 'origin', 'APP-1-add-a-search-box');

  expect(await renameCardBranch(db, 'APP-1', 'APP-1-search', env)).toEqual({ ok: false, reason: 'APP-1-add-a-search-box has an upstream, so it keeps its name.' });
  expect(git(at, 'branch', '--show-current')).toBe('APP-1-add-a-search-box');
  expect(chosenBranch(db, 'APP-1')).toBeNull();
});

it('refuses a name git refuses or one without the key, and a card with a run going', async () => {
  expect(await renameCardBranch(db, 'APP-1', 'search box', env)).toMatchObject({ ok: false });
  expect(await renameCardBranch(db, 'APP-1', 'search-box', env)).toEqual({ ok: false, reason: 'The name must carry the card key APP-1.' });
  db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
  expect(await renameCardBranch(db, 'APP-1', 'APP-1-search', env)).toMatchObject({ ok: false, reason: expect.stringContaining('running') });
  expect(await renameCardBranch(db, 'APP-9', 'APP-9-search', env)).toEqual({ ok: false, reason: 'There is no card APP-9 here.' });
  db.prepare("UPDATE cards SET state = 'idle', stage = 'closed' WHERE key = 'APP-1'").run();
  expect(await renameCardBranch(db, 'APP-1', 'APP-1-search', env)).toEqual({ ok: false, reason: 'A closed card keeps its branch.' });
  expect(chosenBranch(db, 'APP-1')).toBeNull();
});
