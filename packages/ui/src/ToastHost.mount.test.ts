import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import ToastHost from './ToastHost.svelte';
import { pushToast, type ToastItem } from './toasts.ts';

let host: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

const toast = (key: string, more: Partial<ToastItem> = {}): ToastItem => ({ kind: 'success', card: { key, href: `/t/${key}` }, message: 'added to Inbox.', ...more });
const stackOf = (...toasts: ToastItem[]) => toasts.reduce<ToastItem[]>((all, one) => pushToast(all, one), []);
const shown = () => [...host!.target.querySelectorAll<HTMLElement>('.toast')];

// Handed four straight, not through pushToast, so the host holds the limit on its own.
it('keeps three toasts and drops the oldest', () => {
  const three = [toast('APP-1'), toast('APP-2'), toast('APP-3')];
  host = mounted(ToastHost as never, { toasts: three, ondismiss: () => {} });
  expect(shown()).toHaveLength(3);

  host.set({ toasts: [...three, toast('APP-4')] });

  expect(shown().map((one) => one.querySelector('.message .key')?.textContent)).toEqual(['APP-2', 'APP-3', 'APP-4']);
});

// Open is the one link, so a keyboard reaches each card once per toast.
it('names its card first, and has Open as the one link to it', () => {
  host = mounted(ToastHost as never, { toasts: [toast('APP-4')], ondismiss: () => {} });
  const [one] = shown();

  expect(one!.querySelector('.message')?.textContent).toBe('APP-4: added to Inbox.');
  expect(one!.querySelector('.message .key')?.textContent).toBe('APP-4');
  expect(one!.querySelector('.run')).toBeNull();
  const links = [...one!.querySelectorAll('a')];
  expect(links.map((link) => link.textContent)).toEqual(['Open']);
  const open = links[0];
  expect(open?.getAttribute('href')).toBe('/t/APP-4');
  expect(open?.getAttribute('aria-label')).toBe('Open APP-4');
});

it('shows the mono line only for a toast with run data, and only what the run reported', () => {
  host = mounted(ToastHost as never, {
    toasts: [
      toast('APP-1', { kind: 'error', message: 'QA failed: empty list, not the message.', run: { model: 'sonnet', durationMs: 62_000, costUsd: 0.08 } }),
      toast('APP-2', { run: { model: 'haiku', durationMs: null, costUsd: 0.01 } }),
      toast('APP-3', { run: { model: null, durationMs: null, costUsd: null } }),
    ],
    ondismiss: () => {},
  });

  expect(shown().map((one) => one.querySelector('.run')?.textContent ?? null)).toEqual(['sonnet · 1m 02s · $0.08', 'haiku · $0.01', null]);
});

// The corner is there before any toast, so a screen reader is listening when the first one comes.
it('keeps the status region on the page while the stack is empty', () => {
  host = mounted(ToastHost as never, { toasts: [], ondismiss: () => {} });

  expect(host.target.querySelector('.toasts')?.getAttribute('role')).toBe('status');
  expect(shown()).toEqual([]);
});

it('reads an error out as an alert and the other kinds through the status corner, with the fix under the line', () => {
  host = mounted(ToastHost as never, {
    toasts: stackOf(toast('APP-1', { kind: 'error', message: 'sonnet is gone, so Plan cannot start a run.', fix: 'Pick another model in the card settings, or in Settings, Models.' }), toast('APP-2', { kind: 'warning' })),
    ondismiss: () => {},
  });
  const [error, warning] = shown();

  expect(error!.getAttribute('role')).toBe('alert');
  expect(error!.querySelector('.fix')?.textContent).toBe('Pick another model in the card settings, or in Settings, Models.');
  // No region of its own: a status nested in the corner would be a second region added with its text.
  expect(warning!.getAttribute('role')).toBeNull();
  expect(warning!.closest('[role="status"]')).toBe(host.target.querySelector('.toasts'));
  expect(warning!.querySelector('.fix')).toBeNull();
});

it('hands the dismissed card to the page and gives focus back to where the reader was', () => {
  const trigger = document.body.appendChild(document.createElement('button'));
  trigger.focus();
  const ondismiss = vi.fn();
  host = mounted(ToastHost as never, { toasts: [toast('APP-4')], ondismiss });

  const dismiss = host.target.querySelector<HTMLButtonElement>('button[aria-label="Dismiss APP-4"]')!;
  dismiss.focus();
  dismiss.click();
  flushSync();

  expect(ondismiss).toHaveBeenCalledWith('APP-4');
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});


// A refused drop says which card did not move and to which column, why, and links the setting that
// fixes it. The why and the fix share the one line under the headline, the model is mono, and
// the ban sign says nothing ran. The fix link takes the place of Open.
it('heads a refused drop with the card and the column, and links the setting to fix', () => {
  host = mounted(ToastHost as never, {
    toasts: [
      toast('APP-18', {
        kind: 'error',
        refused: true,
        headline: 'did not move to Plan',
        message: 'Plan uses sonnet-4-5, which Claude Code no longer offers.',
        code: 'sonnet-4-5',
        fix: 'Pick another in Settings, Models.',
        link: { label: 'Open Settings, Models', href: '/settings/models' },
      }),
    ],
    ondismiss: () => {},
  });
  const [one] = shown();

  expect(one!.querySelector('.message')?.textContent).toBe('APP-18 did not move to Plan');
  expect(one!.querySelector('.said')?.textContent).toBe('Plan uses sonnet-4-5, which Claude Code no longer offers. Pick another in Settings, Models.');
  expect(one!.querySelector('.said code')?.textContent).toBe('sonnet-4-5');
  expect(one!.querySelectorAll('.text > p:not(.go)')).toHaveLength(2);
  expect(one!.querySelector('.fix')).toBeNull();
  // The ban sign, a circle crossed once, and not the x of a run that failed.
  expect(one!.querySelector('.icon circle')).not.toBeNull();
  expect(one!.querySelector('.icon path')?.getAttribute('d')).toBe('M6 6l12 12');
  const link = one!.querySelector('[data-toast-link]');
  expect(link?.textContent).toBe('Open Settings, Models');
  expect(link?.getAttribute('href')).toBe('/settings/models');
  expect([...one!.querySelectorAll('a')].map((found) => found.textContent)).toEqual(['Open Settings, Models']);
});

