import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { PhasePolicy, WallState } from '@nolzu/core';
import type { EngineName, WallKind } from '@nolzu/protocol';
import type { WallSpec } from './wall.ts';

// The fixed rules of the wall, as data, so a correction from the wall measurements is a change to a
// row and not to the code that builds the wall. A wrong row makes a run fail: it never lets one
// write outside its folders. Paths start with `~/` and are read against the run's home folder, and the
// fixed hidden ones against the account's home as well (`homesOf`).

// Hidden in every run, Implement included, in three parts so Settings, Wall can group the list it
// shows from the same rows. `~/.npmrc` is not here on purpose: runs install packages with the
// person's own npm setup, scoped registry logins included, and hiding it would turn every private
// package into a 404 the run cannot explain. gh's `hosts.yml` can go: Nolzu runs gh itself, outside
// the wall, and no run calls it.
export const HIDDEN_LOGINS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gcloud',
  '~/.azure',
  '~/.kube',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.config/gh/hosts.yml',
  '~/.git-credentials',
  '~/.pypirc',
  '~/.cargo/credentials.toml',
  // Google's agent CLIs keep their logins here. No engine Nolzu runs reads it.
  '~/.gemini',
];

// The folders that hold the Docker sockets on macOS. The profile closes the connect itself.
export const HIDDEN_SOCKET_FOLDERS: readonly string[] = ['~/.docker/run', '~/.orbstack/run'];

// Shell and REPL history, where a typed token or password stays.
export const HIDDEN_HISTORY: readonly string[] = [
  '~/.zsh_history',
  '~/.bash_history',
  '~/.zsh_sessions',
  '~/.local/share/fish/fish_history',
  '~/.python_history',
  '~/.node_repl_history',
];

export const HIDDEN_FOR_EVERY_RUN: readonly string[] = [...HIDDEN_LOGINS, ...HIDDEN_SOCKET_FOLDERS, ...HIDDEN_HISTORY];

// Hidden only on the system where they live: the browser profiles, with their cookies and saved
// passwords.
export const HIDDEN_ON: Readonly<Record<'darwin' | 'linux', readonly string[]>> = {
  darwin: [
    '~/Library/Application Support/Google/Chrome',
    '~/Library/Application Support/Chromium',
    '~/Library/Application Support/Microsoft Edge',
    '~/Library/Application Support/Arc',
    '~/Library/Application Support/BraveSoftware',
    '~/Library/Application Support/Firefox',
    '~/Library/Safari',
  ],
  linux: ['~/.config/google-chrome', '~/.config/chromium', '~/.config/microsoft-edge', '~/.config/BraveSoftware', '~/.mozilla'],
};

// Linux only: unix sockets no run may connect to. A running Docker or Podman daemon writes anywhere
// in the home folder for whoever reaches it, the session bus starts services outside the wall, and
// the X server takes keystrokes for other windows. macOS closes these by name in the profile.
const uid = process.getuid?.() ?? 0;
export const LINUX_SOCKETS: readonly string[] = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  `/run/user/${uid}/docker.sock`,
  '/run/podman/podman.sock',
  `/run/user/${uid}/podman/podman.sock`,
  `/run/user/${uid}/bus`,
  '/tmp/.X11-unix',
];

// A file a run must be able to write that still starts something later, outside the wall. `part` is
// what matters in it, read from its bytes (null when it is not there); Nolzu compares it before and
// after each run and fails the card on a change. `what` names that part in the sentence.
export interface WatchedFile {
  path: string;
  what: string;
  part: (bytes: Buffer | null) => string;
}

const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isSet = (value: unknown) =>
  value !== undefined && value !== null && value !== false && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && Object.keys(value).length === 0);
// Keys sorted at every level, so a rewrite that only moves keys around reads the same.
const sorted = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sorted) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])])) : value;

