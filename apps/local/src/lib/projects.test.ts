import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, getSetting, openDatabase, resolveDataDir, startRun, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fillAllowedCommands } from './onboard.ts';
import { addCommands, foundToAdd, openerWords, projectBranches, projectList, projectRow, removeProjectRepo, repoTable, rescanRepos, revealProject, saveProjectField } from './projects.ts';
import ProjectsList from './ProjectsList.svelte';
import { PROJECT_BOXES } from './settings-sections.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';

// The Walls box links to Settings, Wall, so the page says where it is drawn.
drawnAt('/settings/project');

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

const dir = mkdtempSync(join(tmpdir(), 'nolzu-projects-'));
const project = mkdtempSync(join(tmpdir(), 'nolzu-projects-repo-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();

let db: DatabaseSync;
beforeEach(() => {
  db?.close();
  for (const file of readdirSync(dir)) rmSync(join(dir, file), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  db = openDatabase(dir);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The way `evidence.test.ts` writes a move: the column the reader asks for, at a time the test picks.
const moved = (key: string, at: string) =>
  db.prepare('INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES (?, ?, ?, ?, ?)').run(key, 'inbox', 'plan', 'you', at);

it('reads a machine with no project as a row with nothing in it', async () => {
  const row = await projectRow(db);

  expect(row).toMatchObject({ name: null, path: null, closedCheckouts: 0, nextKey: 'APP-1' });
  expect(await repoTable(db)).toEqual([]);
  expect(row.ticketSystem).toBe('local');
});

it('reads the one project: name, path, ticket system, the next key, the branch a card gets and the closed checkouts', async () => {
  git('init', '-b', 'main');
  writeSetting(db, 'projectPath', project);
  createCard(db, { key: 'APP-1', title: 'Add a search box', board: 'delivery', stage: 'plan' });
  createCard(db, { key: 'APP-2', title: 'Shipped already', board: 'delivery', stage: 'closed' });
  createCard(db, { key: 'APP-3', title: 'Shipped long ago', board: 'delivery', stage: 'closed' });
  // A closed card with its checkout still on disk, one without, and an open one with a checkout.
  mkdirSync(join(project, 'worktrees', 'APP-2'), { recursive: true });
  mkdirSync(join(project, 'worktrees', 'APP-1'), { recursive: true });

  const row = await projectRow(db);

  expect(row.name).toBe(basename(project));
  expect(row.path).toBe(project);
  expect(row.ticketSystem).toBe('local');
  expect(row.nextKey).toBe('APP-4');
  expect(row.branchExample).toBe('feature/APP-4/search-box');
  expect(row.closedCheckouts).toBe(1);

  const body = render(ProjectsList, { props: { row } }).body;
  const said = text(body);
  expect(body).toContain('The next card is <span class="mono svelte-');
  expect(said).toContain('The next card is APP-4 .');
  expect(said).toContain('The next card gets feature/APP-4/search-box .');
  expect(said).toContain('Remove the checkouts of closed cards (1)');
  // Both read only: the location cannot be moved from the app.
  const input = (id: string) => new RegExp(`<input id="${id}"[^>]*>`).exec(body)?.[0] ?? '';
  expect(input('project-name')).toContain(`value="${basename(project)}" readonly`);
  expect(input('project-path')).toContain(`value="${project}" readonly`);

  rmSync(join(project, 'worktrees'), { recursive: true });
});

// A server render draws no layout, so the rule is read. Beside the full rail at 800px the repositories
// table is wider than its panel, and a clip there hides the Clone and Remove column.
it('lets the repositories panel scroll and never clip', () => {
  const css = /<style>([\s\S]*)<\/style>/.exec(readFileSync(new URL('./ProjectsList.svelte', import.meta.url), 'utf8'))?.[1] ?? '';
  const panel = /\n {2}\.panel \{([^}]*)\}/.exec(css)?.[1] ?? '';

  expect(panel).toContain('overflow-x: auto;');
  expect(panel).not.toContain('overflow: hidden');
});

// The Location box shows the folder as a person reads it, with the home folder as ~.
it('shows the project folder under the home folder with ~', async () => {
  writeSetting(db, 'projectPath', project);
  const home = process.env.HOME;
  process.env.HOME = tmpdir();
  try {
    expect((await projectRow(db)).path).toBe(`~/${basename(project)}`);
  } finally {
    process.env.HOME = home;
  }
});

// The core rule asks a stored template for {key} only, so a hand edit can store one branchName refuses.
// The page must still open, because it is where the template is fixed.
it('opens with a stored template the branch namer refuses, and draws no example', async () => {
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'branchTemplate', '{key}-{user}');

  const row = await projectRow(db);

  expect(row.branchTemplate).toBe('{key}-{user}');
  expect(row.branchExample).toBeNull();
  expect(text(render(ProjectsList, { props: { row } }).body)).toContain('{key} is the card key');
});

// Without JavaScript every form is a full page post, and the Saved line at the foot is the answer.
it('draws plain post forms and the Saved line for a page without JavaScript', async () => {
  writeSetting(db, 'projectPath', project);
  const body = render(ProjectsList, { props: { row: await projectRow(db), saved: 'branchTemplate' } }).body;

  const forms = body.match(/<form[^>]*>/g) ?? [];
  expect(forms.length).toBeGreaterThan(10);
  expect(forms.filter((form) => !/method="POST" action="\?\/\w+"/.test(form))).toEqual([]);
  expect(body).toContain('<p class="said svelte-');
  expect(text(body)).toContain('Saved.');
});

it('takes the newer of the last move and the last run, and counts a queued run as nothing', async () => {
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  const newest = () => projectList(db).projects[0]?.lastActivity;
  createCard(db, { key: 'APP-1', title: 'Add a search box', board: 'delivery', stage: 'plan' });
  moved('APP-1', '2026-09-20T08:00:00.000Z');
  // Queued and nothing else: it has no start and no end, so it happened on no day yet. The cost
  // report drops it for the same reason.
  const run = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: null });
  expect(newest()).toBe('2026-09-20T08:00:00.000Z');

  db.prepare('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?').run('2026-09-21T08:00:00.000Z', '2026-09-21T08:30:00.000Z', run);

  expect(newest()).toBe('2026-09-21T08:30:00.000Z');
});

// The client, the rate and the currency are saved together by `saveBilling`, from Evidence, so the
// one-field save still refuses them, and Settings, Project draws no Evidence box.
it('saves no client or rate one field at a time, and draws no Evidence box', async () => {
  for (const field of ['clientName', 'hourlyRate', 'currency']) expect(await saveProjectField(db, field, '80')).toBe(`There is no setting ${field} on this screen.`);
  expect(getSetting(db, 'hourlyRate')).toBeNull();

  const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;
  expect(body).not.toContain('id="evidence"');
  expect(body).not.toContain('Coming soon');
  expect(body).not.toContain('action="?/bill"');
});

// "Or pick one found on this machine": a found folder adds by its remote, so one with none is left out,
// and so are the project itself and a repository the table lists already.
it('offers the repositories found on this machine that the project has not got', () => {
  const row = { path: '~/code/recipes', table: [{ remote: 'github.com/recipes-app/web' }] };
  const found = [
    { path: '~/code/recipes', url: 'git@github.com:recipes-app/recipes.git' },
    { path: '~/code/web', url: 'https://github.com/recipes-app/web.git' },
    { path: '~/code/dotfiles', url: null },
    { path: '~/code/recipes-scripts', url: 'https://github.com/recipes-app/recipes-scripts.git' },
  ];

  expect(foundToAdd(row, found)).toEqual([{ path: '~/code/recipes-scripts', url: 'https://github.com/recipes-app/recipes-scripts.git' }]);
  expect(foundToAdd({ path: null, table: [] }, found).map((one) => one.path)).toEqual(['~/code/recipes', '~/code/web', '~/code/recipes-scripts']);
});

it('leaves out a repository found inside the project folder, but not a sibling that shares its prefix', () => {
  const found = [
    { path: '~/code/recipes/api', url: 'https://github.com/recipes-app/api.git' },
    { path: '~/code/recipes-scripts', url: 'https://github.com/recipes-app/recipes-scripts.git' },
  ];
  expect(foundToAdd({ path: '~/code/recipes', table: [] }, found).map((one) => one.path)).toEqual(['~/code/recipes-scripts']);
});

// The location is read only, and the way to the folder is the file manager.
describe('showing the project folder', () => {
  it('names the button by the file manager of the system, and none where there is none', () => {
    expect(openerWords('darwin', {})).toBe('Open in Finder');
    expect(openerWords('linux', { DISPLAY: ':0' })).toBe('Open the folder');
    expect(openerWords('linux', {})).toBeNull();
  });

  it('opens the stored folder only, and says why when it cannot', () => {
    const opened: string[][] = [];
    const run = (command: string, args: string[]) => void opened.push([command, ...args]);

    expect(revealProject(db, run, 'darwin', {})).toBe('There is no project set, so there is no folder to show.');
    writeSetting(db, 'projectPath', project);
    expect(revealProject(db, run, 'linux', {})).toBe('This machine has no file manager Nolzu can open. The path is in the Location box.');
    expect(opened).toEqual([]);

    expect(revealProject(db, run, 'darwin', {})).toBeNull();
    expect(opened).toEqual([['open', project]]);

    writeSetting(db, 'projectPath', join(project, 'gone'));
    expect(revealProject(db, run, 'darwin', {})).toBe(`The folder ${join(project, 'gone')} is not there any more.`);
    expect(opened).toHaveLength(1);
  });

  it('draws the button beside the read only location, and none with no file manager', async () => {
    writeSetting(db, 'projectPath', project);
    const row = await projectRow(db);

    const button = (opener: string | null) => /action="\?\/reveal"[^]*?<\/form>/.exec(render(ProjectsList, { props: { row: { ...row, opener } } }).body)?.[0] ?? '';
    expect(text(button('Open in Finder'))).toContain('Open in Finder');
    expect(button(null)).not.toContain('<button');
  });
});

describe('turning a board off', () => {
  // The switch of one board, found by the name it is labelled with.
  const switchOf = (body: string, kind: string) => new RegExp(`<button[^>]*aria-labelledby="board-${kind}"[^>]*>`).exec(body)?.[0] ?? '';
  const everything = () => ({
    cards: db.prepare('SELECT * FROM cards ORDER BY key').all(),
    moves: db.prepare('SELECT * FROM card_events ORDER BY id').all(),
    runs: db.prepare('SELECT * FROM runs ORDER BY id').all(),
    links: db.prepare('SELECT * FROM card_links ORDER BY a, b').all(),
  });

  // An off board leaves the rail, and its cards stay untouched until it is on
  // again. The setting is the one write, so the cards, their moves, runs and links read the same after.
  it('turns a board off and on again, and leaves its cards as they were', async () => {
    createCard(db, { key: 'EPIC-1', title: 'Meal plans', board: 'epics', stage: 'architecture' });
    createCard(db, { key: 'APP-1', title: 'Add a search box', board: 'delivery', stage: 'plan' });
    db.prepare("UPDATE cards SET state = 'ready', minimized = 1, summary = 'A week of meals' WHERE key = 'EPIC-1'").run();
    moved('EPIC-1', '2026-10-06T09:00:00.000Z');
    db.prepare('INSERT INTO card_links (a, b) VALUES (?, ?)').run('APP-1', 'EPIC-1');
    const run = startRun(db, { cardKey: 'EPIC-1', phase: 'architecture', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: null });
    db.prepare("UPDATE runs SET state = 'complete', started_at = '2026-10-06T09:00:00.000Z', ended_at = '2026-10-06T09:10:00.000Z' WHERE id = ?").run(run);
    const before = everything();

    expect(await saveProjectField(db, 'board:epics', 'off')).toBeNull();
    expect(getSetting(db, 'offBoards')).toEqual(['epics']);
    expect((await projectRow(db)).boards).toContainEqual({ kind: 'epics', label: 'Epics', on: false });
    expect(everything()).toEqual(before);

    expect(await saveProjectField(db, 'board:epics', 'on')).toBeNull();
    expect(getSetting(db, 'offBoards')).toEqual([]);
    expect(everything()).toEqual(before);
  });

  // The card above is folded already, so a switch that folded the board's cards would pass it. This
  // one is open, the way a new card is.
  it('leaves an open card of a board turned off open', async () => {
    createCard(db, { key: 'EPIC-2', title: 'Shopping list', board: 'epics', stage: 'architecture' });
    const before = everything();

    expect(await saveProjectField(db, 'board:epics', 'off')).toBeNull();

    expect(everything()).toEqual(before);
  });

  it('has no switch for Delivery, and refuses one sent by hand', async () => {
    const row = await projectRow(db);
    expect(row.boards.map((one) => one.kind)).toEqual(['epics', 'research', 'prreview']);

    const body = render(ProjectsList, { props: { row } }).body;
    // Delivery's switch is drawn on and off limits, in no form.
    expect(text(body)).toContain('Delivery always on');
    expect(switchOf(body, 'delivery')).toMatch(/disabled[^>]*role="switch"[^>]*aria-checked="true"/);
    expect(body).not.toContain('value="board:delivery"');
    expect(body).toContain('value="board:epics"');
    expect(switchOf(body, 'epics')).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(switchOf(body, 'epics')).not.toContain('disabled');

    expect(await saveProjectField(db, 'board:delivery', 'off')).toBe('The Delivery board cannot be turned off.');
    expect(await saveProjectField(db, 'board:recipes', 'off')).toBe('There is no recipes board.');
    expect(await saveProjectField(db, 'board:delivery', 'on')).toBe('The Delivery board cannot be turned off.');
    expect(await saveProjectField(db, 'board:recipes', 'on')).toBe('There is no recipes board.');
    expect(await saveProjectField(db, 'board:epics', 'later')).toBe('A board is on or off.');
    expect(getSetting(db, 'offBoards')).toEqual([]);
  });

  it('offers to turn an off board on again', async () => {
    await saveProjectField(db, 'board:research', 'off');

    const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;

    expect(switchOf(body, 'research')).toContain('aria-checked="false"');
    expect(text(body)).toContain('An off board leaves the rail. Its cards stay as they are until it is on again, and no run stops.');
  });

  // Research is one list over two kinds, so its one switch turns both on and off together, and
  // so does a switch sent by hand for one of the two.
  it('turns both Research kinds off and on together', async () => {
    expect(await saveProjectField(db, 'board:research', 'off')).toBeNull();
    expect(getSetting(db, 'offBoards')).toEqual(['questions', 'investigations']);
    expect(await saveProjectField(db, 'board:investigations', 'on')).toBeNull();
    expect(getSetting(db, 'offBoards')).toEqual([]);
    expect(await saveProjectField(db, 'board:questions', 'off')).toBeNull();
    expect(getSetting(db, 'offBoards')).toEqual(['questions', 'investigations']);
  });

  // The button posts the state the board goes to. A button that posted the state it has would read
  // right and change nothing.
  it('posts the other state from each board button', async () => {
    await saveProjectField(db, 'board:research', 'off');

    const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;
    const posts = (kind: string) => new RegExp(`value="board:${kind}"[^]*?name="value" value="(on|off)"`).exec(body)?.[1];

    expect(posts('research')).toBe('on');
    expect(posts('epics')).toBe('off');
  });
});

it('names a field this screen does not have rather than storing it', async () => {
  expect(await saveProjectField(db, 'agentSlots', '9')).toBe('There is no setting agentSlots on this screen.');
});

// Plan lines go where a person compares plans, not on a settings page, so no screen draws the old
// upgrade line.
it('draws the old upgrade line on no screen', () => {
  const LINE = 'Solo supports multiple client projects';
  const roots = [new URL('../', import.meta.url), new URL('../../../../packages/ui/src/', import.meta.url)];
  const found: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (name.endsWith('.svelte') && readFileSync(new URL(name.split(sep).join('/'), root), 'utf8').includes(LINE)) found.push(name);
    }
  }

  expect(found).toEqual([]);
});

