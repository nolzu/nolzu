import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryBoard } from '@nolzu/core';
import { createCard, moveCard, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import { addTasks } from './create-card.ts';
import { createLoop, type Loop } from './loop.ts';
import { waitingItems } from './now.ts';
import { nowSnapshot } from './now-snapshot.ts';
import NowPage from './NowPage.svelte';

// The In delivery card over a real loop: the count comes from the links the epic wrote
// and from the plan file in its folder, and the epic stays put when its last task closes.
let dir = '';
let live: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-epic-progress-'));
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', dir);
  writeSetting(live.db, 'localKeyPrefix', 'APP');
  createCard(live.db, { key: 'APP-1', board: 'epics', stage: 'in-delivery', title: 'Weekly meal plans' });
  const plan = join(dir, '.tasks', 'APP-1', 'plan');
  mkdirSync(plan, { recursive: true });
  writeFileSync(join(plan, 'plan.md'), '# Plan\n\n1. Store meal plans in the api\n2. Add tags to recipes\n3. Build the shopping list for a week\n');
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const epic = () => live.snapshot('epics').cards.find((card) => card.key === 'APP-1');
const close = (key: string) => moveCard(live.db, deliveryBoard('pull-request'), key, 'closed', vi.fn());
const toWrapup = (key: string) => live.db.prepare("UPDATE cards SET stage = 'wrapup' WHERE key = ?").run(key);

it('counts the tasks from the links, and a step of the plan not added yet in M with no chip', () => {
  const { keys } = addTasks(live.db, 'APP-1', ['Store meal plans in the api', 'Add tags to recipes']);
  // A Delivery card that names the third step but was never linked is not one of the epic's tasks.
  createCard(live.db, { key: 'APP-9', board: 'delivery', stage: 'inbox', title: 'Build the shopping list for a week' });

  expect(epic()?.delivered).toEqual({ done: 0, total: 3 });
  expect(epic()?.tasks?.map((task) => [task.key, task.state, task.done])).toEqual([
    [keys[0], 'idle', false],
    [keys[1], 'idle', false],
  ]);
});

it('stays in In delivery when its last task closes, turns finished and shows in Now', async () => {
  const { keys } = addTasks(live.db, 'APP-1', ['Store meal plans in the api', 'Add tags to recipes', 'Build the shopping list for a week']);
  for (const key of keys) toWrapup(key);
  await close(keys[0]!);
  await close(keys[1]!);
  expect(epic()).toMatchObject({ delivered: { done: 2, total: 3 } });
  expect(epic()).not.toHaveProperty('finished');
  expect(waitingItems(nowSnapshot(live)).map((item) => item.card.key)).not.toContain('APP-1');

  await close(keys[2]!);

  expect(epic()).toMatchObject({ stage: 'in-delivery', state: 'idle', delivered: { done: 3, total: 3 }, finished: true });
  const now = nowSnapshot(live);
  const item = waitingItems(now).find((one) => one.card.key === 'APP-1');
  expect(item?.kind).toBe('tasks-done');
  expect(item?.card.stage).toBe('in-delivery');
  // It waits from the close of its last task, the newest move of any of them.
  const lastClose = live.db.prepare('SELECT max(at) AS at FROM card_events WHERE card_key = ?').get(keys[2]!) as { at: string };
  expect(now.waiting['APP-1']?.since).toBe(lastClose.at);

  drawnAt('/');
  const html = render(NowPage, { props: { stream: { snapshot: now, reconnecting: false, activity: {}, limits: {} }, now: new Date() } }).body;
  const drawn = /<article[^>]*data-card="APP-1"[\s\S]*?<\/article>/.exec(html)?.[0] ?? '';
  expect(drawn).toContain('data-kind="tasks-done"');
  expect(drawn.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).toContain('All 3 tasks are done on Delivery.');
  expect(drawn).toContain('Start Wrap-up');
  expect(drawn).not.toContain('data-send-back');
});

it('is not finished while a step of the plan is not on Delivery yet', async () => {
  const { keys } = addTasks(live.db, 'APP-1', ['Store meal plans in the api']);
  toWrapup(keys[0]!);
  await close(keys[0]!);

  expect(epic()).toMatchObject({ delivered: { done: 1, total: 3 } });
  expect(epic()).not.toHaveProperty('finished');
});
