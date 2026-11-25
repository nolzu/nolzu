import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import type { DiffEntry } from '@nolzu/protocol';
import { cardCommits, cardDiff, commitDiff, diffStat, fileTree, filePatch } from './diff.ts';

const entry = (path: string, added = 1, removed = 0, extra: Partial<DiffEntry> = {}): DiffEntry => ({
  path,
  oldPath: null,
  status: 'changed',
  added,
  removed,
  binary: false,
  ...extra,
});

it('groups two files of one folder under a single node', () => {
  const tree = fileTree([entry('src/a.ts'), entry('src/b.ts')]);

  expect(tree).toHaveLength(1);
  expect(tree[0]?.name).toBe('src');
  expect(tree[0]?.path).toBe('src');
  expect(tree[0]?.children.map((child) => child.name)).toEqual(['a.ts', 'b.ts']);
  expect(tree[0]?.entry).toBe(null);
});

it('collapses a chain of single folders into one row', () => {
  const tree = fileTree([entry('docs/deep/nested/x.md')]);

  // Four rows for one file is four clicks to reach it, so the chain reads as one.
  expect(tree).toHaveLength(1);
  expect(tree[0]?.name).toBe('docs/deep/nested');
  expect(tree[0]?.path).toBe('docs/deep/nested');
  expect(tree[0]?.children.map((child) => child.path)).toEqual(['docs/deep/nested/x.md']);
});

it('stops collapsing where the folder holds more than one thing', () => {
  const tree = fileTree([entry('src/deep/a.ts'), entry('src/b.ts')]);

  expect(tree[0]?.name).toBe('src');
  expect(tree[0]?.children.map((child) => child.name)).toEqual(['deep', 'b.ts']);
});

it('puts folders before files and sorts each by name', () => {
  const tree = fileTree([entry('z.ts'), entry('a.ts'), entry('lib/one.ts'), entry('api/two.ts')]);

  expect(tree.map((node) => node.name)).toEqual(['api', 'lib', 'a.ts', 'z.ts']);
});

it('keeps a file at the root as its own row', () => {
  const tree = fileTree([entry('README.md')]);

  expect(tree[0]?.name).toBe('README.md');
  expect(tree[0]?.children).toEqual([]);
  expect(tree[0]?.entry?.path).toBe('README.md');
});

it('carries a rename under its new path and keeps the old one on the entry', () => {
  const tree = fileTree([entry('src/new.ts', 0, 0, { status: 'renamed', oldPath: 'src/old.ts' })]);

  expect(tree[0]?.children[0]?.entry?.oldPath).toBe('src/old.ts');
});

it('adds up the stat bar from the per file numbers', () => {
  const stat = diffStat([entry('a.ts', 3, 2), entry('b.ts', 1, 4)]);

  expect(stat).toEqual({ files: 2, added: 4, removed: 6 });
});

it('counts a binary file as a file that adds nothing', () => {
  const stat = diffStat([entry('logo.png', 0, 0, { binary: true }), entry('a.ts', 2, 1)]);

  expect(stat).toEqual({ files: 2, added: 2, removed: 1 });
});

it('reports an empty diff as no files at all', () => {
  expect(diffStat([])).toEqual({ files: 0, added: 0, removed: 0 });
});

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

// A card checkout with work of every shape in it: committed and not, and a base branch that moved
// on after the card branched.
const cardRepo = (): TempRepo => {
  const made = tempRepo('nolzu-diff-');
  repo = made;
  made.write('a.txt', 'a\n');
  made.write('b.txt', 'one\n');
  made.write('dir/one.txt', 'one\n');
  made.commit('first commit');
  made.run('branch', 'card');
  made.write('z.txt', 'later on main\n');
  made.commit('main moved on');
  made.run('checkout', '-q', 'card');

  made.write('a.txt', 'a\nchanged\n');
  made.run('rm', '-q', 'dir/one.txt');
  made.run('mv', 'b.txt', 'c.txt');
  made.write('added.txt', 'new\n');
  made.write('with space.txt', 'x\n');
  made.write('ékezet.txt', 'y\n');
  writeFileSync(join(made.dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
  made.commit('card work');

  made.write('a.txt', 'a\nchanged\nagain\n');
  made.write('untracked.txt', 'not added yet\n');
  return made;
};

const diffOf = (made: TempRepo) => cardDiff({ worktreePath: made.dir, baseBranch: 'main', env: made.env });

it('reports each committed file once, with what happened to it', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  const status = new Map(diff.committed.map((entry) => [entry.path, entry.status]));
  expect(status.get('added.txt')).toBe('added');
  expect(status.get('a.txt')).toBe('changed');
  expect(status.get('dir/one.txt')).toBe('deleted');
  expect(status.get('c.txt')).toBe('renamed');
});

it('shows a rename with both paths and counts it once', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  const renamed = diff.committed.filter((entry) => entry.status === 'renamed');
  expect(renamed).toHaveLength(1);
  expect(renamed[0]?.oldPath).toBe('b.txt');
  expect(renamed[0]?.path).toBe('c.txt');
});