// Every part of the page is a box, in the order and with the ids the settings menu lists.
it('draws every part in a box, in the order the settings menu lists them', async () => {
  const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;

  const ids = [...body.matchAll(/<section class="box[^"]*" id="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toEqual(PROJECT_BOXES.map((box) => box.id));
  // The long list of fixed walls is on Settings, Wall. Walls keeps the three lists and a link there.
  const walls = body.slice(body.indexOf('id="walls"'), body.indexOf('id="tickets"'));
  expect(walls).toContain('href="../settings/wall"');
  expect(walls).not.toContain('~/.ssh');
  for (const label of ['More paths to hide', 'Secret exceptions', 'More writable folders']) expect(walls).toContain(label);
  // The remote column of the repositories table gives way first: out of the table's sizing, with an ellipsis.
  const source = readFileSync(new URL('./ProjectsList.svelte', import.meta.url), 'utf8');
  expect(source).toMatch(/\.remote \{[^}]*max-width: 0;[^}]*text-overflow: ellipsis;/);
  // A label that only just fits keeps its "?" on the last line, not alone under it.
  expect(source).toMatch(/\.lb \{[^}]*text-wrap: balance;/);
});

// The labels that need more than a line carry a "?" with the longer word and an example.
it('puts a help tip beside each label that needs one', async () => {
  const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;

  for (const label of ['Card key prefix', 'Branch name', 'Knowledge location', 'Commands the agent may run', 'Start the app', 'QA browser', 'Project files', 'On the rail', 'More paths to hide', 'Secret exceptions', 'More writable folders']) {
    expect(body).toContain(`aria-label="About ${label}"`);
  }
  expect(text(body)).toContain('Example: feature/{key}/{desc} gives feature/APP-1/search-box.');
});

