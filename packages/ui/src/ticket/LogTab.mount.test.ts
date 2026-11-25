import type { RunEvent } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { cardFixture } from '../board/fixture.ts';
import LogTab from './LogTab.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
  vi.restoreAllMocks();
});

const EVENTS: RunEvent[] = [
  { type: 'text', text: 'One.' },
  { type: 'tool', name: 'Read', input: {} },
  { type: 'tool', name: 'Grep', input: {} },
  { type: 'text', text: 'Two.' },
];

// A run that failed before its first line has an empty log, so the tab says why it failed above it.
it('says why the shown run failed, and that it wrote no lines', () => {
  const runs = [
    { id: 6, phase: 'refine', state: 'failed', startedAt: null, failureReason: 'The Cursor CLI engine stopped with exit code 1.' },
    { id: 5, phase: 'refine', state: 'running', startedAt: null },
  ];
  page = mounted(LogTab as never, { runs, selected: 6, events: [], runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });

  expect(page.target.querySelector('[data-run-failed]')?.textContent).toBe('Refine failed: The Cursor CLI engine stopped with exit code 1.');
  expect(page.target.textContent).toContain('The run wrote no lines.');

  page.remove();
  page = mounted(LogTab as never, { runs, selected: 5, events: [], runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });
  expect(page.target.querySelector('[data-run-failed]')).toBeNull();
  expect(page.target.textContent).toContain('No lines yet.');
});

it('follows a live run to its newest line until the box is cleared, and offers nothing to follow on an ended run', () => {
  const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const live = { runs: [{ id: 5, phase: 'plan', state: 'running', startedAt: null }], selected: 5, events: EVENTS.slice(0, 1), runHref: (id: number) => `?run=${id}`, rawHref: '/raw' };
  page = mounted(LogTab as never, live);
  scrolled.mockClear();

  page.set({ events: EVENTS.slice(0, 2) });
  expect(scrolled).toHaveBeenCalledOnce();

  page.target.querySelector<HTMLInputElement>('#follow-log')!.click();
  flushSync();
  scrolled.mockClear();
  page.set({ events: EVENTS });
  expect(scrolled).not.toHaveBeenCalled();

  page.remove();
  page = mounted(LogTab as never, { ...live, runs: [{ id: 5, phase: 'plan', state: 'complete', startedAt: null }], events: EVENTS });
  expect(page.target.querySelector('#follow-log')).toBeNull();
  expect(scrolled).not.toHaveBeenCalled();
});

it('hides the tool calls when asked, and says how many it hid', () => {
  page = mounted(LogTab as never, { runs: [{ id: 5, phase: 'plan', state: 'complete', startedAt: null }], selected: 5, events: EVENTS, runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });
  const box = page.target.querySelector<HTMLInputElement>('#hide-tools')!;

  box.click();
  flushSync();

  expect(page.target.querySelectorAll('[data-kind="tool"]')).toHaveLength(0);
  expect(page.target.textContent).toContain('2 tool calls hidden');
});

it('hides only the tool calls and their results, and keeps every other row', () => {
  const events: RunEvent[] = [
    { type: 'session', sessionId: '3e9b71d0', model: 'sonnet', apiKeyMode: false },
    { type: 'text', text: 'One.' },
    { type: 'tool', name: 'Read', input: {} },
    { type: 'tool_result', bytes: 2970, error: false },
    { type: 'usage', id: 'msg_1', tokens: { input: 400, output: 18_000, cacheRead: 0, cacheCreation: 0 } },
    { type: 'api_retry', attempt: 1, delayMs: 2000, status: 529, maxRetries: null, reason: null },
    { type: 'complete', costUsd: null, durationMs: null, tokens: null },
  ];
  page = mounted(LogTab as never, { runs: [{ id: 5, phase: 'plan', state: 'complete', startedAt: null }], selected: 5, events, runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });
  const kinds = () => [...page!.target.querySelectorAll('[data-kind]')].map((row) => row.getAttribute('data-kind'));

  expect(kinds()).toEqual(['session', 'text', 'tool', 'result', 'usage', 'retry', 'complete']);
  page.target.querySelector<HTMLInputElement>('#hide-tools')!.click();
  flushSync();

  expect(kinds()).toEqual(['session', 'text', 'usage', 'retry', 'complete']);
});

