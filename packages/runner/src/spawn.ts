import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { PHASE_POLICIES, type PhasePolicy, policyFor, type RunPlace, startsInCardFolder, vendorRefusal, type WallState } from '@nolzu/core';
import { resolveDataDir } from '@nolzu/core/node';
import { CONFIG_DIR_VAR, type EngineName, type EngineProfile, type Job } from '@nolzu/protocol';
import { claudeArgs } from './claude-args.ts';
import { codexArgs, codexMcp } from './codex-args.ts';
import { codexModelList } from './codex-models.ts';
import { codexRefusals } from './codex.ts';
import { cursorArgs } from './cursor-args.ts';
import { cursorFailure } from './cursor.ts';
import { cursorModels } from './cursor-models.ts';
import { engineEnv, packageCaches } from './engine-env.ts';
import { CHECKOUT_WRITE_DENIED, linuxStateOf, ownSandbox, sessionFoldersOf, systemHome, wallSpecFor, watchedFilesOf } from './engine-walls.ts';
import { noteLine } from './log.ts';
import { RunHalted } from './run.ts';
import { removeCardFile, writeCardFile, writeOwnFile } from './card-files.ts';
import { INSTRUCTIONS_FILE, PROMPT_FILE } from './prompt.ts';
import { findExecutable } from './shell-env.ts';
import { gitLinkIn, gitLinkSentence } from './git/links.ts';
import { childRepos, gitCommonDir, gitDirs, gitPointers, resolvedPath, specOnDisk, walledCommand, wallHere } from './wall-detect.ts';
import { checkedWallLists } from './wall-lists.ts';
import { inFolder, writeMcpConfig } from './mcp-config.ts';
import { writablePath } from './project/writable.ts';
import { SANDBOX_EXEC, type WallCommand, type WallSpec } from './wall.ts';

// The wall a run starts in: the engine command in, the walled command or a refusal out.
export type WallPort = (spec: WallSpec, command: string, args: readonly string[]) => WallCommand;

export interface SpawnOptions {
  // How long a stuck process may hold a run up, both between the polite signal and the kill, and
  // between the engine's exit and the moment Nolzu stops reading a pipe a tool still holds.
  killGraceMs?: number;
  // The environment the engine's own is built from. The process environment when not given.
  env?: Record<string, string | undefined>;
  // The login this run belongs to, looked up from `job.engine` by the caller that holds the
  // settings. Without one the vendor's own config folder is used, which is the single-profile
  // case. It is passed rather than read here, because the runner holds no settings.
  profile?: EngineProfile | null;
  // Tests only: a double that records the wall or refuses it, because CI has no bubblewrap. Nothing
  // a person sets reaches this field, and no variable turns the wall off.
  wall?: WallPort;
  // Tests only: what the wall probe found. Left out, the probe answers, and a double above stands
  // in for a wall that starts.
  wallState?: WallState;
}

const wallStateOf = (options: SpawnOptions): WallState => options.wallState ?? (options.wall !== undefined ? { ready: true } : wallHere());

const placeOf = (job: Job, options: SpawnOptions): RunPlace => ({ outsideGit: job.outsideGit === true, wall: wallStateOf(options) });

// A failing run can print megabytes. The end is the part that names the problem.
const STDERR_TAIL = 4000;
const KILL_GRACE_MS = 5000;
// Short enough that a tool which goes quietly costs nothing, long enough not to spin.
const GROUP_POLL_MS = 25;
// A child that is already exiting needs a moment to have that exit delivered. Signalling inside
// that moment replaces its own status with the signal, and the crash is then gone for good.
const SELF_EXIT_MS = 10;

const canEnter = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// A worktree that is gone, that is not a folder, or that cannot be entered is reported against the
// binary, because the path on the error names the binary either way. Telling someone to reinstall
// an engine that works sends them the wrong way.
function startupError(error: NodeJS.ErrnoException, name: string, binary: string, cwd: string): Error {
  if (error.code === 'ENOENT' && !existsSync(cwd)) {
    return new Error(`The worktree ${cwd} is not there, so the run cannot start. Move the card back and forward again to make a new one.`);
  }
  if (error.code === 'ENOTDIR' || (error.code === 'EACCES' && !canEnter(cwd))) {
    return new Error(`The worktree ${cwd} cannot be opened, so the run cannot start. Check that it is a folder you can enter.`);
  }
  if (error.code === 'ENOENT') {
    return new Error(`The ${name} engine was not found at ${binary}. Install ${name}, or check the PATH the login shell reports.`);
  }
  if (error.code === 'EACCES') {
    return new Error(`The ${name} engine at ${binary} cannot be run. Check that it is a file with the execute bit set.`);
  }
  // Node's message quotes the bad value, which may be a server's secret, and it becomes the run's reason.
  if (error.code === 'ERR_INVALID_ARG_VALUE') {
    return new Error(`The ${name} engine cannot start: a value in its arguments or environment holds a null byte. Check the values of the MCP servers on Settings, MCP servers.`);
  }
  return error;
}

// A worktree that is not there is spawn's to report, with the sentence written for it above, so
// this hands the path back as it came rather than failing first with a bare errno.
function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface ProcessSpec {
  // The engine's product name, for the sentences a failed start prints.
  name: string;
  binary: string;
  // The engine itself when `binary` is the wall around it, for the sentences a failed start prints.
  engineBinary?: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  // The prompt, written to stdin and then closed. Both engines take it there rather than in the
  // argument list, so it cannot show up in a process listing, and Codex waits for a stdin that is
  // never closed.
  stdin: string;
  // Lines Nolzu adds to the stream once the process has ended, read off its stderr.
  afterExit?: (stderr: string) => readonly string[];
  // The sentence a failed run gets instead of the engine's own, read off its stderr, or null to
  // keep the engine's. It is for a failure a person can act on, such as a login a plan refuses.
  failureText?: (stderr: string) => string | null;
  // A sentence that fails the run once the process has ended, even one that gave its result or was
  // stopped, or null when all is well. It is for something the run left on disk that makes Nolzu's
  // next step unsafe.
  afterRun?: () => string | null;
  killGraceMs?: number;
  // The first line of the stream, which says what holds the run.
  firstLine?: string;
  // Called with each line the engine prints, before it is handed on.
  onLine?: (line: string) => void;
}

function wallName(command: string): string | null {
  if (command === SANDBOX_EXEC) return 'macOS sandbox-exec';
  if (basename(command) === 'bwrap') return 'bubblewrap';
  return null;
}

// Inside the wall a missing engine is the wall's own exit code, so it is looked for first and gets
// the sentence spawn would have given it.
function engineMissing(spec: ProcessSpec): Error | null {
  if (!existsSync(spec.cwd)) return null;
  const found = spec.binary.includes('/') ? (existsSync(spec.binary) ? spec.binary : null) : findExecutable(spec.binary, spec.env.PATH ?? '');
  if (found === null) return startupError(Object.assign(new Error('missing'), { code: 'ENOENT' }), spec.name, spec.binary, spec.cwd);
  return canEnter(found) ? null : startupError(Object.assign(new Error('denied'), { code: 'EACCES' }), spec.name, spec.binary, spec.cwd);
}

export const POINTER_CHANGED = "The run changed the checkout's git pointer; Nolzu stopped before running git there.";

