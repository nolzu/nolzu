import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@nolzu/core/node';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { mounted } from '../../../../packages/ui/test/mounted.svelte.ts';
import { addRepository } from './add-repo.ts';
import { createWorkspace } from './onboard.ts';
import { projectRow, type ProjectRow, removeConfirm, removeConfirmNow, type RemoveConfirm, repoTable, type RepoRow } from './projects.ts';
import ProjectsList from './ProjectsList.svelte';
import { NO_TOASTS, SETTING_TOAST } from './board-page.ts';
import type { AppRow, QaSetup } from './qa-setup.ts';
import { toastStack } from './toast-stack.svelte.ts';

// The page's script, cut down: a submit hands the form to the page's callback, and the test answers
// it with the result it wants. `update` only records what it was asked, as there is no page to reload.
type After = (input: { result: unknown; update: (options?: { reset?: boolean }) => Promise<void> }) => Promise<void> | void;
const posted = vi.hoisted(() => [] as { form: HTMLFormElement; answer: (result: unknown) => Promise<void> }[]);
const updates = vi.hoisted(() => [] as unknown[]);
const cancels = vi.hoisted(() => ({ count: 0 }));
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit: (input: { formElement: HTMLFormElement; formData: FormData; submitter: HTMLElement | null; cancel: () => void }) => After | void) => {
    const on = (event: Event): void => {
      event.preventDefault();
      const after = submit({ formElement: form, formData: new FormData(form), submitter: (event as SubmitEvent).submitter, cancel: () => void (cancels.count += 1) });
      posted.push({ form, answer: async (result) => void (await after?.({ result, update: async (options) => void updates.push(options) })) });
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

// Remove in Settings, Project for real: the row's button opens the typed confirm of the States design,
// and only the exact folder name lets it send the row's form. The confirm comes from the real builder,
// so the fixture cannot drift from what the server hands the page.

beforeAll(() => {
  drawnAt('/settings/project');
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

const facts = { project: 'recipes', folder: '~/nolzu/recipes/web', remote: { host: 'github.com', path: 'recipes-app/web' }, records: true };

const row: ProjectRow = {
  name: 'recipes',
  path: '/home/demo/nolzu/recipes',
  opener: 'Open in Finder',
  ticketSystem: 'local',
  baseBranch: 'main',
  repos: [
    { path: 'web', base: 'main' },
    { path: 'api', base: 'main' },
  ],
  missing: [],
  manifestProblems: [],
  rootRecords: true,
  workspace: true,
  branchTemplate: '{key}-{slug}',
  branchExample: 'APP-4-add-a-search-box-to-the-recipe-list',
  boards: [],
  deliveryFlow: 'pull-request',
  localKeyPrefix: 'APP',
  nextKey: 'APP-4',
  apps: [],
  browser: { servers: [], on: false, chrome: true, problem: null },
  knowledgeDir: null,
  knowledgeFolder: null,
  allowedCommands: [],
  closedCheckouts: 0,
  convert: null,
};

const table: RepoRow[] = [
  { path: 'web', remote: 'github.com/recipes-app/web', base: 'main', onDisk: true, clone: false, remove: true },
  { path: 'api', remote: null, base: 'main', onDisk: true, clone: false, remove: true },
];

// What /api/remove-check answers for each repository, which the dialog asks for as it opens.
const confirms: Record<string, RemoveConfirm> = { web: removeConfirm('web', facts), api: removeConfirm('api', { ...facts, folder: '~/nolzu/recipes/api', remote: null }) };
let answers = confirms;
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => new Response(JSON.stringify(answers[new URL(String(url), 'http://x/').searchParams.get('repo') ?? ''] ?? null)));
});

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  answers = confirms;
  vi.restoreAllMocks();
  posted.length = 0;
  updates.length = 0;
  toastStack.state = NO_TOASTS;
  vi.useRealTimers();
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

function open(drawn: ProjectRow = row, extra: Record<string, unknown> = {}): HTMLElement {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ProjectsList, { target, props: { row: drawn, table, ...extra } }) as Record<string, unknown>;
  flushSync();
  return target;
}

// The streamed parts land a few microtasks after the mount.
async function landed(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
  flushSync();
}

// A press of Remove, then its checks: the dialog opens once they land.
async function pressRemove(page: HTMLElement, repo: string): Promise<HTMLDialogElement> {
  page.querySelector<HTMLButtonElement>(`[data-remove="${repo}"]`)!.click();
  flushSync();
  await landed();
  return page.querySelector<HTMLDialogElement>('dialog[role="alertdialog"]')!;
}

