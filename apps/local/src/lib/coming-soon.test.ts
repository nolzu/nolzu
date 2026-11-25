import { boardFixture } from '@nolzu/ui/fixture';
import { describe, expect, it, vi } from 'vitest';
import type { NowSnapshot } from './now.ts';
import type { ProjectRow } from './projects.ts';
import { database } from '$lib/db.ts';
import { acceptTerms } from '$lib/terms.ts';

// `SCOUT_AND_EVIDENCE` is one constant, read when a module loads. Each state loads the modules again
// with the switch set, so this file proves both: off, as shipped, and on, as it comes back.
vi.mock('$lib/loop.ts', () => ({ loop: () => ({}) }));
vi.mock('$lib/hub-link.ts', () => ({ startHubLink: () => undefined, closeHubLink: () => undefined }));

// The server answers only the terms page until they are accepted, and this file tests what comes after.
acceptTerms(database(), true);

async function withSwitch(on: boolean, cloud = false) {
  vi.resetModules();
  vi.doMock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: on, CLOUD_OPEN: cloud }));
  const [{ KEYS, liveKeys, scoped }, { paletteRows }, { nowToasts }, { handle }, { default: Rail }, { FREE }, { render }, { drawnAt }, { default: DataSync }, { default: NowPage }, { default: ProjectsList }] = await Promise.all([
    import('@nolzu/ui'),
    import('./palette.ts'),
    import('./now-toasts.ts'),
    import('../hooks.server.ts'),
    import('./Rail.svelte'),
    import('./display.ts'),
    // Loaded again with the component, or the two copies of Svelte do not share a render.
    import('svelte/server'),
    // The stub vitest aliases `$app/paths` to, loaded again with Rail for the same reason.
    import('../../../../test/stubs/app-paths.ts'),
    import('./DataSync.svelte'),
    import('./NowPage.svelte'),
    import('./ProjectsList.svelte'),
  ]);
  const { column } = await import('./data-leaves.ts');
  return { KEYS, liveKeys, scoped, paletteRows, nowToasts, handle, Rail, FREE, render, drawnAt, DataSync, NowPage, ProjectsList, column };
}

const snapshot = (fresh: number, boards: NowSnapshot['boards'] = []): NowSnapshot => ({
  version: 3,
  boards,
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 1, fresh, newest: null },
  ended: [],
});

const state = (now: NowSnapshot) => ({ snapshot: now, reconnecting: false, activity: {}, limits: {} });
const hrefs = { board: (kind: string) => `/b/${kind}`, card: (key: string) => `/t/${key}`, cardTab: (key: string) => `/t/${key}`, section: (id: string) => `/settings/${id}`, addCard: '/?add' };

// The least of a project row Settings, Project draws.
const ROW = {
  name: 'recipes',
  path: '/home/demo/nolzu/recipes',
  opener: 'Open in Finder',
  ticketSystem: 'local',
  baseBranch: 'main',
  repos: [{ path: 'web', base: 'main' }],
  missing: [],
  manifestProblems: [],
  rootRecords: true,
  workspace: true,
  branchTemplate: '{key}-{slug}',
  branchExample: 'APP-4-add-a-search-box',
  boards: [],
  deliveryFlow: 'pull-request',
  localKeyPrefix: 'APP',
  nextKey: 'APP-4',
  apps: [],
  browser: { servers: [], on: false, chrome: true, problem: null },
  knowledgeDir: null,
  knowledgeFolder: null,
  allowedCommands: [],
  closedCheckouts: 0,
  convert: null,
} satisfies ProjectRow;

