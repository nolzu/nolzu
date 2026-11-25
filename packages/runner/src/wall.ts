import { dirname, isAbsolute, normalize } from 'node:path';

// One description of what a run may touch, turned into one walled command: a Seatbelt profile on
// macOS, a bwrap call on Linux. Pure, so the order of the rules can be read in a test. Every way
// out of here that is not a walled command is a refusal with a reason, never the bare engine.

export interface WallSpec {
  // Folders and files the run may write. Everything else is read-only.
  writable: readonly string[];
  // Files the engine saves the safe way: a temp file `<file>.<pid>.<id>.tmp` beside it, then a rename
  // over it, as the Cursor CLI does with its config. macOS opens that temp name beside each one and
  // nothing else in the folder. Linux binds the file itself, and a bound file cannot be renamed over.
  replaced?: readonly string[];
  // Folders or files the run may not read or write.
  hidden: readonly string[];
  // Paths inside a writable folder that stay read-only. They win over `writable`. A `*` stands for
  // one folder name, such as each project's memory folder. macOS holds it as a pattern; on Linux the
  // caller lists the folders that are there (`starredPaths`).
  writeDenied: readonly string[];
  // Exact paths that stay read-only, with nothing under them: a checkout folder and its git pointers,
  // which a run that may write must not rename, replace or delete while it still writes inside them.
  // macOS holds each by name. On Linux a file is bound read-only, and a folder in a writable place is
  // bound onto itself, because a mount point cannot be renamed or removed. A `*` stands for one folder
  // name, and there only a rename or delete is denied; on Linux the caller lists the folders there.
  writeDeniedLiteral?: readonly string[];
  // Folders whose `.env` and `.env.*` files are hidden and read-only. macOS matches every such file
  // by name, wherever it is, because a run that may write could move a folder out from under a root
  // and read the file there. On Linux the caller lists the files at spawn time (`envFilesUnder`),
  // because bwrap hides only paths, and a bound file cannot be moved.
  envRoots: readonly string[];
  // Exact files under `envRoots` that stay readable, such as a `.env.test` the tests need.
  envExceptions: readonly string[];
  // Folders inside a hidden one that stay readable, never writable: a Claude Code run's own folder in
  // the hidden `mcp-runs`, where its config waits for the engine. macOS opens each again after the
  // denies, Linux binds each read-only over the tmpfs that hides its parent.
  reopened?: readonly string[];
  // Writable git folders and files where git writes by name, so a run may make no symbolic link and no
  // hard link there. macOS refuses a new link and a link file renamed in; a folder renamed in with a
  // link inside is not refused, and Linux has no rule, so the check after the run is what holds.
  noLinks?: readonly string[];
  // Linux only: unix sockets a run may not connect to, such as Docker's, whose daemon can write
  // anywhere. A file rule does not stop a connect, so bwrap covers each with /dev/null or a tmpfs.
  // macOS closes them by name in the profile instead (`DAEMON_SOCKET`).
  sockets?: readonly string[];
}

export type WallCommand = { command: string; args: string[] } | { refused: string };

export type PathKind = 'dir' | 'file';