function type(field: HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

it('lists what goes before it asks for the name, and sends nothing until the name is typed', async () => {
  const page = open();
  const sent: FormData[] = [];
  page.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target instanceof HTMLFormElement && event.target.getAttribute('action') === '?/remove') sent.push(new FormData(event.target));
  });

  const dialog = await pressRemove(page, 'web');
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('h2')?.textContent).toBe('Remove repository web');
  expect(dialog.textContent).toContain('From the project recipes. This cannot be undone.');
  // The path is mono inside its sentence, as every path is.
  expect(dialog.querySelector('.lost li')?.textContent).toBe('Deletes the folder ~/nolzu/recipes/web.');
  expect(dialog.querySelector('.lost li code')?.textContent).toBe('~/nolzu/recipes/web');
  expect([...dialog.querySelectorAll('.lost li:nth-child(2) code')].map((found) => found.textContent)).toEqual(['.gitignore', '.nolzu/repositories.json']);
  expect(dialog.querySelector('.kept')?.textContent).toBe('Its knowledge file web/repository.md stays. GitHub keeps recipes-app/web, so you can add it again later.');
  expect(dialog.querySelector('.kept code')?.textContent).toBe('web/repository.md');

  const field = dialog.querySelector<HTMLInputElement>('input')!;
  const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!;
  expect(confirm.disabled).toBe(true);
  type(field, 'we');
  expect(confirm.disabled).toBe(true);
  // Enter in the field submits the confirm's own form, which refuses a name that does not match.
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
  expect(sent).toEqual([]);

  type(field, 'web');
  expect(confirm.disabled).toBe(false);
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();

  expect(sent).toHaveLength(1);
  expect(sent[0]?.get('repo')).toBe('web');
  expect(sent[0]?.get('typed')).toBe('web');
});

// The check pass found work: the confirm shows it in the red box, asks for no name, and Remove stays
// off, so nothing is sent whatever a script submits.
it('keeps Remove off while a check fails, and sends nothing', async () => {
  const found = ["APP-1 has a checkout of web, so web stays. The card's work there would be left out of its changes."];
  answers = { ...confirms, web: removeConfirm('web', facts, found, ['Nothing uncommitted, no stash']) };
  const page = open();
  let posts = 0;
  page.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target instanceof HTMLFormElement && event.target.getAttribute('action') === '?/remove') posts += 1;
  });

  const dialog = await pressRemove(page, 'web');
  expect(dialog.querySelector('.gone')?.textContent).toBe(found[0]);
  expect([...dialog.querySelectorAll('.checked li')].map((line) => line.textContent)).toEqual(['Nothing uncommitted, no stash']);
  expect(dialog.querySelector('input')).toBeNull();
  expect(dialog.querySelector<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(true);
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();

  expect(posts).toBe(0);
});

// Every check holds: the confirm ticks them and then asks for the name.
it('ticks the checks that hold, then asks for the name', async () => {
  answers = { ...confirms, web: removeConfirm('web', facts, [], ['No card has a checkout of it', 'Nothing uncommitted, no stash', 'Every commit is on a remote']) };
  const page = open();

  const dialog = await pressRemove(page, 'web');
  expect(dialog.querySelectorAll('.checked li')).toHaveLength(3);
  expect(dialog.querySelector('.gone')).toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('input')).not.toBeNull();
});

// A folder the manifest names and the disk has not got shows Missing, and its own Clone posts its folder.
it('draws a missing folder with its own Clone, which names the folder', () => {
  const page = open({ ...row, missing: ['mobile'] }, { table: [...table, { path: 'mobile', remote: 'github.com/recipes-app/mobile', base: 'main', onDisk: false, clone: true, remove: false }] });
  const sent: FormData[] = [];
  page.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target instanceof HTMLFormElement && event.target.getAttribute('action') === '?/clone') sent.push(new FormData(event.target));
  });

  const line = [...page.querySelectorAll('tbody tr')].find((one) => one.querySelector('th')?.textContent === 'mobile')!;
  expect(line.textContent).toContain('Missing');
  expect(line.querySelector('[data-remove]')).toBeNull();
  // The other rows are on disk, and have no Clone.
  expect(page.querySelectorAll('[aria-label^="Clone "]')).toHaveLength(1);
  line.querySelector<HTMLButtonElement>('[aria-label="Clone mobile"]')!.click();

  expect(sent.map((form) => form.get('folder'))).toEqual(['mobile']);
});

// The remote column is the one that gives way, so it shows owner/name and keeps the host for the
// title. Two repositories on one host still read apart.
it('shows each remote without its host, and the whole remote as the title', () => {
  const page = open();
  const remotes = [...page.querySelectorAll<HTMLElement>('td.remote')];
  expect(remotes.map((cell) => cell.textContent)).toEqual(['recipes-app/web', 'no remote']);
  expect(remotes[0]!.title).toBe('github.com/recipes-app/web');
});

// A project of 29 repositories kept Settings, Project blank while git named each remote.
// The page draws at once, with a grey row per repository and no count, until the rows land.
it('draws a grey row per repository until the table lands, then the rows and their count', async () => {
  let land: (rows: RepoRow[]) => void = () => {};
  const page = open(row, { table: new Promise<RepoRow[]>((done) => (land = done)) });
  expect(page.querySelectorAll('tbody [data-skeleton]')).toHaveLength(2);
  expect(page.querySelector('#git-title .n')).toBeNull();
  expect(page.querySelector('tbody th')).toBeNull();

  land(table);
  await landed();
  expect(page.querySelector('tbody [data-skeleton]')).toBeNull();
  expect([...page.querySelectorAll('tbody th')].map((one) => one.textContent)).toEqual(['web', 'api']);
  expect(page.querySelector('#git-title .n')?.textContent).toBe('2');
});

