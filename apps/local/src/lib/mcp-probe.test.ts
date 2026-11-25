import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Keychain } from '@nolzu/runner';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyEntry, type McpEntry } from './mcp-list.ts';
import { probeEntry } from './mcp-probe.ts';
import { secretName } from './mcp-store.ts';

// The fake stdio server of the fixtures: it answers, exits with an error, or never answers, by FAKE_MODE.
const SERVER = join(import.meta.dirname, '..', '..', 'fixtures', 'mcp-server.mjs');
const SECRET = 'sk-test-4be2f1';

const keychain = (held: Record<string, string> = {}): Keychain => ({
  read: async (name) => held[name] ?? null,
  write: async () => undefined,
  remove: async () => undefined,
});
const local = (mode: string, over: Partial<McpEntry> = {}): McpEntry => ({ ...emptyEntry(), name: 'recipes', command: 'recipes-mcp', args: ['--stdio'], env: [{ name: 'FAKE_MODE', secret: false, value: mode }], ...over });

// The wall's command is recorded, and the fake server runs instead, with the options the probe hands it.
function seams() {
  const walls: { writable: string[]; command: string }[] = [];
  const started: { cwd: unknown; detached: unknown }[] = [];
  return {
    walls,
    started,
    options: {
      wall: (spec: { writable: string[] }, command: string, args: readonly string[]) => {
        walls.push({ writable: spec.writable, command });
        return { command, args: [...args] };
      },
      spawn: (_command: string, _args: readonly string[], options: object) => {
        started.push(options as { cwd: unknown; detached: unknown });
        return spawn(process.execPath, [SERVER], options);
      },
    },
  };
}

const run = (entry: McpEntry, options: object, held: Record<string, string> = {}) => probeEntry(entry, { project: null, projectId: 1, keychain: keychain(held) }, options);

