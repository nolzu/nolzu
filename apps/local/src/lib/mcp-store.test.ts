import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE } from '@nolzu/protocol';
import { createKeychain, CURSOR_RECORD, type KeychainRun, MCP_RUNS } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyEntry, MCP_FILE, type McpEntry } from './mcp-list.ts';
import { deleteServer, mcpPage, saveSecret, saveServer, setPhase, testServer } from './mcp-page.ts';
import { browserEntry, commitMcpList, commitMcpListSoon, cursorMergesHere, flushMcpCommit, listShared, listUncommitted, migrateQaBrowser, missingSecrets, promptMcp, qaHasBrowser, readMcpList, runMcp, secretName, sweepMcpRuns, writeMcpList } from './mcp-store.ts';

let dir = '';
let project = '';
let db: DatabaseSync;
const ID = 4;

// The real keychain module over a Map, the way a Linux keyring answers, as in ticket-system.test.ts.
// Nothing here runs a command or reaches the machine's keychain. `refuse` makes every store fail and
// `broken` every read.
function fakeKeychain({ refuse = false, broken = false } = {}) {
  const entries = new Map<string, string>();
  const run: KeychainRun = async (_command, args, input) => {
    const account = args[args.indexOf('account') + 1] ?? '';
    if (args[0] === 'store') {
      if (refuse) return { code: 2, stdout: '', stderr: 'locked' };
      entries.set(account, input);
    }
    if (args[0] === 'clear') entries.delete(account);
    if (args[0] === 'lookup') {
      if (broken) return { code: 1, stdout: '', stderr: 'the keyring is locked' };
      const held = entries.get(account);
      return held === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: held, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { entries, keychain: createKeychain('linux', run, dir) };
}

const local = (patch: Partial<McpEntry> = {}): McpEntry => ({ ...emptyEntry(), name: 'db', command: 'db-mcp', ...patch });
const remote = (patch: Partial<McpEntry> = {}): McpEntry => ({ ...emptyEntry(), name: 'docs', kind: 'remote', url: 'https://mcp.example.com/mcp', ...patch });
const file = () => readFileSync(join(project, MCP_FILE), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-mcp-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-mcp-project-'));
  db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('names a secret per project id, server and key, in the characters a keychain name takes', () => {
  const one = secretName(ID, local(), { where: 'env', name: 'DB_LOGIN' });
  expect(one).toMatch(/^mcp-[a-f0-9]{32}$/);
  expect(secretName(ID, local(), { where: 'header', name: 'DB_LOGIN' })).not.toBe(one);
  expect(secretName(ID, local({ name: 'db2' }), { where: 'env', name: 'DB_LOGIN' })).not.toBe(one);
  expect(secretName(ID + 1, local(), { where: 'env', name: 'DB_LOGIN' })).not.toBe(one);
  // A pull that points a server of the same name elsewhere leaves its secret behind.
  expect(secretName(ID, local({ command: 'other-mcp' }), { where: 'env', name: 'DB_LOGIN' })).not.toBe(one);
  expect(secretName(ID, local({ args: ['--evil'] }), { where: 'env', name: 'DB_LOGIN' })).not.toBe(one);
  expect(secretName(ID, remote({ url: 'https://elsewhere.example/mcp' }), { where: 'header', name: 'A' })).not.toBe(secretName(ID, remote(), { where: 'header', name: 'A' }));
  // A plain value counts too: a server reads its host from one as often as from its arguments.
  expect(secretName(ID, local({ env: [{ name: 'JIRA_URL', secret: false, value: 'https://elsewhere.example' }] }), { where: 'env', name: 'DB_LOGIN' })).not.toBe(one);
  // What a run never sends anywhere does not count, so a phase or tool change keeps the secret.
  expect(secretName(ID, local({ phases: ['plan'], tools: ['query'] }), { where: 'env', name: 'DB_LOGIN' })).toBe(one);
});

describe('writing the list', () => {
  it('keeps unknown keys, unknown rows and rows it left out, as they were', () => {
    mkdirSync(join(project, '.nolzu'), { recursive: true });
    writeFileSync(
      join(project, MCP_FILE),
      JSON.stringify({ version: 2, servers: [{ ...local(), future: { a: 1 } }, 'odd', { name: 'bad name', kind: 'local', command: 'x' }] }),
    );
    const read = readMcpList(project);
    expect(read.servers.map((one) => one.name)).toEqual(['db']);
    expect(writeMcpList(project, [...read.servers, local({ name: 'notes' })])).toBeNull();
    const back = JSON.parse(file());
    expect(back.version).toBe(2);
    expect(back.servers[0].future).toEqual({ a: 1 });
    expect(back.servers.slice(1).map((row: unknown) => (typeof row === 'object' && row !== null ? (row as { name: string }).name : row))).toEqual(['notes', 'odd', 'bad name']);
  });

  it('writes nothing over a file it cannot read, such as one with a git conflict', () => {
    mkdirSync(join(project, '.nolzu'), { recursive: true });
    const conflict = '{\n<<<<<<< HEAD\n  "servers": []\n=======\n  "servers": [{}]\n>>>>>>> theirs\n}\n';
    writeFileSync(join(project, MCP_FILE), conflict);
    expect(readMcpList(project).broken).toMatch(/git conflict/);
    expect(writeMcpList(project, [local()])).toMatch(/git conflict/);
    expect(file()).toBe(conflict);
  });
});

describe('the QA browser of the old setting', () => {
  it("moves Nolzu's own config in as its browser, once, and clears the setting", async () => {
    const own = join(dir, 'playwright-mcp.json');
    writeFileSync(own, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env: { HOME: '/tmp/x' } } } }));
    writeSetting(db, 'qaMcpConfigPath', own);
    const { entries, keychain } = fakeKeychain();

    expect(await migrateQaBrowser(db, ID, keychain, own)).toBeNull();
    expect(readMcpList(project).servers).toEqual([browserEntry()]);
    expect(getSetting(db, 'qaMcpConfigPath')).toBeNull();
    expect(entries.size).toBe(0);
    expect(await migrateQaBrowser(db, ID, keychain, own)).toBeNull();
    expect(readMcpList(project).servers).toHaveLength(1);
  });

  it("moves a config of the person's own with its values as secrets, an engine's own name plain", async () => {
    const theirs = join(dir, 'their-mcp.json');
    writeFileSync(theirs, JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['b'], env: { API_KEY: 'k-123', HOME: '/home/me/x' } }, docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' } } } }));
    writeSetting(db, 'qaMcpConfigPath', theirs);
    writeMcpList(project, [local({ name: 'docs' })]);
    const { keychain } = fakeKeychain();

    expect(await migrateQaBrowser(db, ID, keychain, join(dir, 'playwright-mcp.json'))).toBeNull();
    expect(readMcpList(project).servers.map((one) => one.name)).toEqual(['docs', 'browser']);
    expect(readMcpList(project).servers[1]).toMatchObject({ env: [{ name: 'API_KEY', secret: true }, { name: 'HOME', secret: false, value: '/home/me/x' }], phases: ['qa'] });
    expect(file()).not.toContain('k-123');
    expect(await keychain.read(secretName(ID, readMcpList(project).servers.find((one) => one.name === 'browser') ?? local(), { where: 'env', name: 'API_KEY' }))).toBe('k-123');
  });

  it('moves the server in when the keychain refuses, and the page then asks for the secret', async () => {
    const theirs = join(dir, 'their-mcp.json');
    writeFileSync(theirs, JSON.stringify({ mcpServers: { browser: { command: 'npx', env: { API_KEY: 'k' } } } }));
    writeSetting(db, 'qaMcpConfigPath', theirs);
    const { keychain } = fakeKeychain({ refuse: true });

    expect(await migrateQaBrowser(db, ID, keychain, '')).toBeNull();
    expect(getSetting(db, 'qaMcpConfigPath')).toBeNull();
    expect((await mcpPage(db, keychain, ID)).rows[0]?.missing).toEqual([{ where: 'env', name: 'API_KEY' }]);
  });

  it('waits with a config whose address holds a login, and says so, so it is never committed', async () => {
    const theirs = join(dir, 'their-mcp.json');
    writeFileSync(theirs, JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp?token=abc' } } }));
    writeSetting(db, 'qaMcpConfigPath', theirs);
    expect(await migrateQaBrowser(db, ID, fakeKeychain().keychain, '')).toMatch(/holds token=/);
    expect(getSetting(db, 'qaMcpConfigPath')).toBe(theirs);
    expect(existsSync(join(project, MCP_FILE))).toBe(false);
  });

  it('refuses a QA run while the old browser file is gone, and says so on the pages', async () => {
    writeSetting(db, 'qaMcpConfigPath', join(dir, 'gone.json'));
    expect(await migrateQaBrowser(db, ID, fakeKeychain().keychain, '')).toMatch(/QA runs are refused until it is\. There is no browser config at/);
    await expect(runMcp({ project, projectId: ID, phase: 'qa', vendor: 'claude-code', keychain: fakeKeychain().keychain, dir: join(dir, 'r'), cursorHere: true, legacy: join(dir, 'gone.json') })).rejects.toThrow(/There is no browser config at/);
  });

  it('writes no secret over a server of the same name already in the list', async () => {
    const theirs = join(dir, 'their-mcp.json');
    writeFileSync(theirs, JSON.stringify({ mcpServers: { browser: { command: 'npx', env: { API_KEY: 'old' } } } }));
    writeSetting(db, 'qaMcpConfigPath', theirs);
    const { keychain } = fakeKeychain();
    await keychain.write(secretName(ID, local({ name: 'browser' }), { where: 'env', name: 'API_KEY' }), 'mine');
    // The list already holds a server of that name, with its own secret on this machine.
    writeMcpList(project, [local({ name: 'browser', env: [{ name: 'API_KEY', secret: true }] })]);
    expect(await migrateQaBrowser(db, ID, keychain, '')).toBeNull();
    expect(await keychain.read(secretName(ID, local({ name: 'browser' }), { where: 'env', name: 'API_KEY' }))).toBe('mine');
    expect(readMcpList(project).servers).toHaveLength(1);
  });

  it('keeps the old setting working and says why when an entry does not pass', async () => {
    const theirs = join(dir, 'their-mcp.json');
    writeFileSync(theirs, JSON.stringify({ mcpServers: { browser: { command: '--bad' } } }));
    writeSetting(db, 'qaMcpConfigPath', theirs);

    const problem = await migrateQaBrowser(db, ID, fakeKeychain().keychain, '');
    expect(problem).toMatch(/is not moved to Settings, MCP servers yet, and QA still uses it from there\. The command of browser starts with a dash/);
    expect(getSetting(db, 'qaMcpConfigPath')).toBe(theirs);
    expect(qaHasBrowser(db)).toBe(true);
    // QA keeps the old browser until the move succeeds.
    const mcp = await runMcp({ project, projectId: ID, phase: 'qa', vendor: 'claude-code', keychain: fakeKeychain().keychain, dir: join(dir, 'r'), cursorHere: true, legacy: theirs });
    expect(Object.keys(mcp.mcp?.stdio ?? {})).toEqual(['browser']);
    expect(promptMcp(project, 'qa', 'claude-code', theirs).browser).toEqual(['browser']);
  });
});

