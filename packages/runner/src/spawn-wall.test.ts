import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PHASE_POLICIES } from '@nolzu/core';
import { ASK_PHASE, type Job } from '@nolzu/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { stubBinary, type StubBinary } from '../test/stub-binary.ts';
import { recordingWall, refusingWall } from '../test/wall-double.ts';
import { resolveDataDir } from '@nolzu/core/node';
import { codexModelList } from './codex-models.ts';
import { ENGINE_WALLS, systemHome } from './engine-walls.ts';
import { runLogNote } from './log.ts';
import { makeQaCopy, removeQaCopy } from './qa-copy.ts';
import { addedToState, POINTER_CHANGED, spawnClaude, spawnCodex, spawnCursor, type SpawnOptions, watchedChanged } from './spawn.ts';
import { wallHere } from './wall-detect.ts';

// The wall wired into the spawn of every engine: the spec each run hands the
// wall, the refusal that stops a run before any process starts, and, where this machine can start
// the wall, the stubs run inside the real one.

// The fixture sits under the repository's ignored `.vitest` folder, not the system temp folder,
// because the macOS wall leaves every process the temp folders.
const scratch = join(import.meta.dirname, '../../../.vitest');
mkdirSync(scratch, { recursive: true });

const CURSOR_MODELS = 'Available models\ngpt-5.3-codex - Codex 5.3\n';
const CODEX_MODELS = JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }] }] });

// One stub for all three engines. It answers the model lists, then tries the writes and the read its
// environment names, and prints one line per try. Nothing in it is an engine stream: the lines are
// read back as they came.
const STUB = `
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  if (args[0] === '--list-models') { process.stdout.write(${JSON.stringify(CURSOR_MODELS)}); process.exit(0); }
  if (args[0] === 'debug') { process.stdout.write(${JSON.stringify(CODEX_MODELS)}); process.exit(0); }
  if (process.env.NOLZU_TEST_MARK) fs.writeFileSync(process.env.NOLZU_TEST_MARK, 'started');
  if (process.env.NOLZU_TEST_CWD) fs.writeFileSync(process.env.NOLZU_TEST_CWD, fs.realpathSync(process.cwd()));
  if (process.env.NOLZU_TEST_CACHE) fs.writeFileSync(process.env.NOLZU_TEST_CACHE, process.env.npm_config_cache || '');
  if (process.env.NOLZU_TEST_MCP) fs.writeFileSync(process.env.NOLZU_TEST_MCP, JSON.stringify({ file: fs.readFileSync('.cursor/mcp.json', 'utf8'), env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('NOLZU_MCP_'))) }));
  const tries = JSON.parse(process.env.NOLZU_TEST_TRIES || '[]');
  for (const [kind, path, text] of tries) {
    let ok = true;
    // A rename moves the file named in the third field onto the path, and a symlink or link points the path at it. A chmod takes the mode as octal text.
    // A run starts the program at the path with the arguments in the third field, as JSON.
    const act = { write: () => fs.writeFileSync(path, text ?? 'x'), read: () => fs.readFileSync(path), rename: () => fs.renameSync(text, path), delete: () => fs.unlinkSync(path), chmod: () => fs.chmodSync(path, parseInt(text, 8)), mkdir: () => fs.mkdirSync(path), symlink: () => fs.symlinkSync(text, path), link: () => fs.linkSync(text, path), run: () => require('node:child_process').execFileSync(path, JSON.parse(text), { stdio: 'ignore' }) }[kind];
    let code;
    try { act(); } catch (error) { ok = false; code = error.code ?? error.status; }
    process.stdout.write(JSON.stringify({ kind, path, ok, code }) + '\\n');
  }
  // A tool left in the engine's group that writes a file only once it is told to stop.
  let ready = Promise.resolve();
  if (process.env.NOLZU_TEST_LINGER) {
    const [path, text] = JSON.parse(process.env.NOLZU_TEST_LINGER);
    const code = 'process.on("SIGTERM", () => setTimeout(() => { require("node:fs").writeFileSync(' + JSON.stringify(path) + ', ' + JSON.stringify(text) + '); process.exit(0); }, 300)); process.stdout.write("ready"); setInterval(() => {}, 1000);';
    const tool = require('node:child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    ready = new Promise((resolve) => tool.stdout.once('data', resolve));
  }
  process.stdin.resume();
  process.stdin.on('end', () => ready.then(() => process.exit(0)));
`;

// Issues the terminal extension for another terminal, as a run with ctypes could, then opens that
// terminal for writing. Exits 7 when the open is refused.
const FORGE = [
  'import ctypes, os, sys',
  "lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
  'lib.sandbox_extension_issue_file.restype = ctypes.c_char_p',
  'lib.sandbox_extension_issue_file.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]',
  'lib.sandbox_extension_consume.argtypes = [ctypes.c_char_p]',
  'lib.sandbox_extension_consume.restype = ctypes.c_int64',
  "token = lib.sandbox_extension_issue_file(b'com.apple.sandbox.pty', sys.argv[1].encode(), 0)",
  'if token: lib.sandbox_extension_consume(token)',
  'try: os.close(os.open(sys.argv[1], os.O_WRONLY | os.O_NOCTTY))',
  'except PermissionError: sys.exit(7)',
].join('\n');

// Hangs up the terminal it names, and exits with the error number when that is refused.
const REVOKE = ['import ctypes, sys', 'lib = ctypes.CDLL(None, use_errno=True)', 'sys.exit(0 if lib.revoke(sys.argv[1].encode()) == 0 else ctypes.get_errno())'].join('\n');

let root = '';
// Every fixture of the test, not only the last: a test that makes two would leave the first in
// the repository, and lint would then read it.
const made: { stub: StubBinary; root: string }[] = [];

afterEach(() => {
  // The folder in the repository goes first: a stub that fails to go only litters the temp folder.
  for (const f of made.splice(0)) {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    f.stub.remove();
  }
  root = '';
});

// Proves the cleanup above: every folder this file made, in the repository and in the temp
// folder, is gone at the end.
const everyFolder: string[] = [];
afterAll(() => expect(everyFolder.filter((dir) => existsSync(dir))).toEqual([]));

interface Fixture {
  binary: string;
  home: string;
  project: string;
  card: string;
  knowledge: string;
}

