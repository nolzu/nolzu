import type { Changes, DiffEntry, WorktreeRow } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import ChangesTab from './ChangesTab.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const row: WorktreeRow = {
  repo: '.',
  path: '/work/recipes/worktrees/APP-1',
  branch: 'feat/APP-1',
  base: 'main',
  ahead: 1,
  behind: 0,
  changed: 1,
  untracked: 1,
  unpushed: null,
  stale: false,
  staleReason: null,
};

const entry = (path: string, status: DiffEntry['status'], added: number, removed: number): DiffEntry => ({ path, oldPath: null, status, added, removed, binary: false });
const search = entry('src/recipes/search.ts', 'added', 2, 0);
const list = entry('src/recipes/list.ts', 'changed', 1, 1);

const changes: Changes = {
  ok: true,
  row,
  untracked: [],
  committed: {
    stat: { files: 1, added: 2, removed: 0 },
    tree: [{ name: 'src/recipes', path: 'src/recipes', entry: null, children: [{ name: 'search.ts', path: search.path, entry: search, children: [] }] }],
  },
  uncommitted: {
    stat: { files: 1, added: 1, removed: 1 },
    tree: [{ name: 'src/recipes', path: 'src/recipes', entry: null, children: [{ name: 'list.ts', path: list.path, entry: list, children: [] }] }],
  },
  // The one diff the tab draws: the base to the folder.
  diff: {
    stat: { files: 2, added: 3, removed: 1 },
    tree: [
      {
        name: 'src/recipes',
        path: 'src/recipes',
        entry: null,
        children: [
          { name: 'list.ts', path: list.path, entry: list, children: [] },
          { name: 'search.ts', path: search.path, entry: search, children: [] },
        ],
      },
    ],
  },
};

const draw = (props: Changes) => render(ChangesTab, { props: { changes: props } }).body;

// The worktree row moved to the repository switcher, which ChangeGroups.test.ts covers.

it('heads the diff with its files, lines added and removed', () => {
  expect(text(draw(changes))).toContain('2 files +3 -1');
});

it('lists the files under their folder with their counts, and says new for a file the card added', () => {
  const shown = text(draw(changes));

  expect(shown).toContain('src/recipes/');
  expect(shown).toContain('list.ts +1 -1');
  expect(shown).toContain('search.ts +2 new');
});

it('says so when nothing changed against the base', () => {
  const empty = { stat: { files: 0, added: 0, removed: 0 }, tree: [] };
  expect(text(draw({ ...changes, diff: empty }))).toContain('No change against main yet.');
});

it('draws no files and lines bar when nothing changed', () => {
  const empty = { stat: { files: 0, added: 0, removed: 0 }, tree: [] };
  const body = draw({ ...changes, diff: empty });

  expect(text(body)).not.toContain('0 files');
  expect(body).not.toContain('class="dhead');
});

it('keeps the comment chip but not the files and lines bar when only comments are left', () => {
  const empty = { stat: { files: 0, added: 0, removed: 0 }, tree: [] };
  const comment = { id: 1, repo: '.', file: 'gone.ts', line: 1, lineText: 'x', text: 'why', commit: 'abc', createdAt: '2026-10-21', sentAt: null };
  const shown = text(render(ChangesTab, { props: { changes: { ...changes, diff: empty }, comments: [comment] } }).body);

  expect(shown).toContain('1 comment');
  expect(shown).not.toContain('0 files');
});

it('marks a binary file instead of counting its lines', () => {
  const picture = { ...entry('assets/hero.png', 'added', 0, 0), binary: true };
  const body = draw({ ...changes, diff: { stat: { files: 1, added: 0, removed: 0 }, tree: [{ name: 'assets', path: 'assets', entry: null, children: [{ name: 'hero.png', path: picture.path, entry: picture, children: [] }] }] } });

  expect(text(body)).toContain('hero.png binary');
});

it('shows the reason when there is nothing to read', () => {
  expect(text(draw({ ok: false, reason: 'APP-1 has no checkout. A run makes one. A closed card has none once its checkouts are removed.' }))).toBe('APP-1 has no checkout. A run makes one. A closed card has none once its checkouts are removed.');
});

it('names a stale worktree and why', () => {
  const shown = text(draw({ ...changes, row: { ...row, stale: true, staleReason: 'The folder was deleted by hand.' } }));

  expect(shown).toContain('stale');
  expect(shown).toContain('The folder was deleted by hand.');
});

it('shows where a renamed file came from as text, not only in a tooltip', () => {
  const moved = { ...entry('src/recipes/find.ts', 'renamed', 0, 0), oldPath: 'src/recipes/search.ts' };
  const body = draw({ ...changes, diff: { stat: { files: 1, added: 0, removed: 0 }, tree: [{ name: 'find.ts', path: moved.path, entry: moved, children: [] }] } });

  expect(text(body)).toContain('find.ts from src/recipes/search.ts');
});

it('shows only why a stale checkout cannot be read, and no diff', () => {
  const shown = text(draw({ ok: true, row: { ...row, stale: true, staleReason: 'git cannot read it.' }, untracked: [], committed: null, uncommitted: null }));

  expect(shown).toBe('The checkout is stale, so its files cannot be read. git cannot read it.');
});

// A pull into the checkout that stopped on a conflict: the tab says so, names each file in mono, and
// says what to do, in the card's own checkout.
it('says the checkout stopped on a conflict, names the files and says what to do', () => {
  const body = draw({ ...changes, conflicted: ['src/recipes/list.ts', 'README.md'] });

  expect(text(body)).toContain(
    'The checkout has a conflict in 2 files. The merge stopped, and nothing was pushed. src/recipes/list.ts README.md Fix each file in /work/recipes/worktrees/APP-1 , mark it resolved with git add, then commit here and push again.',
  );
  expect(body).toContain('<li class="mono');
  expect(body).toContain('data-conflict');
});

it('draws no conflict box for a checkout with none', () => {
  expect(draw(changes)).not.toContain('data-conflict');
  expect(draw({ ...changes, conflicted: [] })).not.toContain('data-conflict');
});

// Once the branch has a commit, the one diff holds both, so each file with work in the folder says so.
it('marks the files not committed yet once the branch has a commit, and none before', () => {
  expect(text(draw(changes))).toContain('list.ts +1 -1 not committed');
  expect(text(draw(changes))).not.toContain('search.ts +2 new not committed');
  expect(text(draw({ ...changes, committed: null }))).not.toContain('not committed');
});