// The load runs no Remove checks, so the press of Remove says it checks until the dialog opens.
it('says it checks the repository until the Remove dialog opens', async () => {
  let reply: (response: Response) => void = () => {};
  vi.mocked(fetch).mockImplementation(() => new Promise((done) => (reply = done)));
  const page = open();
  page.querySelector<HTMLButtonElement>('[data-remove="web"]')!.click();
  flushSync();
  expect(page.querySelector('dialog')).toBeNull();
  expect(page.querySelector('[role="status"]')?.textContent).toBe('Checking web for work that is not saved yet.');

  reply(new Response(JSON.stringify(confirms.web)));
  await landed();
  expect(page.querySelector('dialog[role="alertdialog"] h2')?.textContent).toBe('Remove repository web');
  expect(page.textContent).not.toContain('Checking web');
});

// A check that answers nothing opens no dialog, so the Checking line goes and Remove can be pressed again.
it('drops the Checking line when the checks answer nothing', async () => {
  answers = {};
  const page = open();
  await pressRemove(page, 'web');
  expect(page.querySelector('dialog')).toBeNull();
  expect(page.textContent).not.toContain('Checking web');
});

// A check that fails to answer says so under the table, so the press does not look like nothing.
it('says it could not check when the checks fail', async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response('', { status: 500 }));
  const page = open();
  await pressRemove(page, 'web');
  expect(page.querySelector('dialog')).toBeNull();
  expect(page.querySelector('[role="alert"]')?.textContent).toBe('Nolzu could not check web. Press Remove again.');
});

// A Remove changes the list before the new table lands: grey rows stand in, never the removed row.
it('draws grey rows, not the old ones, while the table of a changed list streams', async () => {
  const page = mounted(ProjectsList as never, { row, table: Promise.resolve(table) });
  try {
    await landed();
    expect(page.target.querySelectorAll('tbody th')).toHaveLength(2);

    page.set({ row: { ...row, repos: [{ path: 'web', base: 'main' }] }, table: new Promise<RepoRow[]>(() => {}) });
    expect(page.target.querySelectorAll('tbody th')).toHaveLength(0);
    expect(page.target.querySelectorAll('tbody [data-skeleton]')).toHaveLength(1);
  } finally {
    page.remove();
  }
});

// Each row has its own form. The confirm of the second row sends that row's form, so typing api never
// removes web.
it('sends the form of the repository whose confirm was typed, not the first row', async () => {
  const page = open();
  const sent: FormData[] = [];
  page.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target instanceof HTMLFormElement && event.target.getAttribute('action') === '?/remove') sent.push(new FormData(event.target));
  });

  const dialog = await pressRemove(page, 'api');
  type(dialog.querySelector<HTMLInputElement>('input')!, 'api');
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();

  expect(sent.map((form) => [form.get('repo'), form.get('typed')])).toEqual([['api', 'api']]);
});

it('closes on Cancel and sends nothing', async () => {
  const page = open();
  let posts = 0;
  page.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target instanceof HTMLFormElement && event.target.getAttribute('action') === '?/remove') posts += 1;
  });

  await pressRemove(page, 'api');
  expect(page.querySelector('dialog .kept')?.textContent).toBe('Its knowledge file api/repository.md stays.');
  [...page.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent?.trim().startsWith('Cancel'))!.click();
  flushSync();

  expect(page.querySelector('dialog')).toBeNull();
  expect(posts).toBe(0);
});

