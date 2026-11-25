import { ENGINE_NAMES } from '@nolzu/protocol';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import EngineTools from './EngineTools.svelte';

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

const open = (props: Record<string, unknown>): HTMLElement => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(EngineTools, { target, props: { onlook: () => {}, ...props } as never }) as Record<string, unknown>;
  flushSync();
  return target;
};

// The loading words once sat in the row grid's 18px first column, one word per line.
it('draws one skeleton row per engine while the look runs, and keeps the words for screen readers', () => {
  const panel = open({ rows: null }).querySelector('.panel')!;

  expect(panel.getAttribute('aria-busy')).toBe('true');
  // The shared Skeleton draws the rows in the same grid as the real ones.
  const rows = [...panel.querySelectorAll('[data-skeleton] .row')];
  expect(rows).toHaveLength(ENGINE_NAMES.length);
  for (const row of rows) expect(row.querySelectorAll('.bone')).toHaveLength(3);
  expect(panel.querySelector('[data-skeleton] .shapes')?.getAttribute('aria-hidden')).toBe('true');
  expect(panel.querySelector('[data-skeleton] .sr')?.textContent).toBe('Looking for each tool and its version.');
});

it('lets the failed line span the whole row', () => {
  const panel = open({ rows: null, failed: true }).querySelector('.panel')!;

  expect(panel.getAttribute('aria-busy')).toBe('false');
  expect(panel.querySelector('[data-skeleton]')).toBeNull();
  const line = panel.querySelector('.tl > .wide');
  expect(line?.textContent).toBe('The look did not finish. Press Look again.');
});
