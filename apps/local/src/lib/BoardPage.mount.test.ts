import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { goto, invalidateAll } from '$app/navigation';
import type { BoardSnapshot, ProfileLimit } from '@nolzu/protocol';
import { Keyboard } from '@nolzu/ui';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page } from '../../../../test/stubs/app-state.ts';
import BoardPage from './BoardPage.svelte';
import type { NowSnapshot } from './now.ts';
import { nowLive } from './now-live.svelte.ts';
import { NO_TOASTS } from './board-page.ts';
import { follow } from './follow.svelte.ts';
import { pageKeys } from './page-keys.svelte.ts';
import { type QaAskOpen, qaAsk } from './qa-ask.svelte.ts';
import { type SetupGateOpen, setupGate } from './setup-gate.svelte.ts';
import ToastCorner from './ToastCorner.svelte';
import { toastStack } from './toast-stack.svelte.ts';

// The board page for real: the board out of the Now state, its keys through the one handler, its drop
// and its toasts. The page reads the state the layout's one stream writes, so a test writes that state
// the way the stream does, and its toasts go to the app's one stack, which the layout's one corner draws.
// routes/layout.mount.test.ts holds the stream and the corner itself. fetch answers every write with 200.

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }));

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
  localStorage.clear();
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
  toastStack.state = NO_TOASTS;
  vi.stubGlobal('fetch', posted);
  if (globalThis.CSS?.escape === undefined) vi.stubGlobal('CSS', { escape: (value: string) => value });
});

afterEach(() => {
  for (const part of parts) {
    void unmount(part.instance);
    part.target.remove();
  }
  parts = [];
  vi.unstubAllGlobals();
});

const place = (component: Parameters<typeof mount>[0], props: Record<string, unknown>) => {
  const target = document.body.appendChild(document.createElement('div'));
  parts.push({ instance: mount(component, { target, props }), target });
  flushSync();
};

// What the stream writes: Now's view, which carries every board that is on.
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

// The page, with the layout's one key handler and its one toast corner beside it.
function open(snapshot: BoardSnapshot) {
  drawnAt('/');
  place(BoardPage as never, {});
  place(ToastCorner as never, {});
  nowLive.state = { ...nowLive.state, snapshot: nowOf(snapshot) };
  flushSync();
  place(Keyboard as never, { keys: pageKeys.now!.keys, actions: pageKeys.now!.actions });
  return {
    card: (key: string) => document.querySelector<HTMLElement>(`article[data-card="${key}"]`)!,
    column: (id: string) => document.querySelector<HTMLElement>(`section[data-stage="${id}"]`)!,
  };
}

function drop(ui: ReturnType<typeof open>, key: string, stage: string): void {
  ui.card(key).dispatchEvent(new Event('dragstart', { bubbles: true }));
  flushSync();
  ui.column(stage).dispatchEvent(new Event('dragenter', { bubbles: true }));
  flushSync();
  ui.column(stage).dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  flushSync();
}

function shiftRight(ui: ReturnType<typeof open>, key: string): void {
  ui.card(key).focus();
  flushSync();
  ui.card(key).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
  flushSync();
}

it('posts the same move on Shift Right then Enter as a drop on the next column', async () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));

  drop(ui, 'APP-1', 'refine');
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  const dropped = posted.mock.calls[0];
  expect(dropped?.[0]).toBe('./api/board/move');
  expect(dropped?.[1].body).toBe(JSON.stringify({ key: 'APP-1', to: 'refine' }));

  // The stream never said the card moved, so it is still in Inbox and the key moves it to Refine.
  shiftRight(ui, 'APP-1');
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-start-confirm]')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Move APP-1 to Refine');
  expect(dialog.textContent).toContain('Starts: Claude Code · haiku · low');
  // Asking sends nothing.
  expect(posted).toHaveBeenCalledOnce();

  // jsdom presses no button on Enter, so the key goes to the dialog box, which StartConfirm answers
  // itself. In a browser Enter presses Confirm, which has the focus.
  expect(document.activeElement).toBe(dialog.querySelector('[data-confirm]'));
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();

  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(posted.mock.calls[1]).toEqual(dropped);
});

it('raises the toast that names the column and links the setting, on a refused drop and a refused key', async () => {
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const gone = { ...snapshot, stages: snapshot.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } } : stage)) };
  const ui = open(gone);
  const toast = () => document.querySelector<HTMLElement>('.toast[data-kind="error"]');

  drop(ui, 'APP-1', 'refine');
  expect(toast()?.querySelector('.message')?.textContent).toBe('APP-1 did not move to Refine');
  expect(toast()?.querySelector('.said')?.textContent).toBe('Refine uses sonnet-4-5, which Claude Code no longer offers. Pick another in Settings, Models.');
  // The refused drop: the ban sign, and the model in mono.
  expect(toast()?.hasAttribute('data-refused')).toBe(true);
  expect(toast()?.querySelector('.said code')?.textContent).toBe('sonnet-4-5');
  const link = toast()?.querySelector('[data-toast-link]');
  expect(link?.textContent).toBe('Open Settings, Models');
  expect(link?.getAttribute('href')).toBe('./settings/models');

  document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss APP-1"]')!.click();
  flushSync();
  expect(toast()).toBeNull();

  shiftRight(ui, 'APP-1');
  expect(document.querySelector('dialog[data-start-confirm]')).toBeNull();
  expect(toast()?.querySelector('.message')?.textContent).toBe('APP-1 did not move to Refine');
  expect(toast()?.querySelector('[data-toast-link]')?.getAttribute('href')).toBe('./settings/models');
  expect(posted).not.toHaveBeenCalled();
});

// A column that starts nothing has nothing to ask about, so the key sends the move at once.
it('sends a move forward that starts nothing at once, as a drop does', async () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-5', stage: 'qa', state: 'ready' })]));

  shiftRight(ui, 'APP-5');

  expect(document.querySelector('dialog[data-start-confirm]')).toBeNull();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-5', to: 'review' }));
});

// The usage window goes from the Now state the stream writes to the drop box and to the confirm of Shift
// Right, through the page. Each part has its own test, so this one holds the joins.
it('shows the usage window the stream sent in the drop box and in the confirm', () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  const now = Date.now();
  const reading: ProfileLimit = { seenAt: now - 60_000, windows: [{ name: 'five_hour', used: 0.62, resetsAt: Math.floor(now / 1000) + 3600, status: 'allowed' }] };
  nowLive.state = { ...nowLive.state, limits: { 'claude-code': reading } };
  flushSync();

  ui.card('APP-1').dispatchEvent(new Event('dragstart', { bubbles: true }));
  flushSync();
  ui.column('refine').dispatchEvent(new Event('dragenter', { bubbles: true }));
  flushSync();
  expect(ui.column('refine').querySelector('[data-drop="starts"] .usage')?.textContent).toMatch(/^5h window 62% · resets \d\d:\d\d$/);
  ui.card('APP-1').dispatchEvent(new Event('dragend', { bubbles: true }));
  flushSync();

  shiftRight(ui, 'APP-1');
  expect(document.querySelector('dialog[data-start-confirm] .usage')?.textContent).toMatch(/^5h window 62% · resets \d\d:\d\d$/);
});

// R on a failed card asks first, and Enter retries that card on its own route.
it('retries a failed card on R then Enter', async () => {
  open(boardFixture('pull-request', [cardFixture({ key: 'APP-3', stage: 'implement', state: 'failed' })]));
  const card = document.querySelector<HTMLElement>('article[data-card="APP-3"]')!;

  card.focus();
  flushSync();
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
  flushSync();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-start-confirm]')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Retry APP-3 in Implement');
  expect(posted).not.toHaveBeenCalled();

  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();

  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/card/APP-3/retry');
  expect(posted.mock.calls[0]?.[1].body).toBe('{}');
});

