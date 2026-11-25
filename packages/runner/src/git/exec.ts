import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { linkBeforeWrite } from './links.ts';

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
const GIT_FLAGS = [
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
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  // A link a run left where git writes by name would have this call write the file it points to, here
  // outside the wall (`linkBeforeWrite`). Refused like any git failure, with the sentence as stderr.
  const link = linkBeforeWrite(args, options.cwd, options.env);
  if (link !== null) return Promise.resolve({ code: 128, stdout: '', stderr: link });
  return args[0] === 'add' ? addWithoutGitlinks(args, options) : spawnGit(withFlags(args), options);
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
async function addWithoutGitlinks(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const index = await spawnGit(['ls-files', '--stage', '-z', '--full-name', '--', ':/'], { cwd: options.cwd, env: options.env, signal: options.signal });
  if (index.code !== 0) return index;
  const skip = index.stdout
    .split('\0')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => `:(top,exclude,literal)${line.slice(line.indexOf('\t') + 1)}`);
  return spawnGit(skip.length === 0 ? args : [...args, ...(args.includes('--') ? [] : ['--']), ...skip], options);
}

function spawnGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
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
    const child = spawn(binary, [...GIT_FLAGS, ...(options.hooks === true ? [] : NO_HOOKS), ...args], {
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
