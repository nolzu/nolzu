import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

// Pointed at a temp data folder before the import, as the route reads it from the environment. Not
// fake mode: fake mode ignores NOLZU_DATA_DIR on purpose.
const data = mkdtempSync(join(tmpdir(), 'nolzu-health-route-'));
process.env.NOLZU_DATA_DIR = data;

const { GET } = await import('./+server.ts');
const get = GET as unknown as () => Response;

afterAll(() => rmSync(data, { recursive: true, force: true }));

// A second start compares this with its own data folder, and opens the server only when they match.
it('names the data folder it serves', async () => {
  const response = get();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ dataDir: data });
  // Asked once per start, and the answer can change with the next server on the port.
  expect(response.headers.get('cache-control')).toBe('no-store');
});