function fixture(): Fixture {
  const stub = stubBinary(STUB, 'engine-stub');
  root = realpathSync(mkdtempSync(join(scratch, 'spawn-wall-')));
  made.push({ stub, root });
  everyFolder.push(root, dirname(stub.path));
  const home = join(root, 'home');
  const project = join(root, 'project');
  for (const dir of [join(home, '.ssh'), join(home, '.claude'), join(project, 'src'), join(project, 'knowledge')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.ssh/id_ed25519'), 'secret');
  writeFileSync(join(project, 'src/recipe.ts'), 'old');
  // Codex reads its model list before it starts. Read once here with a test's wait and kept: a stub
  // written a moment before can take longer than the product's five seconds on a busy machine.
  codexModelList(stub.path, process.env, 30_000);
  return { binary: stub.path, home, project, card: join(project, '.tasks/APP-1'), knowledge: join(project, 'knowledge') };
}

const job = (f: Fixture, vendor: string, over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: vendor,
  phase: 'refine',
  cwd: f.project,
  prompt: 'Refine the ticket.',
  model: vendor === 'cursor' ? 'gpt-5.3-codex' : vendor === 'codex' ? 'gpt-5.6-sol' : 'sonnet',
  effort: 'low',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: join(f.project, 'run.ndjson'),
  taskDir: f.card,
  knowledgeDir: f.knowledge,
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep'],
  ...over,
});

const mkdirSyncAll = (path: string) => (mkdirSync(path, { recursive: true }), path);

const SPAWN = { 'claude-code': spawnClaude, codex: spawnCodex, cursor: spawnCursor } as const;

async function lines(vendor: keyof typeof SPAWN, f: Fixture, over: Partial<Job>, options: SpawnOptions, env: Record<string, string> = {}): Promise<string[]> {
  const out: string[] = [];
  const all = { ...options, env: { ...process.env, HOME: f.home, ...env } };
  for await (const line of SPAWN[vendor](f.binary, job(f, vendor, over), new AbortController().signal, all)) out.push(line);
  return out;
}

const READ_ONLY = [...Object.keys(PHASE_POLICIES).filter((phase) => PHASE_POLICIES[phase]?.readOnly), ASK_PHASE, 'extract-summary'];

describe('the spec Claude Code hands the wall', () => {
  it.each(READ_ONLY)('holds %s to the card folder, with the secrets hidden', async (phase) => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines('claude-code', f, { phase }, { wall });
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec?.writable).toContain(f.card);
    expect(spec?.writable).not.toContain(f.project);
    expect(spec?.hidden).toEqual(expect.arrayContaining([join(f.home, '.ssh'), join(f.home, '.codex/auth.json')]));
    // HOME is the fixture's, and Claude Code's Read resolves ~ from the account's home, so that one is hidden too.
    expect(spec?.hidden).toContain(join(systemHome() ?? f.home, '.ssh'));
    // The project's own `~/` entry as well.
    const { wall: own, specs: listed } = recordingWall();
    await lines('claude-code', f, { phase, walls: { hidden: ['~/private-notes'], exceptions: [], writable: [] } }, { wall: own });
    expect(listed[0]?.hidden).toEqual(expect.arrayContaining([join(f.home, 'private-notes'), join(systemHome() ?? f.home, 'private-notes')]));
    expect(spec?.writeDenied).toEqual(expect.arrayContaining([join(f.home, '.claude/settings.json'), join(f.project, '.git/hooks')]));
    // The knowledge folder only for the phases that write knowledge.
    expect(spec?.writable.includes(f.knowledge)).toBe(PHASE_POLICIES[phase]?.knowledge === true);
  });

  // The data folder's one `mcp-runs` holds Claude Code's config for an attempt. Every walled run hides
  // it whole, a run with an empty `mcp` (the loop's shape for no server) and a pass too; a Claude Code
  // run with servers opens its own folder again, read only.
  it("hides the data folder's mcp-runs from every run, and reopens only a Claude run's own folder", async () => {
    const f = fixture();
    const runs = realpathSync(mkdirSyncAll(join(resolveDataDir(process.env), 'mcp-runs')));
    for (const id of ['1-1', '1-2']) mkdirSync(join(runs, id), { recursive: true });
    const dir = join(resolveDataDir(process.env), 'mcp-runs', '1-1');
    const mcp = { stdio: { db: { command: 'db-mcp', args: [], env: { DB_LOGIN: 'x' } } }, remote: {}, rules: { db: { tools: [], secretEnv: ['DB_LOGIN'], secretHeaders: [], cwd: null } }, dir };
    const empty = { stdio: {}, remote: {}, rules: {}, dir };
    try {
      for (const [vendor, over, reopened] of [
        ['codex', { mcp }, []],
        ['cursor', { mcp }, []],
        ['claude-code', {}, []],
        ['claude-code', { mcp: empty }, []],
        ['claude-code', { mcp }, [join(runs, '1-1')]],
      ] as const) {
        const { wall, specs } = recordingWall();
        await lines(vendor, f, { ...over, phase: 'implement', cwd: join(f.project, 'worktrees', 'APP-1') }, { wall }).catch(() => undefined);
        expect(specs[0]?.hidden, vendor).toContain(runs);
        expect(specs[0]?.reopened ?? [], vendor).toEqual(reopened);
      }
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  // A Cursor run's merged file holds a reference to each secret, and cursor-agent's environment the
  // value. The file goes after the run.
  it("hands Cursor each secret in its environment and only a reference in .cursor/mcp.json", async () => {
    const f = fixture();
    // Cursor reads the file at the nearest git root, which the project is.
    mkdirSync(join(f.project, '.git'));
    const { wall } = recordingWall();
    const seen = join(root, 'mcp.txt');
    const dir = join(root, 'mcp-runs', '1-1');
    const mcp = {
      stdio: { db: { command: 'db-mcp', args: [], env: { DB_LOGIN: 'hunter2', LEVEL: '1' } } },
      remote: { docs: { url: 'https://mcp.example.com/mcp', transport: 'http' as const, headers: { Authorization: 'Bearer abc', 'X-Team': 'web' } } },
      rules: { db: { tools: [], secretEnv: ['DB_LOGIN'], secretHeaders: [], cwd: null }, docs: { tools: [], secretEnv: [], secretHeaders: ['Authorization'], cwd: null } },
      dir,
    };
    await lines('cursor', f, { mcp, phase: 'implement' }, { wall }, { NOLZU_TEST_MCP: seen });
    const got = JSON.parse(readFileSync(seen, 'utf8')) as { file: string; env: Record<string, string> };
    expect(got.file).not.toContain('hunter2');
    expect(got.file).not.toContain('Bearer abc');
    const servers = JSON.parse(got.file).mcpServers;
    expect(servers.db).toEqual({ type: 'stdio', command: 'db-mcp', args: [], env: { DB_LOGIN: expect.stringMatching(/^\$\{env:NOLZU_MCP_SECRET_[0-9a-f]{16}_0\}$/), LEVEL: '1' } });
    expect(servers.docs).toEqual({ url: 'https://mcp.example.com/mcp', headers: { Authorization: expect.stringMatching(/^\$\{env:NOLZU_MCP_SECRET_[0-9a-f]{16}_1\}$/), 'X-Team': 'web' } });
    const name = (reference: string) => reference.slice('${env:'.length, -1);
    expect(got.env).toEqual({ [name(servers.db.env.DB_LOGIN)]: 'hunter2', [name(servers.docs.headers.Authorization)]: 'Bearer abc' });
    expect(existsSync(join(f.project, '.cursor'))).toBe(false);
  });

  // A hand-edited database cannot loosen the wall: the spawn checks every entry again. macOS only for
  // now: on Linux the spec drops the missing ~/.gradle, a known gap on Linux.
  it.runIf(process.platform === 'darwin')("leaves a bad stored wall entry out and says so on the first line", async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    const walls = { hidden: ['secrets'], exceptions: ['~/.ssh/id_ed25519'], writable: [f.project, '~/.gradle'] };
    const out = await lines('claude-code', f, { phase: 'implement', walls, projectDir: f.project }, { wall });
    expect(specs[0]?.hidden).toContain(join(f.project, 'secrets'));
    expect(specs[0]?.writable).toContain(join(f.home, '.gradle'));
    expect(specs[0]?.envExceptions).toEqual([]);
    const note = runLogNote(out[0] ?? '') ?? '';
    expect(note).toContain("Left out of the project's wall lists: Type the path from the project folder, such as .env.test. ~/.ssh/id_ed25519 is not one.");
    expect(note).toContain(`${f.project} would open the project to a phase that only reads it.`);
  });

  // The home folder stays read-only, so npm's cache goes to Nolzu's data folder, which the wall opens,
  // and never into the card folder.
  it("hands every walled run the package caches in Nolzu's data folder", async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    const seen = join(root, 'cache.txt');
    await lines('claude-code', f, { phase: 'implement' }, { wall }, { NOLZU_TEST_CACHE: seen });
    const caches = join(resolveDataDir(process.env), 'caches');
    expect(readFileSync(seen, 'utf8')).toBe(join(caches, 'npm'));
    expect(specs[0]?.writable).toContain(realpathSync(caches));
  });

  it("maps project entries onto the card's checkout and never hides the card folder", async () => {
    const f = fixture();
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const { wall, specs } = recordingWall();
    const walls = { hidden: ['secrets', f.card], exceptions: ['.env.test'], writable: [] };
    const out = await lines('claude-code', f, { phase: 'implement', cwd: checkout, walls, projectDir: f.project }, { wall });
    expect(specs[0]?.hidden).toEqual(expect.arrayContaining([join(f.project, 'secrets'), join(checkout, 'secrets')]));
    expect(specs[0]?.hidden).not.toContain(f.card);
    expect(specs[0]?.envExceptions).toEqual([join(checkout, '.env.test')]);
    expect(runLogNote(out[0] ?? '') ?? '').toContain(`would hide ${f.card}, which the run needs.`);
  });

  it('opens the checkout for implement, with the secrets still hidden', async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines('claude-code', f, { phase: 'implement' }, { wall });
    expect(specs[0]?.writable).toContain(f.project);
    expect(specs[0]?.writable).not.toContain(f.knowledge);
    expect(specs[0]?.hidden).toContain(join(f.home, '.ssh'));
  });

  it('opens the objects, refs and own admin folder of a worktree checkout for implement only', async () => {
    const f = fixture();
    const common = join(root, "main/.git");
    const own = join(common, "worktrees/w");
    mkdirSync(own, { recursive: true });
    // A real shared folder has these. The Linux wall opens only paths that are there before the run.
    mkdirSync(join(common, "objects"));
    mkdirSync(join(common, "refs"));
    writeFileSync(join(own, "commondir"), "../..");
    writeFileSync(join(f.project, ".git"), `gitdir: ${own}\n`);
    const impl = recordingWall();
    await lines("claude-code", f, { phase: "implement" }, { wall: impl.wall });
    expect(impl.specs[0]?.writable).toEqual(expect.arrayContaining([join(common, "objects"), join(common, "refs"), own]));
    expect(impl.specs[0]?.writable).not.toContain(common);
    expect(impl.specs[0]?.writeDenied).toContain(join(common, "hooks"));
    expect(impl.specs[0]?.writeDeniedLiteral).toEqual(expect.arrayContaining([f.project, join(f.project, ".git"), own, join(own, "commondir")]));
    const ro = recordingWall();
    await lines("claude-code", f, { phase: "refine" }, { wall: ro.wall });
    expect(ro.specs[0]?.writable.filter((path) => path.startsWith(common))).toEqual([]);
  });

  it('holds the git pointers of a repository one folder down in the checkout for implement', async () => {
    const f = fixture();
    const child = join(f.project, 'api');
    mkdirSync(join(child, '.git'), { recursive: true });
    const impl = recordingWall();
    await lines('claude-code', f, { phase: 'implement' }, { wall: impl.wall });
    expect(impl.specs[0]?.writeDeniedLiteral).toEqual(expect.arrayContaining([child, join(child, '.git'), join(child, '.git/commondir')]));
    expect(impl.specs[0]?.writeDenied).toContain(join(child, '.git/config'));
  });

  it('opens the config folder a profile names, not the default one', async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    const configDir = join(f.home, 'work-claude');
    await lines('claude-code', f, {}, { wall, profile: { id: 'work', label: 'Work', vendor: 'claude-code', configDir } });
    expect(specs[0]?.writable).toContain(join(configDir, 'projects'));
    expect(specs[0]?.writable).not.toContain(join(f.home, '.claude/projects'));
    expect(specs[0]?.writeDenied).toContain(join(configDir, 'settings.json'));
  });

  // The config folder is opened whole, so a profile pointed at the home folder or the project would
  // open the project to a read-only phase.
  it.each(['home', 'project'] as const)('refuses a profile whose config folder is the %s folder, and starts no engine', async (where) => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    const mark = join(f.home, 'started');
    const configDir = f[where];
    await expect(lines('claude-code', f, {}, { wall, profile: { id: 'work', label: 'Work', vendor: 'claude-code', configDir } }, { NOLZU_TEST_MARK: mark })).rejects.toThrow(
      `The profile's config folder ${configDir} holds the project or the home folder`,
    );
    expect(specs).toEqual([]);
    expect(existsSync(mark)).toBe(false);
  });

  it('writes no wall line when nothing walls the run', async () => {
    const f = fixture();
    const out = await lines('claude-code', f, {}, { wall: recordingWall().wall });
    expect(out.map(runLogNote).filter((note) => note !== null)).toEqual([]);
  });
});