// The wall holds the git pointers of a checkout a run may write, and this checks that it did, before
// Nolzu runs git there again. On Linux it is the only check of a pointer file that was not there yet.
function pointerCheck(checkout: string): () => string | null {
  const before = gitPointers(checkout);
  return () => (gitPointers(checkout) === before ? null : POINTER_CHANGED);
}

// A run that may write the checkout's git folders may leave a link where git writes by name, and
// Nolzu's next commit or pull would write through it outside the wall. macOS refuses a new link there,
// but not a folder moved in with one inside, and Linux refuses neither, so this looks after every such
// run, in the checkout and each repository one folder down.
function linkCheck(checkout: string): () => string | null {
  return () => {
    for (const tree of [checkout, ...childRepos(checkout)]) {
      const dirs = gitDirs(tree);
      const found = dirs === undefined ? null : gitLinkIn(dirs);
      if (found !== null) return gitLinkSentence(found);
    }
    return null;
  };
}

// A file read whole, or null when it is not there or is no plain file, so a pipe or a device a run left
// at the name answers at once and is never read. With `follow` false a link at the name is null too.
function readPlain(path: string, follow: boolean): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW));
  } catch {
    return null;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
// An engine's own file, which a person may keep as a link to their dotfiles, so a link is followed.
const readOrNull = (path: string): Buffer | null => readPlain(path, true);
// A file in a checkout or its git folder, which the run may write: the caller checks the folders on the
// way (`realFolders`), and a link at the name is not followed.
const readOwnOrNull = (path: string): Buffer | null => readPlain(path, false);

// The engine files every run may write that still start something later outside the wall, such as
// the MCP servers in `~/.claude.json`, compared before and after the run.
function watchedCheck(vendor: EngineName, spec: ProcessSpec, options: SpawnOptions): () => string | null {
  const variable = CONFIG_DIR_VAR[vendor];
  const files = watchedFilesOf({ vendor, home: (options.env ?? process.env).HOME ?? homedir(), configDir: spec.env[variable] ?? null });
  const before = files.map((file) => file.part(readOrNull(file.path)));
  return () => {
    const changed = files.find((file, at) => file.part(readOrNull(file.path)) !== before[at]);
    return changed === undefined ? null : watchedChanged(changed.what, changed.path);
  };
}

export const addedToState = (paths: readonly string[]): string =>
  `The run created or replaced ${paths.join(', ')}, which the wall cannot hold on Linux and which may start something later outside the wall. Nolzu stopped the card. Check ${paths.length === 1 ? 'it' : 'each one'} before you use the engine again.`;

// Every check's sentence, so a second problem is not lost behind the first, or null when all is well.
const joinedHalts = (halts: readonly (string | null)[]): string | null => {
  const said = halts.filter((halt): halt is string => halt !== null);
  return said.length === 0 ? null : said.join(' ');
};

// The names in a folder, or null when it cannot be read.
function namesIn(folder: string): string[] | null {
  try {
    return readdirSync(folder);
  } catch {
    return null;
  }
}

// What an entry is, so one removed and made again under its old name shows: its inode, and a link's
// target. `gone` when there is none.
function identityOf(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return `${stat.dev}:${stat.ino}`;
    // A link's target too: a run may move the folder that holds it and put another file there.
    let target = 'none';
    try {
      const followed = statSync(path);
      target = `${followed.dev}:${followed.ino}`;
    } catch {
      // A link to nothing stays a link to nothing, or the compare shows the change.
    }
    return `${stat.dev}:${stat.ino}:${readlinkSync(path)}:${target}`;
  } catch {
    return 'gone';
  }
}

// A temp file the engine saves a session file through, `<file>.<pid>.<id>.tmp`, left by a run that
// stopped between the write and the rename.
const savedThrough = (name: string, session: readonly string[]): boolean => session.some((file) => name.startsWith(`${file}.`) && /^\.[0-9]+\.[0-9a-f-]+\.tmp$/.test(name.slice(file.length)));

export const watchedChanged = (what: string, path: string): string =>
  `The run changed ${what} ${path}, which runs later outside the wall. Nolzu stopped the card. Check that file before you use the engine again.`;

// Every run gets the engine file check, and a run that may write also the pointer check, under every
// wall: Nolzu's, none, or the engine's own sandbox.
function checked(vendor: EngineName, policy: PhasePolicy, job: Job, spec: ProcessSpec, options: SpawnOptions): ProcessSpec {
  const checks = [watchedCheck(vendor, spec, options), ...(policy.readOnly ? [] : [pointerCheck(physical(job.cwd)), linkCheck(physical(job.cwd))])];
  return { ...spec, afterRun: () => joinedHalts(checks.map((check) => check())) };
}

/**
 * The engine process inside Nolzu's wall, or an error when the wall cannot start.
 *
 * Where the probe says the wall cannot start, Claude Code runs every phase without it, held by its
 * guard hook, and Cursor runs Implement only; the first line of the log says so.
 * A read-only phase of Cursor never starts without the wall. A wall that was ready and still
 * refused stops the run before any process starts, with the wall's reason.
 */
