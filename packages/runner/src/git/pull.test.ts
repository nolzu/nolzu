import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { pullBranch } from './pull.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

// The person's own clone on main with work of theirs in the folder, the card's checkout as a worktree
// of it on the card's branch, a bare remote in a second folder, and another machine that pushed to the
// card's branch. None of it needs a network.
function setUp() {
  const made = tempRepo('nolzu-pull-');
  repo = made;
  made.write('list.ts', 'export const list = [];\n');
  made.commit('first commit');
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('push', '-q', 'origin', 'main');
  const card = join(made.dir, '..', 'card');
  made.run('worktree', 'add', '-q', '-b', 'APP-1-work', card);
  made.run('-C', card, 'push', '-q', '-u', 'origin', 'APP-1-work');
  const other = join(made.dir, '..', 'other');
  made.run('clone', '-q', bare, other);
  made.run('-C', other, 'checkout', '-q', 'APP-1-work');
  // The person's own folder: on main, with a file they have not committed.
  made.write('notes.txt', 'mine, not committed\n');
  return { made, card, other, bare };
}

const pull = (made: TempRepo, card: string) => pullBranch({ worktreePath: card, repo: { project: join(made.dir, '..'), workTree: card, commonDir: join(made.dir, '.git') }, branch: 'APP-1-work', remote: 'origin', env: made.env });

// The other machine adds search.ts to the card's branch and pushes it.
function pushFromOther(made: TempRepo, other: string) {
  made.write('../other/search.ts', 'export const search = true;\n');
  made.run('-C', other, 'add', '-A');
  made.run('-C', other, 'commit', '-q', '-m', 'from another machine');
  made.run('-C', other, 'push', '-q', 'origin', 'APP-1-work');
}

// What the person's own clone looks like: its branch, its commit and its folder.
const own = (made: TempRepo) => ({ head: made.run('rev-parse', 'HEAD'), branch: made.run('branch', '--show-current'), status: made.run('status', '--porcelain'), notes: readFileSync(join(made.dir, 'notes.txt'), 'utf8') });

it("pulls the commits another machine pushed into the card checkout, and leaves the person's own folder alone", async () => {
  const { made, card, other } = setUp();
  pushFromOther(made, other);
  // The card kept working meanwhile, so the two have parted and a merge commit joins them.
  made.write('../card/sort.ts', 'export const sort = true;\n');
  made.run('-C', card, 'add', '-A');
  made.run('-C', card, 'commit', '-q', '-m', 'the card kept working');
  const before = own(made);

  const result = await pull(made, card);

  expect(result).toEqual({ ok: true, upToDate: false });
  expect(existsSync(join(card, 'search.ts'))).toBe(true);
  expect(existsSync(join(card, 'sort.ts'))).toBe(true);
  expect(made.run('-C', card, 'log', '--format=%s', '-3')).toContain('from another machine');
  expect(own(made)).toEqual(before);
  expect(existsSync(join(made.dir, 'search.ts'))).toBe(false);
});

