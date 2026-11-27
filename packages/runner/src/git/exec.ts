import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { kindOf, wallHere, type WallReady } from '../wall-detect.ts';
import { wallCommand, type WallSpec } from '../wall.ts';
import { type GitCall, gitCall, gitKind, madeFolders } from './commands.ts';
import { closedGitPaths, CONFIG_WITH_HOOKS, gitWallReady, gitWallSpec, gnupgFolders, GPG_FORMATS, HOOK_IN_WALL, launchGpgAgent, leftBehind, linuxHolds, markedRepo, markRepo, NO_PLACE, thereOrAbove, WALL_REFUSED, writesConfig } from './git-wall.ts';
import { linkBeforeWrite } from './links.ts';
import { type ExpectedPlaces, type RepoPlaces, repoPlaces } from './places.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  // Stop reading once stdout passes this many characters, and kill the child. The one caller that
  // pipes a file's own content through here needs it: a patch of half a gigabyte would otherwise
  // sit in the runner's memory, and past node's string limit the join below throws inside the data
  // handler, where no promise can catch it.
  maxStdout?: number;
  // True runs the repository's git hooks. Only a commit or a push the person turned hooks on for, and
  // the first commit of a new workspace, which no run has written yet, pass it.
  hooks?: boolean;
  // The folder Nolzu owns the call happens in, the project or the workspace, for a call that makes a
  // folder (`linkBeforeWrite`). Left out, the folder the call runs in.
  owner?: string;
  // The repository a write works in, from Nolzu's own record. Every write names one: git then writes
  // inside a wall that allows only its folders, and git is pinned to them (`gitWrite`).
  repo?: ExpectedPlaces;
}

// What `spawnGit` adds for a walled write: the wall, and what detection found.
interface Walled {
  wall?: { spec: WallSpec; ready: WallReady & { ready: true } };
}

// The one place that spawns git. It never throws on a non-zero exit, because git reports
// normal states that way: nothing to commit, a non fast forward push, a path that is not a
// repository. A helper that threw would turn each of those into a crash. Callers read the
// code and decide.
// A child killed by a signal carries no exit code. Reporting that as zero let a caller read empty
// output as a real answer, and the worktree cleanup then read an unreadable list as nobody owning
// the path, which is the most destructive reading available to it.
export const exitCode = (code: number | null, signal: NodeJS.Signals | null): number =>
  code !== null ? code : signal !== null ? 128 : 0;

// fsmonitor names a command git runs on a plain status. A run that got a config past the wall, or
// pointed the checkout at a repository of its own, would have Nolzu run it outside the wall.
// The submodule settings are for a folder in the checkout that holds a repository of its own, at any
// depth. git checks such a folder by running git inside it, under that repository's config, which a
// writable run can write: a filter named there runs on every file git reads. `dirty` keeps status and
// diff out of it and still shows a moved pointer. The other three overrule a person's global config
// that would send checkout, pull, fetch or diff inside as well. A `.gitmodules` the run writes beats
// this setting, so status and diff also take the flag, which beats `.gitmodules` (`withFlags`).
// A folder that holds `HEAD`, `objects` and `refs` is a repository to git with no `.git` name at all,
// and a run can write one where Nolzu's git later looks. `safe.bareRepository=explicit` makes git
// refuse such a folder unless a caller names it with GIT_DIR, which Nolzu does only for a repository
// it found before the run (git 2.38 and newer). `push.recurseSubmodules=no` keeps a push from pushing
// or checking a repository a run made inside the checkout, whatever a config asks.
export const GIT_FLAGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.ignoreSubmodules=dirty',
  '-c',
  'submodule.recurse=false',
  '-c',
  'fetch.recurseSubmodules=false',
  '-c',
  'diff.submodule=short',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'push.recurseSubmodules=no',
];

// On every call unless `hooks` is true. A run can write .husky, lefthook.yml or a lint-staged entry
// in its own checkout, and git would run them here, outside the wall: on a commit or a push, and on
// a merge, a checkout or any ref update through post-checkout or reference-transaction. One empty
// hooks folder covers every hook manager, because each one is started from a git hook.
export const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

const refused = (stderr: string): GitResult => ({ code: 128, stdout: '', stderr });

