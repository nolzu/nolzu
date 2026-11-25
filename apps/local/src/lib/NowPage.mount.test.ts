import type { BoardSnapshot, CardView } from '@nolzu/protocol';
import { Keyboard } from '@nolzu/ui';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page } from '../../../../test/stubs/app-state.ts';
import NowRoute from '../routes/+page.svelte';
import type { NowSnapshot, RunRow } from './now.ts';
import { nowLive } from './now-live.svelte.ts';
import { follow } from './follow.svelte.ts';
import { pageKeys } from './page-keys.svelte.ts';
import { type QaAskOpen, qaAsk } from './qa-ask.svelte.ts';
import { toastStack } from './toast-stack.svelte.ts';
import { NO_TOASTS } from './board-page.ts';

// Now for real: the route reads the state the layout's stream writes, so a test writes that state the
// way the stream does and sees the page follow. fetch answers every write with 200.

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }));

const posted = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }));
let parts: { instance: object; target: HTMLElement }[] = [];

beforeEach(() => {
  posted.mockClear();
  vi.stubGlobal('fetch', posted);
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
});

afterEach(() => {
  for (const part of parts) {
    void unmount(part.instance);
    part.target.remove();
  }
  parts = [];
  vi.unstubAllGlobals();
  page.url = new URL('http://localhost/');
});

const place = (component: Parameters<typeof mount>[0], props: Record<string, unknown>) => {
  const target = document.body.appendChild(document.createElement('div'));
  parts.push({ instance: mount(component, { target, props }), target });
  flushSync();
};

const ASKS = cardFixture({
  key: 'APP-1',
  stage: 'plan',
  state: 'blocked',
  question: 'Stars or thumbs?',
  questionOptions: [
    { label: '1 to 5 stars', means: 'A new column.' },
    { label: 'Thumbs up and down', means: 'The likes table.' },
  ],
});
const READY = cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' });

const machine = (cards: CardView[], running: RunRow[] = [], version = 1): NowSnapshot => ({
  version,
  boards: [{ ...boardFixture('pull-request', cards), version } satisfies BoardSnapshot],
  waiting: Object.fromEntries(cards.map((card) => [card.key, { since: null, summary: null, resumable: true }])),
  running,
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 0, fresh: 0, newest: null },
});

// What the stream does: a new whole state.
function send(snapshot: NowSnapshot): void {
  nowLive.state = { snapshot, reconnecting: false, activity: {}, limits: {} };
  flushSync();
}

function open(snapshot: NowSnapshot) {
  drawnAt('/');
  send(snapshot);
  place(NowRoute as never, {});
  place(Keyboard as never, { keys: pageKeys.now!.keys, actions: pageKeys.now!.actions });
  return {
    item: (key: string) => document.querySelector<HTMLElement>(`article[data-now-item][data-card="${key}"]`),
    field: (key: string) => document.querySelector<HTMLTextAreaElement>(`#answer-${key}`)!,
  };
}

const option = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.opt')].find((one) => one.textContent?.trim() === label)!;

it('fills the answer on a press of an option, keeps typed text, and sends nothing', () => {
  const ui = open(machine([ASKS]));

  option('1 to 5 stars').click();
  flushSync();
  expect(ui.field('APP-1').value).toBe('1 to 5 stars');
  expect(option('1 to 5 stars').getAttribute('aria-pressed')).toBe('true');

  ui.field('APP-1').value = '1 to 5 stars\n\nKeep the old likes.';
  ui.field('APP-1').dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  option('Thumbs up and down').click();
  flushSync();
  expect(ui.field('APP-1').value).toBe('Thumbs up and down\n\nKeep the old likes.');
  expect(posted).not.toHaveBeenCalled();
});

