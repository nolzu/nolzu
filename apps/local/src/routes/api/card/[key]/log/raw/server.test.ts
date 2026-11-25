import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, startRun } from '@nolzu/core/node';
import { afterAll, expect, it } from 'vitest';

// The route opens the database of the data folder the environment names, so it points at a temp one
// before the module is imported.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-raw-route-'));
process.env.NOLZU_DATA_DIR = join(dir, 'data');
const { GET } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');

afterAll(() => {
  database().close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const run = (key: string, text: string) => {
  createCard(database(), { key, board: 'delivery', stage: 'plan', title: key });
  const logPath = join(dir, `${key}.ndjson`);
  writeFileSync(logPath, text);
  return startRun(database(), { cardKey: key, phase: 'plan', engine: 'fake', model: 'sonnet', effort: 'medium', sessionId: null, logPath, lane: null });
};

const raw = (key: string, id: number) =>
  (GET as unknown as (event: { params: { key: string }; url: URL; request: Request }) => Promise<Response>)({
    params: { key },
    url: new URL(`http://localhost/api/card/${key}/log/raw?run=${id}`),
    request: new Request('http://localhost'),
  });

it('serves the log of the card in the address, and of no other card', async () => {
  const one = run('APP-1', '{"n":1}\n');
  const two = run('APP-2', '{"n":2}\n');

  expect(await (await raw('APP-2', two)).text()).toBe('{"n":2}\n');
  expect(await (await raw('APP-1', one)).text()).toBe('{"n":1}\n');
  expect((await raw('APP-1', two)).status).toBe(404);
});