it('saves the base branch the repository has, and refuses one it has not in the wizard\'s words', async () => {
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Dev', '-c', 'user.email=dev@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start');
  git('branch', 'develop');
  writeSetting(db, 'projectPath', project);

  expect(await saveProjectField(db, 'baseBranch', 'develop')).toBeNull();
  expect(getSetting(db, 'baseBranch')).toBe('develop');

  const refused = await saveProjectField(db, 'baseBranch', 'nope');

  expect(refused).toBe('There is no branch nope in this repository. Type a branch it has, such as the one it is on.');
  expect(getSetting(db, 'baseBranch')).toBe('develop');
});

// The list has a row per repository, so the single field refuses rather than store a base
// that no card reads.
it('refuses the single base branch for a project with several repositories', async () => {
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'repos', [{ path: 'api', base: 'main' }, { path: 'web', base: 'master' }]);
  const before = getSetting(db, 'baseBranch');

  expect(await saveProjectField(db, 'baseBranch', 'develop')).toBe('This project has a base branch for each repository. Change them in the repository table.');
  expect(getSetting(db, 'baseBranch')).toBe(before);
});

describe('the repository table', () => {
  // Real repositories in a temp folder, with a git identity so the knowledge commit can be made.
  let at = '';
  const env = () => ({ ...process.env, HOME: at, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  const gitIn = (where: string, ...args: string[]) => execFileSync('git', ['-C', where, ...args], { env: env(), encoding: 'utf8' }).trim();
  const repoAt = (where: string) => {
    mkdirSync(where, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', where], { env: env() });
    gitIn(where, 'commit', '-q', '--allow-empty', '-m', 'first');
    return where;
  };
  // A root repository that ignores its api and docs folders, and an api repository with a develop branch.
  const rootWithApi = () => {
    repoAt(at);
    writeFileSync(join(at, '.gitignore'), '/api/\n/docs/\n');
    gitIn(at, 'add', '-A');
    gitIn(at, 'commit', '-q', '-m', 'ignore');
    gitIn(repoAt(join(at, 'api')), 'branch', 'develop');
    writeSetting(db, 'projectPath', at);
    writeSetting(db, 'repos', [
      { path: '.', base: 'main' },
      { path: 'api', base: 'main' },
    ]);
    writeSetting(db, 'baseBranch', 'main');
  };

  beforeEach(() => {
    at = mkdtempSync(join(tmpdir(), 'nolzu-projects-repos-'));
  });
  afterEach(() => rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('saves the base of api alone, and refuses a missing branch in the onboarding sentence', async () => {
    rootWithApi();

    expect(await saveProjectField(db, 'repoBase:api', 'develop')).toBeNull();
    expect(getSetting(db, 'repos')).toEqual([
      { path: '.', base: 'main' },
      { path: 'api', base: 'develop' },
    ]);
    expect(getSetting(db, 'baseBranch')).toBe('main');

    expect(await saveProjectField(db, 'repoBase:api', 'nope')).toBe('There is no branch nope in the repository api. Type a branch it has, such as the one it is on.');
    expect(await saveProjectField(db, 'repoBase:web', 'main')).toBe('There is no repository web in this project.');
    expect(await saveProjectField(db, 'repoBase:api', ' ')).toBe('The base branch cannot be empty.');
    expect(getSetting(db, 'repos')?.[1]).toEqual({ path: 'api', base: 'develop' });
  });

  // The base branch select lists what origin has: one for-each-ref per repository, HEAD left out.
  it('lists the branches origin has for each repository, and none for one with no origin', async () => {
    rootWithApi();
    const bare = join(at, 'docs', 'api.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', bare], { env: env() });
    const api = join(at, 'api');
    gitIn(api, 'remote', 'add', 'origin', bare);
    gitIn(api, 'push', '-q', 'origin', 'main', 'develop', 'develop:release/next');
    gitIn(api, 'remote', 'set-head', 'origin', 'main');

    const branches = await projectBranches(db);

    expect(branches.api).toEqual(['develop', 'main', 'release/next']);
    expect(branches['.']).toEqual([]);

    // One repository at the project folder keeps the one field, with its own list.
    writeSetting(db, 'projectPath', api);
    writeSetting(db, 'repos', null);
    expect(await projectBranches(db)).toEqual({ '.': ['develop', 'main', 'release/next'] });

    // A plain folder inside that repository is not one: git would answer for the repository around it.
    mkdirSync(join(api, 'plain'));
    writeSetting(db, 'projectPath', join(api, 'plain'));
    expect(await projectBranches(db)).toEqual({ '.': [] });
    writeSetting(db, 'projectPath', api);

    // release/next is on origin only, and a card starts from a local branch, so the pick makes the
    // local tracking branch and saves.
    expect(await saveProjectField(db, 'baseBranch', 'release/next')).toBeNull();
    expect(getSetting(db, 'baseBranch')).toBe('release/next');
    expect(gitIn(api, 'rev-parse', '--abbrev-ref', 'release/next@{upstream}')).toBe('origin/release/next');
  });

  // A fresh clone has only origin's default branch locally. A base picked from
  // origin's other branches gets its local tracking branch, and HEAD and the files stay as they were.
  it('makes the local branch for a base only origin has, and moves nothing checked out', async () => {
    rootWithApi();
    const source = repoAt(join(at, 'docs', 'source'));
    gitIn(source, 'checkout', '-q', '-b', 'develop');
    gitIn(source, 'commit', '-q', '--allow-empty', '-m', 'on develop');
    gitIn(source, 'checkout', '-q', '-b', 'feature');
    gitIn(source, 'commit', '-q', '--allow-empty', '-m', 'on feature');
    gitIn(source, 'checkout', '-q', 'main');
    const bare = join(at, 'docs', 'web.git');
    execFileSync('git', ['clone', '-q', '--bare', source, bare], { env: env() });
    const web = join(at, 'web');
    execFileSync('git', ['clone', '-q', bare, web], { env: env() });
    writeFileSync(join(web, 'notes.txt'), 'mine\n');
    // --track sets the upstream even where git is set not to set one by itself.
    gitIn(web, 'config', 'branch.autoSetupMerge', 'false');
    writeSetting(db, 'repos', [...(getSetting(db, 'repos') ?? []), { path: 'web', base: 'main' }]);
    const head = gitIn(web, 'rev-parse', 'HEAD');

    expect(await saveProjectField(db, 'repoBase:web', 'develop')).toBeNull();

    expect(getSetting(db, 'repos')?.find((repo) => repo.path === 'web')).toEqual({ path: 'web', base: 'develop' });
    expect(gitIn(web, 'rev-parse', '--abbrev-ref', 'develop@{upstream}')).toBe('origin/develop');
    expect(gitIn(web, 'rev-parse', 'develop')).toBe(gitIn(web, 'rev-parse', 'origin/develop'));
    expect(gitIn(web, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(gitIn(web, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitIn(web, 'status', '--porcelain')).toBe('?? notes.txt');

    // A local branch of that name is used as it is, and not made again from origin.
    gitIn(web, 'branch', 'feature', 'main');
    expect(await saveProjectField(db, 'repoBase:web', 'feature')).toBeNull();
    expect(gitIn(web, 'rev-parse', 'feature')).toBe(head);

    // A name on neither side is refused in the old sentence, and no branch is made.
    expect(await saveProjectField(db, 'repoBase:web', 'nope')).toBe('There is no branch nope in the repository web. Type a branch it has, such as the one it is on.');
    expect(gitIn(web, 'branch', '--list', 'nope')).toBe('');
    expect(getSetting(db, 'repos')?.find((repo) => repo.path === 'web')).toEqual({ path: 'web', base: 'feature' });

    // A name with a leading dash would reach git as an option (-f forces), so it is refused and git
    // makes nothing, even when origin has a ref of that name.
    gitIn(web, 'update-ref', 'refs/remotes/origin/-f', 'origin/develop');
    const heads = gitIn(web, 'for-each-ref', '--format=%(refname)', 'refs/heads');
    expect(await saveProjectField(db, 'repoBase:web', '-f')).toBe('There is no branch -f in the repository web. Type a branch it has, such as the one it is on.');
    expect(gitIn(web, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(heads);
  });

  // A teammate clones from the manifest, so a saved base reaches its entry and is committed there.
  it('writes a saved base into the manifest entry and commits it', async () => {
    rootWithApi();
    mkdirSync(join(at, '.nolzu'));
    const manifest = join(at, '.nolzu', 'repositories.json');
    writeFileSync(manifest, `${JSON.stringify({ repositories: [{ folder: 'api', url: 'https://example.invalid/acme/api.git', base: 'main' }] }, null, 2)}\n`);
    gitIn(at, 'add', '-A');
    gitIn(at, 'commit', '-q', '-m', 'manifest');
    for (const [key, value] of Object.entries(env())) if (key.startsWith('GIT_')) vi.stubEnv(key, value);

    expect(await saveProjectField(db, 'repoBase:api', 'develop')).toBeNull();
    vi.unstubAllEnvs();

    expect(JSON.parse(readFileSync(manifest, 'utf8')).repositories).toEqual([{ folder: 'api', url: 'https://example.invalid/acme/api.git', base: 'develop' }]);
    expect(gitIn(at, 'log', '-1', '--format=%s')).toBe('chore: start api from develop');
    expect(gitIn(at, 'status', '--porcelain')).toBe('');
  });

  it('keeps the single base branch in step with the first repository', async () => {
    rootWithApi();
    gitIn(at, 'branch', 'trunk');

    expect(await saveProjectField(db, 'repoBase:.', 'trunk')).toBeNull();
    expect(getSetting(db, 'repos')?.[0]).toEqual({ path: '.', base: 'trunk' });
    expect(getSetting(db, 'baseBranch')).toBe('trunk');
  });

  it('removes a repository, and keeps the project folder and the last one', () => {
    rootWithApi();

    expect(removeProjectRepo(db, '.')).toBe('The project folder is a repository, so it stays in the list. Every card starts in its checkout.');
    expect(removeProjectRepo(db, 'web')).toBe('There is no repository web in this project.');
    expect(removeProjectRepo(db, 'api')).toBeNull();
    expect(getSetting(db, 'repos')).toEqual([{ path: '.', base: 'main' }]);

    writeSetting(db, 'repos', [{ path: 'api', base: 'develop' }]);
    expect(removeProjectRepo(db, 'api')).toBe('The repository api is the last one of the project, so it stays.');

    writeSetting(db, 'repos', null);
    expect(removeProjectRepo(db, '.')).toBe('This project has one repository, so there is none to remove.');
  });

  it('keeps a repository while a card has a checkout of it', () => {
    rootWithApi();
    writeSetting(db, 'repos', [{ path: '.', base: 'main' }, { path: 'api', base: 'main' }, { path: 'web', base: 'main' }]);
    createCard(db, { key: 'APP-7', board: 'delivery', stage: 'implement', title: 'Add a search box' });
    mkdirSync(join(at, 'worktrees', 'APP-7', 'api'), { recursive: true });
    writeFileSync(join(at, 'worktrees', 'APP-7', 'api', '.git'), 'gitdir: elsewhere\n');
    // An empty submodule folder in the root checkout is no checkout.
    mkdirSync(join(at, 'worktrees', 'APP-7', 'web'));

    expect(removeProjectRepo(db, 'api')).toBe("APP-7 has a checkout of api, so api stays. The card's work there would be left out of its changes.");
    expect(removeProjectRepo(db, 'web')).toBeNull();
    expect(getSetting(db, 'repos')?.map((repo) => repo.path)).toEqual(['.', 'api']);
  });

  it('adds the docs repository a rescan finds, and writes its knowledge file', async () => {
    rootWithApi();
    const docs = repoAt(join(at, 'docs'));
    writeFileSync(join(docs, 'package.json'), '{}');

    expect(await rescanRepos(db, env())).toEqual({ said: 'Added docs. Wrote docs/repository.md, run-recipe.md in the knowledge folder.' });
    expect(getSetting(db, 'repos')).toEqual([
      { path: '.', base: 'main' },
      { path: 'api', base: 'main' },
      { path: 'docs', base: 'main' },
    ]);
    const files = join(at, '.nolzu', 'knowledge');
    expect(readFileSync(join(files, 'docs', 'repository.md'), 'utf8')).toContain('Base branch: `main`.');
    // Only the repository the scan added gets a file.
    expect(readdirSync(files).sort()).toEqual(['docs', 'run-recipe.md']);
    expect(gitIn(at, 'log', '-1', '--pretty=%s')).toBe('knowledge: repository files');

    expect(await rescanRepos(db, env())).toEqual({ said: 'Every repository the scan found is in the list already.' });
  });

  it('refuses a new repository with no branch to start from, by name, and adds nothing', async () => {
    rootWithApi();
    const docs = repoAt(join(at, 'docs'));
    gitIn(docs, 'checkout', '-q', '--detach');

    expect(await rescanRepos(db, env())).toEqual({ problem: 'The repository docs is on no branch. Check out the branch cards should start from there, then scan again.' });
    expect(getSetting(db, 'repos')).toHaveLength(2);
  });

  // Its cards have no list, so a list made here would stop each of them at its next implement.
  it('refuses to scan a project of one repository, even when the folder holds another', async () => {
    repoAt(at);
    writeFileSync(join(at, '.gitignore'), '/docs/\n');
    repoAt(join(at, 'docs'));
    writeSetting(db, 'projectPath', at);
    writeSetting(db, 'baseBranch', 'main');

    expect(await rescanRepos(db, env())).toEqual({ problem: 'This project has one repository, so there is no list to add to.' });
    expect(getSetting(db, 'repos')).toBeNull();
  });

  it('puts the project folder first when it became a repository, and refuses it once a card has a checkout', async () => {
    rootWithApi();
    writeSetting(db, 'repos', [{ path: 'api', base: 'main' }]);
    createCard(db, { key: 'APP-8', board: 'delivery', stage: 'implement', title: 'Add a search box' });
    mkdirSync(join(at, 'worktrees', 'APP-8', 'api'), { recursive: true });

    expect(await rescanRepos(db, env())).toEqual({
      problem: "The project folder is a repository now, and its checkout would be each card's root. APP-8 has a checkout already, so nothing was added.",
    });
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'main' }]);

    rmSync(join(at, 'worktrees', 'APP-8'), { recursive: true });
    expect((await rescanRepos(db, env())) as { said: string }).toEqual({ said: 'Added the project folder. Wrote repository.md, run-recipe.md in the knowledge folder.' });
    expect(getSetting(db, 'repos')).toEqual([
      { path: '.', base: 'main' },
      { path: 'api', base: 'main' },
    ]);
  });

  it('never adds the workspace folder itself when it scans a workspace again', async () => {
    rootWithApi();
    writeSetting(db, 'repos', null);
    writeSetting(db, 'workspace', true);
    writeSetting(db, 'repos', []);

    expect(await rescanRepos(db, env())).toMatchObject({ said: expect.stringMatching(/^Added api\./) });
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'main' }]);
  });

  it('draws one row per repository in place of the single field', async () => {
    rootWithApi();

    const body = render(ProjectsList, { props: { row: await projectRow(db), table: await repoTable(db) } }).body;

    expect(body).not.toContain('id="baseBranch"');
    expect(body).toContain('aria-label="Base branch of api"');
    expect(body).toContain('value="repoBase:api"');
    expect(body).toContain('aria-label="Remove api"');
    // The project folder stays, so its row has no button.
    expect(body).not.toContain('aria-label="Remove project folder"');
    expect(text(body)).toContain('Scan again');
    // The help is one info box of three lines above the table. What Remove checks is in its dialog.
    const info = /<div class="info[^"]*" role="note"[\s\S]*?<\/div><\/div>/.exec(body)?.[0] ?? '';
    expect(info.match(/<p>/g)).toHaveLength(3);
    expect(body.indexOf('data-info-box')).toBeLessThan(body.indexOf('<table'));
    expect(text(body)).not.toContain('commits on no remote');
  });

  it('draws the one base field on a project of one repository, and no table', async () => {
    repoAt(at);
    writeSetting(db, 'projectPath', at);

    const row = await projectRow(db);
    const body = render(ProjectsList, { props: { row } }).body;

    expect(row.repos).toBeNull();
    expect(body).toContain('id="baseBranch"');
    expect(body).not.toContain('<table');
    expect(text(body)).not.toContain('Scan again');
  });
});

it('refuses a branch template with no {key}, and stores one that has it', async () => {
  expect(await saveProjectField(db, 'branchTemplate', 'feature/{slug}')).toBe('The branch template must carry {key}, so the branch name carries the card key.');
  expect(await saveProjectField(db, 'branchTemplate', 'feature/{key}-{slug}')).toBeNull();
  expect((await projectRow(db)).branchTemplate).toBe('feature/{key}-{slug}');
});

// Pull requests are the one flow, so the screen has no flow to save and a card stays where it is.
it('saves no Delivery flow', async () => {
  createCard(db, { key: 'APP-1', title: 'Add a search box', board: 'delivery', stage: 'pr-watch' });

  expect(await saveProjectField(db, 'deliveryFlow', 'pull-request')).toBe('There is no setting deliveryFlow on this screen.');
  expect(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'deliveryFlow'").get()).toEqual({ n: 0 });
  expect((db.prepare("SELECT stage FROM cards WHERE key = 'APP-1'").get() as { stage: string }).stage).toBe('pr-watch');

  const page = render(ProjectsList, { props: { row: await projectRow(db) } }).body;
  expect(page).not.toContain('deliveryFlow');
  expect(text(page)).not.toContain('Direct merge');
  expect(text(page)).toContain('A card is delivered as a pull request');
});

it('refuses a key prefix with the rule', async () => {
  const page = await saveProjectField(db, 'localKeyPrefix', 'recipes');

  expect(page).toBe('The key prefix is two to six capital letters, such as APP.');
  expect(await saveProjectField(db, 'localKeyPrefix', 'RCP')).toBeNull();
  expect(getSetting(db, 'localKeyPrefix')).toBe('RCP');
});

// Research numbers its kinds as Q-7 and INV-4, so the project's prefix may not be either, and the
// refusal says which kind holds it.
it('refuses the key prefix of a Research kind with a sentence, and keeps the one stored', async () => {
  expect(await saveProjectField(db, 'localKeyPrefix', 'INV')).toBe('INV is the key prefix of Investigations on Research. Pick another prefix.');
  expect(getSetting(db, 'localKeyPrefix')).toBe('APP');
});

it('refuses a knowledge folder outside any repository, and an empty box goes back to the default', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'nolzu-projects-plain-'));

  expect(await saveProjectField(db, 'knowledgeDir', plain)).toMatch(/is in no git repository/);
  expect(getSetting(db, 'knowledgeDir')).toBeNull();
  expect(await saveProjectField(db, 'knowledgeDir', '')).toBeNull();

  rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('stores a knowledge folder inside the project, and the knowledge screens read it from there', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nolzu-projects-knowledge-'));
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, 'notes'));
  writeSetting(db, 'projectPath', repo);

  expect(await saveProjectField(db, 'knowledgeDir', join(repo, 'notes'))).toBeNull();
  // The same resolveKnowledgeDir call the knowledge page, review and revert make.
  expect((await projectRow(db)).knowledgeFolder).toBe(join(repo, 'notes'));

  expect(await saveProjectField(db, 'knowledgeDir', '')).toBeNull();
  expect((await projectRow(db)).knowledgeFolder).not.toBe(join(repo, 'notes'));

  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The default folder is the placeholder of the box, so it reads with ~ like the other paths.
