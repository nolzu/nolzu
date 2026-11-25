import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import HelpTip from './HelpTip.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
  vi.unstubAllGlobals();
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  delete (document.documentElement as { clientHeight?: number }).clientHeight;
});

// jsdom lays nothing out, so the test sets the screen the box is placed in: innerWidth with a fixed
// scrollbar in it, and the root's client size without.
function screen(width: number, height: number, scrollbar = 0): void {
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => run());
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width - scrollbar, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
}

function draw(props: Record<string, unknown> = {}) {
  page = mounted(HelpTip as never, { label: 'What Plan does', text: 'Writes the plan for the card.', ...props });
  const button = page.target.querySelector<HTMLButtonElement>('button')!;
  const box = page.target.querySelector<HTMLElement>('[popover]')!;
  // jsdom has no popover, so the test plays the browser's part: it fires the toggle events the browser
  // fires when the "?" opens or shuts the box.
  const toggle = (newState: 'open' | 'closed') => {
    box.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState }));
    box.dispatchEvent(Object.assign(new Event('toggle'), { newState }));
    flushSync();
  };
  return { button, box, toggle };
}

it('is a named button that opens a native popover, shut at first', () => {
  const ui = draw();

  expect(ui.button.textContent).toBe('?');
  expect(ui.button.getAttribute('aria-label')).toBe('What Plan does');
  expect(ui.button.getAttribute('popovertarget')).toBe(ui.box.id);
  expect(ui.button.getAttribute('aria-controls')).toBe(ui.box.id);
  expect(ui.button.getAttribute('aria-expanded')).toBe('false');
  // auto is the kind the browser shuts on Esc and on a click outside.
  expect(ui.box.getAttribute('popover')).toBe('auto');
  expect(ui.box.textContent?.trim()).toBe('Writes the plan for the card.');
  expect(document.getElementById(ui.button.getAttribute('aria-describedby')!)?.textContent).toBe('Writes the plan for the card.');
  expect(ui.box.querySelector('.example')).toBeNull();
  expect(ui.box.querySelector('a')).toBeNull();
});

it('draws the example and the docs link only when given', () => {
  const ui = draw({ example: 'A plan with three steps.', href: 'https://example.com/docs/plan' });

  expect(ui.box.querySelector('.example')?.textContent).toBe('Example: A plan with three steps.');
  const link = ui.box.querySelector('a')!;
  expect(link.textContent).toBe('More in the docs');
  expect(link.getAttribute('href')).toBe('https://example.com/docs/plan');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

it('says it is open while the box shows', () => {
  const ui = draw();

  ui.toggle('open');
  expect(ui.button.getAttribute('aria-expanded')).toBe('true');
  ui.toggle('closed');
  expect(ui.button.getAttribute('aria-expanded')).toBe('false');
});

// The "?" of the last row of a table opened under the table's edge.
it('opens upward when there is no room below the button', () => {
  screen(1200, 800);
  const ui = draw();
  ui.button.getBoundingClientRect = () => ({ top: 760, bottom: 776, left: 40 }) as DOMRect;
  ui.box.getBoundingClientRect = () => ({ width: 260, height: 120 }) as DOMRect;

  ui.toggle('open');
  expect(ui.box.dataset.up).toBe('true');
  expect(ui.box.style.top).toBe('636px');
  expect(ui.box.style.left).toBe('40px');
});

// At 390px the box ran under a fixed 15px scrollbar and lost its right edge.
it('stays left of a fixed scrollbar on a narrow screen', () => {
  screen(390, 844, 15);
  const ui = draw();
  ui.button.getBoundingClientRect = () => ({ top: 400, bottom: 416, left: 82 }) as DOMRect;
  ui.box.getBoundingClientRect = () => ({ width: 300, height: 120 }) as DOMRect;

  ui.toggle('open');
  // 375 of page, less the 300px box and the 8px edge.
  expect(ui.box.style.left).toBe('67px');
});

it('follows the "?" while the page scrolls under the open box', () => {
  screen(1200, 800);
  const ui = draw();
  let top = 100;
  ui.button.getBoundingClientRect = () => ({ top, bottom: top + 16, left: 40 }) as DOMRect;
  ui.box.getBoundingClientRect = () => ({ width: 260, height: 120 }) as DOMRect;

  ui.toggle('open');
  expect(ui.box.style.top).toBe('120px');
  top = 300;
  document.dispatchEvent(new Event('scroll'));
  expect(ui.box.style.top).toBe('320px');
});

it('keeps the Esc that shuts it from the page, and lets it through when shut', () => {
  const ui = draw();
  const seen = vi.fn();
  window.addEventListener('keydown', seen);
  try {
    ui.toggle('open');
    ui.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Focus may have left the "?" while the box shows; that Esc shuts the box too, so it is held as well.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(seen).not.toHaveBeenCalled();

    ui.toggle('closed');
    ui.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(seen).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('keydown', seen);
  }
});
