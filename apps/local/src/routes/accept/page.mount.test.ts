import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { TERMS } from '$lib/terms.ts';
import Page from './+page.svelte';

// The button waits for the box, from the keyboard as from a click.
let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown !== null) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

it('holds Accept and start until the box is ticked, and holds it again when the box is cleared', () => {
  shown = mount(Page, { target: document.body, props: { data: { terms: TERMS, changed: false, to: null }, form: null } as never });
  const box = document.querySelector<HTMLInputElement>('input[name="accept"]')!;
  const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  // The label names the box, so a screen reader says the sentence.
  expect(box.labels?.[0]?.textContent?.trim()).toBe(TERMS.checkbox);
  expect(button.disabled).toBe(true);

  box.click();
  flushSync();
  expect(button.disabled).toBe(false);

  box.click();
  flushSync();
  expect(button.disabled).toBe(true);
});
