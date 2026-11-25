import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';
import { SHAPE_ONE } from '$lib/add-repo.ts';
import { onboardRedirect, projectFilesNotice } from '$lib/onboard.ts';
import type { ProjectRow, RepoRow } from '$lib/projects.ts';

// The keychain is a Map, so the Jira form reaches no keychain on this machine.
const held = vi.hoisted(() => new Map<string, string>());
vi.mock('@nolzu/runner', async (real) => ({
  ...(await real<object>()),
  createKeychain: () => ({
    read: async (name: string) => held.get(name) ?? null,
    write: async (name: string, secret: string) => void held.set(name, secret),
    remove: async (name: string) => void held.delete(name),
  }),
}));

// A fake Jira for the prefix check, so no save here opens a socket.
const jira = vi.hoisted(() => ({ projects: [] as string[], asked: [] as string[] }));
vi.stubGlobal('fetch', async (url: string) => {
  jira.asked.push(url);
  const keys = new URL(url).searchParams.getAll('keys');
  return new Response(JSON.stringify({ values: jira.projects.filter((key) => keys.includes(key)).map((key) => ({ key })) }));
});

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything. Not fake mode: fake mode ignores NOLZU_DATA_DIR on purpose.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-projects-route-'));
process.env.NOLZU_DATA_DIR = dir;

const { actions, load } = await import('./+page.server.ts');
// The load reads the request's Sec-Fetch-Site, so each call carries a request from the page itself.
const own = { request: new Request('http://localhost/settings/project') } as never;
const page = (() => load(own)) as unknown as () => Promise<{ project: ProjectRow; table: Promise<readonly RepoRow[]> }>;
const post = (body: Record<string, string>) => ({ request: new Request('http://localhost/settings/project', { method: 'POST', body: new URLSearchParams(body) }) });
type Answer = { field?: string; saved?: boolean; status?: number; data?: { field: string; typed: string; message: string } };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The first run redirect is the layout's, not this page's, so this is the one thing to prove about it:
// `/settings/project` is not on the list of paths it lets through.
it('sends a machine with no project to New project', () => {
  const db = openDatabase(dir);

  expect(onboardRedirect(db, '/settings/project')).toBe('/new');

  db.close();
});

it('reads the one project on a machine that has one', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  db.close();

  const loaded = await page();
  const row = loaded.project;

  expect(row.name).toBe('recipes');
  expect(row.path).toBe('/home/dev/recipes');
  expect(row.ticketSystem).toBe('local');
  // The folder is not there, so there is no repository to list.
  expect(await loaded.table).toEqual([]);
});

