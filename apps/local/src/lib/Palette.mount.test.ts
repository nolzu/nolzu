import type { BoardSnapshot } from '@nolzu/protocol';
import { type Binding, type KeyActions, Keyboard, scoped } from '@nolzu/ui';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { goto } from '$app/navigation';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import NowRoute from '../routes/+page.svelte';
import BoardPage from './BoardPage.svelte';
import type { NowSnapshot } from './now.ts';
import { nowLive } from './now-live.svelte.ts';
import { NO_TOASTS } from './board-page.ts';
import { pageKeys } from './page-keys.svelte.ts';
import { type QaAskOpen, qaAsk } from './qa-ask.svelte.ts';
import Palette from './Palette.svelte';
import ToastCorner from './ToastCorner.svelte';
import { toastStack } from './toast-stack.svelte.ts';

// The palette for real, beside the one key handler, as the root layout mounts them: Cmd K opens it,
// the field has the keys, and Enter runs the chosen row. The cards come from the Now state the layout's
// one stream writes, so a test writes that state the way the stream does. fetch answers every write
// with 200 unless a test says otherwise.

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

const posted = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
let parts: { instance: object; target: HTMLElement }[] = [];

beforeEach(() => {
  posted.mockClear();
  vi.mocked(goto).mockClear();
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
  toastStack.state = NO_TOASTS;
  vi.stubGlobal('fetch', posted);
  if (globalThis.CSS?.escape === undefined) vi.stubGlobal('CSS', { escape: (value: string) => value });
  drawnAt('/');
});

afterEach(() => {
  for (const part of parts) {
    void unmount(part.instance);
    part.target.remove();
  }
  parts = [];
  vi.unstubAllGlobals();
});

const place = <T extends Record<string, unknown>>(component: Parameters<typeof mount>[0], props: Record<string, unknown>): T => {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(component, { target, props }) as T;
  parts.push({ instance, target });
  flushSync();
  return instance;
};

const nowOf = (board: BoardSnapshot): NowSnapshot => ({
  version: board.version,
  boards: [board],
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 0, fresh: 0, newest: null },
});

// The key handler and the palette with the same keys and actions, and Cmd K bound to the palette, as
// the layout binds them, with the layout's one toast corner.
function both(keys: readonly Binding[], actions: KeyActions) {
  let palette: { show: () => Promise<void> } | null = null;
  const all = { ...actions, palette: () => void palette?.show() };
  const list = [...scoped('global'), ...keys];
  palette = place<{ show: () => Promise<void> }>(Palette as never, { keys: list, actions: all });
  place(Keyboard as never, { keys: list, actions: all });
  place(ToastCorner as never, {});
}

function key(name: string, over: KeyboardEventInit = {}, from: Element = document.activeElement ?? document.body): boolean {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...over });
  from.dispatchEvent(event);
  flushSync();
  return event.defaultPrevented;
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-palette]');
const field = () => dialog()!.querySelector<HTMLInputElement>('input')!;
const row = (id: string) => dialog()!.querySelector<HTMLElement>(`[data-row="${id}"]`);

async function openPalette(): Promise<void> {
  key('k', { metaKey: true });
  await vi.waitFor(() => expect(document.activeElement).toBe(dialog()?.querySelector('input')));
}

function type(text: string): void {
  field().value = text;
  field().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

it('posts the same move on Enter as a drop on the next column', async () => {
  place(BoardPage as never, {});
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])) };
  flushSync();
  both(pageKeys.now!.keys, pageKeys.now!.actions);

  const card = document.querySelector<HTMLElement>('article[data-card="APP-1"]')!;
  const refine = document.querySelector<HTMLElement>('section[data-stage="refine"]')!;
  card.dispatchEvent(new Event('dragstart', { bubbles: true }));
  flushSync();
  refine.dispatchEvent(new Event('dragenter', { bubbles: true }));
  flushSync();
  refine.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  flushSync();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  const dropped = posted.mock.calls[0];
  expect(dropped?.[0]).toBe('./api/board/move');
  expect(dropped?.[1].body).toBe(JSON.stringify({ key: 'APP-1', to: 'refine' }));

  // The stream never said the card moved, so it is still in Inbox, and the palette offers Refine.
  await openPalette();
  type('move app-1');
  const move = row('move:APP-1:refine')!;
  expect(move.getAttribute('aria-selected')).toBe('true');
  // The chosen row shows the Enter cap.
  expect(move.textContent?.replace(/\s+/g, ' ').trim()).toBe('Move to Refine starts Claude Code · haiku · low ↵');
  // The bolt of a move that starts a run is the palette's one amber mark, and its Starts line is mono.
  expect(dialog()!.querySelectorAll('.ico.amber')).toHaveLength(1);
  expect(move.querySelector('.ico.amber')).not.toBeNull();
  expect(move.classList.contains('starts')).toBe(true);
  expect(move.querySelector('.hint.mono')).not.toBeNull();
  // Only the chosen row has the Enter cap.
  expect(row('model:APP-1')!.textContent).not.toContain('↵');
  // Showing the row sends nothing. Enter is the consent.
  expect(posted).toHaveBeenCalledOnce();

  key('Enter', {}, field());
  expect(dialog()).toBeNull();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(posted.mock.calls[1]).toEqual(dropped);
});

