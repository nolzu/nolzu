import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { type Keychain, walledCommand, type WallPort } from '@nolzu/runner';
import { serverWall } from './browser-test.ts';
import { type McpEntry, type McpTransport, type McpValue, secretKeysOf } from './mcp-list.ts';
import { secretName, TMP_TOKEN } from './mcp-store.ts';

/**
 * The probe behind Test on Settings, MCP servers, and behind the tool list it fills: start the server
 * the way a run would, send initialize and tools/list, and stop it. Nothing else is called, so no tool
 * of the server runs. A local server starts only inside the wall a run uses, never outside it. The
 * answer is one sentence, with the tool names when it worked, and never holds a secret value: the
 * server's own words are shown with every secret it was handed taken out.
 */

export type Probe = { ok: true; tools: string[]; said: string } | { ok: false; said: string };

export interface ProbeOptions {
  // Passed by a test, which starts a fake server. It gets `detached: true`, and the kill reaches its group.
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  wall?: WallPort;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const TIMEOUT_MS = 15_000;
const PROTOCOL = '2025-06-18';
// A server that pages its tools without end is cut off here.
const MAX_PAGES = 20;
// The server's own words shown at most, from the end, where the reason usually is.
const TAIL_CHARS = 300;

const RELATIVE = ' The command names a relative path and the server has no folder: Test starts it in an empty folder, and a run in the card\'s checkout. Set Folder, or give a full path.';

// Thrown with the sentence the person reads.
class Refused extends Error {}

// The value shown in place of a secret.
const HIDDEN = '•••';
const redact = (text: string, secrets: readonly string[]): string => secrets.reduce((out, secret) => out.split(secret).join(HIDDEN), text);

// What the server said, cut short, with its secrets out: its last error line, else its last lines. Node
// ends a crash with the stack, `requireStack: []` and its version, so the reason sits above them.
const tail = (text: string, secrets: readonly string[]): string => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const said = redact(lines.filter((line) => line.includes('Error:')).at(-1) ?? lines.slice(-3).join(' '), secrets);
  return said.length > TAIL_CHARS ? `...${said.slice(-TAIL_CHARS)}` : said;
};

const toolsSaid = (tools: readonly string[]): string =>
  tools.length === 0 ? 'Started, and the server lists no tool.' : `Started, ${tools.length === 1 ? '1 tool' : `${tools.length} tools`}: ${tools.join(', ')}.`;

/**
 * The server of a saved row or of the form, with its secrets: the ones typed in the form first, the
 * keychain's for the rest. A secret this machine lacks stops the probe before anything starts.
 */
export async function probeEntry(
  entry: McpEntry,
  input: { project: string | null; projectId: number; keychain: Keychain; typed?: Readonly<Record<string, string>> },
  options: ProbeOptions = {},
): Promise<Probe> {
  const secrets: Record<string, string> = {};
  for (const key of secretKeysOf(entry)) {
    const where = `${key.where}:${key.name}`;
    let value = input.typed?.[where] ?? '';
    if (value === '') {
      try {
        value = (await input.keychain.read(secretName(input.projectId, entry, key))) ?? '';
      } catch (error) {
        return { ok: false, said: `The keychain could not be read for ${key.name}, so the server was not started. ${(error as Error).message}` };
      }
    }
    if (value === '') return { ok: false, said: `This machine has no secret ${key.name} for ${entry.name === '' ? 'this server' : entry.name}, so it was not started. Enter it first.` };
    secrets[where] = value;
  }
  const values = (where: 'env' | 'header', list: readonly McpValue[]) =>
    Object.fromEntries(list.map((one) => [one.name, one.secret ? (secrets[`${where}:${one.name}`] ?? '') : (one.value ?? '').replaceAll(TMP_TOKEN, tmpdir())]));
  const hide = Object.values(secrets);
  if (entry.kind === 'remote') return probeRemote({ url: entry.url, transport: entry.transport, headers: values('header', entry.headers) }, hide, options);
  const cwd = entry.cwd === '' ? null : isAbsolute(entry.cwd) ? entry.cwd : input.project === null ? null : join(input.project, entry.cwd);
  return probeLocal({ command: entry.command, args: entry.args, env: values('env', entry.env), cwd }, hide, options);
}

// The program a command names: a path as it is, else the first match on PATH that may run.
function found(command: string, cwd: string): boolean {
  const runs = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return runs(resolve(cwd, command));
  return (process.env.PATH ?? '').split(delimiter).some((folder) => folder !== '' && runs(join(folder, command)));
}

interface LocalServer {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string | null;
}