function walled(vendor: EngineName, job: Job, policy: PhasePolicy, taskDir: string, given: ProcessSpec, options: SpawnOptions): ProcessSpec {
  const spec = checked(vendor, policy, job, given, options);
  const state = wallStateOf(options);
  if (!state.ready) {
    if (vendor !== 'claude-code' && policy.readOnly) throw new Error(state.reason);
    const guard = vendor === 'claude-code' && policy.readOnly ? ' The guard hook still holds Write and Edit to the card folder.' : '';
    return { ...spec, firstLine: noteLine(`Not walled. ${state.reason} Secret files such as ~/.ssh and .env are not hidden from this run.${guard}`) };
  }
  const platform = process.platform;
  const base = options.env ?? process.env;
  const home = base.HOME ?? homedir();
  const variable = CONFIG_DIR_VAR[vendor];
  const copy = job.qaCopy ?? null;
  const tmp = base.TMPDIR ?? tmpdir();
  // The project's own lists, checked again here, so an entry a hand edit put in the database is
  // left out with a line in the log and never loosens the wall.
  const project = physical(job.projectDir ?? job.cwd);
  const real = physical(job.cwd);
  const dataDir = resolveDataDir(process.env);
  const caches = packageCaches(dataDir);
  const runConfig = runConfigWall(vendor, job);
  const account = systemHome();
  const lists = checkedWallLists(job.walls ?? { hidden: [], exceptions: [], writable: [] }, {
    home,
    systemHome: account,
    project,
    gitDir: gitCommonDir(project) ?? join(project, '.git'),
    dataDir,
    needed: [taskDir, tmp, real, ...(copy === null ? [] : [copy]), ...(job.knowledgeDir == null ? [] : [job.knowledgeDir])],
    real: resolvedPath,
  });
  // A path of the project names the same path in the card's checkout too.
  const inProject = (path: string) => path !== project && path.startsWith(`${project}/`);
  const dirs = gitDirs(job.cwd);
  const onCheckout = (paths: readonly string[]) => (real === project ? paths : paths.flatMap((path) => (inProject(path) ? [path, join(real, relative(project, path))] : [path])));
  const input = {
    policy,
    vendor,
    cardDir: taskDir,
    knowledgeDir: policy.knowledge === true ? (job.knowledgeDir ?? null) : null,
    checkout: physical(copy ?? job.cwd),
    // The real checkout's git folder for a QA copy too, so the `.env` files of a worktree's main
    // project stay hidden from the copy's run as well.
    gitCommonDir: policy.readOnly && copy === null ? undefined : dirs?.common,
    gitOwnDir: policy.readOnly ? undefined : dirs?.own,
    childRepos: policy.readOnly ? [] : childRepos(real).flatMap((child) => [gitDirs(child)].flatMap((found) => (found === undefined ? [] : [{ checkout: child, ...found }]))),
    copyOf: copy === null ? undefined : physical(job.cwd),
    home,
    systemHome: account,
    tmp,
    exceptions: onCheckout(lists.exceptions),
    lists: { hidden: [...onCheckout(lists.hidden), ...runConfig.hidden], writable: lists.writable },
    platform,
    configDir: spec.env[variable] ?? null,
    caches: resolvedPath(caches.dir),
  };
  // The session folders under the config folder are opened, so one that holds the project or the home
  // folder could let a read-only phase write into the project, or another engine's state.
  if (input.configDir !== null) {
    const dir = resolve(input.configDir);
    const holds = (path: string) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);
    if (holds(input.checkout) || holds(resolve(home))) {
      throw new Error(`The profile's config folder ${dir} holds the project or the home folder, so the wall would let every run write there. Give the profile a folder of its own.`);
    }
  }
  let wallSpec: WallSpec = { ...wallSpecFor(input), reopened: runConfig.reopened };
  let appeared: string[] = [];
  let added = (): string | null => null;
  // The session folders are the engine's own, so making them changes nothing it would not make
  // itself. bwrap opens only a path that is there, and a macOS run may not make their parent. One
  // that cannot be made stays closed: the run loses a write, it never gains one.
  for (const folder of sessionFoldersOf(input)) {
    try {
      mkdirSync(folder, { recursive: true });
    } catch {
      continue;
    }
  }
  if (platform === 'linux') {
    // A missing session file, or a knowledge folder not made yet, stays closed: the run loses a
    // write, it never gains one.
    wallSpec = specOnDisk(wallSpec);
    // Limit: bwrap cannot hold a hook name in a writable checkout that is not there yet, and a
    // placeholder would put a file in the person's repository. So Implement may create one, and the
    // log names it after the run. The card is not failed for it. Upgrade: an overlay mount, or the
    // git compare after the run failing the card.
    if (!policy.readOnly) appeared = CHECKOUT_WRITE_DENIED.map((path) => join(input.checkout, path)).filter((path) => !existsSync(path));
    const open = linuxStateOf(input);
    const before = open === null ? null : namesIn(open.folder);
    // A folder that is not there stays closed, as `specOnDisk` dropped it. One Nolzu cannot read could
    // hide what a run adds, so the run does not start.
    if (open !== null && before === null && existsSync(open.folder)) {
      throw new Error(`Nolzu cannot read ${open.folder}, so the wall could not check what a run adds there. Check that folder's permissions, then start the card again.`);
    }
    if (open !== null && before !== null) {
      // macOS keeps every name in the folder closed but the session ones, so here every other entry
      // there now stays read-only, and a name the run adds is looked for after it. A link is held at
      // its target, and the link itself can be removed and made again, so each entry's identity is
      // compared too. A leftover temp name is not held: a run may finish its rename meanwhile.
      const held = before.filter((name) => !open.session.includes(name) && !savedThrough(name, open.session));
      const was = new Map(held.map((name) => [name, identityOf(join(open.folder, name))]));
      wallSpec = { ...wallSpec, writeDenied: [...wallSpec.writeDenied, ...held.map((name) => join(open.folder, name))] };
      added = () => {
        const now = namesIn(open.folder);
        if (now === null) return `Nolzu could not read ${open.folder} after the run, so it cannot check what the run added there. Nolzu stopped the card. Check that folder before you use the engine again.`;
        // Every one, so removing the first a message names does not leave the next one held as theirs.
        const names = [...now.filter((one) => !before.includes(one) && !open.session.includes(one) && !savedThrough(one, open.session)), ...held.filter((one) => identityOf(join(open.folder, one)) !== was.get(one))];
        return names.length === 0 ? null : addedToState(names.map((one) => join(open.folder, one)));
      };
    }
  }
  const out = (options.wall ?? walledCommand)(wallSpec, spec.binary, spec.args);
  if ('refused' in out) throw new Error(out.refused);
  const name = wallName(out.command);
  const dropped = lists.dropped.length === 0 ? '' : ` Left out of the project's wall lists: ${lists.dropped.join(' ')}`;
  if (name !== null) {
    const missing = engineMissing(spec);
    if (missing !== null) throw missing;
  }
  return {
    ...spec,
    afterRun: () => joinedHalts([spec.afterRun?.() ?? null, added()]),
    env: { ...spec.env, ...caches.env },
    binary: out.command,
    args: out.args,
    engineBinary: spec.binary,
    firstLine:
      name !== null ? noteLine(`Walled by ${name}.${dropped} Writable: ${wallSpec.writable.join(', ')}.`) : dropped === '' ? undefined : noteLine(dropped.trim()),
    afterExit: (stderr) => [
      ...(spec.afterExit?.(stderr) ?? []),
      ...appeared.filter((path) => existsSync(path)).map((path) => noteLine(`The run created ${path}, which the wall cannot hold on Linux. Check it before another tool opens this checkout.`)),
    ],
  };
}

// The data folder's one `mcp-runs` folder, where each run of every project keeps Claude Code's config
// for an attempt and Cursor's record of the file it merged into. The boot makes it with mode 700, so
// bubblewrap has a folder to hide. Every walled run hides it whole, a pass included. A Claude Code run
// with servers reads its own config inside the wall, so its wall opens that one folder again, read only
// (`WallSpec.reopened`), and no other run's folder ever shows, one made later included.
export const MCP_RUNS = 'mcp-runs';
export const mcpRunsFolder = (dataDir: string): string => join(dataDir, MCP_RUNS);

// Whether the job hands its engine any server: the loop gives every job an `mcp`, empty or not.
const hasServers = (job: Job): boolean => job.mcp !== undefined && Object.keys(job.mcp.stdio).length + Object.keys(job.mcp.remote).length > 0;

function runConfigWall(vendor: EngineName, job: Job): { hidden: string[]; reopened: string[] } {
  const runs = mcpRunsFolder(resolveDataDir(process.env));
  const own = vendor === 'claude-code' && hasServers(job) && job.mcp !== undefined && dirname(physical(job.mcp.dir)) === physical(runs) ? [physical(job.mcp.dir)] : [];
  return { hidden: [physical(runs)], reopened: own };
}

// The job as the engine sees it. A QA run starts in its throwaway copy (`job.qaCopy`), and its
// prompt names every path outside the copy in full. The card folder stays the real one.
const onCopy = (job: Job): Job => (job.qaCopy == null ? job : { ...job, cwd: job.qaCopy });

// What a Cursor run changed in the checkout, kept in the run's folder until it is put back, so a crash
// or a kill leaves a record `restoreCursorMcp` reads at the next start.
export const CURSOR_RECORD = 'cursor-restore.json';