// Only these keys of a JSON file, at the top and in each entry of `nested`. An unset key and an
// empty one read the same, because an engine writes empty ones for every new folder it runs in. A
// file that does not parse reads as its hash, so any change to it counts.
function jsonPart(keys: readonly string[], nested?: string): (bytes: Buffer | null) => string {
  const asObject = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
  const pick = (from: unknown) => Object.fromEntries(keys.filter((key) => isSet(asObject(from)[key])).map((key) => [key, asObject(from)[key]]));
  return (bytes) => {
    let config: unknown = {};
    if (bytes !== null) {
      try {
        config = JSON.parse(bytes.toString('utf8'));
      } catch {
        return hashOf(bytes);
      }
    }
    const entries = nested === undefined ? [] : Object.entries(asObject(asObject(config)[nested]));
    const each = entries.map(([name, entry]) => [name, pick(entry)] as const).filter(([, kept]) => Object.keys(kept).length > 0);
    return JSON.stringify(sorted({ top: pick(config), each: Object.fromEntries(each) }));
  };
}

export interface EngineWallRow {
  // macOS only: whole state folders opened in place of the session list, for an engine whose session
  // paths are not all known yet. In SBPL the last matching rule wins, so a whole folder is writable
  // except the names in `writeDenied`. Empty means macOS opens only the session list, as Linux does.
  writable: readonly string[];
  // Where its login lives on disk. Hidden from every other engine's run. A login kept in the macOS
  // Keychain has no path, so the wall cannot hide it.
  logins: readonly string[];
  // Config and hook files inside the writable folders that stay read-only, so a run cannot plant a
  // hook or a server that fires in a later run.
  writeDenied: readonly string[];
  // The folder the vendor's config variable moves (`CLAUDE_CONFIG_DIR`, `CURSOR_CONFIG_DIR`,
  // `CODEX_HOME`). A profile with a folder of its own gets every path under this one there.
  configRoot: string;
  // The session folders and files a run may write. A whole writable state folder would let a run
  // create a config, hook, rule or memory file that loads later outside the wall, and bwrap cannot
  // hold a path that is not there yet. The folders are made before the run. On Linux a file that is
  // not there stays closed.
  sessionFolders: readonly string[];
  sessionFiles: readonly string[];
  // Session files that still start something later, compared before and after each run.
  watched: readonly WatchedFile[];
  // True when the engine's own sandbox holds the run in place of this wall. Exactly one wall per run:
  // a macOS sandbox cannot start inside another one.
  ownSandbox: boolean;
  // The state folder Linux opens whole, for an engine that saves a session file through a temp file
  // beside it and a rename. bwrap binds a file, and a bound file can be neither renamed over nor given
  // a sibling. Every other entry there before the run stays read-only, and a name the run adds that is
  // no session name fails the card (`linuxStateOf`, and `walled` in spawn.ts).
  linuxOpen?: string;
}