describe('a local server', () => {
  it('starts it inside the wall, lists every page of its tools, and says so', async () => {
    const { walls, started, options } = seams();

    expect(await run(local('answer'), options)).toEqual({ ok: true, tools: ['search_recipes', 'read_recipe', 'list_menus'], said: 'Started, 3 tools: search_recipes, read_recipe, list_menus.' });
    expect(walls).toHaveLength(1);
    expect(walls[0]?.command).toBe('recipes-mcp');
    expect(started[0]?.detached).toBe(true);
  });

  it("says the server's own words when it stops before it answers", async () => {
    const said = (await run(local('exit'), seams().options)).said;

    expect(said).toBe('The server stopped with exit code 3 before it answered. It said: Error: the database at postgres://localhost/recipes refused the connection');
  });

  // Node ends a crash with the stack, `requireStack: []` and its version. The line that says why comes first.
  it("shows Node's error line, and says why a relative path found nothing", async () => {
    const { options } = seams();
    const node: object = { ...options, spawn: (_command: string, args: readonly string[], spawnOptions: object) => spawn(process.execPath, [...args], spawnOptions) };
    const entry = local('', { command: 'node', args: ['./tools/server.js'], env: [] });

    const loose = (await run(entry, node)).said;
    expect(loose).toMatch(/^The server stopped with exit code 1 before it answered\. It said: Error: Cannot find module '\S*\/tools\/server\.js'/);
    expect(loose).toMatch(/Test starts it in an empty folder, and a run in the card's checkout\. Set Folder, or give a full path\.$/);
    expect(loose).not.toContain('requireStack');

    const placed = (await probeEntry({ ...entry, cwd: '.' }, { project: import.meta.dirname, projectId: 1, keychain: keychain() }, node)).said;
    expect(placed).toContain(`Cannot find module '${join(import.meta.dirname, 'tools', 'server.js')}'`);
    expect(placed).not.toContain('Set Folder');
  });

  it('gives up on a server that never answers', async () => {
    expect(await run(local('hang'), { ...seams().options, timeoutMs: 400 })).toEqual({ ok: false, said: 'No answer in 1 s.' });
  });

  // The server prints what it was handed, as some do. The secret comes from the keychain and never out.
  it('hands the server its secret from the keychain, and never shows it', async () => {
    const entry = local('hang', { env: [{ name: 'FAKE_MODE', secret: false, value: 'hang' }, { name: 'FAKE_ECHO', secret: true }] });
    const said = (await run(entry, { ...seams().options, timeoutMs: 400 }, { [secretName(1, entry, { where: 'env', name: 'FAKE_ECHO' })]: SECRET })).said;

    expect(said).toContain('starting with key •••');
    expect(said).not.toContain(SECRET);
  });

  it('starts nothing without a secret it needs, outside the wall, or with no such command', async () => {
    const { started, options } = seams();
    const entry = local('answer', { env: [{ name: 'TOKEN', secret: true }] });
    expect((await run(entry, options)).said).toBe('This machine has no secret TOKEN for recipes, so it was not started. Enter it first.');

    const outside = await run(local('answer'), { ...options, wall: () => ({ refused: 'bwrap is not installed.' }) });
    expect(outside).toEqual({ ok: false, said: 'Nolzu starts a server only inside the wall a run uses, and the wall cannot start here. bwrap is not installed.' });
    expect(started).toEqual([]);

    expect(await run(local('answer', { command: 'no-such-mcp-server-x9' }), {})).toEqual({ ok: false, said: 'Command not found: no-such-mcp-server-x9. Install it, or give its full path.' });
  });
});

describe('a remote server', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((done) => (server === null ? done() : server.close(() => done()))));
  const listen = async (handle: (request: IncomingMessage, body: string, response: ServerResponse) => void) => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => handle(request, body, response));
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/mcp`;
  };
  const remote = (url: string, transport: 'http' | 'sse' = 'http'): McpEntry => ({ ...emptyEntry(), name: 'docs', kind: 'remote', url, transport, headers: [{ name: 'Authorization', secret: true }] });
  // Kept under the server as it points now, so the name follows the address.
  const held = (entry: McpEntry) => ({ [secretName(1, entry, { where: 'header', name: 'Authorization' })]: `Bearer ${SECRET}` });

  // Streamable HTTP: a JSON answer, a stream answer, the session id on every later post, and the end.
  it('lists the tools over HTTP with the header from the keychain, and ends its session', async () => {
    const seen: string[] = [];
    const url = await listen((request, body, response) => {
      seen.push(`${request.method} ${request.headers.authorization === `Bearer ${SECRET}` ? 'auth' : 'no auth'} ${request.headers['mcp-session-id'] ?? '-'}`);
      if (request.method === 'DELETE') return response.writeHead(200).end();
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method === 'initialize') return response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      if (message.id === undefined) return response.writeHead(202).end();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search_docs' }] } })}\n\n`);
    });

    expect(await run(remote(url), {}, held(remote(url)))).toEqual({ ok: true, tools: ['search_docs'], said: 'Started, 1 tool: search_docs.' });
    expect(seen).toEqual(['POST auth -', 'POST auth s1', 'POST auth s1', 'DELETE auth s1']);
  });

  it("says the server's answer when it refuses, with the secret taken out", async () => {
    const url = await listen((request, _body, response) => response.writeHead(401, 'Unauthorized').end(`bad token ${String(request.headers.authorization)}`));

    const said = (await run(remote(url), {}, held(remote(url)))).said;
    expect(said).toBe('The server answered 401 Unauthorized. It said: bad token •••');
  });

  // The older SSE transport: the stream names where to post, and the answers come on the stream.
  it('lists the tools over the older SSE transport', async () => {
    let stream: ServerResponse | null = null;
    const url = await listen((request, body, response) => {
      if (request.method === 'GET') {
        stream = response;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: endpoint\ndata: /messages?session=7\n\n');
        return;
      }
      response.writeHead(202).end();
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) return;
      const result = message.method === 'initialize' ? {} : { tools: [{ name: 'fetch_page' }, { name: 'search' }] };
      stream?.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
    });

    expect(await run(remote(url, 'sse'), {}, held(remote(url, 'sse')))).toEqual({ ok: true, tools: ['fetch_page', 'search'], said: 'Started, 2 tools: fetch_page, search.' });
  });

  it('says it could not reach an address nothing answers on', async () => {
    const said = (await run(remote('http://127.0.0.1:9/mcp'), {}, held(remote('http://127.0.0.1:9/mcp')))).said;
    expect(said).toMatch(/^Nolzu could not reach 127\.0\.0\.1:9/);
  });

  it('gives up on a server that never answers', async () => {
    const url = await listen(() => undefined);
    expect(await run(remote(url), { timeoutMs: 300 }, held(remote(url)))).toEqual({ ok: false, said: 'No answer in 1 s.' });
  });
});
