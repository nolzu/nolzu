import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, markKnowledgeMoved, openDatabase, recordKnowledgeChanges, startRun, writeSetting } from '@nolzu/core/node';
import type { BoardSnapshot } from '@nolzu/protocol';
import { KB_MAINTENANCE_KEY } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitPatch, knowledgeFiles, knowledgeLane, knowledgePage, readOrNull, shortFolder } from './knowledge-page.ts';

// A real repository in a temp folder, with real commits. The diff on the screen is read back out of
// it through the page itself, so a copy stored in the database could not pass these tests.
let project = '';
let data = '';
let db: DatabaseSync;
let folder = '';

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
const head = () => git('rev-parse', 'HEAD');

const write = (name: string, text: string) => {
  mkdirSync(join(folder, name, '..'), { recursive: true });
  writeFileSync(join(folder, name), text);
};

// `when` sets the day of the commit, so two changes of one file can fall on two days and the last
// reviewed day has something to pick.
const commit = (message: string, when?: string) => {
  git('add', '-A');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message], {
    cwd: project,
    encoding: 'utf8',
    env: when === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  return head();
};

const run = (cardKey: string) =>
  startRun(db, { cardKey, phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });

const KNOWLEDGE = '.nolzu/knowledge/search.md';
const FIRST = '---\ndescription: How search is tested\n---\n\nRun the list first.\n';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-repo-'));
  data = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-data-'));
  folder = join(project, '.nolzu', 'knowledge');
  db = openDatabase(data);
  writeSetting(db, 'projectPath', project);
  git('init', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'A recipe app.\n');
  mkdirSync(folder, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the folder', () => {
  it('lists the files under it, in order, with forward slashes and without the repository itself', () => {
    write('search.md', FIRST);
    write('notes/testing.md', 'Run the suite.\n');
    write('a.md', 'One.\n');
    write('B.md', 'Two.\n');

    // By codepoint, which puts `B.md` first. A locale order would read `a.md` first here and would
    // differ from machine to machine.
    expect(knowledgeFiles(folder)).toEqual(['B.md', 'a.md', 'notes/testing.md', 'search.md']);
    rmSync(join(folder, 'a.md'));
    rmSync(join(folder, 'B.md'));
    // The repository of a folder that is one on its own would otherwise arrive as knowledge.
    execFileSync('git', ['init', '-b', 'main'], { cwd: folder, stdio: 'ignore' });
    expect(knowledgeFiles(folder)).toEqual(['notes/testing.md', 'search.md']);
  });

  it('says there is no project when none is set', async () => {
    writeSetting(db, 'projectPath', null);

    const view = await knowledgePage(db);

    expect(view.problem).toMatch(/no project set/);
    expect(view.folder).toBeNull();
  });

  it('names the folder that has not been made yet', async () => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const view = await knowledgePage(db);

    // From the project, never the long path of this machine.
    expect(view.problem).toBe('There is no folder .nolzu/knowledge yet. The first wrap-up that teaches something makes it.');
    expect(view.problem).not.toContain(project);
    expect(view.files).toEqual([]);
  });

  it('is empty, and not broken, while nothing has been taught', async () => {
    const view = await knowledgePage(db);

    expect(view.empty).toBe(true);
    expect(view.problem).toBeNull();
  });

  it('says the folder is not there when the knowledge path names a file', async () => {
    const file = join(project, 'notes.md');
    writeFileSync(file, 'Not a folder.\n');
    writeSetting(db, 'knowledgeDir', file);

    const view = await knowledgePage(db);

    expect(view.problem).toContain('There is no folder notes.md yet.');
    expect(view.files).toEqual([]);
  });
});

