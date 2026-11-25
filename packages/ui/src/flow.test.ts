import type { ProjectScan } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { flowView } from './flow.ts';

const scan = (remotes: unknown[]): ProjectScan => ({ ok: true, repos: [{ path: '.', base: { kind: 'branch', name: 'main' }, remotes }], branchPreview: { ok: true, name: 'x' } }) as ProjectScan;

it('names a GitHub remote', () => {
  expect(flowView(scan([{ supported: true, name: 'origin', host: 'github', owner: 'example', repo: 'recipes' }])).hosts).toEqual([
    { id: '.:origin', remote: 'origin', text: 'GitHub, example/recipes', supported: true },
  ]);
});

it('says a GitLab remote is not supported yet, and names it', () => {
  expect(flowView(scan([{ supported: true, name: 'origin', host: 'gitlab', owner: 'example', repo: 'recipes' }])).hosts[0]).toEqual({
    id: '.:origin',
    remote: 'origin',
    text: 'GitLab, example/recipes: not supported yet',
    supported: false,
  });
});

it('shows the address of a host it does not know', () => {
  expect(flowView(scan([{ supported: false, name: 'origin', url: 'https://git.example.invalid/recipes.git' }])).hosts[0]?.text).toBe(
    'https://git.example.invalid/recipes.git: not supported yet',
  );
});

it('says pull requests need a remote when there is none', () => {
  const view = flowView(scan([]));

  expect(view.noRemote).toBe(true);
  expect(view.note).toMatch(/pull requests need/i);
  expect(view.note).not.toMatch(/merge/i);
});

it('says no project is set yet, rather than that it has no remote', () => {
  expect(flowView(null)).toMatchObject({ hosts: [], noRemote: true, note: expect.stringMatching(/No project is set yet/) });
});

// A folder that was renamed after onboarding must not read as a project without a remote.
it('says why the folder could not be read, when the scan failed', () => {
  expect(flowView({ ok: false, reason: 'The folder /work/recipes is not there.' }).note).toBe('The folder /work/recipes is not there.');
});

it('gathers the remotes of every repository the scan found', () => {
  const two = {
    ok: true,
    repos: [
      { path: 'web', base: { kind: 'branch', name: 'main' }, remotes: [{ supported: true, name: 'origin', host: 'github', owner: 'example', repo: 'web' }] },
      { path: 'api', base: { kind: 'branch', name: 'main' }, remotes: [{ supported: true, name: 'upstream', host: 'github', owner: 'example', repo: 'api' }] },
    ],
    branchPreview: { ok: true, name: 'x' },
  } as ProjectScan;

  expect(flowView(two).hosts.map((host) => host.id)).toEqual(['web:origin', 'api:upstream']);
});

// Two repositories often both have an origin, so the row says whose it is.
it('names the repository of a remote, except for the project folder', () => {
  const two = {
    ok: true,
    repos: [
      { path: '.', base: { kind: 'branch', name: 'main' }, remotes: [{ supported: true, name: 'origin', host: 'github', owner: 'example', repo: 'recipes' }] },
      { path: 'api', base: { kind: 'branch', name: 'main' }, remotes: [{ supported: true, name: 'origin', host: 'github', owner: 'example', repo: 'api' }] },
    ],
    branchPreview: { ok: true, name: 'x' },
  } as ProjectScan;

  expect(flowView(two).hosts.map((host) => host.repo)).toEqual([undefined, 'api']);
});
