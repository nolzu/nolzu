import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { createKeychain, type KeychainRun } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyEntry, MCP_FILE } from './mcp-list.ts';
import { claudeServers, codexServers, cursorServers, findImports, importServers } from './mcp-import.ts';
import { readMcpList, secretName } from './mcp-store.ts';

let dir = '';
let home = '';
let project = '';
let db: DatabaseSync;

// The real keychain module over a Map, as in mcp-store.test.ts. Nothing reaches the machine's keychain.
function fakeKeychain() {
  const entries = new Map<string, string>();
  const run: KeychainRun = async (_command, args, input) => {
    const account = args[args.indexOf('account') + 1] ?? '';
    if (args[0] === 'store') entries.set(account, input);
    if (args[0] === 'lookup') {
      const held = entries.get(account);
      return held === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: held, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return createKeychain('linux', run, dir);
}

// The three files as each engine writes them, in a home folder of the test's own.
const CLAUDE = (folder: string) =>
  JSON.stringify({
    mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' } }, 'bad name': { command: 'x' } },
    projects: { [folder]: { mcpServers: { db: { type: 'stdio', command: 'db-mcp', args: ['--read-only'], env: { DB_TOKEN: 'hunter2', LEVEL: '1' } } } }, '/elsewhere': { mcpServers: { other: { command: 'o' } } } },
  });
const CODEX = `model = "gpt-5"

[mcp_servers.search]
command = "npx"
args = ["-y", "search-mcp"] # a comment
env = { "SEARCH_KEY" = "k-1" }

[mcp_servers.feed]
url = "https://feed.example.com/mcp"

[mcp_servers.feed.http_headers]
X-Team = "web"

[profiles.fast]
model = "gpt-5-mini"
`;
const CURSOR = JSON.stringify({ mcpServers: { linear: { url: 'https://linear.example.com/sse', headers: {} }, local: { command: 'node', args: ['server.js'] } } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-mcp-import-'));
  home = join(dir, 'home');
  project = join(dir, 'recipes');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.cursor'), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, '.claude.json'), CLAUDE(project));
  writeFileSync(join(home, '.codex', 'config.toml'), CODEX);
  writeFileSync(join(home, '.cursor', 'mcp.json'), CURSOR);
  db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it("reads Claude Code's global servers and this project's, every value a secret, and skips a bad name", () => {
  const found = claudeServers(CLAUDE(project), project);
  expect(found.map((one) => one.key)).toEqual(['Claude Code:docs', 'Claude Code:db']);
  expect(found[0]?.entry).toMatchObject({ kind: 'remote', url: 'https://mcp.example.com/mcp', transport: 'http', headers: [{ name: 'Authorization', secret: true }] });
  expect(found[1]?.entry).toMatchObject({ kind: 'local', command: 'db-mcp', args: ['--read-only'], env: [{ name: 'DB_TOKEN', secret: true }, { name: 'LEVEL', secret: true }], phases: [] });
  expect(found[1]?.values).toEqual({ 'env:DB_TOKEN': 'hunter2', 'env:LEVEL': '1' });
  expect(claudeServers('{', project)).toEqual([]);
});

it("reads Codex's server tables, inline and as sub-tables, and leaves the rest of the file", () => {
  const found = codexServers(CODEX);
  expect(found.map((one) => one.key)).toEqual(['Codex:search', 'Codex:feed']);
  expect(found[0]?.entry).toMatchObject({ command: 'npx', args: ['-y', 'search-mcp'], env: [{ name: 'SEARCH_KEY', secret: true }] });
  expect(found[0]?.values).toEqual({ 'env:SEARCH_KEY': 'k-1' });
  expect(found[1]?.entry).toMatchObject({ kind: 'remote', url: 'https://feed.example.com/mcp', headers: [{ name: 'X-Team', secret: true }] });
});

it("reads Cursor's servers, an SSE address too", () => {
  expect(cursorServers(CURSOR).map((one) => [one.key, one.entry.kind])).toEqual([
    ['Cursor:linear', 'remote'],
    ['Cursor:local', 'local'],
  ]);
});

it('imports the picked servers off everywhere, secrets to the keychain, plain only where marked', async () => {
  const keychain = fakeKeychain();
  const before = readFileSync(join(home, '.claude.json'), 'utf8');
  expect(findImports(home, project)).toHaveLength(6);

  expect(await importServers(db, keychain, home, ['Claude Code:db', 'Codex:feed'], ['Claude Code:db|env:LEVEL'], 4)).toBeNull();
  const list = readMcpList(project).servers;
  expect(list.map((one) => one.name)).toEqual(['db', 'feed']);
  expect(list[0]?.env).toEqual([{ name: 'DB_TOKEN', secret: true }, { name: 'LEVEL', secret: false, value: '1' }]);
  expect(list.every((one) => one.phases.length === 0)).toBe(true);
  const file = readFileSync(join(project, MCP_FILE), 'utf8');
  expect(file).not.toContain('hunter2');
  const named = (name: string) => list.find((one) => one.name === name) ?? emptyEntry();
  expect(await keychain.read(secretName(4, named('db'), { where: 'env', name: 'DB_TOKEN' }))).toBe('hunter2');
  expect(await keychain.read(secretName(4, named('feed'), { where: 'header', name: 'X-Team' }))).toBe('web');
  // Read only: the engine's own file is as it was.
  expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(before);

  // A name already in the list is refused with a sentence, and nothing else changes.
  expect(await importServers(db, keychain, home, ['Codex:search', 'Claude Code:db'], [], 4)).toBe("Claude Code's db was not imported. There is a server named db already.");
  expect(readMcpList(project).servers).toHaveLength(2);
  const search = findImports(home, project).find((one) => one.entry.name === 'search')?.entry ?? emptyEntry();
  expect(await keychain.read(secretName(4, search, { where: 'env', name: 'SEARCH_KEY' }))).toBeNull();
  expect(await importServers(db, keychain, home, [], [], 4)).toBe('Pick at least one server to import.');
});

// The list is committed for every teammate, so an address with a login in it does not come in.
it('refuses a server whose address holds a login', async () => {
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { leaky: { url: 'https://mcp.example.com/mcp?api_key=abc' } } }));
  expect(await importServers(db, fakeKeychain(), home, ['Cursor:leaky'], [], 4)).toMatch(/^Cursor's leaky was not imported\. The address of leaky holds api_key=/);
  expect(readMcpList(project).servers).toEqual([]);
});
