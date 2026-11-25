import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BoardKind, BoardSnapshot, CardView } from '@nolzu/protocol';
import { boardFixture, cardFixture, stageFixture } from '@nolzu/ui/fixture';
import { parseRound } from '@nolzu/ui/review';
import { type Component, createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_TOASTS } from '$lib/board-page.ts';
import { offlineBanner } from '$lib/cloud-status.ts';
import { FREE } from '$lib/display.ts';
import type { NowSnapshot } from '$lib/now.ts';
import { nowLive } from '$lib/now-live.svelte.ts';
import { toastStack } from '$lib/toast-stack.svelte.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page } from '../../../../test/stubs/app-state.ts';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { mounted } from '../../../../packages/ui/test/mounted.svelte.ts';
import Layout from './+layout.svelte';
import NowRoute from './+page.svelte';
import BoardRoute from './b/[board]/+page.svelte';
import CardLayout from './t/[key]/+layout.svelte';
import CardTab from './t/[key]/[tab]/+page.svelte';

// `CLOUD_OPEN` read through a getter, so one test can draw the card page with the cloud open. What
// reads it while a module loads keeps the shipped false.
const cloud = vi.hoisted(() => ({ open: false }));
vi.mock('@nolzu/protocol', async (actual) => Object.defineProperty({ ...(await actual<typeof import('@nolzu/protocol')>()) }, 'CLOUD_OPEN', { get: () => cloud.open, enumerable: true }));

// The card page reads its tabs again through this when the card moves on the board.
const reload = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({ goto: async () => undefined, invalidateAll: reload }));

// The root layout for real, beside the page it frames: the one Now stream it opens, and the rail and
// the pages that read it. A browser holds six connections to one host over HTTP/1.1, counted over all
// its tabs, so a tab holds one stream. The stream is a stand-in the test feeds by hand.

class Source {
  static opened: Source[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    Source.opened.push(this);
  }
  addEventListener(): void {}
  close(): void {}
}

// `now` is the card layout's: the time the server drew the page with, which the trail's times ago start from.
const LAYOUT = { project: null, prefix: 'APP', offBoards: [] as BoardKind[], display: FREE, cloud: null, projectPath: null, repos: [], listed: false, usage: null, now: new Date().toISOString() };
const empty = createRawSnippet(() => ({ render: () => '<div></div>' }));
let parts: { instance: object; target: HTMLElement }[] = [];

beforeEach(() => {
  Source.opened = [];
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
  toastStack.state = NO_TOASTS;
  vi.stubGlobal('EventSource', Source);
  // The card row measures itself. jsdom has no ResizeObserver, and the size it would report is no part
  // of these tests.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // The layout loads the installed feature package, which a test has not got.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const part of parts) {
    void unmount(part.instance);
    part.target.remove();
  }
  parts = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const place = (component: Parameters<typeof mount>[0], props: Record<string, unknown>) => {
  const target = document.body.appendChild(document.createElement('div'));
  parts.push({ instance: mount(component, { target, props }), target });
  flushSync();
};

// The address, as the router would set it before the layout and the page draw.
function at(route: string, params: Record<string, string>, path: string): void {
  page.route.id = route;
  page.params = params;
  page.url = new URL(`http://localhost${path}`);
  drawnAt(path);
}

const nowOf = (boards: BoardSnapshot[]): NowSnapshot => ({
  version: 1,
  boards,
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 0, fresh: 0, newest: null },
});

// What the server sends on a stream: one whole event.
function send(source: Source | undefined, value: unknown): void {
  source!.onmessage!({ data: JSON.stringify(value) });
  flushSync();
}

const urls = () => Source.opened.map((one) => one.url);
const epics = (board: BoardSnapshot): BoardSnapshot => ({ ...board, kind: 'epics' });
const ticket = (board: BoardKind) => ({ key: 'APP-1', title: 'Add a search box', board, state: 'idle', stage: 'inbox' });
// The head's K and J, drawn only once the card was read off a board, in whatever state it is.
const cardRead = () => document.querySelector('header .beside') !== null;

it('opens one stream on a board page, the Now stream, and draws the board out of it', () => {
  at('/b/[board]', { board: 'delivery' }, '/b/delivery');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(BoardRoute as never, { data: { off: null } });

  expect(urls()).toEqual(['../api/now']);
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])]));
  expect(document.querySelector('article[data-card="APP-1"]')).not.toBeNull();
});

// New project draws no rail and nothing that reads Now, so it opens no stream.
it('opens no stream on New project', () => {
  at('/new', {}, '/new');
  place(Layout as never, { data: LAYOUT, children: empty });

  expect(urls()).toEqual([]);
});

// The board the address names, and not Delivery, which comes first in every Now snapshot.
it('draws the board the address names out of the Now stream', () => {
  at('/b/[board]', { board: 'epics' }, '/b/epics');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(BoardRoute as never, { data: { off: null } });

  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'inbox' })]), epics(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]))]));
  expect(document.querySelector('article[data-card="APP-1"]')).not.toBeNull();
  expect(document.querySelector('article[data-card="APP-2"]')).toBeNull();
});

it('reads a card on a board that is on out of the Now stream, with no stream of its own', () => {
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: ticket('delivery'), tabs: [], runOn: null }, children: empty });

  expect(urls()).toEqual(['../api/now']);
  expect(cardRead()).toBe(false);
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])]));
  expect(cardRead()).toBe(true);
});

// The PRs tab shows from the Pull request column on, and the tabs come with the load, so a move there
// with the page open reads the card again. A snapshot with the card where it was reads nothing.
it('reads the card again when the board moves it to another column', () => {
  reload.mockClear();
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), stage: 'qa' }, tabs: [], runOn: null }, children: empty });
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'qa', state: 'idle' })])]));
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'qa', state: 'idle' })])]));
  expect(reload).not.toHaveBeenCalled();
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'pr-watch', state: 'idle' })])]));
  expect(reload).toHaveBeenCalledTimes(1);
});