// The Linux rules, read on any machine with the system name swapped and the recording wall.
describe('on Linux', () => {
  const asLinux = async <T>(body: () => Promise<T>): Promise<T> => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      return await body();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  };

  it('makes the session folders, opens only them, and drops a writable path that is not there', async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await asLinux(() => lines('claude-code', f, {}, { wall }));
    expect(existsSync(join(f.home, '.claude/projects'))).toBe(true);
    expect(specs[0]?.writable).toContain(join(f.home, '.claude/projects'));
    expect(specs[0]?.writable).not.toContain(join(f.home, '.claude'));
    // No `~/.claude.json` in this home, so it stays closed rather than refusing the wall.
    expect(specs[0]?.writable).not.toContain(join(f.home, '.claude.json'));
  });

  // The Cursor CLI saves its config through a temp file and a rename, which a bound file refuses, so
  // its folder opens whole. What was there and is no session state stays read-only, and a name the
  // run adds that could start something later fails the card.
  it("opens Cursor's folder whole and holds the rest of what is in it", async () => {
    const f = fixture();
    mkdirSync(join(f.home, '.cursor'), { recursive: true });
    for (const name of ['cli-config.json', 'argv.json', 'mcp.json']) writeFileSync(join(f.home, '.cursor', name), '{}');
    const { wall, specs } = recordingWall();
    await asLinux(() => lines('cursor', f, {}, { wall }));
    expect(specs[0]?.writable).toContain(join(f.home, '.cursor'));
    expect(specs[0]?.writable).not.toContain(join(f.home, '.cursor/cli-config.json'));
    expect(specs[0]?.writeDenied).toEqual(expect.arrayContaining([join(f.home, '.cursor/argv.json'), join(f.home, '.cursor/mcp.json')]));
    expect(specs[0]?.writeDenied).not.toContain(join(f.home, '.cursor/cli-config.json'));
    expect(specs[0]?.writeDenied).not.toContain(join(f.home, '.cursor/projects'));
  });

  it.each(['hooks.json', 'rules', 'skills'])('fails a Cursor run that added %s to its folder', async (name) => {
    const f = fixture();
    const made = join(f.home, '.cursor', name);
    // The stub writes files only; a new name is what counts, file or folder.
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', made, 'x']]) };
    await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries))).rejects.toThrow(addedToState([made]));
  });

  // A link is held at its target, so the link itself could be removed and a file with a server made
  // under its name.
  it('fails a Cursor run that replaced a link in its folder', async () => {
    const f = fixture();
    const link = join(f.home, '.cursor', 'mcp.json');
    mkdirSync(join(f.home, 'dotfiles'), { recursive: true });
    mkdirSync(join(f.home, '.cursor'), { recursive: true });
    writeFileSync(join(f.home, 'dotfiles', 'mcp.json'), '{}');
    symlinkSync(join(f.home, 'dotfiles', 'mcp.json'), link);
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['delete', link], ['write', link, '{"mcpServers":{"x":{"command":"sh"}}}']]) };
    await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries))).rejects.toThrow(addedToState([link]));
  });

  // The link and its text stay, and the folder its target sits in is swapped for another.
  it("fails a Cursor run that swapped the folder a link's target sits in", async () => {
    const f = fixture();
    const link = join(f.home, '.cursor', 'mcp.json');
    const dotfiles = join(f.home, 'dotfiles');
    mkdirSync(dotfiles, { recursive: true });
    mkdirSync(join(f.home, '.cursor'), { recursive: true });
    writeFileSync(join(dotfiles, 'mcp.json'), '{}');
    symlinkSync(join(dotfiles, 'mcp.json'), link);
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['rename', join(f.home, 'dotfiles-old'), dotfiles], ['mkdir', dotfiles], ['write', join(dotfiles, 'mcp.json'), '{"mcpServers":{"x":{"command":"sh"}}}']]) };
    await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries))).rejects.toThrow(addedToState([link]));
  });

  // Each one named, so removing the first leaves no second one held as the person's own.
  it('names every name a Cursor run added to its folder', async () => {
    const f = fixture();
    const folder = join(f.home, '.cursor');
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(folder, 'notes.txt'), 'x'], ['write', join(folder, 'hooks.json'), '{}']]) };
    const error = await asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries)).catch((caught: Error) => caught);
    expect(String(error)).toContain(join(folder, 'hooks.json'));
    expect(String(error)).toContain(join(folder, 'notes.txt'));
  });

  it('names both when the run changed the permissions and added a name', async () => {
    const f = fixture();
    const folder = join(f.home, '.cursor');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'cli-config.json'), '{}');
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(folder, 'cli-config.json'), '{"permissions":{"allow":["Shell(*)"]}}'], ['write', join(folder, 'hooks.json'), '{}']]) };
    const error = await asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries)).catch((caught: Error) => caught);
    expect(String(error)).toContain(watchedChanged('the permissions in', join(folder, 'cli-config.json')));
    expect(String(error)).toContain(addedToState([join(folder, 'hooks.json')]));
  });

  it('fails a Cursor run that left its folder unreadable, and starts none in a folder it cannot read', async () => {
    const f = fixture();
    const folder = join(f.home, '.cursor');
    mkdirSync(folder, { recursive: true });
    try {
      const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(folder, 'hooks.json'), '{}'], ['chmod', folder, '311']]) };
      await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries))).rejects.toThrow(`Nolzu could not read ${folder} after the run`);
      const { wall, specs } = recordingWall();
      await expect(asLinux(() => lines('cursor', f, {}, { wall }))).rejects.toThrow(`Nolzu cannot read ${folder}`);
      expect(specs).toEqual([]);
    } finally {
      chmodSync(folder, 0o755);
    }
  });

  // A profile's config folder written with a trailing slash names the same session paths.
  it('opens a profile folder whole when its path ends in a slash, and holds no leftover temp name', async () => {
    const f = fixture();
    const profile = join(f.home, 'profiles', 'work');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'cli-config.json.77.0d6c2f1e.tmp'), '{}');
    const { wall, specs } = recordingWall();
    await asLinux(() => lines('cursor', f, {}, { wall, profile: { id: 'cursor#work', label: 'Work', vendor: 'cursor', configDir: `${profile}/` } }));
    expect(specs[0]?.writable).toContain(profile);
    expect(specs[0]?.writable).not.toContain(join(profile, 'cli-config.json'));
    expect(specs[0]?.writeDenied).not.toContain(join(profile, 'cli-config.json.77.0d6c2f1e.tmp'));
  });

  it('lets a Cursor run add its session files and a temp file it saves them through', async () => {
    const f = fixture();
    const folder = join(f.home, '.cursor');
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(folder, 'cli-config.json'), '{}'], ['write', join(folder, 'statsig-cache.json.4242.0d6c2f1e-7a4b-4c9e.tmp'), '{}']]) };
    await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, tries))).resolves.toBeDefined();
    // Not a temp name of a session file.
    const odd = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(folder, 'mcp.json.4242.abc.tmp'), '{}']]) };
    await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, odd))).rejects.toThrow(addedToState([join(folder, 'mcp.json.4242.abc.tmp')]));
    // A session file's name with something else after it.
    const near = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(folder, 'cli-config.json.hooks'), '{}']]) };
    await expect(asLinux(() => lines('cursor', f, {}, { wall: recordingWall().wall }, near))).rejects.toThrow(addedToState([join(folder, 'cli-config.json.hooks')]));
  });

  it.each(['.cursor', '.claude', '.mcp.json'])('names %s when an implement run created it in the checkout', async (name) => {
    const f = fixture();
    const created = join(f.project, name);
    const out = await asLinux(() => lines('cursor', f, { phase: 'implement' }, { wall: recordingWall().wall }, { NOLZU_TEST_TRIES: JSON.stringify([['write', created]]) }));
    expect(out.map(runLogNote).filter((note) => note !== null)).toEqual([`The run created ${created}, which the wall cannot hold on Linux. Check it before another tool opens this checkout.`]);
  });
});