it('leaves out a commit the base branch got after the card branched', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  // The diff starts at the merge base, so work that is only on main is not this card's.
  expect(diff.committed.map((entry) => entry.path)).not.toContain('z.txt');
});

it('keeps the two groups apart', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  expect(diff.committed.map((entry) => entry.path)).toContain('added.txt');
  expect(diff.uncommitted.map((entry) => entry.path)).toEqual(['a.txt', 'untracked.txt']);
});

// What a push takes once the folder is committed: a file changed in both groups counts once, with
// its lines from the base to the folder.
it('reads the branch against its base with the folder in it, each file once', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  expect(diff.branch.filter((one) => one.path === 'a.txt')).toEqual([expect.objectContaining({ added: 2, removed: 0 })]);
  expect(diff.branch.map((one) => one.path)).toContain('untracked.txt');
  expect(diff.branch.map((one) => one.path)).not.toContain('z.txt');
  expect(diffStat(diff.branch)).toEqual({ files: 8, added: 6, removed: 1 });
});

it('reports an untracked file as added, with its lines counted', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  const untracked = diff.uncommitted.find((entry) => entry.path === 'untracked.txt');
  expect(untracked?.status).toBe('added');
  expect(untracked?.added).toBe(1);
  expect(untracked?.removed).toBe(0);
});

it('marks a binary file as binary and adds no lines for it', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  const binary = diff.committed.find((entry) => entry.path === 'blob.bin');
  expect(binary?.binary).toBe(true);
  expect([binary?.added, binary?.removed]).toEqual([0, 0]);
});

it('keeps a path with a space and one with an accent as they are', async () => {
  const made = cardRepo();

  const paths = (await diffOf(made)).committed.map((entry) => entry.path.normalize('NFC'));

  expect(paths).toContain('with space.txt');
  expect(paths).toContain('ékezet.txt');
});

it('adds the stat bar up from the same numbers the rows carry', async () => {
  const made = cardRepo();

  const diff = await diffOf(made);

  const stat = diffStat(diff.committed);
  expect(stat.files).toBe(diff.committed.length);
  expect(stat.added).toBe(diff.committed.reduce((sum, entry) => sum + entry.added, 0));
});

it('fetches the patch of one file only', async () => {
  const made = cardRepo();

  const patch = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'a.txt', group: 'committed', env: made.env });

  expect(patch.ok).toBe(true);
  if (!patch.ok) return;
  expect(patch.text).toContain('+changed');
  expect(patch.text).not.toContain('added.txt');
});

it('shows an untracked file content as a patch', async () => {
  const made = cardRepo();

  const patch = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'untracked.txt', group: 'uncommitted', env: made.env });

  expect(patch.ok).toBe(true);
  if (!patch.ok) return;
  expect(patch.text).toContain('+not added yet');
});

// The diff a comment is made on: the committed work and the folder's in one patch, so the new side is
// the file as it is in the folder.
it('fetches the base to the folder in one patch, and an untracked file as added', async () => {
  const made = cardRepo();

  const tracked = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'a.txt', group: 'branch', env: made.env });
  const untracked = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'untracked.txt', group: 'branch', env: made.env });

  expect(tracked).toEqual({ ok: true, text: expect.stringContaining('@@ -1 +1,3 @@\n a\n+changed\n+again\n') });
  expect(untracked.ok && untracked.text).toContain('+not added yet');
});