it('shows Send and resume busy after the press, and the card running only once the snapshot says so', async () => {
  const ui = open(machine([ASKS]));
  const sendButton = () => document.querySelector<HTMLButtonElement>('[data-send-answer]');

  option('1 to 5 stars').click();
  flushSync();
  sendButton()!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/card/APP-1/answer');
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ answer: '1 to 5 stars' }));
  flushSync();

  // The server took it, and the board has not said so yet: the item stays, held, and nothing reads
  // running.
  await vi.waitFor(() => expect(ui.item('APP-1')?.querySelector('[role="status"]')?.textContent).toBe('Sent. Waiting for the board to queue the run.'));
  expect(sendButton()?.getAttribute('aria-busy')).toBe('true');
  expect(sendButton()?.getAttribute('aria-disabled')).toBe('true');
  expect(document.querySelector('.run[data-run]')).toBeNull();
  expect(document.querySelector('[data-state="running"]')).toBeNull();
  // A second press sends nothing more.
  sendButton()!.click();
  flushSync();
  expect(posted).toHaveBeenCalledOnce();

  // The board queues the run, then starts it.
  const job = (state: 'queued' | 'running'): RunRow => ({
    runId: 9,
    key: 'APP-1',
    title: ASKS.title,
    kind: 'card',
    phase: 'Plan',
    state,
    runState: state,
    position: state === 'queued' ? 1 : null,
    startedAt: state === 'running' ? new Date().toISOString() : null,
    model: 'sonnet',
    effort: 'medium',
    lane: null,
  });
  send(machine([{ ...ASKS, state: 'queued', runId: 9 }], [job('queued')], 2));
  expect(ui.item('APP-1')).toBeNull();
  expect(document.querySelector('.run[data-run="9"]')?.getAttribute('data-state')).toBe('queued');
  expect(document.querySelector('.run[data-run="9"] [data-state="running"]')).toBeNull();

  send(machine([{ ...ASKS, state: 'running', runId: 9 }], [job('running')], 3));
  expect(document.querySelector('.run[data-run="9"] .pill [data-state="running"]')).not.toBeNull();
  expect(document.querySelector('.run[data-run="9"] [aria-label="Stop APP-1"]')).not.toBeNull();
});

// The other answer tests ask on APP-1 alone. With two cards asking, the post, the busy button and the
// status line are those of the card the answer was typed in.
it('answers the card the answer was typed in, when two cards ask', async () => {
  const ui = open(machine([ASKS, { ...ASKS, key: 'APP-9', title: 'Pick a font' }]));
  const sendOf = (key: string) => ui.item(key)!.querySelector<HTMLButtonElement>('[data-send-answer]')!;

  ui.field('APP-9').value = 'Serif';
  ui.field('APP-9').dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  sendOf('APP-9').click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/card/APP-9/answer');
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ answer: 'Serif' }));
  flushSync();
  expect(sendOf('APP-9').getAttribute('aria-busy')).toBe('true');
  expect(sendOf('APP-1').getAttribute('aria-busy')).toBeNull();
});

it('says a refused answer beside the field and lets the person send again', async () => {
  posted.mockImplementationOnce(async () => new Response(JSON.stringify({ message: 'APP-1 is queued and not blocked, so no question is waiting for an answer.' }), { status: 409 }));
  const ui = open(machine([ASKS]));

  option('1 to 5 stars').click();
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-send-answer]')!.click();
  await vi.waitFor(() => expect(ui.item('APP-1')?.querySelector('[role="status"]')?.textContent).toBe('APP-1 is queued and not blocked, so no question is waiting for an answer.'));
  expect(document.querySelector('[data-send-answer]')?.getAttribute('aria-busy')).toBeNull();
});

// Approve is the consent, as a drop is: one press posts the move a drop on the next column posts, and
// the button holds until the board shows the card moved.
it('posts the move on Approve and holds the button until the board moves the card', async () => {
  open(machine([READY]));
  const approve = () => document.querySelector<HTMLButtonElement>('[data-approve]');

  expect(approve()?.textContent).toContain('Approve and start Implement');
  approve()!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/board/move');
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-2', to: 'implement' }));
  flushSync();
  expect(approve()?.getAttribute('aria-busy')).toBe('true');
  // A second press while it holds sends nothing more.
  approve()!.click();
  await Promise.resolve();
  expect(posted).toHaveBeenCalledOnce();

  // The same snapshot again changes nothing: the card is where it was, so the press still holds.
  send(machine([READY], [], 2));
  expect(approve()?.getAttribute('aria-busy')).toBe('true');
  send(machine([{ ...READY, stage: 'implement', state: 'queued' }], [], 3));
  expect(approve()).toBeNull();
});

