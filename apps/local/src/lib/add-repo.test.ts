import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { createCard, getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { cloneTarget } from '@nolzu/runner';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRepository, type Clone, CLONE_STOPPED, cloneJobs, type CloneJob, cloneMissing, cloneStream, onCloneChange, SHAPE_ONE, startClone, stopAllClones, stopClone, stoppable } from './add-repo.ts';
import { cardReposFor } from './card-repos.ts';
import { MANIFEST } from './manifest.ts';
import { createWorkspace, saveProject } from './onboard.ts';
import { addToList, projectRow, repoTable, rescanRepos } from './projects.ts';
import { removeRepository } from './remove-repo.ts';
import ProjectsList from './ProjectsList.svelte';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';

// The Walls box links to Settings, Wall, so the page says where it is drawn.
drawnAt('/settings/project');

// Every path here sits in `home`, a temp folder removed after each test.
let home = '';
let db: DatabaseSync;
const env = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const inGit = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { env: env(), encoding: 'utf8' }).trim();
const at = (...parts: string[]) => join(home, ...parts);
const url = (name: string) => `https://example.com/team/${name}.git`;

// A bare repository on develop, with a main branch too, the way a hosted repository looks.
const bare = (name: string) => {
  const source = at('src', name);
  execFileSync('git', ['init', '-q', '-b', 'develop', source], { env: env() });
  writeFileSync(join(source, 'package.json'), '{}\n');
  inGit(source, 'add', '-A');
  inGit(source, 'commit', '-q', '-m', 'first');
  inGit(source, 'branch', 'main');
  execFileSync('git', ['clone', '-q', '--bare', source, at('remotes', `${name}.git`)], { env: env() });
};

// The runner's clone cannot reach a local bare repository, so this one maps the https URL onto it.
// The URL still passes the clone rules, which name the folder.
const clone: Clone = async ({ workspace, url: typed, taken }) => {
  const target = cloneTarget(typed, taken);
  if (!target.ok) return target;
  execFileSync('git', ['clone', '-q', at('remotes', `${target.name}.git`), join(workspace, target.name)], { env: env() });
  return { ok: true, name: target.name, path: join(workspace, target.name) };
};
const add = (name: string) => addRepository(db, url(name), env(), clone);

