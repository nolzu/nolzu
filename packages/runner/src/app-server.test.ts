import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appWall, installApp, installCommand, startApp } from './app-server.ts';
import { systemHome } from './engine-walls.ts';
import { wallHere } from './wall-detect.ts';
import type { WallSpec } from './wall.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-app-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A dev server in a few lines: it listens on PORT and says where, the way vite does, colours and all.
// It writes its process id before it says anything, for the check that a stop took it down.
const server = (says: string) => {
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((request, response) => response.end('ok')).listen(port, () => {
  writeFileSync('server.pid', String(process.pid));
  console.log(${says});
});
`,
  );
  return 'node server.mjs';
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The server's process and not its port: a freed port can be taken at once by another test on a busy
// machine, and a request there would read a stranger's answer as the server still up.
const serverGone = () => vi.waitFor(() => expect(alive(Number(readFileSync(join(dir, 'server.pid'), 'utf8')))).toBe(false), { timeout: 5000 });

const answers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const portOf = (address: string | null) => Number(new URL(address ?? 'http://localhost').port);

it('starts the app on a free port, reads the address it printed, and stops it', async () => {
  const command = server("'  \\u001b[32m➜\\u001b[39m  Local:   \\u001b[36mhttp://localhost:' + port + '/\\u001b[39m'");

  const app = await startApp(command, { cwd: dir, env: process.env });

  expect(app.address).toMatch(/^http:\/\/localhost:\d+\/$/);
  expect(await answers(portOf(app.address))).toBe(true);
  await app.stop();
  await serverGone();
});

// A pipe can hand the output over in two chunks with the cut inside the address. The part read first
// names another port, so only a whole line counts.
it('reads an address cut across two chunks whole', async () => {
  writeFileSync(
    join(dir, 'split.mjs'),
    `import { createServer } from 'node:http';
const port = String(process.env.PORT);
process.stdout.write('Local: http://localhost:' + port.slice(0, 2));
setTimeout(() => {
  process.stdout.write(port.slice(2) + '/' + String.fromCharCode(10));
  createServer((request, response) => response.end('ok')).listen(Number(port));
}, 300);
`,
  );

  const app = await startApp('node split.mjs', { cwd: dir, env: process.env });

  expect(app.address).toMatch(/^http:\/\/localhost:\d{4,5}\/$/);
  await app.stop();
});

// The launcher sets ORIGIN, PORT and HOST for Nolzu's own server. The app gets its own PORT and not
// the other two, so code from the card's branch is not handed Nolzu's address.
it("keeps Nolzu's ORIGIN and HOST from the app", async () => {
  const seen = `node -e "require('node:fs').writeFileSync('seen.json', JSON.stringify({ o: process.env.ORIGIN, h: process.env.HOST }))"; ${server("'ready'")}`;
  const app = await startApp(seen, { cwd: dir, env: { ...process.env, ORIGIN: 'http://127.0.0.1:4319', HOST: '127.0.0.1', PORT: '4319' } });
  await app.stop();

  expect(readFileSync(join(dir, 'seen.json'), 'utf8')).toBe('{}');
  expect(portOf(app.address)).not.toBe(4319);
});

// The app is code from the card's branch, so it could push or publish with a token from the shell.
it('keeps the GitHub and npm tokens from the app', async () => {
  const tokens = { GH_TOKEN: 'x', GITHUB_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'x', NPM_TOKEN: 'x', NODE_AUTH_TOKEN: 'x' };
  const names = JSON.stringify(Object.keys(tokens)).replaceAll('"', "'");
  const seen = `node -e "require('node:fs').writeFileSync('seen.json', JSON.stringify(${names}.filter((name) => name in process.env)))"; ${server("'ready'")}`;
  const app = await startApp(seen, { cwd: dir, env: { ...process.env, ...tokens } });
  await app.stop();

  expect(readFileSync(join(dir, 'seen.json'), 'utf8')).toBe('[]');
});

// Not every dev server prints its address, so the port Nolzu handed it answering is enough.
it('takes the port answering when the app prints no address', async () => {
  const app = await startApp(server("'ready'"), { cwd: dir, env: process.env });

  expect(app.address).toMatch(/^http:\/\/localhost:\d+$/);
  expect(await answers(portOf(app.address))).toBe(true);
  await app.stop();
});

// A fresh checkout with no installed packages is the usual case, and the command's own words say so.
it('refuses with the last line of the command when it exits before the app answers', async () => {
  await expect(startApp('echo "sh: vite: command not found" >&2; exit 127', { cwd: dir, env: process.env })).rejects.toThrow(/exited 127.*vite: command not found/);
});

// Your own commands may exit once the app is up, as `docker compose up -d` does. The exit with 0 is the
// start, and the `<name> <url>` lines it printed name the apps.
it('takes a start that may exit and exits 0 as up, with the named lines it printed', async () => {
  const app = await startApp('echo "Container api Started" >&2; echo "api http://localhost:8787/recipes"; echo "web http://localhost:$PORT"', { cwd: dir, env: process.env, mayExit: true });

  expect(app.exited).toBe(true);
  expect(app.address).toBe('http://localhost:8787/recipes');
  expect(app.named).toEqual(['api http://localhost:8787/recipes', expect.stringMatching(/^web http:\/\/localhost:\d+$/)]);
  expect(app.output).toContain('Container api Started\n');
  await app.stop();
});

it('takes a start that may exit and prints nothing as up with no address', async () => {
  const app = await startApp('true', { cwd: dir, env: process.env, mayExit: true });

  expect(app).toMatchObject({ address: null, named: [], exited: true });
});

it('takes a start that may exit and keeps running as up, and stops it', async () => {
  const app = await startApp(server("'Local: http://localhost:' + port + '/'"), { cwd: dir, env: process.env, mayExit: true });

  expect(app.exited).toBe(false);
  expect(await answers(portOf(app.address))).toBe(true);
  await app.stop();
  await serverGone();
});

// A script can print an address it waits for, such as a database it polls. For a start that may exit,
// only its exit or its PORT answering counts, never a printed address.
it('does not take a printed address as up for a start that may exit', async () => {
  await expect(startApp('echo "waiting for http://localhost:5432"; sleep 1; echo "no database" >&2; exit 3', { cwd: dir, env: process.env, mayExit: true })).rejects.toThrow(/exited 3.*no database/);
});

it('refuses a start that may exit when it exits with another code, with its last line', async () => {
  await expect(startApp('echo "Cannot connect to the Docker daemon" >&2; exit 1', { cwd: dir, env: process.env, mayExit: true })).rejects.toThrow(/exited 1.*Docker daemon/);
  // The whole of what it printed goes with the failure, for the run's log.
  const failed = await startApp('echo "loading"; echo "the worker died" >&2; exit 1', { cwd: dir, env: process.env, mayExit: true }).catch((error: Error & { output?: string }) => error);
  // Two pipes, so the order of the two lines is not fixed.
  for (const line of ['loading\n', 'the worker died\n']) expect((failed as Error & { output?: string }).output).toContain(line);
});

// A command whose shell starts a child, as `npm run dev` does, and writes the child's pid. A kill of the
// shell alone would leave the child running, so these see that the whole group went.
const SLEEPER = 'sleep 30 & echo $! > child.pid; wait';

// A start that must never be up needs a port nothing answers on for the whole wait. A port the system
// hands out (49152 and up on macOS, 32768 and up on Linux) can go to another test's server between the
// pick and the probe, which read that server as this app up. One below both ranges, free now, is one
// no other test can be handed.
const quietPort = async (): Promise<number> => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
};
const child = () => Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
// The tests below that must never see the app up hand it a port of their own, so the app has to get it.
it('hands the app the port a test gives it', async () => {
  const port = await quietPort();
  const app = await startApp(server("'ready'"), { cwd: dir, env: process.env, port });

  expect(app.address).toBe(`http://localhost:${port}`);
  await app.stop();
  await serverGone();
});

