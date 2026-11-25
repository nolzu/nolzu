import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { processRunning } from '@nolzu/core/node';
import { CLOUD_OPEN } from '@nolzu/protocol';
import { type AppBuild, readBuild, versionLine } from './app-version.ts';
import { homePath } from './home-path.ts';

// The first port and the last one tried. A range, not a random port, so the address a person
// bookmarked keeps working.
export const PORT_RANGE = { first: 4319, last: 4328 };

// The commands that need a Nolzu account. They stand apart from starting the server, which needs
// nothing and stays the default: `nolzu` with no argument is what every install does today.
export const SUBCOMMANDS = ['login', 'logout', 'status'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export type Command = { kind: 'serve'; open: boolean } | { kind: Subcommand } | { kind: 'help' } | { kind: 'version' } | { kind: 'usage'; problem: string };

// What `login`, `logout` and `status` print while the cloud is closed, with no network call.
export const NO_ACCOUNT = 'Free needs no account. Accounts open later, with the Solo and Team plans.';

// The account commands are listed only while the cloud is open, so a free user is not sent to a
// server that is not there.
export const usage = (cloud: boolean): string[] => [
  'Usage: npx nolzu@latest [command]',
  '',
  '  npx nolzu@latest             start Nolzu and open it in a browser',
  ...(cloud
    ? [
        '  npx nolzu@latest login       connect this machine to a Nolzu account',
        '  npx nolzu@latest logout      disconnect this machine and forget its token',
        '  npx nolzu@latest status      print the account and the plan',
      ]
    : []),
  '  npx nolzu@latest --version   print the version',
  '  npx nolzu@latest --help      print this list',
  '',
  'Flag: --no-open starts Nolzu without opening a browser.',
];

export const USAGE = usage(CLOUD_OPEN);

const isSubcommand = (word: string): word is Subcommand => (SUBCOMMANDS as readonly string[]).includes(word);

// What the person asked the command to do. Parsing is split from doing it so the whole table of
// answers can be tested without spawning a process. While the cloud is closed an account command
// takes any argument, because it answers with one sentence whatever follows it.
export function parseCommand(argv: readonly string[], cloud: boolean = CLOUD_OPEN): Command {
  const words = argv.filter((arg) => arg !== '--no-open');
  if (words.length === 0) return { kind: 'serve', open: !argv.includes('--no-open') };
  const first = words[0] ?? '';
  const rest = words.slice(1);
  // Help wins over whatever follows it: a person who asks for the list wants the list.
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (!isSubcommand(first)) return { kind: 'usage', problem: `nolzu ${first} is not a command.` };
  if (rest.length > 0 && cloud) return { kind: 'usage', problem: `nolzu ${first} takes no argument, and got ${rest[0]}.` };
  return { kind: first };
}

// Set by vite.bin.config.ts in the packed command. A clone runs this file as it is, with no build.
declare const __NOLZU_BUILD__: AppBuild | undefined;

// What --version prints: the version the rail shows, so the two agree. The packed command has it from
// its build. A clone reads package.json and asks git, the way the build does.
export function versionOutput(version: string, git: (args: string[]) => string | null, build: AppBuild | null = typeof __NOLZU_BUILD__ === 'undefined' ? null : __NOLZU_BUILD__): string {
  return `nolzu ${versionLine(build ?? readBuild(version, git, '')).short}`;
}

const canListen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

// Why a port could not be used. The same sentence serves the port that was asked for and the one that
// was free a moment ago and is taken by the time the server binds.
export const portBusyNote = (port: number): string => `Port ${port} is busy. Free it, or set NOLZU_PORT to another port.`;

// adapter-node waits this many seconds (30 by default) for open connections before it exits, and an
// open page holds a live event stream that never finishes. Runs are stopped by the SIGINT handler in
// hooks.server.ts, not by this wait, so one second is enough. A value the person set wins.
export function shutdownDefault(env: Record<string, string | undefined>): void {
  env.SHUTDOWN_TIMEOUT ??= '1';
}

// Native Windows is not supported, so Nolzu stops before it opens a database or a port. WSL2 counts
// as Linux. WSL1 runs Linux programs on the Windows kernel, which bubblewrap and the keyring cannot use,
// and its kernel release says "Microsoft" where WSL2 says "microsoft-standard".
export function platformRefusal(platform: string, kernelRelease: string | null): string | null {
  const wsl2 = 'On Windows, WSL2 runs it as Linux, which is not tested yet. See https://nolzu.com/docs/quickstart';
  if (platform === 'win32') return `Nolzu runs on macOS. Native Windows is not supported. ${wsl2}`;
  if (platform === 'linux' && kernelRelease !== null && /Microsoft/.test(kernelRelease) && !/microsoft-standard|WSL2/i.test(kernelRelease)) {
    return `Nolzu runs on macOS. WSL1 is not supported. ${wsl2}`;
  }
  return null;
}

// Linux starts, but no real engine run has been checked there yet, so it says so on every start
// until one has.
export function platformWarning(platform: string): string | null {
  return platform === 'linux'
    ? 'Linux, WSL2 included, is not tested yet. The wall around engine runs and the keyring may not work as the docs say. macOS is the tested system.'
    : null;
}

// The README quotes this sentence word for word.
export const NOT_BUILT = 'Nolzu is not built yet. Run corepack pnpm build first.';

// The refusals the app writes for a person at start: a second copy on the same data folder, and a
// database from a newer Nolzu. Matched by their text, because they are plain Errors thrown deep in core.
const LOCK_HELD = /^Nolzu is already running on /;
const START_REFUSALS = [LOCK_HELD, /Update Nolzu to open it\.$/];

// The writer lock refused this start: another Nolzu holds the data folder.
export const lockHeld = (error: unknown): boolean => error instanceof Error && LOCK_HELD.test(error.message);

// What a failed start prints: a known refusal as its one sentence, and anything else whole, so a real
// bug still shows its stack.
export function startRefusal(error: unknown, port: number): unknown {
  if ((error as { code?: unknown } | null)?.code === 'EADDRINUSE') return portBusyNote(port);
  if (error instanceof Error && START_REFUSALS.some((refusal) => refusal.test(error.message))) return error.message;
  return error;
}

// The port to listen on: the one asked for, else the first free one of the range. The range is a
// parameter so a test never fights a Nolzu the person has open.
export async function freePort(env: Record<string, string | undefined>, range = PORT_RANGE): Promise<number> {
  const asked = env.NOLZU_PORT;
  if (asked !== undefined) {
    const port = Number(asked);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`NOLZU_PORT is ${asked}, which is not a port number from 1 to 65535.`);
    if (!(await canListen(port))) throw new Error(portBusyNote(port));
    return port;
  }
  for (let port = range.first; port <= range.last; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`Every port from ${range.first} to ${range.last} is busy. Free one, or set NOLZU_PORT to the port to use.`);
}

