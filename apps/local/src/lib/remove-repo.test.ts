import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { cloneTarget } from '@nolzu/runner';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRepository, type Clone } from './add-repo.ts';
import { MANIFEST } from './manifest.ts';
import { createWorkspace } from './onboard.ts';
import { projectRow, removeConfirm, removeConfirmNow, repoTable } from './projects.ts';
import ProjectsList from './ProjectsList.svelte';
import { REMOVE_CHECKS, removeChecks, removeRepository } from './remove-repo.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';

// The Walls box links to Settings, Wall, so the page says where it is drawn.
drawnAt('/settings/project');

// The delete cannot be undone, so most of these prove that a refusal removes nothing.
let home = '';
let db: DatabaseSync;
const env = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const inGit = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { env: env(), encoding: 'utf8' }).trim();
const at = (...parts: string[]) => join(home, ...parts);
const url = (name: string) => `https://example.com/team/${name}.git`;

const bare = (name: string) => {
  const source = at('src', name);
  execFileSync('git', ['init', '-q', '-b', 'develop', source], { env: env() });
  writeFileSync(join(source, 'package.json'), '{}\n');
  inGit(source, 'add', '-A');
  inGit(source, 'commit', '-q', '-m', 'first');
  execFileSync('git', ['clone', '-q', '--bare', source, at('remotes', `${name}.git`)], { env: env() });
};
const clone: Clone = async ({ workspace, url: typed, taken }) => {
  const target = cloneTarget(typed, taken);
  if (!target.ok) return target;
  execFileSync('git', ['clone', '-q', at('remotes', `${target.name}.git`), join(workspace, target.name)], { env: env() });
  return { ok: true, name: target.name, path: join(workspace, target.name) };
};
const remove = (path: string, typed = path) => removeRepository(db, path, typed, env());