// The card's own board out of the Now snapshot, and not Delivery, which comes first in it.
it('reads a card on a board that is on, other than Delivery, out of that board in the Now stream', () => {
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: ticket('epics'), tabs: [], runOn: null }, children: empty });

  expect(urls()).toEqual(['../api/now']);
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'inbox' })]), epics(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]))]));
  expect(cardRead()).toBe(true);
});

// No Now snapshot carries a board that is off, so the card page opens that board's own stream.
it('opens the stream of a board that is off for a card on it, and reads the card from there', () => {
  const data = { ...LAYOUT, offBoards: ['epics'] as BoardKind[] };
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data, children: empty });
  place(CardLayout as never, { data: { ...data, ticket: ticket('epics'), tabs: [], runOn: null }, children: empty });

  expect(urls()).toEqual(['../api/now', '../api/board?board=epics']);
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'inbox' })])]));
  expect(cardRead()).toBe(false);
  send(Source.opened[1], epics(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])));
  expect(cardRead()).toBe(true);
});

// The stream of the card's own board, whichever board is off.
it('opens the stream of the card’s own board when another board is off', () => {
  const data = { ...LAYOUT, offBoards: ['investigations'] as BoardKind[] };
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data, children: empty });
  place(CardLayout as never, { data: { ...data, ticket: ticket('investigations'), tabs: [], runOn: null }, children: empty });

  expect(urls()).toEqual(['../api/now', '../api/board?board=investigations']);
  send(Source.opened[1], { ...boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]), kind: 'investigations' });
  expect(cardRead()).toBe(true);
});

// The rail's count and the count of Waiting on you are one number, read off the one stream, over every
// board that is on, and both follow each new snapshot.
it('keeps the rail count equal to Waiting on you, over two boards and a second snapshot', () => {
  at('/', {}, '/');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(NowRoute as never, {});
  const rail = () => document.querySelector('[data-now-count]')?.textContent;
  const section = () => document.querySelector('[data-waiting-count]')?.textContent;

  const asks = cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' });
  const failed = cardFixture({ key: 'APP-3', stage: 'implement', state: 'failed' });
  const ready = cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' });
  send(Source.opened[0], nowOf([boardFixture('pull-request', [asks, failed]), epics(boardFixture('pull-request', [ready]))]));
  expect(rail()).toBe('3');
  expect(section()).toBe('3');

  send(Source.opened[0], nowOf([boardFixture('pull-request', [failed]), epics(boardFixture('pull-request', []))]));
  expect(rail()).toBe('1');
  expect(section()).toBe('1');
});

// A run's toast comes off the same stream, once, and never for a run the first snapshot replays. A
// reload opens a new stream, whose first snapshot raises nothing either.
it('raises one toast for a run that ends after the page loaded, and none on a reload', () => {
  at('/', {}, '/');
  place(Layout as never, { data: LAYOUT, children: empty });
  const ended = (runId: number, key: string) => ({ runId, key, phase: 'Plan', state: 'complete', verdict: null, reason: null, endedAt: `2026-10-17T16:1${runId}:00.000Z`, model: 'sonnet', durationMs: 48_000, costUsd: 0.07 });
  const board = boardFixture('pull-request', []);
  const keys = () => toastStack.state.toasts.map((one) => one.card.key);

  send(Source.opened[0], { ...nowOf([board]), ended: [ended(1, 'APP-1')] });
  expect(keys()).toEqual([]);

  const after = { ...nowOf([board]), version: 2, ended: [ended(2, 'APP-2'), ended(1, 'APP-1')] };
  send(Source.opened[0], after);
  send(Source.opened[0], { ...after, version: 3 });
  expect(keys()).toEqual(['APP-2']);
  expect(document.querySelector('.toasts .toast .message')?.textContent).toBe('APP-2 Plan finished');

  for (const part of parts.splice(0)) {
    void unmount(part.instance);
    part.target.remove();
  }
  toastStack.state = NO_TOASTS;
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
  place(Layout as never, { data: LAYOUT, children: empty });
  send(Source.opened[1], after);
  expect(keys()).toEqual([]);
});

// The rail's search button and Cmd K open the one palette the layout mounts, and Esc gives focus back
// to the button. The palette reads the cards off the same Now stream.
it('opens the command palette from the rail button and from Cmd K', async () => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  at('/', {}, '/');
  place(Layout as never, { data: LAYOUT, children: empty });
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])]));
  const palette = () => document.querySelector<HTMLDialogElement>('dialog[data-palette]');
  const button = document.querySelector<HTMLButtonElement>('button.cmdk')!;

  expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('Search or run a command ⌘K');
  expect(palette()).toBeNull();
  button.click();
  await vi.waitFor(() => expect(document.activeElement).toBe(palette()?.querySelector('input')));
  expect(palette()!.open).toBe(true);
  const field = palette()!.querySelector('input')!;
  field.value = 'app-1';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(palette()!.querySelector('[data-row="move:APP-1:refine"]')?.textContent).toContain('Move to Refine');

  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  flushSync();
  expect(palette()).toBeNull();
  expect(document.activeElement).toBe(button);

  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.activeElement).toBe(palette()?.querySelector('input')));
});

// New project has no rail, so it has no palette, and Cmd K stays the browser's there.
it('has no palette on New project', () => {
  at('/new', {}, '/new');
  place(Layout as never, { data: LAYOUT, children: empty });

  const press = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(press);
  flushSync();
  expect(press.defaultPrevented).toBe(false);
  expect(document.querySelector('dialog[data-palette]')).toBeNull();
  expect(document.querySelector('button.cmdk')).toBeNull();
});