// The row the server builds for a real workspace, so the page and the confirms of projectRow cannot
// drift apart. Without a confirm for a repository, its Remove button opens nothing.
it('opens the confirm the server built for a real clone, with the remote its origin names', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nolzu-projects-list-'));
  vi.stubEnv('HOME', home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', args, { env, encoding: 'utf8' });
  const db = openDatabase(join(home, 'data'));
  try {
    git('init', '-q', '-b', 'main', join(home, 'src'));
    writeFileSync(join(home, 'src', 'package.json'), '{}\n');
    git('-C', join(home, 'src'), 'add', '-A');
    git('-C', join(home, 'src'), 'commit', '-q', '-m', 'first');
    git('clone', '-q', '--bare', join(home, 'src'), join(home, 'web.git'));
    const made = await createWorkspace(db, { parent: home, name: 'recipes', home, env });
    if (!made.ok) throw new Error(made.reason);
    await addRepository(db, 'https://github.com/recipes-app/web.git', env, async ({ workspace }) => {
      git('clone', '-q', join(home, 'web.git'), join(workspace, 'web'));
      return { ok: true, name: 'web', path: join(workspace, 'web') };
    });
    git('-C', join(made.path, 'web'), 'remote', 'set-url', 'origin', 'https://github.com/recipes-app/web.git');

    const real = await projectRow(db);
    const web = await removeConfirmNow(db, 'web');
    expect(web?.lost).toEqual([
      { text: 'Deletes the folder ~/recipes/web.', code: '~/recipes/web' },
      { text: 'Takes web out of .gitignore and .nolzu/repositories.json, and commits that.', code: ['.gitignore', '.nolzu/repositories.json'] },
    ]);

    answers = { web: web! };
    const page = open(real, { table: await repoTable(db) });
    await pressRemove(page, 'web');
    expect(page.querySelector('dialog h2')?.textContent).toBe('Remove repository web');
    expect(page.querySelector('dialog .kept')?.textContent).toBe('Its knowledge file web/repository.md stays. GitHub keeps recipes-app/web, so you can add it again later.');
  } finally {
    db.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// QA's browser has its own row after the stack hook, so a person finds it.
it('offers to set up a browser, and greys the button out without Chrome', () => {
  const browser = () => target!.querySelector<HTMLElement>('#browser')!;
  const words = () => browser().textContent?.replace(/\s+/g, ' ');
  const setUp = () => [...browser().querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Set up a browser')!;
  open();
  expect(target!.querySelector('#app + #browser .lb > span')?.textContent).toBe('QA browser');
  expect(words()).toContain('QA has no browser, so a card that changes a page ends with a question to you.');
  expect(setUp().closest('form')?.getAttribute('action')).toBe('?/browserSetup');
  expect(setUp().disabled).toBe(false);
  void unmount(instance!);
  target?.remove();

  open({ ...row, browser: { ...row.browser, chrome: false } });
  expect(words()).toContain('Google Chrome is not installed, so QA has no browser. Install it and come back.');
  expect(setUp().disabled).toBe(true);
});

it('shows the servers QA gets with Test the browser and Turn off once one is on', () => {
  open({ ...row, browser: { servers: ['playwright'], on: true, chrome: true, problem: null } });
  const browser = target!.querySelector<HTMLElement>('#browser')!;
  expect(browser.querySelector('.mono')?.textContent).toBe('playwright');
  expect(browser.textContent).toContain('on for QA');
  expect(browser.textContent).toContain('Settings, MCP servers');
  const actions = [...browser.querySelectorAll('form')].map((form) => form.getAttribute('action'));
  expect(actions).toEqual(['?/browserTest', '?/browserOff']);
  // The Start the app forms have no browser box.
  expect(target!.querySelector('#app input[name="browser"]')).toBeNull();
});

// Start the app: one short line per repository, with Edit, and Ask again only where there is an answer.
const SETUP: QaSetup = { project: 'web', repo: 'web', dev: { command: 'npm run dev', repo: 'web' }, scripts: 'dev: vite', unwalled: null, address: '', test: null, playwright: false, chrome: false, browser: false };
const appRow = (repo: string, answer: AppRow['answer'], words: string): AppRow => ({ repo, answer, words, setup: { ...SETUP, repo, dev: repo === '*' ? null : { command: 'npm run dev', repo } } });

it('says how QA gets the app, with Ask again once it was answered', () => {
  expect(open().querySelector('[data-qa-app]')?.textContent).toBe('The first card that enters QA asks how QA gets the app.');
  void unmount(instance!);
  target?.remove();

  const page = open({ ...row, apps: [appRow('web', { mode: 'running', address: 'http://localhost:5173' }, 'already running at localhost:5173')] });
  const form = page.querySelector<HTMLFormElement>('form[data-qa-app]');
  expect(form?.getAttribute('action')).toBe('?/qa');
  expect(form?.querySelector('button')?.textContent?.trim()).toBe('Ask again');
});

it('draws one line per repository with its answer in a few words', () => {
  const page = open({
    ...row,
    apps: [
      appRow('*', { mode: 'own', start: 'docker compose up -d', stop: null, status: null }, 'own commands: docker compose up -d'),
      appRow('api', null, 'same as every repository'),
      appRow('web', { mode: 'dev', command: 'npm run dev', repo: 'web' }, 'npm run dev'),
    ],
  });
  expect(page.querySelector('#app .lb > span')?.textContent).toBe('Start the app');
  const lines = [...page.querySelectorAll('[data-app-row]')].map((one) => one.querySelector('.line')?.textContent?.replace(/\s+/g, ' ').trim());
  expect(lines).toEqual(['Every repository own commands: docker compose up -d Ask again', 'api same as every repository', 'web npm run dev Ask again']);
  // Ask again on a row clears that row's answer only.
  const clear = page.querySelector<HTMLFormElement>('[data-app-row="web"] form[action="?/qaClear"]')!;
  expect(Object.fromEntries(new FormData(clear))).toEqual({ repo: 'web' });
  expect(page.querySelector('[data-app-row="api"] form[action="?/qaClear"]')).toBeNull();
});

// Edit opens the four choices of the question at the first QA, and Save posts that row's answer.
it('edits one repository with the four choices of the question and posts them for that repository', () => {
  const page = open({ ...row, apps: [appRow('web', null, 'asked at the first QA')] });
  const edit = page.querySelector<HTMLElement>('[data-app-row="web"] details')!;
  expect(edit.querySelector('summary')?.getAttribute('aria-label')).toBe('Edit how QA starts web');
  expect([...edit.querySelectorAll<HTMLInputElement>('[data-choice]')].map((one) => one.value)).toEqual(['dev', 'running', 'own', 'code']);

  edit.querySelector<HTMLInputElement>('[data-choice="own"]')!.click();
  flushSync();
  const start = edit.querySelector<HTMLInputElement>('[data-own="start"]')!;
  start.value = 'docker compose up -d';
  start.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  const form = edit.querySelector<HTMLFormElement>('form[action="?/qaRepo"]')!;
  expect(Object.fromEntries(new FormData(form))).toMatchObject({ repo: 'web', choice: 'own', start: 'docker compose up -d', stop: '', status: '' });
});

// Docker and its kin need their daemon's socket, which the wall closes, so the list says where they go.
it('says under the commands that runs cannot reach Docker, only when one is listed', () => {
  expect(open().querySelector('[data-docker-note]')).toBeNull();
  void unmount(instance!);
  target?.remove();

  const page = open({ ...row, allowedCommands: ['npm test', 'docker compose *'] });
  expect(page.querySelector('[data-docker-note]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Runs cannot reach Docker: the wall closes its socket, because Docker can write anywhere on this machine. Start containers with your own commands under Start the app, which Nolzu runs outside the wall when a card enters QA.',
  );
});

// The Tickets line: the system in words, and Change with the one other choice worded as what a press
// does. The login is on Settings, Integrations, so the box holds no Jira fields.
it('draws the ticket system on one line with Change', () => {
  let page = open();
  const system = () => page.querySelector('[data-ticket-system]');
  const words = () => system()?.textContent?.replace(/\s+/g, ' ') ?? '';
  expect(words()).toContain('Ticket system Only local cards');
  expect(words()).toContain("Local cards work either way: a key with this project's prefix is always a local card.");
  // Change opens under the line, not beside it.
  expect(system()?.querySelector('.line details')).toBeNull();
  // Nothing to switch to before Jira is connected, so Change says where the login is.
  expect(system()?.querySelector('form')).toBeNull();
  expect(system()?.querySelector('a')?.getAttribute('href')).toContain('settings/integrations');
  expect(page.querySelector('#jira-token')).toBeNull();

  void unmount(instance!);
  target?.remove();
  page = open({ ...row, ticketSystem: 'jira', jira: { site: 'https://you.atlassian.net', email: 'dana@example.com' } });
  expect(words()).toContain('Ticket system Read from Jira at you.atlassian.net');
  expect(system()?.querySelector('summary')?.textContent?.trim()).toBe('Change');
  expect(system()?.querySelector('form button')?.textContent?.trim()).toBe('Stop reading Jira in this project');
  expect(system()?.querySelector<HTMLInputElement>('input[name="value"]')?.value).toBe('local');

  void unmount(instance!);
  target?.remove();
  page = open({ ...row, ticketSystem: 'local', jira: { site: 'https://you.atlassian.net', email: 'dana@example.com' } });
  expect(system()?.querySelector('form button')?.textContent?.trim()).toBe('Read Jira in this project');
  expect(system()?.querySelector<HTMLInputElement>('input[name="value"]')?.value).toBe('jira');

  void unmount(instance!);
  target?.remove();
  // After Disconnect a project can still read Jira, and says the login is gone.
  page = open({ ...row, ticketSystem: 'jira', jira: { site: null, email: null } });
  expect(words()).toContain('Read from Jira, which is not connected on this machine');
  expect(system()?.querySelector('form button')?.textContent?.trim()).toBe('Stop reading Jira in this project');

  void unmount(instance!);
  target?.remove();
  // A site with no email is no login, so nothing offers a switch the server would refuse.
  page = open({ ...row, ticketSystem: 'local', jira: { site: 'https://you.atlassian.net', email: null } });
  expect(system()?.querySelector('form')).toBeNull();
  expect(system()?.querySelector('a')?.getAttribute('href')).toContain('settings/integrations');
});

// The warning on the prefix row while the project reads Jira and Jira has a project with that key.
it('warns on the prefix row when Jira has a project with the prefix, and only then', () => {
  const clash = { prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WRK' };
  let page = open({ ...row, localKeyPrefix: 'WORK', ticketSystem: 'jira', jira: { site: clash.site, email: 'dana@example.com' }, keyClash: clash });
  expect(page.querySelector('[data-warning="localKeyPrefix"]')?.textContent).toBe(
    'WORK is also a Jira project at you.atlassian.net. Jira tickets such as WORK-12 cannot be added while local cards use WORK. Pick another prefix, such as WRK.',
  );
  // One press saves the free prefix.
  const use = page.querySelector<HTMLFormElement>('[data-use-prefix]')!;
  expect(Object.fromEntries(new FormData(use))).toEqual({ field: 'localKeyPrefix', value: 'WRK' });
  expect(use.textContent?.trim()).toBe('Use WRK');

  void unmount(instance!);
  target?.remove();
  page = open({ ...row, localKeyPrefix: 'WORK', ticketSystem: 'jira', jira: { site: clash.site, email: 'dana@example.com' }, keyClash: { ...clash, suggestion: null } });
  expect(page.querySelector('[data-warning="localKeyPrefix"]')?.textContent).toMatch(/Pick another prefix\.$/);
  expect(page.querySelector('[data-use-prefix]')).toBeNull();

  void unmount(instance!);
  target?.remove();
  // A project that stopped reading Jira has no clash to warn about, and neither has one Jira was not asked for.
  page = open({ ...row, localKeyPrefix: 'WORK', ticketSystem: 'local', jira: { site: clash.site, email: 'dana@example.com' }, keyClash: clash });
  expect(page.querySelector('[data-warning]')).toBeNull();
  void unmount(instance!);
  target?.remove();
  page = open({ ...row, ticketSystem: 'jira', jira: { site: clash.site, email: 'dana@example.com' }, keyClash: null });
  expect(page.querySelector('[data-warning]')).toBeNull();
  // With no clash the hint asks for a free prefix, a space after the key's full stop.
  expect(page.querySelector('#localKeyPrefix-help')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'The next card is APP-4. Pick a prefix no Jira project uses, because a key with this prefix reads as a local card.',
  );
});

// The base branch picks from origin's branches and Save posts the pick. A pick alone posts nothing,
// because arrow keys step a select one branch at a time and each post reloads the page. A stored base
// origin does not list stays first and selected, and a row with no remote branches keeps the typed box.
// git answers after the page drew, so a grey line holds each box's place until then.
it('draws the base branch as a select of origin branches that Save posts', async () => {
  let answer: (map: Record<string, string[]>) => void = () => {};
  const page = open(row, { table: [{ ...table[0]!, base: 'release' }, table[1]!], branches: new Promise((done) => (answer = done)) });
  expect(page.querySelector('form [data-skeleton]')?.getAttribute('data-shape')).toBe('line');
  expect(page.querySelector('select[aria-label="Base branch of web"]')).toBeNull();
  answer({ web: ['develop', 'main'], api: [] });
  await landed();
  expect(page.querySelector('form [data-skeleton]')).toBeNull();
  const sent: FormData[] = [];
  page.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target instanceof HTMLFormElement) sent.push(new FormData(event.target));
  });

  const select = page.querySelector<HTMLSelectElement>('select[aria-label="Base branch of web"]')!;
  expect([...select.options].map((option) => option.value)).toEqual(['release', 'develop', 'main']);
  expect(select.value).toBe('release');
  expect(page.querySelector('input[aria-label="Base branch of api"]')).not.toBeNull();

  select.value = 'develop';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  expect(sent).toEqual([]);
  select.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  flushSync();
  expect(sent.map((one) => [one.get('field'), one.get('value')])).toEqual([['repoBase:web', 'develop']]);
});

it('lists the repositories found on this machine, each with its own Add by the remote', async () => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ProjectsList, { target, props: { row, found: Promise.resolve([{ path: '~/code/recipes-scripts', url: 'https://github.com/recipes-app/recipes-scripts.git' }]) } }) as Record<string, unknown>;
  flushSync();
  // A grey line in the list's place while the scan of the home folder runs.
  expect(target.querySelector('.found [data-skeleton]')).not.toBeNull();
  await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
  flushSync();

  expect(target.textContent).toContain('Or pick one found on this machine');
  const add = target.querySelector<HTMLButtonElement>('button[aria-label="Add ~/code/recipes-scripts"]')!;
  const form = add.closest('form')!;
  expect(form.getAttribute('action')).toBe('?/add');
  expect(new FormData(form).get('url')).toBe('https://github.com/recipes-app/recipes-scripts.git');
});

// With JavaScript a save posts in place: the page stays where it is, the boxes keep what was typed, and
// the answer is a toast. The toast host closes it with its bar, so no timer here takes it away.
it('saves in place and says Saved in a toast, with no timer of its own', async () => {
  vi.useFakeTimers();
  const page = open();
  const box = page.querySelector<HTMLInputElement>('#branchTemplate')!;
  box.value = '{key}';
  box.form!.requestSubmit();

  expect(posted.map((one) => new FormData(one.form).get('field'))).toEqual(['branchTemplate']);
  await posted[0]!.answer({ type: 'success', status: 200, data: { field: 'branchTemplate', saved: true } });
  flushSync();

  expect(updates).toEqual([{ reset: false }]);
  expect(box.isConnected).toBe(true);
  expect(box.value).toBe('{key}');
  expect(toastStack.state.toasts).toMatchObject([{ kind: 'success', card: { key: SETTING_TOAST }, title: 'Saved.' }]);
  expect(toastStack.state.toasts[0]?.card.href).toBeUndefined();
  vi.advanceTimersByTime(60_000);
  expect(toastStack.state.toasts).toHaveLength(1);
});

// With JavaScript the toast says Saved, so the line at the foot, which stays, is not drawn.
it('leaves out the Saved line at the foot once the page runs', () => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ProjectsList, { target, props: { row, saved: 'branchTemplate' } }) as Record<string, unknown>;
  flushSync();

  expect(target.querySelector('p.said')).toBeNull();
});

