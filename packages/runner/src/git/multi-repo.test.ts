import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { removeWorktree } from './cleanup.ts';
import { listWorktrees } from './list.ts';
import { ensureWorktree } from './worktree.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

// A root repository that ignores its child repository `api`, which branches from develop and holds
// a commit the root does not have.
const parent = (): TempRepo => {
  const made = tempRepo('nolzu-multi-');
  repo = made;
  made.write('.gitignore', 'api/\n');
  made.write('README.md', 'recipes\n');
  made.commit('first commit');
  const api = join(made.dir, 'api');
  made.run('init', '-q', '-b', 'develop', api);
  made.write('api/server.ts', 'export {};\n');
  made.run('-C', api, 'add', '-A');
  made.run('-C', api, 'commit', '-q', '-m', 'api first commit');
  return made;
};

const ensure = (made: TempRepo, repoName: string | undefined, baseBranch: string, key = 'APP-1') =>
  ensureWorktree({ projectPath: made.dir, key, branch: `${key}-work`, baseBranch, repo: repoName, env: made.env });

const branchAt = (made: TempRepo, at: string): string => made.run('-C', at, 'branch', '--show-current').trim();

it('puts the child checkout inside the root checkout, on one branch, each cut from its own base', async () => {
  const made = parent();
  const api = join(made.dir, 'api');

  const root = await ensure(made, '.', 'main');
  const child = await ensure(made, 'api', 'develop');

  expect(root.path).toBe(join(made.dir, 'worktrees', 'APP-1'));
  expect(child.path).toBe(join(made.dir, 'worktrees', 'APP-1', 'api'));
  expect(branchAt(made, root.path)).toBe('APP-1-work');
  expect(branchAt(made, child.path)).toBe('APP-1-work');
  expect(made.run('rev-parse', 'APP-1-work').trim()).toBe(made.run('rev-parse', 'main').trim());
  expect(made.run('-C', api, 'rev-parse', 'APP-1-work').trim()).toBe(made.run('-C', api, 'rev-parse', 'develop').trim());
  expect(existsSync(join(child.path, 'server.ts'))).toBe(true);
  // The child is ignored by the root, so the root checkout does not list it as untracked.
  expect(made.run('-C', root.path, 'status', '--porcelain')).toBe('');

  expect((await ensure(made, 'api', 'develop')).created).toBe(false);
});

it('makes a child checkout when the card root holds nothing yet', async () => {
  const made = parent();
  mkdirSync(join(made.dir, 'worktrees', 'APP-1'), { recursive: true });

  const child = await ensure(made, 'api', 'develop');

  expect(child.path).toBe(join(made.dir, 'worktrees', 'APP-1', 'api'));
  expect(branchAt(made, child.path)).toBe('APP-1-work');
});

it('lists one repository at a time, at the depth its checkouts sit', async () => {
  const made = parent();
  await ensure(made, '.', 'main');
  await ensure(made, 'api', 'develop');

  const apiRows = await listWorktrees({ projectPath: made.dir, baseBranch: 'develop', repo: 'api', env: made.env });
  const rootRows = await listWorktrees({ projectPath: made.dir, baseBranch: 'main', env: made.env });

  // git prints resolved paths.
  const real = realpathSync(made.dir);
  expect(apiRows.map((row) => [row.repo, row.path])).toEqual([['api', join(real, 'worktrees', 'APP-1', 'api')]]);
  expect(rootRows.map((row) => [row.repo, row.path])).toEqual([['.', join(real, 'worktrees', 'APP-1')]]);
});

// A second worktree of api that an agent added inside the card root sits at the same depth, but it is
// not the api checkout, so it is no row.
it('leaves out a worktree of the child repository that is not at its own folder name', async () => {
  const made = parent();
  await ensure(made, 'api', 'develop');
  made.run('-C', join(made.dir, 'api'), 'worktree', 'add', '-q', '-b', 'scratch', join(made.dir, 'worktrees', 'APP-1', 'scratch'), 'develop');

  const apiRows = await listWorktrees({ projectPath: made.dir, baseBranch: 'develop', repo: 'api', env: made.env });

  expect(apiRows.map((row) => row.path)).toEqual([join(realpathSync(made.dir), 'worktrees', 'APP-1', 'api')]);
});

it('removes the child checkout and leaves the root checkout alone', async () => {
  const made = parent();
  const root = await ensure(made, '.', 'main');
  const child = await ensure(made, 'api', 'develop');

  const result = await removeWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'develop', repo: 'api', env: made.env });

  expect(result).toEqual({ ok: true, stale: false });
  expect(existsSync(child.path)).toBe(false);
  expect(existsSync(join(root.path, 'README.md'))).toBe(true);
  expect(made.run('-C', join(made.dir, 'api'), 'worktree', 'list')).not.toContain('APP-1');
  expect(made.run('worktree', 'list')).toContain('APP-1');
});