const workspace = async (name = 'recipes') => {
  const made = await createWorkspace(db, { parent: home, name, home, env: env() });
  if (!made.ok) throw new Error(made.reason);
  return made.path;
};
const manifest = (folder: string) => JSON.parse(readFileSync(join(folder, MANIFEST), 'utf8')) as { workspace?: true; repositories: unknown[] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nolzu-add-repo-'));
  db = openDatabase(at('data'));
  bare('api');
  bare('web');
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('adding a repository by URL', () => {
  it('clones it, lists it with its base, ignores it, writes its knowledge file and records its URL, all committed', async () => {
    const root = await workspace();

    expect(await add('api')).toEqual({ said: 'Added api, starting from develop. Wrote api/repository.md, run-recipe.md in the knowledge folder.', added: 'api' });

    expect(inGit(join(root, 'api'), 'branch', '--show-current')).toBe('develop');
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
    expect(getSetting(db, 'baseBranch')).toBe('develop');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/api/\n');
    expect(manifest(root)).toEqual({ workspace: true, repositories: [{ folder: 'api', url: url('api'), base: 'develop' }] });
    expect(readFileSync(join(root, '.nolzu', 'knowledge', 'api', 'repository.md'), 'utf8')).toContain('Base branch: `develop`.');
    expect(readFileSync(join(root, '.nolzu', 'knowledge', 'run-recipe.md'), 'utf8')).toContain('## The api repository');
    expect(inGit(root, 'log', '--pretty=%s')).toBe('knowledge: repository files\nchore: add api\nchore: start the workspace');
    expect(inGit(root, 'status', '--porcelain')).toBe('');
  });

  it('clones nothing and stores nothing for a bad URL or a name the list has', async () => {
    const root = await workspace();
    await add('api');
    const before = { ignore: readFileSync(join(root, '.gitignore'), 'utf8'), manifest: readFileSync(join(root, MANIFEST), 'utf8'), head: inGit(root, 'rev-parse', 'HEAD') };

    // The runner's own clone, with its rules, so nothing here reaches git.
    for (const typed of ['file:///tmp/web', '-oProxyCommand=x', 'ext::sh -c x', 'https://me:secret@example.com/team/web.git', '../web']) {
      const answer = await addRepository(db, typed, env());
      expect('problem' in answer).toBe(true);
      expect(JSON.stringify(answer)).not.toContain('secret');
    }
    expect(await add('API')).toEqual({ problem: 'There is a repository "api" in this workspace already.' });

    expect(readdirSync(root).sort()).toEqual(['.agents', '.claude', '.git', '.gitignore', '.nolzu', '.tasks', 'AGENTS.md', 'CLAUDE.md', 'api', 'worktrees']);
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
    expect({ ignore: readFileSync(join(root, '.gitignore'), 'utf8'), manifest: readFileSync(join(root, MANIFEST), 'utf8'), head: inGit(root, 'rev-parse', 'HEAD') }).toEqual(before);
  });

  it('refuses a project of one repository with a sentence about making a workspace', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', at('one')], { env: env() });
    writeSetting(db, 'projectPath', at('one'));

    expect(await add('api')).toEqual({ problem: SHAPE_ONE });
    expect(existsSync(at('one', 'api'))).toBe(false);
  });

  it('clones into the root repository of a folder that holds its repositories, and commits the line there', async () => {
    const root = at('shop');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: env() });
    inGit(root, 'commit', '-q', '--allow-empty', '-m', 'first');
    writeSetting(db, 'projectPath', root);
    writeSetting(db, 'repos', [{ path: '.', base: 'main' }]);

    expect((await add('web')) as { said: string }).toMatchObject({ said: expect.stringMatching(/^Added web, starting from develop\./) });

    expect(getSetting(db, 'repos')).toEqual([
      { path: '.', base: 'main' },
      { path: 'web', base: 'develop' },
    ]);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/web/\n');
    // No workspace mark, because this root holds code and stays in its own list.
    expect(manifest(root)).toEqual({ repositories: [{ folder: 'web', url: url('web'), base: 'develop' }] });
    expect(inGit(root, 'status', '--porcelain')).toBe('');
  });

  it('opens a root that holds code and a manifest again with the root still in its list', async () => {
    const root = at('shop');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: env() });
    inGit(root, 'commit', '-q', '--allow-empty', '-m', 'first');
    writeSetting(db, 'projectPath', root);
    writeSetting(db, 'repos', [{ path: '.', base: 'main' }]);
    await add('web');

    expect(await saveProject(db, { path: root, template: '{key}-{slug}', home, env: env() })).toEqual({ ok: true, path: root });

    expect(getSetting(db, 'workspace')).toBeNull();
    expect(getSetting(db, 'repos')?.map((repo) => repo.path)).toEqual(['.', 'web']);
  });

  it('commits only its own change when .gitignore holds an edit of the person that is not committed', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.gitignore'), '/worktrees/\n/.tasks/\n/scratch/\n');

    const answer = await add('api');

    expect(answer).toMatchObject({ said: expect.stringContaining('.gitignore and .nolzu/repositories.json name api now. Nolzu did not commit them, because they held changes of yours that were not committed.') });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/scratch/\n/api/\n');
    expect(inGit(root, 'log', '--pretty=%s')).not.toContain('chore: add api');
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
  });

  it('names the manifest when it is the file Nolzu could not write, and puts .gitignore back', async () => {
    const root = await workspace();
    // A folder no one may write into makes the manifest write fail after the .gitignore one.
    chmodSync(join(root, '.nolzu'), 0o555);
    const answer = await add('api').finally(() => chmodSync(join(root, '.nolzu'), 0o755));

    expect(answer).toMatchObject({ problem: expect.stringMatching(/^Nolzu could not write \.nolzu\/repositories\.json in the project folder\./) });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n');
    expect(existsSync(join(root, 'api'))).toBe(false);
  });

  it('lets a card made before the add pick the new repository on its Settings tab', async () => {
    await workspace();
    await add('api');
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });

    await add('web');

    expect(cardReposFor(db, 'APP-1')?.repos.map((repo) => repo.path)).toEqual(['api', 'web']);
  });

  // The clone is the only new thing, so it goes, and the person's file stays as they left it.
  it('removes its own clone and changes nothing when the manifest cannot take the entry', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), '{ nope');

    const answer = await add('api');

    expect(answer).toEqual({ problem: '.nolzu/repositories.json is not JSON, so Nolzu left it alone and did not add api to it. The clone was removed again.' });
    expect(existsSync(join(root, 'api'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n');
    expect(readFileSync(join(root, MANIFEST), 'utf8')).toBe('{ nope');
    expect(getSetting(db, 'repos')).toEqual([]);
  });

  it('gives a repository Scan again finds in a workspace its .gitignore line and its manifest entry', async () => {
    const root = await workspace();
    execFileSync('git', ['clone', '-q', at('remotes', 'web.git'), join(root, 'web')], { env: env() });
    // git keeps the path it cloned from, which no teammate can clone, so the URL is set the way a host gives it.
    inGit(join(root, 'web'), 'remote', 'set-url', 'origin', url('web'));
    execFileSync('git', ['clone', '-q', at('remotes', 'api.git'), join(root, 'api')], { env: env() });

    const said = await rescanRepos(db, env());

    expect(said).toEqual({ said: 'Added api, web. Wrote api/repository.md, web/repository.md, run-recipe.md in the knowledge folder. .nolzu/repositories.json does not list api, because there is no origin URL Nolzu can clone from.' });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/api/\n/web/\n');
    expect(manifest(root)).toEqual({ workspace: true, repositories: [{ folder: 'web', url: url('web'), base: 'develop' }] });
    expect(inGit(root, 'status', '--porcelain')).toBe('');
  });

  it('names the folder after the clone git made, not after the typed text', async () => {
    const root = await workspace();

    expect(await addRepository(db, 'https://example.com/team/web/', env(), clone)).toMatchObject({ said: expect.stringMatching(/^Added web, starting from develop\./) });

    expect(getSetting(db, 'repos')).toEqual([{ path: 'web', base: 'develop' }]);
    expect(manifest(root).repositories).toEqual([{ folder: 'web', url: 'https://example.com/team/web/', base: 'develop' }]);
  });

  it('keeps a list entry that differs only in case, and stores no second one', () => {
    writeSetting(db, 'projectPath', at('shop'));
    writeSetting(db, 'repos', [{ path: 'api', base: 'develop' }]);

    expect(addToList(db, [{ path: 'API', base: 'main' }])).toBeNull();
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
  });

  it('says on the page whether the project folder keeps the .gitignore line and the manifest entry', async () => {
    mkdirSync(at('plain'));
    writeSetting(db, 'projectPath', at('plain'));
    writeSetting(db, 'repos', [{ path: 'api', base: 'develop' }]);
    const plain = await projectRow(db);
    expect(plain.rootRecords).toBe(false);
    expect(render(ProjectsList, { props: { row: plain } }).body).toContain('Add clones a repository into the project folder. Scan again');

    await workspace();
    const records = await projectRow(db);
    expect(records.rootRecords).toBe(true);
    expect(render(ProjectsList, { props: { row: records } }).body).toContain('Add clones a repository into the project folder and records it, so a teammate gets it too.');
  });

  it('lists no clone Scan again finds whose origin URL would clone into another folder', async () => {
    const root = await workspace();
    execFileSync('git', ['clone', '-q', at('remotes', 'web.git'), join(root, 'site')], { env: env() });
    inGit(join(root, 'site'), 'remote', 'set-url', 'origin', url('web'));

    const said = await rescanRepos(db, env());

    expect(said).toMatchObject({ said: expect.stringContaining('.nolzu/repositories.json does not list site, because there is no origin URL Nolzu can clone from.') });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/site/\n');
    expect(existsSync(join(root, MANIFEST)) ? manifest(root).repositories : []).toEqual([]);
  });

  it('still gives a clone Scan again finds its .gitignore line when the manifest cannot be read', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), '{ nope');
    execFileSync('git', ['clone', '-q', at('remotes', 'web.git'), join(root, 'web')], { env: env() });
    inGit(join(root, 'web'), 'remote', 'set-url', 'origin', url('web'));

    const said = await rescanRepos(db, env());

    expect(said).toMatchObject({ said: expect.stringContaining('.nolzu/repositories.json is not JSON, so Nolzu left it alone and did not add web to it.') });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/web/\n');
    expect(inGit(root, 'log', '-1', '--pretty=%s', '--', '.gitignore')).toBe('chore: add web');
    expect(readFileSync(join(root, MANIFEST), 'utf8')).toBe('{ nope');
  });
});

