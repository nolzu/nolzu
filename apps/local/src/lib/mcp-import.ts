import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting } from '@nolzu/core/node';
import type { Keychain } from '@nolzu/runner';
import { emptyEntry, entryProblem, type McpEntry, reservedName, secretKeysOf, SERVER_NAME, urlWarning } from './mcp-list.ts';
import { readMcpList, secretName, writeMcpList } from './mcp-store.ts';

/**
 * "Import from my engines" on Settings, MCP servers: the servers in the person's own engine configs,
 * read and never written. Every env value and header counts as a secret unless the person marks it
 * plain, so a value goes to the keychain and never into the shared file by default.
 */

export type ImportSource = 'Claude Code' | 'Codex' | 'Cursor';

// One server found, with its values apart from the entry, so the page never gets a value.
export interface Found {
  key: string;
  source: ImportSource;
  entry: McpEntry;
  values: Record<string, string>;
}

const pairs = (value: unknown): [string, string][] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value).map(([key, one]) => [key, String(one)]) : [];

// One server in the JSON shape Claude Code and Cursor share, or null when it names neither a command
// nor an address. Every value is a secret until the person says otherwise.
function fromJson(source: ImportSource, name: string, raw: unknown): Found | null {
  if (typeof raw !== 'object' || raw === null || !SERVER_NAME.test(name)) return null;
  const server = raw as Record<string, unknown>;
  const remote = typeof server.url === 'string' && typeof server.command !== 'string';
  if (!remote && typeof server.command !== 'string') return null;
  const env = pairs(server.env);
  const headers = remote ? pairs(server.headers) : [];
  const entry: McpEntry = {
    ...emptyEntry(),
    name,
    kind: remote ? 'remote' : 'local',
    command: remote ? '' : String(server.command),
    args: Array.isArray(server.args) ? server.args.map(String) : [],
    url: remote ? String(server.url) : '',
    transport: server.type === 'sse' ? 'sse' : 'http',
    // A name an engine reads for itself cannot be a secret (`reservedName`), so it comes in plain.
    env: env.map(([key]) => ({ name: key, secret: !reservedName(key) })),
    headers: headers.map(([key]) => ({ name: key, secret: true })),
  };
  return { key: `${source}:${name}`, source, entry, values: Object.fromEntries([...env.map(([key, value]) => [`env:${key}`, value]), ...headers.map(([key, value]) => [`header:${key}`, value])]) };
}

const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  const found = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === 'object' && found !== null && !Array.isArray(found) ? (found as Record<string, unknown>) : {};
};

/** `~/.claude.json`: its global servers, then those of this project's folder, which win on a name. */
export function claudeServers(text: string, project: string | null): Found[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const own = project === null ? {} : objectAt(objectAt(objectAt(parsed, 'projects'), resolve(project)), 'mcpServers');
  const all = { ...objectAt(parsed, 'mcpServers'), ...own };
  return Object.entries(all).flatMap(([name, raw]) => fromJson('Claude Code', name, raw) ?? []);
}

/** `~/.cursor/mcp.json`. */
export function cursorServers(text: string): Found[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return Object.entries(objectAt(parsed, 'mcpServers')).flatMap(([name, raw]) => fromJson('Cursor', name, raw) ?? []);
}

// One TOML value of the kinds a server table uses: a string, a number or boolean, an array of
// strings, or an inline table of strings. Anything else reads as undefined.
function tomlValue(text: string): unknown {
  const value = text.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value);
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    return [...value.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => (match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2]));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    return Object.fromEntries(
      [...value.slice(1, -1).matchAll(/(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)].map((match) => [
        match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2],
        match[3] !== undefined ? JSON.parse(`"${match[3]}"`) : match[4],
      ]),
    );
  }
  return undefined;
}

/**
 * `~/.codex/config.toml`: its `[mcp_servers.<name>]` tables and their `env` and `http_headers`
 * sub-tables, or the same as inline tables.
 *
 * Limit: a reader for the lines a server table holds, not all of TOML. A value spread over several
 * lines, such as a long array, reads as missing, and that server comes in without it. A TOML library
 * if people's configs show it.
 */
export function codexServers(text: string): Found[] {
  const tables = new Map<string, Record<string, unknown>>();
  let at: { name: string; part: string | null } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.([A-Za-z_]+))?\s*\]$/.exec(line);
    if (header !== null) {
      at = { name: header[1] ?? header[2] ?? '', part: header[3] ?? null };
      if (!tables.has(at.name)) tables.set(at.name, {});
      continue;
    }
    if (line.startsWith('[')) {
      at = null;
      continue;
    }
    const pair = /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*(.+)$/.exec(line);
    if (at === null || pair === null) continue;
    const key = pair[1] ?? pair[2] ?? '';
    const value = tomlValue(pair[3] ?? '');
    const table = tables.get(at.name) ?? {};
    if (at.part === null) table[key] = value;
    else table[at.part] = { ...objectAt(table, at.part), [key]: value };
    tables.set(at.name, table);
  }
  return [...tables].flatMap(([name, table]) => fromJson('Codex', name, { ...table, headers: table.http_headers }) ?? []);
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** What the three engines' own configs hold, read only. A file that is not there gives nothing. */
export function findImports(home: string, project: string | null): Found[] {
  const read = (path: string, parse: (text: string) => Found[]) => {
    const text = readText(join(home, path));
    return text === null ? [] : parse(text);
  };
  return [...read('.claude.json', (text) => claudeServers(text, project)), ...read('.codex/config.toml', codexServers), ...read('.cursor/mcp.json', cursorServers)];
}

/**
 * Adds the picked servers to the list, off everywhere. `plain` holds `<key>|env:NAME` or
 * `<key>|header:NAME` for each value the person marked plain; every other value goes to the keychain.
 * The files are read again here, so nothing the page sends becomes a value. The sentence it was
 * refused with, or null.
 */
export async function importServers(db: DatabaseSync, keychain: Keychain, home: string, picked: readonly string[], plain: readonly string[], projectId: number): Promise<string | null> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return 'This project has no folder, so there is nowhere to keep the list.';
  if (picked.length === 0) return 'Pick at least one server to import.';
  const found = findImports(home, project).filter((one) => picked.includes(one.key));
  const { servers, broken } = readMcpList(project);
  if (broken !== null) return broken;
  // Every server is checked before any secret is written, so a refusal leaves the keychain as it was.
  const added: { entry: McpEntry; values: Record<string, string> }[] = [];
  for (const one of found) {
    const isPlain = (where: string) => plain.includes(`${one.key}|${where}`);
    const mark = (where: 'env' | 'header', list: McpEntry['env']) =>
      list.map((value) => (!value.secret || isPlain(`${where}:${value.name}`) ? { name: value.name, secret: false, value: one.values[`${where}:${value.name}`] ?? '' } : { name: value.name, secret: true }));
    const entry = { ...one.entry, env: mark('env', one.entry.env), headers: mark('header', one.entry.headers) };
    // An address with a login in it would be committed for every teammate, so it does not come in.
    const problem = entryProblem(entry, [...servers, ...added.map((done) => done.entry)]) ?? urlWarning(entry);
    if (problem !== null) return `${one.source}'s ${one.entry.name} was not imported. ${problem}`;
    added.push({ entry, values: one.values });
  }
  try {
    for (const { entry, values } of added) {
      for (const key of secretKeysOf(entry)) await keychain.write(secretName(projectId, entry, key), values[`${key.where}:${key.name}`] ?? '');
    }
  } catch (error) {
    return (error as Error).message;
  }
  return writeMcpList(project, [...servers, ...added.map((done) => done.entry)]);
}
