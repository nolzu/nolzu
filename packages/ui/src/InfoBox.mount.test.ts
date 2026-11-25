import { createRawSnippet } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import InfoBox from './InfoBox.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

it('draws an info box as a note with its lines', () => {
  page = mounted(InfoBox as never, { children: createRawSnippet(() => ({ render: () => '<p>Add puts a repository in this project.</p>' })) });
  const box = page.target.querySelector('[data-info-box]')!;

  expect(box.getAttribute('role')).toBe('note');
  expect(box.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(box.textContent?.trim()).toBe('Add puts a repository in this project.');
});
