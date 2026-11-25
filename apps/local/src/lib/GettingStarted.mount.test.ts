import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import GettingStarted from './GettingStarted.svelte';
import { type FirstRun, LOGIN_NOTE } from './getting-started.ts';

// The press is the consent: nothing reaches the login item until Turn on is
// pressed, and one press asks once. The fetch stands in for the server.
let instance: object | null = null;
let target: HTMLElement | null = null;
let answer: Response = new Response('{"ok":true}');
const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => answer.clone());

const FIRST: FirstRun = {
  steps: [
    { id: 'card', label: 'Make the first card', done: true },
    { id: 'drag', label: 'Drag it to Refine', done: false },
    { id: 'summary', label: 'Read what changed', done: false },
    { id: 'push', label: 'Push your first branch', done: false },
  ],
  coach: 'first-drag',
  loginOffer: LOGIN_NOTE,
};

beforeEach(() => {
  drawnAt('/b/delivery');
  answer = new Response('{"ok":true}');
  fetched.mockClear();
  vi.stubGlobal('fetch', fetched);
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
  vi.unstubAllGlobals();
});

const draw = (firstRun: FirstRun = FIRST) => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(GettingStarted, { target, props: { firstRun } });
  flushSync();
  return target;
};
const button = (root: HTMLElement, name: string) => [...root.querySelectorAll('button')].find((one) => one.textContent?.trim() === name);
const settle = () => new Promise((done) => setTimeout(done, 0));
const calls = (path: string) => fetched.mock.calls.filter(([url]) => url.endsWith(path));

it('draws the four steps with the count, the done one struck and the next one marked', () => {
  const root = draw();

  expect(root.querySelector('h2')?.textContent).toBe('Getting started 1/4, 1 of 4 done');
  const items = [...root.querySelectorAll('li')];
  expect(items.map((item) => item.textContent)).toEqual(['Make the first card, done', 'Drag it to Refine', 'Read what changed', 'Push your first branch']);
  expect(items[0]?.className).toContain('done');
  expect(items[1]?.getAttribute('aria-current')).toBe('step');
  expect(items.filter((item) => item.hasAttribute('aria-current'))).toHaveLength(1);
});

// A click on the list does nothing: the steps come from events on the server.
it('takes no click on a step', () => {
  const root = draw();
  root.querySelector('li')?.click();
  expect(root.querySelectorAll('li button, li a')).toHaveLength(0);
  expect(fetched).not.toHaveBeenCalled();
});

it('asks nothing of the login item until Turn on is pressed, then asks once and goes', async () => {
  const root = draw();
  await settle();
  expect(fetched).not.toHaveBeenCalled();

  button(root, 'Turn on')?.click();
  await settle();
  flushSync();

  expect(calls('/api/login-item')).toHaveLength(1);
  expect(calls('/api/login-item')[0]?.[1]?.method).toBe('POST');
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(root.textContent).not.toContain('Start Nolzu when you log in?');
});

it('answers Not now for good, and never reaches the login item', async () => {
  const root = draw();

  button(root, 'Not now')?.click();
  await settle();
  flushSync();

  expect(calls('/api/login-item')).toHaveLength(0);
  expect(calls('/api/notes')).toHaveLength(1);
  expect(JSON.parse(String(calls('/api/notes')[0]?.[1]?.body))).toEqual({ note: LOGIN_NOTE });
  expect(root.textContent).not.toContain('Start Nolzu when you log in?');
});

it('keeps the offer and says why when Turn on is refused', async () => {
  answer = new Response(JSON.stringify({ message: 'Nolzu could not write the login item. EACCES.' }), { status: 422 });
  const root = draw();

  button(root, 'Turn on')?.click();
  await settle();
  flushSync();

  expect(root.textContent).toContain('Start Nolzu when you log in?');
  expect(root.querySelector('[role="status"]')?.textContent).toBe('Nolzu could not write the login item. EACCES.');
});

it('draws no list once it is done, and no offer once it is answered', () => {
  const root = draw({ steps: null, coach: null, loginOffer: null });
  expect(root.textContent?.trim()).toBe('');
});
