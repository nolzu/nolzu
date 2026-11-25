import { afterEach, expect, it } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import Skeleton from './Skeleton.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const draw = (props: Record<string, unknown>) => {
  page = mounted(Skeleton as never, { label: 'Reading the changes with git.', ...props });
  return page.target.querySelector<HTMLElement>('[data-skeleton]')!;
};

it('hides the shapes from screen readers and reads the words instead', () => {
  const skeleton = draw({});

  expect(skeleton.querySelector('.shapes')?.getAttribute('aria-hidden')).toBe('true');
  expect(skeleton.querySelector('.sr')?.textContent).toBe('Reading the changes with git.');
});

it('draws a block of the given height by default', () => {
  const skeleton = draw({ height: '240px' });

  expect(skeleton.dataset.shape).toBe('block');
  expect(skeleton.querySelector<HTMLElement>('.bone.box')?.style.height).toBe('240px');
});

it('draws a line of the given width', () => {
  expect(draw({ shape: 'line', width: '50%' }).querySelector<HTMLElement>('.bone')?.style.width).toBe('50%');
});

it('draws rows of a dot, a name and a meta line', () => {
  const rows = [...draw({ shape: 'rows', count: 4 }).querySelectorAll('.row')];

  expect(rows).toHaveLength(4);
  for (const row of rows) expect([...row.children].map((bone) => bone.className.replace(/\s*svelte-\w+/g, ''))).toEqual(['bone dot', 'bone name', 'bone meta']);
});

it('draws a list of a name over a meta line, and the lines of a paragraph with a short last one', () => {
  const items = [...draw({ shape: 'list', count: 3 }).querySelectorAll('.item')];
  expect(items).toHaveLength(3);
  for (const item of items) expect(item.querySelectorAll('.bone')).toHaveLength(2);
  page?.remove();
  const lines = [...draw({ shape: 'text', count: 4 }).querySelectorAll('.bone.line')];
  expect(lines.map((line) => line.classList.contains('short'))).toEqual([false, false, false, true]);
});

it('draws a card of a title and two short lines, and an inline pill', () => {
  expect(draw({ shape: 'card' }).querySelectorAll('.card .bone')).toHaveLength(3);
  page?.remove();
  expect(draw({ shape: 'pill' }).querySelectorAll('.bone.pill')).toHaveLength(1);
});
