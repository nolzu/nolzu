import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardRepos, createCard, writeSetting } from '@nolzu/core/node';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before
// the module is imported. The loop is a stand-in, so the test sees whether the route tells it.
const data = mkdtempSync(join(tmpdir(), 'nolzu-card-repos-route-'));
process.env.NOLZU_DATA_DIR = data;
const changed = vi.fn();
vi.mock('$lib/loop.ts', () => ({ loop: () => ({ changed }) }));

const { PATCH } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const patch = PATCH as unknown as (event: { params: { key: string }; request: Request }) => Promise<Response>;
const send = (repos: unknown) => patch({ params: { key: 'APP-1' }, request: new Request('http://localhost/api/card/APP-1/repos', { method: 'PATCH', body: JSON.stringify({ repos }) }) });

afterAll(() => rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

beforeEach(() => {
  changed.mockClear();
  const db = database();
  if (db.prepare('SELECT 1 FROM cards WHERE key = ?').get('APP-1') === undefined) createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
  writeSetting(db, 'projectPath', join(data, 'recipes'));
  writeSetting(db, 'repos', [{ path: '.', base: 'main' }, { path: 'api', base: 'main' }]);
});

it('saves the ticks as the person\'s list and tells the loop', async () => {
  const response = await send(['api']);

  expect(response.status).toBe(200);
  expect(cardRepos(database(), 'APP-1')).toEqual({ repos: ['api'], by: 'person' });
  expect(changed).toHaveBeenCalledTimes(1);
});

it('leaves the loop alone when the list is refused', async () => {
  const response = await send(['docs']);

  expect(response.status).toBe(400);
  expect(changed).not.toHaveBeenCalled();
});
