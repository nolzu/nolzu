import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { repoKnowledge, runRecipe } from '@nolzu/core';
import { boardVersion, cardRepos, createCard, getSetting, knowledgeChange, openDatabase, recordKnowledgeChanges, setCardRepos, startRun, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revertable } from './knowledge-revert.ts';
import { MANIFEST } from './manifest.ts';
import { projectRow } from './projects.ts';
import ProjectsList from './ProjectsList.svelte';
import { makeThisAWorkspace, WORKSPACE_NOTE, workspaceNote } from './to-workspace.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';

// The Walls box links to Settings, Wall, so the page says where it is drawn.
drawnAt('/settings/project');

// Every path sits in `home`, a temp folder removed after each test.
let home = '';
let db: DatabaseSync;
const env = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const inGit = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { env: env(), encoding: 'utf8' }).trim();
const at = (...parts: string[]) => join(home, ...parts);
const card = (key: string) => createCard(db, { key, board: 'delivery', stage: 'plan', title: `Card ${key}`, summary: null, source: 'local', sourceRef: null });
const convert = (name = 'recipes', options: Parameters<typeof makeThisAWorkspace>[2] = {}) => makeThisAWorkspace(db, { parent: home, name, home }, { env: env(), ...options });

// One repository at `app`, set up the way onboarding leaves a project of one repository, with a
// branch on no remote, a knowledge file and the change row that wrote it, and two cards.
let sha = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nolzu-to-workspace-'));
  db = openDatabase(at('data'));
  const app = at('app');
  execFileSync('git', ['init', '-q', '-b', 'main', app], { env: env() });
  mkdirSync(join(app, '.nolzu', 'knowledge'), { recursive: true });
  writeFileSync(join(app, '.nolzu', 'knowledge', 'stack.md'), 'The app runs on port 5173.\n');
  inGit(app, 'add', '-A');
  inGit(app, 'commit', '-q', '-m', 'first');
  sha = inGit(app, 'rev-parse', 'HEAD');
  inGit(app, 'branch', 'feature');
  inGit(app, 'remote', 'add', 'origin', 'https://example.com/team/app.git');
  writeSetting(db, 'projectPath', app);
  writeSetting(db, 'baseBranch', 'main');
  writeSetting(db, 'teamProjectId', 'team-7');
  writeSetting(db, 'qaMcpConfigPath', join(app, 'qa', 'mcp.json'));
  writeSetting(db, 'qaApp', { '*': { mode: 'own', start: `${app}/scripts/up.sh {key}`, stop: null, status: null } });
  card('APP-1');
  card('APP-2');
  // A person's pick in a project of one repository can only be the project folder.
  setCardRepos(db, 'APP-2', ['.'], 'person');
  mkdirSync(join(app, '.tasks', 'APP-1'), { recursive: true });
  writeFileSync(join(app, '.tasks', 'APP-1', 'plan.md'), 'Add a search box.\n');
  const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'claude-code', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(runId);
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: sha, status: 'applied', files: [{ path: '.nolzu/knowledge/stack.md', summary: null }] });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('making a project of one repository a workspace', () => {
  it('moves the repository in with its branches and rewrites what held the old path', async () => {
    const answer = await convert();
    const ws = at('recipes');
    const app = join(ws, 'app');

    expect(answer).toEqual({
      said: `Moved ${at('app')} to ${app}. Copied 1 knowledge file into the workspace's knowledge folder and committed it. Moved the card folders to ${join(ws, '.tasks')}. 2 cards work in app now.`,
    });
    // Moved, not copied: the old folder is gone and the repository keeps every branch.
    expect(existsSync(at('app'))).toBe(false);
    expect(inGit(app, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['feature', 'main']);
    expect(inGit(app, 'rev-parse', 'HEAD')).toBe(sha);

    expect(getSetting(db, 'projectPath')).toBe(ws);
    expect(getSetting(db, 'workspace')).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([{ path: 'app', base: 'main' }]);
    expect(getSetting(db, 'baseBranch')).toBe('main');
    expect(getSetting(db, 'teamProjectId')).toBe('team-7');
    expect(getSetting(db, 'qaMcpConfigPath')).toBe(join(app, 'qa', 'mcp.json'));
    // Free text, shown with a note and never rewritten.
    expect(getSetting(db, 'qaApp')?.['*']).toEqual({ mode: 'own', start: `${at('app')}/scripts/up.sh {key}`, stop: null, status: null });

    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['app'], by: 'plan' });
    expect(cardRepos(db, 'APP-2')).toEqual({ repos: ['app'], by: 'plan' });

    expect(readFileSync(join(ws, '.tasks', 'APP-1', 'plan.md'), 'utf8')).toBe('Add a search box.\n');
    expect(existsSync(join(app, '.tasks'))).toBe(false);

    expect(readFileSync(join(ws, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/app/\n');
    expect(JSON.parse(readFileSync(join(ws, MANIFEST), 'utf8'))).toEqual({ workspace: true, repositories: [{ folder: 'app', url: 'https://example.com/team/app.git', base: 'main' }] });
    // A note of the project folder's repository is the moved repository's note now.
    expect(readFileSync(join(ws, '.nolzu', 'knowledge', 'app', 'stack.md'), 'utf8')).toBe('The app runs on port 5173.\n');
    expect(inGit(ws, 'ls-files', '.nolzu/knowledge').split('\n')).toEqual(['.nolzu/knowledge/app/repository.md', '.nolzu/knowledge/app/stack.md', '.nolzu/knowledge/run-recipe.md']);
    expect(inGit(ws, 'status', '--porcelain')).toBe('');
    // The old files stay in the repository, where its commits name them.
    expect(existsSync(join(app, '.nolzu', 'knowledge', 'stack.md'))).toBe(true);
  });

  // The project folder's files would tell every run to install, test and change code in the workspace folder.
  it('renames the run recipe section and the repository file of the project folder for the folder the repository moved to', async () => {
    const app = at('app');
    writeFileSync(join(app, '.nolzu', 'knowledge', 'run-recipe.md'), runRecipe([{ path: '.', scripts: { test: 'vitest' }, files: ['package.json'] }], null) ?? '');
    const learned = repoKnowledge({ path: '.', base: 'main' }).replace('Nobody has written what this repository is for yet. A run that learns it writes it here.', 'The app serves the recipe list.');
    writeFileSync(join(app, '.nolzu', 'knowledge', 'repository.md'), learned);
    inGit(app, 'add', '-A');
    inGit(app, 'commit', '-q', '-m', 'recipe');

    await convert();

    const knowledge = join(at('recipes'), '.nolzu', 'knowledge');
    const recipe = readFileSync(join(knowledge, 'run-recipe.md'), 'utf8');
    expect(recipe).toContain('## The app repository\n\nRun these in the `app` folder of the project.\n\n- Install: `npm install`');
    expect(recipe).not.toContain('## The project folder');
    expect(recipe.match(/## The app repository/g)).toHaveLength(1);
    // One file for the one repository, with what a run learned kept.
    expect(readdirSync(join(knowledge, 'app')).sort()).toEqual(['repository.md', 'stack.md']);
    expect(existsSync(join(knowledge, 'repository.md'))).toBe(false);
    const file = readFileSync(join(knowledge, 'app', 'repository.md'), 'utf8');
    expect(file).toContain('description: Read before you change the app repository.');
    expect(file).toContain('# The app repository\n\n- Folder: `app` in the project folder.\n- Base branch: `main`.\n\nThe app serves the recipe list.');
    expect(inGit(at('recipes'), 'status', '--porcelain')).toBe('');
  });

  // A project that never moved to the newer knowledge layout still has its file at repositories/project-root.md.
  it('gives the moved repository the project folder file of the older layout', async () => {
    const app = at('app');
    mkdirSync(join(app, '.nolzu', 'knowledge', 'repositories'));
    const learned = repoKnowledge({ path: '.', base: 'main' }).replace('Nobody has written what this repository is for yet. A run that learns it writes it here.', 'The app serves the recipe list.');
    writeFileSync(join(app, '.nolzu', 'knowledge', 'repositories', 'project-root.md'), learned);
    inGit(app, 'add', '-A');
    inGit(app, 'commit', '-q', '-m', 'old layout');

    await convert();

    const knowledge = join(at('recipes'), '.nolzu', 'knowledge');
    expect(existsSync(join(knowledge, 'repositories'))).toBe(false);
    expect(readFileSync(join(knowledge, 'app', 'repository.md'), 'utf8')).toContain('- Folder: `app` in the project folder.\n- Base branch: `main`.\n\nThe app serves the recipe list.');
  });

  it('marks the old knowledge history, so Revert says it cannot act on it', async () => {
    await convert();
    const row = knowledgeChange(db, 1);
    const folder = join(at('recipes'), 'app', '.nolzu', 'knowledge');

    expect(row?.movedFrom).toBe(folder);
    const said = revertable(row, 1);
    expect(said.ok ? '' : said.message).toBe(
      `The change to .nolzu/knowledge/stack.md was committed in ${folder}, before this project became a workspace. Commit ${sha.slice(0, 7)} is not in the knowledge folder in use now, so Nolzu cannot revert it here. Revert it in that folder with git revert.`,
    );
  });

  it('keeps a knowledge folder outside the old one, and its history', async () => {
    const kb = at('kb');
    execFileSync('git', ['init', '-q', '-b', 'main', kb], { env: env() });
    writeSetting(db, 'knowledgeDir', kb);

    const answer = await convert();

    expect('said' in answer && answer.said).toContain(`The knowledge folder ${kb} stays where it is.`);
    expect(getSetting(db, 'knowledgeDir')).toBe(kb);
    expect(knowledgeChange(db, 1)?.movedFrom).toBeNull();
  });
  // A step after the rename that fails is named, and nothing is removed: the answer says how to undo.
  it('says what was moved and how to move it back when a step after the move fails', async () => {
    chmodSync(at('app', '.nolzu', 'knowledge', 'stack.md'), 0o000);
    const ws = at('recipes');

    const answer = await convert();
    chmodSync(join(ws, 'app', '.nolzu', 'knowledge', 'stack.md'), 0o644);

    expect('problem' in answer).toBe(true);
    const said = 'problem' in answer ? answer.problem : '';
    expect(said.startsWith(`Moved ${at('app')} to ${join(ws, 'app')}.`)).toBe(true);
    expect(said).toContain('Copying the knowledge files failed.');
    expect(
      said.endsWith(
        `Nothing was deleted. To move it back, run mv '${join(ws, 'app')}' '${at('app')}' and mv '${join(ws, '.tasks')}' '${at('app', '.tasks')}', then make a new project at /new and add the repository there by its URL. After that, set the team link again. The cards keep app as their repository, and older knowledge changes cannot be reverted on the Knowledge page.`,
      ),
    ).toBe(true);
    expect(existsSync(join(ws, 'app', '.git'))).toBe(true);
    expect(getSetting(db, 'projectPath')).toBe(ws);
    // The steps after the failed one still ran.
    expect(knowledgeChange(db, 1)?.movedFrom).toBe(join(ws, 'app', '.nolzu', 'knowledge'));
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['app'], by: 'plan' });
    expect(existsSync(join(ws, '.nolzu', 'knowledge', 'app', 'repository.md'))).toBe(true);

    // The project has its list by now, so the page draws the workspace, and the answer has to show there.
    const html = render(ProjectsList, { props: { row: await projectRow(db), refused: { field: 'convert', message: said } } }).body;
    expect(html).toContain('role="alert"');
    expect(html).toContain(`To move it back, run mv '${join(ws, 'app')}'`);
  });

  it('moves a knowledge folder under the old one into the workspace default, and leaves a QA config outside alone', async () => {
    const app = at('app');
    mkdirSync(join(app, 'docs', 'kb'), { recursive: true });
    writeFileSync(join(app, 'docs', 'kb', 'run.md'), 'Start it with the up script.\n');
    inGit(app, 'add', '-A');
    inGit(app, 'commit', '-q', '-m', 'kb');
    writeSetting(db, 'knowledgeDir', join(app, 'docs', 'kb'));
    writeSetting(db, 'qaMcpConfigPath', at('qa.json'));
    const ws = at('recipes');

    expect('said' in (await convert())).toBe(true);

    expect(getSetting(db, 'knowledgeDir')).toBeNull();
    expect(getSetting(db, 'qaMcpConfigPath')).toBe(at('qa.json'));
    expect(inGit(ws, 'ls-files', '.nolzu/knowledge/app/run.md')).toBe('.nolzu/knowledge/app/run.md');
    expect(knowledgeChange(db, 1)?.movedFrom).toBe(join(ws, 'app', 'docs', 'kb'));
  });

  // The answer to the question at the first QA named the project folder. Left as it was, QA would run the
  // start command in the workspace's card folder, which has no package.json.
  it('points the start command QA runs at the moved repository', async () => {
    writeSetting(db, 'qaApp', { '.': { mode: 'dev', command: 'npm run dev', repo: '.' } });

    expect('said' in (await convert())).toBe(true);

    expect(getSetting(db, 'qaApp')).toEqual({ app: { mode: 'dev', command: 'npm run dev', repo: 'app' } });
  });

  // Every other test names the repository app, which hides a folder name written in as a literal.
  it('keeps the repository folder name of any project, in the path, the list and every card', async () => {
    renameSync(at('app'), at('shop'));
    writeSetting(db, 'projectPath', at('shop'));
    const version = boardVersion(db);
    const ws = at('recipes');

    expect('said' in (await convert())).toBe(true);

    expect(inGit(join(ws, 'shop'), 'rev-parse', 'HEAD')).toBe(sha);
    expect(getSetting(db, 'repos')).toEqual([{ path: 'shop', base: 'main' }]);
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['shop'], by: 'plan' });
    expect(cardRepos(db, 'APP-2')).toEqual({ repos: ['shop'], by: 'plan' });
    expect(knowledgeChange(db, 1)?.movedFrom).toBe(join(ws, 'shop', '.nolzu', 'knowledge'));
    // The board redraws with the new lists.
    expect(boardVersion(db)).toBeGreaterThan(version);
  });

  it('refuses a second time, once the project has its list', async () => {
    expect('said' in (await convert())).toBe(true);

    expect(await convert('again')).toEqual({ problem: 'This project has a list of repositories already. Add one in Settings, Project. Nothing was changed.' });
    expect(existsSync(at('again'))).toBe(false);
    expect(existsSync(at('recipes', 'app', '.git'))).toBe(true);
  });
});