// R on a QA FAIL offers Fix it through the same confirm, naming both runs, and Enter posts Fix it for
// that card. The other card failed QA too, so a key held as a literal cannot pass.
it('offers Fix it on R on a QA FAIL, and Enter posts it for that card', async () => {
  const failed = (key: string) => cardFixture({ key, stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  open(boardFixture('pull-request', [failed('APP-2'), failed('APP-4')]));
  const card = document.querySelector<HTMLElement>('article[data-card="APP-4"]')!;

  card.focus();
  flushSync();
  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
  flushSync();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-start-confirm]')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Fix APP-4: Implement, then QA');
  expect(dialog.textContent).toContain('Starts: Claude Code · sonnet · medium, then Claude Code · sonnet · medium');
  expect(posted).not.toHaveBeenCalled();

  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();

  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/card/APP-4/fix');
  expect(posted.mock.calls[0]?.[1].body).toBe('{}');
});

// The board's own Fix it button opens the same confirm as R, for the card it sits on, with no focus.
it('opens the Fix it confirm from the button on a QA FAIL card, and Confirm posts it for that card', async () => {
  const failed = (key: string) => cardFixture({ key, stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  open(boardFixture('pull-request', [failed('APP-2'), failed('APP-4')]));

  document.querySelector<HTMLButtonElement>('[data-fix="APP-4"]')!.click();
  flushSync();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-start-confirm]')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Fix APP-4: Implement, then QA');
  expect(posted).not.toHaveBeenCalled();

  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();

  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/card/APP-4/fix');
});

// The arrows skip Closed while it is folded, and reach its cards once it is opened.
it('skips the folded Closed column on the arrows until a click opens it', async () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'review' }), cardFixture({ key: 'APP-7', stage: 'closed' })]));
  const right = () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    flushSync();
  };

  ui.card('APP-1').focus();
  flushSync();
  right();
  await Promise.resolve();
  expect(document.activeElement).toBe(ui.card('APP-1'));
  expect(ui.card('APP-7')).toBeNull();

  ui.column('closed').querySelector<HTMLButtonElement>('button.unfold')!.click();
  flushSync();
  await vi.waitFor(() => expect(document.activeElement?.classList.contains('fold')).toBe(true));
  ui.card('APP-1').focus();
  flushSync();
  right();
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-7')));
});

// A card that runs the stage on a row of its own is fixed in its own settings, not in Settings, Models.
it("links the card settings when the card's own row refused the drop", () => {
  const own = { phase: 'refine' as const, model: 'sonnet-4-5', effort: 'high' as const, engine: 'claude-code', modelState: 'gone' as const, refusal: null };
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', starts: { refine: own } })]));

  drop(ui, 'APP-1', 'refine');

  const link = document.querySelector('.toast[data-kind="error"] [data-toast-link]');
  expect(link?.textContent).toBe('Open card settings');
  expect(link?.getAttribute('href')).toBe('./t/APP-1/settings');
  // The fix names the same one place as the link, and Open gives way to it.
  expect(document.querySelector('.toast[data-kind="error"] .said')?.textContent).toBe('Refine uses sonnet-4-5, which Claude Code no longer offers. Pick another in the card settings.');
  expect(document.querySelector('.toast[data-kind="error"] a[aria-label="Open APP-1"]')).toBeNull();
  expect(posted).not.toHaveBeenCalled();
});

// Two cards, so the confirm, its title and the move it sends cannot fall back to the first card. APP-1
// sits one column further on, so a confirm read for it would offer Implement, not Refine.
it('moves the card the key was pressed on, not another card, on Shift Right then Enter', async () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'plan' }), cardFixture({ key: 'APP-2', stage: 'inbox' })]));

  shiftRight(ui, 'APP-2');
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-start-confirm]');
  expect(dialog?.open).toBe(true);
  expect(dialog?.textContent).toContain('Move APP-2 to Refine');
  dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();

  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/board/move');
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-2', to: 'refine' }));
});

// The fix link names the card that was refused, on a drop and on the key. APP-1 runs the project's
// row, so a link read for it would say Settings, Models.
it("links the refused card's own settings, not another card's, on a drop and on Shift Right", () => {
  const own = { phase: 'refine' as const, model: 'sonnet-4-5', effort: 'high' as const, engine: 'claude-code', modelState: 'gone' as const, refusal: null };
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'inbox', starts: { refine: own } })]));
  const link = () => document.querySelector('.toast[data-kind="error"] [data-toast-link]');

  drop(ui, 'APP-2', 'refine');
  expect(link()?.textContent).toBe('Open card settings');
  expect(link()?.getAttribute('href')).toBe('./t/APP-2/settings');
  document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss APP-2"]')!.click();
  flushSync();
  expect(link()).toBeNull();

  shiftRight(ui, 'APP-2');
  expect(document.querySelector('dialog[data-start-confirm]')).toBeNull();
  expect(link()?.textContent).toBe('Open card settings');
  expect(link()?.getAttribute('href')).toBe('./t/APP-2/settings');
  expect(posted).not.toHaveBeenCalled();
});

// Add card puts the card on the board the page shows, with no board to pick, so the toast names this
// board's stage and not Delivery's.
it('adds the card to the board the page shows, and reads the start off that board', async () => {
  posted.mockImplementation(async (url: string) => (url.endsWith('api/cards') ? new Response('{"key":"APP-21","note":null}', { status: 201 }) : new Response('[]', { status: 200 })));
  const delivery = boardFixture('pull-request', []);
  const epics = { ...delivery, kind: 'epics' as const, stages: delivery.stages.map((stage) => (stage.id === 'refine' ? { ...stage, label: 'Split' } : stage)) };
  page.params = { board: 'epics' };
  try {
    drawnAt('/');
    place(BoardPage as never, {});
    place(ToastCorner as never, {});
    nowLive.state = { ...nowLive.state, snapshot: { ...nowOf(delivery), boards: [delivery, epics] } };
    flushSync();
    expect(sessionStorage.getItem('nolzu.lastBoard')).toBe('epics');
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add epic'))!.click();
    flushSync();
    expect(document.querySelector('#card-board')).toBeNull();
    expect(document.querySelector('#card-size')).toBeNull();
    // The dialog is the button that opened it.
    expect(document.querySelector('dialog h2')?.textContent).toBe('Add epic');
    const field = document.querySelector<HTMLInputElement>('#card-input')!;
    field.value = 'Split the search work';
    field.dispatchEvent(new Event('input'));
    flushSync();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, metaKey: true, shiftKey: true }));
    flushSync();

    await vi.waitFor(() => expect(toastStack.state.toasts).toHaveLength(1));
    const sent = posted.mock.calls.find(([url]) => url.endsWith('api/cards'));
    expect(JSON.parse(String(sent?.[1].body))).toEqual({ input: 'Split the search work', title: 'Split the search work', description: '', board: 'epics', start: true });
    expect(toastStack.state.toasts[0]).toMatchObject({ kind: 'success', message: 'added to Split.' });
  } finally {
    page.params = {};
    sessionStorage.clear();
  }
});

// Add card away from a board (the palette, N on Now) comes here as `?add`. Closing the dialog drops the
// flag, so a reload or a step back does not open it again.
it('opens Add card on arrival with ?add, and drops the flag when it closes', () => {
  page.url = new URL('http://localhost/b/delivery?add');
  try {
    open(boardFixture('pull-request', []));
    expect(document.querySelector('dialog h2')?.textContent).toBe('Add card');
    document.querySelector<HTMLButtonElement>('dialog [data-closer]')!.click();
    flushSync();
    expect(document.querySelector('dialog h2')).toBeNull();
    expect(goto).toHaveBeenCalledWith('/b/delivery', { replaceState: true, keepFocus: true, noScroll: true });
  } finally {
    page.url = new URL('http://localhost/');
  }
});

