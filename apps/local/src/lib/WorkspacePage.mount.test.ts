import type { RepoState, WorkspaceFile } from '@nolzu/runner';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { WorkspaceStatus } from './workspace.ts';
import WorkspacePage from './WorkspacePage.svelte';

// jsdom has no modal dialog, so the push confirmation opens and closes by hand.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;
afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

const file = (path: string, owner: 'nolzu' | 'yours', status: WorkspaceFile['status'] = 'changed'): WorkspaceFile => ({ path, oldPath: null, status, staged: false, owner });
const repo = (over: Partial<Extract<RepoState, { ok: true }>> = {}): RepoState => ({
  ok: true,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  files: [],
  confirmation: 'Push main to origin at git@example.com:recipes.git.',
  ...over,
});
const status = (folder: RepoState, api: RepoState = repo({ branch: 'develop', behind: 2 })): WorkspaceStatus => ({
  ok: true,
  changed: (folder.ok ? folder.files.length : 0) + (api.ok ? api.files.length : 0),
  checkedAt: Date.UTC(2026, 9, 29, 9, 30),
  repos: [
    { id: '.', name: 'recipes', state: folder },
    { id: 'api', name: 'api', state: api },
  ],
});
const CHANGED = status(repo({ ahead: 1, files: [file('AGENTS.md', 'nolzu'), file('.nolzu/phases/plan.md', 'nolzu', 'untracked'), file('src/app.ts', 'yours')] }));
const PATCH = { ok: true as const, text: 'diff --git a/AGENTS.md b/AGENTS.md\n@@ -1,2 +1,2 @@\n # Rules\n-old line\n+new line\n' };

function open(props: Partial<Parameters<typeof WorkspacePage>[1]> = {}) {
  const calls = { read: 0, commit: [] as unknown[][], push: [] as string[], checked: 0 };
  const onread = vi.fn(async () => {
    calls.read += 1;
    return CHANGED;
  });
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(WorkspacePage, {
    target,
    props: {
      name: 'recipes',
      folder: '~/code/recipes',
      onread,
      onpatch: async () => PATCH,
      oncommit: async (...args: unknown[]) => {
        calls.commit.push(args);
        return { ok: true, status: status(repo({ ahead: 2, files: [file('src/app.ts', 'yours')] })) };
      },
      onpush: async (id: string, hooks: boolean) => {
        calls.push.push(hooks ? `${id} with hooks` : id);
        return { ok: true, alreadyUpToDate: false, status: status(repo()) };
      },
      onchecked: () => (calls.checked += 1),
      ...props,
    },
  }) as Record<string, unknown>;
  flushSync();
  return { page: target, calls };
}

const q = <T extends Element = HTMLElement>(page: HTMLElement, selector: string) => page.querySelector<T>(selector)!;
const ticks = (page: HTMLElement) => [...page.querySelectorAll<HTMLElement>('[data-file]')].map((row) => [row.dataset.file, row.querySelector<HTMLInputElement>('input')!.checked]);
// Waits for the first read, then opens every folded folder of files, so each file row is there to tick.
async function settle() {
  await vi.waitFor(() => expect(document.querySelector('[data-repo]')).not.toBeNull());
  for (const fold of document.querySelectorAll<HTMLButtonElement>('.fold[aria-expanded="false"]')) fold.click();
  flushSync();
}

