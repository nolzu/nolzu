import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOUD_OPEN } from '@nolzu/protocol';
import { alreadyRunning, browserCommand, crossSiteFetch, crossSiteRead, crossSiteWrite, foreignHost, freePort, localhostRedirect, lockHeld, NO_ACCOUNT, NOT_BUILT, parseCommand, platformRefusal, platformWarning, PORT_RANGE, portBusyNote, readRecord, RECORD, runningAt, shutdownDefault, startLine, startRefusal, SUBCOMMANDS, USAGE, usage, versionOutput, writeRecord } from './bin.ts';

// Not the range the command uses, so a test never fights a Nolzu the person has open.
const RANGE = { first: 5340, last: 5344 };

const busy = (port: number) =>
  new Promise<() => void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(() => server.close()));
  });

describe('freePort', () => {
  it('starts at the first port of the range when it is free', async () => {
    await expect(freePort({}, RANGE)).resolves.toBe(RANGE.first);
  });

  it('takes the next one when the first is busy', async () => {
    const close = await busy(RANGE.first);
    try {
      await expect(freePort({}, RANGE)).resolves.toBe(RANGE.first + 1);
    } finally {
      close();
    }
  });

  it('takes the port the person asked for', async () => {
    await expect(freePort({ NOLZU_PORT: String(RANGE.last) }, RANGE)).resolves.toBe(RANGE.last);
  });

  it.each(['abc', '0', '-1', '70000', '12.5'])('refuses %j as a port, and names the setting', async (port) => {
    await expect(freePort({ NOLZU_PORT: port }, RANGE)).rejects.toThrow(/NOLZU_PORT/);
  });

  // Without this the one case where a person picks the port by hand is the one case with no message.
  it('says the port asked for is busy, instead of leaving the server to fail on it', async () => {
    const close = await busy(RANGE.first);
    try {
      await expect(freePort({ NOLZU_PORT: String(RANGE.first) }, RANGE)).rejects.toThrow(portBusyNote(RANGE.first));
    } finally {
      close();
    }
  });

  it('names the range and the setting when every port in it is busy', async () => {
    const closers = [];
    for (let port = RANGE.first; port <= RANGE.last; port += 1) closers.push(await busy(port));
    try {
      await expect(freePort({}, RANGE)).rejects.toThrow(new RegExp(`${RANGE.first}.*${RANGE.last}.*NOLZU_PORT`));
    } finally {
      for (const close of closers) close();
    }
  });

  it('uses a bookmarkable range by default, not a random port', () => {
    expect(PORT_RANGE.last).toBeGreaterThan(PORT_RANGE.first);
  });
});

describe('portBusyNote', () => {
  it('names the port and the way out', () => {
    expect(portBusyNote(4319)).toBe('Port 4319 is busy. Free it, or set NOLZU_PORT to another port.');
  });
});

describe('localhostRedirect', () => {
  // The server answers on both spellings, but its cross-site rule trusts only the printed one, so a page
  // loaded on the other one has every form refused.
  const asked = new URL('http://localhost:4319/b/APP-1?tab=log');

  it.each(['127.0.0.1:4319', '[::1]:4319'])('sends a page asked for on %s to localhost, path and query kept', (host) => {
    expect(localhostRedirect(host, asked)).toBe('http://localhost:4319/b/APP-1?tab=log');
  });

  it('keeps the port the browser used, not the one the server was told', () => {
    expect(localhostRedirect('127.0.0.1:4321', asked)).toBe('http://localhost:4321/b/APP-1?tab=log');
  });

  it('leaves the address alone when it is already localhost', () => {
    expect(localhostRedirect('localhost:4319', asked)).toBeNull();
  });

  it('leaves a host somebody set on purpose alone, and a request with no host', () => {
    expect(localhostRedirect('nolzu.local:4319', asked)).toBeNull();
    expect(localhostRedirect(null, asked)).toBeNull();
  });
});

// Native Windows is not supported. WSL2 is Linux; WSL1 names its kernel "Microsoft" and counts as Windows.
describe('platformRefusal', () => {
  it('stops native Windows and points to WSL2 and the install guide', () => {
    const said = platformRefusal('win32', null);
    expect(said).toMatch(/^Nolzu runs on macOS\. Native Windows is not supported\. On Windows, WSL2 runs it as Linux, which is not tested yet\./);
    expect(said).toContain('https://nolzu.com/docs/quickstart');
  });

  it('stops WSL1, whose kernel release says Microsoft', () => {
    expect(platformRefusal('linux', '4.4.0-19041-Microsoft\n')).toMatch(/WSL1 is not supported/);
  });

  it.each([
    ['darwin', null],
    ['linux', '6.8.0-45-generic\n'],
    ['linux', '5.15.153.1-microsoft-standard-WSL2\n'],
    ['linux', null],
  ])('lets %s with release %j start', (platform, release) => {
    expect(platformRefusal(platform, release)).toBeNull();
  });
});

// Linux starts with one line that says it is not tested yet; macOS starts quietly.
describe('platformWarning', () => {
  it('warns on Linux only', () => {
    expect(platformWarning('linux')).toMatch(/^Linux, WSL2 included, is not tested yet\./);
    expect(platformWarning('darwin')).toBeNull();
  });
});

describe('browserCommand', () => {
  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ])('opens the browser on %s with %s', (platform, command) => {
    expect(browserCommand(platform, { DISPLAY: ':0' })).toMatchObject({ command });
  });

  it('opens nothing on a platform it does not know', () => {
    expect(browserCommand('sunos', {})).toBeNull();
  });

  // Nolzu is meant to work over SSH, where there is no browser to open.
  it('opens nothing on linux with no display', () => {
    expect(browserCommand('linux', {})).toBeNull();
  });
});

