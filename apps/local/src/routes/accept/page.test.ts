import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRedirect } from '@sveltejs/kit';
import { getSetting, writeSetting } from '@nolzu/core/node';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

// The loop and the hub link are what the terms hold back, so they are spies here: building the real
// loop would take this data folder's writer lock and sweep it.
const started = vi.hoisted(() => ({ loop: 0, hub: 0, shutdown: 0 }));
vi.mock('$lib/loop.ts', () => ({
  loop: () => {
    started.loop += 1;
    return {
      shutdown: async () => {
        started.shutdown += 1;
      },
    };
  },
}));
vi.mock('$lib/hub-link.ts', () => ({ startHubLink: () => void (started.hub += 1), closeHubLink: () => undefined }));

// A fresh data folder of its own, set before anything opens one.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-terms-'));
process.env.NOLZU_DATA_DIR = dir;

const { handle, init } = await import('../../hooks.server.ts');
const { actions, load } = await import('./+page.server.ts');
const { load: layout } = await import('../+layout.server.ts');
const { database } = await import('$lib/db.ts');
const { afterAccept, TERMS_REFUSAL, TERMS_VERSION, termsState } = await import('$lib/terms.ts');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ADDRESS = 'http://localhost:4319';

// What the server answers a request, through the hook, with `routed` when it reached the route.
const ask = async (path: string, init: RequestInit = {}): Promise<Response> =>
  (await handle({
    event: { request: new Request(`${ADDRESS}${path}`, init), url: new URL(`${ADDRESS}${path}`) },
    resolve: () => new Response('routed'),
  } as unknown as Parameters<typeof handle>[0])) as Response;

const post = (fields: Record<string, string>, to = '') =>
  actions.default!({ request: new Request(`${ADDRESS}/accept${to}`, { method: 'POST', body: new URLSearchParams(fields) }), url: new URL(`${ADDRESS}/accept${to}`) } as never);

// Where an action or a load sent the person, or what it returned.
const outcome = async (run: () => unknown): Promise<unknown> => {
  try {
    return await run();
  } catch (thrown) {
    if (isRedirect(thrown)) return { redirect: thrown.location, status: thrown.status };
    throw thrown;
  }
};

// The Ctrl+C handler init registers, kept for the test that presses it.
let initStop: (() => void) | undefined;

it('starts no loop and no hub link at server start before the terms are accepted', () => {
  const before = process.rawListeners('SIGTERM');
  init();
  initStop = process.rawListeners('SIGTERM').find((one) => !before.includes(one)) as (() => void) | undefined;
  expect(termsState(database())).toBe('new');
  expect(started).toMatchObject({ loop: 0, hub: 0 });
  // The writer lock is still taken at start, so a second Nolzu on this folder is refused now.
  expect(database().prepare('SELECT pid FROM writer WHERE id = 1').get()).toEqual({ pid: process.pid });
});

it('sends a page on a fresh data folder to the terms, and keeps where it was going', async () => {
  const page = await ask('/b/delivery?card=APP-1', { headers: { accept: 'text/html' } });
  expect(page.status).toBe(303);
  expect(page.headers.get('location')).toBe('/accept?to=%2Fb%2Fdelivery%3Fcard%3DAPP-1');
  expect((await ask('/')).headers.get('location')).toBe('/accept');
  // The terms page itself, and the question a second nolzu asks, pass.
  expect(await (await ask('/accept')).text()).toBe('routed');
  expect(await (await ask('/api/health')).text()).toBe('routed');
});

it('refuses an endpoint and a page form with a sentence that names the fix', async () => {
  const api = await ask('/api/now');
  expect(api.status).toBe(403);
  expect(await api.json()).toEqual({ message: TERMS_REFUSAL });
  const form = await ask('/new?/add', { method: 'POST', headers: { origin: ADDRESS } });
  expect(form.status).toBe(403);
  // Decoded, as SvelteKit routes it.
  expect((await ask('/%61pi/now')).status).toBe(403);
});

it('refuses an accept from another site, and stores nothing', async () => {
  const crossSite = await ask('/accept', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: 'accept=on' });
  expect(crossSite.status).toBe(403);
  const otherOrigin = await ask('/accept', { method: 'POST', headers: { origin: 'https://example.com' }, body: 'accept=on' });
  expect(otherOrigin.status).toBe(403);
  expect(getSetting(database(), 'termsAccepted')).toBeNull();
});

it('stops on Ctrl+C before the accept without building a loop only to stop it', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  expect(initStop).toBeDefined();
  initStop!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(started).toMatchObject({ loop: 0, shutdown: 0 });
});

it('draws the terms page with no rail data and nothing read', async () => {
  writeSetting(database(), 'projectPath', join(dir, 'recipes'));
  const data = (await layout({ url: new URL(`${ADDRESS}/accept`) } as never)) as { project: unknown; projects: unknown[]; workspaceChanged: unknown };
  expect(data).toMatchObject({ project: null, projects: [], workspaceChanged: null });
  writeSetting(database(), 'projectPath', null);
  expect(await outcome(() => load({ url: new URL(`${ADDRESS}/accept`) } as never))).toMatchObject({ changed: false, to: null });
});

