import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import CommitComposer from './CommitComposer.svelte';

type Answer = { ok: true } | { ok: false; reason: string };
type Written = { ok: true; message: string } | { ok: false; reason: string };

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

const type = (target: HTMLElement, text: string): void => {
  const box = target.querySelector('textarea')!;
  box.value = text;
  box.dispatchEvent(new Event('input'));
  flushSync();
};

// `typed` is what the person writes in the box before the test goes on. The box opens empty.
// Every draw has one changed tracked file, list.ts. `untracked` adds new files beside it.
const entry = (path: string, status: 'added' | 'changed' | 'renamed' = 'changed', oldPath: string | null = null) => ({ path, oldPath, status, added: 1, removed: 0, binary: false });
const filesOf = (added: string[]) => [entry('list.ts'), ...added.map((path) => entry(path, 'added'))];

function draw(
  oncommit: (message: string, paths: string[], hooks: boolean) => Promise<Answer>,
  typed = 'feat(api): filter recipes',
  untracked: string[] = [],
  onwrite: (short: boolean) => Promise<Written> = async () => ({ ok: true, message: 'feat: written' }),
) {
  page = mounted(CommitComposer as never, { files: filesOf(untracked), oncommit, onwrite });
  const target = page.target;
  if (typed !== '') type(target, typed);
  return {
    target,
    press: () => {
      target.querySelector<HTMLButtonElement>('[data-commit]')!.click();
      flushSync();
    },
  };
}

it('opens empty, with no message drafted ahead', () => {
  const ui = draw(async () => ({ ok: true }), '');

  expect(ui.target.querySelector('textarea')?.value).toBe('');
  expect(ui.target.textContent).not.toMatch(/COMMIT\.md|Write it again/);
});

it('commits the typed message as it stands', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit);

  ui.press();
  await settle();

  expect(oncommit).toHaveBeenCalledWith('feat(api): filter recipes', ['list.ts'], false);
});

it('shows its own pending state and takes no second press while git works', async () => {
  let done: (answer: Answer) => void = () => {};
  const oncommit = vi.fn(() => new Promise<Answer>((resolve) => (done = resolve)));
  const ui = draw(oncommit);

  ui.press();
  ui.press();

  expect(oncommit).toHaveBeenCalledTimes(1);
  expect(ui.target.querySelector('[data-commit]')?.getAttribute('aria-busy')).toBe('true');
  expect(ui.target.textContent).toContain('Committing');
  done({ ok: true });
  await settle();
  expect(ui.target.querySelector('[data-commit]')?.getAttribute('aria-busy')).toBe('false');
});

it("shows a refusal as git's own text in a bordered code block", async () => {
  const ui = draw(async () => ({ ok: false, reason: 'lint found 2 problems in list.ts\n  list.ts:3 unused' }));

  ui.press();
  await settle();

  expect(ui.target.querySelector('pre[data-refusal]')?.textContent).toBe('lint found 2 problems in list.ts\n  list.ts:3 unused');
});

// Every changed file shows with a tick, tracked ones too, so the person sees what the commit takes.
it('ticks every changed and new file on load, in a Changed and a New group', () => {
  const ui = draw(async () => ({ ok: true }), 'feat: x', ['notes.md', 'scratch.md']);

  const groups = [...ui.target.querySelectorAll<HTMLElement>('fieldset[data-group]')];
  expect(groups.map((one) => one.querySelector('legend')?.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Changed 1', 'New 2']);
  expect(groups.map((one) => [...one.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((box) => `${box.value} ${box.checked}`))).toEqual([['list.ts true'], ['notes.md true', 'scratch.md true']]);
});

it('commits exactly the ticked files, a tracked one left out too', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit, 'feat: x', ['notes.md', 'scratch.md']);

  ui.target.querySelector<HTMLInputElement>('input[value="notes.md"]')!.click();
  ui.target.querySelector<HTMLInputElement>('input[value="list.ts"]')!.click();
  flushSync();
  ui.press();
  await settle();

  expect(oncommit).toHaveBeenCalledWith('feat: x', ['scratch.md'], false);
});

it('sends both paths of a ticked rename', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  page = mounted(CommitComposer as never, { files: [entry('lib/list.ts', 'renamed', 'list.ts')], oncommit, onwrite: vi.fn() });
  type(page.target, 'refactor: move the list');
  page.target.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();

  expect(oncommit).toHaveBeenCalledWith('refactor: move the list', ['lib/list.ts', 'list.ts'], false);
});

it('ticks a file that appears after the composer opened', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit, 'feat: x', ['notes.md']);

  page!.set({ files: filesOf(['notes.md', 'later.md']) });
  ui.press();
  await settle();

  expect(oncommit).toHaveBeenCalledWith('feat: x', ['list.ts', 'notes.md', 'later.md'], false);
});