// On a board: Add and start is one call, the press is the consent, and a start a drop
// would refuse still adds the card, sends no start, and raises the refused toast in the one corner.
describe('Add and start from Add card', () => {
  // The answer is read through fetch and its json, which take more than a few microtasks.
  const settle = async () => {
    await new Promise((done) => setTimeout(done, 0));
    flushSync();
  };
  const cards = () => posted.mock.calls.filter(([url]) => url.endsWith('api/cards')).map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
  const toastOf = (key: string) => toastStack.state.toasts.find((toast) => toast.card.key === key);
  const machine = (cards: Parameters<typeof boardFixture>[1]) => nowOf(boardFixture('pull-request', cards));

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    posted.mockImplementation(async (url: string) => (url.endsWith('api/cards') ? new Response('{"key":"APP-21","note":null}', { status: 201 }) : new Response('[]', { status: 200 })));
    page.url = new URL('http://localhost/b/delivery?add');
    toastStack.state = NO_TOASTS;
  });
  afterEach(() => {
    page.url = new URL('http://localhost/');
  });

  function press(snapshot: NowSnapshot, title: string, keys: KeyboardEventInit) {
    open(snapshot.boards[0]!);
    const field = document.querySelector<HTMLInputElement>('#card-input')!;
    field.value = title;
    field.dispatchEvent(new Event('input'));
    flushSync();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...keys }));
    flushSync();
  }

  it('sends the start with the card, and says the card is in Refine', async () => {
    press(machine([]), 'Sort recipes by rating', { metaKey: true, shiftKey: true });
    await settle();

    expect(cards()).toEqual([expect.objectContaining({ input: 'Sort recipes by rating', board: 'delivery', start: true })]);
    expect(toastOf('APP-21')).toMatchObject({ kind: 'success', message: 'added to Refine.' });
  });

  it('sends no start on Cmd Enter, and says the card is in Inbox', async () => {
    press(machine([]), 'Show the cooking time', { metaKey: true });
    await settle();

    expect(cards()).toEqual([expect.not.objectContaining({ start: expect.anything() })]);
    expect(toastOf('APP-21')).toMatchObject({ kind: 'success', message: 'added to Inbox.' });
  });

  it('keeps a refused start out of the call, so the card stays in Inbox, and raises the refused toast with its fix link', async () => {
    const snapshot = machine([]);
    const [board] = snapshot.boards;
    const retired = {
      ...snapshot,
      boards: [{ ...board!, stages: board!.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'claude-retired-1', modelState: 'gone' as const } } : stage)) }],
    };
    press(retired, 'Sort recipes by rating', { metaKey: true, shiftKey: true });
    await settle();

    expect(cards()).toHaveLength(1);
    expect(cards()[0]).not.toHaveProperty('start');
    expect(toastOf('APP-21')).toMatchObject({ kind: 'error', refused: true, headline: 'did not move to Refine', code: 'claude-retired-1', link: { label: 'Open Settings, Models' } });
  });

  // APP-1 runs Refine on a row of its own. A link read for APP-1 would open its settings, but the new
  // card runs the project's row, and its toast opens the new card.
  it("links the new card and Settings, Models, not another card's settings", async () => {
    const own = { phase: 'refine' as const, model: 'sonnet-4-5', effort: 'high' as const, engine: 'claude-code', modelState: 'ok' as const, refusal: null };
    const snapshot = machine([cardFixture({ key: 'APP-1', stage: 'inbox', starts: { refine: own } })]);
    const [board] = snapshot.boards;
    const retired = {
      ...snapshot,
      boards: [{ ...board!, stages: board!.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'claude-retired-1', modelState: 'gone' as const } } : stage)) }],
    };
    press(retired, 'Sort recipes by rating', { metaKey: true, shiftKey: true });
    await settle();

    expect(toastOf('APP-21')).toMatchObject({ card: { key: 'APP-21', href: './t/APP-21' }, link: { label: 'Open Settings, Models' } });
  });
});


// Peek. The server's view of a card, as the peek route answers it; every other call is a write.
const peekAnswer = (key: string, summary: string | null) => ({
  key,
  summary: summary === null ? null : { text: summary, at: null, live: false },
  log: { runId: 1, rows: [{ kind: 'text', text: `${key} read the list.` }], total: 1 },
  tokens: null,
  trail: [],
  retry: null,
  openComments: 0,
  session: null,
});

function answering(summaries: Record<string, string | null>): void {
  posted.mockImplementation(async (url: string) => {
    const peek = /\/api\/card\/([^/]+)\/peek$/.exec(url);
    if (peek === null) return new Response('{}', { status: 200 });
    const key = decodeURIComponent(peek[1]!);
    return new Response(JSON.stringify(peekAnswer(key, summaries[key] ?? null)), { status: 200 });
  });
}

const press = (key: string, over: KeyboardEventInit = {}) => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }));
  flushSync();
};
const sheet = () => document.querySelector<HTMLElement>('aside[data-peek]');

it('opens the sheet on Space, follows J and K with it, and gives the focus back to the card on Esc', async () => {
  answering({ 'APP-1': 'The list filters as you type.', 'APP-2': null });
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-1', stage: 'inbox', title: 'Filter the recipe list' }),
      cardFixture({ key: 'APP-2', stage: 'inbox', title: 'Sort the recipe list' }),
    ]),
  );
  ui.card('APP-1').focus();
  flushSync();

  press(' ');
  expect(sheet()?.dataset['peek']).toBe('APP-1');
  expect(sheet()?.querySelector('h2')?.textContent).toBe('Filter the recipe list');
  // The summary is Markdown now, which ends its paragraph with a line break.
  await vi.waitFor(() => expect(sheet()?.querySelector('[data-peek-summary]')?.textContent?.trim()).toBe('The list filters as you type.'));
  // While the sheet is open the key row says what the keys do there.
  expect(document.querySelector('p.keys')?.textContent).toContain('next card, the sheet follows');

  press('j');
  await vi.waitFor(() => expect(sheet()?.dataset['peek']).toBe('APP-2'));
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-2')));
  expect(sheet()?.querySelector('h2')?.textContent).toBe('Sort the recipe list');
  // The other card's summary never sits under this card's title: a card with none says so.
  await vi.waitFor(() => expect(sheet()?.querySelector('[data-peek-summary]')?.textContent?.trim()).toBe('No plain summary yet. A phase writes one as it works and when it ends.'));

  press('k');
  await vi.waitFor(() => expect(sheet()?.dataset['peek']).toBe('APP-1'));
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-1')));

  press('Escape');
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(ui.card('APP-1'));
});

// A click anywhere on a card peeks at it, as Space does, the title too. The title stays
// a link, so a click with Cmd or Ctrl still opens the page in a new tab. The buttons keep their own
// jobs, and the end of a drag is no click.
it('opens the peek on a click on the card or its title, moves it to another clicked card, and not on a drag', () => {
  answering({});
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-1', stage: 'inbox' }),
      cardFixture({ key: 'APP-2', stage: 'inbox' }),
    ]),
  );
  const click = (at: Element) => {
    at.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    at.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();
  };

  const title = ui.card('APP-1').querySelector('a.title')!;
  for (const held of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const tab = new MouseEvent('click', { bubbles: true, cancelable: true, ...held });
    title.dispatchEvent(tab);
    flushSync();
    expect(tab.defaultPrevented).toBe(false);
    expect(sheet()).toBeNull();
  }
  const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
  title.dispatchEvent(plain);
  flushSync();
  expect(plain.defaultPrevented).toBe(true);
  expect(sheet()?.dataset['peek']).toBe('APP-1');
  expect(document.activeElement).toBe(ui.card('APP-1'));
  press('Escape');
  expect(sheet()).toBeNull();

  click(ui.card('APP-1').querySelector('.key')!);
  expect(sheet()?.dataset['peek']).toBe('APP-1');
  expect(document.activeElement).toBe(ui.card('APP-1'));
  click(ui.card('APP-2'));
  expect(sheet()?.dataset['peek']).toBe('APP-2');
  expect(document.querySelector('p.keys')?.textContent).toContain('close peek');

  press('Escape');
  expect(sheet()).toBeNull();

  ui.card('APP-1').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  ui.card('APP-1').dispatchEvent(new Event('dragstart', { bubbles: true }));
  ui.card('APP-1').dispatchEvent(new Event('dragend', { bubbles: true }));
  ui.card('APP-1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  expect(sheet()).toBeNull();
  // The next press is a fresh click again.
  click(ui.card('APP-1'));
  expect(sheet()?.dataset['peek']).toBe('APP-1');
});

// Enter peeks as Space does, and Enter again opens the card page, the sheet's own Open.
it('opens the peek on Enter, and the card page on a second Enter', () => {
  answering({});
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  vi.mocked(goto).mockClear();
  ui.card('APP-1').focus();
  flushSync();
  press('Enter');
  expect(sheet()?.dataset['peek']).toBe('APP-1');
  expect(goto).not.toHaveBeenCalled();
  press('Enter');
  expect(goto).toHaveBeenCalledWith(expect.stringMatching(/t\/APP-1$/));
});