describe('cloning the missing repositories', () => {
  // A teammate clones the workspace and one of its repositories by hand, then opens the folder.
  const teammate = async () => {
    const root = await workspace();
    await add('api');
    await add('web');
    // The teammate's workspace asks for web on main, which the clone has only on the remote.
    const file = manifest(root);
    writeFileSync(join(root, MANIFEST), `${JSON.stringify({ ...file, repositories: [file.repositories[0], { folder: 'web', url: url('web'), base: 'main' }] }, null, 2)}\n`);
    inGit(root, 'commit', '-q', '-am', 'web from main');
    const mate = at('mate');
    execFileSync('git', ['clone', '-q', root, mate], { env: env() });
    execFileSync('git', ['clone', '-q', at('remotes', 'api.git'), join(mate, 'api')], { env: env() });
    return mate;
  };

  it('opens a shared workspace as a workspace, shows the repository not on disk, and clones it on the base the manifest names', async () => {
    const mate = await teammate();

    expect(await saveProject(db, { path: mate, template: '{key}-{slug}', home, env: env() })).toEqual({ ok: true, path: mate });
    expect(getSetting(db, 'workspace')).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
    const row = await projectRow(db);
    expect(row.missing).toEqual(['web']);
    expect(row.manifestProblems).toEqual([]);
    // The missing folder is a row of its own, with the URL the manifest names and its own Clone.
    const table = await repoTable(db);
    expect(table.find((one) => one.path === 'web')).toEqual({ path: 'web', remote: 'example.com/team/web', base: 'main', onDisk: false, clone: true, remove: false });
    const body = render(ProjectsList, { props: { row, table } }).body;
    expect(body).toContain('aria-label="Clone web"');
    expect(body).toContain('Missing');

    expect(await cloneMissing(db, env(), clone)).toEqual({ said: 'Added web, starting from main.' });

    expect(inGit(join(mate, 'web'), 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
    expect(getSetting(db, 'repos')).toEqual([
      { path: 'api', base: 'develop' },
      { path: 'web', base: 'main' },
    ]);
    expect((await projectRow(db)).missing).toEqual([]);
    // The line and the entry were there already, and the knowledge files came with the workspace.
    expect(inGit(mate, 'status', '--porcelain')).toBe('');
    expect(await cloneMissing(db, env(), clone)).toEqual({ said: 'Every repository the manifest names is on disk already.' });
  });

  it('names a manifest entry with a bad URL by the clone rules, and clones only the good one', async () => {
    const root = await workspace();
    writeFileSync(
      join(root, MANIFEST),
      JSON.stringify({ repositories: [{ folder: 'tool', url: 'ext::sh -c touch% /tmp/x', base: 'main' }, { folder: 'api', url: url('api'), base: 'develop' }] }),
    );

    const row = await projectRow(db);
    expect(row.missing).toEqual(['api']);
    expect(row.manifestProblems).toEqual([
      'In .nolzu/repositories.json, the entry "tool" cannot be cloned. The URL names a git transport of its own, which can run any command. Type an https:// or user@host:path URL.',
    ]);
    expect(render(ProjectsList, { props: { row } }).body).toContain('the entry "tool" cannot be cloned');

    expect(await cloneMissing(db, env(), clone)).toMatchObject({ said: expect.stringMatching(/^Added api, starting from develop\./) });
    expect(existsSync(join(root, 'tool'))).toBe(false);
  });

  it('names a repository that could not be cloned and still clones the others', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), JSON.stringify({ repositories: [{ folder: 'gone', url: url('gone'), base: 'main' }, { folder: 'api', url: url('api'), base: 'develop' }] }));
    const failing: Clone = async (options) => (options.url.includes('gone') ? { ok: false, reason: 'Git could not clone gone. Repository not found.' } : clone(options));

    const said = await cloneMissing(db, env(), failing);

    expect(said).toMatchObject({ said: expect.stringMatching(/^gone was not cloned\. Git could not clone gone\. Repository not found\. Added api, starting from develop\./) });
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
  });

  // A row's Clone sends its folder: that one is cloned, and the other missing one stays missing.
  it('clones only the folder its row names, and refuses a folder the manifest does not name as missing', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), JSON.stringify({ repositories: [{ folder: 'api', url: url('api'), base: 'develop' }, { folder: 'web', url: url('web'), base: 'main' }] }));
    const asked: string[] = [];
    const counted: Clone = async (options) => {
      asked.push(options.url);
      return clone(options);
    };

    expect(await cloneMissing(db, env(), counted, 'web')).toMatchObject({ said: expect.stringMatching(/^Added web, starting from main\./) });
    expect(asked).toEqual([url('web')]);
    expect(existsSync(join(root, 'api'))).toBe(false);
    expect((await projectRow(db)).missing).toEqual(['api']);

    expect(await cloneMissing(db, env(), counted, 'web')).toEqual({ problem: 'The manifest names no missing folder web, so nothing was cloned.' });
    expect(await cloneMissing(db, env(), counted, '../elsewhere')).toEqual({ problem: 'The manifest names no missing folder ../elsewhere, so nothing was cloned.' });
    expect(asked).toHaveLength(1);
  });

  it('clones back a listed repository whose folder went', async () => {
    const root = await workspace();
    await add('api');
    rmSync(join(root, 'api'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect((await projectRow(db)).missing).toEqual(['api']);
    expect(await cloneMissing(db, env(), clone)).toMatchObject({ said: expect.stringMatching(/^Added api, starting from develop\./) });
    expect(existsSync(join(root, 'api', 'package.json'))).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([{ path: 'api', base: 'develop' }]);
  });

  it('answers with a refusal when no repository could be cloned', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), JSON.stringify({ repositories: [{ folder: 'gone', url: url('gone'), base: 'main' }] }));
    const failing: Clone = async () => ({ ok: false, reason: 'Git could not clone gone. Repository not found.' });

    expect(await cloneMissing(db, env(), failing)).toEqual({ problem: 'gone was not cloned. Git could not clone gone. Repository not found.' });
  });

  it('removes a clone whose base the manifest names is not on the remote', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), JSON.stringify({ repositories: [{ folder: 'api', url: url('api'), base: 'nope' }] }));

    expect(await cloneMissing(db, env(), clone)).toEqual({ problem: 'The base branch nope that the manifest names is not in api. The clone was removed again.' });
    expect(existsSync(join(root, 'api'))).toBe(false);
    expect(getSetting(db, 'repos')).toEqual([]);
  });
});

