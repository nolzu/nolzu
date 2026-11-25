import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { proposePrefix } from '@nolzu/core';
import { ENGINE_INSTALLS } from '@nolzu/runner';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../test/stubs/app-paths.ts';

// The runner's clone takes https and ssh only, so this one maps https://example.com/team/<name>.git
// onto a local bare repository under the temp home and clones it with git's own progress. The engine
// and gh checks answer that nothing is there, so no test starts a real tool. The PATH scan finds claude
// unless a test empties it, so the New project form shows.
const scan = vi.hoisted(() => ({ found: ['claude-code'] }));
// The wall probe's answer, so no test runs the real one. Ready unless a test says otherwise.
const BWRAP = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
const walls = vi.hoisted(() => ({ here: { ready: true, binary: '/usr/bin/sandbox-exec' } as { ready: true; binary: string } | { ready: false; reason: string } }));
// Set by a test, it runs while the workspace waits on git for the author, which is when a page load can
// come in, and git then answers that it has no author.
const gitWait = vi.hoisted(() => ({ during: null as (() => void) | null }));
vi.mock('@nolzu/runner', async (real) => {
  const runner = await real<typeof import('@nolzu/runner')>();
  const { cloneInto } = await import('../../../../../packages/runner/src/git/clone-into.ts');
  const { join: joined } = await import('node:path');
  return {
    ...runner,
    git: async (args: readonly string[], options: import('@nolzu/runner').GitOptions) => {
      if (args[0] !== 'var' || gitWait.during === null) return runner.git(args, options);
      gitWait.during();
      return { code: 128, stdout: '', stderr: 'Author identity unknown' };
    },
    loginShellPath: () => '',
    enginesOnPath: () => scan.found,
    wallHere: () => walls.here,
    runVersion: () => async () => ({ code: null, stdout: '', missing: true }),
    // Put on GitHub never reaches the real gh from a test.
    ghRunner: () => async () => {
      throw new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.');
    },
    cloneRepository: async (options: import('@nolzu/runner').CloneOptions) => {
      const target = runner.cloneTarget(options.url, options.taken);
      if (!target.ok) return target;
      const url = joined(process.env.HOME ?? '', 'remotes', `${target.name}.git`);
      return cloneInto({ workspace: options.workspace, url, name: target.name, env: options.env, signal: options.signal, onProgress: options.onProgress, protocols: 'file' });
    },
  };
});

// The hub link is told once a later project has its folder, so the hub gets it without a restart.
const hub = vi.hoisted(() => ({ changed: vi.fn() }));
vi.mock('$lib/hub-link.ts', async (real) => ({ ...(await real<object>()), hubProjectsChanged: hub.changed }));
// Open the folder never starts the real file manager from a test.
const reveal = vi.hoisted(() => ({ project: vi.fn((): string | null => null) }));
vi.mock('$lib/projects.ts', async (real) => ({ ...(await real<object>()), revealProject: reveal.project }));

// Add card's route asks the loop only for its database and its change signal, so the server's own
// connection to the same data folder stands in, and no scheduler starts.
vi.mock('$lib/loop.ts', async () => {
  const { database } = await import('$lib/db.ts');
  return { loop: () => ({ db: database(), changed: () => undefined }) };
});

