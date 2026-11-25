import { lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const kind = (path: string): 'missing' | 'file' | 'other' => {
  try {
    const found = lstatSync(path);
    // A hard link reads as a plain file and shares its bytes with every other name for it, and a
    // write truncates all of them. More than one name is enough to leave it alone.
    return found.isFile() && found.nlink === 1 ? 'file' : 'other';
  } catch {
    return 'missing';
  }
};

// Where a file of `path` lives under `root`, or null when Nolzu may not write it: a path that leaves
// the folder, one that passes through a symlink, or one that is there and is not a plain file. A
// symlink is often shared with another project or a dotfiles repository, and writing through it would
// change a file outside the folder the person chose. The skill sync and the project files use the one
// rule, so the wizard cannot refuse a link in one place and write through it in another.
export function writablePath(root: string, path: string): string | null {
  const parts = path.split('/');
  // Limit: the backslash and the containment check guard Windows, where a backslash splits a path
  // and a part such as `C:` starts another drive. No test on a posix machine can reach either.
  if (path.includes('\\') || path.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const at = resolve(root, ...parts);
  if (!at.startsWith(root + sep)) return null;
  for (let step = root, index = 0; index < parts.length; index += 1) {
    step = join(step, parts[index] ?? '');
    const found = kind(step);
    if (found === 'missing') return at;
    // lstat never follows a link, so a symlinked folder is not a folder here and a symlinked file is
    // not a file. That is what stops a write from leaving the project through one.
    if (index < parts.length - 1 ? !lstatSync(step).isDirectory() : found !== 'file') return null;
  }
  return at;
}