// Client and rate moved to Evidence, so this page refuses them like any field it does not have.
it('answers 400 for the client and the rate, which Evidence saves now', async () => {
  const answer = (await actions.save!(post({ field: 'hourlyRate', value: '80' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(answer.data).toMatchObject({ field: 'hourlyRate', typed: '80', message: 'There is no setting hourlyRate on this screen.' });
});

it('answers a refusal under its own field when there is no folder to show', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', join(dir, 'gone'));
  db.close();

  const answer = (await actions.reveal!(post({}) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(answer.data?.field).toBe('reveal');
  expect(answer.data?.message).toMatch(/^(The folder .*gone is not there any more\.|This machine has no file manager Nolzu can open\. The path is in the Location box\.)$/);
  const back = openDatabase(dir);
  writeSetting(back, 'projectPath', '/home/dev/recipes');
  back.close();
});

// The switch posts through the same save action as every other field. The rail half is in
// rail.test.ts, and the cards half in projects.test.ts. Open pages read every board out of Now's
// snapshot, so a switch tells the loop, and a refused one says nothing.
it('turns a board off and on through the save action, and refuses Delivery with a 400', async () => {
  const { loop } = await import('$lib/loop.ts');
  let told = 0;
  const leave = loop().onChange(() => (told += 1));

  expect(await actions.save!(post({ field: 'board:research', value: 'off' }) as never)).toMatchObject({ field: 'board:research', saved: true });
  expect((await page()).project.boards).toContainEqual({ kind: 'research', label: 'Research', on: false });
  expect(told).toBe(1);

  const refused = (await actions.save!(post({ field: 'board:delivery', value: 'off' }) as never)) as Answer;
  expect(refused.status).toBe(400);
  expect(refused.data?.message).toBe('The Delivery board cannot be turned off.');
  expect(told).toBe(1);

  await actions.save!(post({ field: 'board:research', value: 'on' }) as never);
  leave();
  expect((await page()).project.boards.every((one) => one.on)).toBe(true);
  expect(told).toBe(2);
});

// The one slot this page renders, so the paid package extends this page instead of adding a second
// projects page under /f. Nothing renders this page component in a test, so the source is the check.
it('renders the projects feature slot, and hands the list no plan', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain('<FeaturePanels name="projects" />');
  // The list draws no upgrade line on any plan, so it needs no plan.
  expect(source).not.toContain('free=');
});

// Edit on a row of Start the app saves that repository's answer by the question's own rules, and
// leaves the browser alone.
it('saves one repository answer from Start the app, and refuses own commands with no Start', async () => {
  const refused = (await actions.qaRepo!(post({ repo: '.', choice: 'own', start: ' ' }) as never)) as Answer;
  expect(refused).toMatchObject({ status: 400, data: { field: 'app:.', message: 'Type the command that starts the app in the Start box.' } });

  const answer = (await actions.qaRepo!(post({ repo: '.', choice: 'own', start: 'docker compose up -d', stop: 'docker compose down', status: '' }) as never)) as Answer;
  expect(answer).toMatchObject({ field: 'app:.', saved: true });
  expect((await page()).project.apps).toMatchObject([{ repo: '.', answer: { mode: 'own', start: 'docker compose up -d', stop: 'docker compose down', status: null }, words: 'own commands: docker compose up -d' }]);
  expect((await page()).project.browser.servers).toEqual([]);

  expect(await actions.qaRepo!(post({ repo: 'elsewhere', choice: 'code' }) as never)).toMatchObject({ status: 400, data: { message: 'elsewhere is not a repository of this project.' } });
});

// The QA browser row: Nolzu's own server in the MCP list, Turn off, and Test the browser's refusal. The
// test that starts a server is in browser-test.test.ts.
it("sets up Nolzu's browser in the MCP list and turns it off", async () => {
  // The project folder of this file's database is not on disk, so the list has nowhere to go.
  const gone = (await actions.browserSetup!(post({}) as never)) as Answer;
  expect(gone.data?.message).toContain('is not there');
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-projects-route-folder-'));
  const db = openDatabase(dir);
  const before = getSetting(db, 'projectPath');
  writeSetting(db, 'projectPath', folder);
  const setup = (await actions.browserSetup!(post({}) as never)) as Answer;
  expect(setup).toMatchObject({ field: 'browser', saved: true });
  expect((await page()).project.browser.servers).toEqual(['playwright']);

  await actions.browserOff!(post({}) as never);
  expect((await page()).project.browser.servers).toEqual([]);
  const none = (await actions.browserTest!(post({}) as never)) as Answer;
  expect(none.data?.message).toBe('QA has no browser to test. Set one up first.');
  writeSetting(db, 'projectPath', before);
  db.close();
  rmSync(folder, { recursive: true, force: true });
});

it('answers /api/projects in the shape the paid panel reads', async () => {
  const { GET } = await import('../../api/projects/+server.ts');
  const answer = await (GET as unknown as () => Promise<Response>)();

  expect(await answer.json()).toEqual({ projects: [{ name: 'recipes', lastActivity: null, current: true }] });
});

// The list of repositories is this page's own business, and the paid panel reads the same shape.
it('removes a repository through its row, and keeps the /api/projects shape on a project with a list', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'master' },
  ]);
  db.close();

  const refused = (await actions.remove!(post({ repo: 'docs' }) as never)) as Answer;
  expect(refused.status).toBe(400);
  expect(refused.data).toEqual({ field: 'remove:docs', message: 'There is no repository docs in this project. Nothing was removed.' });
  // The typed name is checked on the server, so a post without it removes nothing.
  const untyped = (await actions.remove!(post({ repo: 'web' }) as never)) as Answer;
  expect(untyped.status).toBe(400);
  expect(untyped.data).toEqual({ field: 'remove:web', message: 'To remove web, type its folder name web exactly. Nothing was removed.' });
  // The project folder is not on disk here, so there is no clone to delete and the list is all that changes.
  expect(await actions.remove!(post({ repo: 'web', typed: 'web' }) as never)).toEqual({ field: 'remove:web', said: 'Removed web. Its knowledge file web/repository.md stays.' });
  expect((await page()).project.repos).toEqual([{ path: 'api', base: 'main' }]);

  const { GET } = await import('../../api/projects/+server.ts');
  const answer = await (GET as unknown as () => Promise<Response>)();
  expect(await answer.json()).toEqual({ projects: [{ name: 'recipes', lastActivity: null, current: true }] });

  const after = openDatabase(dir);
  writeSetting(after, 'repos', null);
  after.close();
});