describe('the servers of a run', () => {
  const run = (vendor: 'claude-code' | 'codex' | 'cursor', keychain: ReturnType<typeof fakeKeychain>['keychain'], cursorHere = true) =>
    runMcp({ project, projectId: ID, phase: 'plan', vendor, keychain, dir: join(dir, MCP_RUNS, '7'), cursorHere });

  it('reads the secrets into memory and writes no file at all', async () => {
    const { keychain } = fakeKeychain();
    writeMcpList(project, [
      local({ env: [{ name: 'DB_LOGIN', secret: true }, { name: 'LEVEL', secret: false, value: '1' }], tools: ['query'], cwd: 'tools', phases: ['plan'] }),
      remote({ transport: 'sse', headers: [{ name: 'Authorization', secret: true }], phases: ['plan'] }),
      local({ name: 'off' }),
    ]);
    await keychain.write(secretName(ID, readMcpList(project).servers[0] ?? local(), { where: 'env', name: 'DB_LOGIN' }), 'hunter2');
    await keychain.write(secretName(ID, remote(), { where: 'header', name: 'Authorization' }), 'Bearer abc');

    const { mcp, notes } = await run('claude-code', keychain);
    expect(notes).toEqual([]);
    expect(mcp).toEqual({
      stdio: { db: { command: 'db-mcp', args: [], env: { DB_LOGIN: 'hunter2', LEVEL: '1' } } },
      remote: { docs: { url: 'https://mcp.example.com/mcp', transport: 'sse', headers: { Authorization: 'Bearer abc' } } },
      rules: {
        db: { tools: ['query'], secretEnv: ['DB_LOGIN'], secretHeaders: [], cwd: join(project, 'tools') },
        docs: { tools: [], secretEnv: [], secretHeaders: ['Authorization'], cwd: null },
      },
      dir: join(dir, MCP_RUNS, '7'),
    });
    expect(existsSync(join(dir, MCP_RUNS))).toBe(false);
    expect(file()).not.toContain('hunter2');
  });

  it('leaves out a server whose secret is missing or cannot be read, and says which', async () => {
    writeMcpList(project, [local({ env: [{ name: 'DB_LOGIN', secret: true }], phases: ['plan'] })]);
    const missing = await run('claude-code', fakeKeychain().keychain);
    expect(missing.mcp).toBeNull();
    expect(missing.notes).toEqual(['db is left out: this machine has no secret DB_LOGIN for it. Enter it on Settings, MCP servers.']);
    const locked = await run('claude-code', fakeKeychain({ broken: true }).keychain);
    expect(locked.notes[0]).toMatch(/^db is left out: the keychain could not be read for its secrets\./);
    expect(await missingSecrets(ID, readMcpList(project).servers, fakeKeychain().keychain)).toEqual({ db: [{ where: 'env', name: 'DB_LOGIN' }] });
  });

  it('gives Codex no SSE server, and Cursor a server with a secret, with a warning', async () => {
    const { keychain } = fakeKeychain();
    writeMcpList(project, [local({ phases: ['plan'], tools: ['query'] }), remote({ transport: 'sse', phases: ['plan'] }), local({ name: 'vault', env: [{ name: 'V', secret: true }], phases: ['plan'] })]);
    await keychain.write(secretName(ID, local({ name: 'vault' }), { where: 'env', name: 'V' }), 'vault-pass');

    const codex = await run('codex', keychain);
    expect(Object.keys(codex.mcp?.rules ?? {})).toEqual(['db', 'vault']);
    expect(codex.notes).toEqual(['Codex speaks to remote servers over streamable HTTP only, so the SSE server docs is left out.']);
    const cursor = await run('cursor', keychain);
    expect(Object.keys(cursor.mcp?.rules ?? {})).toEqual(['db', 'docs', 'vault']);
    expect(cursor.mcp?.stdio.vault?.env).toEqual({ V: 'vault-pass' });
    expect(cursor.notes).toEqual(['Cursor cannot limit single tools, so this run may call every tool of db.', "On Cursor the agent's shell can read the secret of vault."]);
    expect(cursor.notes.join('\n')).not.toContain('vault-pass');
    expect((await run('cursor', keychain, false)).notes[0]).toMatch(/merges no \.cursor\/mcp\.json/);

    // A secret this machine lacks still leaves the server out of a Cursor run, with its sentence.
    const lacking = await run('cursor', fakeKeychain().keychain);
    expect(Object.keys(lacking.mcp?.rules ?? {})).toEqual(['db', 'docs']);
    expect(lacking.notes).toContain('vault is left out: this machine has no secret V for it. Enter it on Settings, MCP servers.');
    expect(lacking.notes.join('\n')).not.toMatch(/can read the secret/);
  });

  it('reads every temp folder token of Nolzu\'s browser on this machine', async () => {
    writeMcpList(project, [{ ...browserEntry(), env: [{ name: 'HOME', secret: false, value: '{tmp}/a:{tmp}/b' }], phases: ['plan'] }]);
    const { mcp } = await run('claude-code', fakeKeychain().keychain);
    expect(mcp?.stdio.playwright?.env.HOME).toBe(`${join(tmpdir(), 'a')}:${join(tmpdir(), 'b')}`);
  });

  it('names in the prompt Nolzu\'s browser as QA\'s browser and every other server apart', () => {
    writeMcpList(project, [browserEntry(), local({ phases: ['qa'], description: 'The test database' })]);
    expect(promptMcp(project, 'qa', 'codex', null)).toEqual({ browser: ['playwright'], servers: [{ name: 'db', description: 'The test database' }] });
  });
});