it('refuses the root checkout once a child checkout fills its folder, and deletes nothing', async () => {
  const made = parent();
  const child = await ensure(made, 'api', 'develop');

  await expect(ensure(made, '.', 'main')).rejects.toThrow('already holds files and is not a worktree of this repository. Nothing was deleted.');
  expect(existsSync(join(child.path, 'server.ts'))).toBe(true);
  expect(readdirSync(join(made.dir, 'worktrees', 'APP-1'))).toEqual(['api']);
});

// The child repository is ignored by the root, so the root's own counts never see work in it.
it('refuses to remove the root checkout while a child checkout sits inside it', async () => {
  const made = parent();
  const root = await ensure(made, '.', 'main');
  const child = await ensure(made, 'api', 'develop');
  made.write('worktrees/APP-1/api/draft.ts', 'export const draft = 1;\n');

  const result = await removeWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', env: made.env });

  expect(result).toEqual({ ok: false, reason: `${realpathSync(root.path)} still holds the checkout of api, so removing it would delete that checkout too. Remove api first.` });
  expect(existsSync(join(child.path, 'draft.ts'))).toBe(true);
  expect(made.run('worktree', 'list')).toContain('APP-1');
});

it('refuses a repository that is not one plain folder name', async () => {
  const made = parent();

  await expect(ensure(made, '../api', 'develop')).rejects.toThrow('is not one plain folder name');
  await expect(listWorktrees({ projectPath: made.dir, baseBranch: 'main', repo: 'api/x', env: made.env })).rejects.toThrow('is not one plain folder name');
  expect(await removeWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: '../api', env: made.env }))
    .toEqual({ ok: false, reason: expect.stringContaining('is not one plain folder name') });
});

it('names the missing repository folder, and the list entry that names it', async () => {
  const made = parent();

  await expect(ensure(made, 'web', 'main')).rejects.toThrow(`The repository folder ${join(made.dir, 'web')} is not there`);
  expect(await removeWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: 'web', env: made.env })).toEqual({
    ok: false,
    reason: `${join(made.dir, 'web')} is not there, so there is no worktree to remove. Remove web from the project's repositories, or put its folder back.`,
  });
});

// git in a folder that is no repository walks up to the root, and would branch and check out there.
it('refuses a child folder that is not a repository of its own, and leaves the root alone', async () => {
  const made = parent();
  mkdirSync(join(made.dir, 'web'));
  const stray = `The repository folder ${join(made.dir, 'web')} is not a git repository of its own.`;

  await expect(ensure(made, 'web', 'main')).rejects.toThrow(stray);
  await expect(listWorktrees({ projectPath: made.dir, baseBranch: 'main', repo: 'web', env: made.env })).rejects.toThrow(stray);
  expect(await removeWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: 'web', env: made.env }))
    .toEqual({ ok: false, reason: expect.stringContaining(stray) });
  expect(made.run('branch', '--list', 'APP-1-work')).toBe('');
  expect(existsSync(join(made.dir, 'worktrees'))).toBe(false);
});

it('sends a missing base of a child repository to its own entry in the list', async () => {
  const made = parent();

  await expect(ensure(made, 'api', 'trunk')).rejects.toThrow("The base branch trunk is not in this repository. Set the base of api in the project's repositories to a branch that exists.");
  await expect(listWorktrees({ projectPath: made.dir, baseBranch: 'trunk', repo: 'api', env: made.env })).rejects.toThrow("Set the base of api in the project's repositories to a branch that exists.");
});

it('says the child repository needs a first commit, not the project', async () => {
  const made = parent();
  made.run('init', '-q', '-b', 'main', join(made.dir, 'web'));

  await expect(ensure(made, 'web', 'main')).rejects.toThrow('so this repository needs a first commit before a card can start.');
});

// A base from the repository list can start with a dash. git would read it as an option: measured,
// `worktree add -b B <path> -f` branches from HEAD and not from any base.
it.each(['-f', '--detach', '--all'])('refuses the base %s before git reads it as an option', async (base) => {
  const made = parent();

  await expect(ensure(made, 'api', base)).rejects.toThrow(`The base branch ${base} starts with a dash, so git would read it as an option.`);
  expect(existsSync(join(made.dir, 'worktrees'))).toBe(false);
  expect(made.run('-C', join(made.dir, 'api'), 'branch', '--list', 'APP-1-work')).toBe('');
  await expect(listWorktrees({ projectPath: made.dir, baseBranch: base, repo: 'api', env: made.env })).rejects.toThrow(`The base branch ${base} starts with a dash`);
});

// The base is only read when a new branch is cut, so a card whose branch is there still starts.
it('starts a card whose branch is there already, whatever its base', async () => {
  const made = parent();
  made.run('-C', join(made.dir, 'api'), 'branch', 'APP-1-work');

  const child = await ensure(made, 'api', '-f');

  expect(branchAt(made, child.path)).toBe('APP-1-work');
});
