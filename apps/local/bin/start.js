import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from '@nolzu/core/node';
import { detectEngines, runVersion, startPath } from '@nolzu/runner/detect';
import { CLOUD_OPEN } from '@nolzu/protocol';
import { alreadyRunning, browserCommand, freePort, lockHeld, NO_ACCOUNT, NOT_BUILT, parseCommand, platformRefusal, platformWarning, runningAt, shutdownDefault, startLine, startRefusal, USAGE, versionOutput, writeRecord } from '../src/lib/bin.ts';

const stop = (message) => {
  console.error(message);
  process.exit(1);
};

// Before anything else, so a Windows start opens no database, port or keychain.
const kernelRelease = (() => {
  try {
    return process.platform === 'linux' ? readFileSync('/proc/sys/kernel/osrelease', 'utf8') : null;
  } catch {
    return null;
  }
})();
const refusal = platformRefusal(process.platform, kernelRelease);
if (refusal !== null) stop(refusal);
const warning = platformWarning(process.platform);
if (warning !== null) console.error(warning);

const command = parseCommand(process.argv.slice(2));

if (command.kind === 'usage') stop([command.problem, '', ...USAGE].join('\n'));

if (command.kind === 'help') {
  console.log(USAGE.join('\n'));
  process.exit(0);
}

// The same file in a clone (apps/local) and in an install (the package root). Git is asked only in a
// clone, where no build put the version line into this file.
if (command.kind === 'version') {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return null;
    }
  };
  console.log(versionOutput(version, git));
  process.exit(0);
}

// While the cloud is closed there is no account to talk to, so the account commands say so and leave
// before anything reads the keychain or the network.
if (command.kind !== 'serve' && !CLOUD_OPEN) {
  console.log(NO_ACCOUNT);
  process.exit(0);
}

// The account commands need no build and no server of our own, so they answer here and leave. The
// runner is loaded only for them: starting Nolzu should not pay for the git and engine modules it
// pulls in.
if (command.kind !== 'serve') {
  const { accountCommand, cloudUrl, createKeychain, machineName, runKeychain } = await import('@nolzu/runner');
  const cloud = {
    keychain: createKeychain(process.platform, runKeychain, resolveDataDir(process.env)),
    baseUrl: cloudUrl(process.env),
    machine: machineName(hostname()),
    say: (line) => console.log(line),
  };
  // A server that cannot be reached says "fetch failed" and nothing else, which names neither the
  // address nor the thing to check. Every other failure, such as a locked keychain, already says what
  // it was, and a sentence about the network on top of it would name the wrong cause.
  const code = await accountCommand(command.kind, cloud).catch((error) =>
    stop(error.message === 'fetch failed' ? `Nolzu could not reach ${cloud.baseUrl}.` : error.message),
  );

  // The paid package follows the account: signing in brings it down, signing out takes it away.
  // Both are silent, because a client with no package is the free client and that is not a fault.
  const { packageDir, removePackages, syncPackage } = await import('../src/lib/package.ts');
  const packages = packageDir(process.env);
  if (command.kind === 'login' && code === 0) await syncPackage(packages, cloud);
  if (command.kind === 'logout') removePackages(packages);

  process.exit(code);
}

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..', 'build', 'index.js');
const dataDir = resolveDataDir(process.env);
// The same file in a clone (apps/local) and in an install (the package root).
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

// No browser here, which is normal over SSH: the address printed is the way in. A system with the tool
// missing is the same case as a system with no browser: the address is the way in, and the app keeps
// running.
const browser = command.open ? browserCommand(process.platform, process.env) : null;
const open = (url) => {
  if (browser !== null) spawn(browser.command, [...browser.args, url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
};
const openRunning = (running) => {
  for (const line of alreadyRunning(running.url, browser !== null, running.version, version)) console.log(line);
  open(running.url);
  process.exit(0);
};

// One Nolzu per data folder, from any folder: a second start opens the one that runs and leaves. It
// comes before the port, because the port asked for is the one the running copy holds.
const running = await runningAt(dataDir);
if (running !== null) openRunning(running);

if (!existsSync(server)) stop(NOT_BUILT);

// These are sentences for the person, not crashes: a stack trace around them helps nobody.
const port = await freePort(process.env).catch((error) => stop(error.message));
const url = `http://localhost:${port}`;

// The port was free a moment ago. Another program can still take it before the server binds. The
// start below catches that itself, and this stays for anything thrown outside it.
const refuse = (error) => stop(startRefusal(error, port));
process.on('uncaughtException', refuse);

// The writer lock refuses a start while another Nolzu holds the data folder. That one may still be
// booting, as when the login item and a typed nolzu start together: it found no record above and
// writes one once it listens, so it is waited for and opened. One that holds the lock and never
// answers is refused, three seconds later.
const refuseUnlessStarting = async (error) => {
  for (let tries = 0; lockHeld(error) && tries < 10; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = await runningAt(dataDir);
    if (started !== null) openRunning(started);
  }
  refuse(error);
};

process.env.PORT = String(port);
// Only this machine. Nolzu runs the person's agents in their checkout; the network has no business here.
process.env.HOST = '127.0.0.1';
// Without it the server assumes https and refuses every form as cross-site, so nothing in the app works.
process.env.ORIGIN = url;
// Ctrl+C stops at once: an open page's live stream would hold the exit for 30 seconds.
shutdownDefault(process.env);
// An installed copy has no skills package. The build copies the skills and the shared rules into dist/,
// and the server reads them from there. A clone still reads the live package first. Set even when the
// env has one, because a nolzu started inside a run of another install must read its own copy.
process.env.NOLZU_SKILLS_DIR = join(here, '..', 'dist');

// Before the version checks and the server: every git, gh and agent call inherits this PATH, so a
// Nolzu started outside a terminal finds what the person's shell finds (startPath says why).
process.env.PATH = startPath(process.env);

// Asked while the server loads, so the two waits overlap.
const tools = detectEngines(runVersion(process.env));

// adapter-node prints its own address line, on the 127.0.0.1 spelling the app sends away to localhost.
// The block below names the address instead.
const log = console.log;
console.log = (...args) => {
  if (!/^Listening on /.test(String(args[0]))) log(...args);
};

// The address, the record and the browser wait for the server. A start the app refuses, such as a
// database from a newer Nolzu, used to print an address and open a tab on a port nobody served.
const { server: app } = await import(server).catch(refuseUnlessStarting);
if (!app.server.listening) await once(app.server, 'listening').catch(refuse);
console.log = log;

// Only now, so a second start never opens a port this server is not on yet.
writeRecord(dataDir, { pid: process.pid, port, version });

// Before the agent tools answer: a tool that hangs holds these lines for up to five seconds, not the tab.
open(url);
for (const line of startLine({ url, dataDir, home: homedir(), version, tools: await tools, opening: browser !== null }, process.env)) console.log(line);
