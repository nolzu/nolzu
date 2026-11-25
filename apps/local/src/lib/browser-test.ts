import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_WALLS, HIDDEN_FOR_EVERY_RUN, HIDDEN_ON, mcpConfigProblem, walledCommand, type WallPort, type WallSpec } from '@nolzu/runner';

/**
 * Test the browser: start the config's first server the way a QA run does, inside the wall, and ask
 * it to open a page.
 *
 * A QA run starts the engine in the wall and the engine starts the server, so the server inherits it.
 * Here Nolzu starts the server itself in a wall that opens the temp folder only, which is all a QA
 * run's wall leaves writable outside the card's copy. The answer is one sentence for the row.
 */

export interface BrowserTestOptions {
  // Passed by a test, which starts a fake server. It gets `detached: true`, and the kill reaches its group.
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  wall?: WallPort;
  timeoutMs?: number;
}

export type BrowserTest = { passed: boolean; said: string };

/**
 * The wall a server Nolzu starts itself runs in, as a run's wall leaves it: the temp folder is all that
 * is writable outside a card's copy, and the logins, the browser profiles and the history files are
 * hidden. The browser test and the MCP probe both start their server in it.
 */
export function serverWall(): WallSpec {
  const home = homedir();
  const system = process.platform === 'linux' ? 'linux' : 'darwin';
  const hidden = [...HIDDEN_FOR_EVERY_RUN, ...HIDDEN_ON[system], ...Object.values(ENGINE_WALLS).flatMap((row) => row.logins)].map((path) => join(home, path.slice(2)));
  return { writable: [tmpdir()], hidden, writeDenied: [], envRoots: [], envExceptions: [] };
}

// The first run downloads the server with npx, which takes most of this.
const TIMEOUT_MS = 120_000;
const PROTOCOL = '2025-06-18';

interface Server {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function firstServer(path: string): Server | string {
  const problem = mcpConfigProblem(path);
  if (problem !== null) return problem;
  try {
    const servers = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, Partial<Server>> }).mcpServers ?? {};
    const server = Object.values(servers)[0];
    if (typeof server?.command !== 'string') return `The browser config at ${path} names no server with a command.`;
    return { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: server.env ?? {} };
  } catch {
    return `The browser config at ${path} is not JSON the engine can read.`;
  }
}

// The line of an npm or a Node failure that says what went wrong, such as npm's EPERM line with the
// path it could not write. npm ends with advice and where its log is, which say less.
const tellingLine = (stderr: string): string => {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const code = lines.find((line) => line.startsWith('npm error code '));
  if (code !== undefined) {
    const path = lines.find((line) => line.startsWith('npm error path '))?.slice('npm error '.length);
    return path === undefined ? code : `${code} (${path})`;
  }
  return lines.find((line) => /Error:/.test(line)) ?? lines.at(-1) ?? '';
};

// The first line that says something. The Playwright server starts its answers with a Markdown heading.
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#')) ?? '';

export async function testBrowser(configPath: string, options: BrowserTestOptions = {}): Promise<BrowserTest> {
  const server = firstServer(configPath);
  if (typeof server === 'string') return { passed: false, said: server };

  const folder = mkdtempSync(join(tmpdir(), 'nolzu-browser-test-'));
  const page = join(folder, 'page.html');
  writeFileSync(page, '<!doctype html><title>Nolzu browser test</title><p>The browser works.</p>\n');
  const walled = (options.wall ?? walledCommand)(serverWall(), server.command, server.args);
  // Where the wall cannot start, a read-only Claude Code run goes on unwalled, so the test does too.
  const outside = 'refused' in walled ? walled.refused : null;
  const command = 'refused' in walled ? { command: server.command, args: server.args } : walled;

  const started = Date.now();
  const child = (options.spawn ?? spawn)(command.command, command.args, { cwd: folder, detached: true, env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-8000)));
  const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
  child.stdin?.on('error', () => {});

  const answer = await new Promise<BrowserTest>((done) => {
    const fail = (why: string) => done({ passed: false, said: `The browser did not open a page: ${why}` });
    const timer = setTimeout(() => fail(`no answer in ${Math.ceil((options.timeoutMs ?? TIMEOUT_MS) / 1000)} s.${stderr.trim() === '' ? '' : ` ${tellingLine(stderr)}`}`), options.timeoutMs ?? TIMEOUT_MS);
    const end = (result: BrowserTest | string) => {
      clearTimeout(timer);
      if (typeof result === 'string') fail(result);
      else done(result);
    };
    child.on('error', (error) => end(error.message));
    child.on('exit', (code) => end(tellingLine(stderr) || `the server stopped with exit code ${code ?? 'none'} before it answered.`));
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        let message: { id?: unknown; error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error !== undefined && (message.id === 1 || message.id === 2)) end(firstLine(message.error.message ?? 'the server refused the call.'));
        else if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: `file://${page}` } } });
        } else if (message.id === 2) {
          if (message.result?.isError) end(firstLine(message.result.content?.map((part) => part.text ?? '').join('\n') ?? '') || 'the server refused to open the page.');
          else {
            const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
            end({ passed: true, said: outside === null ? `The browser opened a page inside the wall in ${seconds} s.` : `The browser opened a page in ${seconds} s, outside the wall. ${outside}` });
          }
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'nolzu', version: '0' } } });
  });

  // The whole group, so npx's children go too. The browser leads a group of its own and closes when
  // the server's pipe to it does.
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
