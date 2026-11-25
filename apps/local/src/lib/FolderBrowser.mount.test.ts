import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import FolderBrowser from './FolderBrowser.svelte';

// Browse asks the server for the folders, so grey rows hold the list's place until it answers, and a
// refusal replaces them with its sentence.

let instance: object | null = null;
let target: HTMLElement | null = null;
afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  vi.unstubAllGlobals();
});

function open(answer: Promise<Response>): HTMLElement {
  drawnAt('/new');
  vi.stubGlobal('fetch', () => answer);
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(FolderBrowser, { target, props: { open: true, onuse: () => {} } });
  flushSync();
  return target;
}

it('draws grey rows while the folders are on their way, with the words for a screen reader', () => {
  const page = open(new Promise(() => {}));

  expect(page.querySelector('[data-skeleton]')?.getAttribute('data-shape')).toBe('rows');
  expect(page.querySelector('[data-skeleton] .sr')?.textContent).toBe('Reading the folders.');
});

it('drops the grey rows for the sentence when the server refuses', async () => {
  const page = open(Promise.resolve(new Response(JSON.stringify({ problem: 'That folder is not there.' }))));
  await vi.waitFor(() => expect(page.querySelector('[role="alert"]')?.textContent).toBe('That folder is not there.'));
  flushSync();

  expect(page.querySelector('[data-skeleton]')).toBeNull();
});
