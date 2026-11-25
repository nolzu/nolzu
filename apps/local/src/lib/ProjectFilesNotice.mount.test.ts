import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import type { ProjectFilesStatus } from './onboard.ts';
import ProjectFilesNotice from './ProjectFilesNotice.svelte';
import { filesStatusLine, filesUpdatedLine, handEditedLine } from './project-files-notice.ts';

// A submit hands the form to the component's callback, and the test answers it with the result it wants.
type After = (input: { result: unknown; update: (options?: { reset?: boolean }) => Promise<void> }) => Promise<void> | void;
const posted = vi.hoisted(() => [] as { form: HTMLFormElement; answer: (result: unknown) => Promise<void> }[]);
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit: (input: { formElement: HTMLFormElement; formData: FormData; cancel: () => void }) => After | void) => {
    const on = (event: Event): void => {
      event.preventDefault();
      const after = submit({ formElement: form, formData: new FormData(form), cancel: () => {} });
      posted.push({ form, answer: async (result) => void (await after?.({ result, update: async () => {} })) });
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

beforeAll(() => drawnAt('/b/delivery'));

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;
afterEach(() => {
  posted.length = 0;
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

function open(status: ProjectFilesStatus | null): HTMLElement {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ProjectFilesNotice, { target, props: { status, project: 'recipes' } }) as Record<string, unknown>;
  flushSync();
  return target;
}

const OLD: ProjectFilesStatus = { updates: ['AGENTS.md', '.agents/skills/nolzu-refine/SKILL.md'], yours: ['.claude/skills/nolzu-plan/SKILL.md'], newer: null };

it('says nothing with no status or nothing to update', () => {
  expect(open(null).textContent?.trim()).toBe('');
  unmount(instance!);
  instance = null;
  expect(open({ updates: [], yours: ['AGENTS.md'], newer: null }).querySelector('[data-project-files]')).toBeNull();
});

it('offers the update in one line, posting to the action of Write the project files', () => {
  const notice = open(OLD);

  expect(notice.querySelector('[data-project-files]')?.textContent).toContain('Nolzu has newer project files for this project.');
  expect(notice.querySelector('form')?.getAttribute('action')).toMatch(/\/settings\/project\?\/files$/);
  expect(notice.querySelector('button')?.textContent?.trim()).toBe('Update');
});

it('shows what the update did, and points to Settings, Project for the hand edits', async () => {
  const notice = open(OLD);
  notice.querySelector('form')!.requestSubmit();
  flushSync();
  expect(notice.querySelector('button')?.disabled).toBe(true);

  await posted[0]!.answer({ type: 'success', status: 200, data: { field: 'files', updated: 6, handEdited: 3, project: 'recipes' } });
  flushSync();

  expect(notice.querySelector('[data-project-files]')?.textContent).toContain('Updated 6 files. Commit them in recipes.');
  expect(notice.textContent).toContain('3 files were changed by hand and kept your text. See Settings, Project.');
  // The hand edits sit far down the page, so the link lands on their section.
  expect(notice.querySelector('a')?.getAttribute('href')).toMatch(/settings\/project#files$/);
  expect(notice.querySelector('button')?.textContent?.trim()).toBe('Close');

  notice.querySelector('button')!.click();
  flushSync();

  // The status here was never reloaded, so the offer comes back in place of the result line.
  expect(notice.textContent).not.toContain('Updated 6 files.');
  expect(notice.querySelector('button')?.textContent?.trim()).toBe('Update');
});

// The layout stays across a project switch, so what the update said must not follow to the next project.
it('drops what the update said on a switch to another project', async () => {
  // A reactive prop from a plain test file: the getter reads a SvelteMap, which Svelte tracks.
  const now = new SvelteMap([['project', 'recipes']]);
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ProjectFilesNotice, { target, props: { status: OLD, get project() { return now.get('project') ?? null; } } }) as Record<string, unknown>;
  flushSync();
  target.querySelector('form')!.requestSubmit();
  await posted[0]!.answer({ type: 'success', status: 200, data: { field: 'files', updated: 6, handEdited: 0, project: 'recipes' } });
  flushSync();
  expect(target.textContent).toContain('Commit them in recipes.');

  now.set('project', 'garden');
  flushSync();

  expect(target.textContent).not.toContain('Commit them in recipes.');
  expect(target.querySelector('button')?.textContent?.trim()).toBe('Update');
});

// A knowledge folder of the older layout is all there is to do: the notice offers Update for the move,
// and says what moved, which the update has committed already.
it('offers Update for the knowledge files to move, and says what moved', async () => {
  const notice = open({ updates: [], yours: [], newer: null, moves: 4 });
  expect(notice.querySelector('[data-project-files]')?.textContent).toContain('4 knowledge files wait to move into the folders of their repositories.');
  expect(notice.querySelector('button')?.textContent?.trim()).toBe('Update');

  notice.querySelector('form')!.requestSubmit();
  await posted[0]!.answer({ type: 'success', status: 200, data: { field: 'files', updated: 0, handEdited: 0, moved: 'Moved 4 knowledge files into the folders of their repositories and committed the move.', project: 'recipes' } });
  flushSync();

  expect(notice.textContent).toContain('Moved 4 knowledge files into the folders of their repositories and committed the move.');
});

it('says why a write failed', async () => {
  const notice = open(OLD);
  notice.querySelector('form')!.requestSubmit();
  await posted[0]!.answer({ type: 'failure', status: 400, data: { field: 'files', message: 'The folder is not there any more.' } });
  flushSync();

  expect(notice.querySelector('[role="alert"]')?.textContent).toBe('The folder is not there any more.');
});

it('shows the newer-version line with no button', () => {
  const newer = 'These project files come from Nolzu 9.0.0, newer than this Nolzu 1.0.0. Update Nolzu.';
  const notice = open({ ...OLD, newer });

  expect(notice.querySelector('[data-project-files]')?.textContent?.trim()).toBe(newer);
  expect(notice.querySelector('button')).toBeNull();
});

it('words the lines for one file and for many', () => {
  expect(filesStatusLine(null)).toBeNull();
  expect(filesStatusLine({ updates: [], yours: [], newer: null })).toBeNull();
  expect(filesUpdatedLine(1, 'recipes')).toBe('Updated 1 file. Commit it in recipes.');
  expect(filesUpdatedLine(0, 'recipes')).toBe('The project files were up to date.');
  expect(handEditedLine(0)).toBeNull();
  expect(handEditedLine(1)).toBe('1 file was changed by hand and kept your text.');
});
