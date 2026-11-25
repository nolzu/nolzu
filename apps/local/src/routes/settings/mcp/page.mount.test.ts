import { flushSync, tick } from 'svelte';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { emptyEntry } from '$lib/mcp-list.ts';
import type { McpPageData, TestAnswer } from '$lib/mcp-page.ts';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { mounted, type Mounted } from '../../../../../../packages/ui/test/mounted.svelte.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import Page from './+page.svelte';

// A submit is held with the form it posted, and answers when the test says so, through the same
// update a real enhance runs, which here hands the page its new `form`.
type After = (input: { result: { type: string }; update: () => Promise<void> }) => Promise<void>;
const posted = vi.hoisted(() => [] as { action: string; data: FormData; after: After | void }[]);
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit?: (input: { action: URL; formElement: HTMLFormElement; formData: FormData; cancel: () => void }) => After | void) => {
    const on = (event: Event): void => {
      event.preventDefault();
      const by = (event as SubmitEvent).submitter;
      const action = new URL(by?.getAttribute('formaction') ?? form.getAttribute('action') ?? '', 'http://localhost/settings/mcp');
      const data = new FormData(form, by ?? undefined);
      posted.push({ action: action.search, data, after: submit?.({ action, formElement: form, formData: data, cancel: () => {} }) });
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

const entry = (name: string, tools: string[] = []) => ({ ...emptyEntry(), name, command: `${name}-mcp`, tools });
const data = (): McpPageData => ({
  hasFolder: true,
  file: '.nolzu/mcp-servers.json',
  rows: [entry('recipes', ['read_recipe', 'drop_table']), entry('docs')].map((one) => ({ entry: one, missing: [], unlimited: [], urlWarning: null, cursorSecret: false })),
  problems: [],
  phases: [],
  cursor: false,
  codex: false,
  broken: null,
  shared: true,
  uncommitted: false,
  commitProblem: null,
  migration: null,
});

type Props = { data: McpPageData; form: unknown };
let page: Mounted<Props> | null = null;
beforeAll(() => drawnAt('/settings/mcp'));
afterEach(() => {
  page?.remove();
  page = null;
  posted.length = 0;
});

const button = (words: string, label?: string) =>
  [...page!.target.querySelectorAll('button')].find((one) => one.textContent?.trim() === words && (label === undefined || one.getAttribute('aria-label') === label))!;
const said = (where: string) => page!.target.querySelector(`[data-mcp-said="${where}"]`)!;
const press = async (one: HTMLButtonElement) => {
  one.click();
  await tick();
  flushSync();
};
// The server answers the last press with `test`.
const answer = async (test: TestAnswer) => {
  const last = posted.at(-1)!;
  await last.after?.({ result: { type: 'success' }, update: async () => page!.set({ form: { field: 'test', test } }) });
  flushSync();
};

it('tests a saved server from its row and shows the answer on that row only', async () => {
  page = mounted<Props>(Page as never, { data: data(), form: null });

  await press(button('Test', 'Test docs'));
  expect(posted[0]!.action).toBe('?/test');
  expect(posted[0]!.data.get('name')).toBe('docs');
  expect(said('docs').textContent).toContain('Starting the server and asking for its tools.');

  await answer({ name: 'docs', from: 'row', ok: false, said: 'No answer in 15 s. The server said: nothing.', tools: [], chosen: [] });
  expect(said('docs').textContent?.trim()).toBe('No answer in 15 s. The server said: nothing.');
  expect(said('docs').className).toContain('warn');
  expect(said('recipes').textContent?.trim()).toBe('');
});

it('fills Allowed tools with a box per listed tool, keeps a saved tool the server dropped, and forgets it on another form', async () => {
  const view = (page = mounted<Props>(Page as never, { data: data(), form: null }));
  await press(button('Edit', 'Edit recipes'));
  expect(view.target.querySelector<HTMLInputElement>('#mcp-tools')?.value).toBe('read_recipe, drop_table');

  await press(view.target.querySelector<HTMLButtonElement>('[data-mcp-test="form"]')!);
  expect(posted[0]!.action).toBe('?/test');
  // The form goes as typed, so the server is tested as it would be saved.
  expect(posted[0]!.data.get('kind')).toBe('local');
  expect(posted[0]!.data.get('command')).toBe('recipes-mcp');
  expect(said('form').textContent).toContain('Starting the server and asking for its tools.');

  await answer({ name: 'recipes', from: 'form', ok: true, said: 'Started, 2 tools: search_recipes, read_recipe.', tools: ['search_recipes', 'read_recipe'], chosen: ['read_recipe', 'drop_table'] });
  const boxes = [...view.target.querySelectorAll<HTMLInputElement>('[data-tool-boxes] input[type="checkbox"]')];
  expect(boxes.map((one) => [one.value, one.checked])).toEqual([
    ['search_recipes', false],
    ['read_recipe', true],
    ['drop_table', true],
  ]);
  expect(view.target.querySelector('[data-unlisted="drop_table"]')?.textContent).toContain('the server does not list it now');
  expect(view.target.querySelector('#mcp-tools')).toBeNull();
  expect(said('form').textContent?.trim()).toBe('Started, 2 tools: search_recipes, read_recipe.');
  // The boxes post as the list the save reads.
  expect(new FormData(view.target.querySelector<HTMLFormElement>('form[aria-label="Edit recipes"]')!).getAll('tools')).toEqual(['read_recipe', 'drop_table']);

  await press(button('Cancel'));
  await press(button('Edit', 'Edit docs'));
  expect(view.target.querySelector('[data-tool-boxes]')).toBeNull();
  expect(view.target.querySelector<HTMLInputElement>('#mcp-tools')?.value).toBe('');
});

it('keeps the typed list when the form test fails, with the reason', async () => {
  const view = (page = mounted<Props>(Page as never, { data: data(), form: null }));
  await press(button('Edit', 'Edit recipes'));
  await press(view.target.querySelector<HTMLButtonElement>('[data-mcp-test="form"]')!);

  await answer({ name: 'recipes', from: 'form', ok: false, said: 'Command not found: recipes-mcp. Install it, or give its full path.', tools: [], chosen: ['read_recipe', 'drop_table'] });
  expect(view.target.querySelector('[data-tool-boxes]')).toBeNull();
  expect(view.target.querySelector<HTMLInputElement>('#mcp-tools')?.value).toBe('read_recipe, drop_table');
  expect(said('form').className).toContain('warn');
  expect(said('form').textContent?.trim()).toBe('Command not found: recipes-mcp. Install it, or give its full path.');
});