// A run that failed keeps the x: the ban sign is only for a move nothing ran on.
it('draws the x for an error that is not a refusal', () => {
  host = mounted(ToastHost as never, { toasts: [toast('APP-9', { kind: 'error', message: 'QA failed: empty list, not the message.' })], ondismiss: () => {} });
  const [one] = shown();

  expect(one!.querySelector('.icon circle')).toBeNull();
  expect(one!.querySelector('.icon path')?.getAttribute('d')).toBe('M6 6l12 12M18 6 6 18');
});

// Scout's toast and the near-limit warning are about no card: the first line is the title,
// with no key in mono, and the mono line under it is given as it is.
it('draws a toast about no card by its title, with the line it was given', () => {
  host = mounted(ToastHost as never, {
    toasts: [{ kind: 'info', card: { key: 'Scout', href: '/scout' }, title: 'Scout: 2 new findings', message: '', note: 'The recipe app' }],
    ondismiss: () => {},
  });
  const [one] = shown();

  expect(one!.querySelector('.message')?.textContent).toBe('Scout: 2 new findings');
  expect(one!.querySelector('.message .key')).toBeNull();
  expect(one!.querySelector('.run')?.textContent).toBe('The recipe app');
  expect(one!.querySelector('.said')).toBeNull();
  expect(one!.querySelector('a.open')?.getAttribute('href')).toBe('/scout');
  expect(one!.querySelector('a.open')?.getAttribute('aria-label')).toBe('Open Scout');
});

// A save on the page the person is on has no href: Open would only reload that page.
it('draws no Open for a card with no href', () => {
  host = mounted(ToastHost as never, { toasts: [{ kind: 'success', card: { key: 'Settings' }, title: 'Saved.', message: '' }], ondismiss: () => {} });
  const [one] = shown();

  expect(one!.querySelector('.message')?.textContent).toBe('Saved.');
  expect(one!.querySelectorAll('a')).toHaveLength(0);
  expect(one!.querySelector('button')?.getAttribute('aria-label')).toBe('Dismiss Settings');
});

// A run that ended ready says it in the headline, and the run's own line is all that goes under it.
it('draws a headline with nothing under it but the run line when there is no reason to give', () => {
  host = mounted(ToastHost as never, { toasts: [toast('APP-11', { headline: 'QA passed', message: '', run: { model: 'sonnet', durationMs: 48_000, costUsd: 0.07 } })], ondismiss: () => {} });
  const [one] = shown();

  expect(one!.querySelector('.message')?.textContent).toBe('APP-11 QA passed');
  expect(one!.querySelector('.said')).toBeNull();
  expect(one!.querySelector('.run')?.textContent).toBe('sonnet · 48s · $0.07');
});

// Every toast closes by itself. The bar's animation is the countdown, so jsdom, which runs no
// animation, fires its end by hand. The pause and the reduced motion rule are CSS, read from the source.
const source = readFileSync(join(import.meta.dirname, 'ToastHost.svelte'), 'utf8');
const bar = (one: HTMLElement) => one.querySelector<HTMLElement>('.life')!;

it('closes a toast when its bar runs out, without moving the focus', () => {
  const ondismiss = vi.fn();
  const elsewhere = document.body.appendChild(document.createElement('button'));
  host = mounted(ToastHost as never, { toasts: [toast('APP-1')], ondismiss });
  elsewhere.focus();

  bar(shown()[0]!).dispatchEvent(new Event('animationend', { bubbles: true }));

  expect(ondismiss).toHaveBeenCalledWith('APP-1');
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
});

it('gives a plain toast 6 seconds, and an error or a toast with a link 10', () => {
  host = mounted(ToastHost as never, {
    toasts: [toast('APP-1'), toast('APP-2', { kind: 'error' }), toast('APP-3', { kind: 'warning', link: { label: 'Open Settings, Models', href: '/settings/models' } })],
    ondismiss: () => {},
  });

  expect(shown().map((one) => one.style.getPropertyValue('--life'))).toEqual(['6000ms', '10000ms', '10000ms']);
  expect(bar(shown()[0]!).getAttribute('aria-hidden')).toBe('true');
});

it('starts the countdown over for a new toast about the same card', () => {
  const first = toast('APP-1');
  host = mounted(ToastHost as never, { toasts: [first], ondismiss: () => {} });
  const before = bar(shown()[0]!);

  host.set({ toasts: pushToast([first], toast('APP-1', { message: 'moved to Plan.' })) });

  expect(bar(shown()[0]!)).not.toBe(before);
});

it('pauses on hover and on focus inside, and keeps the countdown with reduced motion', () => {
  expect(source).toMatch(/\.toast:hover \.life,\s+\.toast:focus-within \.life \{\s+animation-play-state: paused;/);
  expect(source).toMatch(/animation: life var\(--life\) linear forwards;/);
  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.life \{\s+visibility: hidden;\s+animation-duration: var\(--life\) !important;/);
  expect(source).toMatch(/transform-origin: left;/);
});
