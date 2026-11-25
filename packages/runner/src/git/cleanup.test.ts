import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Each delete of a folder moved aside for removal, with whether the repository lock was held then.
const asideDeletes = vi.hoisted(() => [] as { path: string; locked: boolean }[]);
vi.mock('node:fs', async (actual) => {
  const real = await actual<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: (path: string, options?: Parameters<typeof real.rmSync>[1]) => {
      if (String(path).includes('nolzu-removing')) asideDeletes.push({ path: String(path), locked: real.existsSync(join(String(path), '..', '..', 'nolzu-repo-lock', 'worktrees')) });
      real.rmSync(path, options);
    },
  };
});
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { removeWorktree, sweepRemovals } from './cleanup.ts';
import { ensureWorktree } from './worktree.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

const fresh = (): TempRepo => {
  const made = tempRepo('nolzu-cleanup-');
  repo = made;
  made.write('README.md', 'demo\n');
  made.commit('first commit');
  return made;
};

const card = async (made: TempRepo, key = 'APP-1'): Promise<string> =>
  (await ensureWorktree({ projectPath: made.dir, key, branch: `${key}-work`, baseBranch: 'main', env: made.env })).path;

const remove = (made: TempRepo, over: Record<string, unknown> = {}) =>
  removeWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', env: made.env, ...over });

const commitIn = (made: TempRepo, at: string, name: string): void => {
  writeFileSync(join(at, name), `${name}\n`);
  made.run('-C', at, 'add', '-A');
  made.run('-C', at, 'commit', '-q', '-m', name);
};

const withRemote = (made: TempRepo): string => {
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  return bare;
};

it('removes a clean worktree and keeps its branch', async () => {
  const made = fresh();
  const at = await card(made);

  const result = await remove(made);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The flag is the caller's only way to tell "I removed a checkout" from "it was already gone".
  expect(result.stale).toBe(false);
  expect(existsSync(at)).toBe(false);
  // A closed card keeps its branch: a delete cannot be undone, and the work is the only copy.
  expect(made.run('branch', '--list', 'APP-1-work').trim()).not.toBe('');
  expect(made.run('worktree', 'list')).not.toContain('APP-1');
});

// git deletes ignored files with the checkout and says nothing. A .env is often the only copy of its keys.
it('refuses a checkout holding a file git ignores, and lets node_modules go', async () => {
  const made = fresh();
  made.write('.gitignore', '.env\nnode_modules/\n');
  made.commit('ignore');
  const at = await card(made);
  mkdirSync(join(at, 'node_modules'));
  writeFileSync(join(at, 'node_modules', 'x.js'), '\n');
  writeFileSync(join(at, '.env'), 'TOKEN=mine\n');

  const kept = await remove(made);

  expect(kept).toMatchObject({ ok: false, reason: expect.stringContaining('holds 1 file or folder git ignores (.env), and removing the checkout would delete it.') });
  expect(existsSync(join(at, '.env'))).toBe(true);
  rmSync(join(at, '.env'));
  expect((await remove(made)).ok).toBe(true);
});

it('refuses while the checkout holds uncommitted changes, and touches nothing', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'README.md'), 'edited but never committed\n');
  writeFileSync(join(at, 'notes.md'), 'and something new\n');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('2 uncommitted changes');
  expect(existsSync(join(at, 'notes.md'))).toBe(true);
});

it('refuses while commits are not pushed, when there is a remote to push to', async () => {
  const made = fresh();
  withRemote(made);
  const at = await card(made);
  made.run('-C', at, 'push', '-q', '-u', 'origin', 'APP-1-work');
  commitIn(made, at, 'one.txt');
  commitIn(made, at, 'two.txt');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('2 commits are not pushed');
  expect(existsSync(at)).toBe(true);
});

it('removes a worktree whose commits are all pushed', async () => {
  const made = fresh();
  withRemote(made);
  const at = await card(made);
  commitIn(made, at, 'one.txt');
  made.run('-C', at, 'push', '-q', '-u', 'origin', 'APP-1-work');

  const result = await remove(made);

  expect(result.ok).toBe(true);
  expect(existsSync(at)).toBe(false);
});

it('checks the work against the base when there is no remote at all', async () => {
  const made = fresh();
  const at = await card(made);
  commitIn(made, at, 'one.txt');

  const result = await remove(made);

  // Nothing can be pushed with no remote, so the question becomes whether the base already has the
  // work. It does not, and removing the checkout would leave it only on a branch nobody merged.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('not in main');
  expect(existsSync(at)).toBe(true);
});

