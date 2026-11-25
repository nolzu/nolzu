import type { Changes, WorktreeRow } from '@nolzu/protocol';
import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import ChangeGroups from './ChangeGroups.svelte';

// The push confirm is a modal dialog. jsdom has the dialog element but none of its modal half, so this
// gives it the two calls the dialog uses, as Dialog.mount.test.ts does.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

const row = (repo: string, over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  repo,
  path: `/p/worktrees/APP-1/${repo}`,
  branch: 'APP-1-search',
  base: 'main',
  ahead: 1,
  behind: 0,
  changed: 1,
  untracked: 0,
  unpushed: null,
  stale: false,
  staleReason: null,
  ...over,
});
const entry = (path: string) => ({ path, oldPath: null, status: 'changed' as const, added: 1, removed: 0, binary: false });
const leaf = (path: string) => ({ name: path, path, entry: entry(path), children: [] });
const changed = (repo: string, file: string): Changes => ({
  ok: true,
  row: row(repo),
  untracked: [],
  committed: { stat: { files: 1, added: 1, removed: 0 }, tree: [leaf(`old-${file}`)] },
  uncommitted: { stat: { files: 1, added: 1, removed: 0 }, tree: [leaf(file)] },
  diff: { stat: { files: 2, added: 2, removed: 0 }, tree: [leaf(`old-${file}`), leaf(file)] },
});
const nothing = (repo: string): Changes => ({
  ok: true,
  row: row(repo, { ahead: 0, changed: 0 }),
  untracked: [],
  committed: { stat: { files: 0, added: 0, removed: 0 }, tree: [] },
  uncommitted: { stat: { files: 0, added: 0, removed: 0 }, tree: [] },
  diff: { stat: { files: 0, added: 0, removed: 0 }, tree: [] },
});
const publish = (name: string) => ({
  ok: true as const,
  confirmation: `Push APP-1-search to origin at https://github.com/example/${name}.git.`,
  pushed: false,
  compare: { ok: true as const, url: `https://github.com/example/${name}/compare/main...APP-1-search?expand=1` },
});

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

function draw(groups: unknown[], extra: Record<string, unknown> = {}) {
  const calls = {
    onopen: vi.fn(async () => ({ ok: true as const, text: '' })),
    oncommit: vi.fn(async () => ({ ok: true as const })),
    onwrite: vi.fn(async () => ({ ok: true as const, message: 'feat: written' })),
    onpush: vi.fn(async () => ({ ok: true as const })),
    oncopy: vi.fn<(text: string) => Promise<string | null>>(async () => null),
  };
  page = mounted(ChangeGroups as never, { groups, ...calls, ...extra });
  return { target: page.target, ...calls };
}

const two = () => [
  { repo: '.', changes: changed('.', 'list.ts'), publish: publish('recipe-web') },
  { repo: 'api', changes: changed('api', 'server.ts'), publish: publish('recipe-api') },
];

it('draws one group of a single repository with no heading, and the ids it always had', () => {
  const ui = draw([two()[0]]);

  expect(ui.target.querySelectorAll('[data-repo]')).toHaveLength(0);
  expect(ui.target.querySelector('h2.repo')).toBeNull();
  expect(ui.target.querySelector('#commit-title')).not.toBeNull();
  expect(ui.target.querySelector('#commit-message')).not.toBeNull();
  expect(ui.target.querySelector('#push-title')).not.toBeNull();
});