// Read through a call, so the type is not narrowed to the null the test set.
const asked = (): QaAskOpen | null => qaAsk.state;

// Enter on a move row into QA asks how QA gets the app, for the card of the row, and sends nothing until
// Start QA sends the move.
it('asks the question at the first QA on Enter on a move row, and sends the move once it is answered', async () => {
  qaAsk.state = null;
  const qaSetup = { project: 'recipes', repo: null, dev: null, scripts: '', unwalled: null, address: '', test: null, playwright: false, chrome: false, browser: false };
  nowLive.state = { ...nowLive.state, snapshot: { ...nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'implement', state: 'ready' })])), qaSetup } };
  both([], {});

  await openPalette();
  type('app-2 move');
  key('Enter', {}, field());
  await Promise.resolve();

  expect(posted).not.toHaveBeenCalled();
  expect(asked()?.key).toBe('APP-2');
  void asked()?.go();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-2', to: 'qa' }));
  qaAsk.state = null;
});

it('raises the refused toast with its fix link on Enter on a start the drop would refuse, and sends nothing', async () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const gone = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } } : stage)) };
  nowLive.state = { ...nowLive.state, snapshot: nowOf(gone) };
  both([], {});

  await openPalette();
  type('app-1 move');
  expect(row('move:APP-1:refine')?.querySelector('.ico.amber')).toBeNull();
  // A refused move is not amber, and its reason is a sentence, so it is not mono.
  expect(row('move:APP-1:refine')?.classList.contains('starts')).toBe(false);
  expect(row('move:APP-1:refine')?.querySelector('.hint:not(.mono)')).not.toBeNull();
  key('Enter', {}, field());

  const toast = document.querySelector<HTMLElement>('.toast[data-kind="error"]');
  expect(toast?.querySelector('.message')?.textContent).toBe('APP-1 did not move to Refine');
  expect(toast?.querySelector('[data-toast-link]')?.getAttribute('href')).toBe('./settings/models');
  expect(posted).not.toHaveBeenCalled();
});

it('closes on Esc and gives focus back to what had it', async () => {
  both([], {});
  const button = document.body.appendChild(document.createElement('button'));
  button.focus();

  await openPalette();
  expect(dialog()!.open).toBe(true);
  key('Escape', {}, field());

  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button);
  button.remove();
});

// The palette draws its own dialog, so it closes on a backdrop click through the same rule as `Dialog`:
// the press and the click both outside the box, here 100 to 300 across and down.
it('closes on a click on the backdrop, and not after a drag from the field that ends there', async () => {
  both([], {});
  await openPalette();
  const at = dialog()!;
  at.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200, x: 100, y: 100, toJSON: () => ({}) });
  const click = (down: Element, [x, y]: [number, number]) => {
    down.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 150, clientY: 150 }));
    at.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    flushSync();
  };

  click(field(), [20, 20]);
  expect(dialog()!.open).toBe(true);

  at.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
  at.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));
  flushSync();
  expect(dialog()).toBeNull();
});

// The browser would take Cmd K for its own search field, in a text field and in the palette's own.
it('opens from a text field, keeps Cmd K from the browser while open, and gives focus back to the field', async () => {
  both([], {});
  const answer = document.body.appendChild(document.createElement('textarea'));
  onTestFinished(() => answer.remove());
  answer.value = 'Use the tags table';
  answer.focus();

  await openPalette();
  expect(key('k', { metaKey: true }, field())).toBe(true);
  expect(dialog()!.open).toBe(true);
  key('Escape', {}, field());

  expect(document.activeElement).toBe(answer);
  expect(answer.value).toBe('Use the tags table');
});