// How this system opens a browser, or nothing when it has none. Nolzu is meant to work over SSH too,
// where a missing browser is normal and not an error.
export function browserCommand(platform: string, env: Record<string, string | undefined>): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'linux') return env.DISPLAY === undefined && env.WAYLAND_DISPLAY === undefined ? null : { command: 'xdg-open', args: [] };
  return null;
}

// The server answers on 127.0.0.1 as well, but its cross-site rule only trusts one spelling, the
// localhost the bin prints. A page opened on the other spelling would load and then have every form
// refused, so it is sent to the spelling that works. Null means the address is already right.
// The address is read from the Host header, because the server builds its own URL from the spelling it
// was given and never sees the one the browser used.
export function localhostRedirect(host: string | null, url: URL): string | null {
  const name = host?.replace(/:\d+$/, '');
  // Only the loopback spellings. Any other name is refused by foreignHost before this runs.
  if (name !== '127.0.0.1' && name !== '[::1]') return null;
  const to = new URL(url);
  to.hostname = 'localhost';
  to.port = /:(\d+)$/.exec(host ?? '')?.[1] ?? to.port;
  return to.toString();
}

// A write that another site's page sent, refused by the browser's own Sec-Fetch-Site header. SvelteKit's
// cross-site check only covers form bodies, and a POST with no body (Read open pull requests) or a
// typeless one passes it. A browser too old for Sec-Fetch-Site still sends Origin on a cross-site
// write, so with no Sec-Fetch-Site an Origin that is not this server on this machine is refused too.
// Neither header is a client that is not a browser, such as the bin or a test.
export function crossSiteWrite(method: string, site: string | null, origin: string | null = null, port = ''): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (site !== null) return site !== 'same-origin' && site !== 'none';
  if (origin === null) return false;
  try {
    const from = new URL(origin);
    return !(from.protocol === 'http:' && LOCAL_HOST.test(from.host) && from.port === port);
  } catch {
    // `null`, from a sandboxed frame or a file, names no server.
    return true;
  }
}

// A GET another site's page sent in the background, such as an image, a script or a frame pointed at
// this server. Only a person following a link to one of the pages is let through, and that page's
// load changes nothing for another site (crossSiteRead). Endpoints answer none of it, because each
// one may run git, gh or a call to Jira. No header is a client that is not a browser.
export function crossSiteFetch(method: string, site: string | null, mode: string | null, dest: string | null, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (site === null || site === 'same-origin' || site === 'none') return false;
  // A card's design screen is shown in an empty sandbox, which has no origin of its own, so the
  // `tokens.css` beside it reads as another site's. A style, picture or font of a card file reads
  // that one file and runs nothing. Only a browser sets these `dest` values, never a page's fetch.
  if ((dest === 'style' || dest === 'image' || dest === 'font') && /^\/api\/card\/[^/]+\/files\/./.test(path)) return false;
  return !(mode === 'navigate' && dest === 'document' && !path.startsWith('/api/'));
}

// A read that another site's page sent, such as an image pointed at a page of this server. A GET passes
// the write guard, so a page that runs something or writes something on load asks this first. No
// header is a client that is not a browser, as in crossSiteWrite.
export function crossSiteRead(site: string | null): boolean {
  return site !== null && site !== 'same-origin' && site !== 'none';
}

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/;

