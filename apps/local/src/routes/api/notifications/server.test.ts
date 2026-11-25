import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNotification, boardVersion, unreadNotifications } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported.
const data = mkdtempSync(join(tmpdir(), 'nolzu-notifications-route-'));
process.env.NOLZU_DATA_DIR = data;
const changed = vi.fn();
vi.mock('$lib/loop.ts', () => ({ loop: () => ({ changed }) }));

const { GET, POST } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const get = GET as unknown as () => Promise<Response>;
const post = POST as unknown as () => Promise<Response>;

afterAll(() => {
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('lists the kept items newest first, and the post reads them all and tells the stream once', async () => {
  const db = database();
  addNotification(db, { id: 'run:1', kind: 'success', text: 'Plan finished', card: 'APP-1' });
  addNotification(db, { id: 'scout:1', kind: 'info', text: 'Scout: 1 new finding', href: '/scout' });

  const listed = (await (await get()).json()) as { id: string; read: boolean }[];
  expect(listed.map((one) => [one.id, one.read])).toEqual([
    ['scout:1', false],
    ['run:1', false],
  ]);

  const version = boardVersion(db);
  expect((await post()).status).toBe(200);
  expect(unreadNotifications(db)).toBe(0);
  expect(boardVersion(db)).toBe(version + 1);
  expect(changed).toHaveBeenCalledTimes(1);

  // Nothing left unread moves nothing, so a second tab's open sends no snapshot.
  await post();
  expect(changed).toHaveBeenCalledTimes(1);
});
