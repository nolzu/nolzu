import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase } from './db.ts';
import { addNotification, markNotificationsRead, notifications, NOTIFICATIONS_KEPT, unreadNotifications } from './notifications.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-notifications-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('keeps one row per event, newest first, with its card and address', () => {
  expect(addNotification(db, { id: 'run:1', kind: 'success', text: 'Plan finished', card: 'APP-1' })).toBe(true);
  expect(addNotification(db, { id: 'run:1', kind: 'success', text: 'Plan finished', card: 'APP-1' })).toBe(false);
  addNotification(db, { id: 'scout:1', kind: 'info', text: 'Scout: 2 new findings', href: '/scout' });
  expect(notifications(db).map((one) => [one.id, one.card, one.href, one.read])).toEqual([
    ['scout:1', null, '/scout', false],
    ['run:1', 'APP-1', null, false],
  ]);
  expect(unreadNotifications(db)).toBe(2);
});

it('marks every one read, and a later one comes in unread', () => {
  addNotification(db, { id: 'run:1', kind: 'error', text: 'Plan failed' });
  expect(markNotificationsRead(db)).toBe(true);
  expect(markNotificationsRead(db)).toBe(false);
  addNotification(db, { id: 'run:2', kind: 'success', text: 'Plan finished' });
  expect(unreadNotifications(db)).toBe(1);
  expect(notifications(db).map((one) => one.read)).toEqual([false, true]);
});

it(`keeps the newest ${NOTIFICATIONS_KEPT} and drops the older ones`, () => {
  for (let n = 1; n <= NOTIFICATIONS_KEPT + 5; n += 1) addNotification(db, { id: `run:${n}`, kind: 'success', text: `Run ${n}` });
  // Read past the cap, so a row left behind would show.
  const kept = notifications(db, NOTIFICATIONS_KEPT * 2);
  expect(kept).toHaveLength(NOTIFICATIONS_KEPT);
  expect(kept[0]?.id).toBe(`run:${NOTIFICATIONS_KEPT + 5}`);
  expect(kept.at(-1)?.id).toBe('run:6');
});