it("puts back a Cursor run's merge from its record, then clears every run folder", () => {
  const checkout = join(project, 'worktrees', 'APP-1');
  mkdirSync(join(checkout, '.cursor'), { recursive: true });
  writeFileSync(join(checkout, '.cursor', 'mcp.json'), 'merged');
  const runs = join(dir, MCP_RUNS);
  mkdirSync(join(runs, '3'), { recursive: true });
  writeFileSync(join(runs, '3', CURSOR_RECORD), JSON.stringify({ file: join(checkout, '.cursor', 'mcp.json'), before: Buffer.from('theirs').toString('base64'), madeFolder: null, exclude: null }));
  mkdirSync(join(runs, '4'));
  writeFileSync(join(runs, '4', 'claude-x.json'), 'secret');

  // A record whose QA copy the sweep already took away is skipped, and the boot goes on.
  mkdirSync(join(runs, '5'));
  writeFileSync(join(runs, '5', CURSOR_RECORD), JSON.stringify({ file: join(dir, 'qa-copies', 'gone', '.cursor', 'mcp.json'), before: null, madeFolder: join(dir, 'qa-copies', 'gone', '.cursor'), exclude: null }));

  sweepMcpRuns(dir);
  expect(readFileSync(join(checkout, '.cursor', 'mcp.json'), 'utf8')).toBe('theirs');
  expect(readdirSync(runs)).toEqual([]);
  expect(statSync(runs).mode & 0o777).toBe(0o700);
});

