import { boardFor, policyFor } from '@nolzu/core';
import { BOARD_KINDS, type BoardKind, DELIVERY_PHASES, phaseLabel } from '@nolzu/protocol';

/**
 * A project's MCP servers, as the shared file in the workspace holds them.
 *
 * The file travels with the workspace through git, so it never holds a secret: an env value or a
 * header marked secret keeps its name here and its value in this machine's keychain. Every entry is
 * read as untrusted, the way `.nolzu/repositories.json` is, and a bad one is named rather than thrown.
 */

export const MCP_FILE = '.nolzu/mcp-servers.json';

// One env variable or header. `value` is there only when the value is plain.
export interface McpValue {
  name: string;
  secret: boolean;
  value?: string;
}

export type McpTransport = 'http' | 'sse';

export interface McpEntry {
  name: string;
  description: string;
  kind: 'local' | 'remote';
  // A local server: the program and its arguments, and an optional folder to start it in.
  command: string;
  args: string[];
  cwd: string;
  // A remote server: its address and how it speaks.
  url: string;
  transport: McpTransport;
  env: McpValue[];
  headers: McpValue[];
  // The tools a run may call. Empty is every tool of the server.
  tools: string[];
  // The phases this server is on for. Empty, the default, is off everywhere.
  phases: string[];
  // The keys of the row this version does not know, written back as they were.
  extra?: Record<string, unknown>;
}

// What a write keeps of the file besides the servers it read: the top-level keys it does not know and
// the rows it left out, so a save never drops what a newer Nolzu or a teammate wrote.
export interface McpRest {
  top: Record<string, unknown>;
  kept: unknown[];
}

// Env names Codex forwards from its own environment by the same name (`env_vars`), so a secret by one of
// these names would change the engine itself, or the agent's tools.
const RESERVED = new Set([
  'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'LANG', 'TERM',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'CURSOR_API_KEY',
]);
export const reservedName = (name: string): boolean => RESERVED.has(name.toUpperCase()) || /^(CODEX|NOLZU)_/i.test(name);

// Letters, digits, dash and underscore: the name goes into a tool name (`mcp__<name>__<tool>`) and a
// TOML key, and either would read anything else as a pattern or a path.
export const SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// A value lands in a config file and an environment, where a line break would start a new entry.
const PLAIN = /^[^\n\r\0]*$/;

export const emptyEntry = (): McpEntry => ({ name: '', description: '', kind: 'local', command: '', args: [], cwd: '', url: '', transport: 'http', env: [], headers: [], tools: [], phases: [] });

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function values(raw: unknown, leaked: string[]): McpValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row): McpValue[] => {
    if (typeof row !== 'object' || row === null) return [];
    const { name, secret, value } = row as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    // A shared file that carries a value beside `secret: true` gets the value dropped, never used, and
    // the page names it, since the value went to every teammate with the file.
    if (secret === true && value !== undefined) leaked.push(name);
    return secret === true ? [{ name, secret: true }] : [{ name, secret: false, value: text(value) }];
  });
}

const KNOWN = new Set(['name', 'description', 'kind', 'command', 'args', 'cwd', 'url', 'transport', 'env', 'headers', 'tools', 'phases']);