const dir = mkdtempSync(join(tmpdir(), 'nolzu-new-route-'));
const home = mkdtempSync(join(tmpdir(), 'nolzu-new-home-'));
process.env.NOLZU_DATA_DIR = dir;
const before = { ...process.env };
Object.assign(process.env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

const { actions, load } = await import('./+page.server.ts');
const { default: Page } = await import('./+page.svelte');
const { cloneJobs } = await import('$lib/add-repo.ts');
const task = await import('./task/+page.server.ts');
const { default: TaskPage } = await import('./task/+page.svelte');
const cardsRoute = await import('../api/cards/+server.ts');
const { database } = await import('$lib/db.ts');

type Loaded = { made: import('$lib/new-project.ts').NewProject | null; first: boolean; machine: Promise<import('$lib/new-project.ts').MachineRepo[]> };
const loaded = async () => (await load({} as never)) as unknown as Loaded;
const post = (body: Record<string, string>) => ({ request: new Request('http://localhost/new', { method: 'POST', body: new URLSearchParams(body) }) });
type Answer = { status?: number; data?: { message: string; name?: string; folder?: string }; cloning?: string; removed?: string };
const act = async (name: keyof typeof actions, body: Record<string, string> = {}) => (await actions[name]!(post(body) as never)) as Answer;
const url = (name: string) => `https://example.com/team/${name}.git`;
const at = (...parts: string[]) => join(home, ...parts);
const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { env: process.env, encoding: 'utf8' }).trim();
const setting = <K extends 'projectPath' | 'repos' | 'onboarding' | 'workspace' | 'localKeyPrefix' | 'offBoards' | 'gettingStarted' | 'currentProject' | 'setupSteps'>(key: K) => {
  const db = openDatabase(dir);
  try {
    return getSetting(db, key);
  } finally {
    db.close();
  }
};
// A setting of the current project, which the routes read, where `setting` reads the first project.
const current = <K extends 'projectPath' | 'repos' | 'offBoards' | 'onboarding'>(key: K) => getSetting(database(), key);
const write = <K extends 'onboarding' | 'offBoards' | 'gettingStarted' | 'currentProject'>(key: K, value: Parameters<typeof writeSetting<K>>[2]) => {
  const db = openDatabase(dir);
  try {
    writeSetting(db, key, value);
  } finally {
    db.close();
  }
};
const rows = (sql: string) => {
  const db = openDatabase(dir);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
};
// A redirect is thrown, by a load and by an action alike.
const thrownBy = async (work: () => unknown) => {
  try {
    await work();
  } catch (thrown) {
    return thrown;
  }
  return null;
};
const taskLoaded = () => task.load({} as never) as unknown as import('$lib/new-project.ts').FirstTask & { setup: import('@nolzu/protocol').SetupStep[] };
const card = async (body: Record<string, string>) => (await thrownBy(() => task.actions.card!({ request: new Request('http://localhost/new/task', { method: 'POST', body: new URLSearchParams(body) }) } as never))) ?? null;
// The answer of a first task action, or the redirect it threw.
const taskAct = async (name: 'key' | 'reveal' | 'skip', body: Record<string, string> = {}): Promise<unknown> => {
  try {
    return await task.actions[name]!({ request: new Request('http://localhost/new/task', { method: 'POST', body: new URLSearchParams(body) }) } as never);
  } catch (thrown) {
    return thrown;
  }
};
const cardAnswer = async (body: Record<string, string>) => (await task.actions.card!({ request: new Request('http://localhost/new/task', { method: 'POST', body: new URLSearchParams(body) }) } as never)) as Answer;
const addCard = (title: string) => cardsRoute.POST({ request: new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify({ input: '', title }) }) } as never) as Promise<Response>;
const until = async (check: () => boolean) => {
  for (let tries = 0; !check() && tries < 500; tries += 1) await wait(10);
  expect(check()).toBe(true);
};
const page = (data: Record<string, unknown>, form: unknown = null) =>
  render(Page as never, { props: { data: { display: FREE, engines: Promise.resolve([]), gh: Promise.resolve({ found: false, signedIn: false, account: null }), ...data }, form } } as never).body;
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// A bare repository on main, the way a hosted one looks, and `~/code/web` as a person's own clone of
// web with an https origin, the way the machine scan finds it.
beforeEach(() => {
  drawnAt('/new');
  rmSync(at('remotes'), { recursive: true, force: true });
  for (const name of ['api', 'web']) {
    const source = at('sources', name);
    if (!existsSync(source)) {
      execFileSync('git', ['init', '-q', '-b', 'main', source], { env: process.env });
      writeFileSync(join(source, 'package.json'), '{}\n');
      git(source, 'add', '-A');
      git(source, 'commit', '-q', '-m', 'first');
    }
    execFileSync('git', ['clone', '-q', '--bare', source, at('remotes', `${name}.git`)], { env: process.env });
  }
  if (!existsSync(at('code', 'web'))) {
    execFileSync('git', ['clone', '-q', at('remotes', 'web.git'), at('code', 'web')], { env: process.env });
    git(at('code', 'web'), 'remote', 'set-url', 'origin', url('web'));
  }
});

