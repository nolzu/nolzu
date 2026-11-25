import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import AnswerComposer from './AnswerComposer.svelte';

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

function draw(onanswer: (text: string) => Promise<string | null>, sessionId: string | null = '22222222-aaaa-4bbb-8ccc-000000000002') {
  page = mounted(AnswerComposer as never, { question: 'Titles only?', sessionId, onanswer });
  const target = page.target;
  const field = target.querySelector('textarea')!;
  const button = target.querySelector<HTMLButtonElement>('[data-send-answer]')!;
  const type = (value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    flushSync();
  };
  return { target, button, type };
}

it.each(['', '   ', '\n\t'])('keeps Send held while the answer is %j', (value) => {
  const onanswer = vi.fn(async () => null);
  const ui = draw(onanswer);
  ui.type(value);

  expect(ui.button.getAttribute('aria-disabled')).toBe('true');
  ui.button.click();
  expect(onanswer).not.toHaveBeenCalled();
});

it('sends the answer once, and stays busy after the send until the board queues the run', async () => {
  const onanswer = vi.fn(async () => null);
  const ui = draw(onanswer);
  ui.type('Titles only.');

  ui.button.click();
  ui.button.click();
  await settle();

  expect(onanswer).toHaveBeenCalledTimes(1);
  expect(onanswer).toHaveBeenCalledWith('Titles only.');
  // The request answered, but the page drops the composer only when the card stops being blocked.
  expect(ui.button.getAttribute('aria-busy')).toBe('true');
  expect(ui.target.textContent).toContain('Waiting for the board');
});

it('shows the sentence the answer was refused with, and lets the person send again', async () => {
  const ui = draw(async () => 'APP-1 is ready and not blocked, so no question is waiting for an answer.');
  ui.type('Titles only.');

  ui.button.click();
  await settle();

  expect(ui.target.textContent).toContain('is ready and not blocked');
  expect(ui.button.getAttribute('aria-busy')).not.toBe('true');
  expect(ui.button.getAttribute('aria-disabled')).not.toBe('true');
});

// The answer resumes the session as a new run, so Send answer is the amber go button. With no
// session the send only fails the card, so nothing starts and the button is primary.
it('draws Send answer as go when it resumes a session, and as primary when there is none', () => {
  const resumes = draw(async () => null).button;
  expect(resumes.classList.contains('go')).toBe(true);
  expect(resumes.querySelector('svg[data-glyph="resume"]')).not.toBeNull();
  page?.remove();

  const startsNothing = draw(async () => null, null).button;
  expect(startsNothing.classList.contains('go')).toBe(false);
  expect(startsNothing.classList.contains('primary')).toBe(true);
  expect(startsNothing.querySelector('svg')).toBeNull();
});

// The options fill the answer and send nothing: Send stays the one button that resumes the run.
it('fills the answer from a pressed option and sends nothing until Send', async () => {
  const onanswer = vi.fn(async () => null);
  page = mounted(AnswerComposer as never, {
    question: 'Stars or thumbs?',
    sessionId: '22222222-aaaa-4bbb-8ccc-000000000002',
    onanswer,
    options: [{ label: '1 to 5 stars', means: 'New column in recipes, one migration' }, { label: 'Thumbs up and down', means: null }],
  });
  const field = page.target.querySelector('textarea')!;
  const option = page.target.querySelector<HTMLButtonElement>('[role="group"] button')!;

  option.click();
  flushSync();

  expect(field.value).toBe('1 to 5 stars');
  expect(option.getAttribute('aria-pressed')).toBe('true');
  expect(page.target.querySelector('[data-send-answer]')!.getAttribute('aria-disabled')).toBeNull();
  expect(onanswer).not.toHaveBeenCalled();

  // An edit after the press is the person's own answer, so no option shows pressed.
  field.value = '1 to 5 stars, half stars allowed';
  field.dispatchEvent(new Event('input'));
  flushSync();
  expect(option.getAttribute('aria-pressed')).toBe('false');

  page.target.querySelector<HTMLButtonElement>('[data-send-answer]')!.click();
  await settle();
  expect(onanswer).toHaveBeenCalledWith('1 to 5 stars, half stars allowed');
});

// A field set by script loses its undo history, so a press that replaced typed text would lose it.
it('keeps what the person typed when they press an option, and swaps the option on a second press', () => {
  page = mounted(AnswerComposer as never, {
    question: 'Stars or thumbs?',
    sessionId: '22222222-aaaa-4bbb-8ccc-000000000002',
    onanswer: async () => null,
    options: [{ label: '1 to 5 stars', means: null }, { label: 'Thumbs up and down', means: null }],
  });
  const field = page.target.querySelector('textarea')!;
  const [stars, thumbs] = page.target.querySelectorAll<HTMLButtonElement>('[role="group"] button');

  field.value = 'Half stars too, if that is cheap.';
  field.dispatchEvent(new Event('input'));
  flushSync();
  stars!.click();
  flushSync();
  expect(field.value).toBe('1 to 5 stars\n\nHalf stars too, if that is cheap.');
  expect([stars!.getAttribute('aria-pressed'), thumbs!.getAttribute('aria-pressed')]).toEqual(['true', 'false']);

  thumbs!.click();
  flushSync();
  expect(field.value).toBe('Thumbs up and down\n\nHalf stars too, if that is cheap.');
  expect([stars!.getAttribute('aria-pressed'), thumbs!.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
});

it('draws no options when the agent offered none', () => {
  draw(async () => null);

  expect(page!.target.querySelector('[role="group"]')).toBeNull();
});

// The key cap on Send and resume says Cmd Enter, so the field sends on it, and on nothing less.
it('sends from the field on Cmd Enter, and not on Enter alone', async () => {
  const onanswer = vi.fn(async () => null);
  const ui = draw(onanswer);
  ui.type('Titles only.');
  const field = ui.target.querySelector('textarea')!;

  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(onanswer).not.toHaveBeenCalled();

  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await settle();
  expect(onanswer).toHaveBeenCalledWith('Titles only.');
});
