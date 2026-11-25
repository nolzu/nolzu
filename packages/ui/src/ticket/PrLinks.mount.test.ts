import { flushSync } from 'svelte';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import PrLinks from './PrLinks.svelte';

// jsdom has no modal half of the dialog: showModal only opens, and close fires the close event.
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
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  for (let at = 0; at < 8; at += 1) await Promise.resolve();
  flushSync();
};

const PULL = { repo: 'cook/api', number: 7, url: null, title: 'Return the cooking time', state: 'merged', foundBy: 'attached' };

function draw(onattach: (link: string) => Promise<string | null>, ondetach: (link: string) => Promise<string | null> = async () => null, pull: Record<string, unknown> = PULL) {
  page = mounted(PrLinks as never, { pulls: [pull], onattach, ondetach });
  const target = page.target;
  const input = target.querySelector<HTMLInputElement>('input')!;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    flushSync();
  };
  const submit = () => target.querySelector<HTMLFormElement>('form')!.requestSubmit();
  return { target, input, type, submit };
}

it('sends the typed link, shows the refusal and keeps the text to fix', async () => {
  const onattach = vi.fn(async () => 'Type the owner as well, as in owner/recipes#41.');
  const ui = draw(onattach);

  ui.type(' recipes#41 ');
  ui.submit();
  await settle();

  expect(onattach).toHaveBeenCalledWith('recipes#41');
  expect(ui.target.textContent).toContain('Type the owner as well, as in owner/recipes#41.');
  expect(ui.target.querySelector('[role="status"]')!.classList.contains('failed')).toBe(true);
  expect(ui.input.value).toBe(' recipes#41 ');
});

// The list shows the lower case name, so the line that says it worked does too, not the pasted link.
it('says it attached the pull request by the name the list shows', async () => {
  const ui = draw(async () => null);

  ui.type('https://github.com/Cook/Recipes/pull/41/files');
  ui.submit();
  await settle();

  const status = ui.target.querySelector('[role="status"]')!;
  expect(status.textContent).toBe('Attached cook/recipes#41.');
  expect(status.classList.contains('failed')).toBe(false);
});

it('clears the field once the pull request is attached, and sends nothing for an empty one', async () => {
  const onattach = vi.fn(async () => null);
  const ui = draw(onattach);

  ui.submit();
  await settle();
  expect(onattach).not.toHaveBeenCalled();

  ui.type('cook/recipes#41');
  ui.submit();
  await settle();
  expect(onattach).toHaveBeenCalledWith('cook/recipes#41');
  expect(ui.input.value).toBe('');
});

// Detach asks first, because it takes the discussions and messages on the card with it.
const pressDetach = (target: HTMLElement) => {
  const button = target.querySelector<HTMLButtonElement>('[data-detach]')!;
  button.focus();
  button.click();
  flushSync();
  return button;
};

it('asks first, naming the pull request and how many discussions go with it', () => {
  const ondetach = vi.fn(async () => null);
  const ui = draw(async () => null, ondetach, { ...PULL, discussions: 3 });

  pressDetach(ui.target);

  const dialog = ui.target.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('role')).toBe('alertdialog');
  expect(dialog.textContent).toContain('Detach cook/api#7?');
  expect(dialog.textContent).toContain('The card loses cook/api#7 and its 3 discussions with their messages.');
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(ondetach).not.toHaveBeenCalled();
});

it('names no discussions when the pull request has none', () => {
  const ui = draw(async () => null);

  pressDetach(ui.target);

  const text = ui.target.querySelector('dialog')!.textContent!;
  expect(text).toContain('The card loses cook/api#7.');
  expect(text).not.toContain('discussion');
});

it('changes nothing on Cancel or Esc and gives focus back to Detach', () => {
  const ondetach = vi.fn(async () => null);
  const ui = draw(async () => null, ondetach, { ...PULL, discussions: 1 });

  const button = pressDetach(ui.target);
  ui.target.querySelector<HTMLButtonElement>('[data-detach-cancel]')!.click();
  flushSync();
  expect(ui.target.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);

  pressDetach(ui.target);
  const dialog = ui.target.querySelector('dialog')!;
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (!cancel.defaultPrevented) dialog.close();
  flushSync();
  expect(ui.target.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(ondetach).not.toHaveBeenCalled();
});

it('detaches once confirmed, closes and moves focus to the link field when the row is gone', async () => {
  const ondetach = vi.fn(async () => {
    page!.set({ pulls: [] });
    return null;
  });
  const ui = draw(async () => null, ondetach);

  pressDetach(ui.target);
  ui.target.querySelector<HTMLButtonElement>('[data-detach-confirm]')!.click();
  await settle();

  expect(ondetach).toHaveBeenCalledWith('cook/api#7');
  expect(ui.target.querySelector('dialog')).toBeNull();
  expect(ui.target.querySelector('[role="status"]')!.textContent).toBe('Detached cook/api#7.');
  expect(document.activeElement).toBe(ui.target.querySelector('input'));
});

it('holds Esc and a second press while the detach runs', async () => {
  let answer: (refused: string | null) => void = () => {};
  const ondetach = vi.fn(() => new Promise<string | null>((done) => (answer = done)));
  const ui = draw(async () => null, ondetach);

  pressDetach(ui.target);
  const form = ui.target.querySelector<HTMLFormElement>('dialog form')!;
  const submit = new Event('submit', { cancelable: true });
  form.dispatchEvent(submit);
  expect(submit.defaultPrevented).toBe(true);
  flushSync();
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  const cancel = new Event('cancel', { cancelable: true });
  ui.target.querySelector('dialog')!.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(ondetach).toHaveBeenCalledTimes(1);

  answer(null);
  await settle();
  expect(ui.target.querySelector('dialog')).toBeNull();
});

it('detaches by owner/repo#N and shows a refusal, with focus back on Detach', async () => {
  const ondetach = vi.fn(async () => 'cook/api#7 is not on APP-1.');
  const ui = draw(async () => null, ondetach);

  const button = pressDetach(ui.target);
  ui.target.querySelector<HTMLButtonElement>('[data-detach-confirm]')!.click();
  await settle();

  expect(ondetach).toHaveBeenCalledWith('cook/api#7');
  expect(ui.target.textContent).toContain('cook/api#7 is not on APP-1.');
  expect(ui.target.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
});
