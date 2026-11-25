import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withoutAttribution } from '@nolzu/core';
import { type CardCacheFolder, type CardFile, type CardFileGroup, type CardFileKind, PHASE_LABELS } from '@nolzu/protocol';
import { DISCOVERIES_FILE, QA_CHECKS_FILE } from './prompt.ts';

export type CardFileRead =
  | { ok: true; kind: CardFileKind; type: string; bytes: Buffer }
  | { ok: false; status: 400 | 404 | 413; reason: string };

// Code and notes are shown as text. SVG is not an image here: it can carry a script. HTML is its own
// kind, because the page draws it in a sandboxed frame.
const TEXT = new Set(['.ts', '.js', '.mjs', '.json', '.txt', '.yaml', '.yml', '.css', '.svelte', '.sh', '.log', '.ndjson', '.diff', '.patch']);
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// How a file is shown. Exported, because the reader's size cap depends on it: a picture is shown
// whole or not at all.
export const cardFileKind = (name: string): CardFileKind => {
  const ext = extname(name).toLowerCase();
  if (ext === '.md') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (TEXT.has(ext)) return 'text';
  return ext in IMAGES ? 'image' : 'download';
};

const typeOf = (name: string, kind: CardFileKind): string => {
  if (kind === 'markdown') return 'text/markdown; charset=utf-8';
  // A design's screens link their tokens, and a browser applies a stylesheet under nosniff only when
  // it comes as CSS. The Files tab reads it as text all the same.
  if (kind === 'text') return extname(name).toLowerCase() === '.css' ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8';
  if (kind === 'html') return 'text/html; charset=utf-8';
  return IMAGES[extname(name).toLowerCase()] ?? 'application/octet-stream';
};

// A quarter of a megabyte is already more than a page shows. A bigger file is refused with its size.
export const CARD_FILE_CAP = 256 * 1024;
// A download is not shown, so it may be larger. It still has an end, because the file is read whole.
export const CARD_DOWNLOAD_CAP = 64 * 1024 * 1024;

const kB = (bytes: number) => `${Math.ceil(bytes / 1024)} kB`;

const PHASE_ORDER = Object.keys(PHASE_LABELS);
const topFolder = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '');

// The phase whose run wrote a file, read off the card folder layout: every skill writes to
// `<card folder>/<phase>/`, and Plan also writes the QA checks. Null outside a phase folder, which is
// a file a person put there, such as a log for an investigation.
export function writerOf(path: string): string | null {
  if (path === QA_CHECKS_FILE) return 'plan';
  const folder = topFolder(path);
  // Own keys only: `in` also finds what every object inherits, so a folder named constructor would
  // name a phase.
  return Object.hasOwn(PHASE_LABELS, folder) ? folder : null;
}

// Phase folders in the order the phases run, then the rest by name. The top of the card folder goes
// first when it holds the discoveries, which every phase adds to and the wrap-up reads first.
const rank = (folder: string, list: CardFile[]) => {
  if (folder === '' && list.some((file) => file.path === DISCOVERIES_FILE)) return -1;
  const at = PHASE_ORDER.indexOf(folder);
  return at === -1 ? PHASE_ORDER.length : at;
};
const discoveriesFirst = (one: CardFile, other: CardFile) => Number(other.path === DISCOVERIES_FILE) - Number(one.path === DISCOVERIES_FILE) || one.path.localeCompare(other.path);

// Folders a package manager or a build fills. A run can leave one in the card folder (an npm cache of
// five thousand files once), and nobody reads it, so it is counted and never listed.
const CACHE_NAMES = new Set(['node_modules', 'npm-cache', '.npm', '.cache', '.pnpm-store']);
const isCacheFolder = (path: string): boolean => {
  const name = basename(path);
  return CACHE_NAMES.has(name) || (name === 'cache' && basename(join(path, '..')) === '.yarn');
};

