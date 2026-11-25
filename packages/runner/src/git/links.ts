import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gitDirs } from '../wall-detect.ts';

// git writes several files in its folders by name, with an open that follows a link: COMMIT_EDITMSG,
// FETCH_HEAD, MERGE_MSG, MERGE_HEAD, ORIG_HEAD, SQUASH_MSG, AUTO_MERGE, the reflogs it appends to on
// every ref move, packed-refs and gc.log among them. A run that may write those folders could leave a
// link there, or a second name of a file elsewhere, and Nolzu's next commit, fetch or pull, outside
// the wall, would write the file it points to. A named pipe there would hang that git call. So the
// places git writes by name may hold none of them: a card's own git folder whole, and in the shared
// folder every entry at its top that is not a folder, and the folders in `WALKED`. A socket passes: an
// open of one fails at once, and git's fsmonitor daemon keeps one in each git folder.
//
// The objects and LFS folders are left out, because git writes them through a temp file and a rename
// and they are the large part of a repository, and so is the hooks folder, where a person may link a
// hook and where git runs nothing for Nolzu. So is `modules`, the git folders of submodules: a local
// clone hard links their objects, and Nolzu's git never goes into a submodule (`submodule.recurse=false`).
const SKIPPED = new Set(['objects', 'lfs', 'hooks', 'modules']);
// The folders of the shared one where git writes a file by name. Any other folder there is left out:
// git writes `info/refs` on a gc through a temp file and a rename, which replaces a link and never
// writes through it, and only reads the rest of `info`, which a run cannot write. Nolzu writes
// `info/exclude` itself, after its own check (`addExcludes`). `nolzu-removing` holds checkouts on their
// way out, and `nolzu-locks` and `fsmonitor--daemon` hold files Nolzu's git never opens. So a person's
// linked `info/exclude` does not stop this check, and a checkout's own links stop nothing.
// A named pipe under `objects` is not looked for either: loose objects are many, and git reads them
// by name, so a pipe a run leaves there makes Nolzu's next git call in that repository wait. It writes
// nothing elsewhere.
const WALKED = new Set(['refs', 'logs', 'rr-cache', 'rebase-merge', 'rebase-apply', 'sequencer', 'worktrees']);

export interface GitLink {
  path: string;
  kind: 'link' | 'second name' | 'pipe';
}

// The first entry under `path` that is a link, a plain file with a second name, or neither a plain
// file, a folder nor a socket. Never follows a link, so it cannot loop. A folder it cannot read is
// passed over, since git, as the same user, cannot write in it either.
function walk(path: string, skip: (path: string) => boolean): GitLink | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return { path, kind: 'link' };
  if (stat.isFile()) return stat.nlink > 1 ? { path, kind: 'second name' } : null;
  if (stat.isSocket()) return null;
  if (!stat.isDirectory()) return { path, kind: 'pipe' };
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return null;
  }
  for (const name of names) {
    const child = join(path, name);
    if (skip(child)) continue;
    const found = walk(child, skip);
    if (found !== null) return found;
  }
  return null;
}

/** The first link, second name or pipe in the places git writes by name in these git folders, or null. */
export function gitLinkIn(found: { own: string; common: string }): GitLink | null {
  // From the real folders: a person's `.git` may itself be a link, and what tells git where its folders
  // are is held and compared by `gitPointers`.
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const dirs = { own: real(found.own), common: real(found.common) };
  // Skipped only right inside a git folder (the shared one, the own one, or a card's under
  // `worktrees`), so a branch named `objects` under refs is still looked at.
  const gitFolder = (dir: string) => dir === dirs.common || dir === dirs.own || dirname(dir) === join(dirs.common, 'worktrees');
  const skipTop = (path: string) => SKIPPED.has(basename(path)) && gitFolder(dirname(path));
  if (dirs.own !== dirs.common) {
    const own = walk(dirs.own, skipTop);
    if (own !== null) return own;
  }
  // Each folder git writes in is looked up by the name git opens, never matched against a listing: on
  // macOS `LOGS`, or `logſ` with a long s, is the same folder as `logs`, so a run that renames one is
  // still looked in.
  for (const name of WALKED) {
    const found = walk(join(dirs.common, name), skipTop);
    if (found !== null) return found;
  }
  let names: string[];
  try {
    names = readdirSync(dirs.common);
  } catch {
    return null;
  }
  // Then every entry at the top that is not a folder, a link to one included. A linked `hooks` passes:
  // a person may keep their hooks elsewhere, and git runs none for Nolzu (`core.hooksPath=/dev/null`).
  for (const name of names) {
    const path = join(dirs.common, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined || stat.isDirectory() || name === 'hooks') continue;
    const found = walk(path, () => false);
    if (found !== null) return found;
  }
  return null;
}