// A machine set up before the list existed gets its first one when this page loads, where the
// person sees it before a run uses it.
it('fills the allowed commands of a project that has none when the page loads', async () => {
  const project = mkdtempSync(join(tmpdir(), 'nolzu-projects-fill-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'allowedCommands', null);
  db.close();

  expect((await page()).project.allowedCommands).toEqual(['npm install', 'npm test']);

  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A workspace proposes from every repository, each command once, and Propose again offers only what
// the list does not hold. The page never takes the person's own commands away.
it('proposes from every repository of a workspace and adds the ticked ones', async () => {
  const project = mkdtempSync(join(tmpdir(), 'nolzu-projects-propose-'));
  mkdirSync(join(project, 'shop', 'bin'), { recursive: true });
  for (const file of ['composer.json', 'phpunit.xml.dist', 'bin/console', 'Makefile']) writeFileSync(join(project, 'shop', file), '');
  mkdirSync(join(project, 'api'));
  for (const file of ['pyproject.toml', 'uv.lock', 'Makefile']) writeFileSync(join(project, 'api', file), '');
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'repos', [
    { path: 'shop', base: null },
    { path: 'api', base: null },
  ]);
  writeSetting(db, 'allowedCommands', null);
  db.close();

  const first = (await page()) as unknown as { project: ProjectRow; proposal: string[] };
  expect(first.project.allowedCommands).toEqual([
    'composer install',
    'vendor/bin/phpunit',
    'bin/console lint:container',
    'bin/console lint:yaml config',
    'bin/console lint:twig templates',
    'make test',
    'uv sync',
    'uv run pytest',
  ]);
  expect(first.proposal).toEqual([]);

  const mine = openDatabase(dir);
  writeSetting(mine, 'allowedCommands', ['make e2e']);
  mine.close();
  const again = (await page()) as unknown as { proposal: string[] };
  expect(again.proposal).toContain('uv run pytest');
  expect(again.proposal).not.toContain('make e2e');

  const body = new URLSearchParams([
    ['command', 'uv sync'],
    ['command', 'uv run pytest'],
  ]);
  const answer = await actions.addCommands!({ request: new Request('http://localhost/settings/project', { method: 'POST', body }) } as never);
  expect(answer).toEqual({ field: 'addCommands', saved: true });
  const after = openDatabase(dir);
  expect(getSetting(after, 'allowedCommands')).toEqual(['make e2e', 'uv sync', 'uv run pytest']);
  // Adding commands confirms the list, the step of Set up the project.
  expect(getSetting(after, 'setupSteps')).toEqual({ commands: 'done' });
  writeSetting(after, 'repos', null);
  after.close();

  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// "The list is right" confirms the command list as it is.
it('confirms the command list for Set up the project', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'setupSteps', {});
  db.close();
  expect(((await load(own)) as unknown as { project: ProjectRow }).project.commandsConfirmed).toBe(false);
  expect(await actions.confirmCommands!({} as never)).toEqual({ field: 'confirmCommands', saved: true });
  const after = openDatabase(dir);
  expect(getSetting(after, 'setupSteps')).toEqual({ commands: 'done' });
  writeSetting(after, 'setupSteps', null);
  after.close();
});

// A chip added or removed is a change to the list, so it confirms the list too. A refused one does not.
it('confirms the command list when a chip is added', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'setupSteps', {});
  const before = getSetting(db, 'allowedCommands');
  db.close();
  expect(((await actions.save!(post({ field: 'addCommand', value: '' }) as never)) as Answer).status).toBe(400);
  const refused = openDatabase(dir);
  expect(getSetting(refused, 'setupSteps')).toEqual({});
  refused.close();
  await actions.save!(post({ field: 'addCommand', value: 'make lint' }) as never);
  const after = openDatabase(dir);
  expect(getSetting(after, 'setupSteps')).toEqual({ commands: 'done' });
  writeSetting(after, 'setupSteps', null);
  writeSetting(after, 'allowedCommands', before);
  after.close();
});

// The action hands back the sentence of the checkout removal, under its own field.
it('answers the checkouts action with what the removal said', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', null);
  db.close();

  const answer = (await actions.checkouts!(post({}) as never)) as { field: string; said: string };

  expect(answer).toEqual({ field: 'checkouts', said: 'There is no project set, so there is no checkout to remove.' });
});