it('removes a worktree with no remote once the base holds its work', async () => {
  const made = fresh();
  const at = await card(made);
  commitIn(made, at, 'one.txt');
  made.run('merge', '--no-edit', '-q', 'APP-1-work');

  const result = await remove(made);

  expect(result.ok).toBe(true);
  expect(existsSync(at)).toBe(false);
});

it('reports a directory deleted by hand as stale, and only clears the entry', async () => {
  const made = fresh();
  const at = await card(made);
  rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const result = await remove(made);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.stale).toBe(true);
  expect(made.run('worktree', 'list')).not.toContain('APP-1');
  // The branch is still the only copy of whatever was committed there.
  expect(made.run('branch', '--list', 'APP-1-work').trim()).not.toBe('');
});

it('leaves a worktree the person added somewhere else alone', async () => {
  const made = fresh();
  await card(made);
  const theirs = join(made.dir, '..', 'their-checkout');
  made.run('worktree', 'add', '-q', '-b', 'side', theirs);

  await remove(made);

  expect(existsSync(theirs)).toBe(true);
  expect(made.run('worktree', 'list')).toContain('their-checkout');
});

it('leaves everything in place when a run failed halfway, so the card can start again', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'half-written.ts'), 'the run died here\n');

  const refused = await remove(made);
  expect(refused.ok).toBe(false);

  // The next start finds the same checkout, with the same work in it, and resets nothing.
  const again = await card(made);
  expect(again).toBe(at);
  expect(existsSync(join(at, 'half-written.ts'))).toBe(true);
});

it('removes an unsafe worktree only when force is asked for by name', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'notes.md'), 'uncommitted\n');

  expect((await remove(made)).ok).toBe(false);
  const forced = await remove(made, { force: true });

  expect(forced.ok).toBe(true);
  expect(existsSync(at)).toBe(false);
});

// The checkout passes through the shared git folder on its way out, and its own links are no place
// git writes by name.
it('forces away a checkout holding a link, such as node_modules/.bin', async () => {
  const made = fresh();
  const at = await card(made);
  mkdirSync(join(at, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(at, 'node_modules', 'tool.js'), '\n');
  symlinkSync('../tool.js', join(at, 'node_modules', '.bin', 'tool'));
  writeFileSync(join(at, 'notes.md'), 'uncommitted\n');

  expect(await remove(made, { force: true })).toEqual({ ok: true, stale: false });
  expect(existsSync(at)).toBe(false);
});

// git refuses a forced remove of a worktree a person locked, and the folder moved aside comes back.
it('puts the folder back when git refuses the forced removal', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'notes.md'), 'uncommitted\n');
  made.run('worktree', 'lock', at);

  const refused = await remove(made, { force: true });

  expect(refused.ok).toBe(false);
  expect(readFileSync(join(at, 'notes.md'), 'utf8')).toBe('uncommitted\n');
  made.run('worktree', 'unlock', at);
});

// A forced removal of a large checkout would hold every other card of the repository while its files
// go, so they go after the locks: moved aside under them, deleted once they are free.
it('deletes a forced removal\'s files after it lets go of the repository lock', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'notes.md'), 'uncommitted\n');
  asideDeletes.length = 0;

  expect((await remove(made, { force: true })).ok).toBe(true);

  expect(asideDeletes).toEqual([{ path: expect.stringContaining(join('.git', 'nolzu-removing', 'APP-1-')), locked: false }]);
  expect(existsSync(asideDeletes[0]!.path)).toBe(false);
  expect(existsSync(at)).toBe(false);
  expect(made.run('worktree', 'list', '--porcelain')).not.toContain('worktrees/APP-1');
  expect(made.run('branch', '--list', 'APP-1-work').trim()).not.toBe('');
});

it('never forces by default, whatever else the caller passes', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./cleanup.ts', import.meta.url), 'utf8');

  // Read from the source, so a default nobody tests cannot hide in a branch no test reaches.
  expect(source).not.toMatch(/force\s*=\s*true/);
  expect(source).not.toMatch(/force\s*\?\?\s*true/);
});

it('does nothing for a card that has no checkout of its own', async () => {
  const made = fresh();
  await card(made, 'APP-2');

  // APP-1 was never created here. A cleanup that carried on regardless would be reasoning about a
  // row it does not have, and the next thing it touches is somebody else's.
  const result = await remove(made);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.stale).toBe(false);
  expect(existsSync(join(made.dir, 'worktrees', 'APP-2'))).toBe(true);
  expect(made.run('worktree', 'list')).toContain('APP-2');
});