// One corner on every screen. The layout draws it, so a screen with no toast of its own
// (Knowledge, Scout, Evidence, Settings, Projects, New project) has it as well, and no screen adds one.
it.each([
  ['Now', '/', {}, '/'],
  ['a board', '/b/[board]', { board: 'delivery' }, '/b/delivery'],
  ['a card page', '/t/[key]', { key: 'APP-1' }, '/t/APP-1'],
  ['Knowledge', '/knowledge', {}, '/knowledge'],
  ['New project', '/new', {}, '/new'],
] as const)('draws one toast host on %s', (_name, route, params, path) => {
  at(route, params, path);
  place(Layout as never, { data: LAYOUT, children: empty });
  if (route === '/') place(NowRoute as never, {});
  if (route === '/b/[board]') place(BoardRoute as never, { data: { off: null } });
  if (route === '/t/[key]') place(CardLayout as never, { data: { ...LAYOUT, ticket: ticket('delivery'), tabs: [], runOn: null }, children: empty });
  if (route !== '/new') send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])]));

  expect(document.querySelectorAll('.toasts')).toHaveLength(1);
  expect(document.querySelectorAll('[role="status"].toasts')).toHaveLength(1);
});

// The source side of the same rule: only the layout's corner draws the host, and no screen draws a toast.
it('mounts the toast host in one place, the layout', () => {
  const root = join(import.meta.dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.svelte') ? [join(dir, entry.name)] : []));
  const drawing = (tag: RegExp) => files(root).filter((file) => tag.test(readFileSync(file, 'utf8'))).map((file) => relative(root, file));

  expect(drawing(/<ToastHost[\s>]/)).toEqual(['lib/ToastCorner.svelte']);
  expect(drawing(/<ToastCorner[\s>]/)).toEqual(['routes/+layout.svelte']);
  expect(drawing(/<Toast[\s>]/)).toEqual([]);
});

// A refused press on the card page is the card's toast in the one corner, not a toast of the card row.
it('raises a refused press on the card page in the one corner', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'APP-1 moved on in another tab.' }), { status: 409 }));
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: ticket('delivery'), tabs: [], runOn: null }, children: empty });
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])]));

  document.querySelector<HTMLButtonElement>('[data-move]')!.click();
  await vi.waitFor(() => expect(document.querySelector('.toasts .toast[data-refused] .message')?.textContent).toBe('APP-1: APP-1 moved on in another tab.'));
  expect(document.querySelectorAll('.toast')).toHaveLength(1);
});

// The toast is the card on show, not the first card of the board.
it('names the card on show in a refused press on its page', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'APP-7 moved on in another tab.' }), { status: 409 }));
  at('/t/[key]', { key: 'APP-7' }, '/t/APP-7');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key: 'APP-7' }, tabs: [], runOn: null }, children: empty });
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-7', stage: 'inbox' })])]));

  document.querySelector<HTMLButtonElement>('[data-move]')!.click();
  await vi.waitFor(() => expect(document.querySelector('.toasts .toast[data-refused] .message')?.textContent).toBe('APP-7: APP-7 moved on in another tab.'));
  expect(document.querySelector('.toasts .toast .open')?.getAttribute('href')).toContain('/t/APP-7');
});

// The next press takes the old refusal down, as the card row's own toast went before there was one corner.
it('takes the refusal down on the next press on the card page', async () => {
  const answers = [new Response(JSON.stringify({ message: 'APP-1 moved on in another tab.' }), { status: 409 }), new Response('{}', { status: 200 })];
  vi.stubGlobal('fetch', async () => answers.shift());
  at('/t/[key]', { key: 'APP-1' }, '/t/APP-1');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: ticket('delivery'), tabs: [], runOn: null }, children: empty });
  send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])]));

  document.querySelector<HTMLButtonElement>('[data-move]')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll('.toasts .toast')).toHaveLength(1));
  document.querySelector<HTMLButtonElement>('[data-move]')!.click();
  flushSync();

  expect(document.querySelectorAll('.toasts .toast')).toHaveLength(0);
});

// The question at the first QA is drawn once, by the root layout, over any page. Move forward into QA on
// the card page opens it and sends nothing; Cancel the move lets the button go; Start QA saves the answer
// and then sends the move.
it('asks how QA gets the app on Move forward into QA, in the dialog the layout draws', async () => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  const posted: { url: string; body: unknown }[] = [];
  // The writes only. The dialog also reads the card's copy once it opens.
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push({ url, body: JSON.parse(String(init.body ?? 'null')) });
    return new Response('{"ok":true}');
  });
  at('/t/[key]', { key: 'APP-2' }, '/t/APP-2');
  place(Layout as never, { data: LAYOUT, children: empty });
  place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key: 'APP-2', stage: 'implement' }, tabs: [], runOn: null }, children: empty });
  const qaSetup = { project: 'recipes', repo: null, dev: { command: 'npm run dev', repo: '.' }, scripts: '', unwalled: null, address: '', test: null, playwright: false, chrome: false, browser: false };
  send(Source.opened[0], { ...nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'implement', state: 'ready' })])]), qaSetup });
  const asked = () => document.querySelector<HTMLDialogElement>('dialog[data-qa-ask]');
  const move = () => document.querySelector<HTMLButtonElement>('[data-move="qa"]')!;
  const press = (name: string) => [...asked()!.querySelectorAll('button')].find((one) => one.textContent?.trim() === name)!.click();

  move().click();
  await vi.waitFor(() => expect(asked()?.open).toBe(true));
  expect(posted).toEqual([]);

  press('Cancel the move');
  await vi.waitFor(() => expect(move().getAttribute('aria-disabled')).not.toBe('true'));
  expect(asked()).toBeNull();
  expect(posted).toEqual([]);

  move().click();
  await vi.waitFor(() => expect(asked()?.open).toBe(true));
  press('Start QA');
  await vi.waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[0]).toMatchObject({ url: expect.stringMatching(/api\/qa-setup$/), body: { choice: 'dev' } });
  expect(posted[1]).toMatchObject({ url: expect.stringMatching(/api\/board\/move$/), body: { key: 'APP-2', to: 'qa' } });
  expect(asked()).toBeNull();
});

