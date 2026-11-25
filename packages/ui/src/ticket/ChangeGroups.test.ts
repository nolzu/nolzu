import { readFileSync } from 'node:fs';
import type { Changes, DiffComment, WorktreeRow } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import ChangeGroups from './ChangeGroups.svelte';

// The repository switcher of the Changes tab. The facts of each repository were the worktree table's.

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const row = (repo: string, over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  repo,
  path: `/work/recipes/worktrees/APP-1/${repo}`,
  branch: 'APP-1-broken-image',
  base: 'main',
  ahead: 0,
  behind: 2,
  changed: 2,
  untracked: 1,
  unpushed: null,
  stale: false,
  staleReason: null,
  ...over,
});
const empty = { stat: { files: 0, added: 0, removed: 0 }, tree: [] };
const entry = { path: 'RecipeCard.svelte', oldPath: null, status: 'changed' as const, added: 10, removed: 2, binary: false };
const changed = (repo: string, over: Partial<WorktreeRow> = {}): Changes => ({
  ok: true,
  row: row(repo, over),
  untracked: [],
  committed: empty,
  uncommitted: empty,
  diff: { stat: { files: 1, added: 10, removed: 2 }, tree: [{ name: entry.path, path: entry.path, entry, children: [] }] },
});
const clean = (repo: string): Changes => ({ ok: true, row: row(repo, { behind: 0, changed: 0, untracked: 0 }), untracked: [], committed: empty, uncommitted: empty, diff: empty });
const publish = { ok: false as const, reason: 'This project has no remote.' };
const noop = async () => ({ ok: true as const });

const draw = (groups: { repo: string; name?: string; changes: Changes }[], comments: DiffComment[] = []) =>
  render(ChangeGroups, {
    props: {
      groups: groups.map((one) => ({ ...one, publish })),
      comments,
      onopen: async () => ({ ok: true as const, text: '' }),
      oncommit: noop,
      onwrite: async () => ({ ok: true as const, message: '' }),
      onpush: noop,
    },
  }).body;

it('shows the facts of a single repository with no switcher: branch, the work in the folder, base, ahead and behind', () => {
  const body = draw([{ repo: '.', changes: changed('.') }]);

  expect(body).not.toContain('role="tablist"');
  expect(text(body)).toContain('APP-1-broken-image 3 files not committed base main · 0 ahead · 2 behind');
});

// The page names the root by its folder, so even one repository says which one it is.
it('names the folder of a single repository in its facts', () => {
  expect(text(draw([{ repo: '.', name: 'daily-habits', changes: changed('.') }]))).toContain('daily-habits APP-1-broken-image 3 files not committed');
});

it('counts untracked files as work in the folder too, and says all committed once the folder is clean', () => {
  expect(text(draw([{ repo: '.', changes: changed('.', { changed: 0, untracked: 1 }) }]))).toContain('1 file not committed');
  expect(text(draw([{ repo: '.', changes: changed('.', { changed: 0, untracked: 0, ahead: 1 }) }]))).toContain('all committed');
});

it('says a repository with nothing changed has no changes, and names a stale checkout', () => {
  expect(text(draw([{ repo: '.', changes: clean('.') }]))).toContain('no changes base main');
  expect(text(draw([{ repo: '.', changes: changed('.', { stale: true, staleReason: 'The folder was deleted by hand.' }) }]))).toContain(
    'stale base main · 0 ahead · 2 behind The checkout is stale, so its files cannot be read. The folder was deleted by hand.',
  );
});

// The switcher prints the branch whole. A cut name hides the part that tells two branches apart.
it('prints the branch name in full and lets it wrap, never cut', () => {
  const long = 'APP-1-recipe-images-break-on-slow-networks-and-the-card-falls-back';
  const source = readFileSync(new URL('./ChangeGroups.svelte', import.meta.url), 'utf8');

  expect(text(draw([{ repo: '.', changes: clean('.') }].map((one) => ({ ...one, changes: { ...one.changes, row: row('.', { branch: long }) } as Changes }))))).toContain(long);
  expect(source).not.toMatch(/text-overflow:\s*ellipsis/);
  expect(source).toMatch(/\.head :global\(\.chip\) \{[^}]*white-space: normal/);
});

// Three repositories of a workspace, and the card changed one. It shows alone with its facts line, and
// the other two fold into one line, so a workspace of many repositories draws no wall of tiles.
it('shows only the repository the card changed, and folds the rest into one line', () => {
  const body = draw([
    { repo: '.', changes: clean('.') },
    { repo: 'web', changes: changed('web') },
    { repo: 'api', changes: { ok: false, reason: 'APP-1 does not work in api, so it has no changes there.' } },
  ]);

  expect(body).not.toContain('role="tablist"');
  expect(text(body)).toContain('web APP-1-broken-image 3 files not committed base main · 0 ahead · 2 behind');
  expect(text(body)).toContain('2 without changes');
  expect(text(body)).not.toContain('APP-1 does not work in api');
});

it("counts each repository's comments in its own diff", () => {
  const comment = (id: number, repo: string): DiffComment => ({
    id,
    repo,
    file: 'RecipeCard.svelte',
    line: 4,
    lineText: '  let failed = false;',
    text: 'Name it broken.',
    commit: 'abc1234',
    createdAt: '2026-10-15T08:00:00.000Z',
    sentAt: null,
  });
  const body = draw([{ repo: '.', changes: changed('.') }, { repo: 'web', changes: changed('web') }], [comment(1, 'web'), comment(2, 'web'), comment(3, '.')]);

  const panels = body.split('role="tabpanel"').slice(1).map(text);
  expect(panels[0]).toContain('1 comment');
  expect(panels[1]).toContain('2 comments');
});
