import { expect, it } from 'vitest';
import { cloneProgress, ignoredPaths, parseNameStatus, parseNumstat, parseStatus, parseWorktrees, somePaths, splitRename, unquotePath } from './porcelain.ts';

// Every fixture below is real output from git 2.54.0, with the machine's own paths replaced
// by neutral ones. Writing these from memory is how a parser ends up agreeing with nobody.

const statusWithUpstream = `# branch.oid b162dd62e48794fe88d6a401ef84cbe03f0ac041
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 .M N... 100644 100644 100644 a9f5e5377f184d83e17f3420bfdc0ee33d2068d9 a9f5e5377f184d83e17f3420bfdc0ee33d2068d9 src/renamed.ts
? src/untracked.ts
`;

// A branch with no upstream carries no branch.ab line at all, which is why ahead and behind
// come from rev-list against the base branch and not from status.
const statusNoUpstream = `# branch.oid f724b1de56c773e47024228a3063fb36d4321987
# branch.head feature/demo
1 .M N... 100644 100644 100644 a9f5e537 a9f5e537 src/a.ts
1 .M N... 100644 100644 100644 b1c2d3e4 b1c2d3e4 src/name with space.txt
? src/untracked.ts
`;

const statusClean = `# branch.oid f724b1de56c773e47024228a3063fb36d4321987
# branch.head main
`;

const statusDetached = `# branch.oid f724b1de56c773e47024228a3063fb36d4321987
# branch.head (detached)
`;

it('reads the branch, the upstream and the ahead and behind counts', () => {
  expect(parseStatus(statusWithUpstream)).toEqual({
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    changed: 1,
    untracked: 1,
    dirty: true,
  });
});

it('reports no upstream and zero counts when the branch has none', () => {
  const status = parseStatus(statusNoUpstream);
  expect(status.branch).toBe('feature/demo');
  expect(status.upstream).toBeNull();
  expect([status.ahead, status.behind]).toEqual([0, 0]);
  // Changed and untracked are counted apart, so the UI can say "2 changed, 1 untracked".
  expect([status.changed, status.untracked]).toEqual([2, 1]);
});

it('reports a clean tree as not dirty', () => {
  expect(parseStatus(statusClean)).toEqual({
    branch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0,
    dirty: false,
  });
});

it('reads a detached head as no branch rather than as a branch named detached', () => {
  expect(parseStatus(statusDetached).branch).toBeNull();
});

const worktrees = `worktree /tmp/demo/repo
HEAD f724b1de56c773e47024228a3063fb36d4321987
branch refs/heads/main

worktree /tmp/demo/worktrees/APP-1
HEAD f724b1de56c773e47024228a3063fb36d4321987
branch refs/heads/APP-1-add-search

worktree /tmp/demo/worktrees/APP-9
HEAD b162dd62e48794fe88d6a401ef84cbe03f0ac041
branch refs/heads/APP-9-gone
prunable gitdir file points to non-existent location

worktree /tmp/demo/worktrees/APP-7
HEAD b162dd62e48794fe88d6a401ef84cbe03f0ac041
detached

`;

it('reads every worktree with its branch, and shortens the ref', () => {
  const list = parseWorktrees(worktrees);
  expect(list).toHaveLength(4);
  expect(list[0]).toEqual({ path: '/tmp/demo/repo', head: 'f724b1de56c773e47024228a3063fb36d4321987', branch: 'main', prunable: null, locked: null });
  expect(list[1]?.branch).toBe('APP-1-add-search');
});

it('reports a prunable worktree as stale with the reason git gave', () => {
  const stale = parseWorktrees(worktrees).find((entry) => entry.path.endsWith('APP-9'));
  expect(stale?.prunable).toBe('gitdir file points to non-existent location');
});

it('reads a detached worktree as having no branch', () => {
  const detached = parseWorktrees(worktrees).find((entry) => entry.path.endsWith('APP-7'));
  expect(detached?.branch).toBeNull();
  expect(detached?.prunable).toBeNull();
});

// Tabs separate the three columns. A binary file carries a dash for both counts, and a rename
// arrives as one row with a brace, not as two rows.
const numstat = `-\t-\tlogo.png
1\t0\tsrc/name with space.txt
0\t0\tsrc/{old-name.ts => new-name.ts}
1\t0\tsrc/ékezet.txt
3\t2\tsrc/plain.ts
`;

it('reads a binary file as binary with no line counts', () => {
  const binary = parseNumstat(numstat).find((entry) => entry.path === 'logo.png');
  expect(binary).toEqual({ path: 'logo.png', oldPath: null, added: 0, removed: 0, binary: true });
});

