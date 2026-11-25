import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import SettingsMenu from './SettingsMenu.svelte';
import { PROJECT_BOXES } from './settings-sections.ts';

// jsdom has no IntersectionObserver, so the test plays the browser: it keeps the menu's callback and
// says which boxes cross the top of the window.
let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
const watched: Element[] = [];
let margin: string | undefined;
vi.stubGlobal(
  'IntersectionObserver',
  class {
    constructor(callback: typeof report, options?: { rootMargin?: string }) {
      report = callback;
      margin = options?.rootMargin;
    }
    observe(element: Element) {
      watched.push(element);
    }
    disconnect() {}
  },
);

let instance: Record<string, unknown> | null = null;
afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  document.body.replaceChildren();
  watched.length = 0;
});

const marked = () => [...document.querySelectorAll('a[aria-current="location"]')].map((link) => link.textContent);

// The box in view is marked under Project; of two in view, the first on the page wins.
it('marks the box in view under Project, and moves the mark as the page scrolls', () => {
  for (const box of PROJECT_BOXES) document.body.append(Object.assign(document.createElement('section'), { id: box.id }));
  const target = document.body.appendChild(document.createElement('div'));
  instance = mount(SettingsMenu, { target, props: { current: 'project', href: (id: string) => `/settings/${id}` } }) as Record<string, unknown>;
  flushSync();

  expect(watched.map((one) => one.id)).toEqual(PROJECT_BOXES.map((box) => box.id));
  // The band is the top third of the window.
  expect(margin).toBe('0px 0px -66% 0px');
  const at = (id: string) => document.getElementById(id)!;
  report?.([
    { target: at('agent'), isIntersecting: true },
    { target: at('cards'), isIntersecting: true },
  ]);
  flushSync();
  expect(marked()).toEqual(['Cards and branches']);

  report?.([{ target: at('cards'), isIntersecting: false }]);
  flushSync();
  expect(marked()).toEqual(['Agent']);
});

// A short last box never crosses the top third, so the foot of the page marks it.
it('marks the last box at the foot of the page', () => {
  for (const box of PROJECT_BOXES) document.body.append(Object.assign(document.createElement('section'), { id: box.id }));
  const target = document.body.appendChild(document.createElement('div'));
  instance = mount(SettingsMenu, { target, props: { current: 'project', href: (id: string) => `/settings/${id}` } }) as Record<string, unknown>;
  flushSync();
  report?.([{ target: document.getElementById('walls')!, isIntersecting: true }]);
  flushSync();
  expect(marked()).toEqual(['Walls']);

  const height = vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.stubGlobal('scrollY', 2000 - innerHeight);
  dispatchEvent(new Event('scroll'));
  flushSync();
  expect(marked()).toEqual(['Tickets']);
  height.mockRestore();
  vi.stubGlobal('scrollY', 0);
});

// A box near the foot never reaches the top third, so a press on it in the menu marks it,
// and the foot of the page does not take the mark to the last box until the person scrolls on.
it('marks the box picked in the menu, also one that cannot reach the top', () => {
  for (const box of PROJECT_BOXES) document.body.append(Object.assign(document.createElement('section'), { id: box.id }));
  const target = document.body.appendChild(document.createElement('div'));
  instance = mount(SettingsMenu, { target, props: { current: 'project', href: (id: string) => `/settings/${id}` } }) as Record<string, unknown>;
  flushSync();
  const height = vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(2000);
  const link = [...target.querySelectorAll<HTMLAnchorElement>('a.sub')].find((one) => one.textContent === 'Walls')!;
  link.addEventListener('click', (event) => event.preventDefault());

  link.click();
  flushSync();
  expect(marked()).toEqual(['Walls']);
  // The glide passes Knowledge and ends at the foot with Knowledge still at the top.
  report?.([{ target: document.getElementById('knowledge')!, isIntersecting: true }]);
  vi.stubGlobal('scrollY', 2000 - innerHeight);
  dispatchEvent(new Event('scroll'));
  flushSync();
  expect(marked()).toEqual(['Walls']);

  // A scroll by hand gives the mark back to the page: at the foot, the last box.
  dispatchEvent(new Event('wheel'));
  dispatchEvent(new Event('scroll'));
  flushSync();
  expect(marked()).toEqual(['Tickets']);
  height.mockRestore();
  vi.stubGlobal('scrollY', 0);
});