export const ENGINE_WALLS: Readonly<Record<EngineName, EngineWallRow>> = {
  // From docs/engines/claude-code.md and the vendor's settings docs. Waits for the report of scripts/measure-walls.mjs.
  'claude-code': {
    writable: [],
    logins: ['~/.claude/.credentials.json'],
    writeDenied: [
      '~/.claude/settings.json',
      '~/.claude/settings.local.json',
      '~/.claude/hooks',
      '~/.claude/agents',
      '~/.claude/commands',
      '~/.claude/skills',
      '~/.claude/plugins',
      '~/.claude/CLAUDE.md',
      // Memory Claude Code loads into every later session in that project. A `*` is one folder name.
      '~/.claude/projects/*/memory',
    ],
    configRoot: '~/.claude',
    // From the folders Claude Code makes under `~/.claude`. `sessions` was seen in the macOS report of
    // scripts/measure-walls.mjs on 2026-10-22; the Linux report is still to come.
    sessionFolders: [
      '~/.claude/projects',
      '~/.claude/sessions',
      '~/.claude/todos',
      '~/.claude/shell-snapshots',
      '~/.claude/statsig',
      '~/.claude/session-env',
      '~/.claude/plans',
      '~/.claude/debug',
      '~/.claude/file-history',
      '~/.claude/ide',
    ],
    // `~/.claude/.claude.json` is where the main file moves when a profile sets the config folder.
    sessionFiles: ['~/.claude.json', '~/.claude/.claude.json', '~/.claude/.credentials.json', '~/.claude/history.jsonl'],
    // Claude Code rewrites `.claude.json` in every session, and its MCP servers start in the person's
    // own sessions later.
    watched: ['~/.claude.json', '~/.claude/.claude.json'].map((path) => ({
      path,
      what: 'the MCP servers or hooks in',
      part: jsonPart(['mcpServers', 'hooks', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'enableAllProjectMcpServers'], 'projects'),
    })),
    ownSandbox: false,
  },
  // From docs/engines/codex.md (`CODEX_HOME`) and the vendor's config, hooks and skills docs. Waits
  // for the report of scripts/measure-walls.mjs, which also says whether Codex runs inside this wall at all.
  codex: {
    writable: ['~/.codex'],
    logins: ['~/.codex/auth.json'],
    writeDenied: [
      '~/.codex/config.toml',
      '~/.codex/hooks.json',
      '~/.codex/AGENTS.md',
      '~/.codex/AGENTS.override.md',
      '~/.codex/rules',
      '~/.codex/skills',
      '~/.codex/prompts',
    ],
    configRoot: '~/.codex',
    // From docs/engines/codex.md, and the folders the macOS report of scripts/measure-walls.mjs saw
    // on 2026-10-22. Limit: the report also saw SQLite files at the top of `~/.codex` with a version
    // in the name and -wal files beside them, which a bwrap file bind cannot hold. The Linux report decides.
    sessionFolders: ['~/.codex/sessions', '~/.codex/log', '~/.codex/tmp', '~/.codex/cache', '~/.codex/plugins', '~/.codex/shell_snapshots', '~/.codex/thread-writer-locks'],
    sessionFiles: ['~/.codex/auth.json', '~/.codex/history.jsonl', '~/.codex/version.json', '~/.codex/models_cache.json'],
    watched: [],
    // Off: Codex runs inside this wall with its own sandbox off, because its workspace-write and
    // read-only modes still read ~/.ssh and .env. The other way is a Codex permission profile through
    // `-c default_permissions`, which is beta and not measured yet. The report of
    // scripts/measure-walls.mjs may flip this to true and move that denial into the profile.
    ownSandbox: false,
  },
  // From docs/engines/cursor.md and the installed CLI bundle. The login sits in the
  // Keychain on macOS and in `~/.config/cursor` on Linux. `cli-config.json` stays writable because the
  // CLI writes it, and its permissions are compared after each run: they hold the person's own runs
  // later. Waits for the report of scripts/measure-walls.mjs.
  cursor: {
    writable: [],
    logins: ['~/.config/cursor/auth.json'],
    writeDenied: [
      '~/.cursor/mcp.json',
      '~/.cursor/hooks.json',
      '~/.cursor/sandbox.json',
      '~/.cursor/rules',
      '~/.cursor/commands',
      '~/.cursor/agents',
      '~/.cursor/skills-cursor',
      '~/.cursor/plugins',
    ],
    configRoot: '~/.cursor',
    // The chats and project state the CLI keeps, and its login folder, which holds no hook. The
    // tracking folder and the statsig file were seen in the macOS report of scripts/measure-walls.mjs
    // on 2026-10-22.
    sessionFolders: ['~/.cursor/projects', '~/.cursor/chats', '~/.cursor/ai-tracking', '~/.config/cursor'],
    sessionFiles: ['~/.cursor/cli-config.json', '~/.cursor/statsig-cache.json'],
    watched: [{ path: '~/.cursor/cli-config.json', what: 'the permissions in', part: jsonPart(['permissions']) }],
    ownSandbox: false,
    // The CLI saves `cli-config.json` and `statsig-cache.json` as `<file>.<pid>.<uuid>.tmp` and a rename.
    linuxOpen: '~/.cursor',
  },
};

// Whether this vendor's own sandbox holds its runs, read by the spawn and by where a run starts. An
// unknown vendor has none. Codex falls back to its own where Nolzu's wall cannot start.
export function ownSandbox(vendor: string, wall: WallState): boolean {
  if (vendor === 'codex' && !wall.ready) return true;
  return Object.hasOwn(ENGINE_WALLS, vendor) && ENGINE_WALLS[vendor as EngineName].ownSandbox;
}

// Which wall holds a run of this vendor here, for `runs.wall`. It follows `ownSandbox` and the probe,
// the same two answers the spawn reads.
export function wallKind(vendor: string, wall: WallState, platform: NodeJS.Platform): WallKind {
  if (ownSandbox(vendor, wall)) return 'codex';
  if (!wall.ready) return 'none';
  return platform === 'darwin' ? 'macos' : platform === 'linux' ? 'bubblewrap' : 'none';
}