describe('what stops the move before anything is changed', () => {
  const untouched = () => {
    expect(getSetting(db, 'projectPath')).toBe(at('app'));
    expect(getSetting(db, 'repos')).toBeNull();
    expect(getSetting(db, 'workspace')).toBeNull();
    expect(getSetting(db, 'teamProjectId')).toBe('team-7');
    expect(existsSync(at('app', '.git'))).toBe(true);
    expect(existsSync(at('recipes'))).toBe(false);
  };

  it('refuses while a card has a checkout', async () => {
    mkdirSync(at('app', 'worktrees', 'APP-1'), { recursive: true });

    expect(await convert()).toEqual({
      problem: `APP-1 has a checkout in ${at('app', 'worktrees')}, and a move would break it. Remove the checkouts of closed cards first, or finish the card. Nothing was changed.`,
    });
    untouched();
  });

  // APP-1 is the first card, so only a second card proves the sentence names the one that holds it.
  it('names the card that has the checkout', async () => {
    mkdirSync(at('app', 'worktrees', 'APP-2'), { recursive: true });

    expect(await convert()).toEqual({
      problem: `APP-2 has a checkout in ${at('app', 'worktrees')}, and a move would break it. Remove the checkouts of closed cards first, or finish the card. Nothing was changed.`,
    });
    untouched();
  });

  it('refuses while a card is marked running', async () => {
    db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-2'").run();

    expect(await convert()).toEqual({ problem: 'A run of APP-2 is running, and it works in the folder that would move. Make this a workspace once it has ended. Nothing was changed.' });
    untouched();
  });

  it('refuses while a run is queued, and while a card is marked queued before its run exists', async () => {
    const runId = startRun(db, { cardKey: 'APP-2', phase: 'plan', engine: 'claude-code', model: null, effort: null, sessionId: null, logPath: '', lane: null });

    expect(await convert()).toEqual({ problem: 'A run of APP-2 is queued, and it works in the folder that would move. Make this a workspace once it has ended. Nothing was changed.' });
    db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(runId);
    db.prepare("UPDATE cards SET state = 'queued' WHERE key = 'APP-1'").run();
    expect(await convert()).toEqual({ problem: 'A run of APP-1 is queued, and it works in the folder that would move. Make this a workspace once it has ended. Nothing was changed.' });
    untouched();
  });

  it('refuses while a knowledge change waits for review', async () => {
    const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'claude-code', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
    db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(runId);
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/stack.md', summary: null }] });

    expect(await convert()).toEqual({ problem: `A knowledge change of run ${runId} waits for review. Approve or return it on the Knowledge page first. Nothing was changed.` });
    untouched();
  });

  it('refuses a folder that is there, a parent that is not, a bad name and a folder inside the repository', async () => {
    mkdirSync(at('taken'));
    expect(await convert('taken')).toEqual({ problem: `${at('taken')} is there already. Pick another name, or another folder to put it in. Nothing was changed.` });
    expect(await makeThisAWorkspace(db, { parent: at('nowhere'), name: 'recipes', home }, { env: env() })).toEqual({
      problem: `The folder ${at('nowhere')} is not there. Make it first, or type a folder that is. Nothing was changed.`,
    });
    expect(await convert('worktrees')).toEqual({
      problem: 'The name "worktrees" cannot name a folder. Use one folder name with no slash that does not start with "-" and is not worktrees, .tasks or .nolzu. Nothing was changed.',
    });
    expect(await makeThisAWorkspace(db, { parent: at('app'), name: 'recipes', home }, { env: env() })).toEqual({
      problem: `${at('app')} is inside the repository, and a folder cannot move into itself. Pick a folder outside ${at('app')}. Nothing was changed.`,
    });
    untouched();
  });

  it('refuses a run waiting for its lane in plain words', async () => {
    const runId = startRun(db, { cardKey: 'APP-2', phase: 'plan', engine: 'claude-code', model: null, effort: null, sessionId: null, logPath: '', lane: null });
    db.prepare("UPDATE runs SET state = 'waiting_lane' WHERE id = ?").run(runId);

    expect(await convert()).toEqual({ problem: 'A run of APP-2 is waiting for its lane, and it works in the folder that would move. Make this a workspace once it has ended. Nothing was changed.' });
  });

  it('refuses while git knows another checkout of the repository', async () => {
    inGit(at('app'), 'worktree', 'add', '-q', at('side'), 'feature');

    expect(await convert()).toEqual({
      problem: `The repository has another checkout at ${realpathSync(at('side'))}, and a move breaks it. Remove that checkout first, or run git worktree prune when its folder is gone. Nothing was changed.`,
    });
    untouched();
  });

  it('refuses a repository that keeps its history in another folder', async () => {
    renameSync(at('app', '.git'), at('history'));
    writeFileSync(at('app', '.git'), `gitdir: ${at('history')}\n`);

    expect(await convert()).toEqual({ problem: `${at('app')} keeps its git history in another folder, and a move would cut it off. Move it by hand. Nothing was changed.` });
  });

  it('refuses a repository folder named like a file the workspace holds, or one the list rules refuse', async () => {
    // `.agents` is one of the skills folders the workspace holds, next to `.claude`.
    renameSync(at('app'), at('.agents'));
    writeSetting(db, 'projectPath', at('.agents'));

    expect(await convert()).toEqual({ problem: 'A workspace holds a .agents of its own, so the repository folder .agents cannot go in one. Rename the folder first. Nothing was changed.' });
    renameSync(at('.agents'), at('-app'));
    writeSetting(db, 'projectPath', at('-app'));
    expect(await convert()).toEqual({
      problem: 'The repository folder -app cannot be a repository of a workspace. The repository folder "-app" starts with "-", which git would read as an option. Nothing was changed.',
    });
  });

  it('refuses a project folder that is a link, which a rename would move without the repository', async () => {
    symlinkSync(at('app'), at('link'));
    writeSetting(db, 'projectPath', at('link'));

    expect(await convert()).toEqual({ problem: `${at('link')} is a link to ${realpathSync(at('app'))}. A move would take the link and leave the repository. Move it by hand. Nothing was changed.` });
    expect(existsSync(at('recipes'))).toBe(false);
  });

  it('refuses a folder on another disk, from the device ids, before anything is made', async () => {
    const answer = await convert('recipes', { device: (path) => (path === at('app') ? 1 : 2) });

    expect(answer).toEqual({
      problem: `${home} is on another disk than ${at('app')}. Nolzu moves the repository with a rename, which works only on one disk. Pick a folder on the same disk, or make a new project at /new and add the repository there by its URL. Nothing was changed.`,
    });
    untouched();
  });

  // The device check can miss, for a mount inside the parent folder. Then the rename says EXDEV.
  it('undoes the new workspace when the rename fails across disks, and leaves the repository where it was', async () => {
    const rename = () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };

    const answer = await convert('recipes', { rename });

    expect('problem' in answer && answer.problem).toMatch(/is on another disk than .*Nothing was changed\.$/);
    untouched();
    expect(readdirSync(at('app', '.tasks'))).toEqual(['APP-1']);
    expect(cardRepos(db, 'APP-2')).toEqual({ repos: ['.'], by: 'person' });
  });
});