export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const kind = gitKind(args);
  if (kind === 'write') return writeGit(args, options);
  if ((kind === 'network' || kind === 'network-read') && options.repo !== undefined) return pinnedGit(args, options, options.repo);
  // A link a run left where git writes by name would have this call write the file it points to, here
  // outside the wall (`linkBeforeWrite`). Refused like any git failure, with the sentence as stderr.
  const link = linkBeforeWrite(args, options.cwd, options.env, options.owner);
  if (link !== null) return Promise.resolve(refused(link));
  return run(args, options);
}

const run = (args: readonly string[], options: GitOptions & Walled): Promise<GitResult> => (args[0] === 'add' ? addWithoutGitlinks(args, options) : spawnGit(withFlags(args), options));

export type PreparedWrite =
  | { refused: string }
  // `after` runs once git is done: it removes what a hook left where git writes nothing (`leftBehind`).
  | { env: Record<string, string>; spec: WallSpec | null; ready: WallReady; temp: string | null; after: () => string | null };

// The places of a repository checked as for a write, or the refusal, which marks it.
async function checked(place: ExpectedPlaces, env: Record<string, string>, signal?: AbortSignal): Promise<RepoPlaces | { refused: string }> {
  if (place.refuse !== undefined) {
    markRepo(place.commonDir ?? join(place.workTree, '.git'), place.refuse);
    return { refused: place.refuse };
  }
  const common = place.commonDir ?? join(place.workTree, '.git');
  const before = markedRepo(common);
  if (before !== undefined) return { refused: before };
  const found = await repoPlaces(place, env, signal);
  if (found.ok) return found.places;
  if (found.missing !== true) markRepo(common, found.reason);
  return { refused: found.reason };
}

const plainEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) copy[name] = value;
  return copy;
};
const pins = (places: RepoPlaces) => ({ GIT_DIR: places.gitDir, GIT_WORK_TREE: places.workTree, GIT_COMMON_DIR: places.commonDir });

/**
 * Network git in a repository Nolzu has a record of: checked as a write is, and pinned to the checked
 * folders, so a `commondir` or a `.git` a hook left cannot lead it to another config. It still runs
 * without a wall.
 */
async function pinnedGit(args: readonly string[], options: GitOptions, place: ExpectedPlaces): Promise<GitResult> {
  const env = plainEnv(options.env ?? process.env);
  const places = await checked(place, env, options.signal);
  if ('refused' in places) return refused(places.refused);
  const pinned = { ...env, ...pins(places) };
  const link = linkBeforeWrite(args, options.cwd, pinned, options.owner);
  if (link !== null) return refused(link);
  return run(args, { ...options, env: pinned });
}

// The checkout a `worktree remove` names, as written, or undefined.
const removed = (call: GitCall): string | undefined => (call.command === 'worktree' && call.rest[0] === 'remove' ? call.rest.slice(1).filter((arg) => !arg.startsWith('-')).at(-1) : undefined);

/**
 * How a local git write runs: the places of its repository checked against Nolzu's record, git pinned
 * to them with GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR so it cannot find other folders between the
 * check and the write, and the wall that allows writes only there and in a temp folder of the call's
 * own (`temp`, which the caller removes). A repository whose places did not match is refused again on
 * every later write (`markRepo`). Where no wall can start, `spec` is null and git runs as it did
 * before the wall. `here` is what detection found, passed only by a test.
 */