describe('Settings, MCP servers', () => {
  const form = (fields: Record<string, string | string[]>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) for (const one of [value].flat()) data.append(key, one);
    return data;
  };

  // Test starts the server for a moment and lists its tools, on a saved row or in the form as
  // typed. The fake server of the fixtures runs in place of the command, through the wall seam.
  const SERVER = join(import.meta.dirname, '..', '..', 'fixtures', 'mcp-server.mjs');
  const seams = (env: Record<string, string> = {}) => ({
    wall: (_spec: unknown, command: string, args: readonly string[]) => ({ command, args: [...args] }),
    spawn: (_command: string, _args: readonly string[], options: object) => spawn(process.execPath, [SERVER], { ...options, env: { ...(options as { env: object }).env, ...env } }),
  });

  it('tests a saved server and lists its tools, with the tools it allows now', async () => {
    const { keychain } = fakeKeychain();
    writeMcpList(project, [local({ tools: ['search_recipes', 'old_tool'] })]);

    expect(await testServer(db, keychain, form({ name: 'db' }), ID, seams())).toEqual({
      name: 'db',
      from: 'row',
      ok: true,
      said: 'Started, 3 tools: search_recipes, read_recipe, list_menus.',
      tools: ['search_recipes', 'read_recipe', 'list_menus'],
      chosen: ['search_recipes', 'old_tool'],
    });
    expect((await testServer(db, keychain, form({ name: 'gone' }), ID, seams())).said).toBe('There is no server gone. Reload the page.');
  });

  it('tests the form as typed, with a typed secret, and saves nothing', async () => {
    const { keychain } = fakeKeychain();
    const typed = form({ original: '', name: 'db', kind: 'local', command: 'db-mcp', 'env.name': ['TOKEN', 'FAKE_MODE'], 'env.mode': ['secret', 'plain'], 'env.value': ['hunter2', 'exit'], tools: 'query' });

    const answer = await testServer(db, keychain, typed, ID, seams());
    expect(answer).toMatchObject({ name: 'db', from: 'form', ok: false, tools: [], chosen: ['query'] });
    expect(answer.said).toMatch(/^The server stopped with exit code 3 before it answered/);
    expect(readMcpList(project).servers).toEqual([]);
    expect(await keychain.read(secretName(ID, local(), { where: 'env', name: 'TOKEN' }))).toBeNull();
  });

  // The saved secret sits under the server as saved, and Save would carry it to the edited one.
  it('tests an edited form with the saved secret when its box is left empty', async () => {
    const { keychain } = fakeKeychain();
    writeMcpList(project, [local({ env: [{ name: 'TOKEN', secret: true }] })]);
    await keychain.write(secretName(ID, readMcpList(project).servers[0] ?? local(), { where: 'env', name: 'TOKEN' }), 'hunter2');
    const edited = form({ original: 'db', name: 'db', kind: 'local', command: 'db-mcp', args: '--other\n', 'env.name': 'TOKEN', 'env.mode': 'secret', 'env.value': '' });

    expect(await testServer(db, keychain, edited, ID, seams())).toMatchObject({ from: 'form', ok: true });
  });

  // Once a test listed the tools, each is a box, so the form posts one value per ticked tool.
  it('saves the ticked tools of the boxes, and a typed list too', async () => {
    const { keychain } = fakeKeychain();
    expect(await saveServer(db, keychain, form({ original: '', name: 'db', kind: 'local', command: 'db-mcp', tools: ['search_recipes', 'list_menus'] }), ID)).toBeNull();
    expect(readMcpList(project).servers[0]?.tools).toEqual(['search_recipes', 'list_menus']);
  });

  it('adds a server with its secret in the keychain, off everywhere, and no secret in the file', async () => {
    const { keychain } = fakeKeychain();
    const answer = await saveServer(db, keychain, form({ original: '', name: 'db', kind: 'local', command: 'db-mcp', args: '--read-only\n', 'env.name': ['DB_LOGIN', 'LEVEL', ''], 'env.mode': ['secret', 'plain', 'plain'], 'env.value': ['hunter2', '1', ''], tools: 'query, list' }), ID);
    expect(answer).toBeNull();
    expect(readMcpList(project).servers).toEqual([local({ args: ['--read-only'], env: [{ name: 'DB_LOGIN', secret: true }, { name: 'LEVEL', secret: false, value: '1' }], tools: ['query', 'list'] })]);
    expect(file()).not.toContain('hunter2');
    expect(await keychain.read(secretName(ID, readMcpList(project).servers[0] ?? local(), { where: 'env', name: 'DB_LOGIN' }))).toBe('hunter2');

    const page = await mcpPage(db, keychain, ID);
    expect(page.rows[0]?.missing).toEqual([]);
    expect(page.shared).toBe(false);
    expect(page.phases.map((column) => column.phase)).toContain('plan');
    // The engine notes above the list follow the profiles: one Claude Code login names neither.
    expect([page.cursor, page.codex]).toEqual([false, false]);
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex', label: 'Codex', vendor: 'codex', configDir: null }]);
    const withCodex = await mcpPage(db, keychain, ID);
    expect([withCodex.cursor, withCodex.codex]).toEqual([false, true]);
  });

  it('names the secret the keychain would not take, and keeps a change saved meanwhile', async () => {
    expect(await saveServer(db, fakeKeychain({ refuse: true }).keychain, form({ original: '', name: 'db', kind: 'local', command: 'x', 'env.name': 'DB_LOGIN', 'env.mode': 'secret', 'env.value': 'v' }), ID)).toMatch(/^The keychain did not take DB_LOGIN\./);
    // A keychain that waits for a person while another tab saves a server: both stay.
    let release = () => {};
    const slow = fakeKeychain().keychain;
    const waiting = { ...slow, write: async (name: string, secret: string) => { await new Promise<void>((resolve) => (release = resolve)); return slow.write(name, secret); } };
    const saving = saveServer(db, waiting, form({ original: '', name: 'db', kind: 'local', command: 'x', 'env.name': 'DB_LOGIN', 'env.mode': 'secret', 'env.value': 'v' }), ID);
    writeMcpList(project, [local({ name: 'other' })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    expect(await saving).toBeNull();
    expect(readMcpList(project).servers.map((one) => one.name)).toEqual(['other', 'db']);
  });

  it('refuses a login in an address on a save, so it is never committed', async () => {
    expect(await saveServer(db, fakeKeychain().keychain, form({ original: '', name: 'docs', kind: 'remote', url: 'https://mcp.example.com/mcp?token=abc' }), ID)).toMatch(/holds token=/);
    expect(existsSync(join(project, MCP_FILE))).toBe(false);
  });

  it('refuses a secret an engine reads for itself, and warns on a login in an address', async () => {
    const { keychain } = fakeKeychain();
    expect(await saveServer(db, keychain, form({ original: '', name: 'db', kind: 'local', command: 'x', 'env.name': 'HOME', 'env.mode': 'secret', 'env.value': '/x' }), ID)).toBe('HOME cannot be a secret, because an engine reads it for itself too. Make it plain.');
    writeMcpList(project, [remote({ url: 'https://mcp.example.com/mcp?api_key=abc' })]);
    expect((await mcpPage(db, keychain, ID)).rows[0]?.urlWarning).toMatch(/holds api_key=/);
  });

  it('keeps a secret on an edit left empty, moves it on a rename, and drops it on a delete', async () => {
    const { entries, keychain } = fakeKeychain();
    await saveServer(db, keychain, form({ original: '', name: 'db', kind: 'local', command: 'db-mcp', 'env.name': 'DB_LOGIN', 'env.mode': 'secret', 'env.value': 'hunter2' }), ID);
    expect(setPhase(db, 'db', 'plan', true)).toBeNull();

    expect(await saveServer(db, keychain, form({ original: 'db', name: 'base', kind: 'local', command: 'db-mcp', 'env.name': 'DB_LOGIN', 'env.mode': 'secret', 'env.value': '' }), ID)).toBeNull();
    expect(readMcpList(project).servers[0]).toMatchObject({ name: 'base', phases: ['plan'] });
    expect(await keychain.read(secretName(ID, local({ name: 'base' }), { where: 'env', name: 'DB_LOGIN' }))).toBe('hunter2');
    expect(await keychain.read(secretName(ID, local(), { where: 'env', name: 'DB_LOGIN' }))).toBeNull();

    expect(await deleteServer(db, keychain, 'base', ID)).toBeNull();
    expect(readMcpList(project).servers).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it("warns on a server with a secret while the project has a Cursor profile, whose agent's shell can read it", async () => {
    const { keychain } = fakeKeychain();
    writeMcpList(project, [local({ env: [{ name: 'DB_LOGIN', secret: true }] }), remote({ headers: [{ name: 'X-Team', secret: false, value: 'web' }] })]);
    expect((await mcpPage(db, keychain, ID)).rows.map((row) => row.cursorSecret)).toEqual([false, false]);
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'cursor', label: 'Cursor', vendor: 'cursor', configDir: null }]);
    expect((await mcpPage(db, keychain, ID)).rows.map((row) => row.cursorSecret)).toEqual([true, false]);
  });

  it('asks for a missing secret, and the field fills it', async () => {
    const { keychain } = fakeKeychain();
    writeMcpList(project, [local({ env: [{ name: 'DB_LOGIN', secret: true }], phases: ['plan'] })]);
    expect((await mcpPage(db, keychain, ID)).rows[0]?.missing).toEqual([{ where: 'env', name: 'DB_LOGIN' }]);
    expect(await saveSecret(db, keychain, 'db', 'env', 'DB_LOGIN', '', ID)).toBe('Type the value of DB_LOGIN.');
    expect(await saveSecret(db, keychain, 'db', 'header', 'DB_LOGIN', 'x', ID)).toMatch(/has no secret/);
    expect(await saveSecret(db, keychain, 'db', 'env', 'DB_LOGIN', 'hunter2', ID)).toBeNull();
    expect((await mcpPage(db, keychain, ID)).rows[0]?.missing).toEqual([]);
  });

  it('refuses a bad server, a phase there is none of, and any write while the file is broken', async () => {
    const { keychain } = fakeKeychain();
    expect(await saveServer(db, keychain, form({ original: '', name: 'a b', kind: 'local', command: 'x' }), ID)).toMatch(/letters, digits/);
    writeMcpList(project, [local()]);
    expect(setPhase(db, 'db', 'deploy', true)).toBe('There is no phase "deploy".');
    expect(setPhase(db, 'db', 'qa', true)).toBeNull();
    expect((await mcpPage(db, keychain, ID)).rows[0]).toMatchObject({ unlimited: ['QA'] });
    expect(setPhase(db, 'db', 'qa', false)).toBeNull();
    expect(readMcpList(project).servers[0]?.phases).toEqual([]);

    writeFileSync(join(project, MCP_FILE), '{ not json');
    expect(setPhase(db, 'db', 'qa', true)).toMatch(/is not JSON/);
    expect(await saveServer(db, keychain, form({ original: '', name: 'x', kind: 'local', command: 'x' }), ID)).toMatch(/is not JSON/);
    expect(await deleteServer(db, keychain, 'db', ID)).toMatch(/is not JSON/);
    expect((await mcpPage(db, keychain, ID)).broken).toMatch(/is not JSON/);
  });
});