// A request addressed to a name that is not this machine's own. Under DNS rebinding a page on
// another site reaches the server under that site's name, and the browser then calls every request
// same-origin, so only the Host header gives it away. The port is the one `url` carries: the served
// port in the built app, because ORIGIN sets it, and the Host port on the dev server, which builds
// its URL from that header. Exact spellings only, because a browser sends Host lower case and
// canonical. No header is a client that is not a browser, as in crossSiteWrite.
export function foreignHost(host: string | null, url: URL): boolean {
  if (host === null) return false;
  const local = LOCAL_HOST.exec(host);
  if (local === null) return true;
  // As numbers, so `localhost:80` and `localhost` are one port. Not through URL, which throws on a
  // port above 65535 and turns the 403 into a 500.
  return Number(local[1] ?? 80) !== Number(url.port || 80);
}

export interface StartFacts {
  url: string;
  dataDir: string;
  home: string;
  version: string;
  tools: readonly { binary: string; found: boolean; version: string | null; error: string | null }[];
  // Whether a browser is opened at the address, or the person opens it.
  opening: boolean;
}

// What a first start prints. The address is the localhost one the server trusts, not
// 127.0.0.1. The Ctrl+C line holds because the server hook stops
// every run on the signal (`Loop.shutdown`). No plan word: every plan line follows the signed
// display document (`ARCHITECTURE.md`), which only the server holds.
export function startLine(start: StartFacts, env: Record<string, string | undefined>): string[] {
  const found = start.tools.filter((tool) => tool.found && tool.error === null).map((tool) => (tool.version === null ? tool.binary : `${tool.binary} ${tool.version}`));
  // The app calls these "check failed", so the terminal does not mark them as working.
  const failed = start.tools.filter((tool) => tool.error !== null).map((tool) => tool.binary);
  const lines = [
    '',
    `  Nolzu ${start.version} · runs on this machine only`,
    '',
    ...(found.length > 0 ? [`  ✓ agent tools   ${found.join(' · ')}`] : failed.length === 0 ? ['  ✗ agent tools   none found yet. The app shows how to install one.'] : []),
    ...(failed.length > 0 ? [`  ✗ check failed  ${failed.join(' · ')}. The app shows the error.`] : []),
    `  ✓ your data     ${homePath(start.dataDir, start.home)} (no account needed)`,
    '',
    start.opening ? `  Opening ${start.url}` : `  Nolzu is at ${start.url}`,
    '  Ctrl+C stops Nolzu. A running agent stops with it.',
  ];
  // This client cannot replay the canned streams: the fake engine builds its scenario path from
  // `import.meta.url`, and the folder is not copied into the build, so the path lands beside the
  // bundled file and nothing is there. Saying nothing would leave a person with a data folder named
  // `.nolzu-fake`, every card dead on a path inside the build, and no clue why.
  if (env.NOLZU_FAKE_AGENT === '1') lines.push('  Fake mode is set, but this client cannot run it: every card would fail. Run the dev server to rehearse.');
  return lines;
}

// What a second start prints before it leaves. After an update the old version still runs and opens,
// so a running version that is not this one is named.
export const alreadyRunning = (url: string, opening: boolean, running: string, own: string): string[] => [
  '',
  `  Nolzu is already running at ${url}.${opening ? ' Opening it.' : ''}`,
  ...(running === own ? [] : [`  The running Nolzu is ${running}. Stop it and start Nolzu again to start ${own}.`]),
];

// Where a running Nolzu says which port it is on: in its data folder, next to the database, because
// one Nolzu runs per data folder and the writer lock is kept per data folder too.
export const RECORD = 'running.json';

export interface Running {
  pid: number;
  port: number;
  version: string;
}

// The record, or null for a missing file or anything a crash could leave half written.
export function readRecord(dataDir: string): Running | null {
  try {
    const record = JSON.parse(readFileSync(join(dataDir, RECORD), 'utf8')) as Partial<Running> | null;
    return Number.isInteger(record?.pid) && Number.isInteger(record?.port) && typeof record?.version === 'string' ? (record as Running) : null;
  } catch {
    return null;
  }
}

// Renamed into place, so a second start never reads half a file.
// Limit: the record stays after a stop. The next start reads a dead process id and replaces it.
export function writeRecord(dataDir: string, record: Running): void {
  const file = join(dataDir, RECORD);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(record));
  renameSync(partial, file);
}

export type HealthAsk = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

// The address and version of the Nolzu that serves this data folder, or null when none does. A record
// left by a crash names a dead process, or a port where something else answers now, and both are read
// as no Nolzu, never as a reason to refuse. A server for another data folder is never this one.
export async function runningAt(dataDir: string, { alive = processRunning, ask = fetch as HealthAsk } = {}): Promise<{ url: string; version: string } | null> {
  const record = readRecord(dataDir);
  if (record === null || !alive(record.pid)) return null;
  const url = `http://localhost:${record.port}`;
  const health = await ask(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then((answer) => (answer.ok ? answer.json() : null))
    .catch(() => null);
  return (health as { dataDir?: unknown } | null)?.dataDir === dataDir ? { url, version: record.version } : null;
}