// Two cards and no APP-1, so a write that names the wrong card goes nowhere it should.
it('retries a failed run and sends a QA failure back, each for its own card', async () => {
  const failed = cardFixture({ key: 'APP-5', stage: 'refine', state: 'failed', failureReason: 'The engine stopped.' });
  const qa = cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  open(machine([failed, qa]));

  document.querySelector<HTMLButtonElement>('[data-card="APP-5"] [data-retry]')!.click();
  document.querySelector<HTMLButtonElement>('[data-card="APP-4"] [data-send-back]')!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(posted.mock.calls.map((call) => [call[0], call[1].body])).toEqual([
    ['./api/card/APP-5/retry', '{}'],
    ['./api/board/move', JSON.stringify({ key: 'APP-4', to: 'implement' })],
  ]);
});

// Fix it on its own card's route, and it holds until the board shows the card moved.
it('posts Fix it for the QA failure it sits on', async () => {
  const other = cardFixture({ key: 'APP-3', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The page is blank.' });
  const qa = cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  open(machine([other, qa]));

  document.querySelector<HTMLButtonElement>('[data-card="APP-4"] [data-fix]')!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
  expect(posted.mock.calls.map((call) => [call[0], call[1].body])).toEqual([['./api/card/APP-4/fix', '{}']]);
  expect(document.querySelector('[data-card="APP-4"] [data-fix]')?.getAttribute('aria-busy')).toBe('true');
});

it('goes to the next card that waits on J', () => {
  open(machine([ASKS, READY]));

  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  flushSync();
  expect(document.activeElement?.getAttribute('data-card')).toBe('APP-1');
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  flushSync();
  expect(document.activeElement?.getAttribute('data-card')).toBe('APP-2');
});

it('stops a running run and removes a queued one through the stop route', async () => {
  const row = (runId: number, key: string, state: 'running' | 'queued'): RunRow => ({
    runId,
    key,
    title: `${key} title`,
    kind: key === 'kb-maintenance' ? 'maintenance' : 'card',
    phase: 'Implement',
    state,
    runState: state,
    position: state === 'queued' ? 1 : null,
    startedAt: null,
    model: null,
    effort: null,
    lane: null,
  });
  open(machine([], [row(4, 'kb-maintenance', 'running'), row(5, 'APP-7', 'queued')]));

  document.querySelector<HTMLButtonElement>('[aria-label="Stop maintenance"]')!.click();
  document.querySelector<HTMLButtonElement>('[aria-label="Remove APP-7 from the queue"]')!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(posted.mock.calls.map((call) => [call[0], call[1].body])).toEqual([
    ['./api/board/stop', JSON.stringify({ runId: 4 })],
    ['./api/board/stop', JSON.stringify({ runId: 5 })],
  ]);
  // A second press while the row still runs sends nothing more: the stop holds until the snapshot moves.
  flushSync();
  expect(document.querySelector('[data-stop="4"]')?.getAttribute('aria-busy')).toBe('true');
  document.querySelector<HTMLButtonElement>('[aria-label="Stop maintenance"]')!.click();
  await Promise.resolve();
  expect(posted).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.run[data-run="4"]')?.textContent).toContain('Knowledge maintenance');
});

// Now draws no Add card. N still adds one, on the board this tab was last on, so the card lands
// where the person can see it. The board page opens the dialog on `?add`.
it('draws no Add card, and N opens Add card on the last board', () => {
  sessionStorage.setItem('nolzu.lastBoard', 'epics');
  try {
    open(machine([READY]));
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Add card'))).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    flushSync();
    expect(goto).toHaveBeenCalledWith('./b/epics?add');
    expect(document.querySelector('dialog')).toBeNull();
  } finally {
    sessionStorage.clear();
  }
});

// The layout names the note while a project of one repository has the offer. Got it
// stores it, and the next load names none, which the layout's own test proves.
it('offers Make this a workspace once, links the form on Projects, and stores Got it', () => {
  page.data = { workspaceNote: 'make-workspace' };
  try {
    open(machine([]));
    const note = () => document.querySelector<HTMLElement>('[role="note"]');
    expect(note()?.textContent).toContain('Make this a workspace');
    expect(note()?.querySelector('a')?.getAttribute('href')).toBe('./settings/project#convert');

    note()!.querySelector<HTMLButtonElement>('[data-dismiss-note]')!.click();
    flushSync();
    expect(note()).toBeNull();
    expect(posted).toHaveBeenCalledWith('./api/notes', expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'make-workspace' }) }));
  } finally {
    page.data = {};
  }
});