// A double click opens the card page, on the board and in the list. Its first click has peeked. A held
// key, a drag and the card's own Answer link are left alone.
it('opens the card page on a double click, and not with a key held, after a drag or on the Answer link', () => {
  answering({});
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-1', stage: 'inbox' }),
      cardFixture({ key: 'APP-2', stage: 'inbox', state: 'blocked', question: 'Titles only?' }),
    ]),
  );
  vi.mocked(goto).mockClear();
  const twice = (at: Element, held: MouseEventInit = {}) => {
    at.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...held }));
    flushSync();
  };

  const title = ui.card('APP-1').querySelector('a.title')!;
  for (const held of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) twice(title, held);
  twice(ui.card('APP-2').querySelector('a.answer')!);
  twice(document.querySelector('h1')!);
  ui.card('APP-1').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  ui.card('APP-1').dispatchEvent(new Event('dragstart', { bubbles: true }));
  twice(ui.card('APP-1'));
  expect(goto).not.toHaveBeenCalled();

  ui.card('APP-1').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  twice(title);
  expect(goto).toHaveBeenLastCalledWith(expect.stringMatching(/t\/APP-1$/));
  twice(ui.card('APP-2').querySelector('.key')!);
  expect(goto).toHaveBeenLastCalledWith(expect.stringMatching(/t\/APP-2$/));

  document.querySelector<HTMLElement>('button[data-view="list"]')!.click();
  flushSync();
  twice(ui.card('APP-1'));
  expect(goto).toHaveBeenLastCalledWith(expect.stringMatching(/t\/APP-1$/));
  expect(goto).toHaveBeenCalledTimes(3);
});

// The sheet the first click opens can narrow the columns, so the second click of a double click may
// land on another card. The sheet stays on the first card, and the double click opens that one.
it('opens the card a double click started on when its second click lands on another', () => {
  answering({});
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-1', stage: 'inbox' }),
      cardFixture({ key: 'APP-2', stage: 'inbox' }),
    ]),
  );
  vi.mocked(goto).mockClear();
  const hit = (at: Element, detail: number, type = 'click') => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail });
    at.dispatchEvent(event);
    flushSync();
    return event;
  };

  hit(ui.card('APP-1'), 1);
  expect(hit(ui.card('APP-2').querySelector('a.title')!, 2).defaultPrevented).toBe(true);
  expect(sheet()?.dataset['peek']).toBe('APP-1');
  hit(ui.card('APP-2'), 2, 'dblclick');
  expect(goto).toHaveBeenCalledTimes(1);
  expect(goto).toHaveBeenLastCalledWith(expect.stringMatching(/t\/APP-1$/));

  // A new first click starts a new pair.
  hit(ui.card('APP-2'), 1);
  expect(sheet()?.dataset['peek']).toBe('APP-2');
  hit(document.querySelector('h1')!, 1);
  hit(ui.card('APP-1'), 2);
  expect(sheet()?.dataset['peek']).toBe('APP-1');
});

// The List view is one more way to show the cards, and a click on a row's title peeks the same way.
it('opens the peek on a plain click on a list row title, and leaves a Cmd click to the browser', () => {
  answering({});
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  document.querySelector<HTMLElement>('button[data-view="list"]')!.click();
  flushSync();
  const title = ui.card('APP-1').querySelector('a.title')!;
  expect(ui.card('APP-1').classList.contains('row')).toBe(true);
  const tab = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  title.dispatchEvent(tab);
  flushSync();
  expect(tab.defaultPrevented).toBe(false);
  expect(sheet()).toBeNull();
  const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
  title.dispatchEvent(plain);
  flushSync();
  expect(plain.defaultPrevented).toBe(true);
  expect(sheet()?.dataset['peek']).toBe('APP-1');
});

it('says Space or click peeks in the key row', () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  ui.card('APP-1').focus();
  flushSync();
  expect(document.querySelector('p.keys')?.textContent).toContain('or click peek');
});

// The slot meter in the top bar: one pip per slot, each busy one naming its run.
it('draws a pip per slot with the run in each, peeks at a card on this board and opens any other card', () => {
  answering({});
  const one = boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'inbox', state: 'running' })]);
  open({ ...one, slots: { busy: 2, total: 3 } });
  const row = (key: string, phase: string) => ({ runId: 1, key, title: key, kind: 'card' as const, phase, state: 'running' as const, runState: 'running' as const, position: null, startedAt: null, model: null, effort: null, lane: null });
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, running: [row('APP-2', 'Implement'), row('APP-9', 'Plan')] } };
  flushSync();

  const meter = document.querySelector<HTMLElement>('[data-slot-meter]')!;
  expect(meter.getAttribute('aria-label')).toBe('2 of 3 slots busy');
  const pips = [...meter.querySelectorAll<HTMLElement>('[data-pip]')];
  expect(pips.map((pip) => pip.getAttribute('aria-label'))).toEqual(['APP-2 · Implement', 'APP-9 · Plan', 'Free slot']);
  // The hover and focus text is the same words, drawn by the pip.
  expect(pips[0]!.dataset['tip']).toBe('APP-2 · Implement');
  expect(pips[2]!.dataset['busy']).toBeUndefined();

  pips[0]!.click();
  flushSync();
  expect(sheet()?.dataset['peek']).toBe('APP-2');
  // On the card, so Esc closes the sheet as it does after Space.
  expect(document.activeElement).toBe(document.querySelector('article[data-card="APP-2"]'));
  press('Escape');
  expect(sheet()).toBeNull();

  pips[1]!.click();
  expect(goto).toHaveBeenCalledWith(expect.stringMatching(/t\/APP-9$/));
});

it('opens the page of a busy card the filter hides, and nothing for a run of another project', () => {
  answering({});
  const one = boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'inbox', state: 'running', title: 'Sort the list' })]);
  open({ ...one, slots: { busy: 2, total: 2 } });
  const row = (key: string, phase: string) => ({ runId: 1, key, title: key, kind: 'card' as const, phase, state: 'running' as const, runState: 'running' as const, position: null, startedAt: null, model: null, effort: null, lane: null });
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, running: [row('APP-2', 'Implement')] } };
  const box = document.querySelector<HTMLInputElement>('input[data-filter]')!;
  box.value = 'nothing like it';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  vi.mocked(goto).mockClear();

  const pips = [...document.querySelectorAll<HTMLElement>('[data-pip]')];
  expect(pips[1]!.getAttribute('aria-label')).toBe('Busy in another project');
  expect(pips[1]!.getAttribute('aria-disabled')).toBe('true');
  pips[1]!.click();
  expect(goto).not.toHaveBeenCalled();

  pips[0]!.click();
  flushSync();
  expect(sheet()).toBeNull();
  expect(goto).toHaveBeenCalledWith(expect.stringMatching(/t\/APP-2$/));
});

it('closes the sheet on Esc from inside it, with the focus back on the card it showed', () => {
  answering({});
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  ui.card('APP-1').focus();
  flushSync();
  press(' ');

  sheet()!.querySelector<HTMLElement>('[data-peek-close]')!.focus();
  press('Escape');

  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(ui.card('APP-1'));
});

// The sheet's Move back on a running card asks the server to stop the run first. The card moves when
// the stream says so, never on the answer.
it('sends Move back on a running card with the stop, and holds the button until the card moves', async () => {
  answering({});
  const running = cardFixture({ key: 'APP-1', stage: 'implement', state: 'running', runId: 7, runState: 'running', runStartedAt: new Date().toISOString() });
  const ui = open(boardFixture('pull-request', [running]));
  ui.card('APP-1').focus();
  flushSync();
  press(' ');
  await vi.waitFor(() => expect(sheet()?.querySelector('[data-decision="running"]')).not.toBeNull());

  // One Stop and one Move back: the foot's, since the Next step block leaves out its own in the peek.
  expect(sheet()!.querySelectorAll('[data-run="stop"], [data-peek-stop]')).toHaveLength(1);
  expect(sheet()!.querySelectorAll('[data-move-back], [data-peek-back]')).toHaveLength(1);
  const back = sheet()!.querySelector<HTMLButtonElement>('[data-peek-back]')!;
  expect(back.textContent).toContain('Move back to Plan');
  back.click();
  flushSync();
  await vi.waitFor(() => expect(posted.mock.calls.some((call) => call[0] === './api/board/move')).toBe(true));
  expect(posted.mock.calls.find((call) => call[0] === './api/board/move')?.[1].body).toBe(JSON.stringify({ key: 'APP-1', to: 'plan', stop: true }));
  flushSync();
  expect(sheet()!.querySelector('[data-peek-back]')?.getAttribute('aria-busy')).toBe('true');

  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [{ ...running, stage: 'plan', state: 'idle', runId: null, runState: null }])) };
  flushSync();
  // The stream moved the card: the sheet follows it, and it is selected with the focus in Plan.
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-1')));
  expect(ui.card('APP-1').closest('section')?.dataset['stage']).toBe('plan');
  expect(sheet()?.dataset['peek']).toBe('APP-1');
});