export const gitLinkSentence = (found: GitLink): string =>
  found.kind === 'link'
    ? `${found.path} is a link, where git writes by name. Nolzu stopped before running git there. Remove it, and check the file it points to.`
    : found.kind === 'second name'
      ? `${found.path} is a file with a second name, where git writes by name. Nolzu stopped before running git there. Remove it, and check the file it shares its content with.`
      : `${found.path} is a named pipe or a device, where git writes by name. Nolzu stopped before running git there. Remove it.`;

// The commands that write in a checkout's git folders, where Nolzu checks for a link first. A read
// such as status or log writes nothing there by name, and is left unchecked to keep it fast.
const WRITES = new Set([
  'am',
  'branch',
  'checkout',
  'cherry-pick',
  'commit',
  'fetch',
  'gc',
  'merge',
  'notes',
  'pack-refs',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'stash',
  'switch',
  'symbolic-ref',
  'tag',
  'update-ref',
  'worktree',
]);

// The read forms of those commands Nolzu runs, left unchecked: a branch list, the current branch, the
// worktree list, and `symbolic-ref` with one ref, which reads it.
const READ_FLAGS = new Set(['--show-current', '--list', '--contains', '--all']);
function writes(command: string, rest: readonly string[]): boolean {
  if (!WRITES.has(command)) return false;
  if (command === 'branch') return !rest.some((arg) => READ_FLAGS.has(arg));
  if (command === 'worktree') return rest[0] !== 'list';
  if (command === 'symbolic-ref') return rest.filter((arg) => !arg.startsWith('-')).length > 1;
  return true;
}

// The git folders a call works in: the ones GIT_DIR and GIT_COMMON_DIR name, or those of the nearest
// folder up from where it runs that has a `.git`, as git finds them.
function dirsOf(folder: string, env: Record<string, string | undefined> | undefined): { own: string; common: string } | undefined {
  if (env?.GIT_DIR !== undefined) {
    const own = resolve(folder, env.GIT_DIR);
    if (env.GIT_COMMON_DIR !== undefined) return { own, common: resolve(folder, env.GIT_COMMON_DIR) };
    try {
      return { own, common: resolve(own, readFileSync(join(own, 'commondir'), 'utf8').trim()) };
    } catch {
      return { own, common: own };
    }
  }
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return gitDirs(dir);
    if (dir === dirname(dir)) return undefined;
  }
}

/** For a git call that writes in a checkout's git folders, the sentence that refuses it over a link there; else null. */
export function linkBeforeWrite(args: readonly string[], cwd: string, env: Record<string, string | undefined> | undefined): string | null {
  let at = 0;
  let folder = cwd;
  while (args[at] === '-C' || args[at] === '-c') {
    if (args[at] === '-C') folder = resolve(folder, args[at + 1] ?? '');
    at += 2;
  }
  if (!writes(args[at] ?? '', args.slice(at + 1))) return null;
  const dirs = dirsOf(folder, env);
  const found = dirs === undefined ? null : gitLinkIn(dirs);
  return found === null ? null : gitLinkSentence(found);
}
