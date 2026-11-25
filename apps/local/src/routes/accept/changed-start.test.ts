import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';

// A server that starts with terms accepted at an older version holds its work like a fresh one, and
// still takes the writer lock. Its own file, because the hook's start runs once per module.
const started = vi.hoisted(() => ({ loop: 0, hub: 0 }));
vi.mock('$lib/loop.ts', () => ({
  loop: () => {
    started.loop += 1;
    return { shutdown: async () => undefined };
  },
}));
vi.mock('$lib/hub-link.ts', () => ({ startHubLink: () => void (started.hub += 1), closeHubLink: () => undefined }));

const dir = mkdtempSync(join(tmpdir(), 'nolzu-terms-changed-'));
process.env.NOLZU_DATA_DIR = dir;

const { database } = await import('$lib/db.ts');
const { termsState } = await import('$lib/terms.ts');
writeSetting(database(), 'termsAccepted', { version: '2000-01-01', at: new Date().toISOString() });
const { init } = await import('../../hooks.server.ts');

const before = process.rawListeners('SIGTERM');
afterAll(() => {
  for (const added of process.rawListeners('SIGTERM').filter((one) => !before.includes(one))) process.removeListener('SIGTERM', added as () => void);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('starts no loop and no hub link when the terms accepted are older, and takes the writer lock', () => {
  expect(termsState(database())).toBe('changed');
  init();
  expect(started).toEqual({ loop: 0, hub: 0 });
  expect(database().prepare('SELECT pid FROM writer WHERE id = 1').get()).toEqual({ pid: process.pid });
});
