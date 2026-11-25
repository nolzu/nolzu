import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { commitPaths, outsideRepo, pushUpstream, readRepo, repoPatch, type WorkspaceFile } from './workspace.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

const made = (): TempRepo => {
  repo = tempRepo('nolzu-workspace-');
  repo.write('AGENTS.md', 'rules\n');
  repo.write('notes.md', 'mine\n');
  repo.write('old.md', 'moved\n');
  repo.write('gone.md', 'bye\n');
  repo.commit('first');
  return repo;
};

// A bare remote next to the repository, with main pushed and set as its upstream.
const withRemote = (one: TempRepo): string => {
  const bare = join(one.dir, '..', 'remote.git');
  one.run('init', '-q', '--bare', '-b', 'main', bare);
  one.run('remote', 'add', 'origin', bare);
  one.run('push', '-q', '-u', 'origin', 'main');
  return bare;
};

// A second clone of the remote, which lands a commit the first one has not got.
const landElsewhere = (one: TempRepo, bare: string) => {
  const other = join(one.dir, '..', 'other');
  one.run('clone', '-q', bare, other);
  writeFileSync(join(other, 'theirs.md'), 'from another machine\n');
  one.run('-C', other, 'add', '-A');
  one.run('-C', other, 'commit', '-q', '-m', 'theirs');
  one.run('-C', other, 'push', '-q');
};

const NOLZU = ['AGENTS.md', '.agents/skills/', '.nolzu/phases/'];

const read = async (one: TempRepo, skip: string[] = []) => {
  const state = await readRepo({ folder: one.dir, skip, nolzuFiles: NOLZU, env: one.env });
  if (!state.ok) throw new Error(state.reason);
  return state;
};

it('lists every kind of change, marked as Nolzu files or the person own', async () => {
  const one = made();
  one.write('AGENTS.md', 'rules, newer\n');
  one.write('.agents/skills/nolzu-plan/SKILL.md', 'plan\n');
  one.write('notes.md', 'mine, staged\n');
  one.run('add', 'notes.md');
  one.run('mv', 'old.md', 'new.md');
  rmSync(join(one.dir, 'gone.md'));
  one.write('draft.md', 'new\n');

  const state = await read(one);

  expect(state.branch).toBe('main');
  expect(state.upstream).toBeNull();
  const by = Object.fromEntries(state.files.map((file) => [file.path, file]));
  expect(by['AGENTS.md']).toMatchObject({ status: 'changed', staged: false, owner: 'nolzu' });
  expect(by['.agents/skills/nolzu-plan/SKILL.md']).toMatchObject({ status: 'untracked', owner: 'nolzu' });
  expect(by['notes.md']).toMatchObject({ status: 'changed', staged: true, owner: 'yours' });
  expect(by['new.md']).toMatchObject({ status: 'renamed', oldPath: 'old.md', staged: true, owner: 'yours' });
  expect(by['gone.md']).toMatchObject({ status: 'deleted', owner: 'yours' });
  expect(by['draft.md']).toMatchObject({ status: 'untracked', staged: false, owner: 'yours' });
  expect(state.files).toHaveLength(6);
});

it('leaves out the files of an inner repository and of the card checkouts', async () => {
  const one = made();
  // An inner repository the project lists, one it does not, and a card checkout git can see.
  for (const inner of ['api', 'stray', 'worktrees/APP-1']) {
    mkdirSync(join(one.dir, inner), { recursive: true });
    one.run('init', '-q', join(one.dir, inner));
    writeFileSync(join(one.dir, inner, 'file.ts'), 'x\n');
  }
  one.write('worktrees/loose.txt', 'left by hand\n');
  one.write('top.md', 'mine\n');

  const state = await read(one, ['api', 'worktrees']);

  expect(state.files.map((file) => file.path)).toEqual(['top.md']);
});

it('says a missing folder or a plain folder is not a repository, without asking the one around it', async () => {
  const one = made();
  mkdirSync(join(one.dir, 'plain'));

  expect(await readRepo({ folder: join(one.dir, 'nothing'), env: one.env })).toEqual({ ok: false, reason: 'The folder is not there.' });
  expect(await readRepo({ folder: join(one.dir, 'plain'), env: one.env })).toEqual({ ok: false, reason: 'The folder is not a git repository.' });
});

