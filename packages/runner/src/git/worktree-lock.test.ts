import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { ensureWorktree } from './worktree.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

const fresh = (): TempRepo => {
  const made = tempRepo('nolzu-lock-');
  repo = made;
  made.write('README.md', 'demo\n');
  made.commit('first commit');
  return made;
};

const call = (made: TempRepo, key: string) =>
  ensureWorktree({ projectPath: made.dir, key, branch: `${key}-work`, baseBranch: 'main', env: made.env });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Staggered rather than fired together, because the gap this closes is two milliseconds wide: a
// branch becomes visible before its worktree is registered, so calls that start at slightly
// different moments land inside it.
const staggered = async (made: TempRepo, key: string, calls: number) =>
  Promise.allSettled(
    Array.from({ length: calls }, async (_, at) => {
      await wait((at * 200) / calls);
      return call(made, key);
    }),
  );

const one = (made: TempRepo, key: string) => {
  const path = join(made.dir, 'worktrees', key);
  const listed = made.run('worktree', 'list', '--porcelain');
  const entries = listed.split('\n').filter((line) => line.startsWith('worktree ') && line.includes(`worktrees/${key}`));

  expect(entries).toHaveLength(1);
  expect(existsSync(join(path, 'README.md'))).toBe(true);
  expect(made.run('branch', '--list', `${key}-work`).trim()).not.toBe('');
};

it.each([2, 4, 8])('hands the same worktree to all %i calls for one card', async (calls) => {
  const made = fresh();

  const results = await staggered(made, 'APP-1', calls);

  // Measured before this was written: git refuses the second caller while it builds a worktree, so
  // seven of eight calls came back as errors. Nothing was corrupted, but a retry, a double drag or
  // a second window turned into a failure the person had to read. They wait instead.
  const refused = results.filter((result) => result.status === 'rejected');
  expect(refused).toEqual([]);
  for (const result of results) {
    if (result.status === 'fulfilled') {
      expect(result.value.path).toBe(join(made.dir, 'worktrees', 'APP-1'));
      expect(existsSync(result.value.path)).toBe(true);
    }
  }
  // One of them made it, the rest were handed it.
  expect(results.filter((result) => result.status === 'fulfilled' && result.value.created)).toHaveLength(1);
  one(made, 'APP-1');
});

it('holds up under rounds of it, not only one lucky run', async () => {
  const made = fresh();

  for (let round = 0; round < 5; round += 1) {
    const key = `APP-${round + 1}`;
    const results = await staggered(made, key, 4);

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    one(made, key);
  }
});

it('starts three cards of one repository together in good time', async () => {
  const made = fresh();

  // Different cards wait for each other's build in one repository (`withRepoLock`), and only that
  // long: three checkouts of a one file repository one after another are still well under this.
  const started = Date.now();
  await Promise.all([call(made, 'APP-1'), call(made, 'APP-2'), call(made, 'APP-3')]);
  const took = Date.now() - started;

  one(made, 'APP-1');
  one(made, 'APP-2');
  one(made, 'APP-3');
  // The number is loose on purpose: it catches a lock that waits for its stale age, not a slow machine.
  expect(took).toBeLessThan(10_000);
});

// git writes a new worktree's entry under .git/worktrees in steps, and another card's add that read
// the folder meanwhile failed with "failed to read .git/worktrees/APP-3/commondir". Rounds of cards
// started at once in one repository, so one lucky run proves nothing.
it('lets many cards of one repository start at once, round after round', async () => {
  const made = fresh();

  for (let round = 0; round < 5; round += 1) {
    const keys = Array.from({ length: 8 }, (_, at) => `R${round}-${at + 1}`);
    const results = await Promise.allSettled(keys.map((key) => call(made, key)));

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    for (const key of keys) one(made, key);
  }
});

it('takes over a lock a dead process left behind', async () => {
  const made = fresh();
  const admin = join(made.dir, '.git', 'nolzu-locks', 'APP-1');
  mkdirSync(admin, { recursive: true });
  // A process id that is not running, and a time far enough back to be past any stated age.
  writeFileSync(join(admin, 'held-by.json'), JSON.stringify({ pid: 999_999, at: '2020-01-01T00:00:00.000Z' }));

  const made1 = await call(made, 'APP-1');

  expect(existsSync(join(made1.path, 'README.md'))).toBe(true);
  one(made, 'APP-1');
});

it('leaves no lock behind when the call is done', async () => {
  const made = fresh();

  await call(made, 'APP-1');

  const locks = join(made.dir, '.git', 'nolzu-locks');
  expect(existsSync(locks) ? readdirSync(locks) : []).toEqual([]);
});

it('leaves no lock behind when the call fails', async () => {
  const made = fresh();
  // A tag with the branch name is refused after the lock is taken, so this proves the release
  // happens on the way out as well as on the way through.
  made.run('tag', 'APP-1-work');

  await expect(call(made, 'APP-1')).rejects.toThrow(/tag/i);

  const locks = join(made.dir, '.git', 'nolzu-locks');
  expect(existsSync(locks) ? readdirSync(locks) : []).toEqual([]);
});