describe.each([
  ['off', false],
  ['on', true],
])('Scout and Evidence %s', (_name, on) => {
  it('binds the go keys only when on', async () => {
    const { KEYS } = await withSwitch(on);
    const actions = KEYS.map((binding) => binding.action);

    expect(actions.includes('go:scout')).toBe(on);
    expect(actions.includes('go:evidence')).toBe(on);
  });

  it('lists both screens and the Scout check in the palette only when on', async () => {
    const { KEYS, liveKeys, scoped, paletteRows } = await withSwitch(on);
    const names = KEYS.filter((binding) => binding.scope === 'global').map((binding) => binding.action);
    const live = liveKeys(scoped('global'), Object.fromEntries(names.map((name) => [name, () => undefined])));
    const ids = paletteRows(live, [], [], hrefs).map((row) => row.id);

    expect(ids.includes('key:go:scout')).toBe(on);
    expect(ids.includes('key:go:evidence')).toBe(on);
    expect(ids.includes('scout-check')).toBe(on);
  });

  it('raises a Scout toast only when on', async () => {
    const { nowToasts } = await withSwitch(on);
    const toastHrefs = { card: (key: string) => `/t/${key}`, scout: '/scout', engines: '/settings/engines' };
    const first = nowToasts(null, state(snapshot(0)), 0, toastHrefs);
    const next = nowToasts(first.heard, state(snapshot(2)), 0, toastHrefs);

    expect(next.toasts.some((toast) => toast.title?.startsWith('Scout') === true)).toBe(on);
  });

  it.each(['/scout', '/scout/f/3', '/evidence'])('sends %s to Now only when off', async (path) => {
    const { handle } = await withSwitch(on);
    const address = `http://localhost:5173${path}`;
    const sent = (await handle({
      event: { request: new Request(address, { headers: { host: 'localhost:5173' } }), url: new URL(address) },
      resolve: () => new Response('passed'),
    } as unknown as Parameters<typeof handle>[0])) as Response;

    expect(sent.status).toBe(on ? 200 : 303);
    expect(sent.headers.get('location')).toBe(on ? null : '/');
  });

  it.each(['/api/evidence/timesheet?from=2026-11-02', '/api/scout'])('answers %s with a 404 only when off', async (path) => {
    const { handle } = await withSwitch(on);
    const address = `http://localhost:5173${path}`;
    const sent = (await handle({
      event: { request: new Request(address, { headers: { host: 'localhost:5173' } }), url: new URL(address) },
      resolve: () => new Response('passed'),
    } as unknown as Parameters<typeof handle>[0])) as Response;

    expect(sent.status).toBe(on ? 200 : 404);
    expect(await sent.text()).toBe(on ? 'passed' : JSON.stringify({ message: 'Not found' }));
  });

  // Only the two screens and what is under them, not an address that starts with the same letters.
  it.each(['/scouts', '/evidence-week', '/api/evidence-week'])('passes %s through either way', async (path) => {
    const { handle } = await withSwitch(on);
    const address = `http://localhost:5173${path}`;
    const sent = handle({
      event: { request: new Request(address, { headers: { host: 'localhost:5173' } }), url: new URL(address) },
      resolve: () => new Response('passed'),
    } as unknown as Parameters<typeof handle>[0]);

    expect(((await sent) as Response).status).toBe(200);
  });

  it('draws the Scout panel and the Scout lane on Now only when on', async () => {
    const { NowPage, render, drawnAt } = await withSwitch(on);
    drawnAt('/');
    const body = render(NowPage, { props: { stream: state(snapshot(1, [boardFixture('pull-request')])) } }).body;

    expect(body.includes('class="panel pad scout')).toBe(on);
    expect(body.includes('Scout lane free')).toBe(on);
    expect(body.includes('Stack lane free')).toBe(true);
  });

  // The client and rate fields stay on Evidence, so Settings, Project has no Evidence box in
  // either state, and nothing on it says Coming soon.
  it('draws no Evidence box and no client and rate fields in Settings, Project', async () => {
    const { ProjectsList, render, drawnAt } = await withSwitch(on);
    drawnAt('/settings/project');
    const body = render(ProjectsList, { props: { row: ROW } }).body;

    expect(body).not.toContain('Coming soon');
    expect(body).not.toContain('id="evidence"');
    expect(body.includes('name="client"')).toBe(false);
  });

  // Settings, Wall names the timesheet export only while it can happen: it is a Solo feature, so the
  // paid plans must be open too.
  it.each([false, true])('names the timesheet export on Settings, Wall only when on and the cloud is open (cloud %s)', async (cloud) => {
    const { render, drawnAt } = await withSwitch(on, cloud);
    const { default: Wall } = await import('../routes/settings/wall/+page.svelte');
    drawnAt('/settings/wall');
    const body = render(Wall as never, { props: { data: { groups: [] } } } as never).body;

    expect(body.includes('Timesheet export')).toBe(on && cloud);
    expect(body).not.toContain('Coming soon');
  });

  // A turned-off feature has no row at all.
  it('draws both rail entries as links when on, and no row for either when off', async () => {
    const { Rail, render, drawnAt } = await withSwitch(on);
    drawnAt('/knowledge');
    const body = render(Rail, { props: { routeId: '/knowledge', project: { name: 'recipes', path: '~/nolzu/recipes', repos: ['api'], listed: true }, ontheme: () => {}, scoutNew: true } }).body;
    const links = [...body.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]);

    expect(links.some((href) => href?.endsWith('/scout') === true)).toBe(on);
    expect(links.some((href) => href?.endsWith('/evidence') === true)).toBe(on);
    expect(body.includes('data-scout-new')).toBe(on);
    const words = body.replace(/<[^>]*>/g, ' ');
    expect(/\bScout\b/.test(words)).toBe(on);
    expect(/\bEvidence\b/.test(words)).toBe(on);
    expect(body).not.toContain('Coming soon');
  });

  // What leaves another way moved to Settings, Wall, which names the timesheet export only while it
  // can happen, so the hub box names it in neither state.
  it('names no timesheet export in the hub box', async () => {
    const { DataSync, render } = await withSwitch(on);

    expect(render(DataSync, { props: {} }).body.includes('Timesheet export')).toBe(false);
  });

  // With no Scout source there is no finding, schedule, token or line to name.
  it('names Scout in the hub box only when on', async () => {
    const { DataSync, render, column } = await withSwitch(on);
    const body = render(DataSync, { props: { canSync: true } }).body;

    expect(column('hub').some((group) => group.name === 'Scout')).toBe(on);
    expect(body.includes('finding.results')).toBe(on);
    expect(body.includes('Scout source tokens')).toBe(on);
    expect(body.includes('The lines a Scout source read')).toBe(on);
  });
});
