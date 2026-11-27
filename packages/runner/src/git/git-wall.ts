import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { findExecutable } from '../shell-env.ts';
import type { WallReady } from '../wall-detect.ts';
import type { WallSpec } from '../wall.ts';
import type { GitCall } from './commands.ts';
import type { RepoPlaces } from './places.ts';

// The wall around Nolzu's own git when it writes: the repository's work tree and git folders, and a
// temp folder of the call's own, are the only places it and every program it starts (a hook, a
// filter, a signer) may write. Inside the git folders, what tells git which programs to run and
// where its repository is stays closed. Reads stay open, so the person's git config, keys and
// credential helpers still work.

/** Refuses a git write that names no repository. Every write names one, so this is a bug in Nolzu. */
export const NO_PLACE = 'Nolzu was about to run a git write without naming its repository, so it did not run git. This is a bug in Nolzu. Report it, with the step you took.';

/** Added to a failed git call whose hook a wall refused. */
export const HOOK_IN_WALL =
  "A hook ran inside Nolzu's git wall, which allows writes only in the repository and a temp folder of its own, and never in the repository's config or hooks, and the wall refused one of its writes. Change the hook to write only there, or turn off Run hooks.";

/** Refuses hooks on a command that writes the repository's config, which a hook may never write. */
export const CONFIG_WITH_HOOKS = "Nolzu does not run hooks on a git command that writes the repository's config, because a hook could then change the config too. This is a bug in Nolzu. Report it, with the step you took.";

// What a refused write says on macOS and on Linux.
export const WALL_REFUSED = /Operation not permitted|Read-only file system/;

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// A `branch` that writes moves its section of the config on a delete, a rename or an upstream.
const SUBCOMMANDS_WITH_CONFIG = new Set(['config', 'remote', 'branch', 'init', 'submodule']);

/**
 * Whether a write changes the repository's config: `config` and `remote` when they write, `branch`
 * (a delete, a rename or an upstream moves its config section), `init`, `submodule`, and a
 * `worktree add`, which can set an upstream. Every other write leaves the config closed.
 */
export const writesConfig = (call: GitCall): boolean =>
  call.command !== undefined && (SUBCOMMANDS_WITH_CONFIG.has(call.command) || (call.command === 'worktree' && call.rest.includes('add')));

/**
 * The paths inside the git folders that a write keeps closed: what names the programs git runs (the
 * config and the hooks folder, `info/attributes`, which picks a filter by path) and what tells git
 * where its repository is (a `commondir`, a checkout's `.git` file and its own `gitdir`). A command
 * that writes the config gets the config back, and never runs hooks.
 */
export function closedGitPaths(places: RepoPlaces, config: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const { workTree, gitDir, commonDir } = places;
  const linked = gitDir !== commonDir;
  return [
    ...(config ? [] : [join(commonDir, 'config'), join(commonDir, 'config.worktree'), join(gitDir, 'config.worktree')]),
    join(commonDir, 'hooks'),
    // bubblewrap holds only a path that is there, so on Linux the whole `info` folder, which
    // `linuxHolds` makes first. git's writes here put nothing in it.
    platform === 'linux' ? join(commonDir, 'info') : join(commonDir, 'info', 'attributes'),
    join(commonDir, 'commondir'),
    ...(linked ? [join(workTree, '.git'), join(gitDir, 'commondir'), join(gitDir, 'gitdir')] : []),
  ];
}

export interface GitWallInput {
  writable: readonly string[];
  closed: readonly string[];
  // The call's own temp folder, which git and its programs get as TMPDIR.
  temp: string;
  gnupg?: Gnupg | null;
}

export interface Gnupg {
  home: string;
  // Linux: the folder the agent keeps its sockets in, when it is there.
  sockets: string | null;
}

// gpg's config files name programs gpg starts later, such as a `pinentry-program`, outside any wall.
// gpg also reads a file named for its version, such as `gpg.conf-2` or `gpg-agent.conf-2.4`.
export const GPG_CONF = /\.conf([-.].*)?$/;

/** The wall for one git write: only these folders, its own temp folder and, for a gpg signature, gpg's. */
export function gitWallSpec(input: GitWallInput, platform: NodeJS.Platform = process.platform): WallSpec {
  const gnupg = input.gnupg ?? null;
  // macOS holds a pattern; Linux can hold only a file that is there.
  const confs = gnupg === null ? [] : platform === 'linux' ? gpgConfFiles(gnupg.home) : ['*.conf', '*.conf.*', '*.conf-*'].map((name) => join(gnupg.home, name));
  const writable = [...input.writable, input.temp, ...(gnupg === null ? [] : [gnupg.home, ...(gnupg.sockets === null ? [] : [gnupg.sockets])])];
  return { writable: [...new Set(writable)], hidden: [], writeDenied: [...input.closed, ...confs], envRoots: [], envExceptions: [], systemTemp: false };
}

export const gpgConfFiles = (home: string): string[] => {
  try {
    return readdirSync(home)
      .filter((name) => GPG_CONF.test(name))
      .map((name) => join(home, name));
  } catch {
    return [];
  }
};

/**
 * gpg's own folder, where it keeps its lock and, on macOS, its agent's socket, or null when it is not
 * there. On Linux the agent's sockets sit in the runtime folder.
 */
