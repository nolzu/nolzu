import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { ensureWorktree } from './worktree.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

const fresh = (withCommit = true): TempRepo => {
  const made = tempRepo('nolzu-worktree-');
  repo = made;
  if (withCommit) {
    made.write('README.md', 'demo\n');
    made.commit('first commit');
  }
  return made;
};

const call = (made: TempRepo, key: string, branch: string, baseBranch = 'main') =>
  ensureWorktree({ projectPath: made.dir, key, branch, baseBranch, env: made.env });

it('creates the worktree on a new branch cut from the base', async () => {
  const made = fresh();
  const base = made.run('rev-parse', 'HEAD').trim();

  const result = await call(made, 'APP-1', 'APP-1-add-a-search-box');

  expect(result.path).toBe(join(made.dir, 'worktrees', 'APP-1'));
  expect(result.created).toBe(true);
  expect(existsSync(join(result.path, 'README.md'))).toBe(true);
  expect(made.run('rev-parse', 'APP-1-add-a-search-box').trim()).toBe(base);
  expect(made.run('worktree', 'list')).toContain('APP-1');
});

it('is safe to call twice and adds no second branch', async () => {
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-add-a-search-box');
  const branchesBefore = made.run('branch', '--list').trim();

  const second = await call(made, 'APP-1', 'APP-1-add-a-search-box');

  expect(second.path).toBe(first.path);
  expect(second.created).toBe(false);
  expect(made.run('branch', '--list').trim()).toBe(branchesBefore);
});

it('attaches a branch that exists with no worktree, and loses no commit', async () => {
  const made = fresh();
  made.run('checkout', '-q', '-b', 'APP-2-work');
  made.write('a.txt', 'kept\n');
  made.commit('work commit');
  const tip = made.run('rev-parse', 'APP-2-work').trim();
  made.run('checkout', '-q', 'main');

  const result = await call(made, 'APP-2', 'APP-2-work');

  expect(made.run('rev-parse', 'APP-2-work').trim()).toBe(tip);
  expect(readFileSync(join(result.path, 'a.txt'), 'utf8')).toBe('kept\n');
});

it('fails when the branch is checked out in the main working tree, and creates nothing', async () => {
  const made = fresh();
  made.run('checkout', '-q', '-b', 'APP-3-busy');

  const error = await call(made, 'APP-3', 'APP-3-busy').catch((reason: Error) => reason);

  expect((error as Error).message).toContain('APP-3-busy');
  expect((error as Error).message).toContain(made.dir);
  expect(existsSync(join(made.dir, 'worktrees', 'APP-3'))).toBe(false);
});


it('fails on a base branch that is not there, and names the setting', async () => {
  const made = fresh();

  const error = await call(made, 'APP-5', 'APP-5-work', 'not-a-branch').catch((reason: Error) => reason);

  expect((error as Error).message).toContain('not-a-branch');
  expect((error as Error).message).toMatch(/base branch/i);
});

it('fails on a repository with no commit yet', async () => {
  const made = fresh(false);

  const error = await call(made, 'APP-6', 'APP-6-work').catch((reason: Error) => reason);

  expect((error as Error).message).toMatch(/first commit/i);
});

it('adds the two exclude lines once, and leaves the lines the user wrote alone', async () => {
  const made = fresh();
  const exclude = join(made.dir, '.git', 'info', 'exclude');
  writeFileSync(exclude, '# my own list\nnotes.txt\n/worktrees/\n');

  await call(made, 'APP-1', 'APP-1-one');
  await call(made, 'APP-2', 'APP-2-two');

  const lines = readFileSync(exclude, 'utf8').split('\n');
  expect(lines.filter((line) => line === '/worktrees/')).toHaveLength(1);
  expect(lines.filter((line) => line === '/.tasks/')).toHaveLength(1);
  // The user's lines stay where they were, so nothing they wrote is moved or lost.
  expect(lines.slice(0, 3)).toEqual(['# my own list', 'notes.txt', '/worktrees/']);
  // Never the tracked ignore file.
  expect(existsSync(join(made.dir, '.gitignore'))).toBe(false);
});