// A workspace with api cloned, listed, ignored, in the manifest and with its knowledge file.
const workspaceWithApi = async () => {
  const made = await createWorkspace(db, { parent: home, name: 'recipes', home, env: env() });
  if (!made.ok) throw new Error(made.reason);
  await addRepository(db, url('api'), env(), clone);
  return made.path;
};
const knowledge = (root: string) => join(root, '.nolzu', 'knowledge', 'api', 'repository.md');
// Everything a refusal must leave as it was.
const state = (root: string) => ({
  repos: getSetting(db, 'repos'),
  ignore: readFileSync(join(root, '.gitignore'), 'utf8'),
  manifest: readFileSync(join(root, MANIFEST), 'utf8'),
  head: inGit(root, 'rev-parse', 'HEAD'),
  api: existsSync(join(root, 'api', 'package.json')),
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nolzu-remove-repo-'));
  db = openDatabase(at('data'));
  bare('api');
  bare('lib');
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('removing a clone from a workspace', () => {
  it('removes a clean clone with every branch pushed, and keeps its knowledge file', async () => {
    const root = await workspaceWithApi();

    expect(await remove('api')).toEqual({ said: 'Removed api. Its knowledge file api/repository.md stays.' });

    expect(existsSync(join(root, 'api'))).toBe(false);
    expect(readFileSync(knowledge(root), 'utf8')).toContain('# The api repository');
    // The last repository of a workspace may go.
    expect(getSetting(db, 'repos')).toEqual([]);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n');
    expect(JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'))).toEqual({ workspace: true, repositories: [] });
    expect(inGit(root, 'log', '-1', '--pretty=%s')).toBe('chore: remove api');
    expect(inGit(root, 'status', '--porcelain')).toBe('');
    // Nothing brings it back: the manifest no longer asks for it.
    expect((await projectRow(db)).missing).toEqual([]);
  });

  it('removes nothing when the typed name does not match exactly', async () => {
    const root = await workspaceWithApi();
    const before = state(root);

    for (const typed of ['', 'API', ' api', 'web']) {
      expect(await remove('api', typed)).toEqual({ problem: 'To remove api, type its folder name api exactly. Nothing was removed.' });
    }
    expect(state(root)).toEqual(before);
  });

  it('keeps a clone with an unpushed branch, a stash, a dirty tree, or a commit on no branch, with a sentence naming why', async () => {
    const root = await workspaceWithApi();
    const api = join(root, 'api');
    const before = state(root);

    writeFileSync(join(api, 'notes.txt'), 'mine\n');
    expect(await remove('api')).toEqual({ problem: 'api has 1 file that is not committed, so it stays. Commit and push the changes, or move them away. Nothing was removed.' });
    writeFileSync(join(api, 'package.json'), '{"name":"api"}\n');
    expect(await remove('api')).toMatchObject({ problem: expect.stringMatching(/^api has 2 files that are not committed, so it stays\./) });

    inGit(api, 'stash', '-q', '--include-untracked');
    expect(await remove('api')).toEqual({ problem: 'api has a stash, so it stays. Apply it and push the work, or drop it with git stash drop. Nothing was removed.' });
    inGit(api, 'stash', 'drop', '-q');

    // The folder goes whole, so a .env git ignores would go with it. node_modules comes back with an install.
    writeFileSync(join(api, '.git', 'info', 'exclude'), '.env\nnode_modules/\n');
    writeFileSync(join(api, '.env'), 'TOKEN=mine\n');
    mkdirSync(join(api, 'node_modules'));
    writeFileSync(join(api, 'node_modules', 'x.js'), '\n');
    expect(await remove('api')).toEqual({ problem: 'api has 1 file or folder git ignores (.env), so it stays: removing it would delete it. Move it away first. Nothing was removed.' });
    rmSync(join(api, '.env'));
    rmSync(join(api, 'node_modules'), { recursive: true });

    inGit(api, 'switch', '-q', '-c', 'search');
    inGit(api, 'commit', '-q', '--allow-empty', '-m', 'search box');
    expect(await remove('api')).toEqual({ problem: 'The branch search of api has commits on no remote, so api stays. Push them first. Nothing was removed.' });
    inGit(api, 'switch', '-q', '--detach');
    inGit(api, 'branch', '-q', '-D', 'search');
    expect(await remove('api')).toMatchObject({ problem: expect.stringMatching(/^api has commits on no branch and on no remote, from a detached HEAD or another ref, so it stays\./) });
    inGit(api, 'switch', '-q', 'develop');
    inGit(api, 'tag', 'v1', 'HEAD@{1}');
    expect(await remove('api')).toEqual({ problem: 'The tag v1 of api is on no remote, so api stays. Push it with git push origin v1, or delete it. Nothing was removed.' });

    expect(state(root)).toEqual(before);
  });

  // A .env git ignores is often the only copy of its keys, so the clone stays until it is moved away.
  // A folder tools make again goes with the clone.
  it('keeps a clone with an ignored file, and lets one with only node_modules go', async () => {
    const root = await workspaceWithApi();
    writeFileSync(join(root, 'api', '.gitignore'), '.env\nnode_modules/\n');
    inGit(join(root, 'api'), 'add', '.gitignore');
    inGit(join(root, 'api'), 'commit', '-q', '-m', 'ignore');
    inGit(join(root, 'api'), 'push', '-q', 'origin', 'develop');
    writeFileSync(join(root, 'api', '.env'), 'KEY=1\n');
    mkdirSync(join(root, 'api', 'node_modules'));
    writeFileSync(join(root, 'api', 'node_modules', 'x.js'), '\n');

    expect(await remove('api')).toMatchObject({ problem: expect.stringMatching(/^api has 1 file or folder git ignores \(\.env\), so it stays/) });
    expect(existsSync(join(root, 'api', '.env'))).toBe(true);

    rmSync(join(root, 'api', '.env'));
    expect(await remove('api')).toMatchObject({ said: expect.stringMatching(/^Removed api\./) });
    expect(existsSync(join(root, 'api'))).toBe(false);
  });

  it('refuses a repository a card has a checkout of, and one with a checkout git knows of', async () => {
    const root = await workspaceWithApi();
    const before = state(root);
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
    mkdirSync(join(root, 'worktrees', 'APP-1'), { recursive: true });
    inGit(join(root, 'api'), 'worktree', 'add', '-q', '-b', 'APP-1-search', join(root, 'worktrees', 'APP-1', 'api'));

    expect(await remove('api')).toEqual({ problem: "APP-1 has a checkout of api, so api stays. The card's work there would be left out of its changes. Nothing was removed." });

    // A card that is gone leaves its checkout behind, and git still knows it.
    db.prepare('DELETE FROM cards').run();
    expect(await remove('api')).toMatchObject({ problem: expect.stringMatching(/^api has another checkout at .*APP-1\/api, so it stays\./) });
    expect(state(root)).toEqual(before);
  });

  it('refuses a clone folder that is a link, and leaves what it points at alone', async () => {
    const root = await workspaceWithApi();
    execFileSync('git', ['clone', '-q', at('remotes', 'lib.git'), at('outside', 'lib')], { env: env() });
    symlinkSync(at('outside', 'lib'), join(root, 'lib'));
    writeSetting(db, 'repos', [...(getSetting(db, 'repos') ?? []), { path: 'lib', base: 'develop' }]);

    expect(await remove('lib')).toEqual({ problem: 'The folder lib is a link, so Nolzu leaves it and what it points at alone. Nothing was removed.' });
    expect(existsSync(at('outside', 'lib', 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'lib'))).toBe(true);
  });

  it('refuses a folder that is not a repository of its own', async () => {
    const root = await workspaceWithApi();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'readme.md'), 'mine\n');
    writeSetting(db, 'repos', [...(getSetting(db, 'repos') ?? []), { path: 'docs', base: 'develop' }]);

    expect(await remove('docs')).toEqual({ problem: 'The folder docs is not a git repository of its own, so Nolzu cannot check it for work. Nothing was removed.' });
    expect(existsSync(join(root, 'docs', 'readme.md'))).toBe(true);
  });

  // git in a plain folder answers about the repository around it, so the confirm would say the root's
  // remote keeps docs.
  it('names no remote in the confirm of a folder that is not a repository of its own', async () => {
    const root = await workspaceWithApi();
    inGit(root, 'remote', 'add', 'origin', 'https://github.com/recipes-app/recipes.git');
    mkdirSync(join(root, 'docs'));
    writeSetting(db, 'repos', [...(getSetting(db, 'repos') ?? []), { path: 'docs', base: 'develop' }]);

    expect((await removeConfirmNow(db, 'docs'))?.kept.text).toBe('Its knowledge file docs/repository.md stays.');
  });

  it('refuses a hand-edited list entry that leads out of the project folder, and leaves that folder alone', async () => {
    const root = await workspaceWithApi();
    execFileSync('git', ['clone', '-q', at('remotes', 'lib.git'), at('lib')], { env: env() });
    db.prepare("UPDATE settings SET value = ? WHERE key = 'repos'").run(JSON.stringify([...(getSetting(db, 'repos') ?? []), { path: '../lib', base: 'develop' }]));
    const before = state(root);

    // The settings reader drops the entry first. The folder-name check in the remover is the second wall.
    expect(await remove('../lib')).toMatchObject({ problem: expect.stringMatching(/Nothing was removed\.$/) });
    expect(existsSync(at('lib', 'package.json'))).toBe(true);
    expect(state(root)).toEqual(before);
  });

  it('takes a repository whose folder is gone off the list and out of the records', async () => {
    const root = await workspaceWithApi();
    rmSync(join(root, 'api'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect(await remove('api')).toEqual({ said: 'Removed api. Its knowledge file api/repository.md stays.' });
    expect(getSetting(db, 'repos')).toEqual([]);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n');
  });

  it('removes nothing when the manifest cannot be read', async () => {
    const root = await workspaceWithApi();
    writeFileSync(join(root, MANIFEST), '{ nope');

    expect(await remove('api')).toEqual({ problem: '.nolzu/repositories.json is not JSON, so Nolzu left it alone and did not take api out of it. Nothing was removed.' });
    expect(existsSync(join(root, 'api', 'package.json'))).toBe(true);
  });

  it('writes but does not commit the records when .gitignore holds an edit of the person', async () => {
    const root = await workspaceWithApi();
    writeFileSync(join(root, '.gitignore'), '/worktrees/\n/.tasks/\n/api/\n/scratch/\n');

    expect(await remove('api')).toEqual({
      said: 'Removed api. Its knowledge file api/repository.md stays. .gitignore and .nolzu/repositories.json no longer name api. Nolzu did not commit them, because they held changes of yours that were not committed.',
    });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n/scratch/\n');
    expect(JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')).repositories).toEqual([]);
    expect(inGit(root, 'log', '-1', '--pretty=%s')).not.toBe('chore: remove api');
  });

  it('refuses a clone that holds submodules of its own', async () => {
    const root = await workspaceWithApi();
    const api = join(root, 'api');
    inGit(api, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', at('remotes', 'lib.git'), 'lib');
    inGit(api, 'commit', '-q', '-m', 'add lib');
    inGit(api, 'push', '-q', 'origin', 'develop');
    const before = state(root);

    expect(await remove('api')).toEqual({ problem: 'api holds submodules of its own, and Nolzu cannot check their work. Remove api by hand. Nothing was removed.' });
    expect(state(root)).toEqual(before);
    expect(existsSync(join(api, 'lib', 'package.json'))).toBe(true);
  });

  it('removes nothing when .gitignore is a link', async () => {
    const root = await workspaceWithApi();
    writeFileSync(at('elsewhere'), '/worktrees/\n/api/\n');
    rmSync(join(root, '.gitignore'));
    symlinkSync(at('elsewhere'), join(root, '.gitignore'));

    expect(await remove('api')).toEqual({ problem: '.gitignore in the project folder is a link or not a plain file, so Nolzu cannot take api out of it. Nothing was removed.' });
    expect(existsSync(join(root, 'api', 'package.json'))).toBe(true);
    expect(readFileSync(at('elsewhere'), 'utf8')).toBe('/worktrees/\n/api/\n');
  });

  it('puts .gitignore back when the manifest cannot be written', async () => {
    const root = await workspaceWithApi();
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    chmodSync(join(root, MANIFEST), 0o444);

    expect(await remove('api')).toMatchObject({ said: expect.stringMatching(/^Removed api\. .* Nolzu could not take api out of \.nolzu\/repositories\.json in the project folder\./) });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(ignore);
  });

  // A release tag whose branch was deleted on the host: its commits came with the clone, so they are there.
  const tagOnDeletedBranch = (api: string) => {
    inGit(api, 'switch', '-q', '-c', 'release');
    inGit(api, 'commit', '-q', '--allow-empty', '-m', 'fix: a security issue');
    inGit(api, 'tag', '-a', '-m', 'release', '1.9.5-1');
    inGit(api, 'push', '-q', 'origin', 'release', '1.9.5-1');
    inGit(api, 'push', '-q', 'origin', '--delete', 'release');
    inGit(api, 'switch', '-q', 'develop');
    inGit(api, 'branch', '-q', '-D', 'release');
  };

  it('removes a clone whose only other commits sit under a tag origin has', async () => {
    const root = await workspaceWithApi();
    tagOnDeletedBranch(join(root, 'api'));

    expect(await remove('api')).toMatchObject({ said: expect.stringMatching(/^Removed api\./) });
    expect(existsSync(join(root, 'api'))).toBe(false);
  });

  it('keeps a clone with a tag only it has, and names the tag', async () => {
    const root = await workspaceWithApi();
    const api = join(root, 'api');
    tagOnDeletedBranch(api);
    inGit(api, 'switch', '-q', '--detach');
    inGit(api, 'commit', '-q', '--allow-empty', '-m', 'mine');
    inGit(api, 'tag', 'mine');
    inGit(api, 'tag', 'also-mine');
    inGit(api, 'switch', '-q', 'develop');
    const before = state(root);

    expect(await remove('api')).toEqual({ problem: 'The tags also-mine and mine of api are on no remote, so api stays. Push them with git push origin --tags, or delete them. Nothing was removed.' });
    expect(state(root)).toEqual(before);
  });

  it('says origin could not be reached when the tags cannot be checked', async () => {
    const root = await workspaceWithApi();
    const api = join(root, 'api');
    tagOnDeletedBranch(api);
    // A tag on a pushed commit holds nothing, so it is not named.
    inGit(api, 'tag', 'v1', 'develop');
    inGit(api, 'remote', 'set-url', 'origin', at('remotes', 'gone.git'));
    const before = state(root);

    expect(await remove('api')).toMatchObject({ problem: expect.stringMatching(/^Nolzu could not reach origin to check the tag 1\.9\.5-1 of api, so api stays\. Check the connection, then try again\. fatal: .* does not appear to be a git repository\. Nothing was removed\.$/) });
    expect(state(root)).toEqual(before);
  });

  it('does not read a git killed on the way to origin as origin having no tags', async () => {
    const root = await workspaceWithApi();
    const api = join(root, 'api');
    tagOnDeletedBranch(api);
    inGit(api, 'remote', 'set-url', 'origin', 'ssh://example.invalid/api.git');

    // The ssh command kills the git that started it, which then prints nothing.
    expect(await removeRepository(db, 'api', 'api', { ...env(), GIT_SSH_COMMAND: 'kill -9 $PPID' })).toEqual({
      problem: 'Nolzu could not reach origin to check the tag 1.9.5-1 of api, so api stays. Check the connection, then try again. Nothing was removed.',
    });
  });

  it('keeps a clone with a detached HEAD past a tag origin has', async () => {
    const root = await workspaceWithApi();
    const api = join(root, 'api');
    tagOnDeletedBranch(api);
    inGit(api, 'switch', '-q', '--detach', '1.9.5-1');
    inGit(api, 'commit', '-q', '--allow-empty', '-m', 'mine');

    expect(await remove('api')).toMatchObject({ problem: expect.stringMatching(/^api has commits on no branch and on no remote, from a detached HEAD or another ref, so it stays\./) });
    expect(existsSync(join(api, 'package.json'))).toBe(true);
  });

  it('removes a clone whose branch shares its name with a tag', async () => {
    const root = await workspaceWithApi();
    inGit(join(root, 'api'), 'tag', 'develop');

    expect(await remove('api')).toMatchObject({ said: expect.stringMatching(/^Removed api\./) });
    expect(existsSync(join(root, 'api'))).toBe(false);
  });

  it('keeps a .gitignore line that ignores api at any depth', async () => {
    const root = await workspaceWithApi();
    writeFileSync(join(root, '.gitignore'), '/worktrees/\n/.tasks/\n/api/\napi/\n');
    inGit(root, 'commit', '-q', '-am', 'ignore api anywhere');

    expect(await remove('api')).toMatchObject({ said: expect.stringMatching(/^Removed api\./) });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\napi/\n');
  });

  it('takes both out of the records when two removes overlap', async () => {
    const root = await workspaceWithApi();
    await addRepository(db, url('lib'), env(), clone);
    const both = await Promise.all([remove('api'), remove('lib')]);

    expect(both.every((one) => 'said' in one)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')).repositories).toEqual([]);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n');
  });

  it('draws no Remove box for the last repository of a project that is not a workspace', async () => {
    await workspaceWithApi();
    db.prepare("DELETE FROM settings WHERE key = 'workspace'").run();

    const body = render(ProjectsList, { props: { row: await projectRow(db) } }).body;

    expect(body).not.toContain('aria-label="Remove api"');
  });

  it('draws the answer of a remove under the table', async () => {
    await workspaceWithApi();
    const said = { field: 'remove:api', text: 'Removed api. Its knowledge file api/repository.md stays.' };

    const body = render(ProjectsList, { props: { row: await projectRow(db), said } }).body;

    expect(body).toContain('Removed api. Its knowledge file api/repository.md stays.');
  });

  it('draws the typed name box for the last repository of a workspace, and says the knowledge file stays', async () => {
    await workspaceWithApi();

    const body = render(ProjectsList, { props: { row: await projectRow(db), table: await repoTable(db) } }).body;

    expect(body).toContain('aria-label="Remove api"');
    expect(body).toContain('name="typed"');
    // Said in the Remove dialog, which a server render does not open.
    expect((await removeConfirmNow(db, 'api'))?.kept.text).toContain('Its knowledge file api/repository.md stays.');
  });
});

// Remove runs its checks before it asks for the name: the check pass finds what the delete pass would
// refuse, and changes nothing.
describe('the check pass', () => {
  const lines = [REMOVE_CHECKS.checkouts, REMOVE_CHECKS.work, REMOVE_CHECKS.commits];

  it('ticks each line on a clean clone with every commit pushed, and changes nothing', async () => {
    const root = await workspaceWithApi();
    const before = state(root);

    expect(await removeChecks(db, 'api', env())).toEqual({ passed: lines, failed: [] });
    expect(state(root)).toEqual(before);
  });

  it('names a checkout, a running card and commits on no remote, and the delete pass refuses with the same words', async () => {
    const root = await workspaceWithApi();
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
    mkdirSync(join(root, 'worktrees', 'APP-1', 'api'), { recursive: true });
    writeFileSync(join(root, 'worktrees', 'APP-1', 'api', '.git'), 'gitdir: elsewhere\n');
    // A card that picked no repositories works on all of them, so its run can use api.
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Sort recipes by time' });
    db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-2'").run();
    inGit(join(root, 'api'), 'commit', '-q', '--allow-empty', '-m', 'mine');
    const before = state(root);

    const found = await removeChecks(db, 'api', env());

    expect(found).toEqual({
      passed: [REMOVE_CHECKS.work],
      failed: [
        "APP-1 has a checkout of api, so api stays. The card's work there would be left out of its changes.",
        'APP-2 is running on api now, so api stays until that run ends.',
        'The branch develop of api has commits on no remote, so api stays. Push them first.',
      ],
    });
    // The typed name matches, and still nothing goes while a check fails.
    expect(await remove('api')).toEqual({ problem: `${found.failed.join(' ')} Nothing was removed.` });
    expect(state(root)).toEqual(before);
    // What the page's confirm shows: the findings in the red box and the line that holds with a tick.
    expect(await removeConfirmNow(db, 'api')).toMatchObject({ gone: found.failed, checked: found.passed });
  });

  it('leaves out a card whose run uses only other repositories, and names every card with a checkout', async () => {
    const root = await workspaceWithApi();
    await addRepository(db, url('lib'), env(), clone);
    createCard(db, { key: 'APP-3', board: 'delivery', stage: 'implement', title: 'Add tags' });
    db.prepare(`UPDATE cards SET state = 'queued', repos = '["lib"]', repos_by = 'person' WHERE key = 'APP-3'`).run();
    for (const key of ['APP-4', 'APP-5']) {
      createCard(db, { key, board: 'delivery', stage: 'implement', title: 'Add tags' });
      mkdirSync(join(root, 'worktrees', key, 'api'), { recursive: true });
      writeFileSync(join(root, 'worktrees', key, 'api', '.git'), 'gitdir: elsewhere\n');
    }

    expect((await removeChecks(db, 'api', env())).failed).toEqual(["APP-4 and APP-5 have a checkout of api, so api stays. Their work there would be left out of their changes."]);
    expect((await removeChecks(db, 'lib', env())).failed).toEqual(['APP-3 is running on lib now, so lib stays until that run ends.']);
  });

  it('stops at a reason the folder cannot be checked, and ticks nothing', async () => {
    const root = await workspaceWithApi();
    mkdirSync(join(root, 'docs'));
    writeSetting(db, 'repos', [...(getSetting(db, 'repos') ?? []), { path: 'docs', base: 'develop' }]);

    expect(await removeChecks(db, 'docs', env())).toEqual({ passed: [], failed: ['The folder docs is not a git repository of its own, so Nolzu cannot check it for work.'] });
    expect(await removeChecks(db, 'web', env())).toEqual({ passed: [], failed: ['There is no repository web in this project.'] });
  });

  it('ticks every line for a folder that is gone, which holds nothing to lose', async () => {
    const root = await workspaceWithApi();
    rmSync(join(root, 'api'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect(await removeChecks(db, 'api', env())).toEqual({ passed: lines, failed: [] });
  });
});

describe('removing a submodule from a root that holds code', () => {
  it('runs deinit and git rm, commits, and removes its .git/modules entry', async () => {
    const root = at('shop');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: env() });
    inGit(root, 'commit', '-q', '--allow-empty', '-m', 'first');
    inGit(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--name', 'libname', at('remotes', 'lib.git'), 'lib');
    mkdirSync(join(root, '.nolzu', 'knowledge', 'lib'), { recursive: true });
    writeFileSync(join(root, '.nolzu', 'knowledge', 'lib', 'repository.md'), '# lib\n');
    inGit(root, 'add', '.nolzu');
    inGit(root, 'commit', '-q', '-m', 'add lib');
    writeSetting(db, 'projectPath', root);
    writeSetting(db, 'repos', [
      { path: '.', base: 'main' },
      { path: 'lib', base: 'develop' },
    ]);
    // The name differs from the folder, so the modules entry is found through git and not built from the path.
    expect(existsSync(join(root, '.git', 'modules', 'libname'))).toBe(true);

    expect(await remove('lib')).toEqual({ said: 'Removed lib. Its knowledge file lib/repository.md stays.' });

    expect(existsSync(join(root, 'lib'))).toBe(false);
    expect(existsSync(join(root, '.git', 'modules', 'libname'))).toBe(false);
    expect(inGit(root, 'ls-files', '--', 'lib')).toBe('');
    expect(readFileSync(join(root, '.gitmodules'), 'utf8')).not.toContain('lib');
    expect(inGit(root, 'log', '-1', '--pretty=%s')).toBe('chore: remove lib');
    expect(inGit(root, 'status', '--porcelain')).toBe('');
    expect(getSetting(db, 'repos')).toEqual([{ path: '.', base: 'main' }]);
    expect(readFileSync(join(root, '.nolzu', 'knowledge', 'lib', 'repository.md'), 'utf8')).toBe('# lib\n');
  });

  it('keeps a submodule with an unpushed commit, and its history', async () => {
    const root = at('shop');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: env() });
    inGit(root, 'commit', '-q', '--allow-empty', '-m', 'first');
    inGit(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', at('remotes', 'lib.git'), 'lib');
    inGit(root, 'commit', '-q', '-m', 'add lib');
    inGit(join(root, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'mine');
    writeSetting(db, 'projectPath', root);
    writeSetting(db, 'repos', [
      { path: '.', base: 'main' },
      { path: 'lib', base: 'develop' },
    ]);

    expect(await remove('lib')).toEqual({ problem: 'The branch develop of lib has commits on no remote, so lib stays. Push them first. Nothing was removed.' });
    expect(existsSync(join(root, 'lib', 'package.json'))).toBe(true);
    expect(existsSync(join(root, '.git', 'modules', 'lib'))).toBe(true);
  });

  // A shop root with lib as a submodule, set as the project.
  const shop = (folder = 'shop') => {
    const root = at(folder);
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: env() });
    inGit(root, 'commit', '-q', '--allow-empty', '-m', 'first');
    inGit(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', at('remotes', 'lib.git'), 'lib');
    inGit(root, 'commit', '-q', '-m', 'add lib');
    writeSetting(db, 'projectPath', root);
    writeSetting(db, 'repos', [
      { path: '.', base: 'main' },
      { path: 'lib', base: 'develop' },
    ]);
    return root;
  };

  it('keeps a submodule while .gitmodules holds an edit that is not committed', async () => {
    const root = shop();
    writeFileSync(join(root, '.gitmodules'), `${readFileSync(join(root, '.gitmodules'), 'utf8')}# mine\n`);

    expect(await remove('lib')).toEqual({ problem: '.gitmodules has changes of yours that are not committed, so lib stays. Commit them first. Nothing was removed.' });
    expect(existsSync(join(root, 'lib', 'package.json'))).toBe(true);
    expect(existsSync(join(root, '.git', 'modules', 'lib'))).toBe(true);
  });

  it('keeps a submodule whose history is not in the root\'s .git/modules', async () => {
    const root = at('shop');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: env() });
    // A clone added as it is keeps its .git folder inside it, the way old submodules did.
    execFileSync('git', ['clone', '-q', at('remotes', 'lib.git'), join(root, 'lib')], { env: env() });
    inGit(root, '-c', 'advice.addEmbeddedRepo=false', 'add', 'lib');
    inGit(root, 'commit', '-q', '-m', 'add lib');
    writeSetting(db, 'projectPath', root);
    writeSetting(db, 'repos', [
      { path: '.', base: 'main' },
      { path: 'lib', base: 'develop' },
    ]);

    expect(await remove('lib')).toEqual({ problem: "The history of the submodule lib is not in the root's .git/modules folder, so Nolzu leaves it alone. Nothing was removed." });
    expect(existsSync(join(root, 'lib', '.git'))).toBe(true);
  });

  it('removes a submodule that was never set up', async () => {
    shop();
    execFileSync('git', ['clone', '-q', at('shop'), at('copy')], { env: env() });
    writeSetting(db, 'projectPath', at('copy'));

    expect(await remove('lib')).toEqual({ said: 'Removed lib. Its knowledge file lib/repository.md stays.' });
    expect(existsSync(at('copy', 'lib'))).toBe(false);
    expect(inGit(at('copy'), 'ls-files', '--', 'lib')).toBe('');
    expect(inGit(at('copy'), 'log', '-1', '--pretty=%s')).toBe('chore: remove lib');
  });

  it('finishes a submodule that a deinit already emptied, and keeps its history', async () => {
    const root = shop();
    inGit(root, 'submodule', 'deinit', '-q', '-f', 'lib');

    expect(await remove('lib')).toEqual({ said: 'Removed lib. Its knowledge file lib/repository.md stays.' });
    expect(inGit(root, 'ls-files', '--', 'lib')).toBe('');
    expect(inGit(root, 'status', '--porcelain')).toBe('');
    // Its work was never checked, so its history is not Nolzu's to delete.
    expect(existsSync(join(root, '.git', 'modules', 'lib'))).toBe(true);
  });
});

// What the typed confirm of Remove says before anything goes: what is deleted, the work that exists
// nowhere else in the red box, what stays, and the folder name to type (the States design).
describe('removeConfirm', () => {
  const facts = { project: 'recipes', folder: '~/nolzu/recipes/web', remote: { host: 'github.com', path: 'recipes-app/web' }, records: true };

  it('lists the folder it deletes, the records it commits, and what stays', () => {
    expect(removeConfirm('web', facts)).toEqual({
      title: 'Remove repository web',
      sub: 'From the project recipes. This cannot be undone.',
      // Every path is set in mono, in the order it stands in its line.
      lost: [
        { text: 'Deletes the folder ~/nolzu/recipes/web.', code: '~/nolzu/recipes/web' },
        { text: 'Takes web out of .gitignore and .nolzu/repositories.json, and commits that.', code: ['.gitignore', '.nolzu/repositories.json'] },
      ],
      checked: [],
      gone: [],
      kept: { text: 'Its knowledge file web/repository.md stays. GitHub keeps recipes-app/web, so you can add it again later.', code: 'web/repository.md' },
      action: 'Remove web',
    });
  });

  // The check pass hands in what it found for the red box, and the lines that hold for the ticks.
  it('puts the findings it is handed in the red box, and the lines that hold beside them', () => {
    const confirm = removeConfirm('web', facts, ['APP-9 has a checkout of web, so web stays.'], ['Nothing uncommitted, no stash']);

    expect(confirm.gone).toEqual(['APP-9 has a checkout of web, so web stays.']);
    expect(confirm.checked).toEqual(['Nothing uncommitted, no stash']);
  });

  it('names a host it does not know by its address, and says nothing of a remote that is not there', () => {
    expect(removeConfirm('web', { ...facts, remote: { host: 'git.example.com', path: 'team/web' } }).kept.text).toBe('Its knowledge file web/repository.md stays. git.example.com keeps team/web, so you can add it again later.');
    expect(removeConfirm('web', { ...facts, remote: null }).kept.text).toBe('Its knowledge file web/repository.md stays.');
  });

  it('commits nothing in a plain folder of repositories, and names no project when none is set', () => {
    const plain = removeConfirm('web', { ...facts, project: null, records: false });

    expect(plain.lost).toEqual([{ text: 'Deletes the folder ~/nolzu/recipes/web.', code: '~/nolzu/recipes/web' }]);
    expect(plain.sub).toBe('This cannot be undone.');
  });
});
