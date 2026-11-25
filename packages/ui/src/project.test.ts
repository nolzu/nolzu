import type { ProjectScan } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { projectView } from './project.ts';

const one: ProjectScan = {
  ok: true,
  repos: [{ path: '.', base: { kind: 'branch', name: 'main' }, remotes: [{ supported: true, name: 'origin', host: 'github', owner: 'example', repo: 'recipes' }] }],
  branchPreview: { ok: true, name: 'PROJ-123-example-card' },
};

it('shows one row with its base branch for one repository', () => {
  const view = projectView(one);

  expect(view.rows).toEqual([{ path: 'This folder', base: 'main', remotes: 'origin: github, example/recipes' }]);
  expect(view.canSave).toBe(true);
});

it('lists every repository of a folder that holds several', () => {
  const view = projectView({ ...one, repos: [{ ...one.repos[0]!, path: 'api' }, { ...one.repos[0]!, path: 'web', remotes: [] }] } as ProjectScan);

  expect(view.rows.map((row) => row.path)).toEqual(['api', 'web']);
  expect(view.rows[1]?.remotes).toBe('no remote');
});

it('says a detached or an empty repository has no branch to start from', () => {
  const detached = projectView({ ...one, repos: [{ ...one.repos[0]!, base: { kind: 'detached', commit: 'a1b2c3d' } }] } as ProjectScan);
  const unborn = projectView({ ...one, repos: [{ ...one.repos[0]!, base: { kind: 'unborn', name: 'main' } }] } as ProjectScan);

  expect(detached.rows[0]?.base).toBe('a detached commit, a1b2c3d');
  expect(unborn.rows[0]?.base).toBe('main, with no commit yet');
});

it('names a remote on a host it does not know by its address', () => {
  const view = projectView({ ...one, repos: [{ ...one.repos[0]!, remotes: [{ supported: false, name: 'origin', url: 'https://git.example.invalid/recipes.git' }] }] } as ProjectScan);

  expect(view.rows[0]?.remotes).toBe('origin: https://git.example.invalid/recipes.git, not supported yet');
});

it('refuses a folder with no repository, with the reason, and cannot be saved', () => {
  expect(projectView({ ok: false, reason: 'There is no repository here.' })).toEqual({ rows: [], refusal: 'There is no repository here.', preview: null, canSave: false });
});

it('shows the branch name a card gets, or why git would refuse the template', () => {
  expect(projectView(one).preview).toEqual({ ok: true, text: 'PROJ-123-example-card' });
  const bad = projectView({ ...one, branchPreview: { ok: false, reason: 'The branch template names {nope}.' } } as ProjectScan);

  expect(bad.preview).toEqual({ ok: false, text: 'The branch template names {nope}.' });
  expect(bad.canSave).toBe(false);
});
