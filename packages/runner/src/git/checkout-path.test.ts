import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkoutPath, checkoutRoot, worktreesFolder } from './worktree.ts';

const project = join('/work', 'recipes');

// A single repository card must keep the exact path it had before the helper existed.
it('puts the root repository at the card root', () => {
  expect(checkoutPath(project, 'APP-1')).toBe(join(project, 'worktrees', 'APP-1'));
  expect(checkoutPath(project, 'APP-1', '.')).toBe(checkoutRoot(project, 'APP-1'));
  expect(checkoutRoot(project, 'APP-1')).toBe(join(project, 'worktrees', 'APP-1'));
});

it('puts a child repository in its own folder inside the card root', () => {
  expect(checkoutPath(project, 'APP-1', 'api')).toBe(join(project, 'worktrees', 'APP-1', 'api'));
});

it('names the folder that holds every card checkout', () => {
  expect(worktreesFolder(project)).toBe(join(project, 'worktrees'));
});

it.each(['..', 'a/b', 'a\\b', '', '/etc', 'line\nbreak', '.git', '.Git'])('refuses the repository name %j', (repo) => {
  expect(() => checkoutPath(project, 'APP-1', repo)).toThrow(/repository/);
});