it('shows no note when the layout names none', () => {
  open(machine([]));
  expect(document.querySelector('[role="note"]')).toBeNull();
});

// On Now: the rows that wait and the rows that run are one list for J and K, Space peeks at the
// card of the row with the focus, and the sheet follows J and K. Shift Up puts a queued run first, as on
// the board, where Now had no key for it.
describe('the keys of the rows, and Peek on Now', () => {
  const run = (runId: number, key: string, state: 'running' | 'queued'): RunRow => ({
    runId,
    key,
    title: `${key} title`,
    kind: 'card',
    phase: 'Implement',
    state,
    runState: state,
    position: state === 'queued' ? 1 : null,
    startedAt: state === 'running' ? new Date().toISOString() : null,
    model: 'sonnet',
    effort: 'high',
    lane: null,
  });
  const RUNS = cardFixture({ key: 'APP-6', stage: 'implement', state: 'running', runId: 6, runState: 'running', title: 'APP-6 title' });
  const WAITS = cardFixture({ key: 'APP-7', stage: 'implement', state: 'queued', runId: 7, runState: 'queued', title: 'APP-7 title' });
  const press = (key: string, over: KeyboardEventInit = {}) => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over }));
    flushSync();
  };
  const sheet = () => document.querySelector<HTMLElement>('aside[data-peek]');

  beforeEach(() => {
    posted.mockImplementation(async (url: string) => {
      const peek = /\/api\/card\/([^/]+)\/peek$/.exec(url);
      if (peek === null) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ key: decodeURIComponent(peek[1]!), summary: null, log: null, tokens: null, trail: [], retry: null }), { status: 200 });
    });
  });

  it('goes through what waits and then what runs on J and K, with the sheet following', async () => {
    open(machine([ASKS, RUNS, WAITS], [run(6, 'APP-6', 'running'), run(7, 'APP-7', 'queued')]));

    press('j');
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-1');
    press(' ');
    expect(sheet()?.dataset['peek']).toBe('APP-1');

    press('j');
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-6');
    await vi.waitFor(() => expect(sheet()?.dataset['peek']).toBe('APP-6'));
    expect(sheet()?.querySelector('h2')?.textContent).toBe('APP-6 title');
    // A running card's sheet offers Stop and the move back, which stops the run first.
    expect(sheet()?.querySelector('[data-peek-stop]')).not.toBeNull();
    expect(sheet()?.querySelector('[data-peek-back]')?.textContent).toContain('Move back to Plan');

    press('k');
    await vi.waitFor(() => expect(sheet()?.dataset['peek']).toBe('APP-1'));

    press('Escape');
    expect(sheet()).toBeNull();
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-1');
  });

  // A Scout assessment runs on no card, so the key handler gives its row no key. J that stopped there
  // could not move on, and the sheet would close for a row with no card.
  it('walks past a row with no card, and the sheet stays open', async () => {
    const assessment: RunRow = { ...run(9, 'SCOUT-3', 'running'), title: null, kind: 'assessment' };
    open(machine([RUNS, WAITS], [run(6, 'APP-6', 'running'), assessment, run(7, 'APP-7', 'queued')]));

    press('j');
    press(' ');
    expect(sheet()?.dataset['peek']).toBe('APP-6');

    press('j');
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-7');
    await vi.waitFor(() => expect(sheet()?.dataset['peek']).toBe('APP-7'));
    press('k');
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-6');
    await vi.waitFor(() => expect(sheet()?.dataset['peek']).toBe('APP-6'));
  });

  // The sheet draws Cmd . on Stop and Enter on Open card, so Now binds both. Shift Left is in the help
  // only while the sheet is open, where it is the sheet's Move back.
  it("stops the row's run on Cmd . and opens its card on Enter, and lists Move back only with the sheet open", async () => {
    open(machine([RUNS], [run(6, 'APP-6', 'running')]));
    const listed = () => pageKeys.now!.keys.map((binding) => binding.action);
    expect(listed()).toEqual(expect.arrayContaining(['stop', 'open']));
    expect(listed()).not.toContain('move-back');

    press('j');
    press('.', { metaKey: true });
    await vi.waitFor(() => expect(posted.mock.calls.filter((call) => call[0] === './api/board/stop').map((call) => call[1].body)).toEqual([JSON.stringify({ runId: 6 })]));

    press(' ');
    expect(listed()).toContain('move-back');

    press('Enter');
    expect(goto).toHaveBeenCalledWith('./t/APP-6');
  });

  it('puts a queued run first on Shift Up, and leaves a running one alone', async () => {
    toastStack.state = NO_TOASTS;
    open(machine([RUNS, WAITS], [run(6, 'APP-6', 'running'), run(7, 'APP-7', 'queued')]));

    press('j');
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-6');
    press('ArrowUp', { shiftKey: true });
    press('j');
    expect(document.activeElement?.getAttribute('data-card')).toBe('APP-7');
    press('ArrowUp', { shiftKey: true });

    await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
    expect(posted.mock.calls[0]?.[0]).toBe('./api/board/promote');
    expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ runId: 7 }));
    // The press belongs to the card of the queued row, which is the one a refusal toast would name.
    expect(Object.keys(toastStack.state.latest)).toEqual(['APP-7']);
  });

  // On Now: the palette names the card it moved, and Now gives its row the focus once it moved.
  it('gives the focus to the row of a card the palette moved', async () => {
    const ready = { ...READY, key: 'APP-2' };
    open(machine([ASKS, ready]));
    document.querySelector<HTMLElement>('article[data-now-row][data-card="APP-1"]')!.focus();

    follow.state = { key: 'APP-2', to: 'plan' };
    flushSync();

    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-card')).toBe('APP-2'));
    expect(follow.state).toBeNull();
  });
});

