import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import Help from './Help.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

function draw() {
  page = mounted(Help as never, { text: 'Commits the work, then pushes.', label: 'About the push' });
  const target = page.target;
  const button = target.querySelector<HTMLButtonElement>('button')!;
  const tip = target.querySelector<HTMLElement>('[role="tooltip"]')!;
  const fire = (on: Element, event: Event) => {
    on.dispatchEvent(event);
    flushSync();
  };
  return { target, button, tip, fire };
}

// The text is read with the button even while the tip is shut, so a screen reader never needs the hover.
it('is a named button described by its tip, which starts shut', () => {
  const ui = draw();

  expect(ui.button.textContent).toBe('?');
  expect(ui.button.getAttribute('aria-label')).toBe('About the push');
  expect(ui.button.getAttribute('aria-describedby')).toBe(ui.tip.id);
  expect(ui.tip.textContent).toBe('Commits the work, then pushes.');
  expect(ui.tip.hidden).toBe(true);
});

it('opens on hover and shuts when the pointer moves away', () => {
  const ui = draw();
  const wrap = ui.button.parentElement!;

  ui.fire(wrap, new MouseEvent('mouseenter'));
  expect(ui.tip.hidden).toBe(false);
  ui.fire(wrap, new MouseEvent('mouseleave'));
  expect(ui.tip.hidden).toBe(true);
});

it('opens on keyboard focus, shuts on Esc without the page seeing the key, and on blur', () => {
  const ui = draw();
  const page = vi.fn();
  window.addEventListener('keydown', page);

  ui.fire(ui.button, new FocusEvent('focus'));
  expect(ui.tip.hidden).toBe(false);
  ui.fire(ui.button, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(ui.tip.hidden).toBe(true);
  // Esc on the card page goes back to the board, so the press that shuts the tip must stop here.
  expect(page).not.toHaveBeenCalled();

  ui.fire(ui.button, new FocusEvent('focus'));
  ui.fire(ui.button, new FocusEvent('blur'));
  expect(ui.tip.hidden).toBe(true);
  window.removeEventListener('keydown', page);
});

// A touch screen has no hover, so a tap opens it. A second tap leaves it open, as focus does.
it('opens on a tap', () => {
  const ui = draw();

  ui.button.click();
  flushSync();
  expect(ui.tip.hidden).toBe(false);
  ui.button.click();
  flushSync();
  expect(ui.tip.hidden).toBe(false);
});

it('lets Esc through to the page when the tip is already shut', () => {
  const ui = draw();
  const page = vi.fn();
  window.addEventListener('keydown', page);

  ui.fire(ui.button, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(page).toHaveBeenCalledTimes(1);
  window.removeEventListener('keydown', page);
});