// The run guard and the rules have a button here, for a project made before New project wrote them.
it('writes the project files through the files action, and says what it did under its own field', async () => {
  const project = mkdtempSync(join(tmpdir(), 'nolzu-projects-files-'));
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', null);
  db.close();

  expect(await actions.files!(post({}) as never)).toEqual({ status: 400, data: { field: 'files', message: 'There is no project set, so nothing was written.' } });

  const set = openDatabase(dir);
  writeSetting(set, 'projectPath', project);
  set.close();
  const answer = (await actions.files!(post({}) as never)) as { field: string; said: string };

  expect(answer.field).toBe('files');
  expect(answer.said).toMatch(/^Wrote .*CLAUDE\.md/);
  expect(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).toContain('PreToolUse');

  // The notice in the app reads the counts: an untouched old file is written again, a hand edit kept.
  const record = join(project, '.agents', 'skills', '.nolzu-skills.json');
  writeFileSync(join(project, '.agents', 'skills', 'nolzu-refine', 'SKILL.md'), 'An older method.\n');
  writeFileSync(record, JSON.stringify({ ...(JSON.parse(readFileSync(record, 'utf8')) as object), 'nolzu-refine/SKILL.md': createHash('sha256').update('An older method.\n').digest('hex') }));
  writeFileSync(join(project, '.claude', 'skills', 'nolzu-plan', 'SKILL.md'), 'My own plan.\n');
  const again = (await actions.files!(post({}) as never)) as { updated: number; handEdited: number; project: string };

  expect(again).toMatchObject({ updated: 1, handEdited: 1, project: basename(project) });
  expect(readFileSync(join(project, '.claude', 'skills', 'nolzu-plan', 'SKILL.md'), 'utf8')).toBe('My own plan.\n');
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A folder in no repository: git holds none of the person's text, so Take the new one asks first.
it('lists the files changed by hand, keeps one and takes the other after the ask', async () => {
  const project = mkdtempSync(join(tmpdir(), 'nolzu-projects-hand-'));
  const set = openDatabase(dir);
  writeSetting(set, 'projectPath', project);
  set.close();
  await actions.files!(post({}) as never);
  // A board cached the status before the hand edits, as the layout does on every load.
  const cache = openDatabase(dir);
  expect(projectFilesNotice(cache)?.yours).toEqual([]);
  cache.close();
  const plan = '.agents/skills/nolzu-plan/SKILL.md';
  const qa = '.claude/skills/nolzu-qa/SKILL.md';
  writeFileSync(join(project, plan), 'My own plan.\n');
  writeFileSync(join(project, qa), 'My own QA.\n');
  // Streamed, so the load hands a promise and the page draws before git makes the patches.
  const edits = async () => ((await load(own)) as { handEdits: Promise<{ path: string; unsaved: boolean }[]> }).handEdits;

  // The page's status lines read the status this load refreshed, never the layout's cached one.
  const first = (await load(own)) as { handEdits: Promise<{ path: string; unsaved: boolean }[]>; projectFiles: { yours: string[] } | null };
  expect((await first.handEdits).map((one) => [one.path, one.unsaved])).toEqual([[plan, true], [qa, true]]);
  expect(first.projectFiles?.yours).toEqual([plan, qa]);

  expect(await actions.keep!(post({ path: plan }) as never)).toEqual({ field: 'files', said: `Kept your ${plan}. Nolzu asks again when it ships a new text for it.` });
  expect(await actions.take!(post({ path: qa }) as never)).toEqual({ status: 400, data: { field: `take:${qa}`, message: `git has not committed your changes to ${qa}. Taking the new one loses them.`, ask: true } });
  expect(readFileSync(join(project, qa), 'utf8')).toBe('My own QA.\n');
  expect(await actions.take!(post({ path: qa, sure: '1' }) as never)).toEqual({ field: 'files', said: `Wrote Nolzu's text to ${qa}. Commit it.` });

  expect(readFileSync(join(project, qa), 'utf8')).toContain('name: nolzu-qa');
  expect(readFileSync(join(project, plan), 'utf8')).toBe('My own plan.\n');
  expect(await edits()).toEqual([]);
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Each answer comes back under its own field. A project of one repository has no list to add to.
it('refuses the add and clone actions on a project of one repository, under their own fields', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'repos', null);
  db.close();

  const added = (await actions.add!(post({ url: 'https://example.com/team/api.git' }) as never)) as Answer;
  expect(added.status).toBe(400);
  expect(added.data?.field).toBe('add');
  expect(added.data?.message).toMatch(/^This project has one repository, so there is no list to add another one to\./);
  const cloned = (await actions.clone!(post({}) as never)) as Answer;
  expect(cloned.status).toBe(400);
  expect(cloned.data?.field).toBe('clone');
  expect(cloned.data?.message).toBe(SHAPE_ONE);
  // A row's Clone posts its folder, and is refused the same way.
  expect(await actions.clone!(post({ folder: 'web' }) as never)).toMatchObject({ status: 400, data: { field: 'clone', message: SHAPE_ONE } });
});

// Learn this project answers under its own field. Nothing starts here: this route runs on the real
// engine, and the run is proved against the fake one in orient-run.test.ts.
it('refuses Learn this project for a repository the project does not have, under its own field', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'repos', [{ path: 'web', base: 'main' }]);
  db.close();

  const learned = (await actions.learn!(post({ repo: 'api' }) as never)) as Answer;
  expect(learned.status).toBe(400);
  expect(learned.data?.field).toBe('learn');
  expect(learned.data?.message).toMatch(/no repository "api" in this project/);
});