it('recreates a worktree whose directory was deleted by hand', async () => {
  // A person tidies up and removes the folder. Reporting success then hands the engine a cwd that
  // is not there, and the next git call reads as "git is not installed".
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const again = await call(made, 'APP-1', 'APP-1-work');

  expect(existsSync(again.path)).toBe(true);
  expect(existsSync(join(again.path, 'README.md'))).toBe(true);
});

it('uses a directory that is already there and empty', async () => {
  // git itself checks out into an empty directory, so refusing it only blocks the card.
  const made = fresh();
  mkdirSync(join(made.dir, 'worktrees', 'APP-1'), { recursive: true });

  const result = await call(made, 'APP-1', 'APP-1-work');

  expect(existsSync(join(result.path, 'README.md'))).toBe(true);
});

it('refuses a key that would put the worktree outside the worktrees folder', async () => {
  const made = fresh();

  const error = await call(made, '../escaped', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toMatch(/key/i);
  expect(existsSync(join(made.dir, 'escaped'))).toBe(false);
});

it('refuses a branch name that a tag already uses', async () => {
  // git warns that the name is ambiguous on a stderr nobody reads, and every later lookup by the
  // bare name answers with the tag.
  const made = fresh();
  made.run('tag', 'APP-1-work');

  const error = await call(made, 'APP-1', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toMatch(/tag/i);
  expect((error as Error).message).toContain('APP-1-work');
});

it('keeps the work on a branch that exists only on the remote', async () => {
  const made = fresh();
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('checkout', '-q', '-b', 'APP-2-work');
  made.write('remote.txt', 'work done elsewhere\n');
  made.commit('work done elsewhere');
  const tip = made.run('rev-parse', 'APP-2-work').trim();
  made.run('push', '-q', 'origin', 'APP-2-work');
  made.run('checkout', '-q', 'main');
  made.run('branch', '-q', '-D', 'APP-2-work');

  const result = await call(made, 'APP-2', 'APP-2-work');

  // Cutting a fresh branch from the base would throw the pushed work away and the later push
  // would be refused as a non fast forward.
  expect(made.run('rev-parse', 'APP-2-work').trim()).toBe(tip);
  expect(existsSync(join(result.path, 'remote.txt'))).toBe(true);
});


it('writes the exclude lines even when the worktree was already there', async () => {
  const made = fresh();
  const exclude = join(made.dir, '.git', 'info', 'exclude');
  await call(made, 'APP-1', 'APP-1-work');
  writeFileSync(exclude, '# wiped by hand\n');

  await call(made, 'APP-1', 'APP-1-work');

  const text = readFileSync(exclude, 'utf8');
  expect(text).toContain('/worktrees/');
  expect(text).toContain('/.tasks/');
});

it('never destroys the worktree another call just made', async () => {
  // Two calls for one key race. The loser used to clean up state the winner had created, so the
  // caller was handed a path and a branch that were deleted a moment later.
  const made = fresh();

  await Promise.allSettled([call(made, 'APP-1', 'APP-1-work'), call(made, 'APP-1', 'APP-1-work')]);

  expect(existsSync(join(made.dir, 'worktrees', 'APP-1', 'README.md'))).toBe(true);
  expect(made.run('branch', '--list', 'APP-1-work').trim()).not.toBe('');
});

it('refuses at once on a signal that is already aborted, and creates nothing', async () => {
  // The abort path used to be covered by killing a real checkout mid flight and asserting what was
  // left behind. That raced git. Measured on git 2.54.0, killing `worktree add` at 20, 60, 120, 250
  // and 500 ms leaves the branch every single time, and leaves the folder only sometimes at the
  // early end, so those assertions held only when the timing fell one way. It reddened CI three
  // times. What that test proved about a leftover folder is proved deterministically by 'refuses
  // every folder that holds files, whatever is in it', which builds the same state directly, and the
  // branch cleanup by the annotated tag test. What was left is the signal itself, which needs no
  // race to check.
  const made = fresh();
  const controller = new AbortController();
  controller.abort();

  const error = await ensureWorktree({
    projectPath: made.dir,
    key: 'APP-9',
    branch: 'APP-9-work',
    baseBranch: 'main',
    env: made.env,
    signal: controller.signal,
  }).catch((reason: Error) => reason);

  expect(error).toBeInstanceOf(Error);
  expect(existsSync(join(made.dir, 'worktrees', 'APP-9'))).toBe(false);
  expect(made.run('branch', '--list', 'APP-9-work').trim()).toBe('');
});

it('refuses a worktree that is registered but no longer a checkout, and keeps what is in it', async () => {
  // This used to remake it, which meant deleting the folder. It is the same state as a card whose
  // gitdir was lost while the person still had work in it, and git's own listing cannot tell the
  // two apart, so nothing here is deleted. An empty folder in this state is still cleared.
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  rmSync(join(first.path, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const error = await call(made, 'APP-1', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
  expect(existsSync(join(first.path, 'README.md'))).toBe(true);
});

it.each([
  ['a newline', 'APP-1\nworktree /tmp/elsewhere'],
  ['a nested path', 'A/B'],
])('refuses a key holding %s', async (_label, key) => {
  const made = fresh();

  const error = await call(made, key, 'APP-7-work').catch((reason: Error) => reason);

  expect((error as Error).message).toMatch(/key/i);
});

it('uses a branch pushed to a remote whose name holds a slash', async () => {
  const made = fresh();
  const bare = join(made.dir, '..', 'fork.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'team/fork', bare);
  made.run('checkout', '-q', '-b', 'APP-4-work');
  made.write('kept.txt', 'work done elsewhere\n');
  made.commit('work done elsewhere');
  const tip = made.run('rev-parse', 'APP-4-work').trim();
  made.run('push', '-q', 'team/fork', 'APP-4-work');
  made.run('checkout', '-q', 'main');
  made.run('branch', '-q', '-D', 'APP-4-work');

  const result = await call(made, 'APP-4', 'APP-4-work');

  expect(made.run('rev-parse', 'APP-4-work').trim()).toBe(tip);
  expect(existsSync(join(result.path, 'kept.txt'))).toBe(true);
});

it('refuses a folder that holds files, and deletes nothing', async () => {
  // Deleting it was worse: it removed files the project tracks, and the state it was meant to
  // clear does not happen, because git writes the .git file before the first checked out file.
  const made = fresh();
  const target = join(made.dir, 'worktrees', 'APP-4');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'keep.txt'), 'mine');

  const error = await call(made, 'APP-4', 'APP-4-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(target);
  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('mine');
});

it('starts the card again after a checkout was killed and left git holding its lock', async () => {
  const made = fresh();
  const first = await call(made, 'APP-3', 'APP-3-work');
  made.run('worktree', 'lock', '--reason', 'initializing', first.path);
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const again = await call(made, 'APP-3', 'APP-3-work');

  expect(existsSync(join(again.path, 'README.md'))).toBe(true);
});

it('deletes the branch it made even when the base is an annotated tag', async () => {
  // rev-parse on an annotated tag answers with the tag object while the branch is put on the
  // commit, so the guard never matched. The folder is made read only so that `worktree add` fails
  // after it has created the branch, which is the only way to reach the cleanup at all.
  const made = fresh();
  made.run('tag', '-a', 'v1', '-m', 'release one');
  const holder = join(made.dir, 'worktrees');
  mkdirSync(holder, { recursive: true });
  chmodSync(holder, 0o500);

  await ensureWorktree({ projectPath: made.dir, key: 'APP-2', branch: 'APP-2-work', baseBranch: 'v1', env: made.env }).catch(
    () => undefined,
  );
  chmodSync(holder, 0o700);

  expect(made.run('branch', '--list', 'APP-2-work').trim()).toBe('');
});


it('refuses a worktree the user locked instead of deleting their work', async () => {
  // git's own worktree remove refuses a locked worktree. Deleting the files and then refusing the
  // call is the worst of both.
  const made = fresh();
  const first = await call(made, 'APP-6', 'APP-6-work');
  writeFileSync(join(first.path, 'UNSAVED.txt'), 'not committed yet\n');
  made.run('worktree', 'lock', first.path);
  rmSync(join(first.path, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  await call(made, 'APP-6', 'APP-6-work').catch(() => undefined);

  expect(readFileSync(join(first.path, 'UNSAVED.txt'), 'utf8')).toContain('not committed');
});

it('refuses a killed checkout that still holds files, rather than replacing it', async () => {
  // This used to rebuild the tree, which meant deleting the folder on the strength of the lock
  // saying initializing. That word only records that a checkout once started: a person can repair a
  // half checkout and work in it while it still reads that way, and rebuilding took their staged
  // work with it. Recovery is covered by the case where the folder holds nothing.
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  rmSync(join(first.path, 'README.md'), { force: true });
  made.run('worktree', 'lock', '--reason', 'initializing', first.path);

  const error = await call(made, 'APP-1', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
  expect(existsSync(first.path)).toBe(true);
});







it('never removes a folder that was already there when the creation fails', async () => {
  // The cleanup used to remove the target whenever nothing was registered at it, so a creation that
  // failed took away a folder it had never made, with whatever was inside it.
  const made = fresh();
  const target = join(made.dir, 'worktrees', 'APP-4');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, '.git'), `gitdir: "${join(made.dir, '.git')}"\n`);
  writeFileSync(join(target, 'keep.txt'), 'mine');

  await call(made, 'APP-4', 'APP-4-work').catch(() => undefined);

  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('mine');
});


it('refuses every folder that holds files, whatever is in it', async () => {
  // One rule for all of them: a nested repository, a submodule pointer, a person's notes. Telling
  // them apart is what kept deleting work.
  const made = fresh();
  for (const [key, name, body] of [
    ['APP-5', 'keep.txt', 'mine'],
    ['APP-6', '.git', `gitdir: ${join(made.dir, '.git', 'worktrees', 'APP-6')}\n`],
    ['APP-7', '.git', 'gitdir: ../../.git/modules/APP-7\n'],
  ] as const) {
    const target = join(made.dir, 'worktrees', key);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, name), body);

    const error = await call(made, key, `${key}-work`).catch((reason: Error) => reason);

    expect((error as Error).message, key).toContain(target);
    expect(existsSync(join(target, name)), key).toBe(true);
  }
});

it('never deletes the work in a card whose gitdir went missing', async () => {
  // The folder is still registered, so it used to be removed to clear the entry. A prunable entry
  // says nothing about whose files are in the folder, and staged work has no commit to recover from.
  const made = fresh();
  const first = await call(made, 'APP-8', 'APP-8-work');
  made.write('README.md', 'demo\n');
  writeFileSync(join(first.path, 'NEW-FEATURE.ts'), 'export const x = 1;\n');
  rmSync(join(first.path, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const error = await call(made, 'APP-8', 'APP-8-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
  expect(readFileSync(join(first.path, 'NEW-FEATURE.ts'), 'utf8')).toContain('export const x');
});

it('still clears a registered entry whose folder is empty or gone', async () => {
  // Nothing is lost by clearing an empty folder, so the card recovers without anybody's files.
  const made = fresh();
  const first = await call(made, 'APP-9', 'APP-9-work');
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(first.path, { recursive: true });

  const again = await call(made, 'APP-9', 'APP-9-work');

  expect(existsSync(join(again.path, 'README.md'))).toBe(true);
});

it('never deletes work in a worktree that git still calls unfinished', async () => {
  // The lock records that a checkout once started and never cleared the flag. It does not say the
  // folder is git's own now: a person can repair a half checkout and work in it for a week while
  // the flag still reads initializing. Force removing on that word lost staged work.
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  writeFileSync(join(first.path, 'UNSAVED.md'), 'work nobody committed\n');
  made.run('-C', first.path, 'add', 'UNSAVED.md');
  made.run('worktree', 'lock', '--reason', 'initializing', first.path);

  const error = await call(made, 'APP-1', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
  expect(readFileSync(join(first.path, 'UNSAVED.md'), 'utf8')).toContain('nobody committed');
  // The lock is the person's protection and is still there to protect them.
  expect(made.run('worktree', 'list', '--porcelain')).toContain('locked');
});

it('still recovers an unfinished creation when the folder holds nothing', async () => {
  const made = fresh();
  const first = await call(made, 'APP-2', 'APP-2-work');
  made.run('worktree', 'lock', '--reason', 'initializing', first.path);
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const again = await call(made, 'APP-2', 'APP-2-work');

  expect(existsSync(join(again.path, 'README.md'))).toBe(true);
});

it('never hands the card a checkout belonging to another repository', async () => {
  // The folder holds a real repository, so its .git exists and the entry was taken as usable. An
  // agent working there would write into somebody else's project.
  const made = fresh();
  const first = await call(made, 'APP-3', 'APP-3-work');
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(first.path, { recursive: true });
  made.run('init', '-q', '-b', 'their-feature', first.path);

  const error = await call(made, 'APP-3', 'APP-3-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
});

it("never hands the card the project own checkout", async () => {
  // git walks up when a folder is not a repository, so asking the folder which repository it
  // belongs to answered with the project itself. The card then ran in the person's own working
  // tree: commits landed on their branch and a checkout moved it under them.
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  rmSync(join(first.path, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(join(first.path, '.git'), { recursive: true });

  const error = await call(made, 'APP-1', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
  expect(made.run('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
});

it('refuses a healthy worktree the person locked', async () => {
  // git's own remove refuses a locked worktree. Handing it to an agent that writes in it is worse
  // than refusing, and the lock is the person saying they are using it.
  const made = fresh();
  const first = await call(made, 'APP-2', 'APP-2-work');
  writeFileSync(join(first.path, 'UNSAVED.md'), 'work in progress\n');
  made.run('worktree', 'lock', '--reason', 'debugging a flaky build here', first.path);

  const error = await call(made, 'APP-2', 'APP-2-work').catch((reason: Error) => reason);

  expect((error as Error).message).toMatch(/locked/i);
  expect(readFileSync(join(first.path, 'UNSAVED.md'), 'utf8')).toContain('work in progress');
});

it('never hands a card the checkout of another card', async () => {
  // An ordinary folder move or copy leaves APP-2's path holding APP-1's checkout. git still lists
  // that path under APP-2's registration, so the branch guard reads APP-1's branch and agrees. The
  // agent's commits then land on APP-1's branch and APP-1's own tree comes back with deletions.
  const made = fresh();
  const one = await call(made, 'APP-1', 'APP-1-work');
  const two = await call(made, 'APP-2', 'APP-2-work');
  rmSync(two.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cpSync(one.path, two.path, { recursive: true });

  const error = await call(made, 'APP-2', 'APP-2-work').catch((reason: Error) => reason);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(two.path);
  expect(made.run('-C', one.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('APP-1-work');
});

it('never hands the card the project checkout when the project is itself a linked worktree', async () => {
  // The git directory of a linked worktree lives under the same worktrees folder as the cards, so
  // a check that only asks whether the answer sits under that folder accepts the project itself.
  const made = fresh();
  made.run('worktree', 'add', '-q', '../project', '-b', 'project-work');
  const project = join(made.dir, '..', 'project');
  const job = { projectPath: project, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', env: made.env };
  const first = await ensureWorktree(job);
  writeFileSync(join(project, 'PERSON.md'), 'half finished\n');
  rmSync(join(first.path, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(join(first.path, '.git'), { recursive: true });

  const error = await ensureWorktree(job).catch((reason: Error) => reason);

  expect(error).toBeInstanceOf(Error);
  expect(made.run('-C', project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('project-work');
  expect(readFileSync(join(project, 'PERSON.md'), 'utf8')).toContain('half finished');
});

it('names a registered folder that became a plain file, rather than crashing', async () => {
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  writeFileSync(first.path, 'not a folder\n');

  const error = await call(made, 'APP-1', 'APP-1-work').catch((reason: Error) => reason);

  expect((error as Error).message).toContain(first.path);
  expect((error as Error).message).not.toContain('ENOTDIR');
});

it('starts the card again when the cleared folder holds only a Finder file', async () => {
  // Opening the folder in Finder writes .DS_Store into it. Counting that as work refused the card
  // for good, and the person sees an empty folder and no way to start.
  const made = fresh();
  const first = await call(made, 'APP-1', 'APP-1-work');
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(first.path, { recursive: true });
  writeFileSync(join(first.path, '.DS_Store'), 'finder\n');

  const again = await call(made, 'APP-1', 'APP-1-work');

  expect(again.path).toBe(first.path);
  expect(existsSync(join(again.path, 'README.md'))).toBe(true);
});

// The proof compares the admin directory's pointer with the card folder's own .git. When the card
// path is a symlink both sides resolve through that same link, so the comparison answers itself
// and passes for whatever the link points at. git never makes the card path a symlink, so one is
// never this card's.
it('never hands a card a checkout reached through a symlink at its own path', async () => {
  const made = fresh();
  const one = await call(made, 'APP-1', 'APP-1-work');
  const two = await call(made, 'APP-2', 'APP-2-work');
  rmSync(two.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  symlinkSync(one.path, two.path);

  const error = await call(made, 'APP-2', 'APP-2-work').catch((reason: Error) => reason);

  expect(error).toBeInstanceOf(Error);
  // APP-1 keeps its branch, so nothing was about to commit onto it.
  expect(made.run('-C', one.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('APP-1-work');
});

// The project being a linked worktree is what makes this bite: its own admin directory then has a
// gitdir file, so the pointer read succeeds and the comparison resolves through the same link.
it('refuses a card path symlinked onto a project that is itself a linked worktree', async () => {
  const made = fresh();
  made.run('worktree', 'add', '-q', '../project', '-b', 'project-work');
  const project = join(made.dir, '..', 'project');
  const job = { projectPath: project, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', env: made.env };
  const first = await ensureWorktree(job);
  writeFileSync(join(project, 'PERSON.md'), 'half finished\n');
  rmSync(first.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  symlinkSync(project, first.path);

  const error = await ensureWorktree(job).catch((reason: Error) => reason);

  expect(error).toBeInstanceOf(Error);
  expect(made.run('-C', project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('project-work');
  expect(readFileSync(join(project, 'PERSON.md'), 'utf8')).toContain('half finished');
});

// Nothing in this suite set that config, so the line that resolves a relative pointer was never
// exercised. Dropping it refuses every healthy card in a repository that has it on.
it('reuses a card in a repository that stores worktree paths relatively', async () => {
  const made = fresh();
  made.run('config', 'worktree.useRelativePaths', 'true');
  const first = await call(made, 'APP-1', 'APP-1-work');

  const again = await call(made, 'APP-1', 'APP-1-work');

  expect(again.created).toBe(false);
  expect(again.path).toBe(first.path);
});

// git exports GIT_DIR into every hook it runs, and into rebase --exec and bisect run, and the login
// shell environment is captured and handed on, so one arrives without anybody setting it. With it
// set, rev-parse --git-common-dir answers with that repository, so the excludes are written there
// and the card's worktree and branch are made in a repository nobody chose.
it('ignores a stray GIT_DIR and works in the project it was given', async () => {
  const made = fresh();
  const stray = tempRepo('nolzu-worktree-stray-');
  stray.write('README.md', 'stray\n');
  stray.commit('first commit');
  const strayExclude = join(stray.dir, '.git', 'info', 'exclude');

  try {
    const result = await ensureWorktree({
      projectPath: made.dir,
      key: 'APP-1',
      branch: 'APP-1-work',
      baseBranch: 'main',
      env: { ...made.env, GIT_DIR: join(stray.dir, '.git') },
    });

    expect(result.path).toBe(join(made.dir, 'worktrees', 'APP-1'));
    expect(made.run('worktree', 'list')).toContain('APP-1');
    expect(made.run('branch', '--list', 'APP-1-work').trim()).not.toBe('');
    expect(stray.run('branch', '--list', 'APP-1-work').trim()).toBe('');
    expect(stray.run('worktree', 'list')).not.toContain('APP-1');
    expect(existsSync(strayExclude) ? readFileSync(strayExclude, 'utf8') : '').not.toContain('/worktrees/');
  } finally {
    stray.remove();
  }
});

// `worktree prune` reaches every worktree of the repository, and clears one whose folder is away for a
// moment, on a drive not mounted, say. The card clears only its own entry.
it('clears its own stale entry and leaves another worktree whose folder is away', async () => {
  const made = fresh();
  const one = (await call(made, 'APP-1', 'APP-1-work')).path;
  const two = (await call(made, 'APP-2', 'APP-2-work')).path;
  renameSync(two, `${two}-away`);
  rmSync(one, { recursive: true, force: true });

  await call(made, 'APP-1', 'APP-1-work');

  expect(existsSync(one)).toBe(true);
  expect(made.run('worktree', 'list', '--porcelain')).toContain(two);
});

// A run that may write the git folder can put a link where the exclude file is. Read through it, a
// hidden key would land in the repository's exclude file as plain text, which a later run reads.
it('neither reads nor writes the exclude file through a link, and starts no card on one', async () => {
  const made = fresh();
  const secret = join(made.dir, '..', 'id_test');
  writeFileSync(secret, 'not-a-real-key\n');
  const exclude = join(made.dir, '.git', 'info', 'exclude');
  rmSync(exclude, { force: true });
  symlinkSync(secret, exclude);

  await expect(call(made, 'APP-1', 'APP-1-work')).rejects.toThrow(/is a link/);

  expect(readFileSync(secret, 'utf8')).toBe('not-a-real-key\n');
  expect(lstatSync(exclude).isSymbolicLink()).toBe(true);
  expect(existsSync(join(made.dir, 'worktrees', 'APP-1'))).toBe(false);
});

it('neither reads nor writes through a link in the place of the info folder', async () => {
  const made = fresh();
  const elsewhere = join(made.dir, '..', 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'exclude'), 'theirs\n');
  rmSync(join(made.dir, '.git', 'info'), { recursive: true, force: true });
  symlinkSync(elsewhere, join(made.dir, '.git', 'info'));

  await expect(call(made, 'APP-1', 'APP-1-work')).rejects.toThrow(/is a link/);

  expect(readFileSync(join(elsewhere, 'exclude'), 'utf8')).toBe('theirs\n');
});

// A named pipe would hold the read for good, and the whole app with it.
it('answers at once for a named pipe at the exclude file, and starts no card on it', async () => {
  const made = fresh();
  const exclude = join(made.dir, '.git', 'info', 'exclude');
  rmSync(exclude, { force: true });
  execFileSync('mkfifo', [exclude]);

  await expect(call(made, 'APP-1', 'APP-1-work')).rejects.toThrow(/not what git keeps there/);

  expect(existsSync(join(made.dir, 'worktrees', 'APP-1'))).toBe(false);
}, 10_000);

// The temp file beside it is made new, so a link left at its name is not written through.
it('writes the exclude lines through no link left at the temp name', async () => {
  const made = fresh();
  const victim = join(made.dir, '..', 'victim.txt');
  writeFileSync(victim, 'mine\n');
  symlinkSync(victim, join(made.dir, '.git', 'info', `exclude.${process.pid}.tmp`));

  await call(made, 'APP-1', 'APP-1-work');

  expect(readFileSync(victim, 'utf8')).toBe('mine\n');
  expect(readFileSync(join(made.dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/worktrees/');
});