describe('clones in the background, one at a time', () => {
  // Waits for the job change that makes the check true, so a slow real clone is not cut short.
  const until = (check: () => boolean) =>
    new Promise<void>((done) => {
      const look = (): void => {
        if (!check()) return;
        leave();
        done();
      };
      const leave = onCloneChange(look);
      look();
    });
  // A clone that holds until the test lets it go, and notes each one that began.
  const held = () => {
    let go = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    const began: string[] = [];
    const gated: Clone = async (options) => {
      began.push(options.url);
      await gate;
      return clone(options);
    };
    return { gated, go: () => go(), began };
  };
  const started = (answer: { job: CloneJob } | { problem: string }): CloneJob => {
    if ('problem' in answer) throw new Error(answer.problem);
    return answer.job;
  };
  const project = () => getSetting(db, 'projectPath') ?? '';

  it('answers at once, and a second clone waits until the first one is added', async () => {
    const root = await workspace();
    const { gated, go, began } = held();

    const api = started(startClone(db, url('api'), env(), gated));
    const web = started(startClone(db, url('web'), env(), gated));
    await until(() => api.state === 'cloning');
    await wait(50);

    expect(web.state).toBe('waiting');
    expect(began).toEqual([url('api')]);

    go();
    await until(() => web.state === 'added');
    expect(api).toMatchObject({ state: 'added', said: 'Added api, starting from develop. Wrote api/repository.md, run-recipe.md in the knowledge folder.' });
    expect(began).toEqual([url('api'), url('web')]);
    // Each manifest commit after the one before it, never two at once.
    expect(inGit(root, 'log', '--pretty=%s')).toBe('knowledge: repository files\nchore: add web\nknowledge: repository files\nchore: add api\nchore: start the workspace');
    expect(manifest(root).repositories).toEqual([
      { folder: 'api', url: url('api'), base: 'develop' },
      { folder: 'web', url: url('web'), base: 'develop' },
    ]);
    expect(cloneJobs(project()).map((job) => [job.name, job.state])).toEqual([
      ['api', 'added'],
      ['web', 'added'],
    ]);
  });

  it('makes Add on the Projects page wait for a clone that runs', async () => {
    await workspace();
    const { gated, go } = held();
    const api = started(startClone(db, url('api'), env(), gated));
    await until(() => api.state === 'cloning');

    let done = false;
    const direct = addRepository(db, url('web'), env(), clone).then((answer) => {
      done = true;
      return answer;
    });
    await wait(50);
    expect(done).toBe(false);

    go();
    expect(await direct).toEqual({ said: 'Added web, starting from develop. Wrote web/repository.md, run-recipe.md in the knowledge folder.', added: 'web' });
    expect(api.state).toBe('added');
  });

  // Both commit the manifest, so each waits its turn behind the clone, and then reads the folder as
  // that clone left it.
  it('makes Remove and Scan again wait for a clone that runs', async () => {
    const root = await workspace();
    await add('web');
    const { gated, go } = held();
    const api = started(startClone(db, url('api'), env(), gated));
    await until(() => api.state === 'cloning');

    const ended: string[] = [];
    const removed = removeRepository(db, 'web', 'web', env()).then((answer) => (ended.push('remove'), answer));
    const scanned = rescanRepos(db, env()).then((answer) => (ended.push('scan'), answer));
    await wait(50);
    expect(ended).toEqual([]);

    go();
    expect(await removed).toMatchObject({ said: expect.stringMatching(/^Removed web\. /) });
    expect(await scanned).toEqual({ said: 'Every repository the scan found is in the list already.' });
    expect(ended).toEqual(['remove', 'scan']);
    expect(api.state).toBe('added');
    expect(inGit(root, 'log', '--pretty=%s').split('\n').slice(0, 3)).toEqual(['chore: remove web', 'knowledge: repository files', 'chore: add api']);
  });

  it("sends the whole list on the stream, first as it is, then at each step and each move of git's progress", async () => {
    await workspace();
    const stop = new AbortController();
    const response = cloneStream(db, new Request('http://localhost/api/clones', { signal: stop.signal }));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const lists: CloneJob[][] = [];
    const read = async (until: (list: CloneJob[]) => boolean) => {
      while (!until(lists.at(-1) ?? [{} as CloneJob])) {
        const chunk = new TextDecoder().decode((await reader.read()).value);
        for (const event of chunk.split('\n\n').filter((one) => one.startsWith('data: '))) lists.push(JSON.parse(event.slice(6)) as CloneJob[]);
      }
    };

    await read((list) => list.length === 0);
    const reporting: Clone = async (options) => {
      options.onProgress?.({ step: 'Receiving objects', percent: 45 });
      return clone(options);
    };
    startClone(db, url('api'), env(), reporting);
    await read((list) => list[0]?.state === 'added');
    stop.abort();

    const seen = lists.slice(1).map((list) => [list[0]?.state, list[0]?.progress?.percent ?? null]);
    expect(seen).toContainEqual(['waiting', null]);
    expect(seen).toContainEqual(['cloning', null]);
    expect(seen).toContainEqual(['cloning', 45]);
    expect(lists.at(-1)?.[0]).toMatchObject({ name: 'api', url: url('api'), state: 'added', progress: { step: 'Receiving objects', percent: 45 } });
  });

  // A stream whose page went without the request saying so throws on its closed controller.
  it('keeps cloning when a watcher throws, and stops telling that one', async () => {
    await workspace();
    let calls = 0;
    const leave = onCloneChange(() => {
      calls += 1;
      throw new Error('Invalid state: Controller is already closed');
    });
    const reporting: Clone = async (options) => {
      options.onProgress?.({ step: 'Receiving objects', percent: 10 });
      return clone(options);
    };

    const api = started(startClone(db, url('api'), env(), reporting));
    await until(() => api.state === 'added');

    expect(api.said).toBe('Added api, starting from develop. Wrote api/repository.md, run-recipe.md in the knowledge folder.');
    expect(calls).toBe(1);
    leave();
  });

  it('leaves no folder when a clone fails, and the job says why', async () => {
    const root = await workspace();
    writeFileSync(join(root, MANIFEST), '{ nope');

    const api = started(startClone(db, url('api'), env(), clone));
    await until(() => api.state === 'failed');

    expect(api.said).toBe('.nolzu/repositories.json is not JSON, so Nolzu left it alone and did not add api to it. The clone was removed again.');
    expect(existsSync(join(root, 'api'))).toBe(false);
    expect(getSetting(db, 'repos')).toEqual([]);
  });

  it('ends a job whose clone threw, so it never shows as cloning for ever', async () => {
    await workspace();
    const throwing: Clone = async () => {
      throw new Error('git was not found on the PATH.');
    };

    const api = started(startClone(db, url('api'), env(), throwing));
    await until(() => api.state === 'failed');

    expect(api.said).toBe('The clone stopped with an error: git was not found on the PATH.');
  });

  it('lets the next clone run after one threw', async () => {
    await workspace();
    const api = started(startClone(db, url('api'), env(), async () => Promise.reject(new Error('git was not found on the PATH.'))));
    const web = started(startClone(db, url('web'), env(), clone));
    await until(() => web.state === 'added');

    expect(api.state).toBe('failed');
  });

  it('stops a clone that waits at once, and it never clones', async () => {
    const root = await workspace();
    const { gated, go, began } = held();
    const api = started(startClone(db, url('api'), env(), gated));
    const web = started(startClone(db, url('web'), env(), gated));

    expect(stopClone(web.id)).toBe(true);
    expect(web).toMatchObject({ state: 'failed', said: CLONE_STOPPED });

    go();
    await until(() => api.state === 'added');
    await wait(50);
    expect(began).toEqual([url('api')]);
    expect(existsSync(join(root, 'web'))).toBe(false);
    expect(stopClone(web.id)).toBe(false);
    // A new try takes the stopped one's row.
    const again = started(startClone(db, url('web'), env(), clone));
    expect(cloneJobs(project()).map((job) => [job.name, job.state])).toEqual([
      ['api', 'added'],
      ['web', 'waiting'],
    ]);
    // Ended here, so it does not clone into a folder the next test removed.
    await until(() => again.state === 'added');
  });

  it('stops a clone that runs, and the next one gets its turn', async () => {
    await workspace();
    // Runs until its signal says stop, as git does until the stop kills it.
    const endless: Clone = (options) =>
      new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve({ ok: false, reason: CLONE_STOPPED }), { once: true }));
    const api = started(startClone(db, url('api'), env(), endless));
    const web = started(startClone(db, url('web'), env(), clone));
    await until(() => api.state === 'cloning');

    expect(stopClone(api.id)).toBe(true);
    await until(() => web.state === 'added');

    expect(api).toMatchObject({ state: 'failed', said: CLONE_STOPPED });
  });

  // Ctrl+C: git runs in a process group of its own, so the stop has to come from Nolzu.
  it('stops every clone that runs or waits when Nolzu stops, and ends once they have', async () => {
    await workspace();
    const endless: Clone = (options) =>
      new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve({ ok: false, reason: CLONE_STOPPED }), { once: true }));
    const api = started(startClone(db, url('api'), env(), endless));
    const web = started(startClone(db, url('web'), env(), endless));
    await until(() => api.state === 'cloning');

    await stopAllClones();

    expect([api.state, web.state]).toEqual(['failed', 'failed']);
  });

  // Settings, Project clones with no job. Its clone is wrapped, so Ctrl+C reaches it too.
  it('stops a clone Settings started with no job, and ends once it has', async () => {
    await workspace();
    const endless: Clone = (options) =>
      new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve({ ok: false, reason: CLONE_STOPPED }), { once: true }));
    const added = addRepository(db, url('api'), env(), stoppable(endless));
    await wait(50);

    await stopAllClones();

    expect(await added).toMatchObject({ problem: expect.stringContaining(CLONE_STOPPED) });
  });

  it('refuses before there is a job: a project of one repository, a URL with a token, a repository cloning already', async () => {
    const { gated, go } = held();
    execFileSync('git', ['init', '-q', '-b', 'main', at('one')], { env: env() });
    writeSetting(db, 'projectPath', at('one'));
    expect(startClone(db, url('web'), env(), gated)).toEqual({ problem: SHAPE_ONE });
    expect(cloneJobs(at('one'))).toEqual([]);

    await workspace();

    const token = startClone(db, 'https://someone:secret-token@example.com/team/api.git', env(), gated);
    expect(token).toEqual({ problem: expect.stringContaining('user name and password or a token') });
    expect(JSON.stringify(token)).not.toContain('secret-token');
    expect(cloneJobs(project())).toEqual([]);

    const api = started(startClone(db, url('api'), env(), gated));
    expect(startClone(db, url('API'), env(), gated)).toEqual({ problem: 'API is being cloned already.' });
    go();
    await until(() => api.state === 'added');
  });
});
