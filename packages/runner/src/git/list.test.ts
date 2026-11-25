import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { listWorktrees } from './list.ts';
import { ensureWorktree } from './worktree.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

const fresh = (): TempRepo => {
  const made = tempRepo('nolzu-list-');
  repo = made;
  made.write('README.md', 'demo\n');
  made.commit('first commit');
  return made;
};

// The card's checkout, made the way the board makes it.
const card = async (made: TempRepo, key: string): Promise<string> =>
  (await ensureWorktree({ projectPath: made.dir, key, branch: `${key}-work`, baseBranch: 'main', env: made.env })).path;

const rows = (made: TempRepo, repoName?: string, baseBranch = 'main') =>
  listWorktrees({ projectPath: made.dir, baseBranch, repo: repoName, env: made.env });

const commitIn = (made: TempRepo, at: string, name: string, text: string): void => {
  writeFileSync(join(at, name), text);
  made.run('-C', at, 'add', '-A');
  made.run('-C', at, 'commit', '-q', '-m', name);
};

it('reports how far the card is ahead and what it changed', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');
  commitIn(made, at, 'two.txt', 'two\n');
  writeFileSync(join(at, 'README.md'), 'edited\n');

  const [row, ...rest] = await rows(made);

  expect(rest).toEqual([]);
  expect(row?.branch).toBe('APP-1-work');
  expect(row?.base).toBe('main');
  expect(row?.ahead).toBe(2);
  expect(row?.behind).toBe(0);
  expect(row?.changed).toBe(1);
  expect(row?.untracked).toBe(0);
  expect(row?.stale).toBe(false);
  expect(row?.staleReason).toBe(null);
  expect(row?.path).toContain('APP-1');
});

it('reports the card behind once the base moved on', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');
  made.write('base.txt', 'base moved\n');
  made.commit('base moved on');

  const [row] = await rows(made);

  expect(row?.ahead).toBe(1);
  expect(row?.behind).toBe(1);
});

it('counts an untracked file on its own, so the tab can say what each number is', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');
  writeFileSync(join(at, 'README.md'), 'edited\n');
  writeFileSync(join(at, 'one.txt'), 'edited too\n');
  writeFileSync(join(at, 'new.txt'), 'never added\n');

  const [row] = await rows(made);

  expect(row?.changed).toBe(2);
  expect(row?.untracked).toBe(1);
});

it('reports a worktree whose folder was deleted by hand, and lists the rest', async () => {
  const made = fresh();
  const gone = await card(made, 'APP-1');
  commitIn(made, gone, 'one.txt', 'one\n');
  await card(made, 'APP-2');
  rmSync(gone, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const listed = await rows(made);

  const stale = listed.find((row) => row.path.includes('APP-1'));
  expect(stale?.stale).toBe(true);
  expect(stale?.staleReason).toMatch(/gitdir/i);
  // The counts still come from the branch, which is where the work is.
  expect(stale?.ahead).toBe(1);
  expect(stale?.changed).toBe(0);
  expect(listed.find((row) => row.path.includes('APP-2'))?.stale).toBe(false);
});

it('returns nothing when the project has no card worktree', async () => {
  const made = fresh();

  expect(await rows(made)).toEqual([]);
});

it('never lists the project own working tree', async () => {
  const made = fresh();
  await card(made, 'APP-1');

  const listed = await rows(made);

  expect(listed).toHaveLength(1);
  expect(listed[0]?.branch).toBe('APP-1-work');
});

it('counts what is not pushed once the branch has an upstream', async () => {
  const made = fresh();
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');
  made.run('-C', at, 'push', '-q', '-u', 'origin', 'APP-1-work');

  const [pushed] = await rows(made);
  expect(pushed?.unpushed).toBe(0);
  // Counted from the base, not from the upstream. Against the upstream this would be zero.
  expect(pushed?.ahead).toBe(1);

  commitIn(made, at, 'two.txt', 'two\n');

  const [later] = await rows(made);
  expect(later?.unpushed).toBe(1);
  expect(later?.ahead).toBe(2);
});

it('reports no unpushed count at all when the branch has no upstream', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');

  const [row] = await rows(made);

  // Null and not zero. A project with no remote has nothing to push to, which is not the same
  // as a branch that is level with its upstream.
  expect(row?.unpushed).toBe(null);
});