// The card page's Next step block heads the sheet, and its button sends the move the card page sends.
// The block lets go once the stream shows the card moved, and the sheet stays on the card.
it('shows the next step in the sheet and moves the card with its button', async () => {
  answering({});
  const ready = cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' });
  const ui = open(boardFixture('pull-request', [ready]));
  ui.card('APP-1').focus();
  flushSync();
  press(' ');
  await vi.waitFor(() => expect(sheet()?.querySelector('[data-decision="start"]')).not.toBeNull());

  // One level under the card title, which the sheet heads with an h2.
  expect(sheet()!.querySelector('[data-decision] h3')?.textContent).toBe('Next step');
  const go = sheet()!.querySelector<HTMLButtonElement>('[data-decision] .btn.go')!;
  expect(go.textContent?.trim()).toBe('Approve and start Implement');
  go.click();
  flushSync();
  await vi.waitFor(() => expect(posted.mock.calls.some((call) => call[0] === './api/board/move')).toBe(true));
  expect(posted.mock.calls.find((call) => call[0] === './api/board/move')?.[1].body).toBe(JSON.stringify({ key: 'APP-1', to: 'implement' }));
  flushSync();
  expect(sheet()!.querySelector('[data-decision] .btn.go')?.getAttribute('aria-busy')).toBe('true');

  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [{ ...ready, stage: 'implement', state: 'queued' }])) };
  flushSync();
  await vi.waitFor(() => expect(ui.card('APP-1').closest('section')?.dataset['stage']).toBe('implement'));
  expect(sheet()?.dataset['peek']).toBe('APP-1');
  expect(sheet()?.querySelector('[data-decision]')?.getAttribute('data-decision')).toBe('queued');
});

// A refused move moved nothing, so the page has no card to follow and the button lets go.
it('lets go of the card and raises the toast when the server refuses the move from the sheet', async () => {
  posted.mockImplementation(async (url: string) => {
    if (/\/api\/card\/[^/]+\/peek$/.test(url)) return new Response(JSON.stringify(peekAnswer('APP-1', null)), { status: 200 });
    if (url.endsWith('api/board/move')) return new Response(JSON.stringify({ message: 'Implement is full.' }), { status: 409 });
    return new Response('{}', { status: 200 });
  });
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' })]));
  ui.card('APP-1').focus();
  flushSync();
  press(' ');
  await vi.waitFor(() => expect(sheet()?.querySelector('[data-decision="start"]')).not.toBeNull());

  sheet()!.querySelector<HTMLButtonElement>('[data-decision] .btn.go')!.click();
  flushSync();
  expect(follow.state).toEqual({ key: 'APP-1', to: 'implement' });
  await vi.waitFor(() => expect(follow.state).toBeNull());
  flushSync();
  expect(sheet()!.querySelector('[data-decision] .btn.go')?.hasAttribute('aria-busy')).toBe(false);
  expect(document.body.textContent).toContain('Implement is full.');
});

// The tests above use APP-1 alone. A second card in front tells which card the sheet moves and asks about.
it('sends Move back for the card the sheet shows, and draws no answer that is about another card', async () => {
  const mine = cardFixture({ key: 'APP-5', stage: 'implement', state: 'running', runId: 7, runState: 'running', runStartedAt: new Date().toISOString() });
  posted.mockImplementation(async (url: string) => {
    // Every peek ask is answered with APP-1's view, whatever card was asked about.
    if (/\/api\/card\/[^/]+\/peek$/.test(url)) return new Response(JSON.stringify(peekAnswer('APP-1', 'The words of another card.')), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), mine]));
  ui.card('APP-5').focus();
  flushSync();
  press(' ');
  await vi.waitFor(() => expect(posted.mock.calls.some((call) => /\/api\/card\/APP-5\/peek$/.test(call[0]))).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  flushSync();

  expect(sheet()?.dataset['peek']).toBe('APP-5');
  expect(sheet()?.textContent).not.toContain('The words of another card.');

  sheet()!.querySelector<HTMLButtonElement>('[data-peek-back]')!.click();
  flushSync();
  await vi.waitFor(() => expect(posted.mock.calls.some((call) => call[0] === './api/board/move')).toBe(true));
  expect(posted.mock.calls.find((call) => call[0] === './api/board/move')?.[1].body).toBe(JSON.stringify({ key: 'APP-5', to: 'plan', stop: true }));
  // The page waits for APP-5 to land in Plan, not APP-1.
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), { ...mine, stage: 'plan', state: 'idle', runId: null, runState: null }])) };
  flushSync();
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-5')));
});

// The hold ends when the card leaves the column. Kept, it would block Move back once the card came back.
it('lets Move back work again after the card moved back and then forward with the sheet open', async () => {
  answering({});
  const running = cardFixture({ key: 'APP-1', stage: 'implement', state: 'running', runId: 7, runState: 'running', runStartedAt: new Date().toISOString() });
  const moves = () => posted.mock.calls.filter((call) => call[0] === './api/board/move').map((call) => call[1].body);
  const ui = open(boardFixture('pull-request', [running]));
  ui.card('APP-1').focus();
  flushSync();
  press(' ');

  sheet()!.querySelector<HTMLButtonElement>('[data-peek-back]')!.click();
  await vi.waitFor(() => expect(moves()).toHaveLength(1));
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [{ ...running, stage: 'plan', state: 'idle', runId: null, runState: null }])) };
  flushSync();
  // Moved forward again, and running again in the column it left.
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [{ ...running, runId: 8 }])) };
  flushSync();
  await vi.waitFor(() => expect(sheet()?.querySelector('[data-peek-back]')?.getAttribute('aria-busy')).toBeNull());

  sheet()!.querySelector<HTMLButtonElement>('[data-peek-back]')!.click();
  await vi.waitFor(() => expect(moves()).toHaveLength(2));
  expect(moves()[1]).toBe(JSON.stringify({ key: 'APP-1', to: 'plan', stop: true }));
});

// Shift Left is the sheet's Move back while the sheet is open on a running card, as the button's cap
// says. Without the sheet a running card does not move back on a key.
it('sends the sheet Move back on Shift Left while the sheet is open on a running card, and nothing without it', async () => {
  answering({});
  const running = cardFixture({ key: 'APP-1', stage: 'implement', state: 'running', runId: 7, runState: 'running', runStartedAt: new Date().toISOString() });
  const ui = open(boardFixture('pull-request', [running]));
  ui.card('APP-1').focus();
  flushSync();

  press('ArrowLeft', { shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posted.mock.calls.filter((call) => call[0] === './api/board/move')).toEqual([]);

  press(' ');
  ui.card('APP-1').focus();
  flushSync();
  press('ArrowLeft', { shiftKey: true });
  await vi.waitFor(() => expect(posted.mock.calls.filter((call) => call[0] === './api/board/move').map((call) => call[1].body)).toEqual([JSON.stringify({ key: 'APP-1', to: 'plan', stop: true })]));
});

// After a key move the stream redraws the card in its new column and the focus fell to the page,
// so a second Shift Right needed an arrow first.
it('keeps the moved card selected with the focus, so a second Shift Right moves it on', async () => {
  const before = boardFixture('pull-request', [cardFixture({ key: 'APP-5', stage: 'qa', state: 'ready' })]);
  const ui = open(before);

  shiftRight(ui, 'APP-5');
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-5', stage: 'review', state: 'idle' })])) };
  flushSync();
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-5')));

  // No arrow first: the next Shift Right reaches the card.
  ui.card('APP-5').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
  flushSync();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(posted.mock.calls[1]?.[1].body).toBe(JSON.stringify({ key: 'APP-5', to: 'pr-watch' }));
});

it('keeps the card selected after Shift Left too', async () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-5', stage: 'review', state: 'idle' })]));
  ui.card('APP-5').focus();
  flushSync();

  ui.card('APP-5').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
  flushSync();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-5', stage: 'qa', state: 'idle' })])) };
  flushSync();

  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-5')));
  expect(ui.card('APP-5').closest('section')?.dataset['stage']).toBe('qa');
});