// The offline banner sits at the top of every page, inside a status region that is there before it, so
// a screen reader reads it once. The server builds it from the hub status and the signed document.
describe('the offline banner', () => {
  const solo = { ...FREE, id: 'acct-1', plan: 'solo' as const, features: ['cloud-board'], expiresAt: 4_000_000_000 };
  const banner = () => document.querySelector<HTMLElement>('[data-offline]');

  it('never shows on Free, even while the link is down', () => {
    at('/', {}, '/');
    place(Layout as never, { data: { ...LAYOUT, offline: offlineBanner('waiting', FREE) }, children: empty });

    expect(banner()).toBeNull();
    expect(document.querySelector('main > .offline > .live')?.getAttribute('role')).toBe('status');
  });

  it('shows on a paid machine whose link dropped, with the state in a word and no amber', () => {
    at('/', {}, '/');
    place(Layout as never, { data: { ...LAYOUT, display: solo, offline: offlineBanner('waiting', solo) }, children: empty });

    expect(banner()?.closest('[role="status"]')).toBe(document.querySelector('main > .offline > .live'));
    expect(banner()?.querySelector('.pill')?.textContent?.trim()).toBe('Offline');
    expect(banner()?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Offline The connection to the cloud dropped. Answers and approvals from the phone and the web app wait in the cloud until this machine connects again. Nolzu dials again by itself.',
    );
    expect(banner()?.querySelector('a')).toBeNull();
  });

  it('leads to the connection settings when the cloud refused the machine', () => {
    at('/', {}, '/');
    place(Layout as never, { data: { ...LAYOUT, display: solo, offline: offlineBanner('refused', solo) }, children: empty });

    expect(banner()?.querySelector('b')?.textContent).toBe('The cloud refused this machine.');
    expect(banner()?.querySelector('a')?.textContent).toBe('Open Settings, Cloud');
    expect(banner()?.querySelector('a')?.getAttribute('href')).toBe('./settings/cloud');
  });

  // A board fills the window, so the banner above it would push its key row out of view. The page
  // hands the banner's height down, and the board takes it off. jsdom lays nothing out, so this reads
  // the two sides of that wiring.
  it('hands its height to the board, which takes it off the window it fills', () => {
    const read = (file: string) => readFileSync(join(import.meta.dirname, '..', file), 'utf8');

    expect(read('routes/+layout.svelte')).toMatch(/<main style:--offline-height="\{offlineHeight\}px">[\s\S]*class="offline" bind:offsetHeight=\{offlineHeight\}>\s*<div class="live" role="status">/);
    expect(read('lib/BoardPage.svelte')).toContain('min-height: calc(100vh - var(--offline-height, 0px));');
    // Set up the project counts in the height too, but sits outside the status region, so a screen
    // reader does not read the whole list again on each change.
    expect(read('routes/+layout.svelte')).toMatch(/<ProjectFilesNotice [^>]*\/>\s*\{\/if\}\s*<\/div>[\s\S]*<SetupSteps [\s\S]*?<\/div>\s*\{@render children\(\)\}/);
  });
});

// The project files notice rides in the same status region, so a board takes its height off too. Settings,
// Project draws its own line under its button, so the notice stays off there.
describe('the project files notice', () => {
  const projectFiles = { updates: ['.agents/skills/nolzu-refine/SKILL.md'], yours: [], newer: null };
  const notice = () => document.querySelector<HTMLElement>('main > .offline [data-project-files]');

  it('shows on a board when the project has updates', () => {
    at('/b/[board]', { board: 'delivery' }, '/b/delivery');
    place(Layout as never, { data: { ...LAYOUT, project: 'recipes', projectFiles }, children: empty });

    expect(notice()?.textContent).toContain('Nolzu has newer project files for this project.');
  });

  it('stays off Settings, Project and off a project with nothing to update', () => {
    at('/settings/project', {}, '/settings/project');
    place(Layout as never, { data: { ...LAYOUT, project: 'recipes', projectFiles }, children: empty });
    expect(notice()).toBeNull();

    at('/b/[board]', { board: 'delivery' }, '/b/delivery');
    place(Layout as never, { data: { ...LAYOUT, project: 'recipes', projectFiles: { updates: [], yours: [], newer: null } }, children: empty });
    expect(notice()).toBeNull();
  });
});

