import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EvidenceBlock, evidenceDays, spendOf, type Standup, standupLists, standupTextOf } from '@nolzu/protocol';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import StandupComposer from './StandupComposer.svelte';

// Pinned days, because the text names the day it was built from and the stored edit is keyed by it.
// DAY is the Wednesday the blocks fall on, and the standup is the Thursday after.
const DAY = '2026-03-04';
const TODAY = '2026-03-05';

const block = (at: string, source: EvidenceBlock['source'], ref: string, description: string, over: Partial<EvidenceBlock> = {}): EvidenceBlock => ({
  start: `${DAY}T${at}Z`,
  source,
  ref,
  card: 'APP-1',
  cardTitle: 'Add a search box',
  description,
  durationMs: null,
  spend: null,
  running: false,
  ...over,
});

// Through the fold, so the panel gets its blocks the way the route hands them over. One card in
// progress, so the text has a line under Today as well.
const dayOf = (blocks: readonly EvidenceBlock[]): Standup => ({
  day: TODAY,
  yesterday: { ...(evidenceDays(blocks)[0] ?? { day: DAY, blocks: [], spend: spendOf([]) }), problem: null },
  cards: [{ key: 'APP-1', title: 'Add a search box', stage: 'Implement', blocked: false }],
});

// The key the panel writes, named here so a test can plant a record and read one back. A panel that
// changed the key would leave every saved edit behind, which is worth failing over.
const KEPT = 'nolzu.standup';

const MORNING = [block('09:00:00.000', 'move', '1', 'Moved from Inbox to Implement'), block('09:00:01.000', 'run', '1', 'Implement run, finished')];

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
  localStorage.clear();
});

const open = (day: Standup): HTMLElement => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(StandupComposer, { target, props: { standup: day } }) as Record<string, unknown>;
  flushSync();
  return target;
};

// A reload is a fresh mount with the same props, which is what the route does on every load.
const reload = (day: Standup): HTMLElement => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  return open(day);
};

// Three labelled boxes, Yesterday, Today and Blocked, cut from the same lines as the text.
type Part = 'yesterday' | 'today' | 'blocked';
const box = (root: HTMLElement, part: Part = 'yesterday') => root.querySelector<HTMLTextAreaElement>(`#standup-${part}`)!;
const all = (root: HTMLElement) => ({ yesterday: box(root, 'yesterday').value, today: box(root, 'today').value, blocked: box(root, 'blocked').value });

const type = (root: HTMLElement, words: string, part: Part = 'yesterday') => {
  const field = box(root, part);
  field.value = words;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

const press = (root: HTMLElement, what: string) => {
  root.querySelector<HTMLButtonElement>(`[data-${what}]`)!.click();
  flushSync();
};

const copy = () => (instance as unknown as { copy: () => Promise<void> }).copy();

const generated = (day: Standup) => {
  const lists = standupLists(day);
  return { yesterday: lists.yesterday, today: lists.today, blocked: lists.blocked };
};

it('opens with the three lists built from the day, each under its label', () => {
  const root = open(dayOf(MORNING));

  expect(all(root)).toEqual(generated(dayOf(MORNING)));
  expect(box(root).value).toContain('- run: Implement run, finished');
  expect(box(root, 'today').value).toBe('- APP-1, Add a search box (Implement)');
  expect([...root.querySelectorAll('label')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Yesterday Wed 4 Mar', 'Today', 'Blocked']);
  expect(root.textContent).toContain('Nothing is posted from here.');
  // Nothing to put back yet, so the way back is not offered.
  expect(root.querySelector('[data-regenerate]')).toBeNull();
});

it('gives the edit back after a reload', () => {
  const day = dayOf(MORNING);
  type(open(day), 'APP-1: search box is in QA.');

  expect(box(reload(day)).value).toBe('APP-1: search box is in QA.');
  expect(box(reload(day), 'today').value).toBe(generated(day).today);
});

it('ignores an edit kept under another day, and a record of the old one-box shape', () => {
  localStorage.setItem(KEPT, JSON.stringify({ day: '2026-03-03', parts: { yesterday: 'Yesterday I wrote this.', today: '', blocked: '' }, generated: 'anything' }));
  expect(all(open(dayOf(MORNING)))).toEqual(generated(dayOf(MORNING)));

  localStorage.setItem(KEPT, JSON.stringify({ day: TODAY, text: 'One box.', generated: 'anything' }));
  expect(all(reload(dayOf(MORNING)))).toEqual(generated(dayOf(MORNING)));
});

// The hard case: a run lands after the edit was saved. The person's words win, and the panel says the
// boxes are behind the list rather than letting them paste a text that is missing the afternoon.
it('keeps the edit when the day moves on, and says the boxes are behind', () => {
  type(open(dayOf(MORNING)), 'APP-1: search box is in QA.');

  const later = dayOf([...MORNING, block('14:45:00.000', 'run', '2', 'QA run, failed')]);
  const root = reload(later);

  expect(box(root).value).toBe('APP-1: search box is in QA.');
  expect(root.querySelector('[data-behind]')?.textContent).toContain('so the boxes are behind them');
  // And the way out is one button.
  press(root, 'regenerate');
  expect(all(root)).toEqual(generated(later));
  expect(root.querySelector('[data-behind]')).toBeNull();
  expect(all(reload(later))).toEqual(generated(later));
});

// Typing again is the person answering the warning, so the boxes stop being called behind.
it('drops the warning once the person types again', () => {
  type(open(dayOf(MORNING)), 'APP-1: search box is in QA.');
  const later = dayOf([...MORNING, block('14:45:00.000', 'run', '2', 'QA run, failed')]);
  const root = reload(later);
  expect(root.querySelector('[data-behind]')).not.toBeNull();

  type(root, 'APP-1: search box is in QA, and QA failed.');
  expect(root.querySelector('[data-behind]')).toBeNull();
  expect(box(reload(later)).value).toBe('APP-1: search box is in QA, and QA failed.');
});

// Three empty boxes are not an answer somebody wants to paste, so they are the same way back as the
// button.
it('brings the generated lists back when every box is emptied', () => {
  const day = dayOf(MORNING);
  const root = open(day);
  type(root, 'APP-1: search box is in QA.');
  type(root, '');
  expect(localStorage.getItem(KEPT)).not.toBeNull();
  type(root, '', 'today');
  type(root, '', 'blocked');

  expect(localStorage.getItem(KEPT)).toBeNull();
  expect(all(reload(day))).toEqual(generated(day));
});

// jsdom has no clipboard, which is the branch a real browser reaches when it refuses one. The note
// names what happened and what to do instead.
it('says what to do when the browser refuses the copy', async () => {
  const root = open(dayOf(MORNING));
  await copy();
  flushSync();

  expect(root.querySelector('[role="status"]')?.textContent).toContain('Select the text in the boxes');
});

// The plan's case: Copy copies exactly what the boxes show, an edit included, joined under their
// headings, and not the generated text behind them.
it('copies exactly what the boxes show', async () => {
  const copied: string[] = [];
  const was = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (said: string) => void copied.push(said) }, configurable: true });
  try {
    const day = dayOf(MORNING);
    const root = open(day);
    type(root, '- APP-1 is in QA.');
    await copy();
    flushSync();

    expect(copied).toEqual([standupTextOf({ ...standupLists(day), yesterday: '- APP-1 is in QA.' })]);
    expect(copied[0]).toContain('Yesterday (Wednesday 2026-03-04):\n- APP-1 is in QA.\n\nToday:\n- APP-1, Add a search box (Implement)');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Copied.');
  } finally {
    if (was === undefined) Reflect.deleteProperty(navigator, 'clipboard');
    else Object.defineProperty(navigator, 'clipboard', was);
  }
});