// The folder a row's Clone posts reaches the clone. A folder the manifest does not name as missing is
// refused, and the same post with no folder clones every missing one and has nothing to say here.
it('hands a row\'s folder to the clone, so a folder the manifest does not name is refused', async () => {
  const project = mkdtempSync(join(tmpdir(), 'nolzu-clone-route-'));
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', [{ path: 'web', base: 'main' }]);
  db.close();

  expect(await actions.clone!(post({ folder: 'ghost' }) as never)).toMatchObject({ status: 400, data: { field: 'clone', message: expect.stringContaining('names no missing folder ghost') } });
  expect(await actions.clone!(post({}) as never)).toMatchObject({ field: 'clone', said: expect.stringContaining('on disk already') });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const after = openDatabase(dir);
  writeSetting(after, 'workspace', null);
  after.close();
});

// The answer comes back under its own field, and a refusal changes nothing.
it('refuses the convert action under its own field when the project folder is no repository', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'repos', null);
  db.close();

  const answer = (await actions.convert!(post({ parent: dir, name: 'shop' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(answer.data?.field).toBe('convert');
  expect(answer.data?.message).toBe('/home/dev/recipes is not a git repository, so there is no repository to move. Nothing was changed.');
});

// Two machines on one account. Once the personal hub has listed the projects, `/api/projects` answers
// the whole list for the paid panel. The page load carries no list of its own, so the list draws once.
it('answers /api/projects with the whole account once the hub has listed it', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectId', 'p-1');
  writeSetting(db, 'accountProjects', [
    { id: 'p-1', name: 'recipes', lastActivity: null },
    { id: 'p-2', name: 'recipe-api', lastActivity: '2026-10-06T08:00:00.000Z' },
  ]);
  db.close();

  const { GET } = await import('../../api/projects/+server.ts');
  expect(await (await (GET as unknown as () => Promise<Response>)()).json()).toEqual({
    projects: [
      { name: 'recipes', lastActivity: null, current: true },
      { name: 'recipe-api', lastActivity: '2026-10-06T08:00:00.000Z', current: false },
    ],
  });
  expect(Object.keys((await page()) as object)).toEqual(['project', 'table', 'branches', 'found', 'billing', 'handEdits', 'projectFiles', 'proposal']);
});

// Ask again on a row takes back that repository's answer, and Ask again under the rows takes back all.
it('takes back one QA answer, or every one', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'qaApp', { '.': { mode: 'running', address: 'localhost:5173' }, '*': { mode: 'code' } });
  expect((await page()).project.apps.map((one) => [one.repo, one.words])).toEqual([
    ['*', 'code only'],
    ['.', 'already running at localhost:5173'],
  ]);

  expect(await actions.qaClear!(post({ repo: 'elsewhere' }) as never)).toMatchObject({ status: 400, data: { message: 'elsewhere is not a repository of this project.' } });
  expect(await actions.qaClear!(post({ repo: '.' }) as never)).toMatchObject({ field: 'app:.', saved: true });
  expect(getSetting(db, 'qaApp')).toEqual({ '*': { mode: 'code' } });
  expect((await page()).project.apps.map((one) => one.words)).toEqual(['code only', 'same as every repository']);

  expect(await actions.qa!(post({}) as never)).toMatchObject({ field: 'qa', saved: true });
  expect(getSetting(db, 'qaApp')).toBeNull();
  db.close();
});