// A refusal is an error toast, which the toast host keeps the longer time; nothing here closes it. The
// sentence under the field comes from the page's `form`, which this mount does not pass, so the route
// test covers that line.
it('says a refusal in an error toast, with no timer of its own', async () => {
  vi.useFakeTimers();
  const page = open();
  page.querySelector<HTMLInputElement>('#localKeyPrefix')!.form!.requestSubmit();
  await posted[0]!.answer({ type: 'failure', status: 400, data: { field: 'localKeyPrefix', typed: 'a', message: 'A prefix is 2 to 10 letters.' } });
  vi.advanceTimersByTime(6000);

  expect(toastStack.state.toasts).toMatchObject([{ kind: 'error', refused: true, title: 'A prefix is 2 to 10 letters.' }]);
});

// The page's answer is only the newest post's, so a save in another form must not take a refusal off the
// screen. The refused form's own save does.
it('keeps a refusal and its typed value when another form saves', async () => {
  const page = mounted(ProjectsList as never, { row, refused: { field: 'localKeyPrefix', message: 'A prefix is 2 to 10 letters.', typed: 'a' } } as never);
  const prefix = () => page.target.querySelector<HTMLInputElement>('#localKeyPrefix')!;
  const said = () => prefix().form!.querySelector('.refused')?.textContent ?? null;
  try {
    page.target.querySelector<HTMLInputElement>('#branchTemplate')!.form!.requestSubmit();
    await posted[0]!.answer({ type: 'success', status: 200, data: { field: 'branchTemplate', saved: true } });
    page.set({ refused: null } as never);
    expect(prefix().value).toBe('a');
    expect(said()).toBe('A prefix is 2 to 10 letters.');

    prefix().form!.requestSubmit();
    await posted[1]!.answer({ type: 'success', status: 200, data: { field: 'localKeyPrefix', saved: true } });
    page.set({ saved: 'localKeyPrefix' } as never);
    expect(prefix().value).toBe('APP');
    expect(said()).toBeNull();
  } finally {
    page.remove();
  }
});