// The folder short, from the project or with ~, and every file's text for the search box.
describe('shortFolder', () => {
  it('names the folder from the project, with ~ outside it, and in full elsewhere', () => {
    expect(shortFolder('/home/cook/recipes/.nolzu/knowledge', '/home/cook/recipes', '/home/cook')).toBe('.nolzu/knowledge');
    expect(shortFolder('/home/cook/notes/knowledge', '/home/cook/recipes', '/home/cook')).toBe('~/notes/knowledge');
    expect(shortFolder('/srv/knowledge', '/home/cook/recipes', '/home/cook')).toBe('/srv/knowledge');
    expect(shortFolder('/home/cook/recipes', '/home/cook/recipes', '/home/cook')).toBe('~/recipes');
  });

  it('hands each file its text, so the search box can match what a file says', async () => {
    write('search.md', FIRST);

    expect((await knowledgePage(db)).files.map((one) => [one.name, one.text])).toEqual([['search.md', FIRST]]);
  });

  // The file list groups the folder by the project's repositories.
  it("hands over the project's repositories in its order", async () => {
    write('search.md', FIRST);
    expect((await knowledgePage(db)).repos).toEqual(['.']);
    writeSetting(db, 'repos', [
      { path: 'web', base: 'main' },
      { path: 'api', base: 'main' },
    ]);
    expect((await knowledgePage(db)).repos).toEqual(['web', 'api']);
  });
});

// The knowledge lane may be writing the folder while this page loads, which is what the busy dot
// says. Both reads answer instead of throwing, so the screen draws the busy state and not a 500.
describe('the folder changing while it is read', () => {
  it('lists nothing for a folder that went', () => {
    expect(knowledgeFiles(join(project, 'not-there'))).toEqual([]);
  });

  it('opens nothing for a file that went between the listing and the read', () => {
    write('search.md', FIRST);

    expect(readOrNull(join(folder, 'search.md'))).toBe(FIRST);
    expect(readOrNull(join(folder, 'gone.md'))).toBeNull();
    // A name that is a folder by the time it is read answers the same way.
    expect(readOrNull(folder)).toBeNull();
  });
});

describe('the file the query asks for', () => {
  beforeEach(() => {
    write('search.md', FIRST);
  });

  it('opens it and reads its description out of the frontmatter', async () => {
    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.body).toBe('Run the list first.\n');
    expect(view.open?.description).toBe('How search is tested');
    expect(view.files.map((file) => file.name)).toEqual(['search.md']);
  });

  it('opens nothing for a name the folder does not hold, so no path outside it can be read', async () => {
    // `README.md` is really there, one folder up from the knowledge folder, so this name would be
    // read if the list were not asked first.
    expect((await knowledgePage(db, { file: '../../README.md' })).open).toBeNull();
    expect((await knowledgePage(db, { file: '../../../etc/hosts' })).open).toBeNull();
    expect((await knowledgePage(db, { file: 'gone.md' })).open).toBeNull();
  });
});