it('sends Stop for the shown run, and holds it until the board shows the card stopped', async () => {
  const sent: number[] = [];
  const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'running', runId: 5 });
  page = mounted(LogTab as never, {
    runs: [{ id: 5, phase: 'plan', state: 'running', startedAt: null }],
    selected: 5,
    events: [],
    runHref: (id: number) => `?run=${id}`,
    rawHref: '/raw',
    card,
    onstop: async (runId: number) => {
      sent.push(runId);
      return null;
    },
  });
  const stop = () => page!.target.querySelector<HTMLButtonElement>('[data-run="stop"]');

  stop()!.click();
  await Promise.resolve();
  flushSync();

  expect(sent).toEqual([5]);
  expect(stop()!.getAttribute('aria-busy')).toBe('true');
  page.set({ card: { ...card, state: 'idle', runId: null } });

  expect(stop()).toBeNull();
});

it('holds Stop for a card that is not APP-1, and lets go when the board shows another card', async () => {
  const card = cardFixture({ key: 'APP-2', stage: 'plan', state: 'running', runId: 7 });
  page = mounted(LogTab as never, {
    runs: [{ id: 7, phase: 'plan', state: 'running', startedAt: null }],
    selected: 7,
    events: [],
    runHref: (id: number) => `?run=${id}`,
    rawHref: '/raw',
    card,
    onstop: async () => null,
  });
  const stop = () => page!.target.querySelector<HTMLButtonElement>('[data-run="stop"]');

  stop()!.click();
  await Promise.resolve();
  flushSync();
  expect(stop()!.getAttribute('aria-busy')).toBe('true');

  page.set({ card: { ...card, key: 'APP-3' } });
  flushSync();
  expect(stop()!.getAttribute('aria-busy')).toBeNull();
});

// The browser renders what the agent says as markdown, the way it laid it out, and the closing marker
// is not said at all.
it('renders a says row as markdown, without the closing marker', () => {
  const events: RunEvent[] = [{ type: 'text', text: '## What changed\n\nThe card shows a **placeholder**.\n\nNOLZU: complete' }];
  page = mounted(LogTab as never, { runs: [{ id: 5, phase: 'plan', state: 'complete', startedAt: null }], selected: 5, events, runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });
  const row = page.target.querySelector('[data-kind="text"]')!;

  expect(row.querySelector('h5')?.textContent).toBe('What changed');
  expect(row.querySelector('strong')?.textContent).toBe('placeholder');
  expect(row.textContent).not.toContain('##');
  expect(row.textContent).not.toContain('NOLZU');
});

// The router takes a GET form like a link, so the pick lands on the same ?run= address a row links to.
it('goes to the run picked in the narrow screen select', () => {
  const sent: string[] = [];
  const submit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (this: HTMLFormElement) {
    sent.push(new URLSearchParams(new FormData(this) as never).toString());
  });
  const runs = [
    { id: 5, phase: 'plan', state: 'running', startedAt: null },
    { id: 3, phase: 'refine', state: 'complete', startedAt: null },
  ];
  page = mounted(LogTab as never, { runs, selected: 5, events: [], runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });
  const pick = page.target.querySelector<HTMLSelectElement>('#log-run')!;

  expect(pick.value).toBe('5');
  pick.value = '3';
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  submit.mockRestore();

  expect(sent).toEqual(['run=3']);
});

// jsdom lays nothing out, so the boxes are given: the list shows 0 to 100px, and the picked row sits
// at 300px. The list scrolls by the 230px that brings the row's bottom in, and the page does not.
it('scrolls the list, and only the list, to an older run opened from a link', () => {
  const scrolled = new WeakMap<Element, number>();
  const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('runs')) return box(0, 100) as DOMRect;
    if (this.classList.contains('current')) return box(300 - (scrolled.get(this.closest('.runs')!) ?? 0), 330) as DOMRect;
    return box(0, 0) as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) {
    scrolled.set(this, value);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
    return scrolled.get(this) ?? 0;
  });
  const scrollPage = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const runs = Array.from({ length: 12 }, (_, index) => ({ id: 12 - index, phase: 'plan', state: 'complete', startedAt: null }));

  page = mounted(LogTab as never, { runs, selected: 1, events: [], runHref: (id: number) => `?run=${id}`, rawHref: '/raw' });
  const list = page.target.querySelector('.runs')!;

  expect(scrolled.get(list)).toBe(230);
  expect(scrollPage).not.toHaveBeenCalled();
});