// An Add box empties once its entry is in the list, and keeps a refused entry for the reason.
it('empties the Add box after an add that worked', async () => {
  const page = open();
  const box = page.querySelector<HTMLInputElement>('#addCommand')!;
  box.value = 'pnpm e2e';
  box.form!.requestSubmit();
  await posted[0]!.answer({ type: 'failure', status: 400, data: { field: 'addCommand', typed: 'pnpm e2e', message: 'No.' } });
  expect(box.value).toBe('pnpm e2e');
  box.form!.requestSubmit();
  await posted[1]!.answer({ type: 'success', status: 200, data: { field: 'addCommand', saved: true } });

  expect(box.value).toBe('');
});

// A stray click on the backdrop closes the confirm. The name typed so far waits for the next open of
// the same repository, and goes once it is sent.
it('keeps the typed name when the backdrop closes the confirm', async () => {
  const page = open();
  const opened = (repo: string): Promise<HTMLDialogElement> => pressRemove(page, repo);
  // jsdom lays nothing out, so the box is given a place before the press outside it.
  const backdrop = (dialog: HTMLDialogElement): void => {
    dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200, x: 100, y: 100, toJSON: () => ({}) });
    dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));
    flushSync();
  };

  let dialog = await opened('web');
  type(dialog.querySelector<HTMLInputElement>('input')!, 'we');
  backdrop(dialog);
  expect(page.querySelector('dialog[role="alertdialog"]')).toBeNull();

  dialog = await opened('web');
  expect(dialog.querySelector<HTMLInputElement>('input')!.value).toBe('we');
  backdrop(dialog);
  // Another repository's confirm starts empty.
  dialog = await opened('api');
  expect(dialog.querySelector<HTMLInputElement>('input')!.value).toBe('');
  backdrop(dialog);

  dialog = await opened('web');
  type(dialog.querySelector<HTMLInputElement>('input')!, 'web');
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
  expect(posted.filter((one) => one.form.getAttribute('action') === '?/remove')).toHaveLength(1);
});