// Every file under the card folder, one group per subfolder. Only `share/` is share.
// Git excludes the card folder and the hub never gets a file body, so no other rule decides
// what a card file is for. A folder that is not there yet, which is every card before its first
// run, lists nothing.
export function listCardFiles(dir: string): CardFileGroup[] {
  // A link at the card folder's own name lists nothing, as `readCardFile` shows nothing through it.
  if (linkedCard(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files: CardFile[] = [];
  const caches: CardCacheFolder[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      // A cache folder is counted off the folder listings alone, with no look at each file.
      if (entry.isDirectory() && isCacheFolder(full)) {
        const count = readdirSync(full, { withFileTypes: true, recursive: true }).filter((one) => one.isFile()).length;
        caches.push({ path: relative(dir, full).split(sep).join('/'), count });
      } else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        // A run can remove a file between the listing and this look at it. It is simply not listed.
        let stat: { size: number; mtimeMs: number };
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        const kind = cardFileKind(entry.name);
        const path = relative(dir, full).split(sep).join('/');
        // A note too big for the viewer is a download, so the list offers only what the viewer can do.
        const tooBig = kind !== 'image' && kind !== 'download' && stat.size > CARD_FILE_CAP;
        files.push({ path, name: entry.name, size: stat.size, kind: tooBig ? 'download' : kind, phase: writerOf(path), modified: stat.mtimeMs, ...(tooBig ? { tooBig: true as const } : {}) });
      }
    }
  };
  walk(dir);

  const groups = new Map<string, CardFile[]>();
  for (const file of files) {
    const folder = topFolder(file.path);
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  // A cache folder goes with the group of the folder that holds it, a top level one with the card
  // folder's own group.
  const cachesOf = new Map<string, CardCacheFolder[]>();
  for (const cache of caches) {
    const folder = topFolder(cache.path);
    if (!groups.has(folder)) groups.set(folder, []);
    cachesOf.set(folder, [...(cachesOf.get(folder) ?? []), cache].sort((one, other) => one.path.localeCompare(other.path)));
  }
  return [...groups]
    .sort(([one, ones], [other, others]) => rank(one, ones) - rank(other, others) || one.localeCompare(other))
    .map(([folder, list]) => ({ folder, share: folder === 'share', files: list.sort(discoveriesFirst), ...(cachesOf.has(folder) ? { caches: cachesOf.get(folder) } : {}) }));
}

// Every run may write its card folder, so a run can leave a link there, or put one in the place of the
// card folder itself, and aim a write or a read of Nolzu's at a file outside: the prompt written into
// `~/.zshenv`, a QA report copied out of `~/.ssh`. A link at the card folder's own name is refused.
const linkedCard = (dir: string): boolean => lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true;

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

// The full path of `path` in the card folder, or null for one that holds a null byte, is absolute or climbs out.
const inCard = (dir: string, path: string): string | null => {
  if (path.includes('\0') || isAbsolute(path)) return null;
  const full = resolve(dir, path);
  return full.startsWith(`${resolve(dir)}${sep}`) ? full : null;
};

// Makes the folder `full` sits in, after the nearest folder of it that is there, and again once made,
// is found inside the real card folder. Throws otherwise, before anything is made. Answers the real folder.
function cardParent(dir: string, full: string, path: string): string {
  const refuse = () => new Error(`${path} in the card folder ${dir} leads out of it through a link, so Nolzu leaves it alone.`);
  mkdirSync(dir, { recursive: true });
  if (linkedCard(dir)) throw refuse();
  const root = realpathSync(dir);
  const real = (at: string): string | null => {
    try {
      return realpathSync(at);
    } catch {
      return null;
    }
  };
  let near = dirname(full);
  while (lstatSync(near, { throwIfNoEntry: false }) === undefined) near = dirname(near);
  const nearReal = real(near);
  if (nearReal === null || !within(nearReal, root)) throw refuse();
  mkdirSync(dirname(full), { recursive: true });
  const parentReal = real(dirname(full));
  if (parentReal === null || !within(parentReal, root)) throw refuse();
  return parentReal;
}

/**
 * Writes one file of the card folder. The folder it goes in must be inside the real card folder, before
 * any folder is made and after, and the file is opened without following a link at its name. A file
 * there that is no plain file, or has a second name (a hard link to a file outside), is refused before
 * anything in it changes.
 */
export function writeCardFile(dir: string, path: string, data: string | Uint8Array): void {
  const full = inCard(dir, path);
  if (full === null) throw new Error(`${path} is not a path inside the card folder, so Nolzu did not write it.`);
  writeOwnFile(full, data, `${path} in the card folder ${dir}`, cardParent(dir, full, path));
}

/**
 * Writes `full` without following a link at its name. A file there that is no plain file, or has a
 * second name (a hard link to a file outside), is refused before anything in it changes. `what` names
 * the file in the refusal. The caller checks the folders on the way, and `parent` is the real folder it
 * found the file in: a folder on the way swapped for a link between that check and the open is caught
 * once the file is open, before anything is written, though the open may have made an empty file there.
 */
export function writeOwnFile(full: string, data: string | Uint8Array, what: string, parent: string): void {
  let fd: number;
  try {
    // Not truncated on open: a file found there is checked first. Not blocking, so a named pipe answers at once.
    fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENXIO') throw new Error(`${what} is a link or a pipe, so Nolzu did not write it.`, { cause: error });
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) throw new Error(`${what} is not a plain file of its own, so Nolzu did not write it.`);
    // The open file must be the one in the checked folder, and that folder still where it was found.
    let here: { dev: number; ino: number } | undefined;
    try {
      here = realpathSync(dirname(full)) === parent ? lstatSync(join(parent, basename(full))) : undefined;
    } catch {
      here = undefined;
    }
    if (here === undefined || here.dev !== stat.dev || here.ino !== stat.ino) throw new Error(`${what} moved out of its folder while Nolzu opened it, so Nolzu did not write it.`);
    ftruncateSync(fd, 0);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The text of one file of the card folder, or null when it is not there or `readCardFile` refuses it. */
export function readCardText(dir: string, path: string): string | null {
  const read = readCardFile(dir, path, Number.MAX_SAFE_INTEGER);
  return read.ok ? read.bytes.toString('utf8') : null;
}

/** Makes one folder of the card folder, checked as a write is. Answers its path. */
export function makeCardFolder(dir: string, path: string): string {
  const full = inCard(dir, path);
  if (full === null) throw new Error(`${path} is not a path inside the card folder, so Nolzu did not make it.`);
  cardParent(dir, join(full, 'x'), path);
  return full;
}

/** Removes one file of the card folder: a link there goes as a link, and nothing goes through a link above it. */
export function removeCardFile(dir: string, path: string): void {
  const full = inCard(dir, path);
  if (full === null || !existsSync(dir) || linkedCard(dir)) return;
  let near = dirname(full);
  while (lstatSync(near, { throwIfNoEntry: false }) === undefined) near = dirname(near);
  try {
    if (!within(realpathSync(near), realpathSync(dir))) return;
  } catch {
    return;
  }
  if (near !== dirname(full)) return;
  rmSync(full, { force: true });
}

// One file of the card folder, which is a jail: the path may not climb out, be absolute, hold a null
// byte, or reach outside through a link.
export function readCardFile(dir: string, path: string, cap = CARD_FILE_CAP): CardFileRead {
  if (path.includes('\0')) return { ok: false, status: 400, reason: 'The path holds a null byte, so it names no file.' };
  const leaves: CardFileRead = { ok: false, status: 400, reason: `${path} leaves the card folder, so it is not shown.` };
  const full = resolve(dir, path);
  if (!full.startsWith(`${resolve(dir)}${sep}`) || linkedCard(dir)) return leaves;
  if (!existsSync(full)) return { ok: false, status: 404, reason: `There is no file ${path} in the card folder.` };
  // Through the links, both sides, so a link that points out is caught and a folder reached through
  // a link on this machine's own path, such as /tmp, is not.
  const real = realpathSync(full);
  if (!real.startsWith(`${realpathSync(dir)}${sep}`)) return leaves;

  // The checked path is opened, never through a link at its end, and checked again once open: a run
  // that swaps a folder on the way for a link between the check and the open is caught by the second
  // look, and the bytes come from the file that was open when it passed.
  let fd: number;
  try {
    // Not blocking, so a named pipe a run left in the folder answers at once instead of holding the
    // whole app until something writes into it.
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return leaves;
  }
  try {
    const stat = fstatSync(fd);
    const again = statSync(real, { throwIfNoEntry: false });
    if (realpathSync(real) !== real || again === undefined || again.ino !== stat.ino || again.dev !== stat.dev) return leaves;
    if (!stat.isFile()) return { ok: false, status: 404, reason: stat.isDirectory() ? `${path} is a folder, not a file.` : `${path} is not a plain file, so it is not shown.` };
    // A second name is a hard link, which can be to a file outside the card folder.
    if (stat.nlink > 1) return leaves;
    if (stat.size > cap) return { ok: false, status: 413, reason: `${path} is ${kB(stat.size)}, over the ${kB(cap)} a page shows. Open it in the card folder.` };
    const kind = cardFileKind(path);
    return { ok: true, kind, type: typeOf(path, kind), bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

// The files of the card folder that leave it for other people: every Markdown and text file in
// `share/`, and the pull request text. Regular files only, never through a link: a link could point
// out of the card folder, and the strip below writes.
export function sharedFiles(dir: string): string[] {
  // lstat, so a link reads as a link and is left out, a link to a folder too.
  const is = (path: string, kind: 'file' | 'folder') => {
    try {
      const stat = lstatSync(join(dir, path));
      return kind === 'file' ? stat.isFile() : stat.isDirectory();
    } catch {
      return false;
    }
  };
  const own = is('share', 'folder')
    ? readdirSync(join(dir, 'share'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
        .map((entry) => `share/${entry.name}`)
    : [];
  return [...own.sort(), ...(is('implement/pr.md', 'file') ? ['implement/pr.md'] : [])];
}

// Takes the lines that name a tool as the writer out of the shared files, after every run, and gives
// back the paths it changed. A file that cannot be read or written is skipped, so the rest still go.
export function stripSharedAttribution(dir: string): string[] {
  return sharedFiles(dir).filter((path) => {
    try {
      // Read and written inside the card folder only: a run could swap a file for a link meanwhile.
      const text = readCardText(dir, path);
      if (text === null) return false;
      const clean = withoutAttribution(text);
      if (clean === text) return false;
      writeCardFile(dir, path, clean);
      return true;
    } catch {
      return false;
    }
  });
}