function entryOf(row: Record<string, unknown>, leaked: string[]): McpEntry {
  const kind = row.kind === 'remote' ? 'remote' : 'local';
  const extra = Object.fromEntries(Object.entries(row).filter(([key]) => !KNOWN.has(key)));
  return {
    ...emptyEntry(),
    name: text(row.name),
    description: text(row.description),
    kind,
    command: text(row.command),
    args: strings(row.args),
    cwd: text(row.cwd),
    url: text(row.url),
    transport: row.transport === 'sse' ? 'sse' : 'http',
    env: values(row.env, leaked),
    headers: kind === 'remote' ? values(row.headers, leaked) : [],
    tools: strings(row.tools),
    phases: strings(row.phases),
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

export interface McpList {
  servers: McpEntry[];
  problems: string[];
  // A sentence when the file as a whole cannot be read, such as a git conflict in it. Nolzu then
  // writes nothing, because a write would replace what it could not read.
  broken: string | null;
  rest: McpRest;
}

/** The servers of the file, and one sentence for each entry left out. No file is no server. */
export function parseMcpList(file: string | null): McpList {
  const none = (broken: string | null): McpList => ({ servers: [], problems: broken === null ? [] : [broken], broken, rest: { top: {}, kept: [] } });
  if (file === null) return none(null);
  if (/^(<{7}|={7}|>{7})( |$)/m.test(file)) return none(`${MCP_FILE} holds a git conflict, so Nolzu reads no server from it and writes nothing to it. Settle the conflict in the file and commit it.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(file);
  } catch {
    return none(`${MCP_FILE} is not JSON, so Nolzu reads no server from it and writes nothing to it. Fix the file or delete it.`);
  }
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as { servers?: unknown }).servers : undefined;
  if (!Array.isArray(list)) return none(`${MCP_FILE} has no list of servers, so Nolzu reads no server from it and writes nothing to it. Fix the file or delete it.`);
  const top = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([key]) => key !== 'servers'));
  const servers: McpEntry[] = [];
  const problems: string[] = [];
  const kept: unknown[] = [];
  for (const [index, row] of list.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      problems.push(`Entry ${index + 1} of ${MCP_FILE} is not a server. Nolzu keeps it in the file as it is.`);
      kept.push(row);
      continue;
    }
    const leaked: string[] = [];
    const entry = entryOf(row as Record<string, unknown>, leaked);
    const problem = entryProblem(entry, servers);
    if (problem !== null) {
      problems.push(`Entry ${index + 1} of ${MCP_FILE} is left out and kept in the file as it is. ${problem}`);
      kept.push(row);
      continue;
    }
    servers.push(entry);
    for (const name of leaked) problems.push(`${MCP_FILE} holds a value for the secret ${name} of ${entry.name}, which every teammate gets with the file. Nolzu ignores it and leaves it out of the next save; change that secret where it was issued.`);
  }
  return { servers, problems, broken: null, rest: { top, kept } };
}

const valueRows = (list: readonly McpValue[]) => list.map((one) => (one.secret ? { name: one.name, secret: true } : { name: one.name, value: one.value ?? '' }));

/** The file for these servers, with what the file held besides them. A secret value is never written. */
export function mcpListText(servers: readonly McpEntry[], rest: McpRest = { top: {}, kept: [] }): string {
  const rows = servers.map((entry) => ({
    ...entry.extra,
    name: entry.name,
    ...(entry.description === '' ? {} : { description: entry.description }),
    kind: entry.kind,
    ...(entry.kind === 'local'
      ? { command: entry.command, args: entry.args, ...(entry.cwd === '' ? {} : { cwd: entry.cwd }) }
      : { url: entry.url, transport: entry.transport, headers: valueRows(entry.headers) }),
    env: valueRows(entry.env),
    tools: entry.tools,
    phases: entry.phases,
  }));
  return `${JSON.stringify({ ...rest.top, servers: [...rows, ...rest.kept] }, null, 2)}\n`;
}

function valuesProblem(list: readonly McpValue[], what: string, pattern: RegExp): string | null {
  const seen = new Set<string>();
  for (const one of list) {
    if (!pattern.test(one.name)) return `The ${what} name ${JSON.stringify(one.name)} holds a character a config cannot take.`;
    const key = one.name.toLowerCase();
    if (seen.has(key)) return `The ${what} ${one.name} is there twice.`;
    seen.add(key);
    if (!one.secret && !PLAIN.test(one.value ?? '')) return `The ${what} ${one.name} holds a line break.`;
    if (one.secret && what === 'variable' && reservedName(one.name)) return `${one.name} cannot be a secret, because an engine reads it for itself too. Make it plain.`;
  }
  return null;
}

/** Why an entry cannot be kept, or null. `others` are the servers it sits beside. */
export function entryProblem(entry: McpEntry, others: readonly McpEntry[]): string | null {
  if (!SERVER_NAME.test(entry.name)) return 'A server name holds letters, digits, - and _ only, at most 64 of them, and does not start with -.';
  if (others.some((other) => other.name.toLowerCase() === entry.name.toLowerCase())) return `There is a server named ${entry.name} already.`;
  if (!PLAIN.test(entry.description) || entry.description.length > 200) return 'A description is one line of at most 200 characters.';
  if (entry.kind === 'local') {
    if (entry.command.trim() === '') return `${entry.name} has no command to start.`;
    if (entry.command.startsWith('-')) return `The command of ${entry.name} starts with a dash, which reads as an option.`;
    if (![entry.command, entry.cwd, ...entry.args].every((one) => PLAIN.test(one))) return `The command of ${entry.name} holds a line break.`;
  } else {
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      return `${entry.name} needs a full address, such as https://mcp.example.com/mcp.`;
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      return `The address of ${entry.name} starts with https://, or http:// for this machine only.`;
    }
    // The shared file goes to every teammate, so a password in the address would go with it.
    if (url.username !== '' || url.password !== '') return `The address of ${entry.name} holds a user name or a password. Put the login in a secret header instead.`;
  }
  const problem = valuesProblem(entry.env, 'variable', ENV_NAME) ?? valuesProblem(entry.headers, 'header', HEADER_NAME);
  if (problem !== null) return problem;
  const bad = entry.tools.find((tool) => !TOOL_NAME.test(tool));
  if (bad !== undefined) return `The tool name ${JSON.stringify(bad)} holds a character a tool name cannot have.`;
  const phase = entry.phases.find((one) => !(DELIVERY_PHASES as readonly string[]).includes(one));
  if (phase !== undefined) return `There is no phase ${JSON.stringify(phase)}.`;
  return null;
}

// Where a secret sits in the entry, which together with the server and the project names its keychain
// entry.
export interface SecretKey {
  where: 'env' | 'header';
  name: string;
}

export const secretKeysOf = (entry: McpEntry): SecretKey[] => [
  ...entry.env.filter((one) => one.secret).map((one) => ({ where: 'env' as const, name: one.name })),
  ...entry.headers.filter((one) => one.secret).map((one) => ({ where: 'header' as const, name: one.name })),
];

/**
 * The columns of the grid: each phase of the boards that are on, once, in board order. Feedback is a
 * stage of no board and runs from a Delivery card, which is always on.
 */
export function gridPhases(offBoards: readonly BoardKind[]): { phase: string; label: string; readOnly: boolean }[] {
  const on = BOARD_KINDS.filter((kind) => kind === 'delivery' || !offBoards.includes(kind));
  const phases = new Set(on.flatMap((kind) => boardFor(kind, 'pull-request').stages.flatMap((stage) => (stage.phase === undefined ? [] : [stage.phase]))));
  phases.add('feedback');
  return DELIVERY_PHASES.filter((phase) => phases.has(phase)).map((phase) => ({ phase, label: phaseLabel(phase), readOnly: policyFor(phase).readOnly }));
}

// Query keys that carry a login, which the shared file would hand to every teammate.
const LOGIN_KEYS = /^(api[-_]?key|key|token|access[-_]?token|auth|secret|password|pass|sig|signature|client[-_]?secret)$/i;

/** A sentence when a remote server's address holds a key that looks like a login, or null. */
export function urlWarning(entry: McpEntry): string | null {
  if (entry.kind !== 'remote') return null;
  try {
    const found = [...new URL(entry.url).searchParams.keys()].find((key) => LOGIN_KEYS.test(key));
    return found === undefined ? null : `The address of ${entry.name} holds ${found}=, which looks like a login and goes to every teammate with the file. Move it into a secret header if the server takes one.`;
  } catch {
    return null;
  }
}

/** The read-only phases a server with no tool list is on for. Its tools may change things outside the wall there. */
export const unlimitedReadOnly = (entry: McpEntry): string[] => (entry.tools.length > 0 ? [] : entry.phases.filter((phase) => policyFor(phase).readOnly));

/** The servers a run of this phase is handed, as the file lists them. */
export const serversFor = (servers: readonly McpEntry[], phase: string): McpEntry[] => servers.filter((entry) => entry.phases.includes(phase));