// A move from the palette gave the focus back to what had it before the palette opened. The
// palette names the card it moved, and the board selects it once it lands.
it('selects the card a palette move named, once the stream shows it moved', async () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'inbox' })]));
  ui.card('APP-2').focus();
  flushSync();

  follow.state = { key: 'APP-1', to: 'refine' };
  flushSync();
  // Not yet: the card is still in Inbox, and the old element is about to go.
  expect(document.activeElement).toBe(ui.card('APP-2'));
  nowLive.state = { ...nowLive.state, snapshot: nowOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'refine', state: 'queued' }), cardFixture({ key: 'APP-2', stage: 'inbox' })])) };
  flushSync();

  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-1')));
  expect(follow.state).toBeNull();
});

// The first drag: the coach note sits in Refine, which stays open to hold it, names the card waiting
// in Inbox and the engine, and goes on Got it, which stores it so a reload keeps it closed. It goes
// too once the stream says a card was dragged.
it('draws the first drag note on Refine until Got it, and stores Got it', () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'RECI-1', stage: 'inbox' })]);
  const first = { steps: null, coach: 'first-drag', loginOffer: null };
  const ui = open(board);
  nowLive.state = { ...nowLive.state, snapshot: { ...nowOf(board), profiles: [{ id: 'claude-code', label: 'Claude Code', silent: false }], firstRun: first } };
  flushSync();

  const note = ui.column('refine').querySelector('[role="note"]');
  expect(ui.column('refine').dataset.folded).toBeUndefined();
  expect(note?.textContent).toContain('Dropping a card here is your approval');
  expect(note?.textContent).toContain('An amber column runs an agent. Drop RECI-1 and Claude Code starts Refine on this machine.');
  expect(note?.textContent).toContain('It changes no code.');
  expect(note?.textContent).toContain('No mouse? Select the card and press');
  expect(document.querySelectorAll('[role="note"]')).toHaveLength(1);

  note?.querySelector<HTMLButtonElement>('[data-dismiss-note]')?.click();
  flushSync();

  expect(ui.column('refine').querySelector('[role="note"]')).toBeNull();
  expect(ui.column('refine').dataset.folded).toBe('true');
  expect(posted).toHaveBeenCalledWith('./api/notes', expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'first-drag' }) }));
});

it('draws no note once the stream says a card was dragged', () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'RECI-1', stage: 'inbox' })]);
  const ui = open(board);
  nowLive.state = { ...nowLive.state, snapshot: { ...nowOf(board), firstRun: { steps: null, coach: null, loginOffer: null } } };
  flushSync();

  expect(ui.column('refine').querySelector('[role="note"]')).toBeNull();
  expect(ui.column('refine').dataset.folded).toBe('true');
});

// Read through a call, so the type is not narrowed to the null the test set.
const asked = (): QaAskOpen | null => qaAsk.state;
const gated = (): SetupGateOpen | null => setupGate.state;

// The first move into QA asks how QA gets the app before anything is sent, on a drop and on Shift
// Right alike, and Start QA sends the move a drop would have sent.
it('asks the question at the first QA in place of the move, and sends the move once it is answered', async () => {
  qaAsk.state = null;
  const qaSetup = { project: 'recipes', repo: null, dev: { command: 'npm run dev', repo: '.' }, scripts: '', unwalled: null, address: '', test: null, playwright: false, chrome: false, browser: false };
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'implement', state: 'ready' })]));
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, qaSetup } };
  flushSync();

  drop(ui, 'APP-2', 'qa');
  expect(posted).not.toHaveBeenCalled();
  expect(asked()?.key).toBe('APP-2');
  expect(asked()?.stage.id).toBe('qa');
  // The drop's own held move is the drop of this card.
  void asked()?.go();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-2', to: 'qa' }));
  posted.mockClear();

  qaAsk.state = null;
  shiftRight(ui, 'APP-2');
  expect(document.querySelector('dialog[data-start-confirm]')).toBeNull();
  expect(posted).not.toHaveBeenCalled();
  expect(asked()?.key).toBe('APP-2');

  void asked()?.go();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-2', to: 'qa' }));
  qaAsk.state = null;
});

// While Learn your repositories holds the first run back, a drop that starts a phase opens the
// Learn dialog in place of the move, and "I will write it myself" sends the move the drop held. A drop
// that starts nothing goes straight on.
it('opens the Learn dialog in place of the first run, and sends the held move from it', async () => {
  setupGate.state = null;
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'refine', state: 'ready' })]));
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, setup: { steps: [], gates: true } } };
  flushSync();

  drop(ui, 'APP-1', 'refine');
  expect(posted).not.toHaveBeenCalled();
  expect(gated()?.key).toBe('APP-1');
  expect(gated()?.to).toBe('refine');
  void gated()?.go();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-1', to: 'refine' }));
  posted.mockClear();

  setupGate.state = null;
  drop(ui, 'APP-2', 'inbox');
  expect(gated()).toBeNull();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, setup: { steps: [], gates: false } } };
});

// A first run into QA meets both: "I will write it myself" goes on to the question at the first QA,
// and the move waits for its answer.
it('goes on from "I will write it myself" to the question at the first QA', () => {
  setupGate.state = null;
  qaAsk.state = null;
  const qaSetup = { project: 'recipes', repo: null, dev: { command: 'npm run dev', repo: '.' }, scripts: '', unwalled: null, address: '', test: null, playwright: false, chrome: false, browser: false };
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-2', stage: 'implement', state: 'ready' })]));
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, qaSetup, setup: { steps: [], gates: true } } };
  flushSync();

  drop(ui, 'APP-2', 'qa');
  expect(gated()?.to).toBe('qa');
  expect(asked()).toBeNull();
  void gated()?.go();
  expect(asked()?.stage.id).toBe('qa');
  expect(posted).not.toHaveBeenCalled();
  setupGate.state = null;
  qaAsk.state = null;
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, qaSetup: null, setup: { steps: [], gates: false } } };
});

// Add and start counts as the first run too. The card is only added, and the Learn dialog opens
// on its start once Add card has closed.
it('adds the card only and opens the Learn dialog on Add and start while Learn gates the first run', async () => {
  setupGate.state = null;
  posted.mockImplementation(async (url: string) => (url.endsWith('api/cards') ? new Response('{"key":"APP-21","note":null}', { status: 201 }) : new Response('[]', { status: 200 })));
  const delivery = boardFixture('pull-request', []);
  place(BoardPage as never, {});
  nowLive.state = { ...nowLive.state, snapshot: { ...nowOf(delivery), setup: { steps: [], gates: true } } };
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add card'))!.click();
  flushSync();
  const field = document.querySelector<HTMLInputElement>('#card-input')!;
  field.value = 'Add a search box';
  field.dispatchEvent(new Event('input'));
  flushSync();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, metaKey: true, shiftKey: true }));
  flushSync();

  await vi.waitFor(() => expect(gated()?.key).toBe('APP-21'));
  expect(gated()?.to).toBe('refine');
  const sent = posted.mock.calls.find(([url]) => url.endsWith('api/cards'));
  expect(JSON.parse(String(sent?.[1].body))).not.toHaveProperty('start');
  setupGate.state = null;
  nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, setup: { steps: [], gates: false } } };
});

// The header's filter box narrows the cards by key or title on the client, "/" puts the focus in it,
// and Esc clears it.
it('narrows the cards to the filter on "/", says so when none match, and clears on Esc', () => {
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-1', stage: 'inbox', title: 'Filter the recipe list' }),
      cardFixture({ key: 'APP-2', stage: 'plan', title: 'Sort the recipe list' }),
    ]),
  );
  const box = document.querySelector<HTMLInputElement>('input[data-filter]')!;
  expect(box.placeholder).toBe('Filter cards');

  press('/');
  expect(document.activeElement).toBe(box);
  box.value = 'sort';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(document.querySelector('article[data-card="APP-1"]')).toBeNull();
  expect(ui.card('APP-2')).not.toBeNull();

  box.value = 'app-9';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(document.querySelector('p.nothing')?.textContent).toBe('No card matches the filter.');

  press('Escape');
  expect(box.value).toBe('');
  expect(ui.card('APP-1')).not.toBeNull();
});

