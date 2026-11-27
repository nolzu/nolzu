import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { findExecutable } from './shell-env.ts';
import { SANDBOX_EXEC, wallCommand, type PathKind, type WallCommand, type WallSpec } from './wall.ts';

// The node side of the wall: can it start on this machine, and what is on disk at spawn time.

export type WallReady = { ready: true; binary: string } | { ready: false; reason: string };

export interface WallProbeDeps {
  exists: (path: string) => boolean;
  which: (name: string) => string | null;
  // The exit code of a short command, or null when it could not run at all.
  run: (command: string, args: readonly string[]) => number | null;
}

const PROBE_MS = 5000;

const realDeps: WallProbeDeps = {
  exists: existsSync,
  which: (name) => findExecutable(name, process.env.PATH ?? ''),
  run: (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: PROBE_MS }).status,
};

export function checkWall(platform: string, deps: WallProbeDeps = realDeps): WallReady {
  if (platform === 'darwin') {
    if (!deps.exists(SANDBOX_EXEC)) {
      return { ready: false, reason: `${SANDBOX_EXEC} is missing, so the macOS wall cannot start.` };
    }
    if (deps.run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']) !== 0) {
      return {
        ready: false,
        reason: 'sandbox-exec could not start a test wall. Nolzu may already run inside a sandbox, and a macOS sandbox cannot start inside another one.',
      };
    }
    return { ready: true, binary: SANDBOX_EXEC };
  }
  if (platform === 'linux') {
    const bwrap = deps.which('bwrap');
    if (bwrap === null) {
      return { ready: false, reason: 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.' };
    }
    // The same namespaces the real wall asks for, so a probe that passes means the wall starts.
    if (deps.run(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '/bin/true']) !== 0) {
      return {
        ready: false,
        reason:
          'bubblewrap is installed but could not start a test wall, so user namespaces are blocked on this machine. On Ubuntu, allow them with sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0. On Debian, use sudo sysctl kernel.unprivileged_userns_clone=1.',
      };
    }
    return { ready: true, binary: bwrap };
  }
  return { ready: false, reason: `Nolzu cannot wall a run on ${platform}. It runs on macOS and Linux.` };
}

let cached: WallReady | undefined;

// The probe starts a process, and the answer does not change while Nolzu runs.
export function wallHere(): WallReady {
  cached ??= checkWall(process.platform);
  return cached;
}

const SKIP = new Set(['node_modules', '.git']);
const ENV_FILE = /^\.env(\..+)?$/;

// The project's `.env` files, for bwrap, which can hide only a path it is handed.
export function envFilesUnder(root: string, depth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (left > 0 && !SKIP.has(entry.name)) walk(path, left - 1);
      } else if (ENV_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(root, depth);
  return found;
}

