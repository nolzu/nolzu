import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { testBrowser } from './browser-test.ts';

// Test the browser over a fake MCP server: a node script that answers the JSON-RPC lines the way the
// mode it is given says. The spawn runs it whatever command the wall made, so no wall starts here.

const SERVER = `const mode = process.env.FAKE_MODE;
if (mode === 'exit') {
  console.error('npm error code EPERM');
  console.error('npm error path /home/dev/.npm/_cacache');
  console.error('npm error A complete log of this run can be found in: /home/dev/.npm/_logs');
  process.exit(1);
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (mode === 'hang') continue;
    const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') answer({ protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake' } });
    if (message.method === 'tools/call') {
      if (mode === 'error') answer({ isError: true, content: [{ type: 'text', text: '### Error\\nChrome could not start' }] });
      else answer({ content: [{ type: 'text', text: 'opened ' + message.params.arguments.url }] });
    }
  }
});
`;

let dir = '';
let config = '';
let started: string[][] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-browser-test-fake-'));
  writeFileSync(join(dir, 'server.cjs'), SERVER);
  started = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const withMode = (mode: string) => {
  config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env: { FAKE_MODE: mode } } } }));
};

// The wall's command is recorded and the fake server runs instead, with the options the test hands it.
const fake = (command: string, args: readonly string[], options: object) => {
  started.push([command, ...args]);
  return spawn(process.execPath, [join(dir, 'server.cjs')], options);
};

const tempFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith('nolzu-browser-test-') && !name.startsWith('nolzu-browser-test-fake-'));

it('opens the page inside the wall and says how long it took', async () => {
  withMode('ok');
  const before = tempFolders();

  const tested = await testBrowser(config, { spawn: fake, wall: (_spec, command, args) => ({ command: '/usr/bin/sandbox-exec', args: ['-p', '(profile)', command, ...args] }) });

  expect(tested).toEqual({ passed: true, said: expect.stringMatching(/^The browser opened a page inside the wall in \d+ s\.$/) });
  expect(started).toEqual([['/usr/bin/sandbox-exec', '-p', '(profile)', 'npx', '@playwright/mcp@latest']]);
  // The page's folder goes after the test.
  expect(tempFolders()).toEqual(before);
});

it('opens only the temp folder for writes', async () => {
  withMode('ok');
  let writable: readonly string[] = [];

  await testBrowser(config, { spawn: fake, wall: (spec, command, args) => ((writable = spec.writable), { command, args: [...args] }) });

  expect(writable).toEqual([tmpdir()]);
});

it('runs unwalled where the wall cannot start, and says so', async () => {
  withMode('ok');

  const tested = await testBrowser(config, { spawn: fake, wall: () => ({ refused: 'bubblewrap is not installed.' }) });

  expect(tested.passed).toBe(true);
  expect(tested.said).toMatch(/outside the wall\. bubblewrap is not installed\.$/);
  expect(started).toEqual([['npx', '@playwright/mcp@latest']]);
});

it("refuses with the server's own error when it cannot open the page", async () => {
  withMode('error');

  expect(await testBrowser(config, { spawn: fake })).toEqual({ passed: false, said: 'The browser did not open a page: Chrome could not start' });
});

it('names the npm failure of a server that stops before it answers', async () => {
  withMode('exit');

  expect(await testBrowser(config, { spawn: fake })).toEqual({ passed: false, said: 'The browser did not open a page: npm error code EPERM (path /home/dev/.npm/_cacache)' });
});

it('gives up on a server that never answers, and stops it', async () => {
  withMode('hang');
  let pid: number | undefined;

  const tested = await testBrowser(config, {
    spawn: (command, args, options) => {
      const child = fake(command, args, options);
      pid = child.pid;
      return child;
    },
    timeoutMs: 300,
  });

  expect(tested).toEqual({ passed: false, said: 'The browser did not open a page: no answer in 1 s.' });
  expect(() => process.kill(pid!, 0)).toThrow();
});

it('refuses a config that is not there without starting anything', async () => {
  const tested = await testBrowser(join(dir, 'none.json'), { spawn: fake });

  expect(tested).toMatchObject({ passed: false, said: expect.stringContaining('There is no browser config at') });
  expect(started).toEqual([]);
  expect(existsSync(join(dir, 'none.json'))).toBe(false);
});