it('needs the box ticked to accept', async () => {
  const refused = (await post({})) as { status: number; data: { message: string } };
  expect(refused.status).toBe(400);
  expect(refused.data.message).toBe('Tick the box to accept the terms.');
  expect(getSetting(database(), 'termsAccepted')).toBeNull();
  expect(started).toMatchObject({ loop: 0, hub: 0 });
});

it('stores the version and the time, starts the held work once, and goes where the person was going', async () => {
  const before = Date.now();
  expect(await outcome(() => post({ accept: 'on', to: '/b/delivery' }))).toEqual({ redirect: '/b/delivery', status: 303 });
  const stored = getSetting(database(), 'termsAccepted');
  expect(stored?.version).toBe(TERMS_VERSION);
  expect(stored?.at).toBe(new Date(Date.parse(stored!.at)).toISOString());
  expect(Date.parse(stored!.at)).toBeGreaterThanOrEqual(before - 1000);
  expect(started).toMatchObject({ loop: 1, hub: 1 });
  // A second accept, such as a second tab, starts nothing more.
  await outcome(() => post({ accept: 'on' }));
  expect(started).toMatchObject({ loop: 1, hub: 1 });
});

it('lets pages and endpoints through after the accept, and sends the terms page on', async () => {
  expect(await (await ask('/b/delivery')).text()).toBe('routed');
  expect(await (await ask('/api/now')).text()).toBe('routed');
  expect(await (await ask('/new?/add', { method: 'POST', headers: { origin: ADDRESS } })).text()).toBe('routed');
  expect(await outcome(() => load({ url: new URL(`${ADDRESS}/accept?to=%2Fknowledge`) } as never))).toEqual({ redirect: '/knowledge', status: 303 });
});

it('asks again when the terms are newer than the version accepted', async () => {
  writeSetting(database(), 'termsAccepted', { version: '2000-01-01', at: new Date().toISOString() });
  expect(termsState(database())).toBe('changed');
  expect((await ask('/b/delivery')).status).toBe(303);
  expect((await ask('/api/now')).status).toBe(403);
  expect(await outcome(() => load({ url: new URL(`${ADDRESS}/accept`) } as never))).toMatchObject({ changed: true });
});

it('sends the person on only to a page of this server', () => {
  expect(afterAccept(null)).toBe('/');
  expect(afterAccept('/t/APP-1?tab=log')).toBe('/t/APP-1?tab=log');
  for (const away of ['//example.com/x', '/\\example.com', 'https://example.com', 'http://localhost:9/x', 'javascript:alert(1)', 'http://[', '/accept']) expect(afterAccept(away)).toBe('/');
  // Paths that parse to this server but leave two slashes at the front once dot segments are gone.
  for (const away of ['/.//example.com/x', '/a/..//example.com/x', '/%2e//example.com/x']) expect(afterAccept(away)).toBe('/');
});

it('draws the five points, links that open in a new tab, a labelled box and a held button', async () => {
  const { render } = await import('svelte/server');
  const { default: Page } = await import('./+page.svelte');
  const { TERMS } = await import('$lib/terms.ts');
  const draw = (changed: boolean, form: { message: string } | null = null) => render(Page, { props: { data: { terms: TERMS, changed, to: '/knowledge' }, form } as never }).body;

  const body = draw(false);
  expect(body.match(/<li>/g)).toHaveLength(5);
  const links = [...body.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
  expect(links).toHaveLength(3);
  for (const link of links) expect(link).toMatch(/target="_blank" rel="noopener noreferrer"/);
  expect(links.map((link) => /href="([^"]+)"/.exec(link)?.[1])).toEqual(['https://nolzu.com/security#gaps', 'https://github.com/nolzu/nolzu/blob/main/LICENSE', 'https://github.com/nolzu/nolzu']);
  // The box sits inside its label, so a screen reader reads the sentence as its name.
  expect(body).toMatch(/<label class="tick[^"]*"><input type="checkbox" name="accept"[^>]*\/?>\s*<span[^>]*>I have read this and I accept it\.<\/span><\/label>/);
  expect(body).toMatch(/<button disabled="" type="submit"[^>]*>[\s\S]*?Accept and start/);
  expect(body).toContain('<input type="hidden" name="to" value="/knowledge"/>');
  expect(body).toContain(TERMS.after);
  expect(body).not.toContain('data-changed');

  // The changed line comes before the intro.
  const again = draw(true);
  expect(again.indexOf(TERMS.changed)).toBeGreaterThan(-1);
  expect(again.indexOf(TERMS.changed)).toBeLessThan(again.indexOf(TERMS.intro));
  expect(draw(false, { message: 'Tick the box to accept the terms.' })).toMatch(/role="alert">Tick the box to accept the terms\./);
});