describe('the card page head and decision panel', () => {
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'files', label: 'Files' },
    { id: 'log', label: 'Log' },
  ];
  const open = (key: string, tab: string, cards: CardView[], extra: Record<string, unknown> = {}) => {
    at('/t/[key]/[tab]', { key, tab }, `/t/${key}/${tab}`);
    place(Layout as never, { data: LAYOUT, children: empty });
    place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key }, tabs: TABS, runOn: null, counts: {}, ...extra }, children: empty });
    send(Source.opened[0], nowOf([{ ...boardFixture('pull-request', cards), quietAfterMs: 5 * 60_000 }]));
  };
  const words = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

  // The board draws its columns left to right, open cards first and the minimized strip after them.
  it('links K and J to the cards before and after this one in the board order, and presses them by key', () => {
    open('APP-3', 'files', [
      cardFixture({ key: 'APP-1', stage: 'refine', minimized: true }),
      cardFixture({ key: 'APP-2', stage: 'inbox' }),
      cardFixture({ key: 'APP-3', stage: 'refine' }),
      cardFixture({ key: 'APP-4', stage: 'plan' }),
    ]);
    const next = document.querySelector<HTMLAnchorElement>('[data-card="next"]')!;
    const pressed: string[] = [];
    next.addEventListener('click', (event) => {
      event.preventDefault();
      pressed.push('next');
    });

    expect(document.querySelector('[data-card="previous"]')?.getAttribute('href')).toMatch(/APP-2\/files$/);
    expect(next.getAttribute('href')).toMatch(/APP-1\/files$/);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    flushSync();
    expect(pressed).toEqual(['next']);
    // K must press the previous link, and not the next one.
    const previous = document.querySelector<HTMLAnchorElement>('[data-card="previous"]')!;
    previous.addEventListener('click', (event) => {
      event.preventDefault();
      pressed.push('previous');
    });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }));
    flushSync();
    expect(pressed).toEqual(['next', 'previous']);
  });

  it('draws the decision panel beside the overview, with the drop box line, and the tab counts', () => {
    open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'inbox' })], { counts: { files: '3' } });

    expect(words('[data-decision] h2')).toBe('Next step');
    expect(words('[data-decision="start"] .btn.go')).toBe('Start Refine');
    expect(words('[data-decision]')).toContain('Claude Code · haiku · low');
    expect(words('[data-decision]')).not.toContain('Starts:');
    expect(words('[data-tab="files"]')).toBe('Files 3');
  });

  // The Changes count asks git, so the layout streams it: the tab shows a grey pill until git
  // answers, and the page has drawn by then.
  it('shows the Changes count once git answers, and a grey pill before', async () => {
    let answer!: (counts: Record<string, string>) => void;
    const changes = new Promise<Record<string, string>>((done) => (answer = done));
    open('APP-1', 'files', [cardFixture({ key: 'APP-1', stage: 'inbox' })], { tabs: [...TABS, { id: 'changes', label: 'Changes' }], changes });

    expect(words('[data-tab="changes"]')).toBe('Changes counting the lines');
    expect(document.querySelector('[data-tab="changes"] [data-skeleton]')?.getAttribute('data-shape')).toBe('pill');
    answer({ changes: '+29 -3' });
    // The signs are drawn in the diff's green and red, and a screen reader hears the words instead.
    await vi.waitFor(() => expect(words('[data-tab="changes"]')).toBe('Changes +29 -3 29 lines added, 3 removed'));
    expect(words('[data-tab="changes"] .plus')).toBe('+29');
    expect(words('[data-tab="changes"] .minus')).toBe('-3');
    expect(document.querySelector('[data-tab="changes"] .plus')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  // The count git gave for one card is never the count of the next. Card to card in the same layout
  // instance, the tab shows the grey pill until the new card's git answers.
  it('drops the Changes count of the card it left while the next card waits on git', async () => {
    at('/t/[key]/[tab]', { key: 'APP-1', tab: 'files' }, '/t/APP-1/files');
    place(Layout as never, { data: LAYOUT, children: empty });
    const data = (key: string, changes: Promise<Record<string, string>>) => ({ ...LAYOUT, ticket: { ...ticket('delivery'), key }, tabs: [...TABS, { id: 'changes', label: 'Changes' }], runOn: null, counts: {}, models: null, changes });
    const view = mounted(CardLayout as unknown as Component<Record<string, unknown>>, { data: data('APP-1', Promise.resolve({ changes: '+29 -3' })), children: empty });
    try {
      send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'inbox' })])]));
      await vi.waitFor(() => expect(words('[data-tab="changes"]')).toBe('Changes +29 -3 29 lines added, 3 removed'));

      view.set({ data: data('APP-2', new Promise(() => {})) });
      expect(words('[data-tab="changes"]')).toBe('Changes counting the lines');
    } finally {
      view.remove();
    }
  });

  // Open diff comments make Send back with comments the panel's one amber button on a card in
  // Review, and the press posts to its own route for this card.
  it('offers Send back with comments while a comment is open, and posts it for this card', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (fetched.push(url), new Response('{}', { status: 200 }))));
    try {
      open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'review', state: 'idle' })], { openComments: 2 });

      expect(words('[data-decision="send-back"] .btn.go')).toBe('Send back to Implement with 2 comments');
      document.querySelector<HTMLButtonElement>('[data-run="send-back"]')!.click();
      await vi.waitFor(() => expect(fetched.some((url) => url.endsWith('/api/card/APP-1/send-back'))).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers no send back with no comment open', () => {
    open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'review', state: 'idle' })], { openComments: 0 });

    expect(document.querySelector('[data-run="send-back"]')).toBeNull();
  });

  it('draws no decision panel on another tab', () => {
    open('APP-1', 'files', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);

    expect(document.querySelector('[data-decision]')).toBeNull();
  });

  it.each([
    ['a card that asks', cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' }), 'Asks you'],
    ['a ready card', cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), 'Plan ready'],
    ['a QA FAIL', cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' }), 'QA failed'],
  ])('says the board card’s word in the head for %s', (_name, card, word) => {
    open('APP-1', 'overview', [card]);

    expect(words('header .pill')).toBe(word);
  });

  // A blocked card: the answer form is on the left, so the panel links no question. The phone
  // line is a cloud feature, so it is gone while the cloud is closed.
  it('shows a card that asks no amber button, and no phone line while the cloud is closed', () => {
    open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' })]);

    expect(document.querySelector('[data-decision] .btn.go')).toBeNull();
    expect(document.querySelector('[data-decision] a[href$="overview#asks"]')).toBeNull();
    expect(document.querySelector('[data-decision] [data-phone]')).toBeNull();
  });

  it('draws the phone line locked on Free once the cloud is open', () => {
    cloud.open = true;
    try {
      open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' })]);

      expect(document.querySelector('[data-decision] [data-phone="free"]')).not.toBeNull();
    } finally {
      cloud.open = false;
    }
  });

  // A run that printed nothing for the set time reads Quiet on the page as it does on the board. Half a
  // minute over ten, because the page's clock was read a moment before this test's.
  it('reads Quiet in the head for a quiet run', () => {
    const card = cardFixture({ key: 'APP-5', stage: 'plan', state: 'running', runId: 9, runState: 'running', runStartedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    open('APP-5', 'overview', [card]);
    nowLive.state = { ...nowLive.state, activity: { 'APP-5': { runId: 9, cardKey: 'APP-5', line: null, outputAt: Date.now() - 10.5 * 60_000 } } };
    flushSync();

    expect(words('header .pill')).toBe('Quiet 10m');
    expect(words('[data-decision]')).toContain('Plan has printed nothing for 10m');
    expect(words('[data-tab="log"]')).toBe('Log live');
  });

  // The right column reads the overview's data: the trail with who moved the card on an open card, and
  // the record of totals and every move on a closed one.
  describe('the right column', () => {
    const strip = [{ phase: 'refine', label: 'Refine', run: null, count: 0, spend: { runs: 0, reported: 0, costUsd: null, tokensOnly: 0, tokens: null, durationMs: 0, partial: false } }];
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const moves = [{ label: 'Refine', said: 'moved by you', at: ago(50), phase: 'refine' }, { label: 'Closed', said: 'moved by you', at: ago(8), phase: null }];
    afterEach(() => {
      page.data = {};
    });

    it('draws the trail on an open card', () => {
      page.data = { overview: { strip, spend: strip[0]!.spend, moves }, facts: Promise.resolve([]), closed: false };
      open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);

      expect(words('[aria-labelledby="trail"]')).toContain('Trail');
      expect(document.querySelector('[aria-label="Totals"]')).toBeNull();
    });

    // The branch is one git call, so the facts stream: a quiet placeholder holds their room,
    // then the facts draw in it.
    it('holds the room of the facts until git answers, then draws them', async () => {
      let answer!: (facts: { label: string; value: string }[]) => void;
      page.data = { overview: { strip, spend: strip[0]!.spend, moves }, facts: new Promise((done) => (answer = done)), closed: false };
      open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);

      expect(document.querySelector('.side [data-waiting]')?.getAttribute('aria-busy')).toBe('true');
      expect(document.querySelector('[aria-label="Facts"]')).toBeNull();
      answer([{ label: 'Branch', value: 'app-1-sort-recipes' }]);
      await vi.waitFor(() => expect(words('[aria-label="Facts"]')).toBe('Branch app-1-sort-recipes'));
      expect(document.querySelector('.side [data-waiting]')).toBeNull();
    });

    // The discoveries count moved from the left column to the facts, and it opens the file.
    it('links the discoveries fact to the file on the Files tab of this card', async () => {
      page.data = { overview: { strip, spend: strip[0]!.spend, moves }, facts: Promise.resolve([{ label: 'Discoveries', value: '3', file: 'discoveries.md' }, { label: 'Source', value: 'local ticket' }]), closed: false };
      open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);

      await vi.waitFor(() => expect(words('[aria-label="Facts"]')).toContain('Discoveries 3'));
      expect(document.querySelector<HTMLAnchorElement>('[data-fact-file="discoveries.md"]')?.getAttribute('href')).toMatch(/\/t\/APP-1\/files\?file=discoveries\.md$/);
      expect(document.querySelector('[data-fact-file="discoveries.md"]')?.getAttribute('aria-label')).toBe('Discoveries 3, open discoveries.md');
    });

    it('holds the room again when the page moves to another card, and never shows the facts of the one it left', async () => {
      page.data = { overview: { strip, spend: strip[0]!.spend, moves }, facts: Promise.resolve([{ label: 'Branch', value: 'app-1-sort-recipes' }]), closed: false };
      at('/t/[key]/[tab]', { key: 'APP-1', tab: 'overview' }, '/t/APP-1/overview');
      place(Layout as never, { data: LAYOUT, children: empty });
      const data = (key: string) => ({ ...LAYOUT, ticket: { ...ticket('delivery'), key }, tabs: TABS, runOn: null, counts: {}, models: null });
      const view = mounted(CardLayout as unknown as Component<Record<string, unknown>>, { data: data('APP-1'), children: empty });
      try {
        send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'inbox' })])]));
        await vi.waitFor(() => expect(words('[aria-label="Facts"]')).toBe('Branch app-1-sort-recipes'));

        view.set({ data: data('APP-2') });
        expect(document.querySelector('[aria-label="Facts"]')).toBeNull();
        expect(document.querySelector('.side [data-waiting]')).not.toBeNull();
      } finally {
        view.remove();
      }
    });

    it('draws the record in place of the trail on a closed card', () => {
      page.data = { overview: { strip, spend: strip[0]!.spend, moves }, facts: Promise.resolve([]), closed: true };
      open('APP-1', 'overview', [cardFixture({ key: 'APP-1', stage: 'closed' })]);

      expect(words('[aria-label="Totals"]')).toBe('none cost reported none agent time 0 runs');
      expect(words('[aria-labelledby="record"]')).toContain('Closed moved by you, 8 minutes ago');
      expect(document.querySelector('[aria-labelledby="record"] time')?.getAttribute('datetime')).toBe(moves[0]!.at);
      expect(document.querySelector('[aria-labelledby="trail"]')).toBeNull();
    });

    // The clock is set again as soon as the page mounts, so only the server render shows where it
    // starts. This reads the wiring: the server's time first, so the first paint says what the server
    // said.
    it('starts the clock of the times ago at the time the server drew the page with', () => {
      expect(readFileSync(join(import.meta.dirname, 't/[key]/+layout.svelte'), 'utf8')).toContain('let clock = $state(untrack(() => new Date(data.now)));');
    });
  });
});

