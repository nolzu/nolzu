import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, createProject, openDatabase, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page as appPage } from '../../../../test/stubs/app-state.ts';
import { type NowSnapshot, waitingCount } from '$lib/now.ts';
import NowPage from '$lib/NowPage.svelte';

// Now with two projects in one temp data folder, read through the real Now stream and the real write
// routes. Now shows the current project only, and every write names it.
vi.mock('$lib/hub-link.ts', async (real) => ({ ...(await real<object>()), dialHubAgain: () => false, hubStatus: () => 'closed' }));

// Not fake mode, which ignores NOLZU_DATA_DIR on purpose. Every move here goes back a column, which
// starts no run, and each engine waits for good in case one did.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-now-projects-'));
process.env.NOLZU_DATA_DIR = dir;

const { createLoop } = await import('$lib/loop.ts');
const { GET } = await import('./api/now/+server.ts');
const { POST: move } = await import('./api/board/move/+server.ts');
const { POST: pick } = await import('./api/current-project/+server.ts');

const first = openDatabase(dir);
writeSetting(first, 'projectPath', join(tmpdir(), 'nolzu-now-projects-code', 'recipes'));
const second = createProject(dir);
writeSetting(second, 'projectPath', join(tmpdir(), 'nolzu-now-projects-code', 'shop'));

const card = (db: typeof first, key: string, stage: string, state: string) => {
  createCard(db, { key, board: 'delivery', stage, title: `${key} of ${db === first ? 'recipes' : 'shop'}` });
  db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, key);
};
const stageOf = (db: typeof first, key: string) => (db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string }).stage;

beforeAll(() => {
  for (const live of [createLoop(dir, process.env), createLoop(dir, process.env, { project: 2 })]) {
    live.engine.spawn = async function* () {
      await new Promise<never>(() => {});
      yield '';
    };
  }
  // Each loop sweeps a run no process is doing when it opens, so the states go in after.
  card(first, 'APP-1', 'plan', 'ready');
  card(second, 'APP-1', 'plan', 'blocked');
  card(second, 'APP-2', 'refine', 'failed');
});

afterAll(() => {
  createLoop(dir, process.env, { project: 2 }).close();
  createLoop(dir).close();
  first.close();
  second.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const chunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);
const data = (text: string) => JSON.parse(text.slice(text.indexOf('data: ') + 6).trim()) as NowSnapshot;
const open = () => {
  const controller = new AbortController();
  return (GET({ request: new Request('http://localhost/api/now', { signal: controller.signal }) } as never) as Response).body!.getReader();
};
// The first snapshot of a new Now stream, and the stream closed again.
async function snapshot(): Promise<NowSnapshot> {
  const reader = open();
  const first = data(await chunk(reader));
  await reader.cancel();
  return first;
}
const page = (snapshot: NowSnapshot) => {
  drawnAt('/');
  return render(NowPage, { props: { stream: { snapshot, reconnecting: false, activity: {}, limits: {} }, now: new Date('2026-10-12T12:00:00.000Z') } }).body;
};
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const section = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
// Async, so a refusal the handler throws reads as a rejection.
const post = async (address: string, body: unknown) =>
  move({ request: new Request(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url: new URL(address) } as never);

describe('Now on a plan with several projects', () => {
  it('shows the current project only, and counts only its cards', async () => {
    const now = await snapshot();
    expect(now.project).toBe(1);
    expect(Object.keys(now)).not.toContain('others');
    // The rail reads this count, so it is the current project's alone.
    expect(waitingCount(now)).toBe(1);

    const waiting = section(page(now), 'waiting-title');
    expect(waiting).toContain('data-waiting-count="">1<');
    expect(waiting).not.toContain('class="group');
    expect(waiting).toMatch(/<article[^>]*data-card="APP-1"/);
    expect(text(waiting)).toContain('APP-1 of recipes');
    expect(text(waiting)).not.toContain('of shop');
  });

  it('moves the card of the project the address names, and not the current one with the same key', async () => {
    expect((await post('http://localhost/api/board/move?project=2', { key: 'APP-1', to: 'refine' })).status).toBe(200);
    expect(stageOf(second, 'APP-1')).toBe('refine');
    expect(stageOf(first, 'APP-1')).toBe('plan');

    // With no project named, the current one, as every screen but Now still sends.
    expect((await post('http://localhost/api/board/move', { key: 'APP-1', to: 'refine' })).status).toBe(200);
    expect(stageOf(first, 'APP-1')).toBe('refine');

    await expect(post('http://localhost/api/board/move?project=9', { key: 'APP-1', to: 'inbox' })).rejects.toMatchObject({ status: 409, body: { message: 'There is no project 9 on this machine.' } });
    await expect(post('http://localhost/api/board/move?project=two', { key: 'APP-1', to: 'inbox' })).rejects.toMatchObject({ status: 400 });
  });

  it('names the other project on a lane its card holds, from the projects the selector lists', async () => {
    const now = await snapshot();
    appPage.data = { projects: [{ id: 1, name: 'recipes' }, { id: 2, name: 'shop' }] };
    const boards = now.boards.map((board, at) => (at === 0 ? { ...board, lanes: board.lanes.map((lane) => (lane.name === 'stack' ? { ...lane, heldBy: 'APP-1', project: 2 } : lane)) } : board));

    expect(text(section(page({ ...now, boards }), 'running-title'))).toContain('Stack lane busy with APP-1 in shop');
    appPage.data = {};
  });

  it('tells a stream on the old project that another project became the current one', async () => {
    const reader = open();
    expect(data(await chunk(reader)).switched).toBeUndefined();
    await chunk(reader);

    const body = new FormData();
    body.set('project', '2');
    await expect(pick({ request: new Request('http://localhost/api/current-project', { method: 'POST', body }) } as never)).rejects.toMatchObject({ status: 303 });
    expect(data(await chunk(reader))).toMatchObject({ project: 1, switched: true });
    await reader.cancel();

    // A new stream serves the new current project alone.
    const now = await snapshot();
    expect([now.project, now.switched, Object.keys(now).includes('others')]).toEqual([2, undefined, false]);
    await expect(pick({ request: new Request('http://localhost/api/current-project', { method: 'POST', body: (() => (body.set('project', '1'), body))() }) } as never)).rejects.toMatchObject({ status: 303 });
  });
});

// Every plan holds as many projects as the person makes, so a write that names
// another project reaches it with no account.
describe('Now with no account', () => {
  it('takes a write that names another project', async () => {
    await post('http://localhost/api/board/move?project=2', { key: 'APP-2', to: 'inbox' });
    expect(stageOf(second, 'APP-2')).toBe('inbox');
  });
});
