import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gitDirs } from '../wall-detect.ts';
import { gitCall, gitKind, madeFolders } from './commands.ts';

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

/**
 * For a git call that writes, the sentence that refuses it over a link where it writes; else null.
 * `owner` is the folder Nolzu owns the call happens in, the project or the workspace: a link from it
 * down to a folder the call makes is refused, and a link above it is the person's own setup. Left
 * out, it is the folder the call runs in, never a `-C` folder, which a link may lead to.
 */
export function linkBeforeWrite(args: readonly string[], cwd: string, env: Record<string, string | undefined> | undefined, owner?: string): string | null {
  // A read writes nothing there by name, and is left unchecked to keep it fast. Every other kind is
  // checked, a subcommand the table does not list among them (`gitKind`).
  const kind = gitKind(args);
  if (kind === 'read' || kind === 'network-read') return null;
  const call = gitCall(args, cwd);
  const made = madeFolders(call);
  // The system follows a link before it climbs back up a `..`, and the walk below reads the path with
  // the `..` taken out, so a path with one could lead past the walk to where a link points.
  const climbs = [...(made.length > 0 ? call.moves : []), ...made].find((path) => path.split(/[/\\]/).includes('..'));
  if (climbs !== undefined) return `${climbs} has a .. part, which leads wherever a link before it points. Nolzu stopped before running git there. Name the folder without ..`;
  for (const folder of made) {
    const link = linkOnTheWay(owner ?? cwd, resolve(call.folder, folder));
    if (link !== null) return link;
  }
  // `init` and `clone` write in no repository but the new one, and one that is there already has its
  // git folders checked, as git writes in them again. `worktree add` writes in its repository's.
  const dirs = made.length > 0 && call.command !== 'worktree' ? gitDirs(resolve(call.folder, made[0] ?? '')) : dirsOf(call.folder, env);
  const found = dirs === undefined ? null : gitLinkIn(dirs);
  return found === null ? null : gitLinkSentence(found);
}

// A link at any step from the owner folder down to `target`, `target` itself included, would have git
// make the folder where the link points, also one that points nowhere yet. A target outside the owner
// is walked from the folder the two share. A step that is not there ends the walk: git makes the rest.
function linkOnTheWay(owner: string, target: string): string | null {
  const to = resolve(target);
  let from = resolve(owner);
  while (to !== from && !to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)) from = dirname(from);
  const steps = relative(from, to).split(sep).filter((step) => step !== '');
  let at = from;
  for (const step of steps.length === 0 ? [''] : steps) {
    at = join(at, step);
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (stat.isSymbolicLink()) return `${at} is a link, so git would make its folder where the link points. Nolzu stopped before running git there. Remove the link, or use the folder it points to.`;
  }
  return null;
}