// The four guards of the cleanup. Each one could be removed with no test failing, so each one gets a
// test that fails when it is removed.

// The `ours` guard, which stops the cleanup removing a folder it found rather than made, has no
// test here on purpose. Measured: when the add fails while writing `<target>/.git`, git removes the
// empty folder itself, so the folder is gone whatever the cleanup does and no assertion can tell
// the guard from git's own behaviour. The module says the same thing where the guard is written.
it('takes its own half made branch away when the creation fails', async () => {
  const made = fresh();
  const target = join(made.dir, 'worktrees', 'APP-1');
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o500);

  try {
    await expect(call(made, 'APP-1')).rejects.toThrow();

    // git creates the branch before it writes the checkout, so a failed add leaves one behind.
    // Leaving it would make the next call attach to a branch pointing at nothing anyone chose.
    expect(made.run('branch', '--list', 'APP-1-work').trim()).toBe('');
  } finally {
    if (existsSync(target)) chmodSync(target, 0o700);
  }
});

it('refuses a folder that holds files, whatever git would have done with it', async () => {
  const made = fresh();
  const target = join(made.dir, 'worktrees', 'APP-1');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'notes.md'), 'a person put this here\n');

  await expect(call(made, 'APP-1')).rejects.toThrow(/holds files/i);

  expect(existsSync(join(target, 'notes.md'))).toBe(true);
});

it('keeps a branch that was already there when the creation fails', async () => {
  const made = fresh();
  made.write('second.txt', 'second\n');
  made.commit('second commit');
  const moved = made.run('rev-parse', 'HEAD').trim();
  made.run('branch', 'APP-1-work', moved);
  const target = join(made.dir, 'worktrees', 'APP-1');
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o500);

  try {
    await expect(call(made, 'APP-1')).rejects.toThrow();

    // This call did not cut that branch, so whatever happens to the checkout, the branch and its
    // commit belong to whoever made them.
    expect(made.run('rev-parse', 'APP-1-work').trim()).toBe(moved);
  } finally {
    if (existsSync(target)) chmodSync(target, 0o700);
  }
});

it('locks on the card key, so it is that card that unblocks it', async () => {
  const made = fresh();
  const at = join(made.dir, '.git', 'nolzu-locks', 'APP-1');
  mkdirSync(at, { recursive: true });
  // Held by a process that is alive, under this card's own name, taken a moment ago: nothing about
  // it is stale, so the only honest thing to do is wait.
  writeFileSync(join(at, 'held-by.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  let finished = false;
  const running = call(made, 'APP-1').then((worktree) => {
    finished = true;
    return worktree;
  });

  await wait(80);
  // A lock named after another card would leave this one free and the call would already be done,
  // which is the whole point of keying it by the card.
  expect(finished).toBe(false);

  rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const worktree = await running;
  expect(existsSync(worktree.path)).toBe(true);
});

// Any card's build waits on the repository's lock, which is what keeps two builds out of git's
// worktrees folder at once. The race itself is too narrow to show on demand.
it('waits on the repository lock, whatever the card', async () => {
  const made = fresh();
  const at = join(made.dir, '.git', 'nolzu-repo-lock', 'worktrees');
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'held-by.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  let finished = false;
  const running = call(made, 'APP-7').then((worktree) => {
    finished = true;
    return worktree;
  });

  await wait(80);
  expect(finished).toBe(false);

  rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  expect(existsSync((await running).path)).toBe(true);
});

// A Stop while a card waits behind another card's build ends the wait, behind either lock.
it.each([
  ['the card lock', ['nolzu-locks', 'APP-8']],
  ['the repository lock', ['nolzu-repo-lock', 'worktrees']],
])('stops waiting behind %s when the run is stopped', async (_name, path) => {
  const made = fresh();
  const at = join(made.dir, '.git', ...path);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'held-by.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const stop = new AbortController();

  const waiting = ensureWorktree({ projectPath: made.dir, key: 'APP-8', branch: 'APP-8-work', baseBranch: 'main', env: made.env, signal: stop.signal });
  await wait(80);
  stop.abort(new Error('The run was stopped.'));

  await expect(waiting).rejects.toThrow('The run was stopped.');
  expect(existsSync(join(made.dir, 'worktrees', 'APP-8'))).toBe(false);
  rmSync(at, { recursive: true, force: true });
});

it('keeps the lines a person wrote in the exclude file when cards start together', async () => {
  const made = fresh();
  const exclude = join(made.dir, '.git', 'info', 'exclude');
  writeFileSync(exclude, '# mine\n/scratch/\n');

  await Promise.all([call(made, 'APP-1'), call(made, 'APP-2'), call(made, 'APP-3')]);

  // The excludes are written before the lock is taken, and the lock is per card, so these three
  // calls all read and rewrite this file. A plain write truncates first, and the loser's copy
  // takes the winner's lines with it, the person's own among them.
  const text = readFileSync(exclude, 'utf8');
  expect(text).toContain('/scratch/');
  expect(text.split('\n').filter((line) => line.trim() === '/worktrees/')).toHaveLength(1);
  expect(text.split('\n').filter((line) => line.trim() === '/.tasks/')).toHaveLength(1);
});