it('refuses a stale checkout whose folder still holds files, and keeps its index', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'draft.txt'), 'staged, never committed\n');
  made.run('-C', at, 'add', 'draft.txt');
  // Only the pointer goes. The work stays, and so does the index that is the one thing holding a
  // staged blob with no commit behind it.
  rmSync(join(at, '.git'), { force: true });

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The sentence matters, not only the refusal. Without the folder check git refuses this by
  // itself with its own validation error, so asserting ok alone passes for the wrong reason.
  expect(result.reason).toContain('still holds files');
  expect(existsSync(join(at, 'draft.txt'))).toBe(true);
  expect(existsSync(join(made.dir, '.git', 'worktrees', 'APP-1'))).toBe(true);
});

it('refuses a checkout git cannot read, rather than reporting it cleaned up', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'notes.md'), 'uncommitted\n');
  writeFileSync(join(at, '.git'), 'garbage\n');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('still holds files');
  expect(existsSync(join(at, 'notes.md'))).toBe(true);
  expect(made.run('worktree', 'list')).toContain('APP-1');
});

it('leaves the entry of a worktree that is only away for a moment', async () => {
  const made = fresh();
  const at = await card(made);
  const theirs = join(made.dir, '..', 'their-checkout');
  made.run('worktree', 'add', '-q', '-b', 'side', theirs);
  const parked = join(made.dir, '..', 'parked');
  // Away, not gone: an unmounted drive, a restore, a folder the person moved for an hour.
  renameSync(theirs, parked);
  rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  await remove(made);

  renameSync(parked, theirs);
  // Its administrative folder is not this card's to delete, and a delete cannot be undone.
  expect(existsSync(join(made.dir, '.git', 'worktrees', 'their-checkout'))).toBe(true);
  expect(made.run('-C', theirs, 'status', '--porcelain')).toBe('');
});

it('names pushing, not merging, when the branch was never pushed', async () => {
  const made = fresh();
  withRemote(made);
  const at = await card(made);
  commitIn(made, at, 'one.txt');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('Push APP-1-work first');
  expect(result.reason).not.toContain('no remote');
  expect(existsSync(at)).toBe(true);
});

it('refuses a card key that is not a plain folder name, and deletes nothing', async () => {
  const made = fresh();

  await expect(remove(made, { key: '..' })).rejects.toThrow(/key/i);

  expect(existsSync(join(made.dir, '.git'))).toBe(true);
});

it('says a removal was partial when git dropped the entry and files stayed', async () => {
  const made = fresh();
  const at = await card(made);
  mkdirSync(join(at, 'vendor'));
  writeFileSync(join(at, 'vendor', 'lib.txt'), 'vendored\n');
  made.run('-C', at, 'add', '-A');
  made.run('-C', at, 'commit', '-q', '-m', 'vendor');
  made.run('merge', '--no-edit', '-q', 'APP-1-work');
  // A folder the person cannot delete is ordinary: build output written by a container run, or a
  // vendored folder checked in read only.
  chmodSync(join(at, 'vendor'), 0o555);

  try {
    const result = await remove(made);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('partly removed');
  } finally {
    chmodSync(join(at, 'vendor'), 0o755);
  }
});

it('clears a stale checkout whose folder holds nothing but a .DS_Store', async () => {
  const made = fresh();
  const at = await card(made);
  rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(at, { recursive: true });
  // A Finder visit is not the person's work. Counting it would leave the card unable to finish,
  // which is the mirror of the bug worktree.ts already records on the way in.
  writeFileSync(join(at, '.DS_Store'), 'finder\n');

  const result = await remove(made);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.stale).toBe(true);
  expect(made.run('worktree', 'list')).not.toContain('APP-1');
  expect(made.run('branch', '--list', 'APP-1-work').trim()).not.toBe('');
});

it('counts against the base branch the settings name, not the one that happens to be checked out', async () => {
  const made = fresh();
  made.run('branch', 'release');
  const at = await card(made);
  commitIn(made, at, 'one.txt');
  // main takes the work, release does not, and release is the base the settings name. Every other
  // fixture has these two the same, so passing HEAD instead of the base would read as correct.
  made.run('merge', '--no-edit', '-q', 'APP-1-work');

  const result = await remove(made, { baseBranch: 'release' });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('not in release');
  expect(existsSync(at)).toBe(true);
});