describe('startLine', () => {
  const start = {
    url: 'http://localhost:4319',
    dataDir: '/home/you/.nolzu',
    home: '/home/you',
    version: '1.0.0',
    tools: [
      { binary: 'claude', found: true, version: '2.1.296', error: null },
      { binary: 'cursor-agent', found: false, version: null, error: null },
      { binary: 'codex', found: true, version: '0.145.0', error: null },
    ],
    opening: true,
  };

  // What a first start prints, with the address the server trusts. No plan
  // word, because the terminal cannot read the signed display document every plan line follows.
  it('prints the version, the agent tools, the data folder, the address and how to stop, runs with it', () => {
    expect(startLine(start, {})).toEqual([
      '',
      '  Nolzu 1.0.0 · runs on this machine only',
      '',
      '  ✓ agent tools   claude 2.1.296 · codex 0.145.0',
      '  ✓ your data     ~/.nolzu (no account needed)',
      '',
      '  Opening http://localhost:4319',
      '  Ctrl+C stops Nolzu. A running agent stops with it.',
    ]);
  });

  it('says where Nolzu is instead of "Opening" when no browser opens', () => {
    expect(startLine({ ...start, opening: false }, {})).toContain('  Nolzu is at http://localhost:4319');
  });

  it('says no agent tool was found, and where to get one', () => {
    const none = start.tools.map((tool) => ({ ...tool, found: false, version: null }));

    expect(startLine({ ...start, tools: none }, {})[3]).toBe('  ✗ agent tools   none found yet. The app shows how to install one.');
  });

  it('names a tool that is there but printed no version', () => {
    expect(startLine({ ...start, tools: [{ binary: 'cursor-agent', found: true, version: null, error: null }] }, {})[3]).toBe('  ✓ agent tools   cursor-agent');
  });

  // The app calls such a tool "check failed", and a check mark next to it would read as working.
  it('puts a tool whose version check failed on its own line, not among the working ones', () => {
    const tools = [start.tools[0]!, start.tools[2]!, { binary: 'cursor-agent', found: true, version: null, error: 'not logged in' }];

    expect(startLine({ ...start, tools }, {}).slice(3, 5)).toEqual(['  ✓ agent tools   claude 2.1.296 · codex 0.145.0', '  ✗ check failed  cursor-agent. The app shows the error.']);
  });

  // The tool is there, so "none found" would send the person to install what they have.
  it('says only that the check failed when no tool works', () => {
    const tools = [{ binary: 'cursor-agent', found: true, version: null, error: 'cursor-agent --version did not answer in 5 seconds.' }];
    const lines = startLine({ ...start, tools }, {});

    expect(lines[3]).toBe('  ✗ check failed  cursor-agent. The app shows the error.');
    expect(lines.join('\n')).not.toContain('none found');
  });

  it('prints a data folder outside the home folder whole', () => {
    expect(startLine({ ...start, dataDir: '/srv/nolzu' }, {})[4]).toBe('  ✓ your data     /srv/nolzu (no account needed)');
  });

  // The built client cannot run the fake engine: the scenario folder is in no build. It used to
  // announce fake mode as if it worked, which left a person with cards that failed and no reason.
  it('says fake mode does not work here, and where it does', () => {
    // The data folder is named ".nolzu-fake" in this mode, so the line is checked by its own words.
    const lines = startLine({ ...start, dataDir: '/home/you/.nolzu-fake' }, { NOLZU_FAKE_AGENT: '1' });

    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toContain('this client cannot run it');
    // The consequence, which is the clause that stops a person hunting the path in the error.
    expect(lines.at(-1)).toContain('every card would fail');
    expect(lines.at(-1)).toContain('Run the dev server to rehearse.');
  });
});

describe('alreadyRunning', () => {
  it('names the address it opens', () => {
    expect(alreadyRunning('http://localhost:4319', true, '1.0.0', '1.0.0')).toEqual(['', '  Nolzu is already running at http://localhost:4319. Opening it.']);
  });

  it('opens nothing on --no-open, and says only where it runs', () => {
    expect(alreadyRunning('http://localhost:4319', false, '1.0.0', '1.0.0')).toEqual(['', '  Nolzu is already running at http://localhost:4319.']);
  });

  // After an update the old server still runs, and it is the one that opens.
  it('names a running version that is not this one, and how to start this one', () => {
    expect(alreadyRunning('http://localhost:4319', true, '1.0.0', '1.1.0').at(-1)).toBe('  The running Nolzu is 1.0.0. Stop it and start Nolzu again to start 1.1.0.');
  });
});

describe('the record of the running server', () => {
  const folder = () => mkdtempSync(join(tmpdir(), 'nolzu-record-'));

  it('reads back what it wrote, and leaves no partial file', () => {
    const dir = folder();
    writeRecord(dir, { pid: 42, port: 4319, version: '1.0.0' });

    expect(readRecord(dir)).toEqual({ pid: 42, port: 4319, version: '1.0.0' });
    expect(readdirSync(dir)).toEqual([RECORD]);
    rmSync(dir, { recursive: true, force: true });
  });

  // A second start can read the record while a new start replaces it. It must get the old record or
  // the new one, never half of either.
  it('replaces the record in one step, so a reader with the old one open still reads it whole', () => {
    const dir = folder();
    writeRecord(dir, { pid: 42, port: 4319, version: '1.0.0' });
    const reader = openSync(join(dir, RECORD), 'r');
    writeRecord(dir, { pid: 43, port: 4320, version: '1.0.0' });

    expect(JSON.parse(readFileSync(reader, 'utf8'))).toEqual({ pid: 42, port: 4319, version: '1.0.0' });
    expect(readRecord(dir)).toEqual({ pid: 43, port: 4320, version: '1.0.0' });
    closeSync(reader);
    rmSync(dir, { recursive: true, force: true });
  });

  // A crash can leave anything, or nothing. Neither is a reason to refuse a start.
  it.each(['', '{', 'null', '{"pid":"42","port":4319,"version":"1.0.0"}', '{"pid":42,"version":"1.0.0"}', '{"pid":42,"port":4319}'])('reads %j as no record', (text) => {
    const dir = folder();
    writeFileSync(join(dir, RECORD), text);

    expect(readRecord(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing file as no record', () => {
    expect(readRecord(join(tmpdir(), 'nolzu-no-such-folder'))).toBeNull();
  });
});

describe('runningAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-running-'));
  writeRecord(dir, { pid: 42, port: 4319, version: '1.0.0' });
  const answer = (body: unknown, ok = true) => () => Promise.resolve({ ok, json: () => Promise.resolve(body) });

  it('answers the address of a server that serves this data folder', async () => {
    await expect(runningAt(dir, { alive: () => true, ask: answer({ dataDir: dir }) })).resolves.toEqual({ url: 'http://localhost:4319', version: '1.0.0' });
  });

  // A dead process cannot be serving anything, so its port is not even asked.
  it('ignores a record whose process is gone, without asking its port', async () => {
    let asked = false;
    const ask = () => {
      asked = true;
      return answer({ dataDir: dir })();
    };

    await expect(runningAt(dir, { alive: () => false, ask })).resolves.toBeNull();
    expect(asked).toBe(false);
  });

  // The process id can belong to another program by now, and the port to another server.
  it('ignores a port that answers for another data folder', async () => {
    await expect(runningAt(dir, { alive: () => true, ask: answer({ dataDir: '/home/you/other' }) })).resolves.toBeNull();
  });

  it.each([
    ['refuses the connection', () => Promise.reject(new Error('fetch failed'))],
    ['answers 404', answer({ dataDir: dir }, false)],
    ['answers something that is not Nolzu', answer('<html>')],
  ])('ignores a port that %s', async (_, ask) => {
    await expect(runningAt(dir, { alive: () => true, ask })).resolves.toBeNull();
  });

  it('answers null with no record', async () => {
    await expect(runningAt(join(tmpdir(), 'nolzu-no-such-folder'), { alive: () => true, ask: answer({}) })).resolves.toBeNull();
  });
});