// A refused Remove closes the confirm, so the sentence under the row is what the person reads next.
// The confirm opened again is not held, so it can send again.
it('closes the remove confirm when the answer comes back', async () => {
  const page = open();
  const confirmRemove = async (): Promise<void> => {
    const dialog = await pressRemove(page, 'web');
    type(dialog.querySelector<HTMLInputElement>('input')!, 'web');
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();
  };
  const removes = () => posted.filter((one) => one.form.getAttribute('action') === '?/remove');
  await confirmRemove();
  await removes()[0]!.answer({ type: 'failure', status: 400, data: { field: 'remove:web', message: 'web has a checkout.' } });
  flushSync();

  expect(page.querySelector('dialog[role="alertdialog"]')).toBeNull();
  await confirmRemove();
  expect(removes()).toHaveLength(2);
});

// A newer save's toast takes the older one's place, and an answer that is no save says nothing.
it('puts a newer Saved toast in place of the older one, and raises none for a server error', async () => {
  const box = open().querySelector<HTMLInputElement>('#branchTemplate')!;
  box.form!.requestSubmit();
  await posted[0]!.answer({ type: 'success', status: 200, data: { field: 'branchTemplate', saved: true } });
  const first = toastStack.state.toasts[0];
  box.form!.requestSubmit();
  await posted[1]!.answer({ type: 'success', status: 200, data: { field: 'branchTemplate', saved: true } });
  expect(toastStack.state.toasts).toHaveLength(1);
  expect(toastStack.state.toasts[0]).not.toBe(first);
  toastStack.state = NO_TOASTS;

  box.form!.requestSubmit();
  await posted[2]!.answer({ type: 'error', status: 500, error: new Error('down') });
  expect(toastStack.state.toasts).toEqual([]);
});

// The answer of Add a repository offers Learn this project for the new repository, one click and never
// by itself.
it('offers Learn this project for the repository Add cloned, and says where its questions wait', () => {
  const page = mounted(ProjectsList as never, { row, said: { field: 'add', text: 'Added api, starting from main.', learn: 'api' } } as never);
  try {
    const form = page.target.querySelector<HTMLFormElement>('form[action="?/learn"]');
    expect(form?.querySelector<HTMLInputElement>('input[name="repo"]')?.value).toBe('api');
    expect(form?.querySelector('button.go')?.textContent?.trim()).toBe('Learn api');
    page.set({ said: { field: 'learn', text: 'Learn this project is reading what people wrote, starting with api.' } } as never);
    expect(page.target.querySelector('form[action="?/learn"]')).toBeNull();
    expect([...page.target.querySelectorAll('a')].find((link) => link.textContent === 'Open Knowledge')?.getAttribute('href')).toMatch(/\/knowledge$/);
  } finally {
    page.remove();
  }
});

