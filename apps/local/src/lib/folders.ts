import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homePath } from './home-path.ts';

export type FolderList = { path: string; parent: string | null; folders: string[] };

const OUTSIDE = { status: 403, problem: 'Browse shows only folders inside your home folder.' };

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The folders inside one folder under the home folder, for Browse on New project, since a web page
 * cannot read a real path from the system file picker. Names only: no file is opened, nothing is
 * written, and dot folders are left out.
 *
 * A path outside home is refused twice. First as typed, once `..` is resolved and before the disk is
 * touched, so a path typed outside home is never looked up. Then again once links are resolved, so a
 * link inside home that points out of it is refused too.
 */
export async function listFolders(asked: string | null, home: string): Promise<FolderList | { status: number; problem: string }> {
  const typed = asked === null || asked === '' ? home : asked;
  if (!isAbsolute(typed)) return { status: 400, problem: 'Give the folder as a full path.' };
  const realHome = await realpath(home);
  const lexical = resolve(typed);
  if (!inside(lexical, resolve(home)) && !inside(lexical, realHome)) return OUTSIDE;

  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return { status: 404, problem: `There is no folder at ${homePath(lexical, home)}.` };
  }
  if (!inside(real, realHome)) return OUTSIDE;

  let entries;
  try {
    entries = await readdir(real, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return { status: 400, problem: `${homePath(real, realHome)} is a file, not a folder.` };
    return { status: 403, problem: `${homePath(real, realHome)} cannot be read.` };
  }
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) folders.push(entry.name);
    // A link is listed when it leads to a folder under home, the only place Browse can open.
    else if (entry.isSymbolicLink()) {
      const to = await realpath(join(real, entry.name)).catch(() => null);
      if (to !== null && inside(to, realHome) && (await stat(to)).isDirectory()) folders.push(entry.name);
    }
  }
  return { path: real, parent: real === realHome ? null : dirname(real), folders: folders.sort((a, b) => a.localeCompare(b)) };
}
