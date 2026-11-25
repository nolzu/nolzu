import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BranchFact from './BranchFact.svelte';

let instance: object | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

const draw = (locked: string | null, onsave: (name: string) => Promise<string | null>) => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(BranchFact, { target, props: { value: 'APP-1-add-a-search-box', locked, onsave } });
  flushSync();
  return target;
};
const settle = () => new Promise((done) => setTimeout(done, 0));
const type = (root: HTMLElement, text: string) => {
  const box = root.querySelector('input')!;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

it('turns the name into a box on the pencil, and saves the typed name', async () => {
  const onsave = vi.fn(async () => null);
  const root = draw(null, onsave);

  root.querySelector<HTMLButtonElement>('[data-branch-edit]')!.click();
  flushSync();
  expect(root.querySelector('input')?.value).toBe('APP-1-add-a-search-box');
  type(root, ' APP-1-search ');
  root.querySelector<HTMLButtonElement>('[data-branch-save]')!.click();
  await settle();
  flushSync();

  expect(onsave).toHaveBeenCalledWith('APP-1-search');
  expect(root.querySelector('input')).toBeNull();
});

it('keeps the box open with the refusal, and Cancel puts the name back', async () => {
  const root = draw(null, async () => 'The name must carry the card key APP-1.');

  root.querySelector<HTMLButtonElement>('[data-branch-edit]')!.click();
  flushSync();
  type(root, 'search');
  root.querySelector<HTMLButtonElement>('[data-branch-save]')!.click();
  await settle();
  flushSync();
  expect(root.querySelector('[role="alert"]')?.textContent).toBe('The name must carry the card key APP-1.');

  root.querySelector<HTMLButtonElement>('[data-branch-cancel]')!.click();
  flushSync();
  expect(root.querySelector('input')).toBeNull();
  expect(root.textContent).toContain('APP-1-add-a-search-box');

  root.querySelector<HTMLButtonElement>('[data-branch-edit]')!.click();
  flushSync();
  root.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(root.querySelector('input')).toBeNull();
});

it('draws a pushed branch as plain text, with why in its title', () => {
  const root = draw('APP-1-add-a-search-box has an upstream, so it keeps its name.', async () => null);

  expect(root.querySelector('[data-branch-edit]')).toBeNull();
  expect(root.querySelector('.value')?.getAttribute('title')).toBe('APP-1-add-a-search-box has an upstream, so it keeps its name.');
});