// Codex inside the wall with its own sandbox off, for every phase it runs. It starts in the checkout
// like the other engines, and the wall makes the card folder writable.
describe('the spec Codex hands the wall', () => {
  it.each(['refine', 'plan', 'assess', ASK_PHASE, 'extract-summary'])('holds %s to the card folder, with the secrets hidden', async (phase) => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines('codex', f, { phase }, { wall });
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec?.writable).toContain(f.card);
    expect(spec?.writable).not.toContain(f.project);
    expect(spec?.writable).not.toContain(f.knowledge);
    expect(spec?.hidden).toEqual(expect.arrayContaining([join(f.home, '.ssh'), join(f.home, '.claude/.credentials.json')]));
    expect(spec?.writeDenied).toEqual(expect.arrayContaining([join(f.home, '.codex/config.toml'), join(f.project, '.codex')]));
  });

  it('opens the checkout for implement', async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines('codex', f, { phase: 'implement' }, { wall });
    expect(specs[0]?.writable).toContain(f.project);
    expect(specs[0]?.hidden).toContain(join(f.home, '.ssh'));
  });

  it('hands the wall the engine with its own sandbox off', async () => {
    const f = fixture();
    const seen: string[][] = [];
    const wall = recordingWall().wall;
    await lines('codex', f, { phase: 'refine' }, { wall: (spec, command, args) => (seen.push([...args]), wall(spec, command, args)) });
    expect(seen[0]?.join(' ')).toContain('-c sandbox_mode="danger-full-access"');
    expect(seen[0]?.join(' ')).toContain(`-C ${f.project}`);
  });

  // Inside the wall the three knowledge runs get the knowledge folder, and QA runs like the rest.
  it.each(['qa', 'wrapup', 'optimize', 'orient'])('runs %s inside the wall', async (phase) => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines('codex', f, { phase }, { wall });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.writable).toContain(f.card);
    expect(specs[0]?.writable.includes(f.knowledge)).toBe(phase !== 'qa');
    expect(specs[0]?.writable).not.toContain(f.project);
  });
});

describe.each(['cursor'] as const)('the spec %s hands the wall', (vendor) => {
  it('opens the checkout for implement and hides the other logins', async () => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines(vendor, f, { phase: 'implement' }, { wall });
    expect(specs).toHaveLength(1);
    // The card folder sits inside this checkout, so the checkout covers it.
    expect(specs[0]?.writable).toContain(f.project);
    expect(specs[0]?.hidden).toEqual(expect.arrayContaining([join(f.home, '.ssh'), join(f.home, '.claude/.credentials.json')]));
    expect(specs[0]?.writeDenied).toContain(join(f.project, '.cursor'));
  });

  it.each(['refine', 'plan', 'qa', 'wrapup', 'optimize', 'orient', 'assess'])('holds %s to the card folder inside the wall', async (phase) => {
    const f = fixture();
    const { wall, specs } = recordingWall();
    await lines(vendor, f, { phase }, { wall });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.writable).toContain(f.card);
    expect(specs[0]?.writable).not.toContain(f.project);
    expect(specs[0]?.hidden).toContain(join(f.home, '.ssh'));
  });
});

// QA runs on a throwaway copy of the checkout, so the project's checks can write their caches.
describe.each(['claude-code', 'codex', 'cursor'] as const)('QA on a throwaway copy, on %s', (vendor) => {
  const qaCopy = () => join(root, 'data/qa-copies/qa-APP-1-0a1b2c3d');

  it('starts in the copy, opens it, and keeps the real checkout read-only', async () => {
    const f = fixture();
    const copy = qaCopy();
    await makeQaCopy(f.project, copy, { skip: [join(f.project, '.tasks')] });
    const seen: { command: string; args: string[] }[] = [];
    const { wall, specs } = recordingWall();
    await lines(vendor, f, { phase: 'qa', qaCopy: copy, tools: ['Read', 'Write', 'Bash'] }, { wall: (spec, command, args) => (seen.push({ command, args: [...args] }), wall(spec, command, args)) }, { NOLZU_TEST_CWD: join(root, 'cwd.txt') });
    // The process starts in the copy, never in the real checkout.
    const started = readFileSync(join(root, 'cwd.txt'), 'utf8');
    expect(started).not.toBe(f.project);
    expect(started).toBe(realpathSync(copy));
    const [spec] = specs;
    expect(spec?.writable).toEqual(expect.arrayContaining([copy, f.card]));
    expect(spec?.writable).not.toContain(f.project);
    expect(spec?.envRoots).toEqual(expect.arrayContaining([copy, f.project]));
    // The card folder is the real one, never one inside the copy.
    expect(existsSync(join(copy, '.tasks'))).toBe(false);
    if (vendor === 'codex') expect(seen[0]?.args.join(' ')).toContain(`-C ${copy}`);
    if (vendor === 'claude-code') expect(seen[0]?.args).toEqual(expect.arrayContaining(['--add-dir', f.card]));
  });

  it('hides the .env files of the main project of a card checkout that is a git worktree', async () => {
    const f = fixture();
    const main = join(root, 'main');
    const own = join(main, '.git/worktrees/APP-1');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'commondir'), '../..\n');
    writeFileSync(join(f.project, '.git'), `gitdir: ${own}\n`);
    const copy = qaCopy();
    await makeQaCopy(f.project, copy, { skip: [join(f.project, '.tasks')] });
    const { wall, specs } = recordingWall();
    await lines(vendor, f, { phase: 'qa', qaCopy: copy, tools: ['Read', 'Write', 'Bash'] }, { wall });
    expect(specs[0]?.envRoots).toEqual(expect.arrayContaining([copy, f.project, main]));
  });
});

// The config is gone once Claude Code printed its init message, while the engine still runs: the stub
// prints the init line, then looks for the file it was handed.
it("removes Claude Code's config when the init message arrives, before the run ends", async () => {
  const f = fixture();
  const looker = stubBinary(`
    const args = process.argv.slice(2);
    const config = args[args.indexOf('--mcp-config') + 1];
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ seen: require('node:fs').existsSync(config) }) + '\\n');
      process.exit(0);
    }, 300);
  `, 'claude-init-stub');
  everyFolder.push(dirname(looker.path));
  try {
    const dir = join(root, 'data/mcp-runs/2');
    const mcp = { stdio: { db: { command: 'db-mcp', args: [], env: {} } }, remote: {}, rules: { db: { tools: [], secretEnv: [], secretHeaders: [], cwd: null } }, dir };
    const { wall } = recordingWall();
    const out: string[] = [];
    for await (const line of spawnClaude(looker.path, job(f, 'claude-code', { mcp }), new AbortController().signal, { wall, env: { ...process.env, HOME: f.home } })) out.push(line);
    expect(out).toContain(JSON.stringify({ seen: false }));
  } finally {
    looker.remove();
  }
});