// The status line of the notice in the app, under Write the project files, with the hand edits by name.
it('says under Write the project files what an update would do and which files are yours', async () => {
  const yours = ['.claude/skills/nolzu-plan/SKILL.md', '.agents/skills/nolzu-qa/SKILL.md'];
  const handEdits = yours.map((path) => ({ path, patch: '@@ -1 +1 @@\n-Plan.\n+Mine.\n', gone: false, unsaved: false }));
  const page = open(row, { filesStatus: { updates: ['AGENTS.md'], yours, newer: null }, handEdits: Promise.resolve(handEdits) });
  // git makes each diff, so the files land after the page drew.
  expect(page.querySelector('#files [data-waiting] [data-skeleton]')).not.toBeNull();
  await landed();

  expect(page.querySelector('[data-files-status]')?.textContent).toBe('Nolzu has newer project files for this project.');
  expect(page.querySelector('[data-files-yours]')?.textContent).toBe('2 files were changed by hand and kept your text.');
  expect([...page.querySelectorAll('[data-hand-edit]')].map((one) => one.getAttribute('data-hand-edit'))).toEqual(yours);
  // Each file's forms sit beside the form of Write the project files, never in it.
  expect(page.querySelector('form[action="?/files"] [data-hand-edit]')).toBeNull();
  // The notice in the app links to #files, so the hand edits must sit in that section.
  expect(page.querySelectorAll('#files [data-hand-edit]')).toHaveLength(2);
});

it('says a newer Nolzu wrote the files, and nothing with no status', () => {
  const newer = 'These project files come from Nolzu 9.0.0, newer than this Nolzu 1.0.0. Update Nolzu.';
  expect(open(row, { filesStatus: { updates: ['AGENTS.md'], yours: [], newer } }).querySelector('[data-files-status]')?.textContent).toBe(newer);
  void unmount(instance!);
  instance = null;
  target?.remove();

  // A press of Write the project files is refused with the same sentence, which shows once, as the refusal.
  const refusedPage = open(row, { filesStatus: { updates: [], yours: [], newer }, refused: { field: 'files', message: newer } });
  expect(refusedPage.querySelector('[data-files-status]')).toBeNull();
  expect([...refusedPage.querySelectorAll('.refused')].map((one) => one.textContent)).toEqual([newer]);
  void unmount(instance!);
  instance = null;
  target?.remove();

  const page = open();
  expect(page.querySelector('[data-files-status]')).toBeNull();
  expect(page.querySelector('[data-files-yours]')).toBeNull();
});

// A commit made after the page loaded counts, so the dialog asks for the checks again
// as it opens and shows what they find now.
it('runs the Remove checks again as the dialog opens', async () => {
  const tag = 'The tag web-local of web is on no remote, so web stays. Push it with git push origin web-local, or delete it.';
  const asked: string[] = [];
  const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(removeConfirm('web', facts, [tag])));
  });
  try {
    const page = open();
    page.querySelector<HTMLButtonElement>('[data-remove="web"]')!.click();
    flushSync();
    await landed();
    const dialog = page.querySelector<HTMLDialogElement>('dialog[role="alertdialog"]')!;
    expect(asked).toEqual(['../api/remove-check?repo=web']);
    expect(dialog.querySelector('.gone')?.textContent).toContain(tag);
    // The check that fails keeps the name box away.
    expect(dialog.querySelector('input')).toBeNull();
  } finally {
    fetching.mockRestore();
  }
});

// The refusal of a row spans the table under that row, with the git command as code,
// and not one word per line in the last cell.
it('puts a refused Remove under its row, the full width, with the command as code', () => {
  const message = 'The tag web-local of web is on no remote, so web stays. Push it with git push origin web-local, or delete it.';
  const page = open(row, { refused: { field: 'remove:web', message } });

  const note = page.querySelector('tr.note')!;
  expect(note.previousElementSibling?.querySelector('th')?.textContent).toBe('web');
  expect(note.querySelector('td')?.getAttribute('colspan')).toBe('5');
  expect(note.textContent?.trim()).toBe(message);
  expect(note.querySelector('code')?.textContent).toBe('git push origin web-local');
  expect(page.querySelector('td.acts .refused')).toBeNull();
});

// A form on its way takes no second press, and its button says it is busy: Scan again reads every
// folder, and Clone or Learn would start twice.
it('holds a form while it is on its way, with its button busy, and lets go on the answer', async () => {
  const before = cancels.count;
  const target = open();
  const scan = target.querySelector<HTMLButtonElement>('form button[type="submit"]')!;

  scan.click();
  flushSync();
  expect(scan.getAttribute('aria-busy')).toBe('true');
  scan.click();
  flushSync();
  expect(cancels.count).toBe(before + 1);

  await posted.at(-2)!.answer({ type: 'success', data: {} });
  expect(scan.hasAttribute('aria-busy')).toBe(false);
  scan.click();
  expect(cancels.count).toBe(before + 1);
});
