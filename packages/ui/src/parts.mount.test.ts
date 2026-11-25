import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import Button from './Button.svelte';
import CoachNote from './CoachNote.svelte';
import ErrorBox from './ErrorBox.svelte';
import OptionButtons from './OptionButtons.svelte';
import Switch from './Switch.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

// The page owns the value, so a click only hands the new value over, and the switch shows what the
// page passes back.
it('hands the new value to the page on a click, and shows what the page passes back', () => {
  const onchange = vi.fn();
  page = mounted(Switch as never, { 'aria-label': 'Review knowledge changes', checked: false, onchange });
  const control = page.target.querySelector<HTMLButtonElement>('[role="switch"]')!;

  control.click();
  flushSync();
  expect(onchange).toHaveBeenLastCalledWith(true);
  page.set({ checked: true });
  expect(control.getAttribute('aria-checked')).toBe('true');

  control.click();
  flushSync();
  expect(onchange).toHaveBeenLastCalledWith(false);
  page.set({ checked: false });
  expect(control.getAttribute('aria-checked')).toBe('false');
});

// A save the page refuses leaves the value as it was, so the switch never shows the setting as on.
it('keeps showing the value the page passes when the page refuses the change', () => {
  const onchange = vi.fn();
  page = mounted(Switch as never, { 'aria-label': 'Keep awake', checked: false, onchange });
  const control = page.target.querySelector<HTMLButtonElement>('[role="switch"]')!;

  control.click();
  flushSync();

  expect(onchange).toHaveBeenCalledWith(true);
  expect(control.getAttribute('aria-checked')).toBe('false');
});

it('ignores a click while it is disabled', () => {
  const onchange = vi.fn();
  page = mounted(Switch as never, { 'aria-label': 'Delivery', checked: true, disabled: true, onchange });
  const control = page.target.querySelector<HTMLButtonElement>('[role="switch"]')!;

  control.click();
  flushSync();

  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(onchange).not.toHaveBeenCalled();
});

it('hands a click on the button to the caller', () => {
  const onclick = vi.fn();
  page = mounted(Button as never, { variant: 'go', onclick, children: createRawSnippet(() => ({ render: () => '<span>Re-review</span>' })) });

  page.target.querySelector('button')!.click();

  expect(onclick).toHaveBeenCalledTimes(1);
});

const output = "error: failed to push some refs to 'origin'";

it('hands the whole output to the page to copy, and says it is copied', async () => {
  const oncopy = vi.fn(async () => null);
  page = mounted(ErrorBox as never, { title: 'APP-1 was not pushed.', output, fix: 'Pull, then push again.', oncopy });

  page.target.querySelector<HTMLButtonElement>('[data-copy-output]')!.click();
  await settle();

  expect(oncopy).toHaveBeenCalledWith(output);
  expect(page.target.querySelector('[role="status"]')?.textContent).toBe('Copied.');
});

it('shows the sentence the page answers with when the copy fails', async () => {
  page = mounted(ErrorBox as never, { title: 'APP-1 was not pushed.', output, fix: 'Pull, then push again.', oncopy: async () => 'The browser refused the clipboard. Select the output and copy it.' });

  page.target.querySelector<HTMLButtonElement>('[data-copy-output]')!.click();
  await settle();

  expect(page.target.querySelector('[role="status"]')?.textContent).toBe('The browser refused the clipboard. Select the output and copy it.');
});

// Got it hides the note at once and hands its name to the page, which stores it in `seenNotes`. The
// next page passes that list back, and the note stays away.
it('hides the coach note on Got it, hands its name over once, and stays hidden with the stored list', () => {
  const ondismiss = vi.fn();
  page = mounted(CoachNote as never, { note: 'first-drag', seen: [], title: 'Dropping a card here is your approval', ondismiss });

  page.target.querySelector<HTMLButtonElement>('[data-dismiss-note]')!.click();
  flushSync();

  expect(ondismiss).toHaveBeenCalledTimes(1);
  expect(ondismiss).toHaveBeenCalledWith('first-drag');
  expect(page.target.querySelector('[role="note"]')).toBeNull();
  page.remove();

  page = mounted(CoachNote as never, { note: 'first-drag', seen: ['first-drag'], title: 'Dropping a card here is your approval', ondismiss });
  expect(page.target.querySelector('[role="note"]')).toBeNull();
});

// Got it closes the note by name. The same part handed another note draws it, before the page has
// read the stored list back.
it('draws the next note after Got it closed the one before', () => {
  page = mounted(CoachNote as never, { note: 'first-drag', seen: [], title: 'Dropping a card here is your approval', ondismiss: () => {} });

  page.target.querySelector<HTMLButtonElement>('[data-dismiss-note]')!.click();
  flushSync();
  page.set({ note: 'first-push', title: 'Pushing opens a pull request' } as never);

  expect(page.target.querySelector('[data-dismiss-note]')?.getAttribute('data-dismiss-note')).toBe('first-push');
});

// Got it closes the note it sits on and hands that note's name over, whatever the note is called.
it('closes a note of any name and hands that name over', () => {
  const ondismiss = vi.fn();
  page = mounted(CoachNote as never, { note: 'first-push', seen: [], title: 'Pushing opens a pull request', ondismiss });

  page.target.querySelector<HTMLButtonElement>('[data-dismiss-note]')!.click();
  flushSync();

  expect(ondismiss).toHaveBeenCalledWith('first-push');
  expect(page.target.querySelector('[role="note"]')).toBeNull();
});

it('hands the label of the pressed option to the page, and nothing else', () => {
  const onpick = vi.fn();
  page = mounted(OptionButtons as never, { options: [{ label: '1 to 5 stars', means: 'One migration' }, { label: 'Thumbs up and down' }], answer: '', onpick });

  page.target.querySelectorAll('button')[1]!.click();

  expect(onpick).toHaveBeenCalledTimes(1);
  expect(onpick).toHaveBeenCalledWith('Thumbs up and down');
});
