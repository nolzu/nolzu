import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { renameFreshBranch } from './rename.ts';

let repos: TempRepo[] = [];

afterEach(() => {
  for (const repo of repos) repo.remove();
  repos = [];
});

// A project on main with the card's checkout as a worktree on the branch the first run made.
function setUp(branch = 'APP-1-add-a-search-box') {
  const made = tempRepo('nolzu-rename-');
  repos.push(made);
  made.write('list.ts', 'export const list = [];\n');
  made.commit('first commit');
  const card = join(made.dir, '..', 'card');
  made.run('worktree', 'add', '-q', '-b', branch, card);
  return { made, card };
}

const rename = (made: TempRepo, checkouts: { path: string; base: string }[], to = 'feature/APP-1/search-box') =>
  renameFreshBranch({ checkouts, from: 'APP-1-add-a-search-box', to, env: made.env });

it('renames a branch that has no upstream and no commit beyond its base', async () => {
  const { made, card } = setUp();

  expect(await rename(made, [{ path: card, base: 'main' }])).toEqual({ renamed: true });
  expect(made.run('-C', card, 'branch', '--show-current').trim()).toBe('feature/APP-1/search-box');
  expect(made.run('branch', '--list', 'APP-1-add-a-search-box').trim()).toBe('');
});

it('keeps a branch that has a commit beyond its base', async () => {
  const { made, card } = setUp();
  made.write('../card/search.ts', 'export const search = true;\n');
  made.run('-C', card, 'add', '-A');
  made.run('-C', card, 'commit', '-q', '-m', 'work');

  const result = await rename(made, [{ path: card, base: 'main' }]);

  expect(result.renamed).toBe(false);
  expect(made.run('-C', card, 'branch', '--show-current').trim()).toBe('APP-1-add-a-search-box');
});

it('never renames a pushed branch', async () => {
  const { made, card } = setUp();
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('-C', card, 'push', '-q', '-u', 'origin', 'APP-1-add-a-search-box');

  const result = await rename(made, [{ path: card, base: 'main' }]);

  expect(result.renamed).toBe(false);
  expect(made.run('-C', card, 'branch', '--show-current').trim()).toBe('APP-1-add-a-search-box');
});

it('never renames a branch a remote holds, even with no upstream set', async () => {
  const { made, card } = setUp();
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('-C', card, 'push', '-q', 'origin', 'APP-1-add-a-search-box');

  expect((await rename(made, [{ path: card, base: 'main' }])).renamed).toBe(false);
});

it('never renames a branch that has an upstream, even one no remote copy backs', async () => {
  const { made, card } = setUp();
  // The upstream is the local main, so refs/remotes holds nothing: only the upstream check can see it.
  made.run('-C', card, 'branch', '--set-upstream-to=main', 'APP-1-add-a-search-box');

  const result = await rename(made, [{ path: card, base: 'main' }]);

  expect(result.renamed).toBe(false);
  expect(made.run('-C', card, 'branch', '--show-current').trim()).toBe('APP-1-add-a-search-box');
});

it('changes nothing when the name is already the one wanted', async () => {
  const { made, card } = setUp();

  expect(await rename(made, [{ path: card, base: 'main' }], 'APP-1-add-a-search-box')).toEqual({ renamed: false, reason: null });
});

it('renames in every repository of a workspace card, or in none', async () => {
  const one = setUp();
  const two = setUp();
  const checkouts = [
    { path: one.card, base: 'main' },
    { path: two.card, base: 'main' },
  ];

  expect(await rename(one.made, checkouts)).toEqual({ renamed: true });
  expect(one.made.run('-C', one.card, 'branch', '--show-current').trim()).toBe('feature/APP-1/search-box');
  expect(two.made.run('-C', two.card, 'branch', '--show-current').trim()).toBe('feature/APP-1/search-box');

  // A commit in one of the two keeps both on the old name.
  const three = setUp();
  const four = setUp();
  four.made.write('../card/search.ts', 'export const search = true;\n');
  four.made.run('-C', four.card, 'add', '-A');
  four.made.run('-C', four.card, 'commit', '-q', '-m', 'work');
  const result = await rename(three.made, [
    { path: three.card, base: 'main' },
    { path: four.card, base: 'main' },
  ]);

  expect(result.renamed).toBe(false);
  expect(three.made.run('-C', three.card, 'branch', '--show-current').trim()).toBe('APP-1-add-a-search-box');
});

it('puts the first repository back when git refuses the second', async () => {
  const one = setUp();
  const two = setUp();
  // A branch named feature leaves no room for feature/APP-1/search-box, and only `git branch -m` finds out.
  two.made.run('branch', 'feature');

  const result = await rename(one.made, [
    { path: one.card, base: 'main' },
    { path: two.card, base: 'main' },
  ]);

  expect(result.renamed).toBe(false);
  expect(one.made.run('-C', one.card, 'branch', '--show-current').trim()).toBe('APP-1-add-a-search-box');
  expect(two.made.run('-C', two.card, 'branch', '--show-current').trim()).toBe('APP-1-add-a-search-box');
});

it('renames a branch with commits of its own when the person picked the name, and never a pushed one', async () => {
  const { made, card } = setUp();
  made.write('../card/search.ts', 'export const search = true;\n');
  made.run('-C', card, 'add', '-A');
  made.run('-C', card, 'commit', '-q', '-m', 'work');
  const checkouts = [{ path: card, base: 'main' }];

  expect(await renameFreshBranch({ checkouts, from: 'APP-1-add-a-search-box', to: 'APP-1-search', env: made.env, byPerson: true })).toEqual({ renamed: true });
  expect(made.run('-C', card, 'branch', '--show-current').trim()).toBe('APP-1-search');

  made.run('-C', card, 'branch', '--set-upstream-to=main', 'APP-1-search');
  const result = await renameFreshBranch({ checkouts, from: 'APP-1-search', to: 'APP-1-other', env: made.env, byPerson: true });
  expect(result).toEqual({ renamed: false, reason: 'APP-1-search has an upstream, so it keeps its name.' });
});