it('keeps a path with a space and one with an accent, because quotepath is off', () => {
  const paths = parseNumstat(numstat).map((entry) => entry.path);
  expect(paths).toContain('src/name with space.txt');
  expect(paths).toContain('src/ékezet.txt');
});

it('reads a rename as one entry that carries both paths', () => {
  const renamed = parseNumstat(numstat).find((entry) => entry.oldPath !== null);
  expect(renamed).toEqual({ path: 'src/new-name.ts', oldPath: 'src/old-name.ts', added: 0, removed: 0, binary: false });
  // One row in, one row out, so the stat bar cannot count a rename twice.
  expect(parseNumstat(numstat)).toHaveLength(5);
});

it('reads a plain change with its counts', () => {
  expect(parseNumstat(numstat).find((entry) => entry.path === 'src/plain.ts')).toEqual({
    path: 'src/plain.ts',
    oldPath: null,
    added: 3,
    removed: 2,
    binary: false,
  });
});

it('reads every shape of rename spec git can print', () => {
  expect(splitRename('src/{old.ts => new.ts}')).toEqual(['src/old.ts', 'src/new.ts']);
  expect(splitRename('{src => lib}/file.ts')).toEqual(['src/file.ts', 'lib/file.ts']);
  expect(splitRename('old.ts => new.ts')).toEqual(['old.ts', 'new.ts']);
  expect(splitRename('src/plain.ts')).toEqual(['src/plain.ts', null]);
  // A file whose name holds the arrow is not a rename, so the braces are what decide it.
  expect(splitRename('src/a=>b.ts')).toEqual(['src/a=>b.ts', null]);
});

it('ignores a trailing empty line rather than reading it as a file', () => {
  expect(parseNumstat('')).toEqual([]);
  expect(parseWorktrees('')).toEqual([]);
});

// Real output from git 2.54.0. name-status prints the two paths of a rename in two columns and
// never in braces, which is the shape numstat uses, so the two are parsed apart.
const nameStatus = `M\ta.txt
A\tsrc/added.ts
D\tdir/one.txt
R100\tb.txt\tc.txt
R075\tsrc/old.ts\tsrc/new name.ts
C100\tsrc/a.ts\tsrc/copy.ts
T\tsrc/link.ts
`;

it('reads each status letter as the word the UI shows', () => {
  const byPath = new Map(parseNameStatus(nameStatus).map((entry) => [entry.path, entry.status]));
  expect(byPath.get('a.txt')).toBe('changed');
  expect(byPath.get('src/added.ts')).toBe('added');
  expect(byPath.get('dir/one.txt')).toBe('deleted');
  expect(byPath.get('c.txt')).toBe('renamed');
});

it('reads a rename as the new path with the old one beside it', () => {
  const renamed = parseNameStatus(nameStatus).find((entry) => entry.path === 'src/new name.ts');
  expect(renamed).toEqual({ path: 'src/new name.ts', oldPath: 'src/old.ts', status: 'renamed' });
});

it('reads a copy as an added file, because a copy is a file that was not there before', () => {
  const copied = parseNameStatus(nameStatus).find((entry) => entry.path === 'src/copy.ts');
  expect(copied).toEqual({ path: 'src/copy.ts', oldPath: 'src/a.ts', status: 'added' });
});

it('reads a type change as a change, and counts one row per file', () => {
  expect(parseNameStatus(nameStatus).find((entry) => entry.path === 'src/link.ts')?.status).toBe('changed');
  expect(parseNameStatus(nameStatus)).toHaveLength(7);
});

it('reads no file out of an empty name-status answer', () => {
  expect(parseNameStatus('')).toEqual([]);
});

// core.quotepath=false only stops the escaping of bytes above 0x80. A quote, a backslash, a tab or
// a control character still arrives wrapped and escaped, so the name has to be put back together
// or the tab shows a name nobody has on disk.
it('undoes the quoting git puts around an awkward name', () => {
  expect(unquotePath('"qu\\"ote.txt"')).toBe('qu"ote.txt');
  expect(unquotePath('"back\\\\slash.txt"')).toBe('back\\slash.txt');
  expect(unquotePath('"two\\nlines.txt"')).toBe('two\nlines.txt');
  expect(unquotePath('"tab\\there.txt"')).toBe('tab\there.txt');
  // An octal escape is how git writes a byte it has no letter for.
  expect(unquotePath('"ctl\\001.txt"')).toBe(`ctl${String.fromCharCode(1)}.txt`);
});