// What the page sends, not only what it draws: a key off the overview and a pick in the panel each
// reach the route that writes them.
describe('the card page writes', () => {
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'files', label: 'Files' },
  ];
  let sent: { url: string; method: string; body: unknown }[] = [];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method: string; body: string }) => {
        // Relative to the page, as the browser reads the address the page builds.
        sent.push({ url: new URL(url, page.url).pathname, method: init.method, body: JSON.parse(init.body) as unknown });
        return new Response('{}', { status: 200 });
      }),
    );
  });
  const open = (tab: string, extra: Record<string, unknown> = {}, key = 'APP-1') => {
    at('/t/[key]/[tab]', { key, tab }, `/t/${key}/${tab}`);
    place(Layout as never, { data: LAYOUT, children: empty });
    place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key }, tabs: TABS, runOn: null, counts: {}, models: null, ...extra }, children: empty });
    send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key, stage: 'inbox' })])]));
  };
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    flushSync();
  };

  const later = () => new Promise<void>((done) => setTimeout(() => { flushSync(); done(); }, 0));

  // The Settings tab on a second card, so a key held as a literal in the page cannot pass: a pick, a
  // reset and a preset switch all write to the card in the address.
  it('writes the Settings tab picks, resets and preset switches to the card in the address', async () => {
    const resolved = { engine: 'claude-code', model: 'opus', effort: 'high', from: { model: 'card', effort: 'card' }, gone: false, missingProfile: false, refusal: null };
    const follows = { ...resolved, model: 'sonnet', effort: 'medium', from: { model: 'preset', effort: 'preset' } };
    const row = { action: 'implement', label: 'Implement', step: true, own: { engine: 'claude-code', model: 'opus' }, resolved, follows };
    const settings = { rows: [row], preset: 'default', board: 'Delivery', profiles: [{ id: 'claude-code', label: 'Claude Code', models: ['sonnet', 'opus'] }] };
    at('/t/[key]/[tab]', { key: 'APP-7', tab: 'settings' }, '/t/APP-7/settings');
    place(CardTab as never, { data: { board: 'delivery', current: 'settings', overview: null, files: null, groups: null, discussion: null, log: null, review: null, settings, repos: null } });

    const select = document.querySelector<HTMLSelectElement>('.row .pick select[data-pick="model"]')!;
    select.value = 'sonnet';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await later();
    document.querySelector<HTMLButtonElement>('[data-reset="implement"]')!.click();
    await later();
    [...document.querySelectorAll<HTMLButtonElement>('.presets button')].find((one) => one.textContent === 'Heavy')!.click();
    await later();

    expect(sent).toEqual([
      { url: '/api/card/APP-7/models', method: 'PATCH', body: { action: 'implement', engine: 'claude-code', model: 'sonnet' } },
      { url: '/api/card/APP-7/models', method: 'PATCH', body: { action: 'implement', reset: true } },
      { url: '/api/card/APP-7/models', method: 'PATCH', body: { preset: 'heavy' } },
    ]);
  });

  // Minimize sits in the header by the title, so M presses it on a tab with no panel too.
  it('minimizes the card by key on a tab with no panel', async () => {
    open('files');
    expect(document.querySelector('header [data-minimize]')?.getAttribute('aria-pressed')).toBe('false');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }));
    await settle();

    expect(sent).toEqual([{ url: '/api/board/minimize', method: 'POST', body: { key: 'APP-1', minimized: true } }]);
  });

  // A second card, so a key held as a literal in the page cannot pass.
  it('minimizes the card the page shows, from the header button and from the key', async () => {
    open('overview', {}, 'APP-7');
    expect(document.querySelectorAll('[data-minimize]')).toHaveLength(1);
    expect(document.querySelector('[aria-label^="Next step"] [data-minimize]')).toBeNull();
    document.querySelector<HTMLButtonElement>('header [data-minimize]')!.click();
    await settle();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }));
    await settle();

    expect(sent.map((one) => one.body)).toEqual([{ key: 'APP-7', minimized: true }, { key: 'APP-7', minimized: true }]);
  });

  it('minimizes by key off the overview on the card the page shows', async () => {
    open('files', {}, 'APP-7');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }));
    await settle();

    expect(sent.map((one) => one.body)).toEqual([{ key: 'APP-7', minimized: true }]);
  });

  it('retries the card the page shows, from the panel button', async () => {
    at('/t/[key]/[tab]', { key: 'APP-7', tab: 'overview' }, '/t/APP-7/overview');
    place(Layout as never, { data: LAYOUT, children: empty });
    place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key: 'APP-7' }, tabs: TABS, runOn: null, counts: {}, models: null }, children: empty });
    send(Source.opened[0], nowOf([boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'implement', state: 'failed' }), cardFixture({ key: 'APP-7', stage: 'plan', state: 'failed' })])]));
    expect(document.querySelector('[data-run="retry"]')?.textContent?.trim()).toBe('Retry Plan');
    document.querySelector<HTMLButtonElement>('[data-run="retry"]')!.click();
    await settle();

    expect(sent.map((one) => one.url)).toEqual(['/api/card/APP-7/retry']);
  });

  // A second card that failed QA too, so a key held as a literal in the page cannot pass.
  const qaFailed = () => {
    at('/t/[key]/[tab]', { key: 'APP-7', tab: 'overview' }, '/t/APP-7/overview');
    place(Layout as never, { data: LAYOUT, children: empty });
    place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key: 'APP-7' }, tabs: TABS, runOn: null, counts: {}, models: null }, children: empty });
    const failed = (key: string) => cardFixture({ key, stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
    send(Source.opened[0], nowOf([boardFixture('pull-request', [failed('APP-1'), failed('APP-7')])]));
  };

  it('fixes the card the page shows, from the amber Fix it in the panel', async () => {
    qaFailed();
    const button = document.querySelector<HTMLButtonElement>('[data-decision] [data-run="fix"]')!;
    expect(button.className).toMatch(/\bgo\b/);
    expect(button.textContent?.trim()).toBe('Fix it: run Implement again with this reason, then QA');
    button.click();
    await settle();

    expect(sent.map((one) => one.url)).toEqual(['/api/card/APP-7/fix']);
  });

  // Fix it is a paid run, so its session line reads the overview's own database read and never
  // waits on the facts git streams.
  it('names the Implement session Fix it resumes while the facts are still on their way', () => {
    page.data = { implementSession: '3c91e0b4', facts: new Promise(() => {}) };
    try {
      qaFailed();
      expect(document.querySelector('[data-decision]')?.textContent?.replace(/\s+/g, ' ')).toContain('Resumes implement session 3c91e0b4 with the reason.');
    } finally {
      page.data = {};
    }
  });

  // Fix it starts QA too, so a QA row whose model is gone refuses it, and the panel links to that row.
  it('links a refused Fix it to the QA row when the QA model is gone', () => {
    at('/t/[key]/[tab]', { key: 'APP-7', tab: 'overview' }, '/t/APP-7/overview');
    place(Layout as never, { data: LAYOUT, children: empty });
    place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('delivery'), key: 'APP-7' }, tabs: TABS, runOn: null, counts: {}, models: null }, children: empty });
    const board = boardFixture('pull-request', [cardFixture({ key: 'APP-7', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' })]);
    const stages = board.stages.map((stage) => (stage.id === 'qa' && stage.starts !== null ? { ...stage, starts: { ...stage.starts, model: 'old-model', modelState: 'gone' as const } } : stage));
    send(Source.opened[0], nowOf([{ ...board, stages }]));

    const button = document.querySelector<HTMLButtonElement>('[data-decision] [data-run="fix"]')!;
    expect(button.className).not.toMatch(/\bgo\b/);
    const refused = document.querySelector('[data-decision] .refused')!;
    expect(refused.textContent).toContain('QA uses old-model, which Claude Code no longer offers.');
    expect(refused.querySelector('a')?.textContent).toBe('Open Settings, Models');
  });

  // Accept anyway sends its line of reason with the move, for the trail.
  it('moves the card the page shows on to Review with the reason Accept anyway asked for', async () => {
    qaFailed();
    document.querySelector<HTMLButtonElement>('[data-accept="review"]')!.click();
    await settle();
    const field = document.querySelector<HTMLInputElement>('[data-reason]')!;
    field.value = 'The empty list is fine for now.';
    field.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('[data-decision] [data-move="review"]')!.click();
    await settle();

    expect(sent).toEqual([{ url: '/api/board/move', method: 'POST', body: { key: 'APP-7', to: 'review', reason: 'The empty list is fine for now.' } }]);
  });

  // R on a QA FAIL asks first, naming both runs, and Confirm presses Fix it.
  it('asks before Fix it on R, and Confirm sends it for the card the page shows', async () => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    qaFailed();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
    await settle();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-start-confirm]')!;
    expect(dialog.textContent).toContain('Fix APP-7: Implement, then QA');
    expect(sent).toEqual([]);

    dialog.querySelector<HTMLButtonElement>('[data-confirm]')!.click();
    await settle();

    expect(sent.map((one) => one.url)).toEqual(['/api/card/APP-7/fix']);
  });

  it('writes a pick in the panel to the card’s own row of the phase the button starts', async () => {
    const row = { action: 'refine', own: {}, resolved: { engine: 'claude-code', model: 'haiku', effort: 'low' }, models: ['haiku', 'sonnet'] };
    open('overview', { models: { rows: [row], preset: 'default', profiles: [{ id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet'] }] } }, 'APP-7');
    const model = document.querySelector<HTMLSelectElement>('[data-decision] .pick select[data-pick="model"]')!;
    model.value = 'sonnet';
    model.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    // Engine and model in one write, never one without the other.
    expect(sent).toEqual([{ url: '/api/card/APP-7/models', method: 'PATCH', body: { action: 'refine', engine: 'claude-code', model: 'sonnet' } }]);
  });
});

// The Review tab of a pull request card: the decision panel beside the round says
// why another round makes sense, Agent pre-review is its amber button once a push sent the card back to
// Incoming, and Copy all findings copies the round.
describe('the decision panel beside the Review tab', () => {
  const agent = (id: string, label: string) =>
    stageFixture({ id, label, role: 'agent', starts: { phase: 'pr-review', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null } });
  const stages = [
    stageFixture({ id: 'incoming', label: 'Incoming', role: 'you' }),
    agent('pre-review', 'Agent pre-review'),
    stageFixture({ id: 'my-review', label: 'My review', role: 'you' }),
    stageFixture({ id: 'awaiting-author', label: 'Awaiting author', role: 'auto' }),
    stageFixture({ id: 'approved', label: 'Approved', role: 'you' }),
    stageFixture({ id: 'closed', label: 'Closed', role: 'archive' }),
  ];
  const round = parseRound('issue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n\npraise: src/recipes/list.ts:14\nThe list reads in one pass.\n');
  const blocks = round.ok ? round.blocks : [];
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'review', label: 'Review' },
    { id: 'files', label: 'Files' },
  ];
  const open = (stage: string) => {
    at('/t/[key]/[tab]', { key: 'APP-1', tab: 'review' }, '/t/APP-1/review');
    place(Layout as never, { data: LAYOUT, children: empty });
    place(CardLayout as never, { data: { ...LAYOUT, ticket: { ...ticket('prreview'), stage }, tabs: TABS, runOn: null, counts: {}, models: null }, children: empty });
    send(Source.opened[0], nowOf([{ ...boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage })]), kind: 'prreview', stages }]));
  };
  const words = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  beforeEach(() => {
    page.data = { review: { current: 2, blocks, why: 'dana pushed 1 commit after round 2. 1 finding from round 2 is still open.' } };
  });
  afterEach(() => {
    page.data = {};
  });

  it('says why another round makes sense over the amber Agent pre-review button', () => {
    open('incoming');

    expect(words('[data-why]')).toBe('dana pushed 1 commit after round 2. 1 finding from round 2 is still open.');
    expect(words('[data-decision="start"] .btn.go')).toBe('Start Agent pre-review');
  });

  // The tab has no button of its own that starts a round, so this is the one press on it that starts a
  // paid run. It goes to the board route, the one path that moves a card and starts the stage's phase.
  it('sends the move onto Agent pre-review for the card the page shows when the button is pressed', async () => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        sent.push({ url: new URL(url, page.url).pathname, body: JSON.parse(init.body) as unknown });
        return new Response('{}', { status: 200 });
      }),
    );
    open('incoming');

    document.querySelector<HTMLButtonElement>('[data-decision="start"] .btn.go')!.click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent).toEqual([{ url: '/api/board/move', body: { key: 'APP-1', to: 'pre-review' } }]);
  });

  // From My review the next step is the plain move to the author, which starts nothing.
  it('says no reason while the next step is not a review round', () => {
    open('my-review');

    expect(document.querySelector('[data-why]')).toBeNull();
    expect(document.querySelector('[data-decision] .btn.go')).toBeNull();
    expect(words('[data-decision] [data-move="awaiting-author"]')).toBe('Move to Awaiting author');
  });

  it('copies the shown round as conventional comments onto the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      open('awaiting-author');
      document.querySelector<HTMLButtonElement>('[data-copy-all]')!.click();
      await vi.waitFor(() => expect(words('[data-decision]')).toContain('Round 2 is on the clipboard.'));

      expect(writeText).toHaveBeenCalledWith('issue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n\npraise: src/recipes/list.ts:14\nThe list reads in one pass.');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