// Which system the project reads, both ways. The Jira login is the machine's, from Settings,
// Integrations, and a switch to Jira or a new prefix asks the fake Jira about the prefix.
it('switches the ticket system both ways once Jira is connected, and keeps what Jira says of the prefix', async () => {
  expect(await actions.tickets!(post({ value: 'jira' }) as never)).toMatchObject({ status: 400, data: { field: 'tickets', message: expect.stringMatching(/Connect Jira first in Settings, Integrations/) } });

  const db = openDatabase(dir);
  const before = getSetting(db, 'localKeyPrefix');
  writeSetting(db, 'jiraSite', 'https://you.atlassian.net');
  writeSetting(db, 'jiraEmail', 'dana@example.com');
  writeSetting(db, 'localKeyPrefix', 'WORK');
  held.set('jira-token', 'ATATT3xFfGF0-recipe-token');
  jira.projects = ['WORK'];

  expect(await actions.tickets!(post({ value: 'jira' }) as never)).toEqual({ field: 'tickets', saved: true });
  expect((await page()).project).toMatchObject({ ticketSystem: 'jira', keyClash: { prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WRK' } });
  // The answer is about one prefix at one site, so another of either shows no warning until Jira is asked.
  writeSetting(db, 'localKeyPrefix', 'WOR');
  expect((await page()).project.keyClash).toBeNull();
  writeSetting(db, 'localKeyPrefix', 'WORK');
  writeSetting(db, 'jiraSite', 'https://kitchen.atlassian.net');
  expect((await page()).project.keyClash).toBeNull();
  writeSetting(db, 'jiraSite', 'https://you.atlassian.net');

  expect(await actions.save!(post({ field: 'localKeyPrefix', value: 'WRK' }) as never)).toEqual({ field: 'localKeyPrefix', saved: true });
  expect((await page()).project.keyClash).toBeNull();
  expect(jira.asked).toHaveLength(2);

  expect(await actions.tickets!(post({ value: 'local' }) as never)).toEqual({ field: 'tickets', saved: true });
  expect((await page()).project.ticketSystem).toBe('local');
  // A project that reads no Jira asks it nothing.
  expect(await actions.save!(post({ field: 'localKeyPrefix', value: before }) as never)).toEqual({ field: 'localKeyPrefix', saved: true });
  expect(jira.asked).toHaveLength(2);
  db.close();
});

// Client and rate on this page saves the three fields together, as Evidence does, and a refusal keeps
// what was typed.
it('saves the client, the rate and the currency through bill, and refuses a rate that is no number', async () => {
  expect(await actions.bill!(post({ client: 'Recipe Co', rate: '80', currency: 'eur' }) as never)).toEqual({ field: 'bill', saved: true });
  const db = openDatabase(dir);
  expect([getSetting(db, 'clientName'), getSetting(db, 'hourlyRate'), getSetting(db, 'currency')]).toEqual(['Recipe Co', 80, 'EUR']);
  db.close();
  expect((await page()) as unknown as { billing: unknown }).toMatchObject({ billing: { clientName: 'Recipe Co', hourlyRate: 80, currency: 'EUR' } });

  const refused = (await actions.bill!(post({ client: 'Other', rate: 'lots', currency: 'USD' }) as never)) as { status: number; data: { field: string; message: string; bill: unknown } };
  expect(refused.status).toBe(400);
  expect(refused.data).toMatchObject({ field: 'bill', bill: { client: 'Other', rate: 'lots', currency: 'USD' } });
  const after = openDatabase(dir);
  expect(getSetting(after, 'clientName')).toBe('Recipe Co');
  after.close();
});

// The found list scans ~/code, ~/projects and ~/src of the home folder, and only a project with a
// repository table gets one.
it('offers a repository found under the home folder by its remote, and none to a project of one repository', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nolzu-found-home-'));
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of ['recipes-scripts', 'dotfiles']) {
    mkdirSync(join(home, 'code', name), { recursive: true });
    execFileSync('git', ['init', '-q', join(home, 'code', name)], { env });
  }
  execFileSync('git', ['-C', join(home, 'code', 'recipes-scripts'), 'remote', 'add', 'origin', 'https://github.com/example/recipes-scripts.git'], { env });
  vi.stubEnv('HOME', home);
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  writeSetting(db, 'repos', null);
  db.close();

  expect(((await page()) as unknown as { found: unknown }).found).toEqual([]);

  const listed = openDatabase(dir);
  writeSetting(listed, 'repos', [{ path: 'web', base: 'main' }]);
  listed.close();
  expect(await ((await page()) as unknown as { found: Promise<unknown> }).found).toEqual([{ path: '~/code/recipes-scripts', url: 'https://github.com/example/recipes-scripts.git' }]);

  vi.unstubAllEnvs();
  const back = openDatabase(dir);
  writeSetting(back, 'repos', null);
  back.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
