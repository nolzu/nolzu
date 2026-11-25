import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, writeSetting } from '@nolzu/core/node';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before
// the module is imported.
const data = mkdtempSync(join(tmpdir(), 'nolzu-card-checkouts-route-'));
process.env.NOLZU_DATA_DIR = data;

const { POST } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const post = POST as unknown as (event: { params: { key: string } }) => Promise<Response>;

afterAll(() => rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Two cards, so a route that asks about the wrong key answers for the other one.
beforeAll(() => {
  const db = database();
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'closed', title: 'Add a search box' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Add a filter' });
  writeSetting(db, 'projectPath', join(data, 'recipes'));
});

it('refuses the card in the path when it is open', async () => {
  const response = await post({ params: { key: 'APP-2' } });

  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ ok: false, reason: 'APP-2 is not closed, so its checkouts stay. A card keeps them until it reaches Closed.' });
});

it('answers for a closed card with no checkout', async () => {
  const response = await post({ params: { key: 'APP-1' } });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, said: 'APP-1 has no checkout.' });
});