async function probeLocal(server: LocalServer, secrets: readonly string[], options: ProbeOptions): Promise<Probe> {
  if (server.command === '') return { ok: false, said: 'There is no command to start.' };
  if (server.cwd !== null && !existsSync(server.cwd)) return { ok: false, said: `The folder ${server.cwd} is not there, so the server was not started.` };
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-mcp-probe-'));
  const cwd = server.cwd ?? folder;
  if (options.spawn === undefined && !found(server.command, cwd)) {
    rmSync(folder, { recursive: true, force: true });
    return { ok: false, said: `Command not found: ${server.command}. Install it, or give its full path.` };
  }
  const walled = (options.wall ?? walledCommand)(serverWall(), server.command, server.args);
  if ('refused' in walled) {
    rmSync(folder, { recursive: true, force: true });
    return { ok: false, said: `Nolzu starts a server only inside the wall a run uses, and the wall cannot start here. ${walled.refused}` };
  }

  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  // With no folder a relative path starts nowhere useful: here in an empty folder, in a run in the card's checkout.
  const relative = server.cwd === null && [server.command, ...server.args].some((one) => one.startsWith('./') || one.startsWith('../'));
  const child = (options.spawn ?? spawn)(walled.command, walled.args, { cwd, detached: true, env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-8000)));
  child.stdin?.on('error', () => {});
  const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);

  const answer = await new Promise<Probe>((done) => {
    const timer = setTimeout(() => {
      const said = tail(stderr, secrets);
      done({ ok: false, said: `No answer in ${Math.ceil(timeoutMs / 1000)} s.${said === '' ? '' : ` The server said: ${said}`}` });
    }, timeoutMs);
    const end = (result: Probe) => {
      clearTimeout(timer);
      done(result);
    };
    child.on('error', (error: NodeJS.ErrnoException) =>
      end({ ok: false, said: error.code === 'ENOENT' ? `Command not found: ${server.command}. Install it, or give its full path.` : redact(error.message, secrets) }),
    );
    child.on('exit', (code) => {
      const said = tail(stderr, secrets);
      end({ ok: false, said: `The server stopped with exit code ${code ?? 'none'} before it answered.${said === '' ? '' : ` It said: ${said}`}${relative ? RELATIVE : ''}` });
    });
    const tools: string[] = [];
    let page = 0;
    const list = (cursor?: string) => {
      page += 1;
      send({ jsonrpc: '2.0', id: page + 1, method: 'tools/list', params: cursor === undefined ? {} : { cursor } });
    };
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          continue;
        }
        if (typeof message.id !== 'number') continue;
        if (message.error !== undefined) {
          end({ ok: false, said: `The server refused ${message.id === 1 ? 'to start' : 'to list its tools'}: ${redact(message.error.message ?? 'no reason given', secrets)}` });
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          list();
          continue;
        }
        tools.push(...toolNames(message.result));
        const cursor = message.result?.nextCursor;
        if (typeof cursor === 'string' && cursor !== '' && page < MAX_PAGES) list(cursor);
        else end({ ok: true, tools, said: toolsSaid(tools) });
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'nolzu', version: '0' } } });
  });

  // The whole group, so what the server started goes too.
  const closed = new Promise((gone) => (child.exitCode !== null || child.signalCode !== null ? gone(null) : child.once('close', gone)));
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Gone already.
  }
  await Promise.race([closed, new Promise((wait) => setTimeout(wait, 5000))]);
  rmSync(folder, { recursive: true, force: true });
  return answer;
}

interface RpcMessage {
  id?: unknown;
  error?: { message?: string };
  result?: { tools?: unknown; nextCursor?: unknown };
}

const toolNames = (result: RpcMessage['result']): string[] =>
  Array.isArray(result?.tools) ? result.tools.flatMap((tool: unknown) => (typeof (tool as { name?: unknown }).name === 'string' ? [(tool as { name: string }).name] : [])) : [];

// The events of a text/event-stream body, as they come.
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line === '') {
        if (data.length > 0) yield { event, data: data.join('\n') };
        event = 'message';
        data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
}

// The answer with this id among the events still to come.
async function answerIn(events: AsyncGenerator<{ event: string; data: string }>, id: number): Promise<RpcMessage> {
  for (let next = await events.next(); next.done !== true; next = await events.next()) {
    try {
      const message = JSON.parse(next.value.data) as RpcMessage;
      if (message.id === id) return message;
    } catch {
      // Not JSON-RPC, such as a ping.
    }
  }
  throw new Refused('The server closed the stream before it answered.');
}

interface RemoteServer {
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
}

