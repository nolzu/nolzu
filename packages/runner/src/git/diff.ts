import type { BranchCommits, DiffEntry, DiffStat, FileTreeNode } from '@nolzu/protocol';
import { baseCommit } from './base.ts';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';
import { parseNameStatus, parseNumstat, unquotePath, type GitDiffEntry, type NameStatusEntry } from './porcelain.ts';

interface Folder {
  dirs: Map<string, Folder>;
  files: Map<string, DiffEntry>;
}

const empty = (): Folder => ({ dirs: new Map(), files: new Map() });

const byName = (one: FileTreeNode, other: FileTreeNode): number => one.name.localeCompare(other.name);

const nodesOf = (folder: Folder, prefix: string): FileTreeNode[] => {
  const folders: FileTreeNode[] = [];

  for (const [name, child] of folder.dirs) {
    let label = name;
    let path = prefix === '' ? name : `${prefix}/${name}`;
    let at = child;
    // A folder holding one folder and nothing else is one row. Four rows to reach one file is four
    // clicks, and the folders in between say nothing the path does not.
    while (at.dirs.size === 1 && at.files.size === 0) {
      const only = [...at.dirs.entries()][0];
      if (only === undefined) break;
      const [childName, grandchild] = only;
      label = `${label}/${childName}`;
      path = `${path}/${childName}`;
      at = grandchild;
    }
    folders.push({ name: label, path, children: nodesOf(at, path), entry: null });
  }

  const files = [...folder.files].map(([name, entry]) => ({ name, path: entry.path, children: [], entry }));
  return [...folders.sort(byName), ...files.sort(byName)];
};

// The diff as a tree the tab can render. Folders come before files and both are sorted by name, so
// the same diff reads the same way twice.
export function fileTree(entries: readonly DiffEntry[]): FileTreeNode[] {
  const root = empty();

  for (const entry of entries) {
    const parts = entry.path.split('/');
    const name = parts.pop() ?? entry.path;
    let at = root;
    for (const part of parts) {
      let next = at.dirs.get(part);
      if (next === undefined) {
        next = empty();
        at.dirs.set(part, next);
      }
      at = next;
    }
    // Keyed by name, so a file listed twice is one row and not two.
    at.files.set(name, entry);
  }

  return nodesOf(root, '');
}

// The stat bar. A rename is one file, and a binary file counts as a file that adds no lines,
// because git reports no line counts for one.
export function diffStat(entries: readonly DiffEntry[]): DiffStat {
  return {
    files: entries.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0),
    removed: entries.reduce((sum, entry) => sum + entry.removed, 0),
  };
}

