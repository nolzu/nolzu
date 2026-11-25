import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import { CHORD_MS, type KeyActions, scoped } from './keymap.ts';
import Keyboard from './Keyboard.svelte';

// jsdom has the dialog element but none of its modal half, so the help gets the two calls it uses.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

let page: Mounted<Record<string, unknown>> | null = null;
let field: HTMLInputElement | null = null;
afterEach(() => {
  page?.remove();
  page = null;
  field?.remove();
  field = null;
});

// A key as the browser sends it: from whatever has focus, up to the window. Answers whether the
// handler took it from the browser.
function key(name: string, over: KeyboardEventInit = {}, from: Element = document.activeElement ?? document.body): boolean {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...over });
  from.dispatchEvent(event);
  flushSync();
  return event.defaultPrevented;
}

const BOARD = [...scoped('global'), ...scoped('board')];

function draw(actions: KeyActions) {
  page = mounted(Keyboard as never, { keys: BOARD, actions });
  return page;
}

const help = () => document.querySelector<HTMLDialogElement>('dialog[data-key-help]');

describe('the one key handler', () => {
  it('runs the action of a key and takes the key from the browser', () => {
    const add = vi.fn();
    draw({ add });

    expect(key('n')).toBe(true);
    expect(add).toHaveBeenCalledOnce();
  });

  // Enter with no card selected, or an arrow with no card to go to, keeps its own job.
  it('leaves the key to the browser when the action did nothing', () => {
    const open = vi.fn(() => false);
    draw({ open });

    expect(key('Enter')).toBe(false);
    expect(open).toHaveBeenCalledOnce();
  });

  it('does nothing for a key whose action the screen has not got', () => {
    draw({ add: vi.fn() });

    expect(key('r')).toBe(false);
    expect(key('p')).toBe(false);
  });

  it('gives a key typed into a field to the field', () => {
    const add = vi.fn();
    draw({ add });
    field = document.body.appendChild(document.createElement('input'));
    field.focus();

    expect(key('n')).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('acts on G then a letter', () => {
    const go = vi.fn();
    draw({ 'go:knowledge': go, previous: vi.fn() });

    expect(key('g')).toBe(false);
    expect(key('k')).toBe(true);
    expect(go).toHaveBeenCalledOnce();
  });

  // The clock is the key event's own, so the app forgets G too, and not only the matcher.
  it('forgets G when its letter comes after the timeout', () => {
    const go = vi.fn();
    const previous = vi.fn();
    draw({ 'go:knowledge': go, previous });
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    key('g');
    now.mockReturnValue(10_000 + CHORD_MS + 1);
    key('k');
    now.mockRestore();

    expect(go).not.toHaveBeenCalled();
    expect(previous).toHaveBeenCalledOnce();
  });
});

describe('the help', () => {
  it('opens on ? and lists exactly the keys the screen binds, with help itself', () => {
    draw({ add: vi.fn(), theme: vi.fn(), open: vi.fn(), 'go:delivery': vi.fn() });

    expect(key('?', { shiftKey: true })).toBe(true);
    const rows = [...help()!.querySelectorAll('[data-help-key]')].map((row) => row.getAttribute('data-help-key'));
    // The board's help also lists the card page tabs.
    const tabs = ['tab:changes', 'tab:discussion', 'tab:files', 'tab:log', 'tab:overview', 'tab:prs', 'tab:settings'];
    expect(rows.sort()).toEqual(['add', 'go:delivery', 'help', 'open', ...tabs, 'theme']);
    expect(help()!.textContent).toContain('Numbers count the tabs shown. Epics and Research cards have no Changes tab.');
  });

  it('lists no card page tabs on a screen with no board key', () => {
    draw({ theme: vi.fn() });
    key('?', { shiftKey: true });

    expect([...help()!.querySelectorAll('[data-help-key]')].map((row) => row.getAttribute('data-help-key')).sort()).toEqual(['help', 'theme']);
  });

  it('labels each row and says its keys in words', () => {
    draw({ next: vi.fn() });
    key('?');
    const row = help()!.querySelector('[data-help-key="next"]')!;

    expect(row.querySelector('dt')?.textContent).toBe('Next card');
    expect([...row.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual(['J', '↓']);
    expect(row.querySelector('.hidden')?.textContent).toBe('J or Down arrow');
  });

  it('draws the Starts foot only while a key that starts a run is live', () => {
    draw({ add: vi.fn() });
    key('?');
    expect(help()!.textContent).not.toContain('Starts an agent run');
    page!.remove();

    draw({ retry: vi.fn() });
    key('?');
    expect(help()!.textContent).toContain('Starts an agent run. The key first shows what starts, like a drop.');
    expect(help()!.querySelector('[data-help-key="retry"] .bolt')).not.toBeNull();
  });

  it('holds the board keys while it is open, and opens again after a close', () => {
    const add = vi.fn();
    draw({ add });
    key('?');

    expect(key('n')).toBe(false);
    expect(add).not.toHaveBeenCalled();

    help()!.querySelector<HTMLButtonElement>('[data-closer]')!.click();
    flushSync();
    expect(help()).toBeNull();
    key('n');
    expect(add).toHaveBeenCalledOnce();
    key('?');
    expect(help()).not.toBeNull();
  });
});

// The line beside the title points at the palette, so it shows only where Cmd K opens one.
it('names the command palette beside the title only where Cmd K opens it', () => {
  draw({ add: vi.fn(), palette: vi.fn() });
  key('?');
  expect(help()!.querySelector('.sub')?.textContent).toBe('Screens, actions and card moves are also in the command palette, ⌘K');
  expect(help()!.querySelector('[data-help-key="palette"] dt')?.textContent).toBe('Search or run a command');
  page!.remove();

  draw({ add: vi.fn() });
  key('?');
  expect(help()!.querySelector('.sub')).toBeNull();
});