it('refuses a project folder that is not a git repository, rather than throwing', async () => {
  const made = fresh();
  const plain = join(made.dir, '..', 'not-a-repo');
  mkdirSync(plain, { recursive: true });

  const result = await removeWorktree({ projectPath: plain, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', env: made.env });

  // The screen puts this behind a confirmation, and a settings mistake has to arrive as a sentence the
  // screen can show, not as a rejected promise.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('not a git repository');
});

it('refuses a base branch that is not in the repository, rather than throwing', async () => {
  const made = fresh();
  const at = await card(made);
  // The person renamed their branch and the base branch setting still names the old one.
  made.run('branch', '-m', 'main', 'trunk');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('base branch main');
  expect(existsSync(at)).toBe(true);
  expect(made.run('worktree', 'list')).toContain('APP-1');
});

it('refuses a project folder that is not there, rather than throwing', async () => {
  const made = fresh();
  const gone = join(made.dir, '..', 'moved-away');

  const result = await removeWorktree({ projectPath: gone, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', env: made.env });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('is not there');
});

it('names the branch the checkout is on, not the one the card asked for', async () => {
  const made = fresh();
  withRemote(made);
  const at = await card(made);
  // Ordinary git use inside a card folder. The commits land on hotfix, so pushing APP-1-work would
  // report success while the work stayed on this machine.
  made.run('-C', at, 'switch', '-q', '-c', 'hotfix');
  commitIn(made, at, 'one.txt');
  made.run('-C', at, 'push', '-q', '-u', 'origin', 'hotfix');
  commitIn(made, at, 'two.txt');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('Push hotfix first');
  expect(existsSync(at)).toBe(true);
});

it('refuses a checkout on no branch whose commits nothing else holds, with force as well', async () => {
  const made = fresh();
  const at = await card(made);
  made.run('-C', at, 'checkout', '-q', '--detach');
  commitIn(made, at, 'work.txt');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('on no branch');

  // Assumption R keeps a branch, and there is none here, so force must not be the way out of this.
  const forced = await remove(made, { force: true });

  expect(forced.ok).toBe(false);
  expect(existsSync(join(at, 'work.txt'))).toBe(true);
});

it('says nothing about a lost commit when a branch still holds what the detached checkout is on', async () => {
  const made = fresh();
  const at = await card(made);
  commitIn(made, at, 'one.txt');
  // Detached, but on the commit APP-1-work points at. Nothing is lost, so the refusal must be the
  // ordinary one about the base, not the one that says nothing points at these commits.
  made.run('-C', at, 'checkout', '-q', '--detach');

  const result = await remove(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).not.toContain('on no branch');
  expect(result.reason).toContain('not in main');
});

it('refuses to force away a checkout whose submodule history lives inside it', async () => {
  const made = fresh();
  const upstream = join(made.dir, '..', 'lib-origin');
  made.run('init', '-q', '-b', 'main', upstream);
  writeFileSync(join(upstream, 'a.txt'), 'a\n');
  made.run('-C', upstream, 'add', '-A');
  made.run('-C', upstream, 'commit', '-q', '-m', 'lib first');
  made.run('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'lib');
  made.commit('add lib');

  const at = await card(made);
  made.run('-C', at, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
  // git keeps a card submodule's object store in the card's own administrative folder, so this
  // commit exists nowhere else: not on the submodule's remote, not in the project.
  writeFileSync(join(at, 'lib', 'b.txt'), 'b\n');
  made.run('-C', join(at, 'lib'), 'add', '-A');
  made.run('-C', join(at, 'lib'), 'commit', '-q', '-m', 'work nobody pushed');
  const sha = made.run('-C', join(at, 'lib'), 'rev-parse', 'HEAD').trim();
  made.run('-C', at, 'add', '-A');
  made.run('-C', at, 'commit', '-q', '-m', 'bump lib');
  made.run('merge', '--no-edit', '-q', 'APP-1-work');

  const plain = await remove(made);
  expect(plain.ok).toBe(false);

  const forced = await remove(made, { force: true });

  expect(forced.ok).toBe(false);
  if (forced.ok) return;
  expect(forced.reason).toContain('submodule');
  expect(made.run('-C', join(at, 'lib'), 'cat-file', '-t', sha).trim()).toBe('commit');
});

// A removal prunes, and a prune beside another card's build can take that build's half made entry, so
// it waits on the repository lock too.
it('waits on the repository lock before it removes anything', async () => {
  const made = fresh();
  const at = await card(made);
  const lock = join(made.dir, '.git', 'nolzu-repo-lock', 'worktrees');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'held-by.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  const removing = remove(made);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(existsSync(at)).toBe(true);

  rmSync(lock, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  expect((await removing).ok).toBe(true);
  expect(existsSync(at)).toBe(false);
});

// A crash between the move aside and the delete leaves the folder in nolzu-removing. The next removal
// in the repository deletes it, after the locks like its own.
it('deletes what a crashed removal left aside at the next removal', async () => {
  const made = fresh();
  await card(made);
  const left = join(made.dir, '.git', 'nolzu-removing', 'APP-9-0a1b2c3d');
  mkdirSync(join(left, 'src'), { recursive: true });
  writeFileSync(join(left, 'src', 'big.bin'), 'x');
  asideDeletes.length = 0;

  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await remove(made)).ok).toBe(true);

    expect(existsSync(left)).toBe(false);
    expect(asideDeletes).toEqual([{ path: left, locked: false }]);
    expect(said.mock.calls).toEqual([[`Removed ${left}, a checkout an earlier removal moved aside and did not delete.`]]);
  } finally {
    said.mockRestore();
  }
});

// The boot sweeps every known repository the same way, one line for each folder it deletes.
it('sweeps what a crashed removal left aside when Nolzu starts', async () => {
  const made = fresh();
  const left = ['APP-9-0a1b2c3d', 'APP-8-1b2c3d4e'].map((name) => join(made.dir, '.git', 'nolzu-removing', name));
  for (const at of left) mkdirSync(join(at, 'src'), { recursive: true });
  asideDeletes.length = 0;
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sweepRemovals(made.dir, made.env);

    for (const at of left) expect(existsSync(at)).toBe(false);
    expect(asideDeletes.map((one) => one.locked)).toEqual([false, false]);
    expect(said).toHaveBeenCalledTimes(2);
    // A folder that is no repository has nothing to sweep, and says nothing.
    await sweepRemovals(join(made.dir, 'nowhere'), made.env);
    expect(said).toHaveBeenCalledTimes(2);
  } finally {
    said.mockRestore();
  }
});

// A run that may write the git folder, as when a card's checkout is the project folder, can put a link
// where Nolzu keeps what it moved aside. The sweep removes the link and deletes nothing it points to.
it('removes a link left in the place of nolzu-removing, and nothing it points to', async () => {
  const made = fresh();
  const victim = join(made.dir, '..', 'victim');
  mkdirSync(join(victim, 'taxes'), { recursive: true });
  writeFileSync(join(victim, 'notes.txt'), 'mine\n');
  symlinkSync(victim, join(made.dir, '.git', 'nolzu-removing'));
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sweepRemovals(made.dir, made.env);
    expect(said).not.toHaveBeenCalled();
  } finally {
    said.mockRestore();
  }

  expect(existsSync(join(victim, 'notes.txt'))).toBe(true);
  expect(existsSync(join(victim, 'taxes'))).toBe(true);
  expect(lstatSync(join(made.dir, '.git', 'nolzu-removing'), { throwIfNoEntry: false })).toBeUndefined();
});

// A link inside the folder is deleted as a link, and its target stays.
it('deletes a link left inside nolzu-removing as a link', async () => {
  const made = fresh();
  const victim = join(made.dir, '..', 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'notes.txt'), 'mine\n');
  mkdirSync(join(made.dir, '.git', 'nolzu-removing'));
  symlinkSync(victim, join(made.dir, '.git', 'nolzu-removing', 'APP-9-0a1b2c3d'));
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await sweepRemovals(made.dir, made.env);
  } finally {
    said.mockRestore();
  }

  expect(existsSync(join(victim, 'notes.txt'))).toBe(true);
  expect(lstatSync(join(made.dir, '.git', 'nolzu-removing', 'APP-9-0a1b2c3d'), { throwIfNoEntry: false })).toBeUndefined();
});

// The same for a forced removal, which moves the checkout into the folder before it deletes it.
it('moves a forced removal into a folder of its own, never through a link', async () => {
  const made = fresh();
  const at = await card(made);
  writeFileSync(join(at, 'scratch.txt'), 'unsaved\n');
  const victim = join(made.dir, '..', 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'notes.txt'), 'mine\n');
  symlinkSync(victim, join(made.dir, '.git', 'nolzu-removing'));

  expect((await remove(made, { force: true })).ok).toBe(true);

  expect(existsSync(at)).toBe(false);
  expect(readdirSync(victim)).toEqual(['notes.txt']);
});