export function gnupgFolders(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Gnupg | null {
  const home = env.GNUPGHOME ?? (env.HOME === undefined ? undefined : join(env.HOME, '.gnupg'));
  const real = home === undefined ? null : realOrNull(home);
  if (real === null) return null;
  const runtime = env.XDG_RUNTIME_DIR ?? (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : undefined);
  return { home: real, sockets: platform === 'linux' && runtime !== undefined ? realOrNull(join(runtime, 'gnupg')) : null };
}

/**
 * Starts gpg's agent outside the wall before a walled call signs, so the agent the signer talks to
 * is not one the walled gpg started, which would live on inside the wall after the call. A failure
 * is left to the signer to report.
 */
export function launchGpgAgent(env: Record<string, string>): void {
  const gpgconf = findExecutable('gpgconf', env.PATH ?? '');
  if (gpgconf !== null) spawnSync(gpgconf, ['--launch', 'gpg-agent'], { env, stdio: 'ignore', timeout: 5000 });
}

/**
 * Linux, before a walled write: the paths bubblewrap must hold but cannot while they are not there.
 * The `info` and `hooks` folders are made, and each `config.worktree` made empty, which git reads as no settings
 * (and only at all with `extensions.worktreeConfig` on), so both are held read-only. A command that
 * writes the config keeps its `config.worktree` writable, and none is made for it.
 */
export function linuxHolds(places: RepoPlaces, config: boolean): void {
  const there = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  for (const folder of ['info', 'hooks']) if (!there(join(places.commonDir, folder))) mkdirSync(join(places.commonDir, folder));
  if (config) return;
  for (const file of new Set([join(places.commonDir, 'config.worktree'), join(places.gitDir, 'config.worktree')])) {
    if (!there(file)) writeFileSync(file, '', { flag: 'wx' });
  }
}

/**
 * What a git write may not leave behind: a `commondir` in the shared git folder, a `config.worktree`
 * or an `info/attributes`, a new entry in the shared `hooks` folder, and a gpg config file, none of
 * which git writes for Nolzu. Read before the
 * call; the returned check, run after it, removes any that is new, marks the repository and gives
 * the sentence, or null. It holds where the wall cannot: on Linux for a path that was not there, and
 * where no wall starts at all.
 */
export function leftBehind(places: RepoPlaces, config: boolean, gnupg: string | null): () => string | null {
  const paths = [join(places.commonDir, 'commondir'), join(places.commonDir, 'info', 'attributes'), ...(config ? [] : [join(places.commonDir, 'config.worktree'), join(places.gitDir, 'config.worktree')])];
  const hooks = join(places.commonDir, 'hooks');
  const entries = (folder: string): string[] => {
    try {
      return readdirSync(folder).map((name) => join(folder, name));
    } catch {
      return [];
    }
  };
  const now = () => [...[...paths, hooks].filter((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined), ...entries(hooks), ...(gnupg === null ? [] : gpgConfFiles(gnupg))];
  const before = new Set(now());
  return () => {
    const made = now().filter((path) => !before.has(path));
    if (made.length === 0) return null;
    for (const path of made) rmSync(path, { recursive: true, force: true });
    const reason = `${made.join(', ')} appeared during Nolzu's git call, and git writes no such file for Nolzu, so a hook or a program git started made it. Nolzu removed it and stops writing in this repository until it starts again. Check the repository's hooks and the programs its git config names.`;
    markRepo(places.commonDir, reason);
    return reason;
  };
}

// gpg signs for the formats `openpgp`, the default, and `x509`; an ssh signature needs no gpg folder.
export const GPG_FORMATS = new Set(['', 'openpgp', 'x509']);

// bubblewrap opens only a path that is there, and a folder git is about to make is not yet: the
// nearest folder above it that is there stands in. It holds no more than the record allows, because
// every such folder is under the project.
export const thereOrAbove = (path: string): string => {
  let at = resolve(path);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
};

// A repository whose places did not match Nolzu's record, by its shared git folder, with the sentence
// it was refused with. Its later writes are refused the same way until Nolzu restarts. Keyed by the
// real folder the shared one sits in, so a record that names the project through a link and one that
// names it as git does are the same repository, and a `.git` swapped for a link keeps its key.
// Limit: held in memory only, and nothing lets the person clear it but a restart.
const marked = new Map<string, string>();
const markKey = (commonDir: string): string => {
  const at = resolve(commonDir);
  return join(realOrNull(dirname(at)) ?? dirname(at), basename(at));
};
export const markedRepo = (commonDir: string): string | undefined => marked.get(markKey(commonDir));
export const markRepo = (commonDir: string, reason: string): void => {
  marked.set(markKey(commonDir), reason);
};

/** Whether Nolzu's git can write inside a wall here: the run wall can start, and Nolzu runs in no sandbox. */
export const gitWallReady = (here: WallReady): WallReady =>
  process.env.CODEX_SANDBOX !== undefined ? { ready: false, reason: 'Nolzu runs inside a sandbox, and a second wall cannot start inside it.' } : here;

/** The line on Settings, Wall that says whether Nolzu's own git writes inside a wall on this machine. */
export const gitWallLine = (here: WallReady): string =>
  here.ready
    ? "Nolzu's own git writes inside a wall too: a commit, a branch or a checkout it makes may write only in that repository and a temp folder of its own, never in the repository's config or hooks, and so may any hook it runs."
    : `Nolzu's own git runs without a wall on this machine, because the wall cannot start here. ${here.reason}`;