describe('the Projects page before the move', () => {
  it('shows the form with the session warning and the own commands written for the old path', async () => {
    const html = render(ProjectsList, { props: { row: await projectRow(db) } }).body;

    expect(html).toContain('action="?/convert"');
    expect(html).toContain('old sessions cannot be resumed after the move');
    expect(html.replace(/<[^>]+>/g, '')).toContain(`These commands under Start the app were written for ${at('app')}. Check their paths after the move:`);
    expect(html).toContain(`${at('app')}/scripts/up.sh {key}`);
  });

  it('names worktrees/{key} as where an answer for every repository runs, not the card folder', async () => {
    const text = render(ProjectsList, { props: { row: await projectRow(db) } }).body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

    expect(text).toContain("In a workspace, an answer for every repository runs in worktrees/{key}, a plain folder that holds the card's checkouts.");
    expect(text).toContain('An answer for every repository runs once per card, in worktrees/{key} in the project folder.');
  });

  it('shows no form once the project is a workspace', async () => {
    await convert();

    const row = await projectRow(db);
    expect(row.convert).toBeNull();
    expect(render(ProjectsList, { props: { row } }).body).not.toContain('action="?/convert"');
  });
});

// Now offers the move once. The layout reads this on every load, so it is the reload.
describe('the offer on Now', () => {
  it('stands for a project of one repository, ends once the move runs, and the form stays a link away', async () => {
    expect(workspaceNote(db)).toBe(WORKSPACE_NOTE);
    expect(render(ProjectsList, { props: { row: await projectRow(db) } }).body).toContain('id="convert"');

    expect(await convert()).toHaveProperty('said');
    expect(workspaceNote(db)).toBeNull();
  });

  it('stays while a refused move changed nothing, and ends for good once the note is closed', async () => {
    mkdirSync(at('taken'));
    expect(await convert('taken')).toHaveProperty('problem');
    expect(workspaceNote(db)).toBe(WORKSPACE_NOTE);

    writeSetting(db, 'seenNotes', [WORKSPACE_NOTE]);
    expect(workspaceNote(db)).toBeNull();
  });
});