/*
 * The two tests below are the plan's third one: no network call exists in the code path, asserted by
 * there being no call to stub. They prove it from two sides, because either side alone is theatre.
 *
 * The first walks the whole path a person walks and leaves a tripwire on every way out of the
 * process. It records rather than only throwing, because the copy button catches its own failures and
 * would swallow a thrower. A branch no test reaches can still hide a call, which is why the second
 * test exists.
 *
 * The second reads the source of the two files that are the whole path, the way
 * packages/runner/src/git/push.test.ts proves no force flag. The path is two files and no more: the
 * panel imports @nolzu/protocol and nothing else, that package is pure, and the route already had the
 * day, so no load, no endpoint and no form action was added for this feature. Comments are not
 * stripped before matching, so a comment that writes one of these names with a bracket after it turns
 * this red. That is the safe direction for a test about an absence.
 */

const WAYS_OUT = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\$app\/forms/, /\$app\/navigation/, /use:enhance/, /method=["']post["']/i, /https?:\/\//];

it('calls nothing outside the process, on the whole path a person walks', async () => {
  const calls: string[] = [];
  const trip = (name: string) => () => {
    calls.push(name);
    throw new Error(`${name} was called`);
  };
  const host = globalThis as unknown as Record<string, unknown>;
  const was = new Map(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => [name, host[name]] as const));
  const beacon = navigator.sendBeacon;
  for (const name of was.keys()) host[name] = trip(name);
  Object.defineProperty(navigator, 'sendBeacon', { value: trip('sendBeacon'), configurable: true });

  try {
    const day = dayOf(MORNING);
    const first = open(day);
    expect(box(first).value).toContain('- run: Implement run, finished');
    type(first, 'APP-1: search box is in QA.');
    const second = reload(day);
    await copy();
    flushSync();
    press(second, 'regenerate');
  } finally {
    for (const [name, value] of was) host[name] = value;
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  }

  expect(calls).toEqual([]);
});

it('holds no way out of the process in either file of the path', () => {
  // Joined and not a URL: jsdom's own URL is what this environment gives, and node refuses to read
  // a file from it.
  const panel = readFileSync(join(import.meta.dirname, 'StandupComposer.svelte'), 'utf8');
  const pure = readFileSync(join(import.meta.dirname, '../../../../packages/protocol/src/standup.ts'), 'utf8');

  // A renamed file would throw above, and a file that lost its own feature would pass every rule
  // below while testing nothing, so both are named here.
  expect(panel).toContain('standupText(standup)');
  expect(pure).toContain('export function standupText');

  for (const way of WAYS_OUT) {
    expect(panel).not.toMatch(way);
    expect(pure).not.toMatch(way);
  }

  // The closure is these two files only while that stays true, so every import is checked. The panel
  // may reach the pure package, the pure module may reach its own siblings, and neither may reach
  // anything else.
  for (const line of panel.match(/^\s*import[^\n]*/gm) ?? []) expect(line).toMatch(/from '(@nolzu\/protocol|\.\/[\w.-]+)'/);
  for (const line of pure.match(/^\s*import[^\n]*/gm) ?? []) expect(line).toMatch(/from '\.\/[\w.-]+'/);
});