it('refuses a file over the cap and says so in words', async () => {
  const made = cardRepo();

  const patch = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'a.txt', group: 'committed', capBytes: 20, env: made.env });

  expect(patch.ok).toBe(false);
  if (patch.ok) return;
  expect(patch.reason).toContain('too large to show here');
});

it('shows a rename as a rename when the old path comes with it', async () => {
  const made = cardRepo();

  const patch = await filePatch({
    worktreePath: made.dir,
    baseBranch: 'main',
    path: 'c.txt',
    oldPath: 'b.txt',
    group: 'committed',
    env: made.env,
  });

  expect(patch.ok).toBe(true);
  if (!patch.ok) return;
  // Without the old path in the pathspec git sees one file added and one deleted, not a rename.
  expect(patch.text).toContain('rename from b.txt');
  expect(patch.text).toContain('rename to c.txt');
});

it('lists each committed file once, and no row for the path a rename left behind', async () => {
  const made = cardRepo();

  const paths = (await diffOf(made)).committed.map((entry) => entry.path.normalize('NFC')).sort();

  // Without rename detection the old path arrives as a second row, which double counts the work.
  expect(paths).toEqual(['a.txt', 'added.txt', 'blob.bin', 'c.txt', 'dir/one.txt', 'with space.txt', 'ékezet.txt'].sort());
});

it('marks an untracked binary file as binary and adds no lines for it', async () => {
  const made = cardRepo();
  writeFileSync(join(made.dir, 'new-blob.bin'), Buffer.from([0, 1, 2, 0, 3]));

  const blob = (await diffOf(made)).uncommitted.find((entry) => entry.path === 'new-blob.bin');

  expect(blob?.binary).toBe(true);
  expect(blob?.added).toBe(0);
});

it('sees a rename even in a repository that turned rename detection off', async () => {
  const made = cardRepo();
  // git detects renames by default, so the flag on the command line only shows its worth here. A
  // team that set this reads one changed file and one deleted file instead of one rename.
  made.run('config', 'diff.renames', 'false');

  const diff = await diffOf(made);

  const renamed = diff.committed.filter((entry) => entry.status === 'renamed');
  expect(renamed).toHaveLength(1);
  expect(renamed[0]?.oldPath).toBe('b.txt');
  expect(diff.committed.map((entry) => entry.path)).not.toContain('b.txt');
});

it('keeps staged work in the uncommitted group', async () => {
  const made = cardRepo();
  made.run('add', 'a.txt');
  made.write('staged.txt', 'staged\n');
  made.run('add', 'staged.txt');

  const diff = await diffOf(made);

  // Staged work sits in the index, so the group is read against HEAD. Read against the index it
  // would be empty, and the person would see none of the work they are about to commit.
  expect(diff.uncommitted.map((entry) => entry.path.normalize('NFC')).sort()).toEqual(['a.txt', 'staged.txt', 'untracked.txt']);
});

it('leaves an ignored file out of the uncommitted group', async () => {
  const made = cardRepo();
  // The repository's own exclude file, which is where a card's ignores live.
  made.write('.git/info/exclude', 'build/\n');
  made.write('build/out.js', 'js\n');

  const diff = await diffOf(made);

  expect(diff.uncommitted.map((entry) => entry.path)).not.toContain('build/out.js');
});

it('shows one file only when its name holds a glob character', async () => {
  const made = cardRepo();
  made.write('routes/[id]/page.svelte', 'old\n');
  made.write('routes/i/page.svelte', 'old\n');
  made.commit('two routes');
  made.write('routes/[id]/page.svelte', 'new\n');
  made.write('routes/i/page.svelte', 'new\n');
  made.commit('edit both routes');

  const patch = await filePatch({
    worktreePath: made.dir,
    baseBranch: 'main',
    path: 'routes/[id]/page.svelte',
    group: 'committed',
    env: made.env,
  });

  expect(patch.ok).toBe(true);
  if (!patch.ok) return;
  // A path is a pathspec to git, so the brackets matched the sibling and dragged its hunks in.
  expect(patch.text).not.toContain('routes/i/page.svelte');
});

it('gives an empty patch for a tracked file with nothing uncommitted', async () => {
  const made = cardRepo();

  const patch = await filePatch({
    worktreePath: made.dir,
    baseBranch: 'main',
    path: 'added.txt',
    group: 'uncommitted',
    env: made.env,
  });

  expect(patch.ok).toBe(true);
  if (!patch.ok) return;
  // An empty answer used to be read as proof the file is untracked, and the file came back whole.
  expect(patch.text).toBe('');
});