describe('the change history', () => {
  let first = '';
  let second = '';

  beforeEach(() => {
    write('search.md', FIRST);
    first = commit('knowledge: APP-1 run 1', '2026-09-18T10:00:00+02:00');
    write('search.md', `${FIRST}\nThen open one recipe.\n`);
    second = commit('knowledge: APP-1 run 2');

    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'done', title: 'Search the recipe list' });
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: first, status: 'applied', files: [{ path: KNOWLEDGE, summary: 'added' }] });
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: second, status: 'applied', files: [{ path: KNOWLEDGE, summary: 'corrected' }] });
  });

  it('reads the diff of every change out of git, newest first', async () => {
    const view = await knowledgePage(db, { file: 'search.md' });
    const [newest, oldest] = view.open?.history ?? [];

    expect(newest?.sha).toBe(second);
    expect(newest?.diff).toContain('+Then open one recipe.');
    expect(newest?.diff).not.toContain('+Run the list first.');
    expect(oldest?.sha).toBe(first);
    expect(oldest?.diff).toContain('+Run the list first.');
  });

  it('dates every change from the commit, and the folder from the newest applied one', async () => {
    const view = await knowledgePage(db, { file: 'search.md' });
    const today = git('show', '-s', '--format=%cI', second).slice(0, 10);

    expect(view.open?.history[0]?.when).toBe(today);
    expect(view.lastReviewed).toBe(today);
  });

  it('draws a change whose commit is gone without a diff, rather than failing the screen', async () => {
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: 'f'.repeat(40), status: 'applied', files: [{ path: KNOWLEDGE, summary: 'corrected' }] });

    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.history[0]?.diff).toBeNull();
    expect(view.open?.history).toHaveLength(3);
  });

  // The commits are in this folder here, so only the mark can keep git from being asked.
  it('asks git for no diff of a change committed before the project became a workspace', async () => {
    markKnowledgeMoved(db, '/elsewhere/.nolzu/knowledge');

    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.history.map((change) => change.diff)).toEqual([null, null]);
    expect(view.open?.history[0]?.diffNote).toContain('/elsewhere/.nolzu/knowledge');
  });

  it('takes the last reviewed day from git with no file open, so the header never needs one', async () => {
    const view = await knowledgePage(db);

    expect(view.open).toBeNull();
    expect(view.lastReviewed).toBe(git('show', '-s', '--format=%cI', second).slice(0, 10));
  });

  it('reads the last reviewed day from an older applied change when git has lost the newest commit', async () => {
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: 'f'.repeat(40), status: 'applied', files: [{ path: KNOWLEDGE, summary: 'corrected' }] });

    const view = await knowledgePage(db);

    expect(view.lastReviewed).toBe(git('show', '-s', '--format=%cI', second).slice(0, 10));
  });

  it('shows no patch for a commit over the size the page reads, and still dates it', async () => {
    // Long enough that git's answer arrives in more than one piece, which is what makes the capped
    // read kill git. The size has to be read before the exit code, or this would draw as a commit
    // git does not have.
    write('search.md', `${FIRST}${'A long note about search. '.repeat(10_000)}\n`);
    const big = commit('knowledge: APP-1 run 3');

    const said = await commitPatch(folder, big, KNOWLEDGE, process.env, undefined, 1000);

    expect(said.diffTooLarge).toBe(true);
    expect(said.diff).toBeNull();
    expect(said.committedAt).toBe(git('show', '-s', '--format=%cI', big));
  });

  it('holds the changes of the open file only, and not of a file whose name ends the same way', async () => {
    write('testing.md', 'Run the suite.\n');
    write('notes/search.md', 'Another file called search.\n');
    const other = commit('knowledge: APP-1 run 3');
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: other, status: 'applied', files: [{ path: '.nolzu/knowledge/testing.md', summary: 'added' }] });
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: other, status: 'applied', files: [{ path: '.nolzu/knowledge/notes/search.md', summary: 'added' }] });

    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.history.map((change) => change.path)).toEqual(['search.md', 'search.md']);
  });
});

describe('who taught a file', () => {
  beforeEach(() => {
    write('search.md', FIRST);
    const sha = commit('knowledge: APP-1 run 1');

    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'done', title: 'Search the recipe list' });
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: sha, status: 'applied', files: [{ path: KNOWLEDGE, summary: 'added' }] });
    // A card that was on the board and is not any more. Its row stays.
    recordKnowledgeChanges(db, { cardKey: 'APP-9', runId: run('APP-9'), commitSha: sha, status: 'applied', files: [{ path: KNOWLEDGE, summary: 'corrected' }] });
    recordKnowledgeChanges(db, { cardKey: KB_MAINTENANCE_KEY, runId: run(KB_MAINTENANCE_KEY), commitSha: sha, status: 'applied', files: [{ path: KNOWLEDGE, summary: 'tidied' }] });
  });

  it('links the card that exists, skips the one that was deleted and reads maintenance', async () => {
    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.taughtBy).toEqual([
      { kind: 'card', key: 'APP-1', title: 'Search the recipe list' },
      { kind: 'maintenance', key: null, title: null },
    ]);
    expect(view.open?.history.map((change) => change.source?.kind ?? 'gone')).toEqual(['maintenance', 'gone', 'card']);
  });
});