// A long list folds each folder into one row with a tick for all its files, as the Workspace page does.
it('folds the folders of a long list, and a folder tick takes all its files', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const many = Array.from({ length: 11 }, (_, at) => `src/parts/${at}.ts`);
  const ui = draw(oncommit, 'feat: x', many);
  const folder = ui.target.querySelector<HTMLElement>('[data-folder="src/parts"]')!;

  expect(ui.target.querySelector('input[value="src/parts/0.ts"]')).toBeNull();
  folder.querySelector<HTMLButtonElement>('button')!.click();
  flushSync();
  expect(ui.target.querySelectorAll('[data-group="New"] input[value^="src/parts/"]')).toHaveLength(11);
  ui.target.querySelector<HTMLInputElement>('input[value="src/parts/3.ts"]')!.click();
  flushSync();
  expect(folder.querySelector<HTMLInputElement>('input')!.indeterminate).toBe(true);
  // A press on a half ticked folder ticks every file, as a browser does, and the next one unticks them.
  folder.querySelector<HTMLInputElement>('input')!.click();
  flushSync();
  expect(ui.target.querySelector('[data-commit]')?.textContent).toBe('Commit 12 files');
  folder.querySelector<HTMLInputElement>('input')!.click();
  flushSync();
  expect(ui.target.querySelector('[data-commit]')?.textContent).toBe('Commit 1 file');
  ui.press();
  await settle();
  expect(oncommit).toHaveBeenCalledWith('feat: x', ['list.ts'], false);
});

it('commits what the person changed the message to', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit);
  const box = ui.target.querySelector('textarea')!;

  box.value = 'fix(api): keep the old filter';
  box.dispatchEvent(new Event('input'));
  flushSync();
  ui.press();
  await settle();

  expect(oncommit).toHaveBeenCalledWith('fix(api): keep the old filter', ['list.ts'], false);
});

it('fills the box with a conventional message, and commits what the box holds', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const onwrite = vi.fn(async (short: boolean): Promise<Written> => ({ ok: true, message: short ? 'feat(api): filter recipes' : 'feat(api): filter recipes\n\nThe list was long.' }));
  const ui = draw(oncommit, 'my own words', [], onwrite);

  ui.target.querySelector<HTMLButtonElement>('[data-write="full"]')!.click();
  await settle();
  expect(onwrite).toHaveBeenLastCalledWith(false);
  expect(ui.target.querySelector('textarea')?.value).toBe('feat(api): filter recipes\n\nThe list was long.');

  ui.target.querySelector<HTMLButtonElement>('[data-write="short"]')!.click();
  await settle();
  expect(onwrite).toHaveBeenLastCalledWith(true);
  expect(ui.target.querySelector('textarea')?.value).toBe('feat(api): filter recipes');

  type(ui.target, 'feat(api): filter by title');
  ui.press();
  await settle();
  expect(oncommit).toHaveBeenCalledWith('feat(api): filter by title', ['list.ts'], false);
});

it('names both buttons for what they write', () => {
  const ui = draw(async () => ({ ok: true }));

  expect(ui.target.querySelector('[data-write="full"]')?.textContent).toBe('Write conventional message');
  expect(ui.target.querySelector('[data-write="short"]')?.textContent).toBe('Write short conventional message');
});

it('asks once while a message is being written, and keeps the box on a refusal', async () => {
  let done: (said: Written) => void = () => {};
  const onwrite = vi.fn(() => new Promise<Written>((resolve) => (done = resolve)));
  const ui = draw(async () => ({ ok: true }), 'feat: x', [], onwrite);
  const full = ui.target.querySelector<HTMLButtonElement>('[data-write="full"]')!;
  const short = ui.target.querySelector<HTMLButtonElement>('[data-write="short"]')!;

  full.click();
  full.click();
  short.click();
  flushSync();
  expect(onwrite).toHaveBeenCalledTimes(1);
  expect(full.getAttribute('aria-busy')).toBe('true');
  expect(short.disabled).toBe(true);
  done({ ok: false, reason: 'APP-1 is running, and its run writes into this checkout. Ask for a message once the run ends.' });
  await settle();

  expect(ui.target.querySelector('[role="status"]')?.textContent).toContain('once the run ends');
  expect(ui.target.querySelector('textarea')?.value).toBe('feat: x');
  expect(short.disabled).toBe(false);
});

it('keeps the buttons live when the local app does not answer', async () => {
  const onwrite = vi.fn(async (): Promise<Written> => {
    throw new TypeError('Failed to fetch');
  });
  const ui = draw(async () => ({ ok: true }), 'feat: x', [], onwrite);
  const button = ui.target.querySelector<HTMLButtonElement>('[data-write="short"]')!;

  button.click();
  await settle();
  expect(ui.target.querySelector('[role="status"]')?.textContent).toContain('did not answer');
  expect(button.getAttribute('aria-busy')).toBe('false');
  button.click();
  await settle();

  expect(onwrite).toHaveBeenCalledTimes(2);
});