it('says the diff could not be read when git refuses the range', async () => {
  const made = cardRepo();
  const blob = made.run('rev-parse', 'main:a.txt').trim();
  rmSync(join(made.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });

  // A failed git prints nothing, and nothing reads as a card with no work in it.
  await expect(diffOf(made)).rejects.toThrow(/could not be read/);
});

it('counts from the base branch even when a tag carries the base name', async () => {
  const made = cardRepo();
  made.run('tag', 'main', 'HEAD');

  const diff = await diffOf(made);

  // git resolves a short name against the tags first, and the tag hid the whole committed diff.
  expect(diff.committed.map((entry) => entry.path)).toContain('added.txt');
});

it('reads a name git quotes as the name on disk', async () => {
  const made = cardRepo();
  made.write('qu"ote.txt', 'quoted\n');
  made.commit('a name git has to quote');
  made.write('unt"racked.txt', 'never added\n');

  const diff = await diffOf(made);
  expect(diff.committed.map((entry) => entry.path)).toContain('qu"ote.txt');
  // ls-files quotes such a name too, and a path nobody has on disk gives an empty patch.
  expect(diff.uncommitted.map((entry) => entry.path)).toContain('unt"racked.txt');

  const patch = await filePatch({
    worktreePath: made.dir,
    baseBranch: 'main',
    path: 'qu"ote.txt',
    group: 'committed',
    env: made.env,
  });

  expect(patch.ok).toBe(true);
  if (!patch.ok) return;
  expect(patch.text.length).toBeGreaterThan(0);
});

// The Not committed view of the Changes tab: everything a commit would take now, against HEAD.
it('reads every kind of work not committed: changed, staged, untracked, deleted and renamed', async () => {
  const made = tempRepo('nolzu-diff-');
  repo = made;
  made.write('keep.txt', 'keep\n');
  made.write('gone.txt', 'gone\n');
  made.write('staged-gone.txt', 'gone\n');
  made.write('old.txt', 'one\ntwo\nthree\n');
  made.write('edit.txt', 'a\n');
  made.commit('first');
  made.run('checkout', '-q', '-b', 'card');
  made.write('edit.txt', 'a\nb\n');
  rmSync(join(made.dir, 'gone.txt'));
  made.run('rm', '-q', 'staged-gone.txt');
  made.run('mv', 'old.txt', 'new.txt');
  made.write('staged.txt', 'x\n');
  made.run('add', 'staged.txt');
  made.write('loose.txt', 'y\n');

  const { uncommitted } = await diffOf(made);

  const status = Object.fromEntries(uncommitted.map((one) => [one.path, [one.status, one.oldPath]]));
  expect(status).toEqual({
    'edit.txt': ['changed', null],
    'gone.txt': ['deleted', null],
    'staged-gone.txt': ['deleted', null],
    'new.txt': ['renamed', 'old.txt'],
    'staged.txt': ['added', null],
    'loose.txt': ['added', null],
  });
  expect(uncommitted.map((one) => one.path)).not.toContain('keep.txt');
});

// A card branch of `count` commits, one file each, on top of main.
const branchOf = (count: number): TempRepo => {
  const made = tempRepo('nolzu-commits-');
  repo = made;
  made.write('a.txt', 'a\n');
  made.commit('first');
  made.run('checkout', '-q', '-b', 'card');
  for (let at = 1; at <= count; at += 1) {
    made.write(`f${at}.txt`, `${at}\n`);
    made.commit(`step ${at}`);
  }
  return made;
};

it('lists the branch commits since the base, newest first, none pushed without an upstream', async () => {
  const made = branchOf(3);

  const found = await cardCommits({ worktreePath: made.dir, baseBranch: 'main', env: made.env });

  expect(found.total).toBe(3);
  expect(found.list.map((one) => [one.subject, one.pushed])).toEqual([['step 3', false], ['step 2', false], ['step 1', false]]);
  expect(found.list[0]?.sha).toBe(made.run('rev-parse', 'HEAD').trim());
  expect(found.list[0]?.short).toBe(made.run('rev-parse', '--short', 'HEAD').trim());
});

