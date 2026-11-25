import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type AddressInfo, connect, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveDataDir } from '@nolzu/core/node';
import type { WallLists } from '@nolzu/protocol';
import { packageCaches, RUN_TOKENS } from './engine-env.ts';
import { appWallSpec, systemHome } from './engine-walls.ts';
import { childRepos, gitCommonDir, gitDirs, resolvedPath, specOnDisk, walledCommand } from './wall-detect.ts';
import { OUTPUT_TAIL, stackAddresses } from './stack.ts';
import { checkedWallLists } from './wall-lists.ts';
import type { WallCommand, WallSpec } from './wall.ts';

/**
 * A repository's start command, run for one QA run or one Start on the app line, and stopped after it.
 *
 * A dev command such as `npm run dev` never exits, so it runs in the background, with `PORT` set to a
 * free port, until `stop`. Your own commands may exit once the app is up instead (`mayExit`).
 */
export interface AppServer {
  // Where the app answered, for the QA run's addresses file. Null only for a start that may exit and
  // exited 0 with no local address in what it printed.
  address: string | null;
  // The `<name> <url>` lines it printed (`stackAddresses`), which own commands use to name several apps.
  named: string[];
  // The start command ended on its own with 0, so what it started runs on by itself and its Stop takes it down.
  exited: boolean;
  // What it printed by then, both streams, the last `OUTPUT_TAIL` characters.
  output: string;
  // Stops the app and everything it started, and resolves once it is gone.
  stop: () => Promise<void>;
}

export interface AppStartOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  // The wall the command runs in (`appWall`). Left out only where the wall cannot start on this machine.
  wall?: WallSpec;
  // The walled command for a spec, swapped only by a test.
  wallPort?: (spec: WallSpec, command: string, args: readonly string[]) => WallCommand;
  // The command may exit once the app is up, as `docker compose up -d` does, and an exit with 0 is a
  // start. While it runs, only its PORT answering counts. Your own commands start this way; a dev
  // command that exits has failed.
  mayExit?: boolean;
  // The PORT to hand the app, for a test only. The system's free ports are shared with every process,
  // and a port that was free a moment ago can be another server's by the time the probe knocks.
  port?: number;
}

/**
 * The wall for QA's app start in `checkout`, the card's copy of the project folder `repoFolder`. The
 * project's lists are checked as for a run, and a path they name in the project folder names the same
 * path in the checkout.
 */
export function appWall(input: { checkout: string; repoFolder: string; project: string; walls: WallLists; env: Record<string, string | undefined> }): WallSpec {
  // The lists come back as real paths, so the folders they are mapped between are real too.
  const checkout = resolvedPath(input.checkout);
  const repoFolder = resolvedPath(input.repoFolder);
  const home = input.env.HOME ?? homedir();
  const tmp = input.env.TMPDIR ?? tmpdir();
  const account = systemHome();
  const lists = checkedWallLists(input.walls, {
    home,
    systemHome: account,
    project: input.project,
    gitDir: gitCommonDir(input.project) ?? join(input.project, '.git'),
    dataDir: resolveDataDir(process.env),
    needed: [checkout, tmp],
    real: resolvedPath,
  });
  const onCheckout = (paths: readonly string[]) =>
    checkout === repoFolder ? paths : paths.flatMap((path) => (path.startsWith(`${repoFolder}/`) ? [path, join(checkout, relative(repoFolder, path))] : [path]));
  const dirs = gitDirs(checkout);
  const spec = appWallSpec({
    checkout,
    gitCommonDir: dirs?.common,
    gitOwnDir: dirs?.own,
    // The app may write the checkout, so a repository one folder down keeps its hooks and pointers as in Implement.
    childRepos: childRepos(checkout).flatMap((child) => [gitDirs(child)].flatMap((found) => (found === undefined ? [] : [{ checkout: child, ...found }]))),
    home,
    systemHome: account,
    tmp,
    exceptions: onCheckout(lists.exceptions),
    lists: { hidden: onCheckout(lists.hidden), writable: lists.writable },
    platform: process.platform,
    caches: resolvedPath(packageCaches(resolveDataDir(process.env)).dir),
  });
  // bwrap opens only a path that is there, so a missing cache folder stays closed.
  return process.platform === 'linux' ? specOnDisk(spec) : spec;
}

// Two minutes. A dev server answers in seconds, and QA holds the stack lane while it waits.
export const APP_START_TIMEOUT_MS = 2 * 60 * 1000;

// How long an app that ignored SIGTERM gets before it is killed outright, as for a Stop command.
const KILL_GRACE_MS = 5000;

// The first local address an app prints. 0.0.0.0 is where it listens and not where to look. The port is
// required because npm echoes the script text first, and a script may name a host with no port.
const LOCAL_ADDRESS = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"]*/;
// Colour codes, which dev servers print around the address.
// eslint-disable-next-line no-control-regex -- the escape character is what these codes start with
const COLOURS = /\u001b\[[0-9;]*[A-Za-z]/g;

// A port nothing listens on right now, from the system.
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

// The whole process group, because the shell's child is the server and a kill of the shell alone
// leaves it running.
const killGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (child.pid === undefined) throw new Error('no pid');
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Nothing left to stop.
    }
  }
};

const lastLine = (output: string): string => {
  const line = output.replace(COLOURS, '').trim().split('\n').at(-1)?.trim() ?? '';
  return line === '' ? '' : ` ${line}`;
};