// B shows the same cards as rows in the board's order, and the board's keys work on the rows.
it('lists the cards as rows on B, in board order, with the move keys working on a row', async () => {
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-2', stage: 'refine', title: 'Sort the recipe list', engine: 'claude-code', model: 'haiku' }),
      cardFixture({ key: 'APP-1', stage: 'inbox', title: 'Filter the recipe list' }),
    ]),
  );

  press('b');
  const rows = [...document.querySelectorAll<HTMLElement>('[data-board-list] article[data-card]')];
  expect(rows.map((row) => row.dataset['card'])).toEqual(['APP-1', 'APP-2']);
  expect(rows[1]?.textContent).toContain('Refine');
  // The engine before the model, as on a board card.
  expect(rows[1]?.textContent).toContain('Claude Code · haiku');
  expect(document.querySelector('[data-view="list"]')?.getAttribute('aria-pressed')).toBe('true');

  ui.card('APP-1').focus();
  flushSync();
  press('j');
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-2')));
  shiftRight(ui, 'APP-1');
  expect(document.querySelector('dialog[data-start-confirm]')?.textContent).toContain('Move APP-1 to Refine');

  press('Escape');
  document.querySelector<HTMLButtonElement>('[data-view="board"]')!.click();
  flushSync();
  expect(document.querySelector('[data-board-list]')).toBeNull();
  expect(ui.column('inbox')).not.toBeNull();
});

// The choice stays per board, so opening a card and coming back keeps List.
it('keeps Board or List per board after the page is drawn again', () => {
  const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const listShown = () => document.querySelector('[data-board-list]') !== null;
  const reopen = (snapshot: BoardSnapshot) => {
    for (const part of parts) {
      void unmount(part.instance);
      part.target.remove();
    }
    parts = [];
    open(snapshot);
  };
  open(board);
  press('b');
  expect(listShown()).toBe(true);

  reopen(board);
  expect(listShown()).toBe(true);
  expect(document.querySelector('[data-view="list"]')?.getAttribute('aria-pressed')).toBe('true');

  // Another board starts on Board. The test page is not reactive, so each address is a fresh mount.
  page.params = { board: 'epics' };
  try {
    reopen({ ...board, kind: 'epics' });
    expect(listShown()).toBe(false);
    // List on Epics is kept for Epics alone.
    press('b');
    reopen({ ...board, kind: 'epics' });
    expect(listShown()).toBe(true);
  } finally {
    page.params = {};
  }
  reopen(board);
  expect(listShown()).toBe(true);

  // Back to Board on Delivery is kept too.
  document.querySelector<HTMLButtonElement>('[data-view="board"]')!.click();
  flushSync();
  reopen(board);
  expect(listShown()).toBe(false);
});

// Storage that throws, as a browser with site data blocked does, still opens on Board and still switches.
it('opens on Board and still switches when storage throws', () => {
  const blocked = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked });
  open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  expect(document.querySelector('[data-board-list]')).toBeNull();

  press('b');
  expect(document.querySelector('[data-board-list]')).not.toBeNull();
});

// The server cannot read the stored view, so app.html marks List before the first paint and the CSS
// shows List pressed until the page hydrates.
it('marks a board left on List before the first paint, from the address', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'app.html'), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((one) => one[1]).find((one) => one?.includes('nolzu.view.'));
  expect(code).toBeDefined();
  const marked = (path: string) => {
    delete document.documentElement.dataset.boardView;
    history.replaceState(null, '', path);
    new Function(code!)();
    return document.documentElement.dataset.boardView;
  };
  try {
    localStorage.setItem('nolzu.view.delivery', 'list');
    localStorage.setItem('nolzu.view.epics', 'board');
    expect(marked('/b/delivery')).toBe('list');
    expect(marked('/b/delivery/')).toBe('list');
    expect(marked('/b/epics')).toBeUndefined();
    expect(marked('/b/prreview')).toBeUndefined();
    expect(marked('/t/APP-1')).toBeUndefined();
    expect(marked('/')).toBeUndefined();

    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('blocked', 'SecurityError'); } });
    expect(marked('/b/delivery')).toBeUndefined();
  } finally {
    history.replaceState(null, '', '/');
    delete document.documentElement.dataset.boardView;
  }
});

// The page keeps that mark in step with the switch, so its CSS never presses the other segment.
it('keeps the List mark on the page in step with the switch, and drops it when the board goes', () => {
  localStorage.setItem('nolzu.view.delivery', 'list');
  open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  expect(document.documentElement.dataset.boardView).toBe('list');

  press('b');
  expect(document.documentElement.dataset.boardView).toBeUndefined();
  press('b');
  expect(document.documentElement.dataset.boardView).toBe('list');

  for (const part of parts) void unmount(part.instance);
  flushSync();
  expect(document.documentElement.dataset.boardView).toBeUndefined();
});