// The list reaches the team through the workspace repository. So a write is
// committed there, the file alone, the way the list of clones is.
describe('the list in the workspace repository', () => {
  const env = () => ({ ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  const sh = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { env: env(), encoding: 'utf8' });

  it('commits the file alone, and nothing when it did not change', async () => {
    sh('init', '-q', '-b', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'first');
    writeFileSync(join(project, 'notes.txt'), 'the person is still writing this\n');
    writeMcpList(project, [local()]);

    expect(await commitMcpList(project, env())).toBeNull();
    expect(sh('log', '-1', '--format=%s').trim()).toBe('chore: update the MCP servers');
    expect(sh('show', '--name-only', '--format=', 'HEAD').trim()).toBe(MCP_FILE);
    expect(sh('status', '--porcelain')).toContain('notes.txt');
    expect(await commitMcpList(project, env())).toBeNull();
    expect(sh('rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('leaves a file the person staged out of the commit', async () => {
    sh('init', '-q', '-b', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'first');
    writeFileSync(join(project, 'staged.txt'), 'theirs\n');
    sh('add', 'staged.txt');
    writeMcpList(project, [local()]);
    expect(await commitMcpList(project, env())).toBeNull();
    expect(sh('show', '--name-only', '--format=', 'HEAD').trim()).toBe(MCP_FILE);
    expect(sh('diff', '--cached', '--name-only').trim()).toBe('staged.txt');
  });

  it('commits a burst of grid clicks once, and calls a list git ignores not shared', async () => {
    sh('init', '-q', '-b', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'first');
    writeFileSync(join(project, '.gitignore'), '.nolzu/\n');
    expect(await listShared(project, env())).toBe(false);
    rmSync(join(project, '.gitignore'));
    expect(await listShared(project, env())).toBe(true);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    writeMcpList(project, [local()]);
    commitMcpListSoon(project, env(), 300);
    await wait(150);
    // A click inside the quiet moment starts it again, so nothing is committed yet when the first
    // moment would have ended.
    writeMcpList(project, [local({ phases: ['plan'] })]);
    commitMcpListSoon(project, env(), 300);
    await wait(250);
    expect(sh('rev-list', '--count', 'HEAD').trim()).toBe('1');
    await wait(800);
    expect(sh('rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(sh('status', '--porcelain').trim()).toBe('');
  });

  it('commits a waiting burst at once when the loop closes, and tells an uncommitted list apart', async () => {
    sh('init', '-q', '-b', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'first');
    writeMcpList(project, [local()]);
    expect(await listUncommitted(project, env())).toBe(true);
    commitMcpListSoon(project, env(), 60_000);
    expect(await flushMcpCommit(project, env())).toBeNull();
    expect(sh('rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(await listUncommitted(project, env())).toBe(false);
    expect(flushMcpCommit(project, env())).toBeNull();
  });

  // A hand edit goes to the team as it is on disk, so anything Nolzu could not read cleanly stops the
  // commit with a sentence, and the page shows it.
  it.each([
    ['broken JSON', '{ "servers": [', /is not JSON/],
    ['a row it left out', JSON.stringify({ servers: [{ name: 'a b', kind: 'local', command: 'x' }] }), /is left out/],
    ['a secret value', JSON.stringify({ servers: [{ name: 'db', kind: 'local', command: 'x', env: [{ name: 'T', secret: true, value: 'leaked' }] }] }), /holds a value for the secret T/],
    ['a login in the query', JSON.stringify({ servers: [{ name: 'docs', kind: 'remote', url: 'https://mcp.example.com/mcp?token=abc' }] }), /holds token=/],
    ['a password in the address', JSON.stringify({ servers: [{ name: 'docs', kind: 'remote', url: 'https://me:pw@mcp.example.com/mcp' }] }), /user name or a password/],
  ])('commits no hand edit with %s, and the page says why', async (_what, text, said) => {
    sh('init', '-q', '-b', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'first');
    mkdirSync(join(project, '.nolzu'), { recursive: true });
    writeFileSync(join(project, MCP_FILE), text);
    const answer = await commitMcpList(project, env());
    expect(answer).toMatch(/is not committed, so your team does not get this change/);
    expect(answer).toMatch(said);
    expect(sh('rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect((await mcpPage(db, fakeKeychain().keychain, ID)).commitProblem).toMatch(said);
  });

  it('commits nothing on a detached HEAD or in the middle of a merge, and says so', async () => {
    sh('init', '-q', '-b', 'main');
    sh('commit', '-q', '--allow-empty', '-m', 'first');
    writeMcpList(project, [local()]);
    sh('checkout', '-q', '--detach');
    expect(await commitMcpList(project, env())).toMatch(/on no branch \(a detached HEAD\)/);
    sh('checkout', '-q', 'main');
    writeFileSync(join(project, '.git', 'MERGE_HEAD'), `${sh('rev-parse', 'HEAD').trim()}\n`);
    expect(await commitMcpList(project, env())).toMatch(/in the middle of a merge/);
    rmSync(join(project, '.git', 'MERGE_HEAD'));
    expect(await commitMcpList(project, env())).toBeNull();
    expect(sh('rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('commits nothing in a project folder that is not the top of its own repository', async () => {
    writeMcpList(project, [local()]);
    expect(await commitMcpList(project, env())).toBeNull();
  });
});

// Cursor reads the `.cursor/mcp.json` of the nearest git root above where it starts, so the merge goes
// there, and only when that root lies inside the project or QA's copy.
describe('cursorMergesHere', () => {
  let home = '';
  let workspace = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cursor-here-'));
    workspace = join(home, 'Toolshed');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    mkdirSync(join(workspace, 'worktrees', 'Q-1', 'repo'), { recursive: true });
    writeFileSync(join(workspace, 'worktrees', 'Q-1', 'repo', '.git'), 'gitdir: elsewhere\n');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const here = (cwd: string, over: { qaCopy?: string; tracked?: boolean; project?: string } = {}) =>
    cursorMergesHere({ project: over.project ?? workspace, cwd, qaCopy: over.qaCopy ?? null, tracked: async () => over.tracked ?? false });

  it("takes a Research card's folder, whose root is the project folder", async () => {
    expect(await here(join(workspace, 'worktrees', 'Q-1'))).toBe(true);
    expect(await here(join(workspace, 'worktrees', 'Q-1', 'repo'))).toBe(true);
    // A project path stored with a trailing slash names the same folder.
    expect(await here(join(workspace, 'worktrees', 'Q-1'), { project: `${workspace}/` })).toBe(true);
  });

  it('refuses the project folder itself, the worktrees folder and a root that tracks the file', async () => {
    expect(await here(workspace)).toBe(false);
    expect(await here(join(workspace, 'worktrees'))).toBe(false);
    expect(await here(join(workspace, 'worktrees', 'Q-1'), { tracked: true })).toBe(false);
  });

  it('refuses a root outside the project, such as a home folder that is a repository', async () => {
    const plain = join(home, 'plain');
    mkdirSync(join(plain, 'worktrees', 'Q-2'), { recursive: true });
    mkdirSync(join(home, '.git'));
    expect(await here(join(plain, 'worktrees', 'Q-2'), { project: plain })).toBe(false);
  });

  it("takes QA's copy only when its root is inside the copy", async () => {
    const copy = join(home, 'qa-copy');
    mkdirSync(copy);
    writeFileSync(join(copy, '.git'), 'gitdir: elsewhere\n');
    expect(await here(join(workspace, 'worktrees', 'Q-1', 'repo'), { qaCopy: copy })).toBe(true);
    rmSync(join(copy, '.git'));
    mkdirSync(join(home, '.git'));
    expect(await here(join(workspace, 'worktrees', 'Q-1', 'repo'), { qaCopy: copy })).toBe(false);
  });
});