interface CursorRecord {
  file: string;
  // The file's bytes before the merge, base64, or null when there was none.
  before: string | null;
  // The `.cursor` folder Nolzu made, removed with the file, or null.
  madeFolder: string | null;
  // The git exclude file of the checkout's repository, or null, and whether the line in it is Nolzu's:
  // added by this run, or by another run still going when this one started.
  exclude: string | null;
  added?: boolean;
  // A hash of what Nolzu wrote, and the names of its servers in it. A file that no longer matches was
  // changed meanwhile, by hand or by Cursor's settings, and keeps that change.
  wrote?: string;
  names?: string[];
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const EXCLUDE_LINE = '/.cursor/mcp.json';

const linesOf = (text: string): string[] => text.split('\n');

// Every record still on disk in the data folder's `mcp-runs`, but the one at `except`.
function otherRecords(except: string): CursorRecord[] {
  const runs = dirname(except);
  let found: string[];
  try {
    found = readdirSync(runs);
  } catch {
    return [];
  }
  return found.flatMap((name) => {
    if (join(runs, name) === except) return [];
    try {
      return [JSON.parse(readFileSync(join(runs, name, CURSOR_RECORD), 'utf8')) as CursorRecord];
    } catch {
      return [];
    }
  });
}

// Each folder from `root` down to the file is a real folder, not a link. The run that just ended could
// have put one in place of `.cursor` or the git folder's `info`, and a write or a removal would land
// outside.
const realFolders = (root: string, path: string): boolean => {
  const parts = path.split('/').slice(0, -1);
  return parts.every((_, at) => lstatSync(join(root, ...parts.slice(0, at + 1)), { throwIfNoEntry: false })?.isDirectory() === true);
};

// A write of Nolzu's into a checkout or its git folder, as `writeCardFile` writes a card folder: no
// link at a folder on the way, and none at the file.
function checkoutWrite(root: string, path: string, data: string | Buffer): void {
  if (!realFolders(root, path)) throw new Error(`${path} in ${root} leads through a link, so Nolzu did not write it.`);
  // No link from the root down, so the file's real folder is the root's real path and the folders after it.
  writeOwnFile(join(root, path), data, `${path} in ${root}`, join(realpathSync(root), dirname(path)));
}

// The file of a record as a root and a path under it: `.cursor/mcp.json` under the folder Cursor reads,
// and the exclude file under the folder that holds the git folder, so the git folder is checked too.
const MCP_FILE = '.cursor/mcp.json';
const mcpRoot = (file: string): string => dirname(dirname(file));
const excludeAt = (exclude: string): [string, string] => {
  const git = dirname(dirname(exclude));
  return [dirname(git), `${basename(git)}/info/exclude`];
};

/**
 * Puts back what a Cursor run merged, from its record, and removes the record. Each step is best
 * effort: a file whose folder is gone, such as a QA copy the sweep removed, is skipped, and the record
 * goes whatever happened, so a boot or the end of a run never stops on it. Only Nolzu's own exclude
 * line is taken out, and only when no other run's record still needs it, so two runs in two checkouts
 * of one repository and a line the person wrote meanwhile all stay as they are. False with no record.
 */
export function restoreCursorMcp(dir: string): boolean {
  const at = join(dir, CURSOR_RECORD);
  let record: CursorRecord;
  try {
    record = JSON.parse(readFileSync(at, 'utf8')) as CursorRecord;
  } catch {
    return false;
  }
  const step = (work: () => void) => {
    try {
      work();
    } catch {
      // The next step and the record's removal still run.
    }
  };
  // A write into a folder that is gone throws, and `step` lets it go.
  step(() => {
    const now = realFolders(mcpRoot(record.file), MCP_FILE) ? readOwnOrNull(record.file) : null;
    if (record.wrote !== undefined && now !== null && sha(now) !== record.wrote) {
      // Changed after the merge: only Nolzu's servers go, and one of the same name the file held
      // before comes back. A file that does not parse stays as it is.
      const changed = JSON.parse(now.toString('utf8')) as { mcpServers?: Record<string, unknown> };
      const before = record.before === null ? {} : ((JSON.parse(Buffer.from(record.before, 'base64').toString('utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
      const servers = { ...changed.mcpServers };
      for (const name of record.names ?? []) {
        if (name in before) servers[name] = before[name];
        else delete servers[name];
      }
      checkoutWrite(mcpRoot(record.file), MCP_FILE, `${JSON.stringify({ ...changed, mcpServers: servers }, null, 2)}\n`);
      return;
    }
    // A link at the file itself goes as a link.
    if (record.before === null) {
      if (realFolders(mcpRoot(record.file), MCP_FILE)) rmSync(record.file, { force: true });
    } else checkoutWrite(mcpRoot(record.file), MCP_FILE, Buffer.from(record.before, 'base64'));
  });
  // A folder Nolzu made loses its two files, and goes only when nothing else is left in it.
  const made = record.madeFolder;
  if (made !== null) {
    step(() => {
      if (realFolders(dirname(made), `${basename(made)}/.gitignore`)) rmSync(join(made, '.gitignore'), { force: true });
    });
    step(() => {
      if (readdirSync(made).length === 0) rmdirSync(made);
    });
  }
  const exclude = record.exclude;
  if (exclude !== null && record.added === true && !otherRecords(dir).some((other) => other.exclude === exclude)) {
    step(() => {
      const read = realFolders(...excludeAt(exclude)) ? readOwnOrNull(exclude) : null;
      if (read === null) return;
      const text = read.toString('utf8');
      const kept = linesOf(text).filter((line) => line !== EXCLUDE_LINE);
      if (kept.length !== linesOf(text).length) checkoutWrite(...excludeAt(exclude), kept.join('\n'));
    });
  }
  step(() => rmSync(at, { force: true }));
  return true;
}

/**
 * The folder whose `.cursor/mcp.json` Cursor reads: the nearest one at or above `start` that holds a
 * `.git`, as the CLI finds its project root (2026.10.22, `src/mcp/project-paths.ts`), or `start` when
 * none does. A Research card starts in its card folder, which holds checkouts and no `.git`, so Cursor
 * reads the project folder's file and never the card folder's.
 */
export function cursorRoot(start: string): string {
  const top = parse(start).root;
  for (let at = start; ; ) {
    if (existsSync(join(at, '.git'))) return at;
    const up = dirname(at);
    // The CLI stops below the file system's root, so it never looks there.
    if (up === at || up === top) return start;
    at = up;
  }
}

/**
 * The run's servers for a Cursor run, merged into `.cursor/mcp.json` of the folder Cursor reads it
 * from (`cursorRoot`), where the engine reads them. Cursor takes no config file on the command line. A server of the
 * folder's own file with the same name gives way. A secret goes into the file as a reference,
 * `${env:NOLZU_MCP_SECRET_<tag>_<n>}`, which Cursor reads in `env` and `headers` (config interpolation
 * in Cursor's MCP docs), and its value goes into cursor-agent's environment (`env`), so no file holds
 * it. The tag is random for each run: Cursor fills such a reference in every entry it loads, so a name
 * known beforehand could be named by a plain value of the shared list, of the folder's own file or of
 * a parent folder's file and sent anywhere. Nolzu's names are set last and win over the person's own
 * environment. Cursor's shell
 * tool inherits that environment and the docs name no filter, so the agent can read the value; the
 * run log says so (`runMcp`).
 *
 * The file goes through `writablePath`, so a link never takes the write elsewhere. A `.cursor` folder
 * Nolzu makes gets a `.gitignore` that names its two files, so git sees neither. In a `.cursor` that was there, the
 * path goes into the repository's git exclude while it is merged, Nolzu's line alone. The record of all
 * of it sits in the run's folder until `restoreCursorMcp` puts it back. Null when the run has no
 * server for Cursor.
 */
export function cursorMcp(job: Job): { restore: () => void; env: Record<string, string> } | null {
  if (job.mcp === undefined) return null;
  const rules = job.mcp.rules;
  const env: Record<string, string> = {};
  const tag = randomBytes(8).toString('hex');
  // Each secret value swapped for a reference to a variable of cursor-agent's own environment.
  const referred = (values: Record<string, string>, secret: readonly string[] = []) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        if (!secret.includes(key)) return [key, value];
        const variable = `NOLZU_MCP_SECRET_${tag}_${Object.keys(env).length}`;
        env[variable] = value;
        return [key, `\${env:${variable}}`];
      }),
    );
  const servers = {
    ...Object.fromEntries(
      Object.entries(job.mcp.stdio).map(([name, server]) => {
        const started = inFolder(server, rules[name]?.cwd);
        return [name, { type: 'stdio', command: started.command, args: started.args, env: referred(server.env, rules[name]?.secretEnv) }];
      }),
    ),
    // Cursor reads SSE and streamable HTTP from the address and names no type for them in its docs.
    ...Object.fromEntries(Object.entries(job.mcp.remote).map(([name, server]) => [name, { url: server.url, headers: referred(server.headers, rules[name]?.secretHeaders) }])),
  };
  if (Object.keys(servers).length === 0) return null;
  const start = job.qaCopy ?? job.cwd;
  const root = cursorRoot(start);
  // Only inside QA's copy or the project, and never the person's own Cursor config, which
  // `~/.cursor/mcp.json` is when the home folder holds a `.git`. The loop decides the same
  // (`cursorMergesHere`), so this is the last stop, not the rule.
  const within = resolve(job.qaCopy ?? job.projectDir ?? start);
  if (resolve(root) !== within && !resolve(root).startsWith(`${within}/`)) return null;
  if ([homedir(), systemHome()].some((home) => home !== undefined && resolve(home) === resolve(root))) return null;
  const file = writablePath(root, '.cursor/mcp.json');
  if (file === null) return null;
  const folder = dirname(file);
  const made = !existsSync(folder);
  const before = realFolders(mcpRoot(file), MCP_FILE) ? readOwnOrNull(file) : null;
  let theirs: Record<string, unknown> = {};
  try {
    const read = (JSON.parse(before?.toString('utf8') ?? '') as { mcpServers?: unknown }).mcpServers;
    if (typeof read === 'object' && read !== null) theirs = read as Record<string, unknown>;
  } catch {
    // No file in the project, or one that does not parse, which the run could not use anyway.
  }
  const common = job.qaCopy == null && !made ? gitDirs(root)?.common : undefined;
  const exclude = common === undefined ? null : join(common, 'info', 'exclude');
  const excludeText = exclude === null || !realFolders(...excludeAt(exclude)) ? '' : (readOwnOrNull(exclude)?.toString('utf8') ?? '');
  const present = linesOf(excludeText).includes(EXCLUDE_LINE);
  const added = exclude !== null && (!present || otherRecords(join(job.mcp.dir)).some((other) => other.exclude === exclude && other.added === true));
  const merged = `${JSON.stringify({ mcpServers: { ...theirs, ...servers } }, null, 2)}\n`;
  const record: CursorRecord = { file, before: before === null ? null : before.toString('base64'), madeFolder: made ? folder : null, exclude, added, wrote: sha(merged), names: Object.keys(servers) };
  mkdirSync(job.mcp.dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(job.mcp.dir, CURSOR_RECORD), JSON.stringify(record), { mode: 0o600 });
  const dir = job.mcp.dir;
  try {
    mkdirSync(folder, { recursive: true });
    // Only Nolzu's two files, so a file another tool puts in the folder meanwhile stays visible to git.
    if (made) writeFileSync(join(folder, '.gitignore'), '/mcp.json\n/.gitignore\n');
    checkoutWrite(mcpRoot(file), MCP_FILE, merged);
    // An earlier run with no wall could have left a link at the exclude file or a folder above it.
    if (exclude !== null && !present) {
      const [at, path] = excludeAt(exclude);
      if (realFolders(at, dirname(path))) mkdirSync(dirname(exclude), { recursive: true });
      checkoutWrite(at, path, `${excludeText}${excludeText === '' || excludeText.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`);
    }
  } catch (error) {
    // The run does not start, and what was merged so far goes back now.
    restoreCursorMcp(dir);
    throw error;
  }
  return { restore: () => void restoreCursorMcp(dir), env };
}

// Whether a stream line is Claude Code's init message.
export function claudeInit(line: string): boolean {
  try {
    const event = JSON.parse(line) as { type?: unknown; subtype?: unknown };
    return event.type === 'system' && event.subtype === 'init';
  } catch {
    return false;
  }
}

// Claude Code's config for one attempt, written from the job's servers into the run's folder with mode
// 600, and removed by the caller once the engine has read it. Null with no server.
function claudeConfig(job: Job): string | null {
  if (job.mcp === undefined || !hasServers(job)) return null;
  mkdirSync(job.mcp.dir, { recursive: true, mode: 0o700 });
  const path = join(job.mcp.dir, `claude-${randomUUID()}.json`);
  writeMcpConfig(path, job.mcp.stdio, job.mcp.remote, job.mcp.rules);
  return physical(path);
}

// The card folder, as the engine will see it.
//
// It is made before the run, so the first write into it does not depend on the agent making it,
// and so its physical path can be read. Only when the checkout is there: a project folder that was
// deleted would otherwise come back as an empty shell before spawn reports the missing checkout.
function prepareTaskDir(job: Job): string {
  if (existsSync(job.cwd)) {
    try {
      mkdirSync(job.taskDir, { recursive: true });
    } catch (error) {
      throw new Error(`The card folder ${job.taskDir} cannot be made (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). Check that .tasks in the project is a folder you can write to.`, { cause: error });
    }
    // The phase instructions the job carries. They go under the phase, beside what the phase writes,
    // because they belong to this run and are read once by it. A job with none is an Ask.
    //
    // The policy decides, not the job. A pass with no row of its own is built by spreading a phase
    // job, so it would carry that phase's method into a folder whose prompt names no file.
    // Written through `writeCardFile`: an earlier run may have left a link at either name, or in the
    // place of the phase folder, and a plain write would follow it out of the card folder.
    const file = join(job.phase, INSTRUCTIONS_FILE);
    const method = Object.hasOwn(PHASE_POLICIES, job.phase) ? job.instructions : null;
    const promptFile = join(job.phase, PROMPT_FILE);
    if (typeof method === 'string' && method !== '') {
      writeCardFile(job.taskDir, file, method);
      // The prompt beside it, so the Files tab shows what the run was told. A resume is sent the
      // message alone, so the prompt that started the session stays. It holds only what the database
      // and the project already keep, with paths relative to the run, or in full for QA's copy, so it
      // adds no secret.
      if (job.resumeFrom == null) writeCardFile(job.taskDir, promptFile, job.prompt);
    } else {
      // A pass with no method of its own leaves no file from an earlier run behind, in a folder a
      // person reads.
      removeCardFile(job.taskDir, file);
      removeCardFile(job.taskDir, promptFile);
    }
  }
  // Physical, because the engine reports the physical folder and the agent builds its paths from
  // that. Behind a symlink, and macOS keeps its temp folder behind one, the spelling the person
  // typed matches none of them, so the guard refused every write of the run, its summary included.
  // The engine gets the same spelling, so the two cannot disagree about what is inside.
  const taskDir = physical(job.taskDir);
  // The prompt names the card folder from the working folder, and the engine resolves that path from
  // the physical checkout. A project behind a symlink keeps both sides together. A `worktrees/` or
  // `.tasks/` that is a symlink of its own does not, and the path then lands somewhere else. QA's
  // prompt names the card folder in full, so its copy may sit behind a symlink of its own.
  if (job.qaCopy == null && resolve(physical(job.cwd), relative(job.cwd, job.taskDir)) !== taskDir) {
    throw new Error(
      `The card folder ${job.taskDir} is reached through a symlink that the checkout ${job.cwd} does not share, so the path the prompt names would point elsewhere. Keep worktrees and .tasks as plain folders in the project.`,
    );
  }
  return taskDir;
}

// Starts Claude Code in the card's worktree and yields its stdout one NDJSON line at a time.
export async function* spawnClaude(binary: string, job: Job, signal: AbortSignal, options: SpawnOptions = {}): AsyncGenerator<string> {
  if (signal.aborted) return;
  // The policy first, so a phase with no row leaves nothing behind, not even a folder.
  const policy = policyFor(job.phase);
  const at = onCopy(job);
  const taskDir = prepareTaskDir(at);
  // The policy decides, not the job. A job built for another phase that carried a knowledge folder
  // would otherwise let that phase write into it. The guard and the engine get one physical spelling,
  // as the card folder does, or one would refuse what the other allows.
  const knowledgeDir = policy.knowledge === true && job.knowledgeDir != null ? physical(job.knowledgeDir) : null;
  const env = engineEnv(options.env ?? process.env, {
    // The read-only guard is a hook that only this engine loads, so only this engine is handed the
    // folder it holds a run to.
    readOnlyTaskDir: policy.readOnly ? taskDir : null,
    knowledgeDir,
    profile: options.profile ?? null,
    commands: policy.commands === true,
  });
  // Inside the try, so a refused argument list still takes the config with it.
  let config: string | null = null;
  try {
    config = claudeConfig(job);
    const written = config;
    const spec: ProcessSpec = {
      name: 'Claude Code',
      binary,
      // The project folder, the checkout and the files outside them in the physical spelling too: the
      // agent reads AGENTS.md by the physical path, and a Read rule in the typed spelling would
      // match none of its reads.
      args: claudeArgs({
        ...at,
        taskDir,
        cwd: physical(at.cwd),
        projectDir: job.projectDir == null ? job.projectDir : physical(job.projectDir),
        epicFiles: job.epicFiles?.map(physical),
        readFiles: job.readFiles?.map(physical),
        // Read only, so never for a phase that writes knowledge: that one has the folder through `--add-dir`.
        knowledgeReadDir: knowledgeDir !== null || job.knowledgeReadDir == null ? null : physical(job.knowledgeReadDir),
        knowledgeDir,
        mcpConfigPath: config,
      }),
      cwd: at.cwd,
      env,
      stdin: job.prompt,
      killGraceMs: options.killGraceMs,
      // The init message lists the servers Claude Code has connected (`mcp_servers` of the Agent SDK's
      // `SDKSystemMessage`), so it has read the config by then. Removed there, the secrets are gone
      // before the agent's first tool call. A resume writes a new one.
      onLine: written === null ? undefined : (line) => {
        if (claudeInit(line)) rmSync(written, { force: true });
      },
    };
    yield* runProcess(walled('claude-code', job, policy, taskDir, spec, options), signal);
  } finally {
    if (config !== null) rmSync(config, { force: true });
  }
}

/**
 * Starts Codex CLI in the card's worktree and yields its stdout one JSON line at a time.
 *
 * One wall holds the run, and `ownSandbox` says which: the Codex row of `ENGINE_WALLS`, or Codex's
 * own sandbox where Nolzu's wall cannot start. While it is false it is Nolzu's wall, as for the other engines, with Codex's own sandbox off: its sandbox
 * modes still read `~/.ssh` and `.env`, and the wall hides them. With `ownSandbox` true the limit is
 * the engine's own sandbox and rides in the arguments. A refused write leaves the process exiting 0
 * with a line on stderr, which `codexRefusals` turns into a line of the stream, so the log and the
 * card read a refusal the same way they read a Claude one.
 */
export async function* spawnCodex(binary: string, job: Job, signal: AbortSignal, options: SpawnOptions = {}): AsyncGenerator<string> {
  if (signal.aborted) return;
  const policy = policyFor(job.phase);
  // The phases this engine cannot run, refused before the process starts, from the one rule the
  // "Run on" offer reads as well.
  const place = placeOf(job, options);
  const refused = vendorRefusal('codex', job.phase, place);
  if (refused !== null) throw new Error(refused);
  const at = onCopy(job);
  const taskDir = prepareTaskDir(at);
  // Its own sandbox where Nolzu's wall cannot start, as before the wall existed.
  const own = ownSandbox('codex', place.wall);
  // Where the process starts. Under its own sandbox a read-only phase starts in the card folder,
  // because the sandbox makes the working folder the writable area and leaves the project outside
  // it. The job says so when it was built for a resume of a run that started there.
  const inCardFolder = job.startsInCardFolder ?? startsInCardFolder('codex', job.phase, own);
  const cwd = inCardFolder ? taskDir : at.cwd;
  // No read-only folder: the guard those variables feed is a Claude Code hook, and this engine has
  // the sandbox instead. They are still taken off the environment, so a Nolzu that itself runs
  // inside a read-only run does not pass its own pair on.
  const env = engineEnv(options.env ?? process.env, { readOnlyTaskDir: null, profile: options.profile ?? null });
  // Under its own sandbox the home folder refuses writes as well, so a run that runs commands gets the
  // package caches in the data folder, as a walled run does, and the sandbox opens them.
  const caches = own && (!policy.readOnly || policy.commands === true) ? packageCaches(resolveDataDir(process.env)) : null;
  // The model list comes from the binary. An empty one is the binary not answering at all, which is
  // the missing engine and not a wrong model, so it gets the sentence that says how to repair it.
  const models = codexModelList(binary, env);
  if (models.length === 0) {
    throw new Error(`The Codex CLI engine at ${binary} did not answer \`codex debug models --bundled\`. Install Codex CLI, or check the PATH the login shell reports.`);
  }
  const spec: ProcessSpec = {
    name: 'Codex CLI',
    binary,
    args: codexArgs(
      { ...job, taskDir, cwd },
      {
        levels: models.find((one) => one.slug === job.model)?.levels ?? [],
        // QA writes its throwaway copy, which is the writable area under the sandbox. The real
        // checkout lies outside it.
        readOnly: policy.readOnly && !inCardFolder && at.qaCopy == null,
        ownSandbox: own,
        knowledgeDir: policy.knowledge === true ? (job.knowledgeDir ?? null) : null,
        cachesDir: caches === null ? null : resolvedPath(caches.dir),
      },
    ),
    cwd,
    // The secrets of the servers, which `codexMcp` keeps off the command line.
    env: { ...env, ...(caches === null ? {} : caches.env), ...(job.mcp === undefined ? {} : codexMcp(job.mcp.stdio, job.mcp.remote, job.mcp.rules).env) },
    stdin: job.prompt,
    afterExit: codexRefusals,
    killGraceMs: options.killGraceMs,
    firstLine: place.wall.ready ? undefined : noteLine(`Held by the Codex sandbox, because Nolzu's wall cannot start here. ${place.wall.reason} Secret files such as ~/.ssh and .env are not hidden from this run.`),
  };
  yield* runProcess(own ? checked('codex', policy, job, spec, options) : walled('codex', job, policy, taskDir, spec, options), signal);
}

/**
 * Starts Cursor CLI in the card's worktree and yields its stdout one JSON line at a time.
 *
 * Cursor has no read-only to enforce: plan mode is a mode the run itself can leave. So a read-only
 * phase runs only inside Nolzu's wall, and where the wall cannot start it is refused before the
 * process starts. What the run may do is set by `--force`, because without it the engine rejects every shell command
 * and the run still ends with success. Both were measured on 2026-09-25 and both are in
 * docs/engines/cursor.md. The process starts inside Nolzu's wall, which keeps the secrets hidden
 * and the engine's config and hook files read-only, with Cursor's own shell sandbox off.
 */
export async function* spawnCursor(binary: string, job: Job, signal: AbortSignal, options: SpawnOptions = {}): AsyncGenerator<string> {
  if (signal.aborted) return;
  // Without the wall a read-only phase would run with write access to the whole checkout while the
  // card says it cannot change it. One rule, which the "Run on" offer reads as well.
  const place = placeOf(job, options);
  const refused = vendorRefusal('cursor', job.phase, place);
  if (refused !== null) throw new Error(refused);
  // The card folder is made here, and its path is checked against the one the prompt names. It is
  // not handed to the engine: `--add-dir` and `--workspace` exist, and a run wrote a file two
  // folders above its working folder without either, measured on 2026-09-25, so neither would buy a
  // limit. The wall around the process is what holds the run.
  const at = onCopy(job);
  const taskDir = prepareTaskDir(at);
  // No read-only folder: the guard those variables feed is a Claude Code hook, and this engine has
  // the mode instead. They are still taken off the environment, so a Nolzu that itself runs inside
  // a read-only run does not pass its own pair on.
  const env = engineEnv(options.env ?? process.env, { readOnlyTaskDir: null, profile: options.profile ?? null });
  // The model list comes from the login over the network. An empty one is the binary or the login
  // not answering, which is not a wrong model, so it gets the sentence that says how to repair it.
  const models = cursorModels(binary, env);
  if (models.length === 0) {
    throw new Error(`The Cursor CLI engine at ${binary} did not answer \`cursor-agent --list-models\`. Install Cursor CLI, sign it in, or check the PATH the login shell reports.`);
  }
  // Two Research cards of one project share the file Cursor reads, so a run with servers waits its turn.
  const root = hasServers(job) ? cursorRoot(at.cwd) : null;
  const turn = root === null ? null : cursorTurn(root);
  try {
    if (root !== null && turn !== null && !(await within(turn.ready, 0, signal))) {
      const file = join(root, '.cursor', 'mcp.json');
      yield noteLine(`Waits for another Cursor run to end, because Cursor reads the servers of both from ${file}.`);
      // A line now and then, so the quiet timeout does not stop a run that only waits.
      while (!signal.aborted && !(await within(turn.ready, Math.min(WAIT_NOTE_MS, job.timeoutMs / 2), signal))) {
        if (!signal.aborted) yield noteLine(`Still waits for the other Cursor run that uses ${file}.`);
      }
    }
    if (signal.aborted) return;
    const mcp = cursorMcp(job);
    try {
      const spec: ProcessSpec = {
        name: 'Cursor CLI',
        binary,
        args: cursorArgs(at, models, place.wall.ready, mcp !== null),
        cwd: at.cwd,
        // The secret values the merged file refers to.
        env: { ...env, ...mcp?.env },
        stdin: job.prompt,
        failureText: cursorFailure,
        killGraceMs: options.killGraceMs,
      };
      yield* runProcess(walled('cursor', job, policyFor(job.phase), taskDir, spec, options), signal);
    } finally {
      mcp?.restore();
    }
  } finally {
    turn?.release();
  }
}

// The runs holding the `.cursor/mcp.json` of each Cursor root, the newest last in the chain.
const cursorTurns = new Map<string, Promise<void>>();
const WAIT_NOTE_MS = 5 * 60 * 1000;

// A place in the line for `root`'s file: `ready` settles once every run before this one has released
// it. Each run puts back the file it found, so two at once would leave one's merge behind. A run that
// stops while it waits releases its place, and the run after it still waits for the ones before.
function cursorTurn(root: string): { ready: Promise<void>; release: () => void } {
  const ready = cursorTurns.get(root) ?? Promise.resolve();
  let done = () => {};
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const chain = ready.then(() => mine);
  cursorTurns.set(root, chain);
  return {
    ready,
    release: () => {
      done();
      void chain.then(() => {
        if (cursorTurns.get(root) === chain) cursorTurns.delete(root);
      });
    },
  };
}

// True once `ready` settled, false after `ms` or a stop, whichever comes first.
async function within(ready: Promise<void>, ms: number, signal: AbortSignal): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let stop = () => {};
  const late = new Promise<boolean>((resolve) => {
    stop = () => resolve(false);
    timer = setTimeout(stop, ms);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([ready.then(() => true), late]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

// One engine process: its stdout, line by line, and its end.
// Exported for its tests; the engines go through their own spawn functions.
export async function* runProcess(spec: ProcessSpec, signal: AbortSignal): AsyncGenerator<string> {
  if (signal.aborted) return;
  const graceMs = spec.killGraceMs ?? KILL_GRACE_MS;
  const engineBinary = spec.engineBinary ?? spec.binary;
  if (spec.firstLine !== undefined) yield spec.firstLine;
  // A stop that came while the caller read the first line starts nothing.
  if (signal.aborted) return;

  let child: ChildProcess;
  try {
    // detached, so the child leads its own process group and one kill reaches the tools the agent
    // started. Without it a stopped run leaves its children working on the checkout.
    child = spawn(spec.binary, [...spec.args], { cwd: spec.cwd, detached: true, env: spec.env });
  } catch (error) {
    // Node reports only a few errno values on the child. The rest, ENOTDIR among them, are thrown
    // straight out of spawn, so a branch that waited for the error event could never run.
    throw startupError(error as NodeJS.ErrnoException, spec.name, engineBinary, spec.cwd);
  }
  const pid = child.pid;
  const out = child.stdout as Readable;

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    // Cutting by code unit can leave half of a character at the front, which is then stored and
    // read back as something else.
    stderr = (stderr + chunk).slice(-STDERR_TAIL).replace(/^[\uDC00-\uDFFF]/, '');
  });

  let grace: NodeJS.Timeout | null = null;
  let stopping = false;
  const stopNow = (): void => {
    if (stopping) return;
    stopping = true;
    signalChild('SIGTERM');
    // Armed here and not after the run has ended. An engine that traps the polite signal never
    // exits, so anything waiting for its exit before escalating would wait for ever.
    grace = setTimeout(() => signalChild('SIGKILL'), graceMs);
    grace.unref();
  };

  // The caller's stop waits a moment first. An engine that was already exiting keeps its own exit
  // code, so a run that crashed just as the person pressed stop is still reported as a crash.
  const stop = (): void => {
    if (stopping) return;
    const settle = setTimeout(stopNow, SELF_EXIT_MS);
    settle.unref();
  };
  signal.addEventListener('abort', stop, { once: true });

  let weStopped = false;
  let drain: NodeJS.Timeout | null = null;
  // Whether the check after the run ran. A caller that stops reading early, such as a run whose log
  // could not be written, still gets it, or what the run left would read as the state before the next.
  let checkedAfter = false;
  const ended = new Promise<{ code: number | null; killedBy: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) => reject(startupError(error, spec.name, engineBinary, spec.cwd)));
    // exit, not close. close waits for every stdio pipe, and a tool that outlived the engine holds
    // the engine's stdout, so waiting for it would never report the run at all.
    child.on('exit', (code, killedBy) => {
      // Captured before this handler signals the group. True here means the stop went out first,
      // which is the only honest test of whether Nolzu ended the run: an engine that traps the
      // signal exits with a code of its own, so looking for a death by signal never sees it.
      weStopped = stopping;
      resolve({ code, killedBy });
      // The run is over, so its tools go now. Waiting for the read loop first was circular: a tool
      // holding stdout kept the loop open, and the loop is what reached the cleanup that kills it.
      // No wait here: the engine has already reported, so nothing of its own can be lost.
      stopNow();
      // The engine is gone, so no new line can arrive. Whatever a surviving tool still holds is
      // dropped rather than left to stall the run for as long as that tool lives. A tool that was
      // mid line when this fires leaves a fragment, which the parser drops.
      drain = setTimeout(() => out.destroy(), graceMs);
      drain.unref();
    });
    child.on('close', () => {
      if (drain !== null) clearTimeout(drain);
    });
  });
  // Nothing awaits this until the stream ends, and an unawaited rejection would take the whole
  // process down before the error reaches the caller.
  ended.catch(() => undefined);