// The palette is a dialog, so the keys of the page under it do nothing while it is open, typed into
// the field or pressed with focus fallen to the body. They work again once it closes.
it('keeps the page keys from firing while it is open', async () => {
  const add = vi.fn();
  const filter = vi.fn();
  both(scoped('board'), { add, filter });

  await openPalette();
  key('n', {}, field());
  key('w', {}, field());
  key('n', {}, document.body);
  key('?', {}, document.body);
  expect(add).not.toHaveBeenCalled();
  expect(filter).not.toHaveBeenCalled();
  expect(document.querySelector('dialog[data-key-help]')).toBeNull();

  key('Escape', {}, field());
  key('n', {}, document.body);
  expect(add).toHaveBeenCalledOnce();
});

it('runs the same action as the key, from a row that shows the key', async () => {
  const add = vi.fn();
  both(scoped('board'), { add });

  await openPalette();
  type('add');
  const shown = row('key:add')!;
  expect([...shown.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual(['N']);
  expect(shown.querySelector('.hidden')?.textContent).toBe('N');
  key('Enter', {}, field());

  expect(dialog()).toBeNull();
  expect(add).toHaveBeenCalledOnce();
});

it('lets a screen reader follow the chosen row through the listbox', async () => {
  both([], { 'go:now': vi.fn(), 'go:delivery': vi.fn() });

  await openPalette();
  const list = document.getElementById(field().getAttribute('aria-controls')!)!;
  expect(field().getAttribute('role')).toBe('combobox');
  expect(list.getAttribute('role')).toBe('listbox');
  const chosen = () => document.getElementById(field().getAttribute('aria-activedescendant')!);
  expect(chosen()?.getAttribute('role')).toBe('option');
  expect(chosen()?.getAttribute('aria-selected')).toBe('true');
  expect(chosen()?.textContent).toContain('Now');
  // G then N is said in words, and drawn as two caps with no "then" between them.
  expect([...chosen()!.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual(['G', 'N']);
  expect(chosen()?.querySelector('.hidden')?.textContent).toBe('G then N');

  key('ArrowDown', {}, field());
  expect(chosen()?.textContent).toContain('Delivery');
  expect(list.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  key('ArrowUp', {}, field());
  key('ArrowUp', {}, field());
  expect(chosen()?.textContent).toContain('Now');
});

it('opens the card of the chosen row on Cmd Enter, and says so when nothing matches', async () => {
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])) };
  both([], {});

  await openPalette();
  type('zzz');
  expect(dialog()!.querySelector('.none')?.textContent).toBe('Nothing matches “zzz”. Search for a card by its key or title, or for a screen.');
  type('app-1');
  expect(dialog()!.querySelector('.none')?.textContent).toBe('');
  key('Enter', { metaKey: true }, field());

  expect(dialog()).toBeNull();
  expect(goto).toHaveBeenCalledWith('./t/APP-1');
});

// A snapshot that lands while the palette is open never moves Enter onto a move nobody chose: not when
// the chosen move goes, and not when its card moved on and the move now leads to the column after.
it('leaves nothing chosen when the chosen move leaves the list, and sends nothing on Enter', async () => {
  const at = (...cards: Parameters<typeof cardFixture>[0][]) => {
    nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', cards.map(cardFixture))) };
    flushSync();
  };
  at({ key: 'APP-1', stage: 'inbox' }, { key: 'APP-2', stage: 'inbox' });
  both([], {});

  await openPalette();
  type('app');
  key('ArrowDown', {}, field());
  key('ArrowDown', {}, field());
  key('ArrowDown', {}, field());
  expect(row('move:APP-2:refine')!.getAttribute('aria-selected')).toBe('true');
  // Another tab started APP-2, so it has no move. APP-1's move is still there, and stays unchosen.
  at({ key: 'APP-1', stage: 'inbox' }, { key: 'APP-2', stage: 'refine', state: 'running' });
  expect(row('move:APP-1:refine')).not.toBeNull();
  expect(dialog()!.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
  expect(field().hasAttribute('aria-activedescendant')).toBe(false);
  key('Enter', {}, field());
  expect(dialog()).not.toBeNull();

  // The arrow chooses again. Then APP-1 moves on, and its move leads to the next column.
  key('ArrowDown', {}, field());
  expect(row('move:APP-1:refine')!.getAttribute('aria-selected')).toBe('true');
  at({ key: 'APP-1', stage: 'refine' }, { key: 'APP-2', stage: 'refine', state: 'running' });
  expect(row('move:APP-1:refine')).toBeNull();
  expect(dialog()!.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
  key('Enter', {}, field());

  await Promise.resolve();
  expect(posted).not.toHaveBeenCalled();
});

it('raises the reason the board gave when it refuses the move, as it does for a drop', async () => {
  posted.mockImplementationOnce(async () => new Response(JSON.stringify({ message: 'APP-1 moved on in another tab.' }), { status: 409 }));
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])) };
  both([], {});

  await openPalette();
  type('move app-1');
  key('Enter', {}, field());

  await vi.waitFor(() => expect(document.querySelector('.toast[data-kind="error"] .message')?.textContent).toBe('APP-1: APP-1 moved on in another tab.'));
  expect(posted).toHaveBeenCalledOnce();
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-1', to: 'refine' }));
});