it('shows the knowledge folder under the home folder with ~', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nolzu-projects-home-'));
  const repo = join(home, 'recipes');
  execFileSync('git', ['init', '-q', repo]);
  writeSetting(db, 'projectPath', repo);
  vi.stubEnv('HOME', home);
  try {
    expect((await projectRow(db)).knowledgeFolder).toMatch(/^~\/recipes\//);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The text box is the whole list, so saving it adds, edits and removes in one step.
it('saves, edits and removes allowed commands, and refuses a wildcard with the line it is on', async () => {
  expect(await saveProjectField(db, 'allowedCommands', 'npm install\nnpm test')).toBeNull();
  expect((await projectRow(db)).allowedCommands).toEqual(['npm install', 'npm test']);

  expect(await saveProjectField(db, 'allowedCommands', 'npm install\nnpm test *')).toBeNull();
  expect(getSetting(db, 'allowedCommands')).toEqual(['npm install', 'npm test *']);

  expect(await saveProjectField(db, 'allowedCommands', 'npm test *')).toBeNull();
  expect(getSetting(db, 'allowedCommands')).toEqual(['npm test *']);

  expect(await saveProjectField(db, 'allowedCommands', 'npm test\n*')).toMatch(/^Line 2: /);
  expect(getSetting(db, 'allowedCommands')).toEqual(['npm test *']);

  expect(await saveProjectField(db, 'allowedCommands', '')).toBeNull();
  expect(getSetting(db, 'allowedCommands')).toEqual([]);

  const said = text(render(ProjectsList, { props: { row: await projectRow(db) } }).body);
  expect(said).toContain('With Claude Code, Implement and QA run only these commands, and an empty list allows none.');
  expect(said).toContain('Cursor runs any command.');
});

// The commands are chips: each has its own remove, and Add sends one command against the list
// as it is stored, so an old page never writes its list back.
it('adds a command chip, refuses a wildcard and a second copy, and removes one chip', async () => {
  writeSetting(db, 'allowedCommands', ['pnpm install']);

  expect(await saveProjectField(db, 'addCommand', ' pnpm test ')).toBeNull();
  expect(getSetting(db, 'allowedCommands')).toEqual(['pnpm install', 'pnpm test']);
  expect(await saveProjectField(db, 'addCommand', 'pnpm test')).toBe('pnpm test is in the list already.');
  expect(await saveProjectField(db, 'addCommand', '*')).toBe('* names no command. Start with the command itself, such as npm test.');
  expect(await saveProjectField(db, 'addCommand', '')).toBe('Type the command to add, such as npm test.');
  expect(getSetting(db, 'allowedCommands')).toEqual(['pnpm install', 'pnpm test']);

  const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;
  expect(body).toContain('aria-label="Remove pnpm test"');
  expect(body).toMatch(/value="removeCommand"[^]*?name="value" value="pnpm install"/);
  expect(body).toContain('value="addCommand"');

  expect(await saveProjectField(db, 'removeCommand', 'pnpm install')).toBeNull();
  expect(getSetting(db, 'allowedCommands')).toEqual(['pnpm test']);
});

// Propose again only adds: the person's own commands keep their place, and a refused pick saves nothing.
it('adds the ticked proposals after the person\'s own commands and removes none', async () => {
  writeSetting(db, 'allowedCommands', ['make e2e', 'uv sync']);

  expect(addCommands(db, ['uv sync', 'uv run pytest', ' composer install '])).toBeNull();
  expect(getSetting(db, 'allowedCommands')).toEqual(['make e2e', 'uv sync', 'uv run pytest', 'composer install']);
  expect(addCommands(db, ['bin/phpunit', '* x'])).toBe('* x names no command. Start with the command itself, such as npm test.');
  expect(addCommands(db, [])).toBe('Tick the commands to add first.');
  expect(getSetting(db, 'allowedCommands')).toEqual(['make e2e', 'uv sync', 'uv run pytest', 'composer install']);

  const body = render(ProjectsList, { props: { row: await projectRow(db), proposal: ['bin/phpunit'] } }).body;
  expect(body).toContain('Propose again');
  expect(body).toMatch(/action="\?\/addCommands"[^]*?name="command" value="bin\/phpunit" checked/);
  expect(text(render(ProjectsList, { props: { row: await projectRow(db) } }).body)).toContain('The list already holds every command your repositories propose.');
});

// Settings, Project, Walls: one entry at a time, each checked by the runner's rule, and a refused
// entry is not saved.
it('adds and removes wall entries, and refuses one that would loosen the wall', async () => {
  writeSetting(db, 'projectPath', project);

  expect(await saveProjectField(db, 'addWall:hidden', ' ~/secrets ')).toBeNull();
  expect(await saveProjectField(db, 'addWall:exceptions', '.env.test')).toBeNull();
  expect(await saveProjectField(db, 'addWall:writable', '~/.gradle')).toBeNull();
  expect(getSetting(db, 'wallLists')).toEqual({ hidden: ['~/secrets'], exceptions: ['.env.test'], writable: ['~/.gradle'] });

  expect(await saveProjectField(db, 'addWall:hidden', '~/secrets')).toBe('~/secrets is in the list already.');
  expect(await saveProjectField(db, 'addWall:exceptions', '~/.ssh/id_ed25519')).toBe('Type the path from the project folder, such as .env.test. ~/.ssh/id_ed25519 is not one.');
  expect(await saveProjectField(db, 'addWall:writable', project)).toBe(`${project} would open the project to a phase that only reads it. Pick a folder outside the project.`);
  expect(await saveProjectField(db, 'addWall:writable', '~/.claude')).toMatch(/an engine's config or hook file/);
  expect(await saveProjectField(db, 'addWall:writable', resolveDataDir(process.env))).toMatch(/would open Nolzu's own data folder\./);
  expect(await saveProjectField(db, 'addWall:hidden', '.tasks')).toMatch(/^\.tasks would hide .*\.tasks, which the run needs\.$/);
  expect(await saveProjectField(db, 'addWall:secrets', 'x')).toBe('There is no wall list secrets.');
  expect(getSetting(db, 'wallLists')).toEqual({ hidden: ['~/secrets'], exceptions: ['.env.test'], writable: ['~/.gradle'] });

  const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;
  expect(text(body)).toContain('See the list on Wall');
  expect(body).toContain('aria-label="Remove ~/.gradle"');
  expect(body).toMatch(/value="removeWall:exceptions"[^]*?name="value" value=".env.test"/);
  expect(body).toContain('value="addWall:hidden"');
  // A refused entry stays in its box with the sentence under it.
  const refused = render(ProjectsList, { props: { row: await projectRow(db), refused: { field: 'addWall:writable', typed: '~/.claude', message: 'Refused here.' } } }).body;
  expect(refused).toMatch(/id="addWall-writable"[^>]*value="~\/\.claude"/);
  expect(refused).toContain('Refused here.');

  expect(await saveProjectField(db, 'removeWall:writable', '~/.gradle')).toBeNull();
  expect(getSetting(db, 'wallLists').writable).toEqual([]);
});

it('removes only the wall entry it is asked to', async () => {
  writeSetting(db, 'projectPath', project);
  expect(await saveProjectField(db, 'addWall:writable', '~/.gradle')).toBeNull();
  expect(await saveProjectField(db, 'addWall:writable', '~/.m2')).toBeNull();
  expect(await saveProjectField(db, 'addWall:hidden', '~/secrets')).toBeNull();
  expect(await saveProjectField(db, 'removeWall:writable', '~/.gradle')).toBeNull();
  expect(getSetting(db, 'wallLists')).toEqual({ hidden: ['~/secrets'], exceptions: [], writable: ['~/.m2'] });
});

it('adds no wall entry while no project is set', async () => {
  expect(getSetting(db, 'projectPath')).toBeNull();
  expect(await saveProjectField(db, 'addWall:hidden', '~/secrets')).toBe('There is no project set, so there is no folder to check the path against.');
  expect(getSetting(db, 'wallLists').hidden).toEqual([]);
});

it('fills the list the first time from the scripts and the lockfile, and never refills an emptied one', async () => {
  const npm = mkdtempSync(join(tmpdir(), 'nolzu-projects-npm-'));
  writeFileSync(join(npm, 'package.json'), JSON.stringify({ scripts: { test: 'ng test', lint: 'ng lint', build: 'ng build', start: 'ng serve' } }));
  writeFileSync(join(npm, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeSetting(db, 'projectPath', npm);

  expect(fillAllowedCommands(db)).toEqual(['pnpm install', 'pnpm test', 'pnpm run lint', 'pnpm run build']);
  expect(getSetting(db, 'allowedCommands')).toEqual(['pnpm install', 'pnpm test', 'pnpm run lint', 'pnpm run build']);

  writeSetting(db, 'allowedCommands', []);

  expect(fillAllowedCommands(db)).toEqual([]);

  rmSync(npm, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('answers /api/projects with this machine\'s project, marked current', () => {
  expect(projectList(db)).toEqual({ projects: [] });

  writeSetting(db, 'projectPath', '/home/dev/recipes');

  expect(projectList(db)).toEqual({ projects: [{ name: 'recipes', lastActivity: null, current: true }] });
});

// Two machines, one project each, on one account. The hub lists both, and each machine marks its own by
// the id it minted. The other one carries the time the hub worked out.
it('answers the whole account once the hub has listed it, with this machine\'s project first', () => {
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'projectId', 'p-1');
  createCard(db, { key: 'APP-1', title: 'Add a search box', board: 'delivery', stage: 'plan' });
  moved('APP-1', '2026-10-07T10:00:00.000Z');
  writeSetting(db, 'accountProjects', [
    { id: 'p-2', name: 'recipe-api', lastActivity: '2026-10-06T08:00:00.000Z' },
    // The hub's copy of this machine's own project. The name and time answered are this machine's own.
    { id: 'p-1', name: 'recipes-old-name', lastActivity: null },
  ]);

  expect(projectList(db)).toEqual({
    projects: [
      { name: 'recipes', lastActivity: '2026-10-07T10:00:00.000Z', current: true },
      { name: 'recipe-api', lastActivity: '2026-10-06T08:00:00.000Z', current: false },
    ],
  });
});

// The list of one. The hub has answered, and the account has this machine's project alone.
it('answers a list of one when the account has one project', () => {
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'projectId', 'p-1');
  writeSetting(db, 'accountProjects', [{ id: 'p-1', name: 'recipes', lastActivity: null }]);

  expect(projectList(db)).toEqual({ projects: [{ name: 'recipes', lastActivity: null, current: true }] });
});

// The open page draws no list of its own. The paid panel draws the one `/api/projects` answers, so the
// list shows once.
it('draws no account list on the page itself', async () => {
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'projectId', 'p-1');
  writeSetting(db, 'accountProjects', [{ id: 'p-2', name: 'recipe-api', lastActivity: null }]);
  const row = await projectRow(db);

  expect(text(render(ProjectsList, { props: { row } }).body)).not.toContain('recipe-api');
});
