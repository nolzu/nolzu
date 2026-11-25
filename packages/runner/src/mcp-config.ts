import { accessSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs';

// One stdio server of a config, as each engine's own config format takes it.
export interface McpServer {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

/**
 * A server that names its folder, started in it. Claude Code's and Cursor's configs take no folder, so
 * a shell changes into it and then becomes the server; Codex takes the folder itself (`codexMcp`).
 * Without this both engines start the server in the card's checkout, where a relative path finds nothing.
 */
export const inFolder = (server: McpServer, cwd: string | null | undefined): McpServer =>
  cwd == null ? server : { ...server, command: '/bin/sh', args: ['-c', 'cd "$0" && exec "$@"', cwd, server.command, ...server.args] };

// Claude Code's config for one attempt, in its own format. Mode 600, because it holds the secret
// values, and written into the run's folder, from where the spawn removes it once the engine read it.
export function writeMcpConfig(
  path: string,
  stdio: Readonly<Record<string, McpServer>>,
  remote: Readonly<Record<string, McpRemote>>,
  rules: Readonly<Record<string, { cwd: string | null }>> = {},
): void {
  const servers = {
    ...Object.fromEntries(Object.entries(stdio).map(([name, server]) => [name, { type: 'stdio', ...inFolder(server, rules[name]?.cwd) }])),
    ...Object.fromEntries(Object.entries(remote).map(([name, server]) => [name, { type: server.transport, url: server.url, headers: server.headers }])),
  };
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The stdio servers a config holds, by name. A name an engine could read as a pattern or a key path
 * is left out, and so is a server with no command, which only Claude Code can start. A file that
 * does not parse gives none: Claude Code refuses to start on it and says why, and the other engines
 * then run without a browser.
 */
export function mcpServers(path: string): Record<string, McpServer> {
  let servers: unknown;
  try {
    servers = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }).mcpServers;
  } catch {
    return {};
  }
  if (typeof servers !== 'object' || servers === null) return {};
  const found: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(servers as Record<string, { command?: unknown; args?: unknown; env?: unknown }>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof server?.command !== 'string') continue;
    const env = typeof server.env === 'object' && server.env !== null ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value)])) : {};
    found[name] = { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env };
  }
  return found;
}

// One remote server of a config: its address, `http` (streamable HTTP) or `sse`, and its headers.
export interface McpRemote {
  url: string;
  transport: 'http' | 'sse';
  headers: Readonly<Record<string, string>>;
}

/** The remote servers a config holds, by name, read the way `mcpServers` reads the stdio ones. */
export function mcpRemotes(path: string): Record<string, McpRemote> {
  let servers: unknown;
  try {
    servers = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }).mcpServers;
  } catch {
    return {};
  }
  if (typeof servers !== 'object' || servers === null) return {};
  const found: Record<string, McpRemote> = {};
  for (const [name, server] of Object.entries(servers as Record<string, { type?: unknown; url?: unknown; headers?: unknown; command?: unknown }>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof server?.url !== 'string' || typeof server.command === 'string') continue;
    const headers = typeof server.headers === 'object' && server.headers !== null ? Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, String(value)])) : {};
    found[name] = { url: server.url, transport: server.type === 'sse' ? 'sse' : 'http', headers };
  }
  return found;
}

/**
 * The server names a config holds, which a Claude Code run allows by name. Every server counts here,
 * an http one with no command too, because Claude Code starts those itself.
 */
export function mcpServerNames(path: string): string[] {
  try {
    const servers = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== 'object' || servers === null) return [];
    return Object.keys(servers).filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
  } catch {
    return [];
  }
}

/**
 * The sentence that refuses a browser config, or null when the file can be read.
 *
 * Asked before a QA run starts, and the run is refused rather than started without a browser. A
 * verdict from a run whose browser never came up says nothing about the pages the card changed,
 * and nobody reading PASS would know a browser was missing. It is the rule the stack load follows:
 * when the thing QA checks against is not there, say so instead of checking against nothing.
 */
export function mcpConfigProblem(path: string): string | null {
  try {
    // A folder passes the access check below, so it is asked about first. A setting left at
    // `/home/you/.nolzu/` would otherwise start QA with a config the engine cannot load.
    if (!statSync(path).isFile()) {
      return `The browser config at ${path} is a folder, not a file. Point the browser setting at the config file inside it.`;
    }
    accessSync(path, constants.R_OK);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return `There is no browser config at ${path}. QA needs it to start a browser, so point the browser setting at the file, or clear the setting to check this project without one.`;
    }
    return `The browser config at ${path} cannot be read (${code ?? 'unknown error'}). Check that it is a file this machine may read.`;
  }
}