it('marks the commits the upstream holds as pushed and the newer ones as not pushed', async () => {
  const made = branchOf(2);
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('push', '-q', '-u', 'origin', 'card');
  made.write('f3.txt', '3\n');
  made.commit('step 3');

  const found = await cardCommits({ worktreePath: made.dir, baseBranch: 'main', env: made.env });

  expect(found.list.map((one) => [one.subject, one.pushed])).toEqual([['step 3', false], ['step 2', true], ['step 1', true]]);
});

// The push dialog's change: only what the next push adds, the folder in it.
it('counts from the upstream once the branch was pushed, the folder in it', async () => {
  const made = branchOf(2);
  const bare = join(made.dir, '..', 'pushes.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('push', '-q', '-u', 'origin', 'card');
  made.write('f3.txt', '3\n');
  made.commit('step 3');
  made.write('loose.txt', 'loose\n');

  const diff = await cardDiff({ worktreePath: made.dir, baseBranch: 'main', env: made.env });

  expect(diff.pushes.map((one) => one.path).sort()).toEqual(['f3.txt', 'loose.txt']);
  expect(diff.branch).toHaveLength(4);
});

it('counts the whole branch before the first push', async () => {
  const made = branchOf(2);

  const diff = await cardDiff({ worktreePath: made.dir, baseBranch: 'main', env: made.env });

  expect(diff.pushes).toEqual(diff.branch);
});

it('caps the list and still counts every commit, so the tab can say how many are older', async () => {
  const made = branchOf(5);

  const found = await cardCommits({ worktreePath: made.dir, baseBranch: 'main', env: made.env, cap: 2 });

  expect(found.total).toBe(5);
  expect(found.list.map((one) => one.subject)).toEqual(['step 5', 'step 4']);
});

it('reads one commit against its parent, its files and a file patch, and refuses a name that is no commit id', async () => {
  const made = branchOf(2);
  const first = made.run('rev-parse', 'HEAD~1').trim();

  expect((await commitDiff({ worktreePath: made.dir, baseBranch: 'main', commit: first, env: made.env })).map((one) => [one.path, one.status])).toEqual([['f1.txt', 'added']]);
  const patch = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'f1.txt', group: 'commit', commit: first, env: made.env });
  expect(patch.ok && patch.text).toContain('+1');
  const none = await filePatch({ worktreePath: made.dir, baseBranch: 'main', path: 'f2.txt', group: 'commit', commit: first, env: made.env });
  expect(none).toEqual({ ok: true, text: '' });
  const ask = (commit: string) => commitDiff({ worktreePath: made.dir, baseBranch: 'main', commit, env: made.env });
  await expect(ask('--output=x')).rejects.toThrow('is not a commit id');
  await expect(ask('HEAD')).rejects.toThrow('is not a commit id');
  await expect(ask('0000000000')).rejects.toThrow('0000000000 is not a commit in this repository, so it has no diff to show.');
});

// The commit list only offers the card's own commits, so an id from anywhere else is refused.
it('refuses a commit that is not on the card branch past its base, and a hex branch name', async () => {
  const made = branchOf(2);
  const ask = (commit: string) => commitDiff({ worktreePath: made.dir, baseBranch: 'main', commit, env: made.env });
  const base = made.run('rev-parse', 'main').trim();
  made.run('checkout', '-q', 'main');
  made.write('z.txt', 'later\n');
  made.commit('main moved on');
  const elsewhere = made.run('rev-parse', 'HEAD').trim();
  made.run('checkout', '-q', 'card');
  const [second, first] = made.run('rev-list', '-n', '2', 'HEAD').trim().split('\n') as [string, string];

  const refused = "is not a commit of the card's branch since main, so it is not shown here.";
  await expect(ask(base)).rejects.toThrow(`${base} ${refused}`);
  await expect(ask(elsewhere)).rejects.toThrow(`${elsewhere} ${refused}`);
  // A branch named like the first commit's short id, pointing at the second commit. git prefers the
  // branch, so the id would show the wrong commit.
  made.run('branch', first.slice(0, 8), second);
  await expect(ask(first.slice(0, 8))).rejects.toThrow('also names a branch or a tag');
  expect((await ask(first)).map((one) => one.path)).toEqual(['f1.txt']);
});
