import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inFolder, mcpServerNames, mcpServers, writeMcpConfig } from './mcp-config.ts';

const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'));
afterEach(() => rmSync(join(dir, 'mcp.json'), { force: true }));

const config = (text: string) => {
  writeFileSync(join(dir, 'mcp.json'), text);
  return join(dir, 'mcp.json');
};

it('names the servers a config holds, and leaves out a name that reads as a pattern', () => {
  const path = config(JSON.stringify({ mcpServers: { playwright: {}, 'my_db-2': {}, 'a*': {}, 'b c': {} } }));
  expect(mcpServerNames(path)).toEqual(['playwright', 'my_db-2']);
});

it('names none for a file that is missing, does not parse or has no servers', () => {
  expect(mcpServerNames(join(dir, 'missing.json'))).toEqual([]);
  expect(mcpServerNames(config('{ not json'))).toEqual([]);
  expect(mcpServerNames(config('{"mcpServers": null}'))).toEqual([]);
});

it('reads each server as command, args and env, and skips one with no command', () => {
  const path = config(JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['a', 2], env: { HOME: '/tmp/h', N: 1 } }, url: { url: 'https://x' }, bare: { command: 'b' } } }));
  expect(mcpServers(path)).toEqual({
    playwright: { command: 'npx', args: ['a', '2'], env: { HOME: '/tmp/h', N: '1' } },
    bare: { command: 'b', args: [], env: {} },
  });
});

// Claude Code and Cursor take no folder for a server, so a shell starts it there. A relative path in its
// arguments then finds the file, as it does on Codex.
it('starts a server that names a folder in that folder, whatever the folder is called', () => {
  const folder = join(dir, 'tools #1 $HOME');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'server.js'), 'process.stdout.write(process.cwd())');
  const started = inFolder({ command: process.execPath, args: ['./server.js'], env: {} }, folder);

  const out = spawnSync(started.command, [...started.args], { cwd: tmpdir(), encoding: 'utf8' });
  expect(out.stderr).toBe('');
  expect(out.stdout).toBe(realpathSync(folder));
  expect(inFolder({ command: 'db-mcp', args: [], env: {} }, null)).toEqual({ command: 'db-mcp', args: [], env: {} });
});

it("writes Claude Code's config with each server started in its folder", () => {
  const path = join(dir, 'claude.json');
  writeMcpConfig(path, { db: { command: 'db-mcp', args: ['--stdio'], env: { LEVEL: '1' } }, notes: { command: 'notes-mcp', args: [], env: {} } }, {}, { db: { cwd: '/work/tools' }, notes: { cwd: null } });
  expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers).toEqual({
    db: { type: 'stdio', command: '/bin/sh', args: ['-c', 'cd "$0" && exec "$@"', '/work/tools', 'db-mcp', '--stdio'], env: { LEVEL: '1' } },
    notes: { type: 'stdio', command: 'notes-mcp', args: [], env: {} },
  });
});
