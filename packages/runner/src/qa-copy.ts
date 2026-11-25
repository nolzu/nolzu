import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

// QA runs the project's own checks, and a check writes caches: tsc incremental files, `.vite`,
// `test-results`, coverage. The wall keeps the real checkout read-only for a read-only phase, so QA
// runs on a throwaway copy of it instead. The copy holds the working tree as it is, uncommitted
// work and `node_modules` included, because QA checks what Implement left. A git worktree would
// miss the uncommitted work, so this is a file copy: a clone where the disk can make one, which
// costs no space and takes a moment, and a plain copy where it cannot.

export type CopyMethod = 'APFS clone' | 'reflink' | 'plain copy';

export interface CopyAttempt {
  method: CopyMethod;
  flags: readonly string[];
}

// The cp calls to try, in order. A clone needs the copy on the same volume, and cp refuses one it
// cannot make, which is what moves on to the plain copy.
export function copyAttempts(platform: string): CopyAttempt[] {
  const plain: CopyAttempt = { method: 'plain copy', flags: ['-R'] };
  if (platform === 'darwin') return [{ method: 'APFS clone', flags: ['-c', '-R'] }, plain];
  if (platform === 'linux') return [{ method: 'reflink', flags: ['--reflink=always', '-R'] }, plain];
  return [plain];
}

export interface QaCopyOptions {
  platform?: string;
  // Folders of the checkout left out of the copy, such as the project's `.tasks` and `worktrees`
  // when QA runs in the project folder itself.
  skip?: readonly string[];
  signal?: AbortSignal;
  // Tests only: runs cp with these arguments.
  cp?: (args: readonly string[], signal?: AbortSignal) => Promise<void>;
}

const runCp = async (args: readonly string[], signal?: AbortSignal): Promise<void> => {
  await promisify(execFile)('cp', [...args], { signal, maxBuffer: 1024 * 1024 });
};

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Copies the checkout to `dest`, and says how and how long it took.
 *
 * Each top entry is copied on its own into `dest`, so a skipped folder is never read, and a copy
 * folder that sits inside the checkout is not copied into itself. Whatever an earlier run left at
 * `dest` goes first. A failed copy leaves nothing behind.
 */
export async function makeQaCopy(checkout: string, dest: string, options: QaCopyOptions = {}): Promise<{ method: CopyMethod; ms: number }> {
  const started = Date.now();
  const cp = options.cp ?? runCp;
  const skip = new Set(options.skip ?? []);
  rmSync(dest, { recursive: true, force: true });
  const sources = readdirSync(checkout)
    .map((name) => join(checkout, name))
    .filter((path) => !skip.has(path) && !inside(dest, path));
  let last: unknown = null;
  for (const attempt of copyAttempts(options.platform ?? process.platform)) {
    mkdirSync(dest, { recursive: true });
    try {
      // Every source is an absolute path, so none can be read as a flag.
      if (sources.length > 0) await cp([...attempt.flags, ...sources, dest], options.signal);
      return { method: attempt.method, ms: Date.now() - started };
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      if (options.signal?.aborted) throw error;
      last = error;
    }
  }
  const said = String((last as { stderr?: unknown } | null)?.stderr ?? '').trim() || (last as Error | null)?.message || 'no reason given';
  throw new Error(`Nolzu could not copy ${checkout} for QA. ${said}`);
}

export async function removeQaCopy(dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// The device of a path, or of its nearest folder that is there: a card's checkout may not be made
// yet when its job is built.
function deviceOf(path: string): number {
  for (let at = path; ; at = dirname(at)) {
    try {
      return statSync(at).dev;
    } catch {
      if (dirname(at) === at) return -1;
    }
  }
}

// The top folder of the volume a path is on.
function mountOf(path: string): string {
  const dev = deviceOf(path);
  let at = path;
  while (!existsSync(at)) at = dirname(at);
  while (dirname(at) !== at && deviceOf(dirname(at)) === dev) at = dirname(at);
  return at;
}

/**
 * The Nolzu folder that holds QA copies for this checkout.
 *
 * On the checkout's volume, because an APFS clone or a reflink can only be made there, and never in
 * the person's project. The data folder when it shares the volume, which is the usual case. A
 * project on another disk gets a folder at the top of that disk, and the data folder when that one
 * cannot be made, where the plain copy then takes over.
 */
export function qaCopyRoot(dataDir: string, checkout: string): string {
  const home = join(dataDir, 'qa-copies');
  if (deviceOf(dataDir) === deviceOf(checkout)) return home;
  const there = join(mountOf(checkout), '.nolzu-qa-copies');
  try {
    mkdirSync(there, { recursive: true });
    return there;
  } catch {
    return home;
  }
}

const COPY_NAME = /^qa-[A-Za-z0-9_.-]+-[0-9a-f]{8}$/;

/**
 * Where the QA copy of this card's checkout goes.
 *
 * The same path for every QA run of the card on this checkout, so a resumed session finds the
 * folder it was filed under. The hash of the checkout keeps two projects with the same card key
 * apart.
 */
export function qaCopyPath(dataDir: string, checkout: string, key: string): string {
  const hash = createHash('sha256').update(checkout).digest('hex').slice(0, 8);
  return join(qaCopyRoot(dataDir, checkout), `qa-${key.replace(/[^A-Za-z0-9_.-]/g, '_')}-${hash}`);
}

/**
 * Deletes the copies a crash left in this folder, and nothing else in it.
 *
 * Called when Nolzu starts, before any run, so every copy there is one no run uses.
 */
export function sweepQaCopies(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const old = names.filter((name) => COPY_NAME.test(name)).map((name) => join(root, name));
  for (const path of old) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return old;
}