async function probeRemote(server: RemoteServer, secrets: readonly string[], options: ProbeOptions): Promise<Probe> {
  if (server.url === '') return { ok: false, said: 'There is no address to reach.' };
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  // Every request and stream of the probe ends with it: at the answer, or at the timeout.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Refused(`No answer in ${Math.ceil(timeoutMs / 1000)} s.`)), timeoutMs);
  const host = (() => {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  })();
  const refusedBy = async (response: Response) => {
    const said = tail(await response.text().catch(() => ''), secrets);
    return new Refused(`The server answered ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}.${said === '' ? '' : ` It said: ${said}`}`);
  };
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'nolzu', version: '0' } } };
  const failed = (message: RpcMessage, what: string) => new Refused(`The server refused ${what}: ${redact(message.error?.message ?? 'no reason given', secrets)}`);
  try {
    const tools: string[] = [];
    if (server.transport === 'sse') {
      // The older SSE transport: a stream that names where to post, and every answer comes on the stream.
      const stream = await fetcher(server.url, { headers: { ...server.headers, accept: 'text/event-stream' }, signal: stop.signal });
      if (!stream.ok || stream.body === null) throw await refusedBy(stream);
      const events = sseEvents(stream.body);
      let endpoint: string | null = null;
      while (endpoint === null) {
        const next = await events.next();
        if (next.done === true) break;
        if (next.value.event === 'endpoint') endpoint = new URL(next.value.data, server.url).href;
      }
      if (endpoint === null) throw new Refused('The server closed the stream without saying where to post.');
      const post = async (message: object) => {
        const sent = await fetcher(endpoint ?? '', { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify(message), signal: stop.signal });
        if (!sent.ok) throw await refusedBy(sent);
      };
      await post(initialize);
      const started = await answerIn(events, 1);
      if (started.error !== undefined) throw failed(started, 'to start');
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      for (let page = 1, cursor: unknown = undefined; page <= MAX_PAGES; page += 1) {
        await post({ jsonrpc: '2.0', id: page + 1, method: 'tools/list', params: typeof cursor === 'string' ? { cursor } : {} });
        const listed = await answerIn(events, page + 1);
        if (listed.error !== undefined) throw failed(listed, 'to list its tools');
        tools.push(...toolNames(listed.result));
        cursor = listed.result?.nextCursor;
        if (typeof cursor !== 'string' || cursor === '') break;
      }
    } else {
      // Streamable HTTP: each message is a post, and its answer comes back as JSON or as a short stream.
      let session: string | null = null;
      const post = async (message: { jsonrpc: string; method: string; id?: number; params?: object }): Promise<RpcMessage | null> => {
        const sent = await fetcher(server.url, {
          method: 'POST',
          headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(session === null ? {} : { 'mcp-session-id': session }) },
          body: JSON.stringify(message),
          signal: stop.signal,
        });
        session = sent.headers.get('mcp-session-id') ?? session;
        if (!sent.ok) throw await refusedBy(sent);
        if (message.id === undefined) return null;
        if ((sent.headers.get('content-type') ?? '').includes('text/event-stream') && sent.body !== null) return answerIn(sseEvents(sent.body), message.id);
        const body = (await sent.json()) as RpcMessage | RpcMessage[];
        const answer = (Array.isArray(body) ? body : [body]).find((one) => one.id === message.id);
        if (answer === undefined) throw new Refused('The server answered with something that is not the answer it was asked for.');
        return answer;
      };
      const started = await post(initialize);
      if (started?.error !== undefined) throw failed(started ?? {}, 'to start');
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      for (let page = 1, cursor: unknown = undefined; page <= MAX_PAGES; page += 1) {
        const listed = await post({ jsonrpc: '2.0', id: page + 1, method: 'tools/list', params: typeof cursor === 'string' ? { cursor } : {} });
        if (listed?.error !== undefined) throw failed(listed ?? {}, 'to list its tools');
        tools.push(...toolNames(listed?.result));
        cursor = listed?.result?.nextCursor;
        if (typeof cursor !== 'string' || cursor === '') break;
      }
      // The session ends, as a client that is done ends it. Its answer changes nothing.
      if (session !== null) await fetcher(server.url, { method: 'DELETE', headers: { ...server.headers, 'mcp-session-id': session }, signal: stop.signal }).catch(() => undefined);
    }
    return { ok: true, tools, said: toolsSaid(tools) };
  } catch (error) {
    const why = stop.signal.aborted && stop.signal.reason instanceof Refused ? stop.signal.reason : error;
    if (why instanceof Refused) return { ok: false, said: why.message };
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { ok: false, said: `Nolzu could not reach ${host}${code === undefined ? '' : ` (${code})`}. ${redact((error as Error).message, secrets)}` };
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}