export interface CardDiffOptions {
  // The card's own checkout. Everything is asked inside it, so the answer is this card's work.
  worktreePath: string;
  baseBranch: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CardDiff {
  committed: DiffEntry[];
  uncommitted: DiffEntry[];
  // The base to the folder, untracked files in: what a push takes once the folder is committed.
  branch: DiffEntry[];
  // The same from where the upstream and the branch part, so a branch pushed before counts only what
  // the next push adds. The branch above when nothing is pushed yet.
  pushes: DiffEntry[];
}

export interface FilePatchOptions extends CardDiffOptions {
  path: string;
  // The path before a rename. Git needs both to see a rename at all when a pathspec narrows the
  // diff, and shows one file added and one deleted without it.
  oldPath?: string;
  // `branch` is the base to the folder in one patch, the diff a comment is made on, so its new side is
  // the file as it is in the folder now. `commit` is one commit against its parent, named by `commit`.
  group: 'committed' | 'uncommitted' | 'branch' | 'commit';
  commit?: string;
  capBytes?: number;
}

export type FilePatch = { ok: true; text: string } | { ok: false; reason: string };

// A quarter of a megabyte of patch is already more than anyone reads. The file list still shows the
// row and its counts, so nothing disappears, it is only not rendered.
export const PATCH_CAP_BYTES = 256 * 1024;

type Run = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

// git's exit code, checked wherever its output feeds a parser. A failed git prints nothing, and an
// empty answer reads as a card with no changes, which is the one reading that loses work.
const out = async (run: Run, args: readonly string[], found = 0): Promise<string> => {
  const result = await run(args);
  if (result.code !== 0 && result.code !== found) {
    throw new Error(`The card's diff could not be read. ${result.stderr.trim()}`);
  }
  return result.stdout;
};

const runner = (options: CardDiffOptions, maxStdout?: number): Run => {
  // Built here rather than passed through, so a stray GIT_DIR cannot point the diff at another
  // repository.
  const env = gitEnv(options.env ?? process.env);
  return (args) => git(args, { cwd: options.worktreePath, env, signal: options.signal, maxStdout });
};

// Where this card's work starts. The merge base and not the base branch tip, so a commit the base
// branch got after the card branched is not read as the card's.
async function startOf(run: Run, options: CardDiffOptions): Promise<string> {
  const base = await baseCommit(run, options.baseBranch);
  if (base.code !== 0 && base.code !== 1) {
    throw new Error(`${options.worktreePath} is not a git repository, so there is no diff to show. ${base.stderr.trim()}`);
  }
  if (base.code !== 0) {
    throw new Error(`The base branch ${options.baseBranch} is not in this repository, so the card's diff cannot be worked out. Set the base branch setting to a branch that exists.`);
  }

  const found = await run(['merge-base', base.stdout.trim(), 'HEAD']);
  if (found.code !== 0) {
    throw new Error(`${options.baseBranch} and this card share no commit, so there is nothing to compare. ${found.stderr.trim()}`);
  }
  return found.stdout.trim();
}

// The numbers come from numstat and the word from name-status, joined on the path. Both are asked
// with rename detection on, so a rename is one row in each.
const joined = (counts: readonly GitDiffEntry[], statuses: readonly NameStatusEntry[]): DiffEntry[] => {
  const byPath = new Map(statuses.map((entry) => [entry.path, entry]));
  return counts.map((count) => {
    const status = byPath.get(count.path);
    return {
      path: count.path,
      oldPath: count.oldPath ?? status?.oldPath ?? null,
      status: status?.status ?? (count.oldPath === null ? 'changed' : 'renamed'),
      added: count.added,
      removed: count.removed,
      binary: count.binary,
    };
  });
};

const listOf = async (run: Run, range: readonly string[]): Promise<DiffEntry[]> =>
  joined(
    parseNumstat(await out(run, ['diff', '--numstat', '-M', ...range])),
    parseNameStatus(await out(run, ['diff', '--name-status', '-M', ...range])),
  );

// The card's work in two groups: what is committed on its branch, and what is only in the folder.
// Both are what the person is about to commit or has already, so both belong on the tab.
export async function cardDiff(options: CardDiffOptions): Promise<CardDiff> {
  const run = runner(options);
  const start = await startOf(run, options);

  const committed = await listOf(run, [`${start}..HEAD`]);
  const tracked = await listOf(run, ['HEAD']);

  // A file git does not track has no diff of its own, so it is compared against nothing. That call
  // exits 1 when it finds a difference, which here means it worked.
  const untracked: DiffEntry[] = [];
  for (const line of (await out(run, ['ls-files', '--others', '--exclude-standard'])).split('\n')) {
    if (line.trim() === '') continue;
    const path = unquotePath(line);
    // The call answers 1 when it finds a difference, which here means it worked.
    const counted = parseNumstat(await out(run, ['diff', '--numstat', '--no-index', '--', '/dev/null', path], 1))[0];
    untracked.push({
      path,
      oldPath: null,
      status: 'added',
      added: counted?.added ?? 0,
      removed: 0,
      binary: counted?.binary ?? false,
    });
  }

  const branch = [...(await listOf(run, [start])), ...untracked];
  // No upstream, or one sharing no commit with the branch, leaves the whole branch to push.
  const upstream = await run(['merge-base', '@{upstream}', 'HEAD']);
  const pushes = upstream.code === 0 ? [...(await listOf(run, [upstream.stdout.trim()])), ...untracked] : branch;
  return { committed, uncommitted: [...tracked, ...untracked], branch, pushes };
}

// One file's patch, fetched when the person opens that file. Fetching the whole diff at once is
// what makes a tab unusable on a change that touched a hundred files.
export async function filePatch(options: FilePatchOptions): Promise<FilePatch> {
  const cap = options.capBytes ?? PATCH_CAP_BYTES;
  // One character past the cap is enough to know the patch is over it, and reading stops there, so
  // a half gigabyte file never reaches the runner's memory. No test here can tell this from
  // measuring afterwards, because the answer is the same either way: what it changes is how much
  // arrives. The mechanism itself is pinned in exec.test.ts.
  const run = runner(options, cap + 1);
  const range =
    options.group === 'commit'
      ? await commitRange(run, options)
      : options.group === 'committed'
        ? [`${await startOf(run, options)}..HEAD`]
        : options.group === 'branch'
          ? [await startOf(run, options)]
          : ['HEAD'];
  // A path is a pathspec to git, so `routes/[id]/page.svelte` matched other files and showed their
  // patches next to this one. `:(literal)` also covers a name that starts with a colon.
  const paths = (options.oldPath === undefined ? [options.path] : [options.oldPath, options.path]).map(
    (path) => `:(literal)${path}`,
  );

  let text = await out(run, ['diff', '-M', ...range, '--', ...paths]);
  // An empty answer is not proof the file is untracked: a tracked file with no change gives one
  // too, and showing that file whole read as if the card had added all of it. git is asked instead.
  if (text === '' && options.group !== 'committed' && options.group !== 'commit' && (await run(['ls-files', '--error-unmatch', '--', options.path])).code !== 0) {
    text = await out(run, ['diff', '--no-index', '--', '/dev/null', options.path], 1);
  }

  if (Buffer.byteLength(text) > cap) {
    return {
      ok: false,
      reason: `The diff of ${options.path} is over ${cap} bytes, which is too large to show here. Open the file in the card's checkout to read it.`,
    };
  }
  return { ok: true, text };
}

// A commit is named by its id alone, so a name cannot reach git as an option or a range.
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

// One commit of the card's branch against its first parent, the diff the commit made. The id resolves
// to a commit only, and git prefers a branch or a tag to a short id of the same name, so the answer must
// start with the id asked: a hex name that is also a branch cannot stand for the branch. A commit that is
// not on the branch past its base is refused, so the tab never shows a commit the card did not make.
async function commitRange(run: Run, options: CardDiffOptions & { commit?: string }): Promise<string[]> {
  const { commit } = options;
  if (commit === undefined || !COMMIT_ID.test(commit)) throw new Error(`${JSON.stringify(commit ?? '')} is not a commit id, so it has no diff to show.`);
  const found = await run(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  if (found.code !== 0) throw new Error(`${commit} is not a commit in this repository, so it has no diff to show.`);
  const sha = found.stdout.trim();
  if (!sha.startsWith(commit)) throw new Error(`${commit} also names a branch or a tag, so it is not read as a commit id.`);
  const start = await startOf(run, options);
  const onBranch = (await run(['merge-base', '--is-ancestor', sha, 'HEAD'])).code === 0;
  // 1 is git's no. Anything else is an error, which is no proof either way.
  const pastBase = (await run(['merge-base', '--is-ancestor', sha, start])).code === 1;
  if (!onBranch || !pastBase) throw new Error(`${commit} is not a commit of the card's branch since ${options.baseBranch}, so it is not shown here.`);
  return [`${sha}^`, sha];
}

// The files one commit of the card's branch changed, for the commit list of the Changes tab.
export async function commitDiff(options: CardDiffOptions & { commit: string }): Promise<DiffEntry[]> {
  const run = runner(options);
  return listOf(run, await commitRange(run, options));
}

// The newest commits of the card's branch since its base, at most `cap`, each marked pushed or not
// against the upstream. The same few git calls however long the branch is. The commits not pushed are
// read from the same range with the same cap, so every listed commit not pushed is among them.
export async function cardCommits(options: CardDiffOptions & { cap?: number }): Promise<BranchCommits> {
  const run = runner(options);
  const range = `${await startOf(run, options)}..HEAD`;
  const cap = String(options.cap ?? 50);
  const total = Number((await out(run, ['rev-list', '--count', range])).trim()) || 0;
  const log = await out(run, ['log', '--no-color', '-z', `--max-count=${cap}`, '--format=%H%x1f%h%x1f%s', range]);
  // A branch that tracks nothing has nowhere it was pushed to, so every commit is not pushed.
  const upstream = await run(['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '@{upstream}']);
  const unpushed = new Set(
    upstream.code === 0 ? (await out(run, ['rev-list', `--max-count=${cap}`, range, `^${upstream.stdout.trim()}`])).split('\n').filter((line) => line !== '') : null,
  );
  const list = log
    .split('\0')
    .filter((one) => one.trim() !== '')
    .map((one) => {
      const [sha = '', short = '', subject = ''] = one.replace(/^\n/, '').split('\x1f');
      return { sha, short, subject, pushed: upstream.code === 0 && !unpushed.has(sha) };
    });
  return { list, total };
}