// One corner, one stack: under the board, the palette's refusal joins the board's toasts.
it('raises its toast in the one corner under the board', async () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const gone = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } } : stage)) };
  place(BoardPage as never, {});
  nowLive.state = { ...nowLive.state, snapshot: nowOf(gone) };
  flushSync();
  both(pageKeys.now!.keys, pageKeys.now!.actions);

  await openPalette();
  type('move app-1');
  key('Enter', {}, field());

  expect(document.querySelectorAll('.toasts')).toHaveLength(1);
  expect(document.querySelector('.toasts .toast[data-kind="error"] .message')?.textContent).toBe('APP-1 did not move to Refine');
  expect(posted).not.toHaveBeenCalled();
});

// The same on Now, which draws no corner of its own either.
it('raises its toast in the one corner under Now', async () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const gone = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } } : stage)) };
  nowLive.state = { ...nowLive.state, snapshot: nowOf(gone) };
  place(NowRoute as never, {});
  both(pageKeys.now!.keys, pageKeys.now!.actions);

  await openPalette();
  type('move app-1');
  key('Enter', {}, field());

  expect(document.querySelectorAll('.toasts')).toHaveLength(1);
  expect(document.querySelector('.toasts .toast[data-kind="error"] .message')?.textContent).toBe('APP-1 did not move to Refine');
});

// The card goes on the board this tab was last on, and on Delivery before any board.
it('opens Add card on the last board from a screen where N adds none', async () => {
  sessionStorage.clear();
  both([], {});

  await openPalette();
  type('add');
  // N does nothing here, so the row has no N cap, only the Enter cap of the chosen row.
  expect([...row('add')!.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual(['↵']);
  key('Enter', {}, field());

  expect(goto).toHaveBeenCalledWith('./b/delivery?add');

  sessionStorage.setItem('nolzu.lastBoard', 'epics');
  await openPalette();
  type('add');
  key('Enter', {}, field());
  expect(goto).toHaveBeenLastCalledWith('./b/epics?add');
  sessionStorage.clear();
});

// Most tests drive APP-1 alone. With two other cards in other columns, each row acts on its own card
// and sends that card's own next column.
it('moves and refuses the card the row names, into the next column of that card', async () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'APP-3', stage: 'inbox' }), cardFixture({ key: 'APP-5', stage: 'qa', state: 'ready' })]);
  const gone = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } } : stage)) };
  nowLive.state = { ...nowLive.state, snapshot: nowOf(gone) };
  both([], {});

  await openPalette();
  type('move app-5');
  key('Enter', {}, field());
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/board/move');
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-5', to: 'review' }));

  await openPalette();
  type('move app-3');
  key('Enter', {}, field());
  expect(document.querySelector('.toast[data-kind="error"] .message')?.textContent).toBe('APP-3 did not move to Refine');
  expect(posted).toHaveBeenCalledOnce();
});

// Ctrl Enter is Cmd Enter off a Mac. It opens the card and never runs the chosen move. A key such as
// app#42 is encoded in the address, or the # would cut it short.
it('opens the card of the chosen move on Ctrl Enter, with its key encoded', async () => {
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'app#42', stage: 'inbox' })])) };
  both([], {});

  await openPalette();
  type('move app 42');
  expect(row('move:app#42:refine')!.getAttribute('aria-selected')).toBe('true');
  key('Enter', { ctrlKey: true }, field());

  expect(dialog()).toBeNull();
  expect(goto).toHaveBeenCalledWith('./t/app%2342');
  expect(posted).not.toHaveBeenCalled();
});