// Your own start may pull an image for minutes, so its refusal says how long Nolzu waited.
it('names the wait when your own start command does not finish', async () => {
  await expect(startApp(SLEEPER, { cwd: dir, env: process.env, mayExit: true, timeoutMs: 500, port: await quietPort() })).rejects.toThrow(/did not finish in 1 s, so Nolzu stopped it/);
});

it('stops an app that has not answered by the timeout, with what it started', async () => {
  await expect(startApp(SLEEPER, { cwd: dir, env: process.env, timeoutMs: 500, port: await quietPort() })).rejects.toThrow(/did not answer in 1 s, so Nolzu stopped it/);

  await vi.waitFor(() => expect(alive(child())).toBe(false), { timeout: 5000 });
});

it('stops the start when the run is stopped, with what it started', async () => {
  const stop = new AbortController();
  const starting = startApp(SLEEPER, { cwd: dir, env: process.env, signal: stop.signal, port: await quietPort() });
  await vi.waitFor(() => expect(existsSync(join(dir, 'child.pid'))).toBe(true), { timeout: 5000 });
  stop.abort();

  await expect(starting).rejects.toThrow(/stopped/);
  await vi.waitFor(() => expect(alive(child())).toBe(false), { timeout: 5000 });
});

// npm prints the script it runs before the script's own output, so a URL in the script text must not count.
it('does not take an address with no port that the command text names', async () => {
  const app = await startApp(`echo "> node serve http://localhost:" >&2; ${server("'ready'")}`, { cwd: dir, env: process.env });

  expect(app.address).toMatch(/^http:\/\/localhost:\d+$/);
  await app.stop();
  // The server here is the shell's child, not the shell, and it goes with the group.
  await serverGone();
});

// A server that listens on every interface says 0.0.0.0, which is where it listens and not where QA looks.
it('gives QA localhost for an app that prints 0.0.0.0', async () => {
  const app = await startApp(server("'Network: http://0.0.0.0:' + port + '/'"), { cwd: dir, env: process.env });

  expect(app.address).toBe(`http://localhost:${portOf(app.address)}/`);
  await app.stop();
});