// Read through a call, so the type is not narrowed to the null the test set.
const asked = (): QaAskOpen | null => qaAsk.state;

// A card the chain left before QA waits here with the question one press away: Approve asks it, sends
// nothing, and lets the button go, and Start QA sends the move Approve would have sent.
it('asks the question at the first QA on Approve, and sends the move once it is answered', async () => {
  qaAsk.state = null;
  const qaSetup = { project: 'recipes', repo: null, dev: null, scripts: '', unwalled: null, address: '', test: null, playwright: false, chrome: false, browser: false };
  open({ ...machine([cardFixture({ key: 'APP-2', stage: 'implement', state: 'ready' })]), qaSetup });
  const approve = () => document.querySelector<HTMLButtonElement>('[data-approve]');

  expect(approve()?.textContent).toContain('Approve and start QA');
  approve()!.click();
  await Promise.resolve();
  flushSync();
  expect(posted).not.toHaveBeenCalled();
  expect(asked()?.key).toBe('APP-2');
  await vi.waitFor(() => {
    flushSync();
    expect(approve()?.getAttribute('aria-busy')).toBeNull();
  });

  void asked()?.go();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[1].body).toBe(JSON.stringify({ key: 'APP-2', to: 'qa' }));
  qaAsk.state = null;
});

// Card keys repeat across projects and another tab can pick another project, so every press names
// the project the snapshot serves.
it('posts each press to the project Now serves', async () => {
  const run: RunRow = { runId: 5, key: 'APP-9', title: 'APP-9 title', kind: 'card', phase: 'Implement', state: 'running', runState: 'running', position: null, startedAt: null, model: null, effort: null, lane: null };
  open({ ...machine([READY], [run]), project: 1 });

  document.querySelector<HTMLButtonElement>('[data-card="APP-2"] [data-approve]')!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
  document.querySelector<HTMLButtonElement>('[aria-label="Stop APP-9"]')!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(posted.mock.calls.map((call) => [call[0], call[1].body])).toEqual([
    ['./api/board/move?project=1', JSON.stringify({ key: 'APP-2', to: 'implement' })],
    ['./api/board/stop?project=1', JSON.stringify({ runId: 5 })],
  ]);
  expect(document.querySelector('h3.group')).toBeNull();
});

it('posts an answer to the project Now serves', async () => {
  open({ ...machine([ASKS]), project: 1 });
  option('1 to 5 stars').click();
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-card="APP-1"] [data-send-answer]')!.click();
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(posted.mock.calls[0]?.[0]).toBe('./api/card/APP-1/answer?project=1');
});

