import type { NotificationItem } from '@nolzu/core/node';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import { FREE } from './display.ts';
import NotificationsPanel from './NotificationsPanel.svelte';
import Rail from './Rail.svelte';

// The bell and its panel. The list comes from the GET, opening it posts the read, and Esc gives the
// focus back to the bell. The fetch stands in for the server.

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

const item = (id: string, over: Partial<NotificationItem> = {}): NotificationItem => ({ id, at: new Date().toISOString(), kind: 'success', card: null, text: id, href: null, read: false, ...over });

let instances: object[] = [];
let target: HTMLElement | null = null;
let listed: NotificationItem[] = [];
const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : listed)));

beforeEach(() => {
  drawnAt('/');
  fetched.mockClear();
  vi.stubGlobal('fetch', fetched);
  target = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  for (const one of instances) void unmount(one);
  instances = [];
  target?.remove();
  target = null;
  vi.unstubAllGlobals();
});

const rail = (props: Record<string, unknown>) => {
  instances.push(mount(Rail, { target: target!, props: { routeId: '/', project: null, display: FREE, ontheme: () => {}, ...props } }));
  flushSync();
  return target!.querySelector<HTMLButtonElement>('button.bell');
};

const settle = async () => {
  for (let n = 0; n < 5; n += 1) await tick();
  flushSync();
};

it('draws the bell with its unread count, folded on a board as well, and no badge at none', () => {
  const bell = rail({ unread: 3, onbell: () => {} });
  expect(bell?.getAttribute('aria-label')).toBe('Notifications, 3 unread');
  expect(bell?.querySelector('[data-unread]')?.textContent).toBe('3');
  target!.replaceChildren();

  const folded = rail({ compact: true, routeId: '/b/[board]', board: 'delivery', unread: 0, onbell: () => {} });
  expect(folded?.getAttribute('aria-label')).toBe('Notifications');
  expect(folded?.querySelector('[data-unread]')).toBeNull();
});

it('lists the kept items newest first, links each to its card, and reads them all once open', async () => {
  listed = [item('scout:1', { kind: 'info', text: 'Scout: 1 new finding', href: '/scout' }), item('run:1', { card: 'APP-1', text: 'Plan finished', read: true })];
  instances.push(mount(NotificationsPanel, { target: target!, props: { onclose: () => {} } }));
  flushSync();
  // Grey rows while the list is on its way, with the words for a screen reader.
  expect(document.querySelector('[data-skeleton]')?.getAttribute('data-shape')).toBe('rows');
  expect(document.querySelector('[data-skeleton] .sr')?.textContent).toBe('Reading the notifications.');
  await settle();
  expect(document.querySelector('[data-skeleton]')).toBeNull();

  const rows = [...document.querySelectorAll<HTMLElement>('[data-notification]')];
  expect(rows.map((row) => row.dataset.notification)).toEqual(['scout:1', 'run:1']);
  expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/scout');
  expect(rows[1]?.querySelector('a')?.getAttribute('href')).toMatch(/\/t\/APP-1$/);
  // New only on the one that was unread when the panel opened.
  expect(rows.map((row) => row.querySelector('[data-new]') !== null)).toEqual([true, false]);
  expect(fetched.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
    ['./api/notifications', 'GET'],
    ['./api/notifications', 'POST'],
  ]);
});

it('shows one that came in on the stream after the list was read, at the top', async () => {
  listed = [item('run:1')];
  instances.push(mount(NotificationsPanel, { target: target!, props: { newest: [item('run:2'), item('run:1')], onclose: () => {} } }));
  await settle();

  expect([...document.querySelectorAll<HTMLElement>('[data-notification]')].map((row) => row.dataset.notification)).toEqual(['run:2', 'run:1']);
});

it('closes on Esc and gives the focus back to the bell', async () => {
  listed = [];
  let open = false;
  const bell = rail({ onbell: () => (open = true) });
  bell!.click();
  expect(open).toBe(true);
  expect(document.activeElement).toBe(bell);

  const onclose = vi.fn();
  instances.push(mount(NotificationsPanel, { target: target!, props: { onclose } }));
  await settle();
  // Scout is off as shipped, so the empty line names no Scout find.
  expect(document.body.textContent).toContain('Nothing yet. A run that ends, a card that asks you and a usage window near its limit show here.');

  document.querySelector('dialog')!.close();
  expect(onclose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(bell);
});

// The panel is modal, so the page behind it is inert and a click outside the sheet, the bell's spot
// as well, lands on the dialog's backdrop: the dialog itself, outside its box. The box is drawn on the
// right, which a mount test has no layout for.
const opened = async (onclose: () => void) => {
  instances.push(mount(NotificationsPanel, { target: target!, props: { onclose } }));
  await settle();
  const dialog = document.querySelector('dialog')!;
  dialog.getBoundingClientRect = () => DOMRect.fromRect({ x: 600, y: 0, width: 400, height: 800 });
  return dialog;
};
const down = (on: Element, clientX: number, clientY = 100) => on.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY }));
const up = (on: Element, clientX: number, clientY = 100) => on.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
const press = (on: Element, clientX: number, clientY = 100) => {
  down(on, clientX, clientY);
  up(on, clientX, clientY);
};

it('closes on a click outside the sheet, and a click on the bell closes it with no reopen', async () => {
  listed = [];
  let opens = 0;
  const bell = rail({ onbell: () => (opens += 1) });
  bell!.click();
  const onclose = vi.fn();
  const dialog = await opened(onclose);

  // On the bell's spot, at the left of the page. The press alone keeps it open: closed then, the page
  // would wake and the release would land on the bell.
  down(dialog, 20, 40);
  expect(dialog.open).toBe(true);
  up(dialog, 20, 40);
  expect(onclose).toHaveBeenCalledOnce();
  expect(dialog.open).toBe(false);
  expect(opens).toBe(1);
  expect(document.activeElement).toBe(bell);
});

it('stays open on a click in the sheet and on a drag that ends outside, and an item link closes it once', async () => {
  listed = [item('scout:1', { href: '/scout' })];
  const onclose = vi.fn();
  const dialog = await opened(onclose);

  // The empty foot of the full-height sheet is the dialog itself, inside its box.
  press(dialog, 700, 700);
  // Text chosen with a drag from the list out past the edge: the click lands on the dialog outside.
  down(dialog.querySelector('.item')!, 700);
  up(dialog, 20);
  // A drag from outside into the sheet.
  down(dialog, 20);
  up(dialog, 700);
  // A click on an item at a point past the edge, as a key press on a focused control sends at 0, 0.
  down(dialog, 20);
  up(dialog.querySelector('.item')!, 20);
  expect(onclose).not.toHaveBeenCalled();

  const link = dialog.querySelector('a')!;
  link.addEventListener('click', (event) => event.preventDefault());
  press(link, 700, 100);
  expect(onclose).toHaveBeenCalledOnce();
});

it('closes on a click past the other edges of the box as well', async () => {
  listed = [];
  for (const [x, y] of [[1100, 100], [700, -10], [700, 900]] as const) {
    const onclose = vi.fn();
    const dialog = await opened(onclose);
    press(dialog, x, y);
    expect(onclose).toHaveBeenCalledOnce();
    await unmount(instances.pop()!);
  }
});