it('refuses at once when the run was stopped before the start', async () => {
  const stop = new AbortController();
  stop.abort();

  await expect(startApp(SLEEPER, { cwd: dir, env: process.env, signal: stop.signal, timeoutMs: 5000 })).rejects.toThrow(/stopped with the run/);
});

it('gives a start two minutes by default', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const starting = startApp(SLEEPER, { cwd: dir, env: process.env });
    const refused = expect(starting).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await refused;
  } finally {
    vi.useRealTimers();
  }
});

// The start command runs in a shell inside the wall, so the scripts it starts are held as well.
it('starts the command through the wall it is handed', async () => {
  const seen: { spec: WallSpec; command: string; args: readonly string[] }[] = [];
  const wall: WallSpec = { writable: [dir], hidden: [], writeDenied: [], envRoots: [dir], envExceptions: [] };
  const app = await startApp(server("'ready'"), {
    cwd: dir,
    env: process.env,
    wall,
    wallPort: (spec, command, args) => {
      seen.push({ spec, command, args });
      return { command, args: [...args] };
    },
  });
  await app.stop();

  expect(seen).toEqual([{ spec: wall, command: '/bin/sh', args: ['-c', 'node server.mjs'] }]);
});

it('starts nothing when the wall refuses', async () => {
  const wall: WallSpec = { writable: [], hidden: [], writeDenied: [], envRoots: [], envExceptions: [] };
  await expect(startApp(SLEEPER, { cwd: dir, env: process.env, wall, wallPort: () => ({ refused: 'The wall cannot start: no reason.' }) })).rejects.toThrow('no reason');
  expect(existsSync(join(dir, 'child.pid'))).toBe(false);
});

// The lists come back as real paths. A project reached through a link still maps a hidden path onto the
// card's checkout, and a repository one folder down keeps its hooks, as in Implement.
it('maps the hidden list onto the checkout through a link, and holds the repositories one folder down', () => {
  mkdirSync(join(dir, 'project', '.git'), { recursive: true });
  symlinkSync(join(dir, 'project'), join(dir, 'link'));
  mkdirSync(join(dir, 'wt', 'APP-1', 'sub', '.git'), { recursive: true });
  const checkout = join(realpathSync(dir), 'wt', 'APP-1');
  const wall = appWall({ checkout: join(dir, 'wt', 'APP-1'), repoFolder: join(dir, 'link'), project: join(dir, 'link'), walls: { hidden: ['secret.txt'], exceptions: [], writable: [] }, env: process.env });

  expect(wall.hidden).toContain(join(checkout, 'secret.txt'));
  // Whatever HOME says, the account's own ~/.ssh is hidden from the app as well.
  expect(appWall({ checkout, repoFolder: checkout, project: checkout, walls: { hidden: [], exceptions: [], writable: [] }, env: { ...process.env, HOME: dir } }).hidden).toEqual(
    expect.arrayContaining([join(dir, '.ssh'), join(systemHome() ?? dir, '.ssh')]),
  );
  expect(wall.writeDenied).toContain(join(checkout, 'sub', '.git', 'hooks'));
  expect(wall.writeDeniedLiteral).toContain(join(checkout, 'sub', '.git'));
});

// The real wall on this machine: the app answers, and the .env file beside it stays out of its reach.
it.runIf(process.platform === 'darwin' && wallHere().ready)('keeps .env from the app inside the real wall', async () => {
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
let env = 'read';
try { readFileSync('.env'); } catch { env = 'hidden'; }
createServer((request, response) => response.end(env)).listen(Number(process.env.PORT));
`,
  );
  const wall = appWall({ checkout: dir, repoFolder: dir, project: dir, walls: { hidden: [], exceptions: [], writable: [] }, env: process.env });
  const app = await startApp('node server.mjs', { cwd: dir, env: process.env, wall });
  const said = await (await fetch(app.address ?? '')).text();
  await app.stop();

  expect(said).toBe('hidden');
});

// The install a checkout needs: the one its lock file names, and none once node_modules is there.
it('names the install of the lock file found, and none with node_modules or no lock file', () => {
  expect(installCommand(dir)).toBeNull();
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  expect(installCommand(dir)).toBe('npm ci');
  writeFileSync(join(dir, 'yarn.lock'), '');
  expect(installCommand(dir)).toBe('yarn install --frozen-lockfile');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  expect(installCommand(dir)).toBe('pnpm install --frozen-lockfile');
  mkdirSync(join(dir, 'node_modules'));
  expect(installCommand(dir)).toBeNull();
});

it('runs an install to its end, and fails with its last line', async () => {
  await installApp('mkdir node_modules', { cwd: dir });
  expect(existsSync(join(dir, 'node_modules'))).toBe(true);
  await expect(installApp('echo one; echo "error two" >&2; exit 1', { cwd: dir })).rejects.toThrow(/^error two$/);
});