it('reads git once on open, lists every folder with its branch, sync and changes, and tells the rail', async () => {
  const { page, calls } = open();
  await settle();

  expect(calls.read).toBe(1);
  expect(calls.checked).toBe(1);
  const rows = () => [...page.querySelectorAll('[data-repo]')].map((row) => [row.querySelector('b')?.textContent, row.querySelector('.br')?.textContent, row.querySelector('[data-sync]')?.textContent, row.querySelector('[data-changed]')?.textContent?.trim()]);
  // The clean repository folds into one line until it is opened.
  expect(rows()).toEqual([['Workspace folder', 'main', '1 to push', '3 changed']]);
  expect(q(page, '[data-repo="."] .sub').textContent).toBe('main · 1 to push');
  const fold = q<HTMLButtonElement>(page, '[data-clean-toggle]');
  expect([fold.textContent?.trim(), fold.getAttribute('aria-expanded')]).toEqual(['1 clean', 'false']);
  fold.click();
  flushSync();
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  expect(rows()).toEqual([
    ['Workspace folder', 'main', '1 to push', '3 changed'],
    ['api', 'develop', '2 behind', 'Clean'],
  ]);
  // The folder with changes is picked, and nothing on the page offers a pull, a discard, a stash or a branch.
  expect(q(page, '[data-repo="."]').getAttribute('aria-current')).toBe('true');
  expect([...page.querySelectorAll('button')].map((one) => one.textContent?.trim())).not.toContainEqual(expect.stringMatching(/pull|discard|stash|force|branch|merge/i));

  // A clean folder that waits for nothing to be pushed has no git step, so no Run hooks either.
  q<HTMLButtonElement>(page, '[data-repo="api"]').click();
  flushSync();
  expect(page.textContent).toContain('No changed files here.');
  expect(page.querySelector('[data-run-hooks]')).toBeNull();
  // Nothing to commit or push draws no empty commit box.
  expect(page.querySelector('.commit')).toBeNull();
  // The picked one stays in sight when the clean line is closed again.
  fold.click();
  flushSync();
  expect(rows().map(([nm]) => nm)).toEqual(['Workspace folder', 'api']);
});

it('draws grey shapes while git status is read', async () => {
  let answer: (value: WorkspaceStatus) => void = () => {};
  const { page } = open({ onread: () => new Promise<WorkspaceStatus>((done) => (answer = done)) });
  expect(page.querySelectorAll('[data-skeleton]').length).toBe(3);
  expect(page.textContent).toContain('Reading git status.');
  // The changes and the diff wait in the split they land in, so a wide screen keeps three columns.
  expect(page.querySelectorAll('.main .split [data-skeleton]').length).toBe(2);
  // The folder rows are drawn in the box they land in, as a name over a meta line.
  expect(page.querySelector('.repos [data-skeleton]')?.getAttribute('data-shape')).toBe('list');
  answer(CHANGED);
  await vi.waitFor(() => expect(page.querySelector('[data-repo]')).not.toBeNull());
});

it('opens the one repository with changes by itself', async () => {
  const { page } = open({ onread: async () => status(repo(), repo({ files: [file('src/app.ts', 'yours')] })) });
  await vi.waitFor(() => expect(page.querySelector('[data-repo="api"]')).not.toBeNull());
  expect(q(page, '[data-repo="api"]').getAttribute('aria-current')).toBe('true');
  // The workspace folder is listed first even when clean, and there is no clean line for it.
  expect([...page.querySelectorAll('[data-repo]')].map((row) => row.getAttribute('data-repo'))).toEqual(['.', 'api']);
  expect(page.querySelector('[data-clean-toggle]')).toBeNull();
});