it('stops on a conflict and leaves the checkout in it, for the person to resolve', async () => {
  const { made, card, other } = setUp();
  made.write('../other/list.ts', 'export const list = ["from another machine"];\n');
  made.run('-C', other, 'commit', '-qam', 'another list');
  made.run('-C', other, 'push', '-q', 'origin', 'APP-1-work');
  made.write('../card/list.ts', 'export const list = ["from the card"];\n');
  made.run('-C', card, 'commit', '-qam', 'the card list');
  const before = own(made);

  const result = await pull(made, card);

  expect(result).toMatchObject({ ok: false, conflicts: ['list.ts'] });
  if (!result.ok) expect(result.reason).toMatch(/conflict/i);
  // Nothing was undone: the merge waits, with git's markers in the file.
  expect(made.run('-C', card, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toBe('');
  expect(readFileSync(join(card, 'list.ts'), 'utf8')).toContain('<<<<<<<');
  expect(own(made)).toEqual(before);
});

it('says so when there is nothing to pull', async () => {
  const { made, card } = setUp();

  expect(await pull(made, card)).toEqual({ ok: true, upToDate: true });
});

it("answers in git's own words when the remote has no such branch", async () => {
  const { made, card } = setUp();

  const result = await pullBranch({ worktreePath: card, repo: { project: join(made.dir, '..'), workTree: card, commonDir: join(made.dir, '.git') }, branch: 'APP-2-gone', remote: 'origin', env: made.env });

  expect(result).toMatchObject({ ok: false, conflicts: [] });
  if (!result.ok) expect(result.reason).toMatch(/couldn't find remote ref|APP-2-gone/i);
});

// git ranks a tag above a branch for a short name, so a tag that shares the branch's name would be
// merged in place of the branch.
it('pulls the branch and not a tag of the same name', async () => {
  const { made, card, other } = setUp();
  pushFromOther(made, other);
  made.run('-C', other, 'tag', 'APP-1-work', 'origin/main');
  made.run('-C', other, 'push', '-q', 'origin', 'refs/tags/APP-1-work');

  expect(await pull(made, card)).toEqual({ ok: true, upToDate: false });
  expect(existsSync(join(card, 'search.ts'))).toBe(true);
});

// Closing the tab or the push timeout stops the request. Only the fetch may stop with it: a merge
// killed halfway leaves the files half written and the index locked.
it('finishes the merge when the request stops after the fetch', async () => {
  const { made, card, other } = setUp();
  pushFromOther(made, other);
  made.write('../other/list.ts', 'export const list = [2];\n');
  made.run('-C', other, 'commit', '-q', '-am', 'list from another machine');
  made.run('-C', other, 'push', '-q', 'origin', 'APP-1-work');
  made.write('../card/list.ts', 'export const list = [1];\n');
  made.run('-C', card, 'commit', '-q', '-am', 'the card kept working');
  // Both sides changed list.ts, so git hands it to this slow merge driver inside the merge. A hook
  // cannot hold the merge here, because Nolzu runs git with the hooks off.
  // In the shared git folder: the driver runs inside the git wall, which allows the repository only.
  const mark = join(made.dir, '.git', 'merging');
  made.run('config', 'merge.slow.driver', `touch "${mark}"; sleep 1`);
  mkdirSync(join(made.dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(made.dir, '.git', 'info', 'attributes'), 'list.ts merge=slow\n');
  const stop = new AbortController();

  const pulling = pullBranch({ worktreePath: card, repo: { project: join(made.dir, '..'), workTree: card, commonDir: join(made.dir, '.git') }, branch: 'APP-1-work', remote: 'origin', env: made.env, signal: stop.signal });
  await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 10_000, interval: 20 });
  stop.abort();

  expect(await pulling).toEqual({ ok: true, upToDate: false });
  expect(existsSync(join(card, 'search.ts'))).toBe(true);
  expect(made.run('-C', card, 'status', '--porcelain')).toBe('');
});

// The merge makes a commit in a checkout an agent wrote, and nobody is asked first, so a post-merge
// hook a run planted, such as one in .husky, must not run here outside the wall.
it('runs no hook of the repository on the merge', async () => {
  const { made, card, other } = setUp();
  pushFromOther(made, other);
  made.write('../card/sort.ts', 'export const sort = true;\n');
  made.run('-C', card, 'add', '-A');
  made.run('-C', card, 'commit', '-q', '-m', 'the card kept working');
  const mark = join(made.dir, '..', 'hook-ran');
  const hooks = join(made.dir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of ['pre-merge-commit', 'post-merge']) writeFileSync(join(hooks, name), `#!/bin/sh\ntouch "${mark}"\n`, { mode: 0o755 });

  expect(await pull(made, card)).toEqual({ ok: true, upToDate: false });
  expect(existsSync(mark)).toBe(false);
});

// Read from the source, so a path no test reaches cannot hide one. The pull adds commits and never
// takes any away: no force, no reset, no rebase, no abort of a merge the person may want to finish.
it('never forces, resets, rebases, stashes or aborts, on any path through the module', () => {
  const source = readFileSync(new URL('./pull.ts', import.meta.url), 'utf8');

  for (const word of ["'--force'", "'-f'", "'reset'", "'rebase'", "'--rebase'", "'--abort'", "'stash'", "'clean'", "'checkout'", "'push'"]) expect(source).not.toContain(word);
});