// Claude Code's config is written for the attempt into the run's folder, named on the command line,
// and gone once the run ends.
it("writes Claude Code's config for the attempt and removes it after the run", async () => {
  const f = fixture();
  const copy = join(root, 'data/qa-copies/qa-APP-1-0a1b2c3d');
  await makeQaCopy(f.project, copy, { skip: [join(f.project, '.tasks')] });
  const dir = join(root, 'data/mcp-runs/1');
  const mcp = { stdio: { playwright: { command: 'npx', args: [], env: {} } }, remote: {}, rules: { playwright: { tools: [], secretEnv: [], secretHeaders: [], cwd: null } }, dir };
  const seen: string[][] = [];
  const { wall } = recordingWall();
  await lines('claude-code', f, { phase: 'qa', qaCopy: copy, mcp }, { wall: (spec, command, args) => (seen.push([...args]), wall(spec, command, args)) });
  const args = seen[0] ?? [];
  const config = args[args.indexOf('--mcp-config') + 1] ?? '';
  expect(config.startsWith(`${realpathSync(dir)}/claude-`)).toBe(true);
  expect(args).toContain('mcp__playwright');
  expect(existsSync(config)).toBe(false);
});

// The probe says the wall cannot start: Claude Code runs every phase, Codex runs every phase under
// its own sandbox, and Cursor runs Implement only. The first line of the log says so.
describe('a wall that cannot start', () => {
  const reason = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
  const missing = { wallState: { ready: false, reason } } as const;
  const notes = (out: string[]) => out.map(runLogNote).filter((note) => note !== null);

  it.each(['refine', 'qa', 'implement'])('runs %s on Claude Code without the wall, and says the secrets are not walled', async (phase) => {
    const f = fixture();
    const mark = join(root, 'started');
    const { wall, specs } = recordingWall();
    const out = await lines('claude-code', f, { phase }, { ...missing, wall }, { NOLZU_TEST_MARK: mark });
    expect(existsSync(mark)).toBe(true);
    expect(specs).toEqual([]);
    expect(notes(out)[0]).toContain(`Not walled. ${reason} Secret files such as ~/.ssh and .env are not hidden from this run.`);
    expect(notes(out)[0]?.includes('guard hook')).toBe(phase !== 'implement');
  });

  it('runs Codex under its own sandbox, in the card folder for a read-only phase', async () => {
    const f = fixture();
    const recorded = recordingWall();
    const out = await lines('codex', f, { phase: 'refine', tools: ['Read', 'Write'] }, { ...missing, wall: recorded.wall }, { NOLZU_TEST_CWD: join(root, 'cwd.txt') });
    expect(recorded.specs).toEqual([]);
    expect(readFileSync(join(root, 'cwd.txt'), 'utf8')).toBe(realpathSync(f.card));
    expect(notes(out)[0]).toContain(`Held by the Codex sandbox, because Nolzu's wall cannot start here. ${reason}`);
  });

  it("fails a Codex implement run under its own sandbox that changed the checkout's git pointer", async () => {
    const f = fixture();
    const own = join(root, 'main/.git/worktrees/w');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(f.project, '.git'), `gitdir: ${own}\n`);
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(f.project, '.git')]]) };
    await expect(lines('codex', f, { phase: 'implement' }, { ...missing, wall: recordingWall().wall }, tries)).rejects.toThrow(POINTER_CHANGED);
  });

  // Codex's own sandbox refuses `~/.npm` too, and a run that met that once put npm's cache and logs in
  // the card folder. A phase that runs no command gets nothing.
  it.each([
    ['implement', true],
    ['refine', false],
  ])("hands a Codex %s run under its own sandbox the package caches in Nolzu's data folder: %s", async (phase, gets) => {
    const f = fixture();
    const seen = join(root, 'cache.txt');
    await lines('codex', f, { phase, tools: ['Read', 'Write'] }, { ...missing, wall: recordingWall().wall }, { NOLZU_TEST_CACHE: seen });
    expect(readFileSync(seen, 'utf8')).toBe(gets ? join(resolveDataDir(process.env), 'caches', 'npm') : '');
  });

  // QA, the wrap-up and optimize run as well, under the same sandbox and never inside the wall.
  it.each(['qa', 'wrapup', 'optimize'])('runs %s on Codex under its own sandbox', async (phase) => {
    const f = fixture();
    const mark = join(root, 'started');
    const recorded = recordingWall();
    const out = await lines('codex', f, { phase }, { ...missing, wall: recorded.wall }, { NOLZU_TEST_MARK: mark });
    expect(existsSync(mark)).toBe(true);
    expect(recorded.specs).toEqual([]);
    expect(notes(out)[0]).toContain('Held by the Codex sandbox');
  });

  describe.each(['cursor'] as const)('on %s', (vendor) => {
    it('runs implement without the wall', async () => {
      const f = fixture();
      const { wall, specs } = recordingWall();
      const out = await lines(vendor, f, { phase: 'implement' }, { ...missing, wall });
      expect(specs).toEqual([]);
      expect(notes(out)[0]).toContain(`Not walled. ${reason}`);
    });

    // Never a read-only phase of Cursor without the wall.
    it.each(['refine', 'plan', 'qa', 'wrapup', 'optimize', 'assess', ASK_PHASE, 'extract-summary'])('never spawns %s, and names the failed check', async (phase) => {
      const f = fixture();
      const mark = join(root, 'started');
      const { wall, specs } = recordingWall();
      await expect(lines(vendor, f, { phase }, { ...missing, wall }, { NOLZU_TEST_MARK: mark })).rejects.toThrow(reason);
      expect(existsSync(mark)).toBe(false);
      expect(specs).toEqual([]);
    });
  });
});