// Read-only in every run, even when the checkout is writable: each one is a hook or a config an
// engine or git runs later, outside the wall. Folders and files alike.
export const CHECKOUT_WRITE_DENIED: readonly string[] = [
  '.git/hooks',
  // The whole folder, not its settings and hooks alone: skills, commands, agents, output styles and
  // rules all load in a later Claude Code or Cursor run. Held by name, so on macOS a rename or a new
  // one fails too; on Linux spawn.ts names a new one after the run.
  '.claude',
  '.cursor',
  // Google's agent CLIs read `.agent`, `_agents` and `_agent` the same way as `.agents`, and a person
  // may run one by hand later. Like the others, only the folder at the checkout root is held, not one
  // in a subfolder.
  '.agents',
  '.agent',
  '_agents',
  '_agent',
  '.codex',
  '.gemini',
  // A file, not a folder: Claude Code starts the stdio servers it names. Held by name like `.claude`,
  // so a write, a new one, a delete or a rename onto it fails on macOS; on Linux an existing one is
  // bound read-only and spawn.ts names a new one after the run. Nolzu's own servers never go here:
  // Claude runs take `--strict-mcp-config` with Nolzu's config path.
  '.mcp.json',
  // The project's MCP list, which Nolzu starts the servers of in later runs, so a run cannot plant one.
  '.nolzu/mcp-servers.json',
  // The project's extra skills, which Write the project files copies for every engine.
  '.nolzu/skills',
  // A repository made here would be the one Nolzu's git finds from the default knowledge folder, and
  // git would read the run's config, filters included, outside the wall. The knowledge run's own
  // folder is held the same way in `wallSpecFor`.
  '.nolzu/.git',
  '.nolzu/knowledge/.git',
];

