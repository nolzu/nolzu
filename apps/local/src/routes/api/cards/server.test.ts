import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';

// gh stands in for the real one, so the test sees how the route asked for it and nothing reaches GitHub.
const gh = vi.hoisted(() => {
  const ISSUE = '{"data":{"t0":{"issueOrPullRequest":{"__typename":"Issue","number":12,"title":"Search by ingredient","body":"","state":"OPEN","url":"https://github.com/example/recipes/issues/12","parent":null}}}}';
  return { runner: vi.fn(() => async () => ({ code: 0, stdout: ISSUE, stderr: '' })) };
});
vi.mock('@nolzu/runner', async (real) => ({ ...(await real<object>()), ghRunner: gh.runner }));

const dir = mkdtempSync(join(tmpdir(), 'nolzu-cards-route-'));
const live = { db: openDatabase(dir), changed: () => {} };
writeSetting(live.db, 'localKeyPrefix', 'APP');
vi.mock('../../../lib/loop.ts', () => ({ loop: () => live }));

const { POST } = await import('./+server.ts');
const post = POST as unknown as (event: { request: Request }) => Promise<Response>;

afterAll(() => {
  live.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The route hands postCard no runner, so in the app every GitHub card is read through the one postCard
// builds. With no options it finds gh on the PATH of the person's login shell.
it('reads a GitHub reference through the gh of the login shell', async () => {
  gh.runner.mockClear();
  const body = JSON.stringify({ input: 'example/recipes#12', links: [], board: 'delivery' });

  const response = await post({ request: new Request('http://localhost/api/cards', { method: 'POST', body }) });

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ key: 'recipes#12', note: null });
  expect(gh.runner).toHaveBeenCalledWith();
});