afterAll(() => {
  process.env = before;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The tests below run in order on one data folder: refused before anything is made, then the
// workspace and two repositories, then Remove, then Make the project.
it('makes nothing for a refused URL, and refuses Make the project with no repository', async () => {
  mkdirSync(at('dev'));

  const refused = await act('add', { name: 'recipes', folder: '~/dev/recipes', url: 'https://me:secret@example.com/team/api.git' });

  expect(refused.status).toBe(400);
  expect(refused.data?.message).toMatch(/^The URL holds a user name and password or a token\./);
  // The URL is not sent back, so a token in it is not drawn again. The name and folder are.
  expect(JSON.stringify(refused)).not.toContain('secret');
  expect(refused.data).toMatchObject({ name: 'recipes', folder: '~/dev/recipes' });
  expect(existsSync(at('dev', 'recipes'))).toBe(false);
  expect(setting('projectPath')).toBeNull();

  expect(await act('make')).toEqual({ status: 400, data: { message: 'There is no new project to make yet. Add a repository first.' } });
  expect(text(page({ ...(await loaded()) }))).toContain('Make your first project');
  expect(text(page({ ...(await loaded()) }))).toContain('1 of 2 · then the first task');
  // A home with no project has no first task either, so that screen sends it to New project.
  expect(await thrownBy(() => task.load({} as never))).toMatchObject({ status: 307, location: '/new' });
});

it('makes the workspace with the first repository, by URL from a bare remote, and shows its clone', async () => {
  const answer = await act('add', { name: 'recipes', folder: '~/dev/recipes', url: url('api') });

  expect(answer).toEqual({ cloning: 'api' });
  const workspace = at('dev', 'recipes');
  expect(setting('projectPath')).toBe(workspace);
  expect(setting('workspace')).toBe(true);
  expect(setting('onboarding')).toEqual({ done: false });
  await until(() => cloneJobs(workspace).every((job) => job.state === 'added'));
  expect(setting('repos')).toEqual([{ path: 'api', base: 'main' }]);
  expect(git(workspace, 'log', '--pretty=%s')).toBe('knowledge: repository files\nchore: add api\nchore: start the workspace');
  // The project files go in with the workspace, in its first commit, before any card.
  for (const file of ['AGENTS.md', 'CLAUDE.md', '.claude/hooks/nolzu-phase-guard.mjs', '.claude/settings.json']) expect(existsSync(join(workspace, file))).toBe(true);
  expect(git(workspace, 'show', '--name-only', '--pretty=', 'HEAD~2')).toContain('.claude/hooks/nolzu-phase-guard.mjs');

  const data = await loaded();
  expect(data.made).toEqual({ path: '~/dev/recipes', name: 'recipes', location: '~/dev', repos: [{ name: 'api', base: 'main', url: url('api'), branches: ['main'] }] });
  const shown = text(page({ ...data }));
  expect(shown).toMatch(/Nolzu made ~\/dev\/recipes ?\./);
  expect(shown).toMatch(/api https:\/\/example\.com\/team\/api\.git main Remove/);
});

// The base of a fresh clone is origin's default branch, and the row picks another
// one origin has. Nolzu cloned it a moment ago, so it makes the local branch and moves nothing.
it('picks a base from the branches origin had at the clone, and makes the local branch', async () => {
  const api = at('dev', 'recipes', 'api');
  git(at('remotes', 'api.git'), 'branch', 'develop', 'main');
  git(api, 'fetch', '-q', 'origin');
  const data = await loaded();
  expect(data.made?.repos).toEqual([{ name: 'api', base: 'main', url: url('api'), branches: ['develop', 'main'] }]);
  const html = page({ ...data });
  expect(html).toMatch(/<select name="base"[^>]*aria-label="Base branch of api"/);
  expect(html).toMatch(/<option value="main" selected/);
  // Save shows once the pick differs from the stored base, so a row draws none at first.
  expect(text(html)).not.toContain('Save');

  expect(await act('base', { repo: 'api', base: 'develop' })).toEqual({ based: 'api' });
  expect(setting('repos')).toEqual([{ path: 'api', base: 'develop' }]);
  expect(git(api, 'rev-parse', '--abbrev-ref', 'develop@{upstream}')).toBe('origin/develop');
  expect(git(api, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(git(api, 'status', '--porcelain')).toBe('');

  expect(await act('base', { repo: 'api', base: 'nope' })).toEqual({ status: 400, data: { message: 'There is no branch nope in the repository api. Type a branch it has, such as the one it is on.' } });
  expect(await act('base', { repo: 'shop', base: 'main' })).toEqual({ status: 400, data: { message: 'shop is not a repository of the project being made.' } });
  expect(await act('base', { repo: 'api', base: 'main' })).toEqual({ based: 'api' });

  // A pick not saved goes with Make the project, which saves it first. The second pick is refused, so
  // the project is not made yet and the rest of the tests go on.
  const make = (body: string) => actions.make!({ request: new Request('http://localhost/new', { method: 'POST', body: new URLSearchParams(body) }) } as never);
  expect(await make('base:api=develop&base:shop=main&base:api=nope')).toEqual({ status: 400, data: { message: 'There is no branch nope in the repository api. Type a branch it has, such as the one it is on.' } });
  expect(setting('repos')).toEqual([{ path: 'api', base: 'develop' }]);
  expect(await act('base', { repo: 'api', base: 'main' })).toEqual({ based: 'api' });
  expect(setting('repos')).toEqual([{ path: 'api', base: 'main' }]);
});

// The rail of a new project shows the two boards a first card goes on, and Getting started.
it('starts a new project with Research and PR reviews off, and Getting started on', () => {
  expect(setting('offBoards')).toEqual(['investigations', 'questions', 'prreview']);
  expect(setting('gettingStarted')).toEqual([]);
});

it('adds a second repository from the machine scan, and refuses one already in the project', async () => {
  const found = await (await loaded()).machine;
  expect(found).toEqual([{ path: '~/code/web', url: url('web') }]);

  // The name and folder are ignored once the workspace is made.
  expect(await act('add', { name: 'other', folder: '~/other', url: found[0]!.url! })).toEqual({ cloning: 'web' });
  const workspace = at('dev', 'recipes');
  await until(() => cloneJobs(workspace).every((job) => job.state === 'added'));
  expect(setting('repos')).toEqual([
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  expect(existsSync(at('other'))).toBe(false);
  expect(JSON.parse(readFileSync(join(workspace, '.nolzu', 'repositories.json'), 'utf8')).repositories).toEqual([
    { folder: 'api', url: url('api'), base: 'main' },
    { folder: 'web', url: url('web'), base: 'main' },
  ]);

  expect(await act('add', { url: url('api') })).toEqual({ status: 400, data: { message: 'There is a repository "api" in this workspace already.', name: '', folder: '' } });
});

it('stops a clone, and says so for one that ended', async () => {
  expect(await act('stop', { id: 'no-such-clone' })).toEqual({ status: 404, data: { message: 'That clone has ended already.' } });
});

it('removes a repository of the project being made, and nothing else', async () => {
  expect(await act('remove', { repo: 'shop' })).toEqual({ status: 400, data: { message: 'shop is not a repository of the project being made.' } });

  const removed = await act('remove', { repo: 'web' });

  expect(removed.removed).toMatch(/^Removed web\. /);
  expect(setting('repos')).toEqual([{ path: 'api', base: 'main' }]);
  expect(existsSync(at('dev', 'recipes', 'web'))).toBe(false);
});

// Step 1 of 2 ends on the first task, and the first run goes on until the first card.
it('makes the project and opens the first task, with card keys from the project name', async () => {
  expect(await thrownBy(() => act('make'))).toMatchObject({ status: 303, location: '/new/task' });

  expect(setting('onboarding')).toEqual({ done: false });
  expect(setting('localKeyPrefix')).toBe(proposePrefix('recipes'));
  const prefix = proposePrefix('recipes');
  const data = taskLoaded();
  expect(data.prefix).toBe(prefix);
  expect(data.key).toBe(`${prefix}-1`);
  expect(data.keys).toEqual([`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]);
  expect(data.made.repos).toEqual([{ name: 'api', base: 'main', url: url('api') }]);
  // The name Settings, Models shows, not the key the setting stores.
  expect(data.runsOn).toEqual({ label: 'Claude Code', preset: 'Balanced' });
});

// The first task: the banner, two equal choices, the Epic board as a named third one, and Skip.
it('draws the first task with the banner, the two choices, the Epic option and Skip, with nothing amber', () => {
  const html = render(TaskPage as never, { props: { data: { display: FREE, ...taskLoaded() }, form: null } } as never).body;
  const shown = text(html);

  expect(shown).toContain('recipes is ready');
  expect(shown).toContain('~/dev/recipes · 1 repository');
  expect(shown).toContain('Cards get the keys RECI-1, RECI-2, RECI-3');
  expect(html).toMatch(/<input id="prefix" name="value"[^>]*value="RECI"/);
  expect(shown).toContain('Runs on Claude Code, Balanced preset. Change in Settings, Models');
  expect(html).toMatch(/href="[./]*\/?settings\/models"/);
  expect(html).toMatch(/href="[./]*\/?settings\/project#tickets"/);
  expect(shown).toContain('Open the folder');
  expect(shown).toContain('Give it a task');
  expect(shown).toMatch(/Make card RECI-1 ?⌘↵/);
  expect(shown).toContain('Ask about the project');
  expect(html).toMatch(/<button[^>]*name="board" value="questions"/);
  expect(shown).toContain('Plan a bigger feature (Epic board)');
  expect(shown).toContain('Agents plan it and split it into tasks.');
  expect(html).toMatch(/action="\?\/skip"/);
  expect(shown).toContain('Skip, go to the board');
  // No file list and no side panel.
  expect(shown).not.toContain('Show them');
  expect(shown).not.toContain('Found in your repositories');
  // Making a card starts no agent, so the screen has no amber and no go button.
  expect(html).not.toContain('btn go');
  expect(readFileSync(new URL('./task/+page.svelte', import.meta.url), 'utf8')).not.toMatch(/var\(--amber/);
});

// The confetti is drawn only after a look at the system's motion setting, and never by a server render.
it('keeps the confetti out of the server render, and off under reduced motion', () => {
  const html = render(TaskPage as never, { props: { data: { display: FREE, ...taskLoaded() }, form: null } } as never).body;
  expect(html).not.toContain('confetti');
  const source = readFileSync(new URL('./task/+page.svelte', import.meta.url), 'utf8');
  expect(source).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches");
  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.confetti \{\s*display: none;/);
  // The burst comes out of the middle of the window, and its pieces take their numbers from one place.
  expect(source).toContain('const PIECES = confettiPieces();');
  expect(source).toMatch(/\.piece \{\s*position: absolute;\s*left: 50%;\s*top: 50%;/);
  expect(source).toMatch(/animation: throw 2\.5s/);
});

// The key prefix changes in place, with the refusal and the save of Settings, Project.
it('changes the card key prefix from the banner, and refuses a bad one with what was typed', async () => {
  expect(await taskAct('key', { value: 'no spaces' })).toMatchObject({ status: 400, data: { field: 'key', typed: 'no spaces' } });
  expect(setting('localKeyPrefix')).toBe(proposePrefix('recipes'));

  expect(await taskAct('key', { value: 'MEAL' })).toEqual({ field: 'key', saved: true });
  expect(taskLoaded().keys).toEqual(['MEAL-1', 'MEAL-2', 'MEAL-3']);
  expect(await taskAct('key', { value: proposePrefix('recipes') })).toEqual({ field: 'key', saved: true });
  const html = render(TaskPage as never, { props: { data: { display: FREE, ...taskLoaded() }, form: { field: 'key', saved: true } } } as never).body;
  expect(text(html)).toContain('Change the card key prefix');
  expect(text(html)).toContain('Saved. New cards get the keys above.');
});

// Open the folder is the reveal of Settings, Project.
it('opens the project folder as Settings, Project does', async () => {
  expect(await taskAct('reveal')).toEqual({ field: 'reveal', said: 'Opened the project folder.' });
  expect(reveal.project).toHaveBeenCalledTimes(1);
  reveal.project.mockReturnValueOnce('There is no project set, so there is no folder to show.');
  expect(await taskAct('reveal')).toEqual({ status: 400, data: { field: 'reveal', message: 'There is no project set, so there is no folder to show.' } });
});

// Set up the project lists every step where the old "Also learn this project" tick was. Learn
// your repositories is required and has no Not now; the others can be put away.
it('lists the setup steps on the first task screen, all open, Learn required, and no Learn tick', async () => {
  expect(setting('setupSteps')).toEqual({});
  const data = taskLoaded();
  expect(data.setup.map((step) => `${step.id} ${step.state}`)).toEqual(['learn open', 'commands open', 'qa open', 'tickets open']);
  const html = render(TaskPage as never, { props: { data: { display: FREE, ...data }, form: null } } as never).body;
  const shown = text(html);

  expect(html).not.toMatch(/name="learn"/);
  expect(shown).toContain('Set up the project');
  expect(shown).toMatch(/Learn your repositories ?Required/);
  expect(html).toMatch(/href="[./]*\/?knowledge#learn-repos"/);
  expect(shown).toMatch(/Confirm the run commands ?Recommended/);
  expect(html).toMatch(/href="[./]*\/?settings\/project#commands"/);
  expect(shown).toMatch(/Set up the QA browser ?Recommended/);
  expect(shown).toMatch(/Connect a ticket system ?Optional/);
  expect(html.match(/aria-label="Put away /g)?.length).toBe(3);
  expect(html).not.toContain('aria-label="Put away Learn your repositories"');
});

it('refuses an empty first task, and sends back what was typed', async () => {
  expect(await cardAnswer({ task: '   ' })).toEqual({ status: 400, data: { message: 'Type the first task. It becomes the first card.', task: '   ' } });
  expect(rows('SELECT key FROM cards')).toEqual([]);
});

it('makes the first card in the Delivery inbox, starts no run, writes no file and ends the first run', async () => {
  const workspace = at('dev', 'recipes');
  const head = git(workspace, 'rev-parse', 'HEAD');

  expect(await card({ task: 'Add a search box to the recipe list\nIt filters as you type.' })).toMatchObject({ status: 303, location: '/b/delivery' });

  expect(rows('SELECT key, board, stage, state, title, summary FROM cards')).toEqual([
    { key: `${proposePrefix('recipes')}-1`, board: 'delivery', stage: 'inbox', state: 'idle', title: 'Add a search box to the recipe list', summary: 'It filters as you type.' },
  ]);
  expect(rows('SELECT id FROM runs')).toEqual([]);
  expect(rows('SELECT card_key FROM card_events')).toEqual([]);
  // The files were written with the workspace, so the card commits nothing.
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(workspace, 'status', '--porcelain')).toBe('');
  expect(setting('onboarding')).toEqual({ done: true });
});

it('writes nothing for a second card, on the first task screen or with Add card', async () => {
  const workspace = at('dev', 'recipes');
  unlinkSync(join(workspace, 'AGENTS.md'));
  const head = git(workspace, 'rev-parse', 'HEAD');

  expect(await cardAnswer({ task: 'Fix the list' })).toEqual({ status: 400, data: { message: 'No new project is waiting for its first card. Add the next card on the board.', task: 'Fix the list' } });
  expect((await addCard('A second card')).status).toBe(201);

  expect(rows('SELECT title FROM cards ORDER BY key')).toEqual([{ title: 'Add a search box to the recipe list' }, { title: 'A second card' }]);
  expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false);
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
});

it('sends the first task of a finished project to its board, and New project then makes a new one', async () => {
  expect(await thrownBy(() => task.load({} as never))).toMatchObject({ status: 307, location: '/b/delivery' });
  const data = await loaded();
  expect(data.made).toBeNull();
  expect(data.first).toBe(false);
  expect(text(page({ ...data }))).toContain('New project');
  // Remove on this screen reaches no repository of a finished project.
  expect((await act('remove', { repo: 'api' })).status).toBe(400);
});

// The project is opened again by hand for each, since each makes the first card of its project.
it('makes a read-only Research card on the Questions board, turned on, and an epic from Plan a bigger feature', async () => {
  write('onboarding', { done: false });
  write('offBoards', ['questions', 'prreview']);

  expect(await card({ board: 'questions', task: '' })).toMatchObject({ status: 303, location: '/b/questions' });
  expect(rows("SELECT board, stage, title FROM cards WHERE board = 'questions'")).toEqual([{ board: 'questions', stage: 'inbox', title: 'What does this project do?' }]);
  expect(setting('offBoards')).toEqual(['prreview']);

  write('onboarding', { done: false });
  expect(await cardAnswer({ board: 'epics', task: '' })).toMatchObject({ status: 400 });
  expect(await card({ board: 'epics', task: 'A meal planner for the week' })).toMatchObject({ status: 303, location: '/b/epics' });
  expect(rows("SELECT board, stage, title FROM cards WHERE board = 'epics'")).toEqual([{ board: 'epics', stage: 'inbox', title: 'A meal planner for the week' }]);
  expect(rows('SELECT id FROM runs')).toEqual([]);
  expect(setting('onboarding')).toEqual({ done: true });
});

// Skip ends the first run with no card and opens the Delivery board, which then stays open.
it('skips the first task to the Delivery board, and ends the first run', async () => {
  write('onboarding', { done: false });
  const cards = rows('SELECT key FROM cards').length;

  expect(await taskAct('skip')).toMatchObject({ status: 303, location: '/b/delivery' });

  expect(setting('onboarding')).toEqual({ done: true });
  expect(rows('SELECT key FROM cards')).toHaveLength(cards);
  expect(await thrownBy(() => task.load({} as never))).toMatchObject({ status: 307, location: '/b/delivery' });
});

// A later project: its first Add makes a project database of its own beside the first one, makes it the
// current project and opens its first run again, so the next Add goes into that workspace and not into a
// third folder. On Free the first Add is refused: the lock comes from the signed document.
it('makes a later project in a database of its own with its first Add, and adds the next repository to it', async () => {
  // The list is started once per machine: a later project leaves a list in progress as it is.
  write('gettingStarted', ['summary']);
  // Free makes a second project with no account.
  expect(rows('SELECT file FROM project_registry')).toEqual([{ file: 'nolzu.db' }]);
  expect(await act('add', { name: 'shop', folder: '~/dev/shop', url: url('api') })).toEqual({ cloning: 'api' });
  expect(hub.changed).toHaveBeenCalledTimes(1);
  const shop = at('dev', 'shop');
  expect(rows('SELECT id, file FROM project_registry')).toEqual([
    { id: 1, file: 'nolzu.db' },
    { id: 2, file: 'projects/2.db' },
  ]);
  expect(setting('currentProject')).toBe(2);
  expect(setting('projectPath')).toBe(at('dev', 'recipes'));
  expect(current('projectPath')).toBe(shop);
  expect(current('offBoards')).toEqual(['investigations', 'questions', 'prreview']);
  expect(setting('onboarding')).toEqual({ done: false });
  expect(setting('gettingStarted')).toEqual(['summary']);
  // A project stands beside the one being made, so the heading stays New project.
  expect(await loaded()).toMatchObject({ first: false, made: { name: 'shop' } });
  expect(text(page({ ...(await loaded()) }))).not.toContain('Make your first project');
  await until(() => cloneJobs(shop).every((job) => job.state === 'added'));

  expect(await act('add', { name: 'shop', folder: '~/dev/shop', url: url('web') })).toEqual({ cloning: 'web' });
  await until(() => cloneJobs(shop).every((job) => job.state === 'added'));
  expect(current('repos')).toEqual([
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  expect(setting('repos')).toEqual([{ path: 'api', base: 'main' }]);
});

// A first card made on the board, past the first task screen, still ends the first run. The later
// project got its files with its workspace too.
it('ends the first run when a new project gets its first card from Add card', async () => {
  const shop = at('dev', 'shop');
  expect(existsSync(join(shop, 'AGENTS.md'))).toBe(true);
  expect(current('onboarding')).toEqual({ done: false });

  expect((await addCard('Ship the cart')).status).toBe(201);

  expect(current('onboarding')).toEqual({ done: true });
});

// The scan decides which folder Put on GitHub may read, never the posted path, and gh answers last.
it('puts on GitHub only a repository the scan found with no remote, and says what gh said', async () => {
  const typed = { name: 'notes', folder: '~/dev/notes' };

  expect(await act('github', { ...typed, path: '~/../etc' })).toEqual({ status: 400, data: { message: '~/../etc is not a git repository found on this machine.', ...typed } });
  expect(await act('github', { ...typed, path: '~/code/web' })).toEqual({ status: 400, data: { message: '~/code/web has a remote already. Press Add to clone it from there.', ...typed } });
  mkdirSync(at('code', 'sketchbook'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', at('code', 'sketchbook')], { env: process.env });
  expect(await act('github', { ...typed, path: '~/code/sketchbook' })).toEqual({
    status: 400,
    data: { message: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.', ...typed },
  });
  expect(existsSync(at('dev', 'notes'))).toBe(false);
});

// jsdom draws no layout, so the rules that keep a found name on one line are read from the source.
it('keeps a found repository name on one line and lets the URL give up width first', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
  expect(source).toMatch(/\.rn \{\s*overflow: hidden;\s*white-space: nowrap;\s*text-overflow: ellipsis;/);
  expect(source).toContain('grid-template-columns: minmax(0, max-content) minmax(8ch, 1fr) auto;');
});

// Free holds every project, so the side column names no limit.
it('says no project limit in the side column, before or after the first project', () => {
  expect(text(page({ made: null, first: false, machine: Promise.resolve([]) }))).not.toContain('keeps one project');
  expect(text(page({ made: null, first: true, machine: Promise.resolve([]) }))).not.toContain('keeps one project');
});

// Amber only where an agent starts work, and Make the project starts none.
it('draws Make the project as the cream main button with its key, and nothing amber', () => {
  const html = page({ made: null, first: true, machine: Promise.resolve([]) });

  expect(html).toMatch(/class="btn primary lg[^"]*"[^>]*>(<!--[^>]*-->| )*Make the project/);
  expect(html).not.toContain('btn go');
  expect(readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8')).not.toMatch(/var\(--amber/);
});

// The idea link sits beside Make the project, and the line about a repository shows only
// while none is listed.
it('links Start from an idea beside Make the project, and says a repository is needed only while none is listed', () => {
  const empty = page({ made: { path: '~/dev/shop', name: 'shop', location: '~/dev', repos: [] }, first: true, machine: Promise.resolve([]) });
  expect(empty).toMatch(/<a class="alt[^"]*" href="\.\/new\/idea">No code yet\? Start from an idea<\/a>/);
  expect(text(empty)).toContain('Make the project ⌘↵ No code yet? Start from an idea A project needs at least one repository.');

  const one = page({ made: { path: '~/dev/shop', name: 'shop', location: '~/dev', repos: [{ name: 'api', base: 'main', url: url('api'), branches: [] }] }, first: true, machine: Promise.resolve([]) });
  expect(text(one)).toContain('No code yet? Start from an idea');
  expect(text(one)).not.toContain('A project needs at least one repository.');
});

// With no agent tool on the PATH the page asks for one first. The fake engine counts as one.
it('asks for an agent tool before the form while none is on the PATH, and not in fake mode', async () => {
  scan.found = [];
  try {
    const waiting = (await loaded()) as Loaded & { tools: unknown };
    expect(waiting.tools).toBe(ENGINE_INSTALLS);
    const shown = text(page({ ...waiting }));
    expect(shown).toContain('Nolzu needs one agent tool to run cards');
    expect(shown).not.toContain('Make the project');

    process.env.NOLZU_FAKE_AGENT = '1';
    expect(((await loaded()) as Loaded & { tools: unknown }).tools).toBeNull();
  } finally {
    delete process.env.NOLZU_FAKE_AGENT;
    scan.found = ['claude-code'];
  }
});

// Onboarding asks for one engine that runs every phase on this machine.
it('goes on with any engine where the wall starts, and needs Claude Code or Codex where it cannot', async () => {
  const tools = async () => ((await loaded()) as Loaded & { tools: unknown }).tools;
  try {
    scan.found = ['cursor'];
    expect(await tools()).toBeNull();

    walls.here = { ready: false, reason: BWRAP };
    const waiting = (await loaded()) as Loaded & { tools: unknown };
    expect(waiting.tools).toBe(ENGINE_INSTALLS);
    expect(text(page({ ...waiting }))).toContain(`Cursor cannot run every phase on this machine. Install Claude Code or Codex to go on, or make Nolzu's wall start so any engine can: ${BWRAP}`);

    scan.found = ['codex'];
    expect(await tools()).toBeNull();
  } finally {
    walls.here = { ready: true, binary: '/usr/bin/sandbox-exec' };
    scan.found = ['claude-code'];
  }
});

// A later workspace whose first commit fails has its folder and its project already, so New project goes
// on with it: the next Add clones into that folder instead of refusing it as taken.
it('goes on with a later workspace whose first commit failed', async () => {
  const hooks = at('hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "no commit today" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(at('.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
  try {
    const refused = await act('add', { name: 'pantry', folder: '~/dev/pantry', url: url('web') });
    expect(refused.status).toBe(400);
    expect(refused.data?.message).toMatch(/^The workspace files are written, but git could not commit them in .*pantry\. no commit today$/);
  } finally {
    unlinkSync(at('.gitconfig'));
  }
  const pantry = at('dev', 'pantry');
  expect(setting('currentProject')).toBe(3);
  expect(current('projectPath')).toBe(pantry);
  expect(await loaded()).toMatchObject({ first: false, made: { name: 'pantry', repos: [] } });

  expect(await act('add', { name: 'pantry', folder: '~/dev/pantry', url: url('web') })).toEqual({ cloning: 'web' });
  await until(() => cloneJobs(pantry).every((job) => job.state === 'added'));
  expect(current('repos')).toEqual([{ path: 'web', base: 'main' }]);
  expect(rows('SELECT file FROM project_registry')).toEqual([{ file: 'nolzu.db' }, { file: 'projects/2.db' }, { file: 'projects/3.db' }]);

  // The first run's flag follows the machine, so an older workspace opened while pantry waits is not the
  // one being made, and its next Add card writes no project files into it.
  write('currentProject', 1);
  expect(await loaded()).toMatchObject({ first: false, made: null });
  write('currentProject', 3);
  expect(await loaded()).toMatchObject({ made: { name: 'pantry' } });
});

// Refused before its folder is made, a later project leaves nothing: no registry row and no database.
it('takes back a later project refused before its folder was made', async () => {
  write('onboarding', { done: true });
  expect(await act('add', { name: 'shop', folder: '~/dev/shop', url: url('api') })).toEqual({
    status: 400,
    data: { message: `${at('dev', 'shop')} has files in it already. Type a new folder, or an empty one.`, name: 'shop', folder: '~/dev/shop' },
  });
  expect(rows('SELECT file FROM project_registry')).toEqual([{ file: 'nolzu.db' }, { file: 'projects/2.db' }, { file: 'projects/3.db' }]);
  expect(existsSync(join(dir, 'projects', '4.db'))).toBe(false);
  expect(setting('currentProject')).toBe(3);
});

// A page load while the first Add waits on git opens the new project. Taken back, its id goes to the next
// project made, and the routes must read that one and not the file that was deleted.
it('reads the next project made, after a page load opened one that was taken back', async () => {
  try {
    gitWait.during = () => void database(4);
    const refused = await act('add', { name: 'larder', folder: '~/dev/larder', url: url('api') });
    expect(refused.data?.message).toBe('git has no name and email to commit with, so nothing was written. Author identity unknown');
    gitWait.during = null;
    expect(rows('SELECT file FROM project_registry')).toHaveLength(3);

    expect(await act('add', { name: 'larder', folder: '~/dev/larder', url: url('api') })).toEqual({ cloning: 'api' });
  } finally {
    gitWait.during = null;
  }
  const larder = at('dev', 'larder');
  expect(setting('currentProject')).toBe(4);
  expect(current('projectPath')).toBe(larder);
  await until(() => cloneJobs(larder).every((job) => job.state === 'added'));
  expect(current('repos')).toEqual([{ path: 'api', base: 'main' }]);
});