// The peek row draws J and K as two caps with no word between them.
it('draws J K as two caps in the peek row', () => {
  answering({ 'APP-1': null });
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  ui.card('APP-1').focus();
  flushSync();

  press(' ');
  const row = [...document.querySelectorAll('p.keys > span')].find((span) => span.textContent?.includes('next card, the sheet follows'))!;
  expect([...row.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual(['J', 'K']);
  expect(row.querySelector('.or')).toBeNull();
});

// The Epics header: Add epic, and the tasks its open epics have on Delivery.
it('says Add epic and counts the tasks on Delivery on the Epics board', () => {
  page.params = { board: 'epics' };
  try {
    const task = (key: string) => ({ key, title: key, state: 'idle' as const, done: false });
    open({ ...boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', tasks: [task('APP-4'), task('APP-5')] })]), kind: 'epics' });

    expect(document.querySelector('.title .sub')?.textContent).toBe('1 epic · 2 tasks on Delivery');
    expect(document.querySelector('input[data-filter]')?.getAttribute('placeholder')).toBe('Filter epics');
    expect([...document.querySelectorAll('.title button')].some((button) => button.textContent?.includes('Add epic'))).toBe(true);
  } finally {
    page.params = {};
  }
});

// The PR reviews header: the open count with its repositories, when the pull requests were
// last read, Read pull requests and Add pull request.
it('draws the PR reviews header words and the read stamp', () => {
  page.params = { board: 'prreview' };
  page.data = { pullsReadAt: new Date(Date.now() - 12 * 60_000).toISOString() };
  try {
    open({ ...boardFixture('pull-request', [cardFixture({ key: 'api#3', stage: 'inbox' }), cardFixture({ key: 'web#4', stage: 'inbox' })]), kind: 'prreview' });
    const header = document.querySelector('.title')!;

    expect(header.querySelector('.sub')?.textContent).toBe('2 open · api and web');
    expect(header.querySelector('[data-read-ago]')?.textContent).toBe('read 12m ago');
    expect(header.querySelector('[data-read-pulls]')?.textContent).toContain('Read pull requests');
    expect(header.textContent).not.toContain('Read open pull requests');
    expect(header.textContent).toContain('Add pull request');
  } finally {
    page.params = {};
    page.data = {};
  }
});

const type = (box: HTMLInputElement, text: string) => {
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

// The filter reaches the keys and the List view too, not only the board.
it('clears the typed filter on Esc from the page, and walks only the cards it shows', async () => {
  const ui = open(
    boardFixture('pull-request', [
      cardFixture({ key: 'APP-1', stage: 'inbox', title: 'Filter one' }),
      cardFixture({ key: 'APP-2', stage: 'inbox', title: 'Sort two' }),
      cardFixture({ key: 'APP-3', stage: 'inbox', title: 'Filter three' }),
    ]),
  );
  const box = document.querySelector<HTMLInputElement>('input[data-filter]')!;
  type(box, 'filter');
  box.blur();
  ui.card('APP-1').focus();
  flushSync();

  press('j');
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.card('APP-3')));

  // The first Esc lets go of the selected card, the next clears the text.
  press('Escape');
  expect(box.value).toBe('filter');
  press('Escape');
  expect(box.value).toBe('');
  expect(ui.card('APP-2')).not.toBeNull();
});

it('says no card matches in the List view, and lists the match', () => {
  const ui = open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', title: 'Filter one' }), cardFixture({ key: 'APP-2', stage: 'inbox', title: 'Sort two' })]));
  const box = document.querySelector<HTMLInputElement>('input[data-filter]')!;
  press('b');
  type(box, 'sort');
  expect([...document.querySelectorAll('[data-board-list] article[data-card]')].map((row) => row.getAttribute('data-card'))).toEqual(['APP-2']);

  type(box, 'zzz');
  expect(document.querySelector('[data-board-list]')).toBeNull();
  expect(document.querySelector('p.nothing')?.textContent).toBe('No card matches the filter.');
  void ui;
});

it('reads the layout again after a PR reviews read, for the read stamp, and not after another board', async () => {
  vi.mocked(invalidateAll).mockClear();
  page.params = { board: 'prreview' };
  try {
    open({ ...boardFixture('pull-request', [cardFixture({ key: 'api#3', stage: 'inbox' })]), kind: 'prreview' });
    document.querySelector<HTMLButtonElement>('[data-read-pulls]')!.click();
    await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalledOnce());
  } finally {
    page.params = {};
  }
});

it('says nothing waits, and not that no card matches, in the List view of Waiting on me', () => {
  page.url = new URL('http://localhost/?w=1');
  try {
    open(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', title: 'Filter one' })]));
    press('b');
    expect(document.querySelector('p.nothing')?.textContent).toBe('Nothing waiting on you.');
  } finally {
    page.url = new URL('http://localhost/');
  }
});

// Research draws the question and investigation boards as one board, each card with its kind's tag.
// A card's start, its confirm and its move read the card's own kind, so an investigation says what
// `investigate` runs on.
describe('the Research board', () => {
  const research = (kind: 'questions' | 'investigations', phase: 'research' | 'investigate', model: string, cards: ReturnType<typeof cardFixture>[]): BoardSnapshot => ({
    ...boardFixture('pull-request', cards),
    kind,
    stages: [
      { id: 'inbox', label: 'Inbox', role: 'you', count: cards.length, cadence: null, starts: null, says: 'you pick what goes next' },
      { id: 'research', label: 'Research', role: 'agent', count: 0, cadence: null, starts: { phase, model, effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } },
      { id: 'review', label: 'Review', role: 'you', count: 0, cadence: null, starts: null, says: 'you read the answer or the report' },
      { id: 'wrapup', label: 'Wrap-up', role: 'agent', count: 0, cadence: null, starts: { phase: 'wrapup', model, effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } },
      { id: 'done', label: 'Done', role: 'archive', count: 0, cadence: null, starts: null },
    ],
  });

  function openResearch() {
    drawnAt('/b/research');
    place(BoardPage as never, { research: true });
    place(ToastCorner as never, {});
    const boards = [research('questions', 'research', 'sonnet', [cardFixture({ key: 'Q-1', title: 'Where is the title checked?' })]), research('investigations', 'investigate', 'opus', [cardFixture({ key: 'INV-1', title: 'Why do uploads fail?' })])];
    nowLive.state = { ...nowLive.state, snapshot: { ...nowOf(boards[0]!), boards } };
    flushSync();
    place(Keyboard as never, { keys: pageKeys.now!.keys, actions: pageKeys.now!.actions });
    return {
      card: (key: string) => document.querySelector<HTMLElement>(`article[data-card="${key}"]`)!,
      column: (id: string) => document.querySelector<HTMLElement>(`section[data-stage="${id}"]`)!,
    };
  }

  it('draws both kinds in one Inbox, each with its tag, in the List view too', () => {
    const ui = openResearch();

    expect(document.querySelector('h1')?.textContent).toBe('Research');
    expect([...ui.column('inbox').querySelectorAll('article[data-card]')].map((card) => card.getAttribute('data-card'))).toEqual(['Q-1', 'INV-1']);
    expect(ui.card('Q-1').querySelector('[data-card-tag]')?.textContent).toBe('Question');
    expect(ui.card('INV-1').querySelector('[data-card-tag]')?.textContent).toBe('Investigation');
    // Research adds through its box, not Add card.
    expect(document.querySelector('#research-ask')).not.toBeNull();
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Add card'))).toBe(false);

    document.querySelector<HTMLButtonElement>('button[data-view="list"]')!.click();
    flushSync();
    expect([...document.querySelectorAll('[data-board-list] [data-card-tag]')].map((tag) => tag.textContent)).toEqual(['Question', 'Investigation']);
  });

  it("says what each card's own kind starts in the drop box and the confirm, and moves it to Research", async () => {
    const ui = openResearch();

    ui.card('INV-1').dispatchEvent(new Event('dragstart', { bubbles: true }));
    flushSync();
    ui.column('research').dispatchEvent(new Event('dragenter', { bubbles: true }));
    flushSync();
    expect(ui.column('research').querySelector('[data-drop="starts"]')?.textContent).toContain('opus');
    ui.card('INV-1').dispatchEvent(new Event('dragend', { bubbles: true }));
    flushSync();

    shiftRight(ui, 'Q-1');
    expect(document.querySelector('dialog[data-start-confirm]')?.textContent).toContain('Claude Code · sonnet · high');
    document.querySelector<HTMLButtonElement>('dialog[data-start-confirm] [data-confirm]')!.click();
    await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
    expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'Q-1', to: 'research' }));

    shiftRight(ui, 'INV-1');
    expect(document.querySelector('dialog[data-start-confirm]')?.textContent).toContain('Claude Code · opus · high');
  });

  // The investigation's own board holds the refused row, so the toast links Settings, Models, where that
  // row is set, and not the card settings a question's row would make it look like.
  it("links the setting of the card's own kind when its start is refused", () => {
    const ui = openResearch();
    const boards = nowLive.state.snapshot!.boards.map((board) =>
      board.kind === 'investigations' ? { ...board, stages: board.stages.map((stage) => (stage.id === 'research' ? { ...stage, starts: { ...stage.starts!, modelState: 'gone' as const } } : stage)) } : board,
    );
    nowLive.state = { ...nowLive.state, snapshot: { ...nowLive.state.snapshot!, boards } };
    flushSync();

    shiftRight(ui, 'INV-1');
    expect(document.querySelector('dialog[data-start-confirm]')).toBeNull();
    const toast = document.querySelector<HTMLElement>('.toast[data-kind="error"]');
    expect(toast?.querySelector('.message')?.textContent).toBe('INV-1 did not move to Research');
    expect(toast?.querySelector('[data-toast-link]')?.textContent).toBe('Open Settings, Models');
  });

  // Waiting on me keeps the person on Research, whose route has no board in its address.
  it('stays on Research when Waiting on me is pressed', () => {
    page.route = { id: '/b/research' };
    page.params = {};
    page.url = new URL('http://localhost/b/research');
    try {
      openResearch();
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Waiting on me'))!.click();
      expect(vi.mocked(goto)).toHaveBeenLastCalledWith('../b/research?w=1', { replaceState: true, keepFocus: true, noScroll: true });
    } finally {
      page.route = { id: '/' };
      page.url = new URL('http://localhost/');
    }
  });

  it('puts the focus in the add box on N, and adds the kind picked to its Inbox', async () => {
    openResearch();
    pageKeys.now!.actions.add!();
    flushSync();
    const box = document.querySelector<HTMLTextAreaElement>('#research-ask')!;
    expect(document.activeElement).toBe(box);

    posted.mockResolvedValueOnce(new Response(JSON.stringify({ key: 'INV-2', note: null }), { status: 201 }));
    box.value = 'Why is the list slow?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLInputElement>('input[name="research-kind"][value="investigations"]')!.click();
    flushSync();
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add to Inbox'))!.click();

    await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
    expect(posted.mock.calls[0]?.[0]).toBe('../api/cards');
    expect(JSON.parse(posted.mock.calls[0]?.[1].body as string)).toEqual({ input: '', title: 'Why is the list slow?', board: 'investigations' });
  });
});