// A wall the probe found ready and that still refused fails closed, with no path to the bare engine.
describe.each(['claude-code', 'codex', 'cursor'] as const)('a wall that refuses after the probe, on %s', (vendor) => {
  it('fails the run with the wall reason, and starts no engine', async () => {
    const f = fixture();
    const mark = join(root, 'started');
    const reason = 'sandbox-exec could not start a test wall.';
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: refusingWall(reason) }, { NOLZU_TEST_MARK: mark })).rejects.toThrow(reason);
    expect(existsSync(mark)).toBe(false);
  });
  it('fails a read-only run that changed the engine file that starts something later, and not one that only rewrote it', async () => {
    // Codex has no such file.
    if (vendor === 'codex') return;
    const f = fixture();
    const file = { 'claude-code': join(f.home, '.claude.json'), cursor: join(f.home, '.cursor/cli-config.json') }[vendor];
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{"numStartups":1}');
    const what = { 'claude-code': 'the MCP servers or hooks in', cursor: 'the permissions in' }[vendor];
    // The double starts the stub with no wall, so the write lands, as it would where the file must stay writable.
    const bad = vendor === 'claude-code' ? { mcpServers: { x: { command: 'sh' } } } : { permissions: { allow: ['Shell(*)'] } };
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', file, JSON.stringify(bad)]]) };
    await expect(lines(vendor, f, { phase: 'refine' }, { wall: recordingWall().wall }, tries)).rejects.toThrow(watchedChanged(what, file));
    writeFileSync(file, '{"numStartups":1}');
    const same = { NOLZU_TEST_TRIES: JSON.stringify([['write', file, '{"numStartups":2,"projects":{"/work/app":{"mcpServers":{}}}}']]) };
    await expect(lines(vendor, f, { phase: 'refine' }, { wall: recordingWall().wall }, same)).resolves.toBeDefined();
  });

  it('compares the engine file only after a tool the run left behind is gone', async () => {
    if (vendor !== 'claude-code') return;
    const f = fixture();
    const file = join(f.home, '.claude.json');
    writeFileSync(file, '{"numStartups":1}');
    const linger = { NOLZU_TEST_LINGER: JSON.stringify([file, JSON.stringify({ mcpServers: { x: { command: 'sh' } } })]) };
    await expect(lines(vendor, f, { phase: 'refine' }, { wall: recordingWall().wall }, linger)).rejects.toThrow(watchedChanged('the MCP servers or hooks in', file));
  });

  it("fails an implement run that changed the checkout's git pointer, and leaves a read-only run alone", async () => {
    const f = fixture();
    const own = join(root, 'main/.git/worktrees/w');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(f.project, '.git'), `gitdir: ${own}\n`);
    // The double starts the stub with no wall, so the write lands, as it would through a gap.
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['write', join(f.project, '.git')]]) };
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: recordingWall().wall }, tries)).rejects.toThrow(POINTER_CHANGED);
    writeFileSync(join(f.project, '.git'), `gitdir: ${own}\n`);
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: recordingWall().wall }, { NOLZU_TEST_TRIES: '[]' })).resolves.toBeDefined();
    // A read-only run is held to its card folder by the wall, and the git compare after it is the loop's.
    await expect(lines(vendor, f, { phase: 'refine' }, { wall: recordingWall().wall }, tries)).resolves.toBeDefined();
  });

  it('fails an implement run that left a link where git writes by name, and leaves a read-only run alone', async () => {
    const f = fixture();
    const own = join(root, 'main/.git/worktrees/w');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(f.project, '.git'), `gitdir: ${own}\n`);
    const target = join(f.home, '.zshenv');
    writeFileSync(target, 'export IMPORTANT=1\n');
    const message = join(own, 'COMMIT_EDITMSG');
    // The double starts the stub with no wall, so the link lands, as it does on Linux.
    const tries = { NOLZU_TEST_TRIES: JSON.stringify([['symlink', message, target]]) };
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: recordingWall().wall }, tries)).rejects.toThrow(`${message} is a link, where git writes by name.`);
    rmSync(message);
    const second = { NOLZU_TEST_TRIES: JSON.stringify([['link', join(own, 'FETCH_HEAD'), target]]) };
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: recordingWall().wall }, second)).rejects.toThrow(`${join(own, 'FETCH_HEAD')} is a file with a second name`);
    rmSync(join(own, 'FETCH_HEAD'));
    // A repository one folder down, as a card on several repositories has, is looked at as well.
    const child = join(f.project, 'api', '.git');
    mkdirSync(child, { recursive: true });
    const third = { NOLZU_TEST_TRIES: JSON.stringify([['symlink', join(child, 'COMMIT_EDITMSG'), target]]) };
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: recordingWall().wall }, third)).rejects.toThrow(`${join(child, 'COMMIT_EDITMSG')} is a link, where git writes by name.`);
    rmSync(join(child, 'COMMIT_EDITMSG'));
    await expect(lines(vendor, f, { phase: 'implement' }, { wall: recordingWall().wall }, { NOLZU_TEST_TRIES: '[]' })).resolves.toBeDefined();
    await expect(lines(vendor, f, { phase: 'refine' }, { wall: recordingWall().wall }, tries)).resolves.toBeDefined();
  });
});

// The stubs inside the real wall. On macOS that is sandbox-exec, which every Mac has; on a Linux
// with bubblewrap it is bwrap.
const ready = wallHere();
const live = (process.platform === 'darwin' || process.platform === 'linux') && ready.ready;