it('names the repository the caller gave, for a project that holds several', async () => {
  const made = fresh();
  await card(made, 'APP-1');
  // Git runs in the named repository now, so it has to be one.
  const api = join(made.dir, 'api');
  made.run('init', '-q', '-b', 'main', api);
  commitIn(made, api, 'server.ts', 'export {};\n');
  await ensureWorktree({ projectPath: made.dir, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: 'api', env: made.env });

  expect((await rows(made, 'api'))[0]?.repo).toBe('api');
  expect((await rows(made))[0]?.repo).toBe('.');
});

// The rows arrive in git's own order and nothing sorts them here. Measured on git 2.54 that order
// is by name and ignores case, so keys of one case read as plain alphabetical.
it('lists the cards in the order git reports, which is by name', async () => {
  const made = fresh();
  await card(made, 'APP-2');
  await card(made, 'APP-1');
  await card(made, 'APP-3');

  const listed = await rows(made);

  expect(listed.map((row) => row.branch)).toEqual(['APP-1-work', 'APP-2-work', 'APP-3-work']);
});

it('refuses a base branch that is not in the repository, and names the setting', async () => {
  const made = fresh();
  await card(made, 'APP-1');

  const error = await rows(made, undefined, 'release').catch((reason: Error) => reason);

  expect((error as Error).message).toContain('release');
  expect((error as Error).message).toMatch(/setting/i);
});

it('counts the card branch even when a tag carries the same name', async () => {
  const made = fresh();
  const bare = join(made.dir, '..', 'remote-tag.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');
  made.run('-C', at, 'push', '-q', '-u', 'origin', 'APP-1-work');
  commitIn(made, at, 'two.txt', 'two\n');
  made.run('tag', 'APP-1-work', 'main');

  const [row] = await rows(made);

  // A short name resolves against the tags first and git only warns, so the tag used to be
  // counted: the row said the card was level with the base and had nothing to push.
  expect(row?.ahead).toBe(2);
  expect(row?.unpushed).toBe(1);
});

it('counts every file in a new folder, not the folder', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  mkdirSync(join(at, 'src'), { recursive: true });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(at, 'src', name), 'x\n');

  const [row] = await rows(made);

  // git collapses a new folder into one line by default, which reported three new files as one.
  expect(row?.untracked).toBe(3);
});

it('counts against the base the caller named', async () => {
  const made = fresh();
  made.run('branch', 'release');
  const at = await card(made, 'APP-1');
  commitIn(made, at, 'one.txt', 'one\n');
  made.write('base.txt', 'on main\n');
  made.commit('main moved on');

  const [row] = await rows(made, undefined, 'release');

  expect(row?.base).toBe('release');
  expect(row?.ahead).toBe(1);
  // Against main this would be 1. Release did not move, so the card is behind nothing.
  expect(row?.behind).toBe(0);
});

it('leaves a worktree the person added somewhere else out of the list', async () => {
  const made = fresh();
  await card(made, 'APP-1');
  made.run('worktree', 'add', '-q', '-b', 'side', join(made.dir, '..', 'side-checkout'));

  expect((await rows(made)).map((row) => row.branch)).toEqual(['APP-1-work']);
});

it('leaves a worktree nested inside a card out of the list', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  made.run('worktree', 'add', '-q', '-b', 'nested', join(at, 'deeper'));

  expect((await rows(made)).map((row) => row.branch)).toEqual(['APP-1-work']);
});

it('reports a card that sits on no branch', async () => {
  const made = fresh();
  const head = made.run('rev-parse', 'HEAD').trim();
  made.run('worktree', 'add', '-q', '--detach', join(made.dir, 'worktrees', 'APP-9'), head);

  const [row] = await rows(made);

  expect(row?.branch).toBe(null);
  expect(row?.ahead).toBe(0);
  expect(row?.unpushed).toBe(null);
});

it('names a folder that is no repository, rather than blaming the base setting', async () => {
  const made = fresh();
  const plain = join(made.dir, '..', 'not-a-repo');
  mkdirSync(plain, { recursive: true });

  const error = await listWorktrees({ projectPath: plain, baseBranch: 'main', env: made.env }).catch(
    (reason: Error) => reason,
  );

  expect((error as Error).message).toMatch(/not a git repository/i);
});

it('reports a card whose commits cannot be counted, rather than showing zeros', async () => {
  const made = fresh();
  const at = await card(made, 'APP-1');
  // An orphan branch has no commit behind it yet, so git refuses the range. Reading that refusal
  // as zero told the person the card holds no work.
  made.run('-C', at, 'checkout', '-q', '--orphan', 'fresh');

  const [row] = await rows(made);

  expect(row?.stale).toBe(true);
  expect(row?.staleReason).not.toBe(null);
  expect(row?.staleReason).not.toBe('');
});