describe('parseCommand', () => {
  // The habit of years: typing `nolzu` starts Nolzu. A subcommand may not take that away.
  it('starts the server, and opens a browser, when there is no command', () => {
    expect(parseCommand([])).toEqual({ kind: 'serve', open: true });
  });

  it('starts the server without a browser on --no-open', () => {
    expect(parseCommand(['--no-open'])).toEqual({ kind: 'serve', open: false });
  });

  it.each(SUBCOMMANDS)('reads %s as its own command', (name) => {
    expect(parseCommand([name])).toEqual({ kind: name });
  });

  it.each(['--version', '-v'])('reads %s as the version, whatever follows it', (flag) => {
    expect(parseCommand([flag])).toEqual({ kind: 'version' });
    expect(parseCommand([flag, 'login'])).toEqual({ kind: 'version' });
  });

  it('refuses a command it does not know, and names it', () => {
    expect(parseCommand(['frobnicate'])).toEqual({ kind: 'usage', problem: 'nolzu frobnicate is not a command.' });
  });

  // A typo after a real command is the case where doing the command anyway is the wrong answer.
  it('refuses an argument after a command while the cloud is open, and names the argument', () => {
    expect(parseCommand(['login', 'nolzu.com'], true)).toEqual({ kind: 'usage', problem: 'nolzu login takes no argument, and got nolzu.com.' });
  });

  // Closed, an account command answers one sentence whatever follows it, so a stray word is no usage error.
  it.each(SUBCOMMANDS)('takes %s with any argument while the cloud is closed', (name) => {
    expect(parseCommand([name, 'nolzu.com'], false)).toEqual({ kind: name });
  });

  it('refuses a flag it does not know rather than starting the server', () => {
    expect(parseCommand(['--serve'])).toMatchObject({ kind: 'usage' });
  });

  // Asking for help is not a mistake, so it is not the usage answer that fails.
  it.each(['--help', '-h'])('reads %s as a request for the list of commands', (flag) => {
    expect(parseCommand([flag])).toEqual({ kind: 'help' });
  });

  it('prints the list for --help with a word after it, rather than calling --help not a command', () => {
    expect(parseCommand(['--help', 'login'])).toEqual({ kind: 'help' });
  });
});

describe('startRefusal', () => {
  // Another program took the port between the pick and the bind.
  it('turns a port taken at bind time into the busy sentence', () => {
    const taken = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4319'), { code: 'EADDRINUSE' });

    expect(startRefusal(taken, 4319)).toBe(portBusyNote(4319));
  });

  it.each([
    'Nolzu is already running on /data/one as process 42. Close that window, or stop that process, before starting another one.',
    '/data/one/nolzu.db has schema version 40, and this Nolzu knows versions up to 39. Update Nolzu to open it.',
  ])('prints a refusal written for a person as its sentence alone: %s', (message) => {
    expect(startRefusal(new Error(message), 4319)).toBe(message);
  });

  it('keeps any other failure whole, so a bug still prints its stack', () => {
    const bug = new TypeError('server.listen is not a function');

    expect(startRefusal(bug, 4319)).toBe(bug);
  });
});

describe('lockHeld', () => {
  it('reads the writer lock refusal, and nothing else', () => {
    expect(lockHeld(new Error('Nolzu is already running on /data/one as process 42. Close that window, or stop that process, before starting another one.'))).toBe(true);
    expect(lockHeld(new Error('/data/one/nolzu.db has schema version 40, and this Nolzu knows versions up to 39. Update Nolzu to open it.'))).toBe(false);
    expect(lockHeld('Nolzu is already running on /data/one')).toBe(false);
  });
});

// The README tells a person to build with corepack, so the sentence a missing build prints says the same.
it('names corepack in the not-built sentence, which the README quotes word for word', () => {
  expect(NOT_BUILT).toContain('Run corepack pnpm build first.');
  expect(readFileSync(fileURLToPath(new URL('../../../../README.md', import.meta.url)), 'utf8')).toContain(`\`${NOT_BUILT}\``);
});

// The launcher is plain JavaScript that no type check reads, and no test can take its build away, so the
// wire from it to the sentence is read off the file.
it('prints the not-built sentence from the launcher', () => {
  expect(readFileSync(fileURLToPath(new URL('../../bin/start.js', import.meta.url)), 'utf8')).toContain('stop(NOT_BUILT)');
});

describe('versionOutput', () => {
  const git = (answers: Record<string, string | null>) => (args: string[]) => answers[args[0] ?? ''] ?? null;

  it('prints the line of the build, the way the rail shows it', () => {
    expect(versionOutput('9.9.9', git({}), { version: '0.4.1', commit: null, date: '2026-11-05' })).toBe('nolzu 0.4.1');
    expect(versionOutput('9.9.9', git({}), { version: '0.4.1', commit: 'abc1234', date: '2026-11-05' })).toBe('nolzu 0.4.1-dev · abc1234');
  });

  // A clone has no build in the command, so it asks git the way the build does.
  it('asks git in a clone: the plain version on a tag, the hash anywhere else, the version with no git', () => {
    expect(versionOutput('0.4.1', git({ describe: 'v0.4.1', 'rev-parse': 'abc1234' }), null)).toBe('nolzu 0.4.1');
    expect(versionOutput('0.4.1', git({ 'rev-parse': 'abc1234' }), null)).toBe('nolzu 0.4.1-dev · abc1234');
    expect(versionOutput('0.4.1', git({}), null)).toBe('nolzu 0.4.1');
  });
});