it('refuses an empty message before it asks git', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit, '');

  ui.press();
  await settle();

  expect(oncommit).not.toHaveBeenCalled();
  expect(ui.target.textContent).toContain('Write a subject line first');
});

it('counts the ticked files on the button, and turns it off at none', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit, 'feat: x', ['notes.md', 'scratch.md']);
  expect(ui.target.querySelector('[data-commit]')?.textContent).toBe('Commit 3 files');
  ui.target.querySelector<HTMLInputElement>('input[value="notes.md"]')!.click();
  ui.target.querySelector<HTMLInputElement>('input[value="scratch.md"]')!.click();
  flushSync();
  expect(ui.target.querySelector('[data-commit]')?.textContent).toBe('Commit 1 file');
  ui.target.querySelector<HTMLInputElement>('input[value="list.ts"]')!.click();
  flushSync();
  const button = ui.target.querySelector<HTMLButtonElement>('[data-commit]')!;
  expect(button.textContent).toBe('Commit 0 files');
  expect(button.disabled).toBe(true);
  ui.press();
  await settle();
  expect(oncommit).not.toHaveBeenCalled();
});

it('says aloud that git refused, and clears a message once it is committed', async () => {
  const refused = draw(async () => ({ ok: false, reason: 'hook failed' }));
  refused.press();
  await settle();
  expect(refused.target.querySelector('[role="status"]')?.textContent).toContain('Git refused the commit');
  page?.remove();

  const taken = draw(async () => ({ ok: true }));
  taken.press();
  await settle();
  expect(taken.target.querySelector('textarea')?.value).toBe('');
});

// Used alone, with no repository named, it keeps the plain ids of the project folder.
it('keeps the plain ids when no repository is named', () => {
  const ui = draw(async () => ({ ok: true }), '');
  expect(ui.target.querySelector('section')?.getAttribute('aria-labelledby')).toBe('commit-title');
  expect(ui.target.querySelector('#commit-title')).not.toBeNull();
  expect(ui.target.querySelector('label')?.getAttribute('for')).toBe('commit-message');
  expect(ui.target.querySelector('textarea')?.id).toBe('commit-message');
});

// The model and the cost of the pass that wrote the message sit beside the buttons, as the pass
// reported them. Nothing shows before a write, and no cost reported says none.
it('names the model and the cost of the pass after a message is written', async () => {
  const replies: { ok: true; message: string; model?: string; cost?: number | null }[] = [
    { ok: true, message: 'feat(api): filter recipes', model: 'haiku', cost: 0.012 },
    { ok: true, message: 'feat(api): filter', model: 'haiku', cost: null },
  ];
  const ui = draw(async () => ({ ok: true }), '', [], async () => replies.shift()!);
  const by = () => ui.target.querySelector('[data-written-by]')?.textContent ?? null;

  expect(by()).toBeNull();
  ui.target.querySelector<HTMLButtonElement>('[data-write="full"]')!.click();
  await settle();
  expect(by()).toBe('haiku · $0.01');
  ui.target.querySelector<HTMLButtonElement>('[data-write="short"]')!.click();
  await settle();
  expect(by()).toBe('haiku');
});

// An agent wrote the work, so the composer says the hooks are skipped and offers them for one commit.
it('says the git hooks are skipped, and runs them only on the commit they were ticked for', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit);

  expect(ui.target.querySelector('[data-hooks]')?.textContent).toContain('Git hooks are skipped, because an agent wrote these changes.');
  const tick = ui.target.querySelector<HTMLInputElement>('[data-run-hooks]')!;
  expect(tick.checked).toBe(false);
  expect(ui.target.querySelector(`label[for="${tick.id}"]`)?.textContent).toBe('Run hooks');
  tick.click();
  flushSync();
  ui.press();
  await settle();
  expect(oncommit).toHaveBeenLastCalledWith('feat(api): filter recipes', ['list.ts'], true);

  expect(tick.checked).toBe(false);
  type(ui.target, 'feat: next');
  ui.press();
  await settle();
  expect(oncommit).toHaveBeenLastCalledWith('feat: next', ['list.ts'], false);
});

it('warns past 72 characters in the subject and still commits', async () => {
  const oncommit = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw(oncommit, 'feat(api): short');
  expect(ui.target.querySelector('[data-subject-warning]')).toBeNull();

  type(ui.target, 'feat(api): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  expect(ui.target.querySelector('[data-subject-warning]')?.textContent).toContain('81 characters');
  ui.press();
  await settle();

  expect(oncommit).toHaveBeenCalledWith('feat(api): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ['list.ts'], false);
});