export interface WallSpecInput {
  policy: Pick<PhasePolicy, 'readOnly' | 'knowledge' | 'commands'>;
  vendor: EngineName;
  cardDir: string;
  knowledgeDir: string | null;
  checkout: string;
  // The git folder that holds the objects and the hooks. For a worktree it is the main checkout's
  // `.git`, not the worktree's. Defaults to `<checkout>/.git`.
  gitCommonDir?: string;
  // The checkout's own git folder, which a worktree's `.git` file names: `<common>/worktrees/<name>`.
  // Defaults to the shared one.
  gitOwnDir?: string;
  // The repositories one folder down in the checkout, as a card on several repositories holds them,
  // with their git folders. Nolzu runs git in each, so their pointers, config and hooks are held too.
  childRepos?: readonly { checkout: string; own: string; common: string }[];
  home: string;
  // The account's home from the system (`systemHome`), when it can be read. The fixed hidden paths
  // are hidden under it too.
  systemHome?: string;
  tmp: string;
  // Secret files of the project that stay readable. Anything outside the checkout, anything that
  // is no `.env` file and anything inside a fixed secret path is dropped.
  exceptions: readonly string[];
  // The project's own lists, already checked by `checkedWallLists` and resolved: more hidden paths
  // for every run, and more writable folders for Implement and QA.
  lists?: { hidden: readonly string[]; writable: readonly string[] };
  // The system the run starts on. Linux opens only the session folders (`sessionFolders`), and so does
  // macOS for a row with no `writable`.
  platform?: string;
  // The folder the vendor's config variable names for this run, or null for its default place.
  configDir?: string | null;
  // The real checkout, when `checkout` is the throwaway copy a QA run works on. The copy is
  // writable, so the project's checks can write their caches. The real one stays read-only, and the
  // `.env` files of both stay hidden.
  copyOf?: string;
  // The package managers' caches in Nolzu's data folder (`packageCaches`), open to a run that runs
  // commands, so an install never writes its cache into the card folder.
  caches?: string;
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The account's home folder from the system's user record, or undefined when there is none, as in a
 * container that runs under an id with no passwd entry. A tool such as Claude Code's Read resolves `~`
 * from this and not from HOME, so a run whose HOME points elsewhere still reaches the real `~/.ssh`.
 */
export function systemHome(read: () => string = () => userInfo().homedir): string | undefined {
  try {
    const home = read();
    return home === '' ? undefined : home;
  } catch {
    return undefined;
  }
}

// The home folders a fixed hidden path is read against: the run's HOME, and the account's home when it
// is another folder, so the wall holds whichever one a tool resolves `~` from.
const homesOf = (input: { home: string; systemHome?: string }): string[] => [...new Set([input.home, ...(input.systemHome === undefined ? [] : [input.systemHome])])];
const underHomes = (input: { home: string; systemHome?: string }, paths: readonly string[]): string[] =>
  homesOf(input).flatMap((folder) => paths.map((path) => join(folder, path.slice(2))));

const ENV_FILE = /^\.env(\..+)?$/;

// A row path on disk: under the home folder, or under the profile's config folder when it moves it.
function placer(input: Pick<WallSpecInput, 'vendor' | 'home' | 'configDir'>): (path: string) => string {
  const root = ENGINE_WALLS[input.vendor].configRoot;
  // Resolved, so a folder written with a trailing slash names the same paths as one without.
  const dir = input.configDir == null ? null : resolve(input.configDir);
  return (path) => (dir !== null && inside(path, root) ? join(dir, path.slice(root.length)) : join(input.home, path.slice(2)));
}

// The session folders to make before a run: bwrap opens only a path that is there, and on macOS a
// run may not make the state folder that holds them.
export function sessionFoldersOf(input: Pick<WallSpecInput, 'vendor' | 'home' | 'configDir'>): string[] {
  return ENGINE_WALLS[input.vendor].sessionFolders.map(placer(input));
}

/**
 * The state folder a Linux run opens whole (`EngineWallRow.linuxOpen`), where it sits on disk, and the
 * names of the session folders and files directly in it, which the run may write and add. Null on
 * macOS, and for an engine whose session paths bwrap can bind one by one.
 */
export function linuxStateOf(input: Pick<WallSpecInput, 'vendor' | 'home' | 'configDir' | 'platform'>): { folder: string; session: string[] } | null {
  const row = ENGINE_WALLS[input.vendor];
  if (input.platform !== 'linux' || row.linuxOpen === undefined) return null;
  const place = placer(input);
  const folder = place(row.linuxOpen);
  const session = [...row.sessionFolders, ...row.sessionFiles].map(place).filter((path) => dirname(path) === folder);
  return { folder, session: session.map((path) => basename(path)) };
}

// The watched files of this run's engine, where they sit on disk.
export function watchedFilesOf(input: Pick<WallSpecInput, 'vendor' | 'home' | 'configDir'>): WatchedFile[] {
  const place = placer(input);
  return ENGINE_WALLS[input.vendor].watched.map((file) => ({ ...file, path: place(file.path) }));
}

// What a run must not change in one repository Nolzu runs git in. core.hooksPath and core.fsmonitor in
// the config, and the hooks, name a command git runs later, outside the wall. And a run that may write
// the checkout must not move what tells git where the repository is: a renamed `.git`, a rewritten
// `.git` file or `commondir` points Nolzu's next git call at a config the run wrote. These are held by
// exact name, so writes inside the folders stay open and a commit still works.
function gitHolds(checkout: string, common: string, own: string): { denied: string[]; literal: string[] } {
  return {
    denied: [join(common, 'hooks'), join(common, 'config')],
    literal: [
      checkout,
      join(checkout, '.git'),
      common,
      join(common, 'commondir'),
      join(common, 'config.worktree'),
      ...(own === common ? [] : [dirname(own), own, join(own, 'commondir'), join(own, 'gitdir'), join(own, 'config.worktree')]),
    ],
  };
}

// What a run that may write the checkout may write of its git folders. A plain checkout's git folder
// opens whole, as it always did. A worktree's shared git folder also holds the admin folder of every
// other card, where a rewritten `commondir` or `config.worktree` would point Nolzu's next git call in
// that card at a config the run wrote, and Nolzu's own lock and removal folders. So for a worktree
// only what a commit, a stash, a branch, a rebase and gc write there opens: the objects, the refs and
// their logs, LFS and rerere's cache, the packed refs and gc's own files, and the card's own admin
// folder, and the lock files gc and a rewrite of the packed refs take. bwrap opens only what is there,
// so on Linux a missing one stays closed, the lock files among them: there a rewrite of `packed-refs`
// (deleting a packed branch, `pack-refs`, gc) fails inside a run.
export const SHARED_GIT_WRITABLE = ['objects', 'refs', 'logs', 'lfs', 'rr-cache', 'packed-refs', 'packed-refs.lock', 'packed-refs.new', 'gc.pid', 'gc.pid.lock', 'gc.log', 'gc.log.lock'];
const gitWritable = (common: string, own: string): string[] => (own === common ? [common] : [...SHARED_GIT_WRITABLE.map((name) => join(common, name)), own]);
// Where git writes by name, so a run may make no link there (`WallSpec.noLinks`): every writable git
// place but the objects and LFS, which git writes through a temp file, a hard link and a rename. A
// plain checkout's git folder is one place, and there git falls back to a rename when the link fails.
const gitNoLinks = (common: string, own: string): string[] => gitWritable(common, own).filter((path) => path !== join(common, 'objects') && path !== join(common, 'lfs'));

export function wallSpecFor(input: WallSpecInput): WallSpec {
  const place = placer(input);
  const row = ENGINE_WALLS[input.vendor];
  const gitDir = input.gitCommonDir ?? join(input.checkout, '.git');

  const state = input.platform === 'linux' || row.writable.length === 0 ? [...row.sessionFolders, ...row.sessionFiles] : row.writable;
  const open = linuxStateOf(input)?.folder;
  // A session path inside a folder opened whole is not bound again: a bound file cannot be renamed over.
  const placed = open === undefined ? state.map(place) : [open, ...state.map(place).filter((path) => !inside(path, open))];
  const writable = [input.tmp, ...new Set(placed)];
  if (input.policy.readOnly) {
    writable.push(input.cardDir);
    if (input.copyOf !== undefined) writable.push(input.checkout);
    if (input.policy.knowledge && input.knowledgeDir !== null) writable.push(input.knowledgeDir);
    // QA, the one read-only phase that runs the project's commands, writes their caches from its copy.
    if (input.policy.commands === true) writable.push(...(input.lists?.writable ?? []), ...(input.caches === undefined ? [] : [input.caches]));
  } else {
    writable.push(...(input.lists?.writable ?? []), ...(input.caches === undefined ? [] : [input.caches]));
    writable.push(input.checkout, ...gitWritable(gitDir, input.gitOwnDir ?? gitDir));
    // The card folder of a worktree run sits in the main project, outside the checkout.
    if (!inside(input.cardDir, input.checkout)) writable.push(input.cardDir);
  }

  const others = Object.entries(ENGINE_WALLS).filter(([name]) => name !== input.vendor);
  const system = input.platform === 'linux' ? 'linux' : 'darwin';
  const fixed = underHomes(input, [...HIDDEN_FOR_EVERY_RUN, ...HIDDEN_ON[system], ...others.flatMap(([, other]) => other.logins)]);

  const gitRepos = [{ checkout: input.checkout, common: gitDir, own: input.gitOwnDir ?? gitDir }, ...(input.childRepos ?? [])];
  const holds = gitRepos.map((repo) => gitHolds(repo.checkout, repo.common, repo.own));
  const knowledgeGit = input.policy.knowledge && input.knowledgeDir !== null ? [join(input.knowledgeDir, '.git')] : [];
  const writeDenied = [...row.writeDenied.map(place), ...CHECKOUT_WRITE_DENIED.map((path) => join(input.checkout, path)), ...holds.flatMap((hold) => hold.denied), ...knowledgeGit];
  // A run may rename a writable folder away and move one of its own in, with a config or memory file
  // inside that no write rule ever saw. So every folder from an open state folder down to one of the
  // row's write-denied paths keeps its name.
  const parents = row.writeDenied.map(place).flatMap((path) => {
    const found: string[] = [];
    for (let dir = dirname(path); dir !== dirname(dir) && writable.some((folder) => inside(dir, folder)); dir = dirname(dir)) found.push(dir);
    return found;
  });
  const writeDeniedLiteral = [...holds.flatMap((hold) => hold.literal), ...parents];
  // A worktree's main project holds the person's own `.env` files, and it is readable by default.
  const main = basename(gitDir) === '.git' ? dirname(gitDir) : input.checkout;
  const trees = input.copyOf === undefined ? [input.checkout] : [input.checkout, input.copyOf];
  // An exception or a hidden path names a file of the real checkout, and the copy holds the same
  // file under its own path.
  const copyOf = input.copyOf;
  const onCopy = (paths: readonly string[]) =>
    copyOf === undefined ? paths : paths.flatMap((path) => (path !== copyOf && inside(path, copyOf) ? [path, join(input.checkout, relative(copyOf, path))] : [path]));
  const exceptions = onCopy(input.exceptions).filter((path) => ENV_FILE.test(basename(path)) && !fixed.some((secret) => inside(path, secret)));

  return {
    writable,
    // A session file the engine saves through a temp file beside it, where the whole state folder is not open.
    replaced: system === 'darwin' && row.writable.length === 0 ? [...new Set(row.sessionFiles.map(place))] : [],
    // The project's paths first and the fixed ones last, so the fixed rules close after the lists.
    hidden: [...new Set([...onCopy(input.lists?.hidden ?? []), ...fixed])],
    writeDenied: [...new Set(writeDenied)],
    writeDeniedLiteral: [...new Set(writeDeniedLiteral)],
    noLinks: input.policy.readOnly ? [] : [...new Set(gitRepos.flatMap((repo) => gitNoLinks(repo.common, repo.own)))],
    envRoots: [...new Set([...trees, main])],
    envExceptions: [...new Set(exceptions.filter((path) => trees.some((tree) => path !== tree && inside(path, tree))))],
    sockets: system === 'linux' ? LINUX_SOCKETS : [],
  };
}

export interface AppWallInput {
  // The folder QA starts the app in: the card's checkout of the repository, or the project's own clone.
  checkout: string;
  // As in `WallSpecInput`. They default to `<checkout>/.git`.
  gitCommonDir?: string;
  gitOwnDir?: string;
  // As in `WallSpecInput`: the repositories one folder down in the checkout.
  childRepos?: readonly { checkout: string; common: string; own: string }[];
  home: string;
  // As in `WallSpecInput`: the account's home, whose fixed hidden paths are hidden too.
  systemHome?: string;
  tmp: string;
  // `.env` files of the project that stay readable, as for a run.
  exceptions: readonly string[];
  // The project's own lists, checked and resolved: more hidden paths, and the writable caches.
  lists?: { hidden: readonly string[]; writable: readonly string[] };
  platform?: string;
  // As in `WallSpecInput`: the package managers' caches in Nolzu's data folder.
  caches?: string;
}

/**
 * The wall QA's "start the app" runs in. Implement can change the package.json scripts on the card's
 * branch, so the start command is held like a run of the project's commands: the checkout, the temp
 * folder and the project's writable caches open, its git hooks, config and pointers held, `.env` hidden
 * with the project's exceptions, and every engine's login hidden, because the app is no engine. The
 * network stays open, as in every wall, so the app can reach its own services.
 */
export function appWallSpec(input: AppWallInput): WallSpec {
  const gitDir = input.gitCommonDir ?? join(input.checkout, '.git');
  const system = input.platform === 'linux' ? 'linux' : 'darwin';
  const fixed = underHomes(input, [...HIDDEN_FOR_EVERY_RUN, ...HIDDEN_ON[system], ...Object.values(ENGINE_WALLS).flatMap((row) => row.logins)]);
  const holds = [gitHolds(input.checkout, gitDir, input.gitOwnDir ?? gitDir), ...(input.childRepos ?? []).map((repo) => gitHolds(repo.checkout, repo.common, repo.own))];
  const main = basename(gitDir) === '.git' ? dirname(gitDir) : input.checkout;
  return {
    writable: [...new Set([input.tmp, input.checkout, ...(input.lists?.writable ?? []), ...(input.caches === undefined ? [] : [input.caches])])],
    hidden: [...new Set([...(input.lists?.hidden ?? []), ...fixed])],
    writeDenied: [...new Set([...CHECKOUT_WRITE_DENIED.map((path) => join(input.checkout, path)), ...holds.flatMap((hold) => hold.denied)])],
    writeDeniedLiteral: [...new Set(holds.flatMap((hold) => hold.literal))],
    envRoots: [...new Set([input.checkout, main])],
    envExceptions: input.exceptions.filter((path) => ENV_FILE.test(basename(path)) && path !== input.checkout && inside(path, input.checkout) && !fixed.some((secret) => inside(path, secret))),
    sockets: system === 'linux' ? LINUX_SOCKETS : [],
  };
}