export async function gitWrite(args: readonly string[], options: GitOptions, here?: WallReady): Promise<PreparedWrite> {
  const place = options.repo;
  if (place === undefined) {
    // Loud in the tests, so a caller that names no repository fails there and never reaches a person.
    if (process.env.VITEST !== undefined) throw new Error(`${NO_PLACE} git ${args.join(' ')}`);
    return { refused: NO_PLACE };
  }
  const call = gitCall(args, options.cwd);
  const config = writesConfig(call);
  if (config && options.hooks === true) {
    if (process.env.VITEST !== undefined) throw new Error(`${CONFIG_WITH_HOOKS} git ${args.join(' ')}`);
    return { refused: CONFIG_WITH_HOOKS };
  }
  const env = plainEnv(options.env ?? process.env);
  // A folder the call makes, from the folder Nolzu owns it in, with no link followed past that one:
  // a link swapped in later leads outside the wall, and the wall refuses the write.
  const owner = resolve(options.owner ?? options.cwd);
  const wanted = madeFolders(call);
  let made: string[];
  try {
    made = wanted.length === 0 ? [] : wanted.map((folder) => join(realpathSync(owner), relative(owner, resolve(call.folder, folder))));
  } catch {
    return { refused: `${owner} is not there, so git could not run in it.` };
  }
  let writable: string[];
  let closed: string[] = [];
  let places: RepoPlaces | null = null;
  if (call.command === 'init') {
    // A new repository: nothing to check yet, and the new folder is all it may write.
    writable = made;
  } else {
    const found = await checked(place, env, options.signal);
    if ('refused' in found) return found;
    places = found;
    const { workTree, gitDir, commonDir } = found;
    Object.assign(env, pins(found));
    writable = [workTree, gitDir, commonDir, ...made];
    closed = closedGitPaths(found, config);
    // The checkout a removal deletes, only from the project's own checkouts folder.
    const gone = removed(call);
    if (gone !== undefined) {
      const checkouts = join(realpathSync(place.project), 'worktrees');
      const at = resolve(call.folder, gone);
      const step = [relative(join(resolve(place.project), 'worktrees'), at), relative(checkouts, at)].find((one) => one !== '' && !one.startsWith('..') && !isAbsolute(one));
      if (step === undefined) return { refused: `${gone} is not a checkout in ${join(place.project, 'worktrees')}, so Nolzu did not remove it.` };
      writable.push(join(checkouts, ...step.split(sep)));
    }
  }
  const link = linkBeforeWrite(args, options.cwd, env, options.owner);
  if (link !== null) return { refused: link };
  const ready = gitWallReady(here ?? wallHere());
  const after = (gnupg: string | null) => (places === null ? () => null : leftBehind(places, config, gnupg));
  if (!ready.ready) return { env, spec: null, ready, temp: null, after: after(null) };
  // gpg keeps a lock and, on macOS, its agent's socket in its own folder, so a repository that signs
  // with gpg needs it. An ssh signature needs none.
  const read = (key: string, type = '') => spawnGit(['config', ...(type === '' ? [] : [type]), '--get', key], { cwd: options.cwd, env, signal: options.signal });
  const signs = (call.command === 'commit' || call.command === 'merge') && (await read('commit.gpgsign', '--type=bool')).stdout.trim() === 'true' && GPG_FORMATS.has((await read('gpg.format')).stdout.trim());
  const gnupg = signs ? gnupgFolders(env) : null;
  // Before the temp folder below, so the agent keeps none of the call's.
  if (gnupg !== null) launchGpgAgent(env);
  // A temp folder of the call's own, so git and its programs write in no shared one.
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-git-')));
  Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp });
  const linux = process.platform === 'linux';
  if (linux && places !== null) linuxHolds(places, config);
  const there = (paths: string[]) => (linux ? paths.map(thereOrAbove) : paths);
  return { env, spec: gitWallSpec({ writable: there(writable), closed, temp, gnupg }), ready, temp, after: after(gnupg?.home ?? null) };
}

async function writeGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const prepared = await gitWrite(args, options);
  if ('refused' in prepared) return refused(prepared.refused);
  let result: GitResult;
  try {
    result =
      prepared.spec === null || !prepared.ready.ready
        ? await run(args, { ...options, env: prepared.env })
        : await run(args, { ...options, env: prepared.env, wall: { spec: prepared.spec, ready: prepared.ready } });
  } finally {
    if (prepared.temp !== null) rmSync(prepared.temp, { recursive: true, force: true });
  }
  const left = prepared.after();
  if (left !== null) return { code: 128, stdout: result.stdout, stderr: left };
  return options.hooks === true && prepared.spec !== null && result.code !== 0 && WALL_REFUSED.test(result.stderr) ? { ...result, stderr: `${result.stderr.trimEnd()}\n${HOOK_IN_WALL}` } : result;
}

// The subcommand sits past any `-C <folder>` or `-c <setting>` the caller put first.
// A textconv or an external diff driver is a command a config names, keyed by a path pattern in
// `.gitattributes`, which a run can write. With `diff.json.textconv` in the person's own config, a run
// that wrote a `json.py` in its checkout had its code run when Nolzu read the diff. So every command
// that can print a patch gets both turned off.
const PATCH_FLAGS = ['--no-textconv', '--no-ext-diff'];
const EXTRA: Record<string, readonly string[]> = {
  status: ['--ignore-submodules=dirty'],
  diff: ['--ignore-submodules=dirty', ...PATCH_FLAGS],
  show: PATCH_FLAGS,
  log: PATCH_FLAGS,
};
function withFlags(args: readonly string[]): readonly string[] {
  let at = 0;
  while (args[at] === '-C' || args[at] === '-c') at += 2;
  const extra = Object.hasOwn(EXTRA, args[at] ?? '') ? EXTRA[args[at] ?? ''] : undefined;
  return extra === undefined ? args : [...args.slice(0, at + 1), ...extra, ...args.slice(at + 1)];
}

