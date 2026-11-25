import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { workspaceCommit, workspaceCommitAsk, workspaceCount, workspacePatch, workspacePush, workspaceStatus } from './workspace.ts';

let root = '';
let project = '';
let db: DatabaseSync;

// No config of the person's own, a fixed author and no hooks, so git answers the same on every machine.
const env = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};
const setting = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));

// A bare remote with one commit on main, cloned to `to`.
const cloned = (name: string, to: string): string => {
  const bare = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  git(root, 'init', '-q', '-b', 'main', seed);
  write(join(seed, 'README.md'), `${name}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'first');
  git(root, 'clone', '-q', '--bare', seed, bare);
  git(root, 'clone', '-q', bare, to);
  return bare;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nolzu-workspace-'));
  project = join(root, 'recipes');
  cloned('recipes', project);
  // The inner repository the project lists, and one it lists that is gone.
  cloned('api', join(project, 'api'));
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  setting('projectPath', project);
  setting('workspace', true);
  setting('repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const statusOf = async () => {
  const status = await workspaceStatus(db, env);
  if (!status.ok) throw new Error(status.reason);
  return status;
};

it('lists the project folder and each repository, a missing one included, and skips nested checkouts', async () => {
  write(join(project, '.claude/skills/nolzu-plan/SKILL.md'), 'plan\n');
  write(join(project, 'AGENTS.md'), 'rules\n');
  write(join(project, 'notes/roadmap.md'), 'mine\n');
  // A card checkout git can see, with a file of its own.
  git(project, 'worktree', 'add', '-q', '-b', 'feat/APP-1', join(project, 'worktrees', 'APP-1'));
  write(join(project, 'worktrees/APP-1/x.ts'), 'x\n');
  // A card folder, which no .gitignore here hides.
  write(join(project, '.tasks/APP-1/plan/plan.md'), 'plan\n');
  write(join(project, 'api/src/search.ts'), 'search\n');

  const status = await statusOf();

  expect(status.repos.map((repo) => [repo.id, repo.name])).toEqual([
    ['.', 'recipes'],
    ['api', 'api'],
    ['web', 'web'],
  ]);
  const [top, api, web] = status.repos.map((repo) => repo.state);
  expect(top?.ok && top.files.map((file) => [file.path, file.owner])).toEqual([
    ['.claude/skills/nolzu-plan/SKILL.md', 'nolzu'],
    ['AGENTS.md', 'nolzu'],
    ['notes/roadmap.md', 'yours'],
  ]);
  expect(top).toMatchObject({ ok: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 });
  expect(api?.ok && api.files.map((file) => [file.path, file.owner])).toEqual([['src/search.ts', 'yours']]);
  expect(web).toEqual({ ok: false, reason: 'The folder is not there.' });
  expect(status.changed).toBe(4);
});

it('says so when no project is set', async () => {
  db.exec('DELETE FROM settings');
  expect(await workspaceStatus(db, env)).toEqual({ ok: false, reason: 'There is no project set, so there is no workspace to show.' });
});

it('shows the patch of a listed file and refuses one that is not listed or leaves the folder', async () => {
  write(join(project, 'AGENTS.md'), 'rules\n');
  write(join(root, 'secret.txt'), 'not yours to read\n');

  expect(await workspacePatch(db, '.', 'AGENTS.md', env)).toMatchObject({ ok: true, text: expect.stringContaining('+rules') });
  expect(await workspacePatch(db, '.', '../secret.txt', env)).toMatchObject({ ok: false, reason: expect.stringContaining('is not inside recipes') });
  expect(await workspacePatch(db, '.', 'README.md', env)).toMatchObject({ ok: false, reason: expect.stringContaining('has no change in recipes') });
  expect(await workspacePatch(db, '.', 'api/README.md', env)).toMatchObject({ ok: false, reason: expect.stringContaining('has no change') });
  expect(await workspacePatch(db, project, 'AGENTS.md', env)).toMatchObject({ ok: false, reason: expect.stringContaining('is not a folder of this workspace') });
});

it('commits the ticked files only and keeps the person own staged file staged', async () => {
  write(join(project, 'AGENTS.md'), 'rules\n');
  write(join(project, '.nolzu/phases/plan.md'), 'plan rules\n');
  write(join(project, 'notes.md'), 'mine\n');
  git(project, 'add', 'notes.md');

  const done = await workspaceCommit(db, { repo: '.', message: 'chore: update the Nolzu files', paths: ['AGENTS.md', '.nolzu/phases/plan.md'], hooks: false }, env);

  expect(done.ok).toBe(true);
  expect(git(project, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['.nolzu/phases/plan.md', 'AGENTS.md']);
  expect(git(project, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('A  notes.md');
});

it('refuses a commit of a path outside the status or with ..', async () => {
  write(join(project, 'AGENTS.md'), 'rules\n');
  const ask = (paths: string[]) => workspaceCommit(db, { repo: '.', message: 'chore: x', paths, hooks: false }, env);

  expect(await ask(['README.md'])).toMatchObject({ ok: false, reason: expect.stringContaining('has no change') });
  expect(await ask(['AGENTS.md', 'notes/../AGENTS.md'])).toMatchObject({ ok: false, reason: expect.stringContaining('is not inside') });
  expect(await ask(['/etc/hosts'])).toMatchObject({ ok: false, reason: expect.stringContaining('is not inside') });
  expect(git(project, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
});

it('reads the commit body, with hooks on for a literal true only', () => {
  expect(workspaceCommitAsk({ repo: '.', message: 'm', paths: ['a'], hooks: true })).toEqual({ repo: '.', message: 'm', paths: ['a'], hooks: true });
  expect(workspaceCommitAsk({ repo: '.', message: 'm', paths: ['a'], hooks: 'yes' })?.hooks).toBe(false);
  expect(workspaceCommitAsk({ repo: '.', message: 'm', paths: 'a' })).toBeNull();
  expect(workspaceCommitAsk({ message: 'm', paths: [] })).toBeNull();
});

it('pushes only with the confirmation, refuses no upstream, and reports a rejected push without pulling', async () => {
  write(join(project, 'api/a.ts'), 'a\n');
  git(join(project, 'api'), 'add', '-A');
  git(join(project, 'api'), 'commit', '-q', '-m', 'a');

  expect(await workspacePush(db, 'api', false, false, env)).toMatchObject({ ok: false, reason: expect.stringContaining('confirmation') });
  expect(await workspacePush(db, 'api', true, false, env)).toMatchObject({ ok: true });
  expect(git(root, '--git-dir', join(root, 'api.git'), 'rev-parse', 'main')).toBe(git(join(project, 'api'), 'rev-parse', 'HEAD'));

  // Another clone lands a commit, then this one commits again.
  const other = join(root, 'api-other');
  git(root, 'clone', '-q', join(root, 'api.git'), other);
  write(join(other, 'b.ts'), 'b\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'b');
  git(other, 'push', '-q');
  write(join(project, 'api/c.ts'), 'c\n');
  git(join(project, 'api'), 'add', '-A');
  git(join(project, 'api'), 'commit', '-q', '-m', 'c');
  const head = git(join(project, 'api'), 'rev-parse', 'HEAD');

  expect(await workspacePush(db, 'api', true, false, env)).toMatchObject({ ok: false, rejected: true, reason: expect.stringContaining('then push again') });
  expect(git(join(project, 'api'), 'rev-parse', 'HEAD')).toBe(head);

  git(project, 'checkout', '-q', '-b', 'local-only');
  expect(await workspacePush(db, '.', true, false, env)).toMatchObject({ ok: false, reason: expect.stringContaining('local-only has no upstream') });
});

it('keeps the count of the last read, and the layout read never runs git', async () => {
  write(join(project, 'AGENTS.md'), 'rules\n');

  // The first ask starts one read and does not wait for it.
  expect(workspaceCount(db, env)).toBeNull();
  await expect.poll(() => workspaceCount(db, env)).toBe(1);

  // A new change is not counted until the next read: the count is kept, not worked out again.
  write(join(project, 'notes.md'), 'mine\n');
  expect(workspaceCount(db, env)).toBe(1);
  await statusOf();
  expect(workspaceCount(db, env)).toBe(2);

  // A read the page left halfway keeps the count it had.
  write(join(project, 'more.md'), 'more\n');
  const stopped = new AbortController();
  stopped.abort();
  await workspaceStatus(db, env, stopped.signal);
  expect(workspaceCount(db, env)).toBe(2);
});
