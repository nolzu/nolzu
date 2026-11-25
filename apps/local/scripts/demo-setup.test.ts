import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, openDatabase } from '@nolzu/core/node';
import { GUARD_PATH } from '@nolzu/runner';
import { scanProject } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TERMS_VERSION } from '../src/lib/terms.ts';

let home = '';
const env = () => ({
  ...process.env,
  HOME: home,
  // The script's temp folder lands here, so a test can see whether it is gone.
  TMPDIR: join(home, 'tmp'),
  NOLZU_FAKE_AGENT: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
});
const script = join(import.meta.dirname, 'demo-setup.ts');
const setup = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { env: env(), encoding: 'utf8', stdio: 'pipe' });
const origin = (at: string) => execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: at, env: env(), encoding: 'utf8' }).trim();
const commits = (at: string) => execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: at, env: env(), encoding: 'utf8' }).trim();
const scanned = async (at: string) => {
  const scan = await scanProject(at, { branchTemplate: '{key}-{slug}', env: env() });
  return 'repos' in scan ? scan.repos.map((repo) => repo.path) : scan.reason;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nolzu-demo-setup-'));
  mkdirSync(join(home, 'tmp'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('splits the services into api and web, one commit each, in a plain folder', async () => {
  const project = join(home, 'recipes');
  const out = setup('--split', project);

  expect(out).toContain(`sh '${join(import.meta.dirname, '..', '..', '..', 'docs', 'stack-hook', 'stack.sh')}' load {key}`);
  expect([commits(join(project, 'api')), commits(join(project, 'web'))]).toEqual(['1', '1']);
  expect(existsSync(join(project, '.git'))).toBe(false);
  expect(existsSync(join(project, 'services'))).toBe(false);
  expect([existsSync(join(project, 'api', 'src', 'server.ts')), existsSync(join(project, 'web', 'index.html'))]).toEqual([true, true]);
  expect(readFileSync(join(project, 'package.json'), 'utf8')).toContain('node --test api/src/recipes/list.test.ts');
  expect(await scanned(project)).toEqual(['api', 'web']);
  expect([origin(join(project, 'api')), origin(join(project, 'web'))]).toEqual([
    'https://github.com/example/recipe-api.git',
    'https://github.com/example/recipe-web.git',
  ]);
  const db = openDatabase(join(home, '.nolzu-fake'));
  expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: null }, { path: 'web', base: null }]);
  db.close();
});

it('makes the root a repository that ignores both with --root-repo', async () => {
  const project = join(home, 'recipes');
  setup('--split', '--root-repo', project);

  expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('/api/\n/web/\n');
  expect([commits(project), commits(join(project, 'api')), commits(join(project, 'web'))]).toEqual(['1', '1', '1']);
  expect(await scanned(project)).toEqual(['.', 'api', 'web']);
  expect([origin(project), origin(join(project, 'api')), origin(join(project, 'web'))]).toEqual([
    'https://github.com/example/recipe-workspace.git',
    'https://github.com/example/recipe-api.git',
    'https://github.com/example/recipe-web.git',
  ]);
  const db = openDatabase(join(home, '.nolzu-fake'));
  expect(getSetting(db, 'repos')).toEqual([{ path: '.', base: null }, { path: 'api', base: null }, { path: 'web', base: null }]);
  db.close();
});

it('refuses --root-repo without --split', () => {
  expect(() => setup('--root-repo', join(home, 'recipes'))).toThrow(/--root-repo works only with --split/);
  expect(existsSync(join(home, 'recipes'))).toBe(false);
});

it('refuses an unknown flag with a sentence', () => {
  expect(() => setup('--rootrepo', join(home, 'recipes'))).toThrow(/The only flags are --split, --root-repo and --workspace/);
  expect(existsSync(join(home, 'recipes'))).toBe(false);
});

it('keeps one repository with services inside when no flag is given', async () => {
  const project = join(home, 'recipes');
  setup(project);

  expect(commits(project)).toBe('1');
  expect(existsSync(join(project, 'services', 'api'))).toBe(true);
  expect(await scanned(project)).toEqual(['.']);
  // The app opens on the board, not on the terms page.
  const db = openDatabase(join(home, '.nolzu-fake'));
  expect(getSetting(db, 'termsAccepted')?.version).toBe(TERMS_VERSION);
  db.close();
});

it('makes a workspace and adds api and web to it by URL with --workspace', () => {
  // Not the demo's own name, so the folder name is the one asked for.
  const project = join(home, 'demos', 'cookbook');
  const out = setup('--workspace', project);

  expect(out).toContain('Added api, starting from main.');
  expect(out).toContain('Added web, starting from main.');
  expect(out).not.toContain('Write the project files');
  // Each ticket line names its own key, read from the split copy.
  expect(out.split('\n').filter((line) => /^APP-\d+ {2}/.test(line)).map((line) => line.slice(0, 5))).toEqual(['APP-1', 'APP-2', 'APP-3']);
  expect(out).toContain(`sh '${join(import.meta.dirname, '..', '..', '..', 'docs', 'stack-hook', 'stack.sh')}' load {key}`);
  expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/api/\n/web/\n');
  expect(JSON.parse(readFileSync(join(project, '.nolzu', 'repositories.json'), 'utf8'))).toEqual({
    workspace: true,
    repositories: [
      { folder: 'api', url: 'https://github.com/example/api.git', base: 'main' },
      { folder: 'web', url: 'https://github.com/example/web.git', base: 'main' },
    ],
  });
  expect(existsSync(join(project, GUARD_PATH))).toBe(true);
  expect(existsSync(join(project, 'api', 'src', 'server.ts'))).toBe(true);
  // Each folder holds its own service, not a second copy of the other.
  expect([existsSync(join(project, 'web', 'app.js')), existsSync(join(project, 'web', 'src'))]).toEqual([true, false]);
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: project, env: env(), encoding: 'utf8' })).toBe('');
  expect([origin(join(project, 'api')), origin(join(project, 'web'))]).toEqual(['https://github.com/example/api.git', 'https://github.com/example/web.git']);
  // The bare repositories went with the script's temp folder.
  expect(readdirSync(join(home, 'tmp')).filter((name) => name.startsWith('nolzu-demo-'))).toEqual([]);
  const db = openDatabase(join(home, '.nolzu-fake'));
  expect([getSetting(db, 'workspace'), getSetting(db, 'repos')]).toEqual([true, [{ path: 'api', base: 'main' }, { path: 'web', base: 'main' }]]);
  expect(db.prepare('SELECT key FROM cards ORDER BY key').all().map((row) => (row as { key: string }).key)).toEqual(['APP-1', 'APP-2', 'APP-3']);
  db.close();
});

it('refuses --workspace with --split', () => {
  expect(() => setup('--workspace', '--split', join(home, 'recipes'))).toThrow(/--workspace and --split make two different layouts/);
  expect(existsSync(join(home, 'recipes'))).toBe(false);
});
