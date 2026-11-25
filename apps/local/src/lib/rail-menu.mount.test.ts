import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import { FREE } from './display.ts';
import Rail from './Rail.svelte';

// The project menu opens and closes on a click, a key and focus, which a server render cannot show.
let instance: { openMenu: () => Promise<void> } | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

const open = () => {
  drawnAt('/knowledge');
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(Rail, {
    target,
    props: { routeId: '/knowledge', project: { name: 'recipes', path: '~/nolzu/recipes', repos: ['api', 'web'], listed: true }, display: FREE, ontheme: () => {} },
  }) as unknown as { openMenu: () => Promise<void> };
  flushSync();
  const root = target;
  return {
    root,
    button: root.querySelector<HTMLButtonElement>('button.proj')!,
    menu: root.querySelector<HTMLElement>('#project-menu')!,
  };
};

it('opens on a click and closes on a second one', () => {
  const { button, menu } = open();
  expect(menu.hidden).toBe(true);

  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(menu.hidden).toBe(false);

  button.click();
  flushSync();
  expect(menu.hidden).toBe(true);
});

it('closes on Esc and gives the focus back to its button', () => {
  const { button, menu } = open();
  button.click();
  flushSync();
  menu.querySelector<HTMLElement>('a')!.focus();

  menu.querySelector('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect(menu.hidden).toBe(true);
  expect(document.activeElement).toBe(button);
});

// A click on its text puts the focus on the panel, and Esc still closes it.
it('closes on Esc from the panel', () => {
  const { button, menu } = open();
  button.click();
  flushSync();
  menu.focus();

  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect(menu.hidden).toBe(true);
  expect(document.activeElement).toBe(button);
});

// Safari and Firefox on a Mac do not focus a clicked button. The click does, so Esc reaches the menu.
it('takes the focus on a click, so Esc closes a menu a click opened', () => {
  const { button, menu } = open();

  button.click();
  flushSync();
  expect(document.activeElement).toBe(button);

  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(menu.hidden).toBe(true);
});

// There a click on the button sends the focus nowhere first. The menu must not close on that and open
// again on the click.
it('closes from its own button after the focus went nowhere', async () => {
  const { button, menu } = open();
  await instance!.openMenu();
  flushSync();

  menu.querySelector('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  flushSync();
  expect(menu.hidden).toBe(false);

  button.click();
  flushSync();
  expect(menu.hidden).toBe(true);
});

// G then P opens it from the keyboard, so focus goes into it.
it('opens from the key with the focus on its first link', async () => {
  const { menu } = open();

  await instance!.openMenu();
  flushSync();
  await tick();

  expect(menu.hidden).toBe(false);
  expect(document.activeElement).toBe(menu.querySelector('a'));
  expect(menu.querySelector('a')?.textContent).toContain('Repositories');
});

it('closes on a press outside it, and stays open on a press inside', () => {
  const { button, menu } = open();
  button.click();
  flushSync();

  menu.querySelector('.gh')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  flushSync();
  expect(menu.hidden).toBe(false);

  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  flushSync();
  expect(menu.hidden).toBe(true);
});

// Tab past the last link leaves the menu, and the menu does not stay open over the page.
it('closes when the focus leaves it', () => {
  const { root, button, menu } = open();
  button.click();
  flushSync();
  const settings = root.querySelector<HTMLElement>('nav[aria-label="Settings"] a')!;

  menu.querySelector('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: menu.querySelectorAll('a')[1] ?? null }));
  flushSync();
  expect(menu.hidden).toBe(false);

  menu.querySelector('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: settings }));
  flushSync();
  expect(menu.hidden).toBe(true);
});

// Each one, because two of them only change the fragment on /settings/project, and the page stays under the menu.
it.each(['./settings/project#git-title', './settings/project#add-url', './settings/project'])('closes when its link to %s is followed', (href) => {
  const { button, menu } = open();
  button.click();
  flushSync();
  const link = menu.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
  // jsdom does not navigate, and the page must not either.
  link.addEventListener('click', (event) => event.preventDefault());

  link.click();
  flushSync();

  expect(menu.hidden).toBe(true);
});