describe('a change waiting for a person', () => {
  it('is listed with no commit and no diff, and moves no reviewed date', async () => {
    write('search.md', FIRST);
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: null, status: 'pending', files: [{ path: KNOWLEDGE, summary: 'added' }] });

    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.pending.map((change) => [change.path, change.statusLabel])).toEqual([['search.md', 'waiting for review']]);
    expect(view.pending[0]?.diff).toBeNull();
    expect(view.lastReviewed).toBeNull();
  });

  // The person reads what they apply. The kept copy holds whole files, so its lines come from
  // setting it against the file in the folder.
  it('reads its lines from the kept copy, set against the file in the folder', async () => {
    write('search.md', FIRST);
    const runId = run('APP-1');
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: null, status: 'pending', files: [{ path: KNOWLEDGE, summary: 'corrected' }] });
    const held = (asked: number) =>
      asked === runId ? { cardKey: 'APP-1', runId, files: [{ path: KNOWLEDGE, kind: 'corrected' as const, content: `${FIRST}Then open one recipe.\n` }] } : null;

    const view = await knowledgePage(db, { held });

    expect(view.pending[0]?.held).toEqual([{ removed: [], added: ['Then open one recipe.'] }]);
  });

  it('shows no lines when the kept copy is gone', async () => {
    write('search.md', FIRST);
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: run('APP-1'), commitSha: null, status: 'pending', files: [{ path: KNOWLEDGE, summary: 'added' }] });

    expect((await knowledgePage(db, { held: () => null })).pending[0]?.held).toBeNull();
  });

  it('reads no kept copy for a change that is not waiting', async () => {
    write('search.md', FIRST);
    const runId = run('APP-1');
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: null, status: 'returned', files: [{ path: KNOWLEDGE, summary: 'corrected' }] });
    const asked: number[] = [];
    const held = (id: number) => {
      asked.push(id);
      return { cardKey: 'APP-1', runId: id, files: [{ path: KNOWLEDGE, kind: 'corrected' as const, content: `${FIRST}More.\n` }] };
    };

    const view = await knowledgePage(db, { file: 'search.md', held });

    expect(asked).toEqual([]);
    expect(view.open?.history.map((change) => change.held)).toEqual([null]);
  });
});

describe('the folder pane', () => {
  it('dates each file by the newest commit that touched it', async () => {
    write('search.md', FIRST);
    commit('knowledge: APP-1 run 1', '2026-09-18T10:00:00+02:00');
    write('notes/testing.md', 'Run the suite.\n');
    commit('knowledge: APP-1 run 2', '2026-09-20T10:00:00+02:00');
    write('loose.md', 'Not committed yet.\n');

    const view = await knowledgePage(db);

    expect(view.files.map((file) => [file.path, file.updated])).toEqual([
      ['loose.md', null],
      ['notes/testing.md', '2026-09-20'],
      ['search.md', '2026-09-18'],
    ]);
  });

  // git writes a name outside ASCII in quotes with octal escapes unless quotepath is off, which the
  // runner's git sets, and the file would then read as never committed.
  it('dates a file whose name is not plain ASCII', async () => {
    write('crème.md', 'Whipped, never boiled.\n');
    commit('knowledge: APP-1 run 1', '2026-09-18T10:00:00+02:00');

    expect((await knowledgePage(db)).files.find((file) => file.path === 'crème.md')?.updated).toBe('2026-09-18');
  });

  it('dates the last Optimize from the commit of a maintenance change', async () => {
    write('search.md', FIRST);
    const sha = commit('knowledge: maintenance', '2026-10-04T10:00:00+02:00');
    recordKnowledgeChanges(db, { cardKey: KB_MAINTENANCE_KEY, runId: run(KB_MAINTENANCE_KEY), commitSha: sha, status: 'applied', files: [{ path: KNOWLEDGE, summary: 'tidied' }] });

    expect((await knowledgePage(db)).lastOptimize).toBe('2026-10-04');
  });
});