  const groupAlive = (): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const signalChild = (which: NodeJS.Signals): void => {
    // The engine's own state is not checked here. A process group outlives its leader, and the
    // tools that survive the engine are exactly the ones this has to reach.
    if (pid === undefined) return;
    try {
      process.kill(-pid, which);
    } catch {
      try {
        child.kill(which);
      } catch {
        // Nothing left to stop.
      }
    }
  };


  try {
    // Closing stdin is what tells the engine the prompt is complete. The prompt goes here and
    // never into the argument list, so it cannot show up in a process listing. An engine that
    // exits without reading it breaks the pipe, and that is not the run's failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin);

    child.stdout?.setEncoding('utf8');
    let carry = '';
    try {
      // Split here rather than with readline. readline hands over its buffered last line only when
      // the input ends, and the drain closes the pipe instead, which threw that line away. The
      // result line carries the cost and the session id and arrives with no trailing newline.
      for await (const chunk of out) {
        carry += chunk as string;
        for (let at = carry.indexOf('\n'); at !== -1; at = carry.indexOf('\n')) {
          const line = carry.slice(0, at).replace(/\r$/, '');
          carry = carry.slice(at + 1);
          if (line.trim() === '') continue;
          spec.onLine?.(line);
          yield line;
        }
      }
    } catch (error) {
      // The drain destroys the pipe on purpose, and the iterator reports that as a premature
      // close. A real read error carries its own code and is not swallowed.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    }
    if (carry.trim() !== '') yield carry.replace(/\r$/, '');

    const { code, killedBy } = await ended;
    // The run ended because Nolzu stopped it, so there is nothing to report.
    //
    // What this can and cannot promise. A crash Node has already handed over before the stop is
    // reported. One that had happened but was still waiting to be delivered is treated as the stop,
    // because a child stays a zombie until the loop reaps it, so its exit code, its signal and a
    // kill probe all read as though it were alive. There is no way to tell the two apart from
    // inside the process. The line falls wherever the caller's own work leaves it: idle, a crash in
    // the same breath is reported, and after about ten milliseconds of work it is not. So an abort
    // forgives what follows it, which is the honest reading of a person pressing stop.
    //
    // What the process said on stderr and not in its stream, such as a tool its sandbox refused, comes
    // first, a stopped run included: Nolzu stops an engine that stays up after its result, and the
    // refusals and the wall's notes of that run still belong in its log. It arrives at the end and not
    // where it happened, because stderr is read outside this loop.
    for (const line of spec.afterExit?.(stderr) ?? []) yield line;
    // A tool the engine left behind could still write a compared file once the compare is done, so
    // the compare waits until the group is gone. The SIGKILL is already armed by the stop on exit.
    if (spec.afterRun !== undefined) {
      for (let waited = 0; waited < graceMs && groupAlive(); waited += GROUP_POLL_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, GROUP_POLL_MS));
      }
      if (groupAlive()) signalChild('SIGKILL');
    }
    checkedAfter = true;
    const halt = spec.afterRun?.() ?? null;
    if (halt !== null) throw new RunHalted(halt);
    if (signal.aborted && weStopped) return;
    if (code === 0 && killedBy === null) return;
    const how = killedBy === null ? `exit code ${code}` : `signal ${killedBy}`;
    const tail = stderr.trim();
    throw new Error(spec.failureText?.(stderr) ?? `The ${spec.name} engine stopped with ${how}.${tail === '' ? '' : ` It said: ${tail}`}`);
  } finally {
    // This runs for a break and a throw from the caller too, which is why the yields are inside it.
    // Before, a caller that stopped reading left the engine and its whole group with no parent.
    signal.removeEventListener('abort', stop);
    stop();
    await ended.catch(() => undefined);
    if (drain !== null) clearTimeout(drain);
    // Polled rather than waited out. A tool that goes quietly is usually still alive the instant
    // the signal is sent, and a single wait made every good run pay the whole grace.
    for (let waited = 0; waited < graceMs && groupAlive(); waited += GROUP_POLL_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, GROUP_POLL_MS));
    }
    if (groupAlive()) signalChild('SIGKILL');
    if (grace !== null) clearTimeout(grace);
    if (!checkedAfter) {
      const halt = spec.afterRun?.() ?? null;
      // eslint-disable-next-line no-unsafe-finally -- the halt outranks how the reading ended
      if (halt !== null) throw new RunHalted(halt);
    }
  }
}
