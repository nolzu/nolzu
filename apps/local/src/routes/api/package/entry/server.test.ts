import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// A package loads only while the cloud is open (`packages/protocol/src/soon.ts`). This file pins the
// route kept for then, and cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

// The route reads the data directory from the environment, so it is pointed at a temp one before
// the module is imported. Not fake mode: fake mode ignores NOLZU_DATA_DIR on purpose.
const data = mkdtempSync(join(tmpdir(), 'nolzu-package-route-'));
process.env.NOLZU_DATA_DIR = data;
const packages = join(data, 'packages');

const { GET } = await import('./+server.ts');
const get = GET as unknown as () => Response;

afterAll(() => rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

it('answers an empty module on a client with no package installed', async () => {
  const response = get();

  expect(response.status).toBe(200);
  // A module and not a 404, because the app imports this path on every start and a free client is
  // the normal case, not a fault.
  expect(await response.text()).toBe('export {};\n');
  expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  // An install flips the file under this same path.
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it('answers with the installed file', async () => {
  mkdirSync(packages, { recursive: true });
  writeFileSync(join(packages, 'pro-1.0.0.js'), 'export const id = "pro";\n');
  writeFileSync(join(packages, 'current'), 'pro-1.0.0.js');

  const response = get();

  expect(await response.text()).toBe('export const id = "pro";\n');
  expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
});

it('answers an empty module when the pointer names a file that is gone', async () => {
  writeFileSync(join(packages, 'current'), 'pro-9.9.9.js');

  expect(await get().text()).toBe('export {};\n');
});

it('answers an empty module when the pointer names a folder', async () => {
  mkdirSync(join(packages, 'pro-3.0.0.js'), { recursive: true });
  writeFileSync(join(packages, 'current'), 'pro-3.0.0.js');

  // Reading it throws. The browser gets the free client's module, because this path must answer on
  // every start.
  expect(await get().text()).toBe('export {};\n');
});