// Plain JavaScript in bin/, so an old Node reads it, and loaded by path, so the typecheck reads no types off it.
describe('the Node check', () => {
  const load = async () => {
    const path = '../../bin/node-check.js';
    return (await import(path)) as {
      nodeRefusal: (running: string, wanted?: string) => string | null;
      quietSqliteWarning: (target: { emitWarning: (...args: unknown[]) => void }) => void;
    };
  };

  it('passes the version asked for and every newer one', async () => {
    const { nodeRefusal } = await load();
    for (const running of ['v24.21.0', 'v24.21.1', 'v24.22.0', 'v25.0.0', 'v100.0.0']) expect(nodeRefusal(running, '>=24.21.0'), running).toBeNull();
  });

  it('refuses every older one, and refuses nothing on a range it cannot read', async () => {
    const { nodeRefusal } = await load();
    for (const running of ['v24.20.9', 'v24.9.99', 'v22.17.0', 'v18.19.1']) expect(nodeRefusal(running, '>=24.21.0'), running).toContain('Nolzu needs Node 24.21.0 or newer');
    expect(nodeRefusal('v18.0.0', undefined)).toBeNull();
    expect(nodeRefusal('v18.0.0', '*')).toBeNull();
  });

  // Node 23 had node:sqlite only from 23.4, so the range skips 23.0 to 23.3.
  it('reads a range of two, a caret on one major and a floor', async () => {
    const { nodeRefusal } = await load();
    const range = '^22.16.0 || >=23.4.0';
    for (const running of ['v22.16.0', 'v22.20.1', 'v23.4.0', 'v24.21.0', 'v25.1.0']) expect(nodeRefusal(running, range), running).toBeNull();
    for (const running of ['v22.15.9', 'v23.0.0', 'v23.3.9', 'v20.11.0']) expect(nodeRefusal(running, range), running).toContain('Nolzu needs Node 22.16.0 or a newer 22, or 23.4.0 or newer');
  });

  // Node 22 prints an experimental warning for node:sqlite on every start. Only that one goes.
  it('drops the node:sqlite experimental warning and passes every other one', async () => {
    const { quietSqliteWarning } = await load();
    const seen: unknown[][] = [];
    const target = { emitWarning: (...args: unknown[]) => void seen.push(args) };
    quietSqliteWarning(target);

    target.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    target.emitWarning('SQLite is an experimental feature and might change at any time', { type: 'ExperimentalWarning' });
    target.emitWarning('Something else is experimental', 'ExperimentalWarning');
    target.emitWarning('SQLite is an experimental feature and might change at any time', 'DeprecationWarning');
    const error = Object.assign(new Error('A real problem'), { name: 'Warning' });
    target.emitWarning(error);

    expect(seen).toEqual([['Something else is experimental', 'ExperimentalWarning'], ['SQLite is an experimental feature and might change at any time', 'DeprecationWarning'], [error]]);
  });

  // A user needs Node 22.16 or newer, and working on Nolzu still needs 24.21, which the
  // scripts' TypeScript needs. The user floor drops; the maintainer pin does not.
  it('asks a user for Node 22.16 and a maintainer for 24.21', () => {
    const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as { engines: { node: string }; devEngines?: { runtime: { version: string } } };
    const root = read('../../../../package.json');
    expect(read('../../package.json').engines.node).toBe('^22.16.0 || >=23.4.0');
    expect(root.engines.node).toBe('^22.16.0 || >=23.4.0');
    expect(root.devEngines?.runtime.version).toBe('>=24.21.0');
    expect(readFileSync(fileURLToPath(new URL('../../../../.nvmrc', import.meta.url)), 'utf8').trim()).toBe('24.21.0');
  });
});

describe('USAGE', () => {
  it('names --version', () => {
    expect(USAGE.join('\n')).toContain('npx nolzu@latest --version');
  });

  // The list is what an unknown command prints, so a command missing from it is a command nobody finds.
  it.each(SUBCOMMANDS)('names %s while the cloud is open', (name) => {
    expect(usage(true).join('\n')).toContain(`npx nolzu@latest ${name}`);
  });

  // While the cloud is closed a free user is not sent to a server that is not there.
  it.each(SUBCOMMANDS)('leaves %s out while the cloud is closed, as shipped', (name) => {
    expect(USAGE).toEqual(usage(false));
    expect(USAGE.join('\n')).not.toContain(`npx nolzu@latest ${name}`);
  });
});

// An unknown command and a login that cannot reach the server need no build, so they run on any checkout.
describe('the nolzu command without a build', () => {
  const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
  const run = (args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; printed: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let printed = '';
      child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      child.on('exit', (code) => resolve({ code, printed }));
    });

  it('prints the list of commands on --help and succeeds', async () => {
    const { code, printed } = await run(['--help']);

    expect(code).toBe(0);
    expect(printed).toContain('Usage: npx nolzu@latest');
  }, 20_000);

  it('prints the version of this clone on --version and succeeds', async () => {
    const { code, printed } = await run(['--version']);
    const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };

    expect(code).toBe(0);
    // The last line, because Linux prints its warning first.
    expect(printed.trim().split('\n').at(-1)).toMatch(new RegExp(`^nolzu ${version.replaceAll('.', '\\.')}(-dev · [0-9a-f]+)?$`));
  }, 20_000);

  it('prints the list of commands and fails on a command it does not know', async () => {
    const { code, printed } = await run(['frobnicate']);

    expect(code).toBe(1);
    expect(printed).toContain('nolzu frobnicate is not a command.');
    expect(printed).toContain('npx nolzu@latest --version');
  }, 20_000);

  // The account commands talk to the hosted server, so a server that cannot be reached is the whole of
  // the failure case the bin owns: it names the address instead of printing "fetch failed". Port 1 is
  // the address, because no Nolzu of any kind can be listening there.
  it.skipIf(!CLOUD_OPEN)('names the server it could not reach', async () => {
    const { code, printed } = await run(['login'], { NOLZU_CLOUD_URL: 'http://127.0.0.1:1' });

    expect(code).toBe(1);
    expect(printed).toContain('Nolzu could not reach http://127.0.0.1:1');
  }, 20_000);

  // While the cloud is closed each account command prints one sentence and calls nothing. A server
  // that cannot be reached would say so, so its silence is the proof no call went out.
  it.skipIf(CLOUD_OPEN).each(SUBCOMMANDS)('answers %s with one sentence and no call while the cloud is closed', async (name) => {
    const { code, printed } = await run([name, 'extra'], { NOLZU_CLOUD_URL: 'http://127.0.0.1:1' });

    expect(code).toBe(0);
    expect(printed.trim().split('\n').at(-1)).toBe(NO_ACCOUNT);
    expect(printed).not.toContain('could not reach');
  }, 20_000);

  // An older Node fails on the node:sqlite import with a stack trace that names no version, so the
  // entry checks `engines` first. The version is faked, so this runs on the Node the suite runs on.
  it.each(['v20.11.0', 'v22.15.0'])('stops on Node %s with one sentence that names the version needed', async (version) => {
    const asOld = `data:text/javascript,Object.defineProperty(process,"version",{value:"${version}"})`;
    const { code, printed } = await new Promise<{ code: number | null; printed: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', asOld, bin, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let said = '';
      child.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
      child.on('exit', (exit) => resolve({ code: exit, printed: said }));
    });
    expect(code).toBe(1);
    expect(printed.trim()).toBe(
      `Nolzu needs Node 22.16.0 or a newer 22, or 23.4.0 or newer, and this is Node ${version.slice(1)}. Install a newer Node from https://nodejs.org or with your version manager (for example nvm install 24), then start Nolzu again.`,
    );
  }, 20_000);

  // The check sits before help and the account commands, because those reach the keychain.
  it('stops on native Windows before any command runs', async () => {
    const asWindows = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})';
    const { code, printed } = await new Promise<{ code: number | null; printed: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', asWindows, bin, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let said = '';
      child.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
      child.on('exit', (exit) => resolve({ code: exit, printed: said }));
    });

    expect(code).toBe(1);
    expect(printed).toContain('Nolzu runs on macOS. Native Windows is not supported.');
    expect(printed).not.toContain('Usage: npx nolzu@latest');
  }, 20_000);

  it('starts on Linux with the not-tested line', async () => {
    const asLinux = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"linux"})';
    const { code, printed } = await new Promise<{ code: number | null; printed: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', asLinux, bin, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let said = '';
      child.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
      child.on('exit', (exit) => resolve({ code: exit, printed: said }));
    });

    expect(code).toBe(0);
    expect(printed).toContain('Linux, WSL2 included, is not tested yet.');
    expect(printed).toContain('Usage: npx nolzu@latest');
  }, 20_000);
});