// Write-denied paths with a `*` as the folders it names on disk now, for bwrap, which can hold only a
// path that is there. Limit: a folder made during the run is not held. Upgrade: an overlay mount.
export function starredPaths(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const at = path.indexOf('*');
    if (at === -1) return [path];
    try {
      return readdirSync(path.slice(0, at), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${path.slice(0, at)}${entry.name}${path.slice(at + 1)}`);
    } catch {
      return [];
    }
  });
}

// What bwrap can hold of a spec. It opens only a path that is there, so a missing writable path stays
// closed, and a `*` becomes the folders there now.
export function specOnDisk(spec: WallSpec): WallSpec {
  return { ...spec, writable: spec.writable.filter((path) => existsSync(path)), writeDenied: starredPaths(spec.writeDenied), writeDeniedLiteral: starredPaths(spec.writeDeniedLiteral ?? []) };
}

// The git folders of a checkout: its own, and the shared one that holds the objects and the hooks.
// A worktree's `.git` is a file that names its own folder, and that folder's `commondir` names the
// shared one, read here the way git reads it so no git process starts before the run. For a plain
// checkout both are its `.git`. Undefined when the checkout has no `.git` at all.
export function gitDirs(checkout: string): { own: string; common: string } | undefined {
  const dotGit = join(checkout, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return { own: dotGit, common: dotGit };
    const own = resolve(checkout, readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim());
    try {
      return { own, common: resolve(own, readFileSync(join(own, 'commondir'), 'utf8').trim()) };
    } catch {
      return { own, common: own };
    }
  } catch {
    return undefined;
  }
}

export function gitCommonDir(checkout: string): string | undefined {
  return gitDirs(checkout)?.common;
}

// The folders one level down that hold a `.git` of their own: the repositories of a card on several
// repositories sit there, and Nolzu runs git in each.
export function childRepos(checkout: string): string[] {
  try {
    return readdirSync(checkout, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.git' && existsSync(join(checkout, entry.name, '.git')))
      .map((entry) => join(checkout, entry.name));
  } catch {
    return [];
  }
}

// What tells git where a checkout's repository is: the `.git` entry, the git folders and their
// `commondir` files, for the checkout and each repository one level down. A file by its content,
// anything else by its device and inode, so a rename and a new folder in its place both show, and so
// does a new repository one level down. Read before and after a writable run: a run that moved one of
// them can point Nolzu's next git call at a config it wrote, and git would run a command from it
// outside the wall.
export function gitPointers(checkout: string): string {
  const id = (path: string): string => {
    try {
      const stat = lstatSync(path);
      return stat.isFile() ? `file ${readFileSync(path, 'utf8')}` : `${stat.isDirectory() ? 'dir' : 'other'} ${stat.dev}:${stat.ino}`;
    } catch {
      return 'none';
    }
  };
  const pointers = (tree: string): string[] => {
    const dirs = gitDirs(tree);
    return [join(tree, '.git'), ...(dirs === undefined ? [] : [dirs.own, join(dirs.own, 'commondir'), dirs.common, join(dirs.common, 'commondir')])];
  };
  const paths = [checkout, ...childRepos(checkout)].flatMap(pointers);
  return paths.map((path) => `${path} ${id(path)}`).join('\n');
}

export function kindOf(path: string): PathKind | null {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

// The path with every link resolved, as far as it exists. The wall matches resolved paths.
export function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolvedPath(parent), basename(path));
  }
}

/**
 * The engine command inside the wall on this machine, or a refusal that says what is missing.
 *
 * `alreadyWalled` is for a caller that starts an engine with its own sandbox, such as Codex. A
 * Nolzu that itself runs inside a Codex sandbox is caught through the variable Codex sets.
 * `here` is what detection found, passed only by a test.
 */
export function walledCommand(
  spec: WallSpec,
  command: string,
  args: readonly string[],
  alreadyWalled = false,
  here?: WallReady,
): WallCommand {
  const nested = alreadyWalled || process.env.CODEX_SANDBOX !== undefined;
  if (nested) return wallCommand(process.platform, spec, command, args, { alreadyWalled: true });
  const ready = here ?? wallHere();
  if (!ready.ready) return { refused: ready.reason };
  const real: WallSpec = {
    writable: spec.writable.map(resolvedPath),
    replaced: (spec.replaced ?? []).map(resolvedPath),
    hidden: spec.hidden.map(resolvedPath),
    writeDenied: spec.writeDenied.map(resolvedPath),
    writeDeniedLiteral: (spec.writeDeniedLiteral ?? []).map(resolvedPath),
    envRoots: spec.envRoots.map(resolvedPath),
    envExceptions: spec.envExceptions.map(resolvedPath),
    sockets: [...new Set((spec.sockets ?? []).map(resolvedPath))],
    reopened: (spec.reopened ?? []).map(resolvedPath),
    noLinks: (spec.noLinks ?? []).map(resolvedPath),
  };
  return wallCommand(process.platform, real, command, args, {
    kindOf,
    envFiles: process.platform === 'linux' ? real.envRoots.flatMap((root) => envFilesUnder(root)) : undefined,
    bwrap: ready.binary,
  });
}