// The command in its own process group, inside the wall when there is one, with the env an app gets.
function spawnApp(command: string, options: AppStartOptions, extra: Record<string, string>): ChildProcess {
  // The shell the command needs runs inside the wall, so every script it starts is held as well.
  const walled = options.wall === undefined ? null : (options.wallPort ?? walledCommand)(options.wall, '/bin/sh', ['-c', command]);
  if (walled !== null && 'refused' in walled) throw new Error(walled.refused);
  // Inside the wall the home folder is read-only, so the package caches go to Nolzu's data folder.
  const caches = options.wall === undefined ? {} : packageCaches(resolveDataDir(process.env)).env;
  const env: Record<string, string | undefined> = { ...options.env, ...caches, ...extra, PWD: options.cwd };
  // The launcher sets these for Nolzu's own server. The app is code from the card's branch, so it
  // gets no address of Nolzu for free, and a framework that reads them binds as it would for you.
  delete env.ORIGIN;
  delete env.HOST;
  // The same code could push or publish with a token from your shell, as a run could.
  for (const name of RUN_TOKENS) delete env[name];
  const how: SpawnOptions = { cwd: options.cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] };
  return walled === null ? spawn(command, { ...how, shell: true }) : spawn(walled.command, walled.args, how);
}

// The lock files an install is read from, and the install each asks for, in the order they are looked for.
const LOCK_INSTALLS = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
] as const;

/**
 * The install a checkout needs before its start command: the one its lock file names, while it has no
 * node_modules. A card's checkout is a fresh worktree, so its tools are missing until then. Null when it
 * needs none.
 */
export function installCommand(folder: string): string | null {
  if (existsSync(join(folder, 'node_modules'))) return null;
  return LOCK_INSTALLS.find(([file]) => existsSync(join(folder, file)))?.[1] ?? null;
}

// Ten minutes. A first install with a cold cache downloads every package.
export const APP_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Runs an install the way `startApp` runs the start, to its end. It fails with the output's last line. */
export async function installApp(command: string, options: AppStartOptions): Promise<void> {
  const child = spawnApp(command, options, {});
  let output = '';
  const heard = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
  };
  child.stdout?.on('data', heard);
  child.stderr?.on('data', heard);
  const stop = (): void => killGroup(child, 'SIGKILL');
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    stop();
  }, options.timeoutMs ?? APP_INSTALL_TIMEOUT_MS);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (options.signal?.aborted === true) throw new Error('The install was stopped with the run.');
    if (late) throw new Error('it did not end in time, so Nolzu stopped it');
    if (code !== 0) throw new Error(lastLine(output).trim() || `it exited ${code ?? 'on a signal'}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}

// A wait as a person says it: whole minutes from one minute on, seconds below.
const spoken = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${ms >= 90_000 ? 's' : ''}` : `${Math.round(ms / 1000)} s`);

export async function startApp(command: string, options: AppStartOptions): Promise<AppServer> {
  const port = options.port ?? (await freePort());
  const child = spawnApp(command, options, { PORT: String(port) });
  return new Promise<AppServer>((resolve, reject) => {
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killGroup(child, 'SIGTERM');
      const hard = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      await closed;
      clearTimeout(hard);
    };

    let output = '';
    let settled = false;
    // Whole lines only while the app runs: a chunk can end inside an address, and the part read so far
    // would name another port. At the exit every byte is in.
    const printed = (text: string = output): string | null => LOCAL_ADDRESS.exec(text.replace(COLOURS, ''))?.[0].replace('0.0.0.0', 'localhost') ?? null;
    const whole = (): string => output.slice(0, output.lastIndexOf('\n') + 1);
    const finish = (up: { address: string | null; exited: boolean } | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(probe);
      options.signal?.removeEventListener('abort', aborted);
      if (up !== null) {
        resolve({ ...up, named: stackAddresses(output), output, stop });
        return;
      }
      void stop();
      // What it printed goes with the failure, because the sentence carries its last line only.
      reject(error === undefined ? error : Object.assign(error, { output }));
    };
    // Read to the end even after the start, or a full pipe would hold the app still. A start that may
    // exit is not up on an address it prints, because a script can print one it waits for, such as a
    // database it polls. It is up on its exit with 0, or on its PORT answering.
    const heard = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
      const found = options.mayExit === true ? null : printed(whole());
      if (found !== null) finish({ address: found, exited: false });
    };
    child.stdout?.on('data', heard);
    child.stderr?.on('data', heard);
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) =>
      options.mayExit === true && code === 0
        ? finish({ address: printed(), exited: true })
        : finish(null, new Error(`The app's start command exited ${code ?? 'on a signal'} before the app answered.${lastLine(output)}`)),
    );

    // The wait is named, because a first image pull can outlast it and the person picks what to do.
    const wait = options.timeoutMs ?? APP_START_TIMEOUT_MS;
    const said = options.mayExit === true ? `The start command did not finish in ${spoken(wait)}` : `The app did not answer in ${spoken(wait)}`;
    const timer = setTimeout(() => finish(null, new Error(`${said}, so Nolzu stopped it.${lastLine(output)}`)), wait);
    // An app that prints no address still answers on the port it was handed.
    const probe = setInterval(() => {
      const socket = connect({ port, host: 'localhost' });
      socket.once('connect', () => {
        socket.destroy();
        finish({ address: `http://localhost:${port}`, exited: false });
      });
      socket.once('error', () => socket.destroy());
    }, 250);

    const aborted = (): void => finish(null, new Error('The app start was stopped with the run.'));
    if (options.signal?.aborted === true) aborted();
    else options.signal?.addEventListener('abort', aborted, { once: true });
  });
}