export interface WallOptions {
  // Set when the process already runs inside a sandbox, Codex's own for example. A macOS sandbox
  // cannot start inside another one, so a second wall would fail or do nothing.
  alreadyWalled?: boolean;
  // Linux only: what is at a path, or null when nothing is. bwrap binds only paths that exist.
  kindOf?: (path: string) => PathKind | null;
  // Linux only: the `.env` files found under `envRoots`.
  envFiles?: readonly string[];
  // Linux only: the bwrap binary detection found.
  bwrap?: string;
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// Paths every process writes. The temp folders are where `$TMPDIR` points on macOS. /dev/ptmx makes
// a new terminal.
const ALWAYS_WRITABLE = [
  '(literal "/dev/null")',
  '(literal "/dev/ptmx")',
  '(literal "/dev/tty")',
  '(literal "/dev/dtracehelper")',
  '(subpath "/dev/fd")',
  '(subpath "/private/tmp")',
  '(subpath "/private/var/folders")',
];

// Docker's and Podman's sockets wherever they live: Docker Desktop, OrbStack, Colima, Rancher Desktop,
// Lima and a Podman machine each keep theirs somewhere else, some under the temp folder. Seatbelt
// matches the resolved path. The write deny holds the name: a socket in the temp folder could
// otherwise be renamed to one the rule does not match.
// Limit: by name only. Closing every unix socket needs a real engine run first.
const DAEMON_SOCKET = '/(docker|podman)[^/]*\\.sock$';

const TERMINAL = '^/dev/ttys[0-9]+$';

const sbplString = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

const escaped = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const starred = (path: string, tail: string) => `(regex ${sbplString(`^${path.split('*').map(escaped).join('[^/]+')}${tail}`)})`;

// A write-denied path as a Seatbelt filter: by name, or as a pattern when it holds a `*`.
const deniedFilter = (path: string) => (path.includes('*') ? starred(path, '(/|$)') : `(subpath ${sbplString(path)})`);

// An exact path keeps its name. With a `*` only a rename or delete is denied, so the engine can still
// make a new folder there, such as a project folder.
const literalDeny = (path: string) => (path.includes('*') ? `(deny file-write-unlink ${starred(path, '$')})` : `(deny file-write* (literal ${sbplString(path)}))`);

export function seatbeltProfile(spec: WallSpec): string {
  // The last matching rule wins in SBPL, so the order below is the meaning: deny every write,
  // open the allowed places, then close the hidden and write-denied paths inside them again.
  const lines = ['(version 1)', '(allow default)', '(deny file-write* (subpath "/"))'];
  lines.push(`(allow file-write* ${ALWAYS_WRITABLE.join(' ')})`);
  // A terminal opens only to the run that made it: macOS gives the maker this extension, and the run
  // may not issue it to itself. Another window's terminal is neither read nor written. `revoke` hangs
  // up a device with neither, and a run needs it for no device but its own terminal.
  lines.push(
    `(deny file-read-data (regex ${sbplString(TERMINAL)}))`,
    '(deny file-revoke)',
    `(allow file-read-data file-write* file-revoke (require-all (regex ${sbplString(TERMINAL)}) (extension "com.apple.sandbox.pty")))`,
    '(deny file-issue-extension (extension-class "com.apple.sandbox.pty"))',
  );
  for (const path of spec.writable) lines.push(`(allow file-write* (subpath ${sbplString(path)}))`);
  for (const path of spec.replaced ?? []) lines.push(`(allow file-write* (regex ${sbplString(`^${escaped(path)}\\.[0-9]+\\.[0-9a-f-]+\\.tmp$`)}))`);
  for (const path of spec.hidden) lines.push(`(deny file-read* file-write* (subpath ${sbplString(path)}))`);
  // The folder above takes a metadata read too, or the path to the reopened folder cannot be walked.
  for (const path of spec.reopened ?? []) lines.push(`(allow file-read-metadata (literal ${sbplString(dirname(path))}))`, `(allow file-read* (subpath ${sbplString(path)}))`);
  // Writes are denied too: a rename needs no read, and a renamed file no longer matches the name.
  if (spec.envRoots.length > 0) lines.push(`(deny file-read* file-write* (regex ${sbplString('/\\.env(\\.[^/]*)?$')}))`);
  for (const path of spec.envExceptions) {
    // An exception gets its writes back only where the run may write anyway.
    const write = spec.writable.some((folder) => inside(path, folder)) ? ' file-write*' : '';
    lines.push(`(allow file-read*${write} (literal ${sbplString(path)}))`);
  }
  for (const path of spec.writeDenied) lines.push(`(deny file-write* ${deniedFilter(path)})`);
  for (const path of spec.writeDeniedLiteral ?? []) lines.push(literalDeny(path));
  // macOS checks a rename of a file with a second name as a hard link, so both shapes are refused.
  for (const path of spec.noLinks ?? []) lines.push(`(deny file-write-create (require-all (subpath ${sbplString(path)}) (vnode-type SYMLINK)))`, `(deny file-link (subpath ${sbplString(path)}))`);
  lines.push(`(deny network-outbound (remote unix-socket (regex ${sbplString(DAEMON_SOCKET)})))`, `(deny file-write* (regex ${sbplString(DAEMON_SOCKET)}))`);
  // launchd starts an app that `open` names outside the sandbox, and an Apple event makes an app
  // that runs outside it do the work. Either way the file rules above would not hold.
  lines.push('(deny lsopen)', '(deny appleevent-send)');
  return lines.join('\n');
}

export function bwrapArgs(
  spec: WallSpec,
  kindOf: (path: string) => PathKind | null,
  envFiles: readonly string[],
): string[] | { refused: string } {
  // Later mounts cover earlier ones, so the order is the same as the macOS profile's. Network is
  // not unshared: the engine needs its API, and research and MCP tools need the web. A fresh /proc
  // can only be mounted inside a process namespace of its own.
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc'];
  for (const path of spec.writable) {
    if (kindOf(path) === null) {
      return { refused: `The wall cannot start: ${path} does not exist, and bubblewrap can only open a path that is there.` };
    }
    args.push('--bind', path, path);
  }
  // Before the read-only binds below, so a folder bound onto itself does not cover them again.
  for (const path of spec.writeDeniedLiteral ?? []) {
    const kind = kindOf(path);
    if (kind === 'file') args.push('--ro-bind', path, path);
    // Only where the run may write anyway, or the bind would open a read-only folder.
    else if (kind === 'dir' && spec.writable.some((folder) => inside(path, folder))) args.push('--bind', path, path);
  }
  const exceptions = new Set(spec.envExceptions);
  const hidden = [...spec.hidden, ...(spec.sockets ?? []), ...envFiles.filter((file) => !exceptions.has(file))];
  for (const path of hidden) {
    const kind = kindOf(path);
    if (kind === 'dir') args.push('--tmpfs', path);
    else if (kind === 'file') args.push('--ro-bind', '/dev/null', path);
  }
  // After the tmpfs that hides the parent, so the bind shows through it.
  for (const path of spec.reopened ?? []) if (kindOf(path) === 'dir') args.push('--ro-bind', path, path);
  for (const path of spec.writeDenied) {
    // bwrap cannot hold a path that is not there yet. macOS holds it by name. So on Linux the caller
    // opens only the engines' session folders, or a whole state folder whose new names it looks for
    // after the run, and a writable checkout's missing hook names are checked after the run (`walled`
    // in spawn.ts).
    if (kindOf(path) === null) continue;
    // Binding it again would show what the hidden folder covers.
    if (hidden.some((folder) => inside(path, folder))) continue;
    args.push('--ro-bind', path, path);
  }
  return args;
}

// macOS resolves these through /private, and Seatbelt matches the resolved path.
const darwinPath = (path: string) => path.replace(/^\/(tmp|var|etc)(?=\/|$)/, '/private/$1');

function cleaned(spec: WallSpec, map: (path: string) => string): WallSpec | { refused: string } {
  const all = [...spec.writable, ...(spec.replaced ?? []), ...spec.hidden, ...spec.writeDenied, ...(spec.writeDeniedLiteral ?? []), ...spec.envRoots, ...spec.envExceptions, ...(spec.sockets ?? []), ...(spec.reopened ?? []), ...(spec.noLinks ?? [])];
  const relative = all.find((path) => !isAbsolute(path));
  if (relative !== undefined) return { refused: `The wall cannot start: ${relative} is not an absolute path.` };
  // A reopened folder only ever gives back part of a hidden one, never a path the wall did not hide.
  const loose = (spec.reopened ?? []).find((path) => !spec.hidden.some((folder) => path !== folder && inside(normalize(path), normalize(folder))));
  if (loose !== undefined) return { refused: `The wall cannot start: ${loose} is opened again, but sits inside no hidden folder.` };
  const fix = (paths: readonly string[]) => paths.map((path) => map(normalize(path).replace(/(.)\/+$/, '$1')));
  return {
    writable: fix(spec.writable),
    replaced: fix(spec.replaced ?? []),
    hidden: fix(spec.hidden),
    writeDenied: fix(spec.writeDenied),
    writeDeniedLiteral: fix(spec.writeDeniedLiteral ?? []),
    envRoots: fix(spec.envRoots),
    envExceptions: fix(spec.envExceptions),
    sockets: fix(spec.sockets ?? []),
    reopened: fix(spec.reopened ?? []),
    noLinks: fix(spec.noLinks ?? []),
  };
}

export function wallCommand(
  platform: string,
  spec: WallSpec,
  command: string,
  args: readonly string[],
  options: WallOptions = {},
): WallCommand {
  if (platform !== 'darwin' && platform !== 'linux') {
    return { refused: `Nolzu cannot wall a run on ${platform}. It runs on macOS and Linux.` };
  }
  if (options.alreadyWalled) {
    return { refused: 'This process already runs inside a sandbox, and a second wall inside it would fail. Start the engine with its own sandbox instead.' };
  }
  if (platform === 'darwin') {
    const clean = cleaned(spec, darwinPath);
    if ('refused' in clean) return clean;
    return { command: SANDBOX_EXEC, args: ['-p', seatbeltProfile(clean), command, ...args] };
  }
  const clean = cleaned(spec, (path) => path);
  if ('refused' in clean) return clean;
  if (options.kindOf === undefined) return { refused: 'The wall cannot start: nothing told it which paths exist.' };
  if (clean.envRoots.length > 0 && options.envFiles === undefined) {
    return { refused: 'The wall cannot start: the .env files of the project were not listed, so it cannot hide them.' };
  }
  const bwrap = bwrapArgs(clean, options.kindOf, options.envFiles ?? []);
  if ('refused' in bwrap) return bwrap;
  return { command: options.bwrap ?? 'bwrap', args: [...bwrap, '--', command, ...args] };
}
