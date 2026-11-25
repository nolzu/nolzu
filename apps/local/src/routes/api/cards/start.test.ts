import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Loop } from '../../../lib/loop.ts';

// The route with a real loop and the fake engine, so Add and start goes through the move a drop sends.
const held = vi.hoisted(() => ({ live: null as Loop | null }));
vi.mock('../../../lib/loop.ts', async (real) => ({ ...(await real<object>()), loop: () => held.live }));

const { createLoop } = await import('../../../lib/loop.ts');
const { POST } = await import('./+server.ts');
const post = (body: unknown) => (POST as unknown as (event: { request: Request }) => Promise<Response>)({ request: new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify(body) }) });

let dir = '';
let live: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-add-start-'));
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '1' });
  held.live = live;
});

afterEach(() => {
  vi.unstubAllEnvs();
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const card = (key: string) => live.db.prepare('SELECT stage, state, size FROM cards WHERE key = ?').get(key) as { stage: string; state: string; size: string | null };
const runs = (key: string) => (live.db.prepare('SELECT count(*) AS n FROM runs WHERE card_key = ?').get(key) as { n: number }).n;

// The press is the consent, the same as a drag, and it is one call.
it('makes the card and starts Refine once, in one call', async () => {
  const response = await post({ input: 'Sort recipes by rating', board: 'delivery', size: 'small', start: true });

  expect(response.status).toBe(201);
  const { key } = (await response.json()) as { key: string };
  expect(card(key)).toMatchObject({ stage: 'refine', size: 'small' });
  expect(['queued', 'running']).toContain(card(key).state);
  expect(runs(key)).toBe(1);
  expect(live.scheduler.queue().running).toHaveLength(1);
});

// Cmd Enter and Add to Inbox send no start, so the card waits in Inbox and nothing runs.
it('adds the card to Inbox and starts nothing without a start', async () => {
  const response = await post({ input: 'Sort recipes by rating', board: 'delivery' });

  const { key } = (await response.json()) as { key: string };
  expect(card(key)).toMatchObject({ stage: 'inbox', state: 'idle', size: null });
  expect(runs(key)).toBe(0);
  expect(live.scheduler.queue().running).toHaveLength(0);
});

// A card on the board already, so the start must reach the card this call made and not another one.
it('starts the card the call made, not a card already on the board', async () => {
  const first = (await (await post({ input: 'Show the cooking time', board: 'delivery' })).json()) as { key: string };
  const { key } = (await (await post({ input: 'Sort recipes by rating', board: 'delivery', start: true })).json()) as { key: string };

  expect(key).not.toBe(first.key);
  expect(card(key).stage).toBe('refine');
  expect(runs(key)).toBe(1);
  expect(card(first.key)).toMatchObject({ stage: 'inbox', state: 'idle' });
  expect(runs(first.key)).toBe(0);
});

// A new project whose first card comes from Add and start ends its first run. Its run guard is there
// since the workspace was made, so nothing is written here.
it('ends the first run of a new project when Add and start makes its first card', async () => {
  const workspace = join(dir, 'recipes');
  mkdirSync(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  writeSetting(live.db, 'projectPath', workspace);
  writeSetting(live.db, 'workspace', true);
  writeSetting(live.db, 'onboarding', { done: false });

  const response = await post({ input: 'Sort recipes by rating', board: 'delivery', start: true });

  expect(response.status).toBe(201);
  expect(getSetting(live.db, 'onboarding')).toEqual({ done: true });
});
