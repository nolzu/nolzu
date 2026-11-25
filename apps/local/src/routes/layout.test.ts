import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
import type { RailUsage } from '$lib/rail.ts';

// The cloud waits for the paid plans (`packages/protocol/src/soon.ts`). This file pins the code kept for
// then, and cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

// The document comes from the keychain and the cloud, which a test never reads, and the hub is never
// dialled. A test can hand in a paid document and the status of the link.
const link = vi.hoisted(() => ({ display: null as unknown, status: 'closed' }));
vi.mock('$lib/display-sync.ts', async (real) => ({ ...(await real<object>()), currentDisplay: async () => link.display ?? FREE }));
vi.mock('$lib/hub-link.ts', async (real) => ({ ...(await real<object>()), dialHubAgain: () => false, hubStatus: () => link.status }));

// The layout reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-root-layout-'));
process.env.NOLZU_DATA_DIR = dir;

const { load } = await import('./+layout.server.ts');
const { POST } = await import('./api/notes/+server.ts');
type Rail = { project: string | null; projectPath: string | null; repos: string[]; listed: boolean; usage: RailUsage | null };
const rail = () => (load as unknown as (event: { url: URL }) => Promise<Rail>)({ url: new URL('http://localhost/knowledge') });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// What the rail's selector and foot show comes from this load, which nothing else draws in a test.
it('hands the rail the project folder, its repositories and the usage reading', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', join(homedir(), 'nolzu-rail-check', 'recipes'));
  db.close();

  // A project of one repository: the folder itself, by the project's name, and no list to add to.
  expect(await rail()).toMatchObject({ project: 'recipes', projectPath: '~/nolzu-rail-check/recipes', repos: ['recipes'], listed: false, usage: null });

  const listed = openDatabase(dir);
  writeSetting(listed, 'workspace', true);
  writeSetting(listed, 'repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  writeSetting(listed, 'engineLimits', { 'claude-code': { seenAt: Date.UTC(2026, 9, 11, 14, 20), windows: [{ name: 'five_hour', used: 0.62, resetsAt: null, status: 'allowed' }] } });
  listed.close();

  expect(await rail()).toMatchObject({ repos: ['api', 'web'], listed: true, usage: { label: 'Claude Code', share: 62, resets: null } });
});

// The offline banner is built from the signed document this load read, so Free never sees it, even
// while the link is down. A paid document whose link dropped gets it.
it('builds no offline banner on Free, and one on a paid machine whose link dropped', async () => {
  const offline = async () => ((await load({ url: new URL('http://localhost/knowledge') } as never)) as { offline: unknown }).offline;
  link.status = 'waiting';
  try {
    expect(await offline()).toBeNull();
    link.display = { ...FREE, id: 'acct-1', plan: 'solo', features: ['cloud-board'], expiresAt: 4_000_000_000 };
    expect(await offline()).toMatchObject({ headline: 'The connection to the cloud dropped.' });
  } finally {
    link.status = 'closed';
    link.display = null;
  }
});

// Now offers a project of one repository the move once, as a coach note. Every load
// reads it again, so a second load is the reload.
it('offers the move until Got it, and never to a repository with repositories inside', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'repos', null);
  writeSetting(db, 'workspace', null);
  writeSetting(db, 'projectPath', join(homedir(), 'nolzu-rail-check', 'recipes'));
  db.close();
  const now = async () => (await load({ url: new URL('http://localhost/') } as never)) as { workspaceNote: string | null; repos: string[]; listed: boolean };

  const note = (await now()).workspaceNote;
  expect(note).toBe('make-workspace');
  const closed = await POST({ request: new Request('http://localhost/api/notes', { method: 'POST', body: JSON.stringify({ note }) }) } as never);
  expect(closed.status).toBe(200);
  expect((await now()).workspaceNote).toBeNull();

  // Its list is kept, and the rail shows the folder itself beside the repository inside it.
  const nested = openDatabase(dir);
  writeSetting(nested, 'seenNotes', []);
  writeSetting(nested, 'repos', [
    { path: '.', base: 'main' },
    { path: 'api', base: 'main' },
  ]);
  nested.close();
  expect(await now()).toMatchObject({ workspaceNote: null, repos: ['recipes', 'api'], listed: true });
});

// The first drag's coach note shows until Got it, and a second load is the reload. Every load reads it
// again, as Now's stream does.
it('hands the board the first drag note until Got it, and not after a reload', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'seenNotes', []);
  db.close();
  const coach = async () => ((await load({ url: new URL('http://localhost/b/delivery') } as never)) as { firstRun: { coach: string | null } }).firstRun.coach;

  expect(await coach()).toBe('first-drag');
  const closed = await POST({ request: new Request('http://localhost/api/notes', { method: 'POST', body: JSON.stringify({ note: 'first-drag' }) }) } as never);
  expect(closed.status).toBe(200);
  expect(await coach()).toBeNull();
});

// The PR reviews header's "read 12m ago" reads the time the last Read pull requests finished.
it('hands the board the time pull requests were last read', async () => {
  const read = async () => ((await load({ url: new URL('http://localhost/b/prreview') } as never)) as { pullsReadAt: string | null }).pullsReadAt;
  expect(await read()).toBeNull();

  const db = openDatabase(dir);
  writeSetting(db, 'pullsReadAt', '2026-10-20T09:12:00.000Z');
  db.close();
  expect(await read()).toBe('2026-10-20T09:12:00.000Z');
});
