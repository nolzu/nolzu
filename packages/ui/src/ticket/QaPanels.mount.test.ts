import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { type QaInput, qaView, type StackAction } from './qa.ts';
import QaPanels from './QaPanels.svelte';

// What a server render cannot reach: the press, the wait that follows it, and the sentence the
// command ends with.

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const input = (over: Partial<QaInput> = {}): QaInput => ({
  cardKey: 'APP-1',
  run: null,
  stack: { state: 'up', reason: null },
  hasLoad: true,
  hasUnload: true,
  hasStatus: true,
  status: null,
  statusProblem: null,
  stackLane: null,
  report: null,
  screenshots: [],
  hasBrowser: false,
  ...over,
});

// An answer the test gives when it chooses to, so a press can be left waiting.
function pending() {
  const answers: ((said: string) => void)[] = [];
  const onstack = vi.fn<(action: StackAction) => Promise<string>>(() => new Promise((resolve) => answers.push(resolve)));
  const answer = async (index: number, said: string) => {
    answers[index]?.(said);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
  };
  return { onstack, answer };
}

function draw(over: Partial<QaInput>, onstack: (action: StackAction) => Promise<string>) {
  page = mounted(QaPanels as never, { view: qaView(input(over)), fileHref: (path: string) => path, onstack });
  const button = (action: StackAction) => page?.target.querySelector<HTMLButtonElement>(`[data-stack="${action}"]`) ?? null;
  const press = (action: StackAction) => {
    button(action)?.click();
    flushSync();
  };
  return { button, press, text: () => page?.target.textContent ?? '' };
}

// Load, Unload and Force run a command and wait for it. They start no phase, so each says it is
// going, the way the commit button does, rather than leaving the person with a button that looks
// idle while a `docker compose up` pulls images.
it('says the unload is going and takes no second press while it waits', () => {
  const { onstack } = pending();
  const ui = draw({ stack: { state: 'up', reason: null } }, onstack);

  ui.press('unload');
  ui.press('unload');

  expect(onstack).toHaveBeenCalledTimes(1);
  expect(onstack).toHaveBeenCalledWith('unload');
  expect(ui.text()).toContain('Stopping the app.');
  expect(ui.button('unload')?.disabled).toBe(true);
  // Only the pressed one says it is busy.
  expect(ui.button('unload')?.getAttribute('aria-busy')).toBe('true');
  expect(ui.button('force')?.hasAttribute('aria-busy')).toBe(false);
  // Force is held as well: one stack, one command at a time.
  expect(ui.button('force')?.disabled).toBe(true);
});

// The disabled attribute is the first gate and a real click never passes it. This is the second:
// an event dispatched straight at the button, which is what an assistive tool or a script can do,
// and which would otherwise start the same command twice.
it('runs the command once even when a click is dispatched at the held button', () => {
  const { onstack } = pending();
  const ui = draw({ stack: { state: 'off', reason: null } }, onstack);

  ui.press('load');
  ui.button('load')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();

  expect(onstack).toHaveBeenCalledTimes(1);
});

it('shows the command\'s own sentence when it comes back, and frees the buttons', async () => {
  const { onstack, answer } = pending();
  const ui = draw({}, onstack);

  ui.press('unload');
  await answer(0, 'The stack was taken down.');

  expect(ui.text()).toContain('The stack was taken down.');
  expect(ui.text()).not.toContain('Stopping the app.');
  expect(ui.button('unload')?.disabled).toBe(false);
});

// Force is the one button while a command is in the middle, the way out of one that never came back.
it('says Force runs the unload command whatever the state says', () => {
  const { onstack } = pending();
  const ui = draw({ stack: { state: 'loading', reason: null } }, onstack);

  ui.press('force');

  expect(onstack).toHaveBeenCalledWith('force');
  expect(ui.text()).toContain('whatever the state says');
});

// The page catches everything today, but the prop is public. A press that throws must not hold the
// three buttons for the life of the page with nothing on the screen saying why.
it('frees the buttons when the press throws', async () => {
  const onstack = vi.fn<(action: StackAction) => Promise<string>>(() => Promise.reject(new Error('the app is not answering')));
  const ui = draw({ stack: { state: 'off', reason: null } }, onstack);

  ui.press('load');
  await Promise.resolve();
  await Promise.resolve();
  flushSync();

  expect(ui.button('load')?.disabled).toBe(false);
  expect(ui.text()).toContain('the app is not answering');
});

// The other half of the rule in AGENTS.md: a run's busy state comes from the board snapshot, and
// the stack lane is in that snapshot. No click here can undo it, and the next page load is what
// frees the buttons.
it('takes no press at all once the board snapshot says a QA run holds the stack lane', () => {
  const { onstack } = pending();
  const ui = draw({ stackLane: 'APP-2' }, onstack);

  ui.press('load');
  ui.press('unload');
  ui.press('force');

  expect(onstack).not.toHaveBeenCalled();
  expect([...page!.target.querySelectorAll('[data-stack]')].every((one) => (one as HTMLButtonElement).disabled)).toBe(true);
  expect(ui.text()).not.toContain('Running the stack');
});

it('lets go when the snapshot shows the lane free again', () => {
  const { onstack } = pending();
  draw({ stackLane: 'APP-2' }, onstack);

  page?.set({ view: qaView(input({ stackLane: null })) });

  expect(page?.target.querySelector<HTMLButtonElement>('[data-stack="unload"]')?.disabled).toBe(false);
});