it('puts the commit box above the files, folded by folder with a count and a tick', async () => {
  const many = Array.from({ length: 34 }, (_, n) => file(`.claude/skills/s${n}/SKILL.md`, 'nolzu'));
  const { page } = open({ onread: async () => status(repo({ files: [file('AGENTS.md', 'nolzu'), ...many, file('src/app.ts', 'yours')] })) });
  await vi.waitFor(() => expect(page.querySelector('[data-commit]')).not.toBeNull());

  const box = q(page, '.commit');
  expect(box.compareDocumentPosition(q(page, '[data-group]')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(q(page, '[data-commit]').textContent?.trim()).toBe('Commit 35 files');
  // Folded: the folder line with its count, and no file row of it.
  const dir = q(page, '[data-folder=".claude/skills"]');
  expect(dir.querySelector('.fold')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('.claude/skills 34');
  expect(dir.querySelector('.fold')?.getAttribute('aria-expanded')).toBe('false');
  expect(page.querySelector('[data-file=".claude/skills/s0/SKILL.md"]')).toBeNull();
  // The folder's tick takes every file in it, folded or not.
  dir.querySelector<HTMLInputElement>('input')!.click();
  flushSync();
  expect(q(page, '[data-commit]').textContent?.trim()).toBe('Commit 1 file');
  // Opened, its files are named by their path inside the folder.
  dir.querySelector<HTMLButtonElement>('.fold')!.click();
  flushSync();
  expect(q(page, '[data-file=".claude/skills/s0/SKILL.md"] .p').textContent).toBe('s0/SKILL.md');
  // Some of its files ticked shows as a half tick.
  q<HTMLInputElement>(page, '[data-file=".claude/skills/s0/SKILL.md"] input').click();
  flushSync();
  expect(dir.querySelector<HTMLInputElement>('input')!.indeterminate).toBe(true);
});

it('opens the first file as the list draws it, opens its folder, and shows grey shapes while the diff loads', async () => {
  const { page } = open({
    onread: async () => status(repo({ files: [file('src/app.ts', 'yours'), file('.claude/skills/plan/SKILL.md', 'nolzu')] })),
    onpatch: () => new Promise<never>(() => {}),
  });
  await vi.waitFor(() => expect(page.querySelector('[data-diff] .dh b')).not.toBeNull());
  // Nolzu's files are drawn first, so the first diff is theirs, not the first file git listed.
  expect(q(page, '[data-diff] .dh b').textContent).toBe('.claude/skills/plan/SKILL.md');
  expect(q(page, '[data-folder=".claude/skills"] .fold').getAttribute('aria-expanded')).toBe('true');
  expect(q(page, '[data-folder="src"] .fold').getAttribute('aria-expanded')).toBe('false');
  expect(page.querySelector('[data-diff] [data-skeleton]')).not.toBeNull();
});

it('keeps the commit line in sight after the last file of a folder is committed', async () => {
  const { page } = open({
    onread: async () => status(repo({ files: [file('AGENTS.md', 'nolzu')] }), repo({ files: [file('src/app.ts', 'yours')] })),
    oncommit: async () => ({ ok: true, status: status(repo(), repo({ files: [file('src/app.ts', 'yours')] })) }),
  });
  await vi.waitFor(() => expect(page.querySelector('[data-commit]')).not.toBeNull());
  q<HTMLButtonElement>(page, '[data-commit]').click();
  await vi.waitFor(() => expect(q(page, '[data-note]').textContent).toBe('Committed 1 file. Nothing left the machine.'));
  expect(page.textContent).toContain('No changed files here.');
});

it('ticks the Nolzu files by default and never the files of the person, with the short message', async () => {
  const { page } = open();
  await settle();

  expect([...page.querySelectorAll('[data-group]')].map((group) => group.querySelector('.gh span')?.textContent)).toEqual(['Nolzu files', 'Your files']);
  expect(ticks(page)).toEqual([
    ['AGENTS.md', true],
    ['.nolzu/phases/plan.md', true],
    ['src/app.ts', false],
  ]);
  expect(q<HTMLTextAreaElement>(page, '[data-message]').value).toBe('chore: update the Nolzu files');
  expect(q(page, '[data-commit]').textContent?.trim()).toBe('Commit 2 files');

  // Ticking an own file says so and empties the message, which is the person's to write.
  const own = q<HTMLInputElement>(page, '[data-file="src/app.ts"] input');
  own.click();
  flushSync();
  expect(q(page, '[data-own]').textContent).toBe('src/app.ts is your own file. It goes in this commit because you ticked it.');
  expect(q<HTMLTextAreaElement>(page, '[data-message]').value).toBe('');
  expect(q(page, '[data-commit]').textContent?.trim()).toBe('Commit 3 files');

  // All in the Nolzu group unticks both.
  q<HTMLInputElement>(page, '[data-tick-all]').click();
  flushSync();
  expect(ticks(page).map(([, on]) => on)).toEqual([false, false, true]);
});

it('opens the diff of the first file and another on a click', async () => {
  const onpatch = vi.fn(async () => PATCH);
  const { page } = open({ onpatch });
  await settle();
  await vi.waitFor(() => expect(page.querySelector('[data-diff] .lines')).not.toBeNull());

  expect(onpatch).toHaveBeenCalledWith('.', 'AGENTS.md');
  expect(q(page, '[data-diff] .dh').textContent).toContain('+1');
  expect([...page.querySelectorAll('[data-diff] .ln')].map((line) => [line.getAttribute('data-line'), line.querySelector('.c')?.textContent])).toEqual([
    ['hunk', '@@ -1,2 +1,2 @@'],
    ['same', '# Rules'],
    ['del', 'old line'],
    ['add', 'new line'],
  ]);
  q<HTMLButtonElement>(page, '[data-file="src/app.ts"] .pick').click();
  await vi.waitFor(() => expect(onpatch).toHaveBeenLastCalledWith('.', 'src/app.ts'));
  expect(q(page, '[data-file="src/app.ts"]').classList.contains('on')).toBe(true);
});

it('commits the ticked files only and shows the status read after it', async () => {
  const { page, calls } = open();
  await settle();

  const button = q<HTMLButtonElement>(page, '[data-commit]');
  button.focus();
  button.click();
  await vi.waitFor(() => expect(page.textContent).toContain('Committed 2 files. Nothing left the machine.'));
  // The button turned into a disabled "Commit 0 files", so focus moves to the line that says what happened.
  await vi.waitFor(() => expect(document.activeElement?.hasAttribute('data-note')).toBe(true));

  expect(calls.commit).toEqual([['.', 'chore: update the Nolzu files', ['AGENTS.md', '.nolzu/phases/plan.md'], false]]);
  // The own file stays changed and unticked, and the rail hears of the new read.
  expect(ticks(page)).toEqual([['src/app.ts', false]]);
  expect(q(page, '[data-repo="."] [data-changed]').textContent?.trim()).toBe('1 changed');
  expect(calls.checked).toBe(2);
  // One read on open and none after: the commit's answer carries the status.
  expect(calls.read).toBe(1);
});

it('shows the words of git when a commit is refused', async () => {
  const { page } = open({ oncommit: async () => ({ ok: false, reason: 'pre-commit hook said no', status: CHANGED }) });
  await settle();

  // The person ticks their own file and writes a message of their own.
  q<HTMLInputElement>(page, '[data-file="src/app.ts"] input').click();
  const box = q<HTMLTextAreaElement>(page, '[data-message]');
  box.value = 'feat: my change';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  q<HTMLButtonElement>(page, '[data-commit]').click();
  await vi.waitFor(() => expect(page.querySelector('[data-alert]')).not.toBeNull());
  expect(q(page, '[data-alert]').textContent).toBe('Git refused the commit.pre-commit hook said no');
  // Nothing was committed, so the message and the ticks stay for the next try.
  expect(q<HTMLTextAreaElement>(page, '[data-message]').value).toBe('feat: my change');
  expect(ticks(page).map(([, on]) => on)).toEqual([true, true, true]);
});

it('warns about a long subject in the commit box', async () => {
  const { page } = open({});
  await settle();

  const box = q<HTMLTextAreaElement>(page, '[data-message]');
  box.value = 'feat(api): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  expect(q(page, '[data-subject-warning]').textContent).toContain('81 characters');
});

it('asks with the confirmation sentence before a push, and sends nothing on Not yet', async () => {
  const { page, calls } = open();
  await settle();

  q<HTMLButtonElement>(page, '[data-push]').click();
  flushSync();
  const dialog = q(document.body, 'dialog[data-push-confirm]');
  expect(dialog.textContent).toContain('Push main to origin at git@example.com:recipes.git. This leaves your machine.');
  expect(calls.push).toEqual([]);

  [...dialog.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Not yet')!.click();
  flushSync();
  expect(document.querySelector('dialog[data-push-confirm]')).toBeNull();
  expect(calls.push).toEqual([]);

  // Run hooks is off unless ticked, and goes with this one press.
  q<HTMLInputElement>(page, '[data-run-hooks]').click();
  q<HTMLButtonElement>(page, '[data-push]').click();
  flushSync();
  q<HTMLButtonElement>(document.body, '[data-push-go]').click();
  await vi.waitFor(() => expect(page.textContent).toContain('Pushed.'));
  expect(calls.push).toEqual(['. with hooks']);

  // A fresh read drops the line of the last push.
  q<HTMLButtonElement>(page, '[data-check]').click();
  await vi.waitFor(() => expect(calls.read).toBe(2));
  expect(page.textContent).not.toContain('Pushed.');
});

it('says a rejected push plainly and keeps Push off until the next read', async () => {
  const reason = 'origin has commits on main that this folder does not have. Pull them in your editor or terminal, then push again. Nothing was pulled.';
  const { page, calls } = open({ onpush: async () => ({ ok: false, rejected: true, reason, status: CHANGED }) });
  await settle();
  q<HTMLInputElement>(page, '[data-file="src/app.ts"] input').click();

  q<HTMLButtonElement>(page, '[data-push]').focus();
  q<HTMLButtonElement>(page, '[data-push]').click();
  flushSync();
  q<HTMLButtonElement>(document.body, '[data-push-go]').click();
  await vi.waitFor(() => expect(page.querySelector('[data-alert]')).not.toBeNull());
  // Push turned into a disabled "Push refused", so focus goes to the refusal rather than the page.
  await vi.waitFor(() => expect(document.activeElement?.hasAttribute('data-alert')).toBe(true));
  // A push changes no file, so the own file the person ticked stays ticked.
  expect(ticks(page).map(([, on]) => on)).toEqual([true, true, true]);

  expect(q(page, '[data-alert] b').textContent).toBe('The remote refused the push.');
  expect(q(page, '[data-alert] .pre').textContent).toBe(reason);
  expect(q<HTMLButtonElement>(page, '[data-push]').disabled).toBe(true);
  expect(q(page, '[data-push]').textContent?.trim()).toBe('Push refused');

  q<HTMLButtonElement>(page, '[data-check]').click();
  await vi.waitFor(() => expect(calls.read).toBe(2));
  await vi.waitFor(() => expect(page.querySelector('[data-alert]')).toBeNull());
  expect(q<HTMLButtonElement>(page, '[data-push]').disabled).toBe(false);
});

it('says all is clean when nothing changed and nothing waits to be pushed', async () => {
  const { page } = open({ onread: async () => ({ ...status(repo()), checkedAt: Date.now() - 90_000 }) });
  await settle();

  expect(q(page, '[data-checked]').textContent).toBe('Checked 1 minute ago');

  expect(q(page, '[data-clean]').textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Nothing to commit The workspace folder and its repository match their last commit, and nothing waits to be pushed.',
  );
  expect(page.querySelector('[data-commit]')).toBeNull();
  expect(page.querySelector('[data-push]')).toBeNull();
});

it('names a folder that cannot be read and still lists the rest', async () => {
  const { page } = open({ onread: async () => status(repo({ files: [file('AGENTS.md', 'nolzu')] }), { ok: false, reason: 'The folder is not there.' }) });
  await settle();

  // Nothing waits to be pushed in the workspace folder, so it offers Commit and no Push.
  expect(page.querySelector('[data-commit]')).not.toBeNull();
  expect(page.querySelector('[data-push]')).toBeNull();
  expect(q(page, '[data-repo="api"] [data-sync]').textContent).toBe('Missing');
  q<HTMLButtonElement>(page, '[data-repo="api"]').click();
  flushSync();
  expect(page.textContent).toContain('The folder is not there.');
});