it('draws two headed groups, each with its own composer and its own compare link', () => {
  const ui = draw(two());

  const groups = [...ui.target.querySelectorAll<HTMLElement>('[data-repo]')];
  expect(groups.map((one) => one.querySelector('h2.repo')?.textContent)).toEqual(['project folder', 'api']);
  expect(groups.map((one) => one.querySelectorAll('[data-write]').length)).toEqual([2, 2]);
  for (const group of groups) group.querySelector<HTMLButtonElement>('[data-copy-link]')!.click();
  expect(ui.oncopy.mock.calls).toEqual([
    ['https://github.com/example/recipe-web/compare/main...APP-1-search?expand=1'],
    ['https://github.com/example/recipe-api/compare/main...APP-1-search?expand=1'],
  ]);
  // No id twice on one page, so each label still points at its own box.
  const ids = [...ui.target.querySelectorAll('[id]')].map((one) => one.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(groups[1]?.querySelector('label[for]')?.getAttribute('for')).toBe(groups[1]?.querySelector('textarea')?.id);
});

it("sends the group's repository with a message button, a commit, a patch and a push", async () => {
  const ui = draw(two());
  const apiGroup = ui.target.querySelector<HTMLElement>('[data-repo="api"]')!;

  apiGroup.querySelector<HTMLButtonElement>('[data-write="short"]')!.click();
  await settle();
  apiGroup.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();
  apiGroup.querySelector<HTMLButtonElement>('[data-open="server.ts"]')!.click();
  await settle();
  apiGroup.querySelector<HTMLButtonElement>('[data-push]')!.click();
  await settle();
  apiGroup.querySelector<HTMLButtonElement>('[data-confirm-push]')!.click();
  await settle();

  expect(ui.onwrite).toHaveBeenCalledWith('api', true);
  expect(ui.oncommit).toHaveBeenCalledWith('api', 'feat: written', ['server.ts'], false);
  expect(ui.onopen).toHaveBeenCalledWith('api', { path: 'server.ts', oldPath: null, group: 'branch' });
  // A push commits nothing: the group's commit ahead goes, and the work in the folder stays.
  expect(ui.onpush).toHaveBeenCalledWith('api', undefined, false);

  ui.target.querySelector<HTMLElement>('[data-repo="."]')!.querySelector<HTMLButtonElement>('[data-write="short"]')!.click();
  await settle();
  expect(ui.onwrite).toHaveBeenLastCalledWith('.', true);
});

it('sends the repository of a single group that is not the project folder', async () => {
  const ui = draw([two()[1]]);

  expect(ui.target.querySelector('h2.repo')).toBeNull();
  const box = ui.target.querySelector('textarea')!;
  box.value = 'feat(api): search';
  box.dispatchEvent(new Event('input'));
  flushSync();
  ui.target.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();

  expect(ui.oncommit).toHaveBeenCalledWith('api', 'feat(api): search', ['server.ts'], false);
});

it('keeps every label whole when a repository folder name has a space', () => {
  const ui = draw([...two(), { repo: 'recipe api', changes: changed('recipe api', 'mail.ts'), publish: publish('recipe-mail') }]);

  const ids = [...ui.target.querySelectorAll('[id]')].map((one) => one.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const labelled of ui.target.querySelectorAll('[aria-labelledby]')) {
    const name = labelled.getAttribute('aria-labelledby')!;
    expect(name).not.toContain(' ');
    expect(ui.target.querySelector(`[id="${name}"]`)).not.toBeNull();
  }
});

it('keeps the wait of a message button to its own group', async () => {
  const ui = draw(two());
  let answer: (said: { ok: true; message: string }) => void = () => {};
  ui.onwrite.mockImplementationOnce(() => new Promise((done) => (answer = done)));
  const [rootGroup, apiGroup] = [...ui.target.querySelectorAll<HTMLElement>('[data-repo]')];

  apiGroup!.querySelector<HTMLButtonElement>('[data-write="full"]')!.click();
  flushSync();

  expect(apiGroup!.querySelector('[data-write="short"]')!.hasAttribute('disabled')).toBe(true);
  expect(rootGroup!.querySelector('[data-write="short"]')!.hasAttribute('disabled')).toBe(false);
  answer({ ok: true, message: 'feat(api): search' });
  await settle();
  expect(apiGroup!.querySelector('textarea')!.value).toBe('feat(api): search');
  expect(rootGroup!.querySelector('textarea')!.value).toBe('');
});

// A workspace of many repositories: only the ones the card changed show, and the rest fold into one line.
it('folds a repository with nothing changed into one line and draws one facts line for the one that changed', () => {
  const ui = draw([two()[0], { repo: 'api', changes: nothing('api'), publish: publish('recipe-api') }, { repo: 'mail', changes: { ok: false, reason: 'APP-1 does not work in mail.' }, publish: { ok: false, reason: 'APP-1 does not work in mail.' } }]);

  expect(ui.target.querySelector('[role="tablist"]')).toBeNull();
  expect(ui.target.querySelectorAll('[data-facts]')).toHaveLength(1);
  expect(ui.target.querySelector('[data-facts]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('project folder APP-1-search 1 file not committed base main · 1 ahead · 0 behind');
  expect(ui.target.querySelectorAll('textarea')).toHaveLength(1);
  const toggle = ui.target.querySelector<HTMLButtonElement>('[data-rest-toggle]')!;
  expect(toggle.textContent?.trim()).toBe('2 without changes');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(ui.target.querySelector('[data-rest-list]')).toBeNull();

  toggle.click();
  flushSync();
  expect([...ui.target.querySelectorAll('[data-rest-list] li')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['api no changes', 'mail no changes']);
});

it('draws a small tab per changed repository with its lines, and none for the rest', () => {
  const ui = draw([...two(), { repo: 'mail', changes: nothing('mail'), publish: publish('recipe-mail') }]);

  expect([...ui.target.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['project folder +2 -0', 'api +2 -0']);
  expect(ui.target.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);
  expect(ui.target.querySelector('[data-rest-toggle]')?.textContent?.trim()).toBe('1 without changes');
});

// Before the card has a checkout no repository changed, so the first one shows with its reason.
it('shows the first repository with its reason when the card changed none', () => {
  const ui = draw([{ repo: '.', changes: { ok: false, reason: 'APP-1 has no checkout yet.' }, publish: { ok: false, reason: 'none' } }, { repo: 'api', changes: nothing('api'), publish: publish('recipe-api') }]);

  expect(ui.target.textContent).toContain('APP-1 has no checkout yet.');
  expect(ui.target.querySelector('[data-rest-toggle]')?.textContent?.trim()).toBe('1 without changes');
});

it("says the commit in the group that made it", async () => {
  const ui = draw(two());
  const [rootGroup, apiGroup] = [...ui.target.querySelectorAll<HTMLElement>('[data-repo]')];
  const box = apiGroup!.querySelector('textarea')!;
  box.value = 'feat(api): search';
  box.dispatchEvent(new Event('input'));
  flushSync();

  apiGroup!.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();

  expect(apiGroup!.querySelector('p.committed')?.textContent).toBe('Committed. Nothing left the machine.');
  expect(rootGroup!.querySelector('p.committed')?.textContent).toBe('');
});

it('says no commit note when the commit is refused', async () => {
  const ui = draw(two());
  ui.oncommit.mockImplementationOnce(async () => ({ ok: false, reason: 'git refused' }) as never);
  const apiGroup = ui.target.querySelector<HTMLElement>('[data-repo="api"]')!;
  const box = apiGroup.querySelector('textarea')!;
  box.value = 'feat(api): search';
  box.dispatchEvent(new Event('input'));
  flushSync();

  apiGroup.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();

  expect(ui.oncommit).toHaveBeenCalledWith('api', 'feat(api): search', ['server.ts'], false);
  expect(apiGroup.querySelector('p.committed')?.textContent).toBe('');
});

it('keeps the link of a repository with a remote when the other has none', () => {
  const none = { ok: true as const, confirmation: null, pushed: false, compare: { ok: false as const, reason: 'This project has no remote, and a pull request needs a GitHub remote.' } };
  const ui = draw([{ ...two()[0], publish: none }, two()[1]]);
  const [rootGroup, apiGroup] = [...ui.target.querySelectorAll<HTMLElement>('[data-repo]')];

  expect(rootGroup!.querySelector('[data-copy-link]')).toBeNull();
  expect(rootGroup!.textContent).toContain('This project has no remote, and a pull request needs a GitHub remote.');
  apiGroup!.querySelector<HTMLButtonElement>('[data-copy-link]')!.click();
  expect(ui.oncopy).toHaveBeenCalledWith('https://github.com/example/recipe-api/compare/main...APP-1-search?expand=1');
  expect(apiGroup!.querySelector('[data-push]')).not.toBeNull();
});

// The push confirm names the card, the branch, the remote and the group's own change, and after a
// rejected push "Pull into the checkout" pulls the group's own repository.
it("names the group's branch and change in the push confirm, and pulls the group's repository", async () => {
  const onpull = vi.fn(async () => ({ ok: true as const, upToDate: false }));
  const where = { branch: 'APP-1-search', remote: { name: 'origin', url: 'https://github.com/example/recipe-api.git' }, host: 'GitHub', place: 'github.com/example/recipe-api' };
  // Nothing left in the folder, so the push sends the commits alone.
  const clean = { files: 0, added: 0, removed: 0 };
  const groups = [
    two()[0],
    {
      ...two()[1],
      changes: { ...changed('api', 'server.ts'), row: row('api', { ahead: 3, unpushed: 2, changed: 0 }), uncommitted: { stat: clean, tree: [] }, branch: { files: 4, added: 38, removed: 6 }, pushes: { files: 1, added: 5, removed: 2 } },
      publish: { ...publish('recipe-api'), ...where },
    },
  ];
  const calls = {
    onopen: vi.fn(async () => ({ ok: true as const, text: '' })),
    oncommit: vi.fn(async () => ({ ok: true as const })),
    onwrite: vi.fn(async () => ({ ok: true as const, message: '' })),
    onpush: vi.fn(async () => ({ ok: false as const, reason: '! [rejected] APP-1-search -> APP-1-search (fetch first)', rejected: true })),
  };
  page = mounted(ChangeGroups as never, { groups, card: 'APP-1', onpull, ...calls });
  const api = page.target.querySelector<HTMLElement>('[data-repo="api"]')!;

  api.querySelector<HTMLButtonElement>('[data-push]')!.click();
  flushSync();
  const dialog = api.querySelector<HTMLDialogElement>('dialog[data-push-confirm]')!;
  expect(dialog.querySelector('h2')?.textContent).toBe('Push APP-1 and open a pull request');
  // The change is what the push adds on top of the upstream, not the whole branch.
  expect(api.querySelector('[data-open-pull]')).toBeNull();
  expect(dialog.querySelector('[data-push-where]')?.textContent?.replace(/\s+/g, ' ')).toContain('+5 -2 · 1 file');
  dialog.querySelector<HTMLButtonElement>('[data-confirm-push]')!.click();
  await settle();
  api.querySelector<HTMLButtonElement>('[data-pull]')!.click();
  await settle();

  expect(calls.onpush).toHaveBeenCalledWith('api', undefined, false);
  expect(onpull).toHaveBeenCalledWith('api');
});

// Right after a run the work sits in the folder with nothing committed. The panel is there, Push is off
// with its reason, and Commit takes the ticked files: work goes in any order, never as numbered steps.
it('keeps Push off for work only in the folder, and commits the ticked files alone', async () => {
  const work: Changes = {
    ok: true,
    row: row('api', { ahead: 0, changed: 0, untracked: 2 }),
    untracked: ['notes.md', '.env.local'],
    committed: { stat: { files: 0, added: 0, removed: 0 }, tree: [] },
    uncommitted: { stat: { files: 2, added: 2, removed: 0 }, tree: [leaf('notes.md'), leaf('.env.local')] },
    branch: { files: 2, added: 2, removed: 0 },
  };
  const ui = draw([{ repo: 'api', changes: work, publish: publish('recipe-api') }]);
  const box = ui.target.querySelector<HTMLInputElement>('input[type="checkbox"][value=".env.local"]')!;
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();

  expect(ui.target.querySelector('[data-push]')?.getAttribute('aria-disabled')).toBe('true');
  expect(ui.target.querySelector('[data-push-why]')?.textContent).toBe('Nothing to push yet. Commit first.');
  ui.target.querySelector<HTMLButtonElement>('[data-write="short"]')!.click();
  await settle();
  ui.target.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();
  expect(ui.oncommit).toHaveBeenCalledWith('api', 'feat: written', ['notes.md'], false);
  expect(ui.onpush).not.toHaveBeenCalled();
});

// Run hooks in the push dialog goes with that one push, and the commit box's tick with its commit.
it('hands each Run hooks tick to the press it belongs to', async () => {
  const ui = draw([{ repo: 'api', changes: changed('api', 'server.ts'), publish: publish('recipe-api') }]);

  ui.target.querySelector<HTMLButtonElement>('[data-push]')!.click();
  await settle();
  ui.target.querySelector<HTMLInputElement>('dialog [data-run-hooks]')!.click();
  ui.target.querySelector<HTMLButtonElement>('[data-confirm-push]')!.click();
  await settle();
  expect(ui.onpush).toHaveBeenCalledWith('api', undefined, true);

  ui.target.querySelector<HTMLButtonElement>('[data-write="short"]')!.click();
  await settle();
  ui.target.querySelector<HTMLInputElement>('[data-run-hooks]:not(dialog *)')!.click();
  ui.target.querySelector<HTMLButtonElement>('[data-commit]')!.click();
  await settle();
  expect(ui.oncommit).toHaveBeenCalledWith('api', expect.any(String), ['server.ts'], true);
});

// The repository switcher shows one repository at a time. A press or the arrow keys pick another.
it('shows the repository whose tab is pressed, and moves along the tabs with the arrow keys', () => {
  const ui = draw([...two(), { repo: 'mail', changes: changed('mail', 'mail.ts'), publish: publish('recipe-mail') }]);
  const shown = () => [...ui.target.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((one) => !one.hidden).map((one) => one.dataset.repo);
  const tab = (repo: string) => ui.target.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls="panel${repo === '.' ? '' : `-${repo}`}"]`)!;

  expect(shown()).toEqual(['.']);
  expect(tab('.').tabIndex).toBe(0);
  expect(tab('api').tabIndex).toBe(-1);

  tab('mail').click();
  flushSync();
  expect(shown()).toEqual(['mail']);
  expect(tab('mail').getAttribute('aria-selected')).toBe('true');

  tab('mail').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  flushSync();
  expect(shown()).toEqual(['.']);
  expect(document.activeElement).toBe(tab('.'));
  tab('.').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  flushSync();
  expect(shown()).toEqual(['mail']);
});

// The page's Next step (Send back with comments) is drawn once, beside the shown repository's
// diff, and only while a comment is not sent yet.
const comment = (id: number, repo: string, sentAt: string | null = null) => ({
  id,
  repo,
  file: 'server.ts',
  line: 3,
  lineText: 'export const port = 3000;',
  text: 'Read the port from the settings.',
  commit: 'abc123',
  createdAt: '2026-10-15T08:00:00.000Z',
  sentAt,
});
const next = createRawSnippet(() => ({ render: () => '<p data-next>Send back</p>' }));

it("draws the page's next step once, in the shown repository, while a comment is not sent", () => {
  page = mounted(ChangeGroups as never, { groups: two(), onopen: vi.fn(), oncommit: vi.fn(), onwrite: vi.fn(), onpush: vi.fn(), comments: [comment(1, 'api')], next });

  expect(page.target.querySelectorAll('[data-next]')).toHaveLength(1);
  const shown = page.target.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
  expect(shown.querySelector('[data-next]')).not.toBeNull();
  page.remove();

  page = mounted(ChangeGroups as never, { groups: two(), onopen: vi.fn(), oncommit: vi.fn(), onwrite: vi.fn(), onpush: vi.fn(), comments: [comment(1, 'api', '2026-10-15T09:00:00.000Z')], next });
  expect(page.target.querySelector('[data-next]')).toBeNull();
});

// Commit stays open while a comment is not sent. The composer says how many wait,
// as a plain line, and the commit goes as always.
it('says how many comments of the repository are not sent yet, and commits all the same', async () => {
  const calls = { onopen: vi.fn(), oncommit: vi.fn(async () => ({ ok: true as const })), onwrite: vi.fn(), onpush: vi.fn() };
  page = mounted(ChangeGroups as never, { groups: two(), ...calls, comments: [comment(1, 'api'), comment(2, 'api'), comment(3, 'api', '2026-10-15T09:00:00.000Z'), comment(4, '.')] });
  const api = page.target.querySelector<HTMLElement>('[data-repo="api"]')!;
  const root = page.target.querySelector<HTMLElement>('[data-repo="."]')!;

  expect(api.querySelector('[data-unsent]')?.textContent).toBe('2 comments are not sent back yet. A commit does not send them.');
  expect(root.querySelector('[data-unsent]')?.textContent).toBe('1 comment is not sent back yet. A commit does not send it.');
  const commit = api.querySelector<HTMLButtonElement>('[data-commit]')!;
  expect(commit.disabled).toBe(false);
  expect(commit.getAttribute('aria-disabled')).toBeNull();

  const box = api.querySelector('textarea')!;
  box.value = 'fix(api): read the port';
  box.dispatchEvent(new Event('input'));
  flushSync();
  commit.click();
  await settle();

  expect(calls.oncommit).toHaveBeenCalledWith('api', 'fix(api): read the port', ['server.ts'], false);
});

it('draws Commit, Push and Create pull request as three actions in one panel, with no step number', () => {
  const ui = draw([{ ...two()[0], name: 'recipe-web' }]);
  const ship = ui.target.querySelector<HTMLElement>('section.ship')!;

  expect(ship.querySelector('h2')?.textContent).toBe('Commit and push');
  expect(ship.querySelector('.ship-head .sub')?.textContent).toBe('recipe-web');
  expect(ship.querySelector('.no')).toBeNull();
  expect([...ship.querySelectorAll('.step')].map((one) => one.firstElementChild?.textContent)).toEqual(['Commit 1 file', 'Push 1 commit', 'Create pull request']);
  expect(ship.querySelector('label[for="commit-message"]')?.textContent).toBe('Commit message');
});

// Not committed and Whole card. The page keeps the pick in the address, so the switch only hands it back.
const commitsOf = (list: { sha: string; subject: string; pushed: boolean }[], total = list.length) => ({ list: list.map((one) => ({ ...one, short: one.sha.slice(0, 7) })), total });
const clean = (repo: string, commits?: ReturnType<typeof commitsOf>): Changes => ({
  ...(changed(repo, 'x.ts') as Extract<Changes, { ok: true }>),
  row: row(repo, { changed: 0, ahead: commits?.total ?? 0 }),
  uncommitted: { stat: { files: 0, added: 0, removed: 0 }, tree: [] },
  ...(commits === undefined ? {} : { commits }),
});
const files = (target: HTMLElement) => [...target.querySelectorAll('[data-open]')].map((one) => one.getAttribute('data-open'));

it('switches between Not committed and Whole card, and draws the diff each view names', () => {
  const onview = vi.fn();
  const ui = draw([two()[0]], { view: 'uncommitted', onview, oncomment: vi.fn() });

  const [mine, whole] = [...ui.target.querySelectorAll<HTMLButtonElement>('[data-views] button')];
  expect([mine?.textContent, mine?.getAttribute('aria-pressed'), whole?.textContent, whole?.getAttribute('aria-pressed')]).toEqual(['Not committed', 'true', 'Whole card', 'false']);
  // Only what a commit takes now, and no comment gutter: a comment is made on the whole change.
  expect(files(ui.target)).toEqual(['list.ts']);
  expect(ui.target.textContent).toContain('Comments on the diff are made on Whole card.');
  whole?.click();
  expect(onview).toHaveBeenCalledWith('all');

  page?.set({ view: 'all' });
  expect(files(ui.target)).toEqual(['old-list.ts', 'list.ts']);
  ui.target.querySelector<HTMLButtonElement>('[data-open="list.ts"]')!.click();
  expect(ui.onopen).toHaveBeenLastCalledWith('.', { path: 'list.ts', oldPath: null, group: 'branch' });
  expect(ui.target.textContent).not.toContain('Comments on the diff are made on Whole card.');
});

it('asks the patch of a file on Not committed from the uncommitted group', async () => {
  const ui = draw([two()[0]], { view: 'uncommitted', onview: vi.fn() });

  ui.target.querySelector<HTMLButtonElement>('[data-open="list.ts"]')!.click();
  await settle();

  expect(ui.onopen).toHaveBeenCalledWith('.', { path: 'list.ts', oldPath: null, group: 'uncommitted' });
});

it('says Nothing to commit and lists the commits, newest first, pushed or not, with the older ones counted', () => {
  const commits = commitsOf([{ sha: 'bbbbbbbbbb', subject: 'Add the search box', pushed: false }, { sha: 'aaaaaaaaaa', subject: 'Read the query', pushed: true }], 7);
  const ui = draw([{ repo: '.', changes: clean('.', commits), publish: publish('recipe-web') }], { view: 'uncommitted', onview: vi.fn(), oncommitdiff: vi.fn() });

  expect(ui.target.querySelector('[data-nothing]')?.textContent).toBe('Nothing to commit.');
  const lines = [...ui.target.querySelectorAll('[data-commit]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim());
  expect(lines).toEqual(['bbbbbbb Add the search box not pushed', 'aaaaaaa Read the query pushed']);
  expect(ui.target.querySelector('[data-history]')?.textContent).toContain('and 5 older');
  expect(files(ui.target)).toEqual([]);
});

it('opens a commit in the diff view, read only, and asks its patches from that commit', async () => {
  const commits = commitsOf([{ sha: 'bbbbbbbbbb', subject: 'Add the search box', pushed: false }]);
  const oncommitdiff = vi.fn(async () => ({ ok: true as const, diff: { stat: { files: 1, added: 1, removed: 0 }, tree: [leaf('search.ts')] } }));
  const ui = draw([{ repo: 'api', changes: clean('api', commits), publish: publish('recipe-api') }], { view: 'uncommitted', onview: vi.fn(), oncommitdiff, oncomment: vi.fn() });

  ui.target.querySelector<HTMLButtonElement>('[data-commit="bbbbbbbbbb"]')!.click();
  await settle();
  expect(oncommitdiff).toHaveBeenCalledWith('api', 'bbbbbbbbbb');
  expect(ui.target.querySelector('[data-commit="bbbbbbbbbb"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(ui.target.querySelector('[data-diff]')?.getAttribute('aria-label')).toBe('Diff against the parent of bbbbbbb');
  ui.onopen.mockResolvedValue({ ok: true, text: 'diff --git a/search.ts b/search.ts\n@@ -0,0 +1 @@\n+find\n' });
  ui.target.querySelector<HTMLButtonElement>('[data-open="search.ts"]')!.click();
  await settle();
  expect(ui.target.querySelectorAll('[data-line]').length).toBeGreaterThan(0);
  expect(ui.onopen).toHaveBeenCalledWith('api', { path: 'search.ts', oldPath: null, group: 'commit', commit: 'bbbbbbbbbb' });
  expect(ui.target.querySelector('[data-gutter]')).toBeNull();
});

// Reading a commit's files runs git, so its row is busy until they come and a second press asks nothing.
it('asks git once for a commit pressed twice, and marks its row busy until the files come', async () => {
  const commits = commitsOf([{ sha: 'bbbbbbbbbb', subject: 'Add the search box', pushed: false }]);
  let answer: (diff: { ok: true; diff: { stat: { files: number; added: number; removed: number }; tree: ReturnType<typeof leaf>[] } }) => void = () => undefined;
  const oncommitdiff = vi.fn(() => new Promise<Parameters<typeof answer>[0]>((done) => (answer = done)));
  const ui = draw([{ repo: 'api', changes: clean('api', commits), publish: publish('recipe-api') }], { view: 'uncommitted', onview: vi.fn(), oncommitdiff });
  const row = () => ui.target.querySelector<HTMLButtonElement>('[data-commit="bbbbbbbbbb"]')!;

  row().click();
  await settle();
  row().click();
  await settle();

  expect(oncommitdiff).toHaveBeenCalledTimes(1);
  expect(row().getAttribute('aria-busy')).toBe('true');
  answer({ ok: true, diff: { stat: { files: 1, added: 1, removed: 0 }, tree: [leaf('search.ts')] } });
  await settle();
  expect(row().hasAttribute('aria-busy')).toBe(false);
});

// The fold follows the view: on Not committed a repository counts as changed only with work in its
// folder, on Whole card with any work.
it('folds the repositories by the rule of the view on screen', () => {
  const groups = [
    { repo: '.', changes: changed('.', 'list.ts'), publish: publish('recipe-web') },
    { repo: 'api', changes: clean('api', commitsOf([{ sha: 'cccccccccc', subject: 'Serve the search', pushed: false }])), publish: publish('recipe-api') },
    { repo: 'mail', changes: nothing('mail'), publish: { ok: false as const, reason: 'nothing' } },
  ];
  const ui = draw(groups, { view: 'uncommitted', onview: vi.fn() });

  // The api has a commit to push and nothing to commit: it keeps its tab and its push panel.
  expect([...ui.target.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['project folder +1 -0', 'api']);
  const api = ui.target.querySelector<HTMLElement>('[data-repo="api"]')!;
  expect(api.querySelector('[data-nothing]')?.textContent).toBe('Nothing to commit.');
  expect(api.querySelector('[data-history] .commit')?.textContent).toContain('Serve the search');
  expect(api.querySelector('[id^="push-title"]')).not.toBeNull();
  expect(ui.target.querySelector('[data-rest-toggle]')?.textContent?.trim()).toBe('1 without changes');

  page?.set({ view: 'all' });
  expect([...ui.target.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['project folder +2 -0', 'api +2 -0']);
  expect(ui.target.querySelector('[data-rest-toggle]')?.textContent?.trim()).toBe('1 without changes');
});

it('shows every repository the card worked in when nothing waits for a commit anywhere', () => {
  const groups = [
    { repo: '.', changes: clean('.', commitsOf([{ sha: 'dddddddddd', subject: 'Add the list', pushed: true }])), publish: publish('recipe-web') },
    { repo: 'api', changes: clean('api', commitsOf([{ sha: 'cccccccccc', subject: 'Serve the search', pushed: false }])), publish: publish('recipe-api') },
    { repo: 'mail', changes: nothing('mail'), publish: { ok: false as const, reason: 'nothing' } },
  ];
  const ui = draw(groups, { view: 'uncommitted', onview: vi.fn() });

  // A tab with nothing to commit shows no size, because Not committed draws no lines there.
  expect([...ui.target.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['project folder', 'api']);
  expect(ui.target.querySelectorAll('[data-nothing]')).toHaveLength(2);
  expect(ui.target.querySelector('[data-rest-toggle]')?.textContent?.trim()).toBe('1 without changes');
});

it('keeps a typed commit message when a switch of view changes how many repositories show', () => {
  const groups = [
    { repo: '.', changes: changed('.', 'list.ts'), publish: publish('recipe-web') },
    { repo: 'api', changes: { ...(nothing('api') as Extract<Changes, { ok: true }>), diff: { stat: { files: 1, added: 1, removed: 0 }, tree: [leaf('server.ts')] } }, publish: publish('recipe-api') },
  ];
  const ui = draw(groups, { view: 'uncommitted', onview: vi.fn() });
  expect(ui.target.querySelectorAll('[role="tab"]')).toHaveLength(0);
  const box = ui.target.querySelector<HTMLTextAreaElement>('#commit-message')!;
  box.value = 'feat: add the search box';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  page?.set({ view: 'all' });
  expect(ui.target.querySelectorAll('[role="tab"]')).toHaveLength(2);
  page?.set({ view: 'uncommitted' });

  const again = ui.target.querySelector<HTMLTextAreaElement>('#commit-message')!;
  expect(again).toBe(box);
  expect(again.value).toBe('feat: add the search box');
});

it('shows the commits loading while the switch reads them, and the reason when git could not', () => {
  const waiting = { ...(clean('.') as Extract<Changes, { ok: true }>), row: row('.', { changed: 0, ahead: 2 }) };
  const ui = draw([{ repo: '.', changes: waiting, publish: publish('recipe-web') }], { view: 'uncommitted', onview: vi.fn() });

  expect(ui.target.querySelector('[data-nothing]')?.textContent).toBe('Nothing to commit.');
  expect(ui.target.querySelector('[data-skeleton]')?.textContent).toContain('Reading the commits.');

  page?.set({ groups: [{ repo: '.', changes: { ...waiting, commits: { list: [], total: 0, reason: 'The card diff could not be read.' } }, publish: publish('recipe-web') }] });
  expect(ui.target.querySelector('[data-skeleton]')).toBeNull();
  expect(ui.target.textContent).toContain('The card diff could not be read.');
});

it("links the group's open pull request in place of a new one", () => {
  const groups = [two()[0], { ...two()[1], publish: { ...publish('recipe-api'), pull: { number: 4, url: 'https://github.com/example/recipe-api/pull/4' } } }];
  page = mounted(ChangeGroups as never, {
    groups,
    card: 'APP-1',
    onopen: vi.fn(),
    oncommit: vi.fn(),
    onwrite: vi.fn(),
    onpush: vi.fn(),
  });

  expect(page.target.querySelector<HTMLAnchorElement>('[data-repo="api"] [data-open-pull]')?.textContent).toContain('#4');
});