// The whole command, once, against the built server. It is skipped when the build is not there, because
// the gate builds after it runs.
const built = new URL('../../build/index.js', import.meta.url);
const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

// The browser is opened by name through PATH, so a stand-in under that name records the call and
// opens nothing. Without it no test can tell an opened browser from a skipped one.
const fakeBrowser = (marker: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-browser-'));
  // Written aside and renamed, so a test that sees the marker never reads it empty.
  const aside = JSON.stringify(`${marker}.part`);
  for (const name of ['open', 'xdg-open']) writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s' "$1" > ${aside} && mv ${aside} ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH}`, DISPLAY: ':0' };
};

describe.skipIf(!existsSync(built))('the nolzu command', () => {
  const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
  // The fake engine keeps its data here, whatever NOLZU_DATA_DIR says.
  const data = (home: string) => join(home, '.nolzu-fake');

  const launch = (args: string[], env: Record<string, string>, cwd?: string) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, NOLZU_FAKE_AGENT: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { text: '' };
    child.stdout.on('data', (chunk: Buffer) => (out.text += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out.text += chunk.toString()));
    return { child, out };
  };

  const answers = async (port: number) => {
    let status = 0;
    for (let tries = 0; tries < 100 && status !== 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await fetch(`http://localhost:${port}/onboard`).then((answer) => answer.status).catch(() => 0);
    }
    return status;
  };

  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<number | null>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(child.exitCode) : child.once('exit', resolve)));

  // The browser is opened through a shell that lands a moment after the command.
  const openedAt = async (marker: string) => {
    for (let tries = 0; tries < 100 && !existsSync(marker); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return existsSync(marker) ? readFileSync(marker, 'utf8') : '';
  };

  // The lines print after the agent tools answer, so they can trail the first answer.
  const printedSoon = async (started: ReturnType<typeof launch>, text: string) => {
    for (let tries = 0; tries < 100 && !started.out.text.includes(text); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return started.out.text;
  };

  it('starts the app, prints where it is, and answers on that address', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
    const child = spawn(process.execPath, [bin, '--no-open'], { env: { ...process.env, ...fakeBrowser(opened), HOME: home, NOLZU_FAKE_AGENT: '1', NOLZU_PORT: '5321' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let printed = '';
    child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));

    try {
      let status = 0;
      for (let tries = 0; tries < 100 && status !== 200; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await fetch('http://localhost:5321/onboard').then((answer) => answer.status).catch(() => 0);
      }

      expect(status).toBe(200);
      // The lines print after the agent tools answer, and each may take up to five seconds.
      for (let tries = 0; tries < 100 && !printed.includes('this client cannot run it'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(printed).toContain('Nolzu is at http://localhost:5321');
      expect(printed).toContain(`  Nolzu ${version} · runs on this machine only`);
      expect(printed).toContain('agent tools');
      // adapter-node's own line, on the spelling the server sends away, is not what a person reads first.
      expect(printed).not.toContain('Listening on');
      // The data folder as a first start prints it, under the home this test gave the command.
      expect(printed).toContain('✓ your data     ~/.nolzu-fake (no account needed)');
      // The built client cannot run the fake engine, and this is the spawn that proves the line
      // reaches a person rather than only the function that writes it.
      expect(printed).toContain('this client cannot run it');

      // The other spelling of the same machine, which adapter-node would print when it starts.
      const other = await fetch('http://127.0.0.1:5321/onboard', { redirect: 'manual' });

      expect(other.status).toBe(307);
      expect(other.headers.get('location')).toBe('http://localhost:5321/onboard');
      // The browser is opened the moment the server binds, before it answers anything, so the address
      // answering proves the step was passed. The wait is for the shell behind it, which lands a few
      // hundred milliseconds later.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(existsSync(opened)).toBe(false);
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // Typing `nolzu` is meant to land the person in the app, so the one step that does that is checked.
  it('opens the browser at the address it printed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
    const child = spawn(process.execPath, [bin], { env: { ...process.env, ...fakeBrowser(opened), HOME: home, NOLZU_FAKE_AGENT: '1', NOLZU_PORT: '5324' }, stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      let asked = '';
      for (let tries = 0; tries < 100 && asked === ''; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        asked = existsSync(opened) ? readFileSync(opened, 'utf8') : '';
      }

      expect(asked).toBe('http://localhost:5324');
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);

  // A Linux box with no xdg-open is the real case: opening the browser fails, the app must not.
  it('keeps running when the browser tool is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
    const child = spawn(process.execPath, [bin], { env: { ...process.env, HOME: home, PATH: '', NOLZU_FAKE_AGENT: '1', NOLZU_PORT: '5322' }, stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      let status = 0;
      for (let tries = 0; tries < 100 && status !== 200; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await fetch('http://localhost:5322/onboard').then((answer) => answer.status).catch(() => 0);
      }

      expect(status).toBe(200);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);

  // fetch will not send a Host of our choosing, so the request is written with node:http.
  const askAs = (port: number, path: string, method: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const sent = request({ host: '127.0.0.1', port, path, method, headers: { host, accept: 'text/html' } }, (answer) => {
        let body = '';
        answer.on('data', (chunk: Buffer) => (body += chunk.toString()));
        answer.on('end', () => resolve({ status: answer.statusCode ?? 0, body }));
      });
      sent.on('error', reject);
      sent.end();
    });

  // The built app, because there the URL comes from ORIGIN and not from the Host header, so the
  // port check is a real one here and a no-op on the dev server.
  it('answers only its own names on its own port, for a read, a write and the board stream', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
    const child = spawn(process.execPath, [bin, '--no-open'], { env: { ...process.env, HOME: home, NOLZU_FAKE_AGENT: '1', NOLZU_PORT: '5325' }, stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      let status = 0;
      for (let tries = 0; tries < 100 && status !== 200; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The terms page, which a fresh data folder answers with 200 where every other page leads to it.
        status = await askAs(5325, '/accept', 'GET', 'localhost:5325').then((answer) => answer.status).catch(() => 0);
      }

      expect(status).toBe(200);
      for (const [path, method] of [['/onboard', 'GET'], ['/api/board', 'GET'], ['/api/board/pulls', 'POST']] as const) {
        const refused = await askAs(5325, path, method, 'evil.example:5325');

        expect(refused.status, `${method} ${path}`).toBe(403);
        expect(refused.body).toContain('Nolzu answers only at localhost on its own port.');
      }
      // The right name on a port the server is not on, which is what a forward to another port sends.
      expect((await askAs(5325, '/onboard', 'GET', 'localhost:4319')).status).toBe(403);
      expect((await askAs(5325, '/onboard', 'GET', '127.0.0.1:5325')).status).toBe(307);
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);

  it('says which port is busy instead of dumping a stack, and starts nothing', async () => {
    const close = await busy(5323);
    const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
    const child = spawn(process.execPath, [bin, '--no-open'], { env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'nolzu-bin-')), NOLZU_PORT: '5323' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let printed = '';
    child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));

    try {
      const code = await new Promise((resolve) => child.on('exit', resolve));

      expect(code).toBe(1);
      expect(printed.trim()).toBe(portBusyNote(5323));
    } finally {
      close();
    }
  }, 20_000);

  // One Nolzu per data folder. A second start, from another folder and with another port asked for,
  // opens the one that runs and leaves. It used to start nothing and fail with a sentence.
  it('opens the running copy from a second start and exits 0, with no second server', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const first = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5326' });

    try {
      expect(await answers(5326)).toBe(200);

      const second = launch([], { ...fakeBrowser(opened), HOME: home, NOLZU_PORT: '5327' }, tmpdir());

      expect(await exited(second.child)).toBe(0);
      expect(second.out.text.trim()).toBe('Nolzu is already running at http://localhost:5326. Opening it.');
      expect(await openedAt(opened)).toBe('http://localhost:5326');
      expect(await fetch('http://localhost:5327/onboard').then(() => true).catch(() => false)).toBe(false);
      expect(first.child.exitCode).toBeNull();

      // The login item starts it this way, so a browser opening here would open one at every login.
      const quiet = join(home, 'opened-quietly');
      const third = launch(['--no-open'], { ...fakeBrowser(quiet), HOME: home, NOLZU_PORT: '5327' }, tmpdir());

      expect(await exited(third.child)).toBe(0);
      expect(third.out.text.trim()).toBe('Nolzu is already running at http://localhost:5326.');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(existsSync(quiet)).toBe(false);
    } finally {
      first.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // A person who sets NOLZU_PORT asks for the same port at every start, so a second start asks for the
  // port the first one holds. It must open the first, not stop on a busy port. After an update the
  // running copy is the older one, and the second start says how to start the new one.
  it('opens the running copy when asked for the port it holds, and names an older running version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const first = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5354' });

    try {
      expect(await answers(5354)).toBe(200);
      // The record as an older Nolzu on this port would have written it.
      const record = readRecord(data(home));
      expect(record).not.toBeNull();
      writeRecord(data(home), { ...record!, version: '0.0.1' });

      const second = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5354' }, tmpdir());

      expect(await exited(second.child)).toBe(0);
      expect(second.out.text.trim()).toBe(`Nolzu is already running at http://localhost:5354.\n  The running Nolzu is 0.0.1. Stop it and start Nolzu again to start ${version}.`);
      expect(first.child.exitCode).toBeNull();
    } finally {
      first.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // A module loaded ahead of the launcher that fails its first health asks, as a Nolzu that is still
  // booting or too slow to answer does. Only the asks fail: the copy that runs is untouched.
  const failingHealth = (home: string, count: number) => {
    const module = join(home, 'fail-health.mjs');
    writeFileSync(module, ['const ask = globalThis.fetch;', `let left = ${count};`, "globalThis.fetch = (...args) => (left-- > 0 ? Promise.reject(new TypeError('fetch failed')) : ask(...args));"].join('\n'));
    return { NODE_OPTIONS: `--import ${pathToFileURL(module).href}` };
  };

  // The writer lock is the last guard: a Nolzu that holds the data folder and never answers, or one from
  // before the record, stops the new start with its one sentence.
  it('refuses a second copy that gets past the record, with no address, no browser and the record left alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const first = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5350' });

    try {
      expect(await answers(5350)).toBe(200);
      const second = launch([], { ...fakeBrowser(opened), ...failingHealth(home, Infinity), HOME: home, NOLZU_PORT: '5351' }, tmpdir());

      expect(await exited(second.child)).toBe(1);
      // Not the whole output: a NO_COLOR left in the shell next to the runner's FORCE_COLOR adds a warning.
      expect(second.out.text).toMatch(/^Nolzu is already running on .+ as process \d+\. Close that window, or stop that process, before starting another one\.$/m);
      for (const text of ['Opening', 'Nolzu is at', 'http://localhost:5351', 'agent tools']) expect(second.out.text).not.toContain(text);
      expect(second.out.text).not.toMatch(/^\s+at /m);
      expect(await fetch('http://localhost:5351/onboard').then(() => true).catch(() => false)).toBe(false);
      expect(readRecord(data(home))).toEqual({ pid: first.child.pid, port: 5350, version });
      expect(first.child.exitCode).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(existsSync(opened)).toBe(false);
    } finally {
      first.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // The login item and a typed nolzu start together. The later one finds no answer, loses the writer
  // lock to the earlier one, and opens it once it answers rather than refusing.
  it('opens a copy that was still booting when the start looked for it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const first = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5352' });

    try {
      expect(await answers(5352)).toBe(200);
      const second = launch([], { ...fakeBrowser(opened), ...failingHealth(home, 1), HOME: home, NOLZU_PORT: '5353' }, tmpdir());

      expect(await exited(second.child)).toBe(0);
      expect(second.out.text).toContain('  Nolzu is already running at http://localhost:5352. Opening it.');
      expect(await openedAt(opened)).toBe('http://localhost:5352');
      expect(readRecord(data(home))).toEqual({ pid: first.child.pid, port: 5352, version });
    } finally {
      first.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // Only the writer lock means another Nolzu may still be booting. Any other refusal, such as a database
  // from a newer Nolzu, prints at once and never waits for a running copy to answer.
  it('refuses a database from a newer Nolzu at once, without waiting for a running copy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    mkdirSync(data(home), { recursive: true });
    const db = new DatabaseSync(join(data(home), 'nolzu.db'));
    db.exec('PRAGMA user_version = 9999');
    db.close();
    // A live process id and a port where nothing listens, so every look for a running copy asks that port.
    writeRecord(data(home), { pid: process.pid, port: 5355, version });
    const asks = join(home, 'asks');
    const counter = join(home, 'count-asks.mjs');
    writeFileSync(
      counter,
      [
        "import { appendFileSync } from 'node:fs';",
        'const ask = globalThis.fetch;',
        `globalThis.fetch = (url, ...rest) => (String(url).endsWith('/api/health') && appendFileSync(${JSON.stringify(asks)}, String(url) + '\\n'), ask(url, ...rest));`,
      ].join('\n'),
    );
    const started = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5356', NODE_OPTIONS: `--import ${pathToFileURL(counter).href}` });

    try {
      expect(await exited(started.child)).toBe(1);
      expect(started.out.text).toMatch(/has schema version 9999, and this Nolzu knows versions up to \d+\. Update Nolzu to open it\.$/m);
      // The one look before the start. Waiting for a booting copy would ask again every 300 ms.
      expect(readFileSync(asks, 'utf8')).toBe('http://localhost:5355/api/health\n');
    } finally {
      started.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // A crash leaves the record behind with a process id that is gone. That is no reason to refuse.
  it('starts over a record left by a crash, and replaces it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const first = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5320' });
    let second: ReturnType<typeof launch> | undefined;

    try {
      expect(await answers(5320)).toBe(200);
      expect(readRecord(data(home))).toEqual({ pid: first.child.pid, port: 5320, version });

      first.child.kill('SIGKILL');
      await exited(first.child);
      expect(existsSync(join(data(home), RECORD))).toBe(true);

      second = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5329' });

      expect(await answers(5329)).toBe(200);
      expect(readRecord(data(home))).toEqual({ pid: second.child.pid, port: 5329, version });
      expect(await printedSoon(second, 'Nolzu is at')).toContain('Nolzu is at http://localhost:5329');
    } finally {
      first.child.kill();
      second?.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // The recorded process id is alive, but it is another program by now, on a port that is not Nolzu.
  it('starts its own server when the recorded port answers but is not Nolzu', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const stranger = createHttpServer((_, answer) => answer.writeHead(404).end()).listen(5348, '127.0.0.1');
    mkdirSync(data(home), { recursive: true });
    writeRecord(data(home), { pid: process.pid, port: 5348, version: '0.0.1' });
    const own = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5349' });

    try {
      expect(await answers(5349)).toBe(200);
      expect(readRecord(data(home))).toEqual({ pid: own.child.pid, port: 5349, version });
    } finally {
      own.child.kill();
      stranger.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // Two data folders, two servers. A record that names the other folder's server, as a reused process
  // id and a reused port can, must not send this folder's start there.
  it('never opens a server for another data folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const other = launch(['--no-open'], { HOME: elsewhere, NOLZU_PORT: '5345' });
    let own: ReturnType<typeof launch> | undefined;

    try {
      expect(await answers(5345)).toBe(200);
      mkdirSync(data(home), { recursive: true });
      writeRecord(data(home), { pid: other.child.pid!, port: 5345, version });

      own = launch([], { ...fakeBrowser(opened), HOME: home, NOLZU_PORT: '5346' });

      expect(await answers(5346)).toBe(200);
      expect(await openedAt(opened)).toBe('http://localhost:5346');
      expect(own.out.text).not.toContain('already running');
      expect(other.child.exitCode).toBeNull();
    } finally {
      other.child.kill();
      own?.child.kill();
      for (const folder of [elsewhere, home]) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // A second start trusts the record, so the record must never name a port before the server is on it.
  // A module loaded ahead of the launcher looks for it when the app's server calls listen and again
  // when it is listening.
  it('writes the record only once the server listens', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const record = join(data(home), RECORD);
    const seen = join(home, 'seen');
    const spy = join(home, 'look-for-the-record.mjs');
    writeFileSync(
      spy,
      [
        "import { appendFileSync, existsSync } from 'node:fs';",
        "import http from 'node:http';",
        `const look = (when) => appendFileSync(${JSON.stringify(seen)}, when + ': ' + (existsSync(${JSON.stringify(record)}) ? 'there' : 'missing') + '\\n');`,
        'const listen = http.Server.prototype.listen;',
        'http.Server.prototype.listen = function (...args) {',
        "  look('listen');",
        "  this.once('listening', () => look('listening'));",
        '  return listen.apply(this, args);',
        '};',
      ].join('\n'),
    );
    const child = launch(['--no-open'], { HOME: home, NOLZU_PORT: '5347', NODE_OPTIONS: `--import ${pathToFileURL(spy).href}` });

    try {
      expect(await answers(5347)).toBe(200);
      expect(readFileSync(seen, 'utf8')).toBe('listen: missing\nlistening: missing\n');
      expect(readRecord(data(home))).toEqual({ pid: child.child.pid, port: 5347, version });
    } finally {
      child.child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  // Another program takes the port between the pick and the bind. The address and the browser wait for
  // the bind, so nobody is sent to a port the app never served. The race is forced by a module loaded
  // ahead of the launcher: it takes the port itself just before the app's own listen.
  it('prints the busy sentence with no address, no stack and no browser when the port is taken at the bind', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
    const opened = join(home, 'opened');
    const bin = fileURLToPath(new URL('../../bin/nolzu.js', import.meta.url));
    const thief = join(home, 'take-the-port.mjs');
    writeFileSync(
      thief,
      [
        "import http from 'node:http';",
        "import net from 'node:net';",
        // The app's server listens with an options object. The free-port check listens with a number on
        // a plain net server, and is left alone.
        'const listen = http.Server.prototype.listen;',
        'http.Server.prototype.listen = function (options, ...rest) {',
        "  if (typeof options !== 'object' || options === null) return listen.call(this, options, ...rest);",
        '  net.createServer().listen(Number(options.port), options.host, () => listen.call(this, options, ...rest));',
        '  return this;',
        '};',
      ].join('\n'),
    );
    const env = { ...process.env, ...fakeBrowser(opened), HOME: home, NOLZU_FAKE_AGENT: '1', NOLZU_PORT: '5328', NODE_OPTIONS: `--import ${pathToFileURL(thief).href}` };
    const child = spawn(process.execPath, [bin], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      let printed = '';
      child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      const code = await new Promise((resolve) => child.on('exit', resolve));

      expect(code).toBe(1);
      // Not the whole output: a NO_COLOR left in the shell next to the runner's FORCE_COLOR adds a warning.
      expect(printed).toContain(portBusyNote(5328));
      // The busy sentence names the port, never the address.
      for (const text of ['http://localhost:5328', 'Opening', 'agent tools']) expect(printed).not.toContain(text);
      expect(printed).not.toMatch(/^\s+at /m);
      // The same wait as above: the browser is opened through a shell that lands a moment later.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(existsSync(opened)).toBe(false);
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});

// A page on another site can fire a POST at the local server with no body, and SvelteKit's form check
// lets that through. The browser says where the request came from, and a write from elsewhere is refused.
// Another site's background GET, an image or a script pointed here, gets nothing. A person following a
// link to a page still lands on it.
describe('crossSiteFetch', () => {
  it.each([
    ['cross-site', 'no-cors', 'image', '/t/APP-1/overview/__data.json', true],
    ['cross-site', 'no-cors', 'script', '/api/tickets/read', true],
    ['cross-site', 'navigate', 'iframe', '/settings/project', true],
    ['cross-site', 'navigate', 'document', '/api/gh/name', true],
    ['same-site', 'cors', 'empty', '/api/board', true],
    ['cross-site', 'navigate', 'document', '/settings/project', false],
    ['same-origin', 'cors', 'empty', '/api/board', false],
    ['none', 'navigate', 'document', '/', false],
    [null, null, null, '/api/health', false],
    // A card's design screen in its sandboxed frame loads the files beside it.
    ['cross-site', 'no-cors', 'style', '/api/card/APP-1/files/design/tokens.css', false],
    ['cross-site', 'no-cors', 'image', '/api/card/APP-1/files/design/logo.png', false],
    ['cross-site', 'cors', 'font', '/api/card/APP-1/files/design/fonts/inter.woff2', false],
    ['cross-site', 'no-cors', 'script', '/api/card/APP-1/files/design/app.js', true],
    // A frame, an embed or a document loads a page that runs, and an audio or video no screen needs.
    ['cross-site', 'navigate', 'iframe', '/api/card/APP-1/files/design/screen.html', true],
    ['cross-site', 'navigate', 'frame', '/api/card/APP-1/files/design/screen.html', true],
    ['cross-site', 'no-cors', 'embed', '/api/card/APP-1/files/design/screen.svg', true],
    ['cross-site', 'no-cors', 'object', '/api/card/APP-1/files/design/screen.svg', true],
    ['cross-site', 'navigate', 'document', '/api/card/APP-1/files/design/screen.html', true],
    ['cross-site', 'no-cors', 'video', '/api/card/APP-1/files/design/clip.mp4', true],
    ['cross-site', 'cors', 'empty', '/api/card/APP-1/files/design/tokens.css', true],
    ['cross-site', 'no-cors', 'style', '/api/card/APP-1/file', true],
    ['cross-site', 'no-cors', 'style', '/api/card/APP-1/files/', true],
    ['cross-site', 'no-cors', 'style', '/_app/immutable/assets/app.css', true],
  ])('treats a GET from %s (%s, %s) to %s as another site\'s background fetch: %s', (site, mode, dest, path, refused) => {
    expect(crossSiteFetch('GET', site, mode, dest, path)).toBe(refused);
  });

  it('leaves writes to crossSiteWrite', () => {
    expect(crossSiteFetch('POST', 'cross-site', 'cors', 'empty', '/api/board')).toBe(false);
  });
});

// A GET passes the write guard, so a page that runs or writes something on load asks this first.
describe('crossSiteRead', () => {
  it.each([
    ['cross-site', true],
    ['same-site', true],
    ['same-origin', false],
    ['none', false],
    [null, false],
  ])('treats a GET from %s as another site\'s: %s', (site, refused) => {
    expect(crossSiteRead(site)).toBe(refused);
  });
});

describe('crossSiteWrite', () => {
  it.each([
    ['POST', 'cross-site', true],
    ['POST', 'same-site', true],
    ['DELETE', 'cross-site', true],
    ['POST', 'same-origin', false],
    ['POST', 'none', false],
    ['POST', null, false],
    ['GET', 'cross-site', false],
  ])('treats %s from %s as a cross-site write: %s', (method, site, refused) => {
    expect(crossSiteWrite(method, site)).toBe(refused);
  });

  // A browser too old for Sec-Fetch-Site still names the page that sent the write.
  it.each([
    ['http://localhost:5000', false],
    ['http://127.0.0.1:5000', false],
    ['http://[::1]:5000', false],
    ['http://localhost:6000', true],
    ['https://evil.example', true],
    ['http://localhost.evil.example:5000', true],
    ['null', true],
  ])('with no Sec-Fetch-Site, treats a POST from %s as a cross-site write: %s', (origin, refused) => {
    expect(crossSiteWrite('POST', null, origin, '5000')).toBe(refused);
  });
});

// DNS rebinding: a page on another site points its own name at 127.0.0.1, and its requests then
// reach the server as same-origin. The Host header still carries that name, so the server answers
// only the names it is reached by on this machine, and only on the port it serves.
describe('foreignHost', () => {
  const served = new URL('http://localhost:4319/api/board');

  it.each(['localhost:4319', '127.0.0.1:4319', '[::1]:4319'])('serves %s', (host) => {
    expect(foreignHost(host, served)).toBe(false);
  });

  it.each([
    'evil.example:4319',
    'evil.example',
    'app.localhost:4319',
    'localhost.:4319',
    'LOCALHOST:4319',
    'user@localhost:4319',
    '127.0.0.2:4319',
    '0.0.0.0:4319',
    // A rebinding name that starts with a local one.
    'localhost.evil.example:4319',
    '127.0.0.1.nip.io:4319',
    '',
    // No port is that high, so a URL built from it throws.
    'localhost:99999',
  ])('refuses %j', (host) => {
    expect(foreignHost(host, served)).toBe(true);
  });

  it('refuses a local name on another port', () => {
    expect(foreignHost('localhost:4320', served)).toBe(true);
    expect(foreignHost('localhost', served)).toBe(true);
  });

  // The dev server builds its URL from the Host header, and NOLZU_PORT can be any port, so the port
  // to match is the one the URL carries and not a fixed range.
  it('serves the port the URL carries, the default HTTP port included', () => {
    expect(foreignHost('localhost:5311', new URL('http://localhost:5311/'))).toBe(false);
    expect(foreignHost('localhost', new URL('http://localhost/'))).toBe(false);
    expect(foreignHost('localhost:80', new URL('http://localhost/'))).toBe(false);
  });

  // On the default port the Host carries no port, so only the whole name can give a lookalike away.
  it('refuses a name that starts with a local one on the default HTTP port', () => {
    expect(foreignHost('localhost.evil.example', new URL('http://localhost/'))).toBe(true);
    expect(foreignHost('127.0.0.1.nip.io', new URL('http://localhost/'))).toBe(true);
  });

  // A browser always sends Host. A request with none is a client on this machine that is not a
  // browser, the same reading crossSiteWrite makes of a missing Sec-Fetch-Site.
  it('serves a request with no Host header', () => {
    expect(foreignHost(null, served)).toBe(false);
  });
});

describe('shutdownDefault', () => {
  it('waits one second for open connections when nobody set a wait', () => {
    const env: Record<string, string | undefined> = {};
    shutdownDefault(env);
    expect(env.SHUTDOWN_TIMEOUT).toBe('1');
  });

  it('keeps a wait the person set', () => {
    const env: Record<string, string | undefined> = { SHUTDOWN_TIMEOUT: '20' };
    shutdownDefault(env);
    expect(env.SHUTDOWN_TIMEOUT).toBe('20');
  });

  // The launcher has no seam to run, so its source is read: the call must come before the server loads.
  it('is called by the launcher before it imports the server', () => {
    const source = readFileSync(fileURLToPath(new URL('../../bin/start.js', import.meta.url)), 'utf8');
    const call = source.indexOf('shutdownDefault(process.env);');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(source.indexOf('await import(server)'));
  });
});