describe('the busy state', () => {
  const snapshot = (heldBy: string | null): Pick<BoardSnapshot, 'lanes'> => ({
    lanes: [
      { name: 'stack', heldBy: 'APP-7' },
      { name: 'knowledge', heldBy },
      { name: 'scout', heldBy: null },
    ],
  });

  it('comes from the knowledge lane of the board snapshot', () => {
    expect(knowledgeLane(snapshot('APP-2'))).toBe('APP-2');
    expect(knowledgeLane(snapshot(null))).toBeNull();
  });

  it('reaches the screen with the card that holds the folder', async () => {
    write('search.md', FIRST);

    expect((await knowledgePage(db, { busy: 'APP-2' })).busy).toBe('APP-2');
  });
});

// Notes can point at a file that had moved and at design files in `.tasks/`,
// which git does not track. Both read as gone from the base branch.
describe('the path check', () => {
  const NOTE = '---\ndescription: Read before changing search.\npaths: src/search.ts, src, .tasks/APP-1/design.html, /etc/hosts\n---\n\nSearch is tested in the browser.\n';

  it('marks each path a note names by whether the base branch has it', async () => {
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'search.ts'), 'export {};\n');
    write('search.md', NOTE);
    commit('the code and a note');
    // On disk, but never on the base branch.
    mkdirSync(join(project, '.tasks', 'APP-1'), { recursive: true });
    writeFileSync(join(project, '.tasks', 'APP-1', 'design.html'), '<p></p>\n');
    writeSetting(db, 'baseBranch', 'main');

    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.paths.map((one) => [one.path, one.state])).toEqual([
      ['src/search.ts', 'there'],
      ['src', 'there'],
      ['.tasks/APP-1/design.html', 'gone'],
      ['/etc/hosts', 'gone'],
    ]);
    expect(view.files.find((file) => file.path === 'search.md')?.gone).toEqual(['.tasks/APP-1/design.html', '/etc/hosts']);
  });

  it('checks nothing against a base branch git cannot read, rather than calling every path gone', async () => {
    write('search.md', NOTE);
    commit('a note');
    writeSetting(db, 'baseBranch', 'trunk');

    const view = await knowledgePage(db, { file: 'search.md' });

    expect(view.open?.paths.map((one) => one.state)).toEqual(['unchecked', 'unchecked', 'unchecked', 'gone']);
  });

  it('asks each repository of a workspace for its own paths', async () => {
    const api = join(project, 'api');
    mkdirSync(join(api, 'src'), { recursive: true });
    writeFileSync(join(api, 'src', 'routes.ts'), 'export {};\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: api });
    execFileSync('git', ['add', '-A'], { cwd: api });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'api'], { cwd: api });
    write('api.md', '---\ndescription: Read before changing the api.\npaths: api/src/routes.ts, api/src/gone.ts, web/app.ts, api\n---\n\nThe routes.\n');
    commit('a note');
    writeSetting(db, 'repos', [{ path: 'api', base: 'main' }]);

    const view = await knowledgePage(db, { file: 'api.md' });

    expect(view.open?.paths.map((one) => one.state)).toEqual(['there', 'gone', 'unchecked', 'there']);
    // A project folder that is a repository too holds only a link to `api`, so the deepest one answers.
    writeSetting(db, 'repos', [{ path: '.', base: 'main' }, { path: 'api', base: 'main' }]);
    expect((await knowledgePage(db, { file: 'api.md' })).open?.paths.map((one) => one.state)).toEqual(['there', 'gone', 'gone', 'there']);
  });
});