it('counts ahead and behind against the upstream as git last knew it, and never fetches', async () => {
  const one = made();
  const bare = withRemote(one);
  one.write('mine.md', 'x\n');
  one.commit('mine');
  landElsewhere(one, bare);
  const trace = join(one.dir, '..', 'trace.txt');

  const before = await readRepo({ folder: one.dir, env: { ...one.env, GIT_TRACE: trace } });

  expect(before).toMatchObject({ ok: true, upstream: 'origin/main', ahead: 1, behind: 0 });
  expect(before.ok && before.confirmation).toBe(`Push main to origin at ${bare}.`);
  const said = readFileSync(trace, 'utf8');
  expect(said).toContain('status');
  expect(said).not.toMatch(/fetch|ls-remote|remote-/);

  one.run('fetch', '-q');
  expect(await read(one)).toMatchObject({ ahead: 1, behind: 1 });

  // The sentence names where the push goes, which a push URL of its own changes.
  one.run('remote', 'set-url', '--push', 'origin', join(one.dir, '..', 'push.git'));
  expect(await read(one)).toMatchObject({ confirmation: `Push main to origin at ${join(one.dir, '..', 'push.git')}.` });
});

it('commits exactly the ticked files and leaves the person staged file staged', async () => {
  const one = made();
  one.write('notes.md', 'mine, staged\n');
  one.run('add', 'notes.md');
  one.write('AGENTS.md', 'rules, newer\n');
  one.write('.nolzu/phases/plan.md', 'plan rules\n');
  one.run('mv', 'old.md', 'new.md');
  const files = (await read(one)).files.filter((file) => file.path !== 'notes.md');

  const done = await commitPaths({ folder: one.dir, message: 'chore: update the Nolzu files', files, env: one.env });

  expect(done.ok).toBe(true);
  expect(one.run('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['A\t.nolzu/phases/plan.md', 'M\tAGENTS.md', 'R100\told.md\tnew.md']);
  expect(one.run('status', '--porcelain').trim()).toBe('M  notes.md');
});

it('commits a file whose name is a pattern to git, and not the files it would match', async () => {
  const one = made();
  one.write('a.md', 'a\n');
  one.write('[ab].md', 'brackets\n');
  const files = (await read(one)).files.filter((file) => file.path === '[ab].md');

  expect(await commitPaths({ folder: one.dir, message: 'chore: x', files, env: one.env })).toMatchObject({ ok: true });
  expect(one.run('show', '--name-only', '--format=', 'HEAD').trim()).toBe('[ab].md');
  expect(one.run('status', '--porcelain').trim()).toBe('?? a.md');
});

it('refuses an empty message, no ticked file and a folder with conflicts', async () => {
  const one = made();
  one.write('AGENTS.md', 'newer\n');
  const files = (await read(one)).files;

  expect(await commitPaths({ folder: one.dir, message: '  ', files, env: one.env })).toMatchObject({ ok: false, reason: expect.stringContaining('empty') });
  expect(await commitPaths({ folder: one.dir, message: 'chore: x', files: [], env: one.env })).toMatchObject({ ok: false, reason: expect.stringContaining('No file is ticked') });

  one.run('stash', '-q');
  one.run('checkout', '-q', '-b', 'side');
  one.write('notes.md', 'side\n');
  one.commit('side');
  one.run('checkout', '-q', 'main');
  one.write('notes.md', 'main\n');
  one.commit('main');
  try {
    one.run('merge', '-q', 'side');
  } catch {
    // The conflict is the point.
  }
  const conflicted = (await read(one)).files;
  expect(conflicted).toEqual([expect.objectContaining({ path: 'notes.md', status: 'conflicted' })]);
  expect(await commitPaths({ folder: one.dir, message: 'chore: x', files: conflicted, env: one.env })).toMatchObject({ ok: false, reason: expect.stringContaining('conflicts') });
});

it('puts a new file back to untracked when git refuses the commit', async () => {
  const one = made();
  const hooks = join(one.dir, '..', 'refusing-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  one.run('config', 'core.hooksPath', hooks);
  one.write('draft.md', 'new\n');
  const files = (await read(one)).files;

  expect(await commitPaths({ folder: one.dir, message: 'chore: x', files, hooks: true, env: one.env })).toEqual({ ok: false, reason: 'no' });
  expect(one.run('status', '--porcelain').trim()).toBe('?? draft.md');
  // Hooks off, as on the card commit, the same hook does not run.
  expect(await commitPaths({ folder: one.dir, message: 'chore: x', files, env: one.env })).toMatchObject({ ok: true });
});

it('shows the patch of a changed file and of an untracked one', async () => {
  const one = made();
  one.write('notes.md', 'mine, changed\n');
  one.write('draft.md', 'new\n');
  const file = (path: string): WorkspaceFile => ({ path, oldPath: null, status: 'changed', staged: false, owner: 'yours' });

  expect(await repoPatch({ folder: one.dir, file: file('notes.md'), env: one.env })).toMatchObject({ ok: true, text: expect.stringContaining('+mine, changed') });
  expect(await repoPatch({ folder: one.dir, file: file('draft.md'), env: one.env })).toMatchObject({ ok: true, text: expect.stringContaining('+new') });
});

it('refuses a path that leaves the repository', () => {
  const one = made();
  const outside = join(one.dir, '..', 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(one.dir, 'out'));

  expect(outsideRepo(one.dir, 'notes.md')).toBe(false);
  expect(outsideRepo(one.dir, 'src/new.ts')).toBe(false);
  expect(outsideRepo(one.dir, '../outside/x')).toBe(true);
  expect(outsideRepo(one.dir, 'src/../notes.md')).toBe(true);
  expect(outsideRepo(one.dir, '/etc/passwd')).toBe(true);
  expect(outsideRepo(one.dir, '')).toBe(true);
  expect(outsideRepo(one.dir, 'out/x')).toBe(true);
  expect(outsideRepo(one.dir, 'out/gone/deeper/x')).toBe(true);
  expect(outsideRepo(one.dir, 'src/gone/x')).toBe(false);
});

it('refuses a push with no upstream or on no branch', async () => {
  const one = made();

  expect(await pushUpstream({ folder: one.dir, env: one.env })).toMatchObject({ ok: false, reason: expect.stringContaining('main has no upstream') });
  // A remote with no branch to merge from is no upstream either.
  one.run('config', 'branch.main.remote', 'origin');
  expect(await pushUpstream({ folder: one.dir, env: one.env })).toMatchObject({ ok: false, reason: expect.stringContaining('main has no upstream') });
  one.run('checkout', '-q', '--detach');
  expect(await pushUpstream({ folder: one.dir, env: one.env })).toMatchObject({ ok: false, reason: expect.stringContaining('on no branch') });
});

it('pushes to the upstream, and reports a rejected push without pulling', async () => {
  const one = made();
  const bare = withRemote(one);
  one.write('mine.md', 'x\n');
  one.commit('mine');

  expect(await pushUpstream({ folder: one.dir, env: one.env })).toMatchObject({ ok: true });
  expect(one.run('--git-dir', bare, 'rev-parse', 'main')).toBe(one.run('rev-parse', 'HEAD'));

  landElsewhere(one, bare);
  one.write('more.md', 'y\n');
  one.commit('more');
  const head = one.run('rev-parse', 'HEAD');

  const pushed = await pushUpstream({ folder: one.dir, env: one.env });

  expect(pushed).toMatchObject({ ok: false, rejected: true, reason: expect.stringContaining('Pull them in your editor or terminal, then push again') });
  expect(one.run('rev-parse', 'HEAD')).toBe(head);
  expect(one.run('ls-files')).not.toContain('theirs.md');
});

// A folder holding a repository whose `.git` is a file, with a filter in that repository's config. When
// git refuses the commit, taking the folder out of the index again runs no git inside it.
it('takes a ticked folder that holds a repository out of the index again without running its filter', async () => {
  const one = made();
  one.write('.gitignore', '/.vendor-git/\n');
  one.commit('ignore');
  const marker = join(one.dir, '..', 'filter-ran');
  const sub = join(one.dir, 'vendor-lib');
  const gitDir = join(one.dir, '.vendor-git');
  mkdirSync(sub);
  one.run('-C', sub, 'init', '-q', '-b', 'main', '--separate-git-dir', gitDir, '.');
  writeFileSync(join(sub, 'lib.txt'), 'data\n');
  one.run('-C', sub, 'add', 'lib.txt');
  one.run('-C', sub, 'commit', '-q', '-m', 'lib');
  one.run('-C', sub, 'config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`);
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=x\n');
  one.run('-C', sub, 'read-tree', 'HEAD');
  const hooks = join(one.dir, '..', 'refusing-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  one.run('config', 'core.hooksPath', hooks);
  const files: WorkspaceFile[] = [{ path: 'vendor-lib/', oldPath: null, status: 'untracked', staged: false, owner: 'yours' }];

  expect((await commitPaths({ folder: one.dir, message: 'chore: x', files, hooks: true, env: one.env })).ok).toBe(false);

  expect(existsSync(marker)).toBe(false);
  expect(one.run('ls-files', '--stage', '--', 'vendor-lib').trim()).toBe('');
});