it('leaves a plain path exactly as it is', () => {
  expect(unquotePath('src/plain.ts')).toBe('src/plain.ts');
  expect(unquotePath('src/ékezet.txt')).toBe('src/ékezet.txt');
});

it('reads a quoted path out of numstat as the name on disk', () => {
  expect(parseNumstat('1\t0\t"qu\\"ote.txt"\n')[0]?.path).toBe('qu"ote.txt');
});

it('reads both sides of a rename whose names are quoted', () => {
  const renamed = parseNumstat('0\t0\t"dir/qu\\"ote.txt" => "dir/moved.txt"\n')[0];

  expect(renamed?.oldPath).toBe('dir/qu"ote.txt');
  expect(renamed?.path).toBe('dir/moved.txt');
});

it('reads a quoted path out of name-status', () => {
  expect(parseNameStatus('A\t"qu\\"ote.txt"\n')[0]?.path).toBe('qu"ote.txt');
});

// What `git clone --progress` wrote to stderr for a file URL, byte for byte. Each update ends in a
// carriage return, so a terminal draws it over the last one, and a finished step ends in a newline.
const CLONE_STDERR =
  "Cloning into 'c1'...\nremote: Enumerating objects: 9, done.        \nremote: Counting objects:  11% (1/9)        \rremote: Counting objects: 100% (9/9), done.        \nremote: Compressing objects:  20% (1/5)        \rremote: Compressing objects: 100% (5/5), done.        \nremote: Total 9 (delta 1), reused 0 (delta 0), pack-reused 0 (from 0)        \nReceiving objects:  11% (1/9)\rReceiving objects:  44% (4/9)\rReceiving objects: 100% (9/9)\rReceiving objects: 100% (9/9), done.\nResolving deltas:   0% (0/1)\rResolving deltas: 100% (1/1)\rResolving deltas: 100% (1/1), done.\n";
const upTo = (text: string) => CLONE_STDERR.slice(0, CLONE_STDERR.indexOf(text) + text.length);

it('reads no progress before git printed a step', () => {
  expect(cloneProgress("Cloning into 'c1'...\n")).toBeNull();
  expect(cloneProgress('')).toBeNull();
});

it("names the remote's own steps, with nothing received yet", () => {
  expect(cloneProgress(upTo('Counting objects:  11% (1/9)        \r'))).toEqual({ step: 'Counting objects', percent: 0 });
});

it('reads the share received from the last whole line', () => {
  expect(cloneProgress(upTo('Receiving objects:  44% (4/9)\r'))).toEqual({ step: 'Receiving objects', percent: 44 });
});

// A chunk can end inside a line. Read early, "Receiving objects:  1" would say 1 percent.
it('leaves half a line for the next chunk', () => {
  expect(cloneProgress(`${upTo('Receiving objects:  44% (4/9)\r')}Receiving objects:  1`)).toEqual({ step: 'Receiving objects', percent: 44 });
});

it('keeps the share received once git resolves what came', () => {
  expect(cloneProgress(upTo('Resolving deltas:   0% (0/1)\r'))).toEqual({ step: 'Resolving deltas', percent: 100 });
  expect(cloneProgress(CLONE_STDERR)).toEqual({ step: 'Resolving deltas', percent: 100 });
});

// Remove its checkouts refuses on an ignored file a person may have written. What a tool writes again
// after a normal run, on the common stacks, does not count, so a quiet week of runs can be cleaned up.
it('leaves out what tools make again, and keeps every name that can hold a person\'s own files', () => {
  const remade = ['next-env.d.ts', '.astro/', '.angular/', '.react-router/', '.output/', '.expo/', '.nx/', '.vercel/', 'test-results/', 'playwright-report/', 'npm-debug.log', 'pkg/recipes.egg-info/', 'htmlcov/', '.phpunit.result.cache', '_build/', '.dart_tool/', 'ios/Pods/', 'DerivedData/'];
  const kept = ['.env', 'bin/', 'obj/', 'vendor/', 'deps/', 'log/', 'tmp/', '.vscode/', '.idea/', '.wrangler/', 'local.properties', '.egg-info/'];
  const porcelain = [...remade, ...kept].map((path) => `!! ${path}`).join('\0');

  expect(ignoredPaths(porcelain).named).toEqual(kept);
});

it('names up to eight paths and says how many more', () => {
  const paths = Array.from({ length: 11 }, (_, at) => `f${at}`);
  expect(somePaths(paths)).toBe('f0, f1, f2, f3, f4, f5, f6, f7, and 3 more');
  expect(somePaths(paths.slice(0, 8))).toBe('f0, f1, f2, f3, f4, f5, f6, f7');
  expect(somePaths(['.env'])).toBe('.env');
});
