import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting } from '@nolzu/core/node';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported. The login item is bound to a temp home and a nolzu command, so no run of this
// test can reach the real LaunchAgents or ~/.config folder.
const data = mkdtempSync(join(tmpdir(), 'nolzu-login-route-'));
const home = mkdtempSync(join(tmpdir(), 'nolzu-login-route-home-'));
process.env.NOLZU_DATA_DIR = data;
let platform = 'darwin';
const changed = vi.fn();
vi.mock('$lib/loop.ts', () => ({ loop: () => ({ changed }) }));
vi.mock('$lib/start-at-login.ts', async (real) => {
  const login = await real<typeof import('$lib/start-at-login.ts')>();
  return {
    ...login,
    systemLoginItem: () => login.systemLoginItem(platform, home, ['/opt/node', '/opt/nolzu/bin/nolzu.js'], '/opt/node'),
    turnOffAtLogin: () => login.turnOffAtLogin(platform, home),
  };
});

const { POST } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const { loginItemPath, loginSwitch } = await import('$lib/start-at-login.ts');
const post = POST as unknown as (event: { request: Request }) => Promise<Response>;
const send = (body: unknown) => post({ request: new Request('http://localhost/api/login-item', { method: 'POST', body: JSON.stringify(body) }) });

afterAll(() => {
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => changed.mockClear());

// The rail's Turn on and the switch's On reach one writer, and the switch's Off removes what it wrote.
it.each(['darwin', 'linux'])('writes the %s item on the rail press and the switch, and the switch removes it', async (system) => {
  platform = system;
  const path = loginItemPath(system, home) ?? '';

  // The rail's Turn on posts `{}` (GettingStarted.svelte), so that body must mean On.
  expect((await send({})).status).toBe(200);
  expect(existsSync(path)).toBe(true);
  expect(getSetting(database(), 'seenNotes')).toContain('start-at-login');
  expect(changed).toHaveBeenCalledTimes(1);

  expect((await send({ on: false })).status).toBe(200);
  expect(existsSync(path)).toBe(false);
  expect(loginSwitch(system, home, []).on).toBe(false);

  expect((await send({ on: true })).status).toBe(200);
  expect(loginSwitch(system, home, ['/opt/node', '/opt/nolzu/bin/nolzu.js']).on).toBe(true);
  expect((await send({ on: false })).status).toBe(200);
  expect(existsSync(path)).toBe(false);
});