// git by its full path, from the absolute PATH entries only. spawn by name searches every entry, and
// one such as `node_modules/.bin` is relative: it resolves against the working folder, which is a
// checkout a run may write, so a planted `node_modules/.bin/git` would run outside the wall. Found once
// per PATH value.
const found = new Map<string, string | null>();
export function gitBinary(path: string | undefined): string | null {
  const key = path ?? '';
  if (found.has(key)) return found.get(key) ?? null;
  let binary: string | null = null;
  for (const dir of key.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, 'git');
    try {
      accessSync(file, constants.X_OK);
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    binary = file;
    break;
  }
  found.set(key, binary);
  return binary;
}

const NO_GIT = 'git was not found on the PATH. Install git, or check the PATH resolved from the login shell.';
// An environment with no PATH at all searches Nolzu's own, as spawn by name did.
const pathOf = (env: Record<string, string | undefined> | undefined): string | undefined => env?.PATH ?? process.env.PATH;

// `add` ignores diff.ignoreSubmodules and looks inside every nested repository its paths reach, so each
// one in the index is left out by name. Nolzu never commits a pointer to another repository anyway.
async function addWithoutGitlinks(args: readonly string[], options: GitOptions & Walled): Promise<GitResult> {
  const index = await spawnGit(['ls-files', '--stage', '-z', '--full-name', '--', ':/'], { cwd: options.cwd, env: options.env, signal: options.signal });
  if (index.code !== 0) return index;
  const skip = index.stdout
    .split('\0')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => `:(top,exclude,literal)${line.slice(line.indexOf('\t') + 1)}`);
  return spawnGit(skip.length === 0 ? args : [...args, ...(args.includes('--') ? [] : ['--']), ...skip], options);
}

function spawnGit(args: readonly string[], options: GitOptions & Walled): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('The git call was aborted.'));
      return;
    }

    const binary = gitBinary(pathOf(options.env));
    if (binary === null) {
      reject(new Error(NO_GIT));
      return;
    }
    // quotepath off here and nowhere else, so every caller reads a real path and no caller
    // has to remember the flag.
    const full = [...GIT_FLAGS, ...(options.hooks === true ? [] : NO_HOOKS), ...args];
    // The paths of a walled write are real already, so the wall gets them as they are: resolving them
    // again here would follow a link swapped in since the check.
    const walled = options.wall === undefined ? null : wallCommand(process.platform, options.wall.spec, binary, full, { kindOf, envFiles: [], bwrap: options.wall.ready.binary });
    if (walled !== null && 'refused' in walled) {
      resolve({ code: 128, stdout: '', stderr: walled.refused });
      return;
    }
    const child = spawn(walled?.command ?? binary, walled?.args ?? full, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Streamed rather than buffered to a fixed size, so a large diff or blob arrives whole.
    child.stdout.on('data', (chunk: string) => {
      if (options.maxStdout !== undefined && stdout.length >= options.maxStdout) {
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        // spawn answers with this code for a working folder that is not there as well as for a
        // binary that is not there, and the wrong one of those sends a person looking for an
        // installation problem they do not have.
        if (!existsSync(options.cwd)) {
          reject(new Error(`${options.cwd} is not there, so git could not run in it.`));
          return;
        }
        reject(new Error(NO_GIT));
        return;
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      resolve({ code: exitCode(code, signal), stdout, stderr });
    });
  });
}

// The commit a repository folder has at `rev`, short, with its date, for the prompt line that says
// which code a run reads. Sync, because a job is built in one go. Null for a folder that is not the
// top of a repository (git would walk up to a parent one), a rev that is not there, or any failure.
export function commitAt(folder: string, env: Record<string, string>, rev = 'HEAD'): { sha: string; date: string } | null {
  if (!existsSync(join(folder, '.git'))) return null;
  const binary = gitBinary(pathOf(env));
  if (binary === null) return null;
  const result = spawnSync(binary, [...GIT_FLAGS, 'log', '-1', '--format=%h %cs', rev, '--'], { cwd: folder, env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const read = result.status === 0 ? /^([0-9a-f]{7,40}) (\d{4}-\d{2}-\d{2})$/.exec(result.stdout.trim()) : null;
  return read === null ? null : { sha: read[1] ?? '', date: read[2] ?? '' };
}