describe.skipIf(!live)(`inside the real wall${ready.ready ? '' : ` (skipped: ${ready.reason})`}`, () => {
  const tries = (f: Fixture) => [
    ['write', join(f.project, 'src/recipe.ts')],
    ['write', join(f.card, 'note.md')],
    ['write', join(root, 'outside.md')],
    ['read', join(f.home, '.ssh/id_ed25519')],
  ];
  const results = (out: string[]) => Object.fromEntries(out.filter((line) => runLogNote(line) === null).map((line) => JSON.parse(line) as { path: string; ok: boolean }).map((one) => [one.path, one.ok]));
  // In order, for tries that name one path more than once.
  const oks = (out: string[]) => out.filter((line) => runLogNote(line) === null).map((line) => (JSON.parse(line) as { ok: boolean }).ok);
  // Why each try failed: the error code, or a program's exit status.
  const codes = (out: string[]) => out.filter((line) => runLogNote(line) === null).map((line) => (JSON.parse(line) as { code?: string | number }).code ?? null);

  // A terminal made outside the wall, as another window's would be. script names it in a file.
  const otherTerminal = async () => {
    const named = join(root, 'tty.txt');
    const other = spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sh', '-c', `tty > '${named}'; sleep 30`], { stdio: 'ignore' });
    const read = () => (existsSync(named) ? readFileSync(named, 'utf8').trim() : '');
    for (let wait = 0; !read() && wait < 100; wait += 1) await new Promise((done) => setTimeout(done, 50));
    return { name: read(), stop: () => other.kill() };
  };

  // The real wall around the data folder's `mcp-runs`: a Claude Code run with servers reads its own folder
  // and nothing else there, and writes none of it; a Codex run reads none of it.
  it("lets a Claude run read only its own mcp-runs folder, and a Codex run none", async () => {
    const f = fixture();
    const runs = mkdirSyncAll(join(resolveDataDir(process.env), 'mcp-runs'));
    const own = mkdirSyncAll(join(runs, '7-1'));
    const other = mkdirSyncAll(join(runs, '7-2'));
    writeFileSync(join(own, 'probe.txt'), 'mine');
    writeFileSync(join(other, 'probe.txt'), 'theirs');
    const mcp = { stdio: { db: { command: 'db-mcp', args: [], env: {} } }, remote: {}, rules: { db: { tools: [], secretEnv: [], secretHeaders: [], cwd: null } }, dir: own };
    const probe = JSON.stringify([['read', join(own, 'probe.txt')], ['read', join(other, 'probe.txt')], ['write', join(own, 'new.txt')]]);
    try {
      expect(oks(await lines('claude-code', f, { mcp }, {}, { NOLZU_TEST_TRIES: probe }))).toEqual([true, false, false]);
      expect(oks(await lines('codex', f, { mcp }, {}, { NOLZU_TEST_TRIES: probe }))).toEqual([false, false, false]);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });

  it('says which wall holds the run on the first line, with the writable folders', async () => {
    const f = fixture();
    const out = await lines('claude-code', f, {}, {}, { NOLZU_TEST_TRIES: '[]' });
    const note = runLogNote(out[0] ?? '');
    expect(note).toMatch(process.platform === 'darwin' ? /^Walled by macOS sandbox-exec\. Writable: / : /^Walled by bubblewrap\. Writable: /);
    expect(note).toContain(f.card);
  });

  it('holds a read-only Claude Code phase to its card folder', async () => {
    const f = fixture();
    const out = await lines('claude-code', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(tries(f)) });
    expect(results(out)).toEqual({
      [join(f.project, 'src/recipe.ts')]: false,
      [join(f.card, 'note.md')]: true,
      [join(root, 'outside.md')]: false,
      [join(f.home, '.ssh/id_ed25519')]: false,
    });
    expect(readFileSync(join(f.project, 'src/recipe.ts'), 'utf8')).toBe('old');
  });

  it('holds a read-only Codex phase to its card folder, with its own sandbox off', async () => {
    const f = fixture();
    const out = await lines('codex', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(tries(f)) });
    expect(runLogNote(out[0] ?? '')).toMatch(/^Walled by /);
    expect(results(out)).toEqual({
      [join(f.project, 'src/recipe.ts')]: false,
      [join(f.card, 'note.md')]: true,
      [join(root, 'outside.md')]: false,
      [join(f.home, '.ssh/id_ed25519')]: false,
    });
    expect(readFileSync(join(f.project, 'src/recipe.ts'), 'utf8')).toBe('old');
  });

  // The stub stands in for a QA engine: it writes a cache in the copy, its report in the real card
  // folder, and tries the real checkout and the secrets.
  it.each(['claude-code', 'codex'] as const)('lets %s QA write its copy and the real card folder, and not the real checkout', async (vendor) => {
    const f = fixture();
    writeFileSync(join(f.project, '.env'), 'SECRET=1');
    mkdirSync(join(f.project, 'node_modules'));
    const copy = join(root, 'data/qa-copies/qa-APP-1-0a1b2c3d');
    await makeQaCopy(f.project, copy, { skip: [join(f.project, '.tasks')] });
    mkdirSync(join(f.card, 'qa'), { recursive: true });
    const qaTries = [
      ['write', join(copy, 'node_modules/.cache')],
      ['write', join(copy, 'src/recipe.ts')],
      ['write', join(f.card, 'qa/report.md')],
      ['write', join(f.project, 'src/recipe.ts')],
      ['write', join(f.project, 'tsconfig.tsbuildinfo')],
      ['read', join(copy, '.env')],
      ['read', join(f.project, '.env')],
      ['read', join(f.home, '.ssh/id_ed25519')],
    ];
    const out = await lines(vendor, f, { phase: 'qa', qaCopy: copy, tools: ['Read', 'Write', 'Bash'] }, {}, { NOLZU_TEST_TRIES: JSON.stringify(qaTries) });
    expect(runLogNote(out[0] ?? '')).toContain(copy);
    expect(results(out)).toEqual({
      [join(copy, 'node_modules/.cache')]: true,
      [join(copy, 'src/recipe.ts')]: true,
      [join(f.card, 'qa/report.md')]: true,
      [join(f.project, 'src/recipe.ts')]: false,
      [join(f.project, 'tsconfig.tsbuildinfo')]: false,
      [join(copy, '.env')]: false,
      [join(f.project, '.env')]: false,
      [join(f.home, '.ssh/id_ed25519')]: false,
    });
    expect(readFileSync(join(f.project, 'src/recipe.ts'), 'utf8')).toBe('old');
    expect(readFileSync(join(f.card, 'qa/report.md'), 'utf8')).toBe('x');
    await removeQaCopy(copy);
    expect(existsSync(copy)).toBe(false);
  });

  // The project's own lists from Settings, Project, Walls, through the real wall.
  it("hides an extra path, reads a .env exception and lets only Implement write an extra cache", async () => {
    const f = fixture();
    mkdirSync(join(f.home, 'secrets'));
    writeFileSync(join(f.home, 'secrets/key'), 'secret');
    writeFileSync(join(f.project, '.env'), 'SECRET=1');
    writeFileSync(join(f.project, '.env.test'), 'TEST=1');
    mkdirSync(join(f.home, '.gradle'));
    const walls = { hidden: ['~/secrets'], exceptions: ['.env.test'], writable: ['~/.gradle'] };
    const listTries = [
      ['read', join(f.home, 'secrets/key')],
      ['read', join(f.project, '.env.test')],
      ['read', join(f.project, '.env')],
      ['write', join(f.home, '.gradle/cache')],
    ];
    const run = (phase: string) => lines('claude-code', f, { phase, walls, projectDir: f.project }, {}, { NOLZU_TEST_TRIES: JSON.stringify(listTries) });
    const expected = (writes: boolean) => ({
      [join(f.home, 'secrets/key')]: false,
      [join(f.project, '.env.test')]: true,
      [join(f.project, '.env')]: false,
      [join(f.home, '.gradle/cache')]: writes,
    });
    expect(results(await run('implement'))).toEqual(expected(true));
    expect(results(await run('plan'))).toEqual(expected(false));
  });

  it("keeps an implement run off the checkout's git pointers, and lets it write beside them", async () => {
    const f = fixture();
    const own = join(root, 'main/.git/worktrees/w');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'commondir'), '../..\n');
    writeFileSync(join(f.project, '.git'), `gitdir: ${own}\n`);
    mkdirSync(join(f.project, 'api'));
    writeFileSync(join(f.project, 'api/.git'), `gitdir: ${own}\n`);
    const pointerTries = [
      ['write', join(f.project, '.git')],
      ['write', join(f.project, 'api/.git')],
      ['write', join(own, 'commondir')],
      ['write', join(own, 'index')],
      ['write', join(f.project, 'src/recipe.ts')],
    ];
    const out = await lines('claude-code', f, { phase: 'implement' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(pointerTries) });
    expect(results(out)).toEqual({
      [join(f.project, '.git')]: false,
      [join(f.project, 'api/.git')]: false,
      [join(own, 'commondir')]: false,
      [join(own, 'index')]: true,
      [join(f.project, 'src/recipe.ts')]: true,
    });
  });

  // A real worktree, as Nolzu makes a card's checkout. The run commits, stashes and branches in its own
  // checkout, and cannot write a sibling card's admin folder, the main checkout's HEAD and index, the
  // exclude file, or a new name such as a lock or removal folder of Nolzu's in the shared git folder.
  it("lets an implement run in a worktree commit, and keeps it off the rest of the shared git folder", async () => {
    const f = fixture();
    const env = { ...process.env, HOME: f.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    const run = (...args: string[]) => spawnSync('git', args, { cwd: f.project, env, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('add', 'src');
    run('commit', '-q', '-m', 'first');
    const one = join(f.project, 'worktrees/APP-1');
    const two = join(f.project, 'worktrees/APP-2');
    run('worktree', 'add', '-q', '-b', 'app-1', one);
    run('worktree', 'add', '-q', '-b', 'app-2', two);
    const common = join(f.project, '.git');
    const git = (...args: string[]) => ['run', '/bin/sh', JSON.stringify(['-c', `cd '${one}' && git ${args.join(' ')}`])];
    const wallTries = [
      ['write', join(one, 'src/recipe.ts'), 'new'],
      git('add', 'src/recipe.ts'),
      git('commit', '-q', '-m', 'work'),
      git('branch', 'scratch'),
      ['write', join(one, 'src/recipe.ts'), 'newer'],
      git('stash', '-q'),
      git('stash', 'pop', '-q'),
      ['write', join(common, 'worktrees/APP-2/commondir'), '/tmp/x'],
      ['write', join(common, 'worktrees/APP-2/config.worktree'), 'x'],
      ['write', join(common, 'HEAD'), 'ref: refs/heads/app-1'],
      ['write', join(common, 'info/exclude'), 'x'],
      ['mkdir', join(common, 'nolzu-removing')],
      ['mkdir', join(common, 'nolzu-locks')],
      git('worktree', 'add', '-q', '../APP-3'),
    ];
    const out = await lines('claude-code', f, { phase: 'implement', cwd: one }, {}, { ...env, NOLZU_TEST_TRIES: JSON.stringify(wallTries) });
    expect(oks(out)).toEqual([true, true, true, true, true, true, true, false, false, false, false, false, false, false]);
    expect(run('-C', one, 'log', '--format=%s', '-1').stdout.trim()).toBe('work');
    expect(run('rev-parse', '--verify', '-q', 'scratch').status).toBe(0);
    expect(existsSync(join(common, 'nolzu-removing'))).toBe(false);
  });

  // git writes COMMIT_EDITMSG, FETCH_HEAD and the reflogs by name, through a link. macOS refuses a new
  // link there, and a link file renamed in; Linux has no such rule, and the check after the run holds.
  it.skipIf(process.platform !== 'darwin')('refuses a symbolic link and a hard link where git writes by name in a worktree, and still commits', async () => {
    const f = fixture();
    const env = { ...process.env, HOME: f.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
    const run = (...args: string[]) => spawnSync('git', args, { cwd: f.project, env, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('add', 'src');
    run('commit', '-q', '-m', 'first');
    const one = join(f.project, 'worktrees/APP-1');
    run('worktree', 'add', '-q', '-b', 'app-1', one);
    const common = join(f.project, '.git');
    const own = join(common, 'worktrees/APP-1');
    // A file the run may write, so only the no-link rule stands in the way of a second name.
    const mine = join(one, 'src/recipe.ts');
    const temp = join(f.project, 'worktrees/APP-1/linked');
    const linkTries = [
      ['symlink', join(own, 'COMMIT_EDITMSG'), join(f.home, '.zshenv')],
      ['link', join(own, 'FETCH_HEAD'), mine],
      ['symlink', join(common, 'logs/refs/heads/feature'), join(f.home, '.zshenv')],
      ['symlink', join(common, 'packed-refs'), join(f.home, '.zshenv')],
      ['link', temp, mine],
      ['rename', join(own, 'MERGE_MSG'), temp],
      ['run', '/bin/sh', JSON.stringify(['-c', `cd '${one}' && git commit -q --allow-empty -m work`])],
    ];
    const out = await lines('claude-code', f, { phase: 'implement', cwd: one }, {}, { ...env, NOLZU_TEST_TRIES: JSON.stringify(linkTries) });
    expect(oks(out)).toEqual([false, false, false, false, true, false, true]);
    expect(run('-C', one, 'log', '--format=%s', '-1').stdout.trim()).toBe('work');
  });

  // A skill, command or agent planted there would load in a later Claude Code or Cursor run. macOS
  // holds the name, so a new .claude fails too; Linux names it after the run instead.
  it("keeps an implement run out of the checkout's .claude folder", async () => {
    const f = fixture();
    mkdirSync(join(f.project, '.claude/skills/x'), { recursive: true });
    writeFileSync(join(f.project, '.claude/skills/x/SKILL.md'), 'old');
    const claudeTries = [
      ['write', join(f.project, '.claude/skills/x/SKILL.md')],
      ['write', join(f.project, '.claude/commands.md')],
      ['write', join(f.project, 'src/recipe.ts')],
      ['write', join(f.project, 'src/new.ts')],
    ];
    const out = await lines('claude-code', f, { phase: 'implement' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(claudeTries) });
    expect(results(out)).toEqual({
      [join(f.project, '.claude/skills/x/SKILL.md')]: false,
      [join(f.project, '.claude/commands.md')]: false,
      [join(f.project, 'src/recipe.ts')]: true,
      [join(f.project, 'src/new.ts')]: true,
    });
    expect(readFileSync(join(f.project, '.claude/skills/x/SKILL.md'), 'utf8')).toBe('old');

    const g = fixture();
    const fresh = join(g.project, '.claude');
    const made = await lines('cursor', g, { phase: 'implement' }, {}, { NOLZU_TEST_TRIES: JSON.stringify([['write', fresh]]) });
    expect(results(made)).toEqual({ [fresh]: process.platform !== 'darwin' });
  });

  // Claude Code starts the stdio servers the checkout's .mcp.json names, so a run must not plant one.
  // A file, held by name: on macOS a write, a new one, a delete and a rename onto it all fail.
  it("keeps an implement run off the checkout's .mcp.json", async () => {
    const f = fixture();
    const mcp = join(f.project, '.mcp.json');
    writeFileSync(mcp, '{}');
    writeFileSync(join(f.project, 'other.json'), '{"mcpServers":{"x":{"command":"evil"}}}');
    const mcpTries = [
      ['write', mcp],
      ['rename', mcp, join(f.project, 'other.json')],
      ['delete', mcp],
      ['write', join(f.project, 'root.txt')],
    ];
    const out = await lines('claude-code', f, { phase: 'implement' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(mcpTries) });
    expect(oks(out)).toEqual([false, false, false, true]);
    expect(readFileSync(mcp, 'utf8')).toBe('{}');

    const g = fixture();
    const fresh = join(g.project, '.mcp.json');
    writeFileSync(join(g.project, 'other.json'), '{}');
    const made = await lines('cursor', g, { phase: 'implement' }, {}, { NOLZU_TEST_TRIES: JSON.stringify([['write', fresh], ['rename', fresh, join(g.project, 'other.json')]]) });
    expect(oks(made)).toEqual(process.platform === 'darwin' ? [false, false] : [true, true]);
    expect(existsSync(fresh)).toBe(process.platform !== 'darwin');
  });

  // In SBPL the last matching rule wins, so a whole open ~/.claude left every name the row did not
  // close writable, and each of these loads later outside the wall. macOS only for now: on Linux the
  // run cannot write ~/.claude.json or history.jsonl, a known gap on Linux.
  it.runIf(process.platform === 'darwin')('lets Claude Code write only its session folders and files in ~/.claude', async () => {
    const f = fixture();
    const claude = join(f.home, '.claude');
    for (const dir of ['rules', 'projects/p/memory']) mkdirSync(join(claude, dir), { recursive: true });
    for (const file of ['statusline.sh', 'rules/x.md', 'projects/p/memory/m.md', 'settings.json']) writeFileSync(join(claude, file), 'old');
    const denied = ['statusline.sh', 'rules/x.md', 'projects/p/memory/m.md', 'projects/p/memory/new.md', 'settings.json', 'output-styles.md'].map((name) => join(claude, name));
    const sessions = ENGINE_WALLS['claude-code'].sessionFolders.map((folder) => join(f.home, folder.slice(2), 'probe'));
    const claudeTries = [
      ...denied.map((path) => ['write', path]),
      ...sessions.map((path) => ['write', path]),
      ['write', join(claude, 'projects/p/session.jsonl')],
      ['write', join(claude, 'history.jsonl')],
      // Valid and with no MCP server, so the compare after the run stays quiet.
      ['write', join(f.home, '.claude.json'), '{"numStartups":1}'],
    ];
    const out = await lines('claude-code', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(claudeTries) });
    expect(results(out)).toEqual({
      ...Object.fromEntries(denied.map((path) => [path, false])),
      ...Object.fromEntries(sessions.map((path) => [path, true])),
      [join(claude, 'projects/p/session.jsonl')]: true,
      [join(claude, 'history.jsonl')]: true,
      [join(f.home, '.claude.json')]: true,
    });
    expect(readFileSync(join(claude, 'statusline.sh'), 'utf8')).toBe('old');
  });

  // The Cursor CLI saves its config as `<file>.<pid>.<uuid>.tmp` beside it and then renames that over
  // the file. Without the temp name a refine run stopped at once with EPERM. Any other new name in
  // ~/.cursor stays closed.
  it.runIf(process.platform === 'darwin')('lets Cursor replace its config through a temp file beside it, and write nothing else there', async () => {
    const f = fixture();
    const cursor = join(f.home, '.cursor');
    mkdirSync(cursor, { recursive: true });
    const config = join(cursor, 'cli-config.json');
    writeFileSync(config, '{"permissions":{"allow":[]}}');
    const temp = `${config}.4242.0d6c2f1e-7a4b-4c9e-9f2a-3b1e5d8c7a60.tmp`;
    const cursorTries = [
      ['write', temp, '{"permissions":{"allow":[]},"model":"new"}'],
      ['rename', config, temp],
      ['write', join(cursor, 'statsig-cache.json.4242.0f3e9a.tmp')],
      ['write', `${config}.tmp`],
      ['write', join(cursor, 'cli-config.json.4242.ab.tmp.json')],
      ['write', join(cursor, 'hooks.json.4242.ab.tmp')],
      ['write', join(cursor, 'mcp.json')],
    ];
    const out = await lines('cursor', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(cursorTries) });
    expect(oks(out)).toEqual([true, true, true, false, false, false, false]);
    expect(readFileSync(config, 'utf8')).toContain('"model":"new"');
    expect(existsSync(join(cursor, 'mcp.json'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('lets a run open a terminal of its own, and neither read nor write one it did not open', async () => {
    const f = fixture();
    const other = await otherTerminal();
    try {
      expect(other.name).toMatch(/^\/dev\/ttys[0-9]+$/);
      const ptyTries = [['run', '/usr/bin/script', '["-q","/dev/null","/usr/bin/true"]'], ['read', other.name], ['write', other.name]];
      const out = await lines('cursor', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(ptyTries) });
      expect(oks(out)).toEqual([true, false, false]);
      expect(codes(out)).toEqual([null, 'EPERM', 'EPERM']);
    } finally {
      other.stop();
    }
  });

  // Without the Command Line Tools, /usr/bin/python3 opens an install dialog instead of running.
  const python = process.platform === 'darwin' && spawnSync('/usr/bin/xcode-select', ['-p']).status === 0;
  it.runIf(python)('refuses a run that issues itself the right to another terminal', async () => {
    const f = fixture();
    const other = await otherTerminal();
    try {
      expect(other.name).toMatch(/^\/dev\/ttys[0-9]+$/);
      const out = await lines('cursor', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify([['run', '/usr/bin/python3', JSON.stringify(['-I', '-c', FORGE, other.name])]]) });
      // 7 is the forge script's own exit for a refused open, so a crash before it cannot pass.
      expect(codes(out)).toEqual([7]);
    } finally {
      other.stop();
    }
  });

  // `revoke` hangs up a terminal with no read and no write, so the read and write rules alone let it through.
  it.runIf(python)('refuses a run that hangs up another terminal', async () => {
    const f = fixture();
    const other = await otherTerminal();
    try {
      expect(other.name).toMatch(/^\/dev\/ttys[0-9]+$/);
      const out = await lines('cursor', f, { phase: 'refine' }, {}, { NOLZU_TEST_TRIES: JSON.stringify([['run', '/usr/bin/python3', JSON.stringify(['-I', '-c', REVOKE, other.name])]]) });
      // 1 is EPERM.
      expect(codes(out)).toEqual([1]);
    } finally {
      other.stop();
    }
  });

  it.each(['claude-code', 'codex', 'cursor'] as const)('lets %s implement in the checkout, and nowhere outside it', async (vendor) => {
    const f = fixture();
    const out = await lines(vendor, f, { phase: 'implement' }, {}, { NOLZU_TEST_TRIES: JSON.stringify(tries(f)) });
    expect(results(out)).toEqual({
      [join(f.project, 'src/recipe.ts')]: true,
      [join(f.card, 'note.md')]: true,
      [join(root, 'outside.md')]: false,
      [join(f.home, '.ssh/id_ed25519')]: false,
    });
  });
});