// The run writes Markdown. Now draws it as Markdown, and a long one waits behind Show all.
it('draws the run summary as Markdown, and holds a long one until Show all', () => {
  const summary = 'All 8 steps are done.\n\nBackend:\n- New flag `sessionPublished`\n- Two\n- Three\n- Four\n- Five\n- Six';
  const snapshot = machine([READY]);
  open({ ...snapshot, waiting: { 'APP-2': { since: null, summary, resumable: true } } });
  const box = document.querySelector<HTMLElement>('#summary-APP-2')!;
  const more = () => document.querySelector<HTMLButtonElement>('button.more');

  expect(box.querySelectorAll('li')).toHaveLength(6);
  expect(box.querySelector('code')?.textContent).toBe('sessionPublished');
  expect(box.classList.contains('clamp')).toBe(true);
  expect(more()?.textContent).toBe('Show all');
  expect(more()?.getAttribute('aria-expanded')).toBe('false');

  more()!.click();
  flushSync();
  expect(box.classList.contains('clamp')).toBe(false);
  expect(more()?.textContent).toBe('Show less');
  expect(more()?.getAttribute('aria-expanded')).toBe('true');
});

// A card under Waiting on you is one header row: a long title is cut to one line and keeps the
// whole sentence in its title attribute, and the time stays in that row.
it('draws one header row, with the whole title in its title attribute', () => {
  const long = 'As a cook I want to rate a recipe with stars so that the best ones rise to the top of the list';
  open(machine([{ ...READY, title: long }]));
  const head = document.querySelector('[data-card="APP-2"] .hd')!;
  const title = head.querySelector<HTMLAnchorElement>('a.tt')!;

  expect(title.textContent).toBe(long);
  expect(title.getAttribute('title')).toBe(long);
  expect(title.getAttribute('href')).toContain('/t/APP-2');
  expect(head.querySelector('.when')?.textContent).toBe('Plan');
});

// The main action comes first, then the link and Send back, and the cost line last, in the order a
// screen reader reads them.
it('puts the main action first with its cost line, then the link and Send back', () => {
  open(machine([READY]));
  const acts = document.querySelector('[data-card="APP-2"] .acts')!;
  const order = [...acts.querySelectorAll('[data-approve], a.link, [data-send-back], .cost')].map((one) => (one.matches('[data-approve]') ? 'start' : one.matches('a.link') ? 'link' : one.matches('.cost') ? 'cost' : 'back'));

  expect(order).toEqual(['start', 'cost', 'link', 'back']);
});

it('holds a four line summary behind Show all', () => {
  open({ ...machine([READY]), waiting: { 'APP-2': { since: null, summary: 'One.\nTwo.\nThree.\nFour.', resumable: true } } });

  expect(document.querySelector('#summary-APP-2')?.classList.contains('clamp')).toBe(true);
  expect(document.querySelector('button.more')?.textContent).toBe('Show all');
});

it('draws a short summary whole, with no Show all', () => {
  const snapshot = machine([READY]);
  open({ ...snapshot, waiting: { 'APP-2': { since: null, summary: '# Plan\n\nThe plan has **8 steps**.', resumable: true } } });

  expect(document.querySelector('#summary-APP-2 strong')?.textContent).toBe('8 steps');
  // Under Now, Waiting on you and a project name, a heading the run wrote starts at h4.
  expect(document.querySelector('#summary-APP-2 h4')?.textContent).toBe('Plan');
  expect(document.querySelector('#summary-APP-2 h1')).toBeNull();
  expect(document.querySelector('#summary-APP-2')?.classList.contains('clamp')).toBe(false);
  expect(document.querySelector('button.more')).toBeNull();
});

it('draws what a card done today said as Markdown', () => {
  const snapshot = machine([]);
  open({ ...snapshot, done: [{ key: 'APP-3', title: 'Add a search box', summary: 'Done:\n- the box\n- `search()`', costUsd: null, durationMs: 1000 }] });

  const said = document.querySelector<HTMLElement>('.said')!;
  expect(said.querySelectorAll('li')).toHaveLength(2);
  expect(said.querySelector('code')?.textContent).toBe('search()');
});
