import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import HandEditedFiles from './HandEditedFiles.svelte';
import type { HandEdit } from './onboard.ts';

// A submit the component did not cancel lands here with its form data, as the server would get it.
const posted = vi.hoisted(() => [] as { action: string; data: Record<string, string> }[]);
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit: (input: { formElement: HTMLFormElement; formData: FormData; cancel: () => void }) => unknown) => {
    const on = (event: Event): void => {
      event.preventDefault();
      let cancelled = false;
      const formData = new FormData(form);
      submit({ formElement: form, formData, cancel: () => (cancelled = true) });
      if (!cancelled) posted.push({ action: form.getAttribute('action') ?? '', data: Object.fromEntries([...formData].map(([key, value]) => [key, String(value)])) });
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;
afterEach(() => {
  posted.length = 0;
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

const PATCH = 'diff --git a/x b/y\n--- a/x\n+++ b/y\n@@ -1,2 +1,2 @@\n name: nolzu-plan\n-Plan the card.\n+My own plan.\n';
const SAVED: HandEdit = { path: '.claude/skills/nolzu-plan/SKILL.md', patch: PATCH, gone: false, unsaved: false };
const UNSAVED: HandEdit = { path: '.agents/skills/nolzu-qa/SKILL.md', patch: PATCH, gone: false, unsaved: true };

function open(files: HandEdit[], refused: { field: string; message: string; ask?: boolean } | null = null): HTMLElement {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(HandEditedFiles, { target, props: { files, refused } }) as Record<string, unknown>;
  flushSync();
  return target;
}
const row = (page: HTMLElement, path: string) => page.querySelector<HTMLElement>(`[data-hand-edit="${path}"]`)!;
const button = (at: HTMLElement, words: string) => [...at.querySelectorAll('button')].find((one) => one.textContent?.trim() === words)!;

it('draws nothing with no file changed by hand', () => {
  expect(open([]).textContent?.trim()).toBe('');
});

it('points to phase instructions and shows each file with its diff', () => {
  const page = open([SAVED]);

  expect(page.querySelector('[data-hand-hint]')?.textContent).toBe('Your own rules belong in phase instructions (Settings, Phases). Skills you leave untouched update with Nolzu.');
  const lines = [...row(page, SAVED.path).querySelectorAll('.ln')].map((one) => [one.getAttribute('data-line'), one.querySelector('.c')?.textContent]);
  expect(lines).toEqual([
    ['hunk', '@@ -1,2 +1,2 @@'],
    ['same', 'name: nolzu-plan'],
    ['del', 'Plan the card.'],
    ['add', 'My own plan.'],
  ]);
});

it('takes the new one at once for a file git holds, and keeps mine', () => {
  const page = open([SAVED]);

  button(row(page, SAVED.path), 'Take the new one').click();
  button(row(page, SAVED.path), 'Keep mine').click();

  expect(posted).toEqual([
    { action: '?/take', data: { path: SAVED.path, take: '1' } },
    { action: '?/keep', data: { path: SAVED.path } },
  ]);
});

it('asks once more inline for a file with changes git has not committed, and posts only on the answer', async () => {
  const page = open([UNSAVED]);
  const confirm = vi.spyOn(window, 'confirm');

  button(row(page, UNSAVED.path), 'Take the new one').click();
  flushSync();

  expect(posted).toEqual([]);
  expect(confirm).not.toHaveBeenCalled();
  expect(row(page, UNSAVED.path).querySelector('[data-hand-ask]')?.textContent).toBe(`git has not committed your changes to ${UNSAVED.path}. Taking the new one loses them.`);
  // The pressed button is gone, so the focus moves to the one that answers the ask, and back on Cancel.
  await tick();
  expect(document.activeElement).toBe(row(page, UNSAVED.path).querySelector('.ask button[type="submit"]'));

  button(row(page, UNSAVED.path), 'Cancel').click();
  flushSync();
  expect(row(page, UNSAVED.path).querySelector('[data-hand-ask]')).toBeNull();
  await tick();
  expect(document.activeElement).toBe(button(row(page, UNSAVED.path), 'Take the new one'));

  button(row(page, UNSAVED.path), 'Take the new one').click();
  flushSync();
  button(row(page, UNSAVED.path), 'Take the new one').click();
  expect(posted).toEqual([{ action: '?/take', data: { path: UNSAVED.path, take: '1', sure: '1' } }]);
});

// The server checks again, so a file changed after the page drew, or a page without JavaScript, gets the ask too.
it('opens the ask from the server\'s refusal, and prints any other refusal under its row', () => {
  const asked = open([SAVED], { field: `take:${SAVED.path}`, message: 'asked', ask: true });
  expect(row(asked, SAVED.path).querySelector('[data-hand-ask]')).not.toBeNull();
  void unmount(instance!);
  instance = null;
  target?.remove();

  const page = open([SAVED], { field: `take:${SAVED.path}`, message: '.agents is a link.' });
  expect(row(page, SAVED.path).querySelector('.refused')?.textContent).toBe('.agents is a link.');
});
