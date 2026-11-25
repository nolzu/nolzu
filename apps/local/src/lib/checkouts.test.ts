import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { ensureWorktree } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutsSaid, removeCardCheckouts, removeClosedCheckouts } from './checkouts.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const env = Object.fromEntries(Object.entries(ENV).filter((entry): entry is [string, string] => entry[1] !== undefined));
const git = (at: string, ...args: string[]) => execFileSync('git', args, { cwd: at, env: ENV, encoding: 'utf8' }).trim();

let dir = '';
let project = '';
let bare = '';
let db: DatabaseSync;

const repoAt = (at: string, branch: string): void => {
  mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', branch);
  writeFileSync(join(at, 'README.md'), 'recipes\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', 'first');
};

const card = (key: string, stage: string): void => {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', 'Add a search box')").run(key, stage);
};

const checkout = async (repo: string, base: string, key = 'APP-1'): Promise<string> =>
  (await ensureWorktree({ projectPath: project, key, branch: `${key}-work`, baseBranch: base, repo, env })).path;

const commitIn = (at: string, name: string): void => {
  writeFileSync(join(at, name), `${name}\n`);
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', name);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-checkouts-')));
  project = join(dir, 'recipes');
  bare = join(dir, 'remote.git');
  db = openDatabase(dir);
  repoAt(project, 'main');
  git(dir, 'init', '-q', '--bare', bare);
  git(project, 'remote', 'add', 'origin', bare);
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'baseBranch', 'main');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The root ignores its child repository api, which branches from develop.
const withApi = (): void => {
  writeFileSync(join(project, '.gitignore'), 'api/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'ignore api');
  repoAt(join(project, 'api'), 'develop');
  writeSetting(db, 'repos', [
    { path: '.', base: null },
    { path: 'api', base: 'develop' },
  ]);
};

describe('removing the checkouts of one card', () => {
  it('removes the checkout of a closed card whose work is pushed, and the branch stays on the remote', async () => {
    card('APP-1', 'closed');
    const at = await checkout('.', 'main');
    commitIn(at, 'search.ts');
    git(at, 'push', '-q', '-u', 'origin', 'APP-1-work');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: ['.'], kept: [], folder: null });
    expect(existsSync(at)).toBe(false);
    expect(git(project, 'ls-remote', bare, 'APP-1-work')).toContain('refs/heads/APP-1-work');
  });

  it('keeps the checkout of a closed card with an unpushed commit, and names it', async () => {
    card('APP-1', 'closed');
    const at = await checkout('.', 'main');
    git(at, 'push', '-q', '-u', 'origin', 'APP-1-work');
    commitIn(at, 'search.ts');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: [], kept: [{ repo: '.', reason: '1 commit is not pushed, so removing this checkout would leave them only on this machine. Push APP-1-work first.' }], folder: null });
    expect(existsSync(join(at, 'search.ts'))).toBe(true);
  });

  it('refuses a card that is not closed, and keeps its checkout', async () => {
    card('APP-1', 'implement');
    const at = await checkout('.', 'main');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: false, reason: 'APP-1 is not closed, so its checkouts stay. A card keeps them until it reaches Closed.' });
    expect(existsSync(at)).toBe(true);
  });

  it('refuses a card that is not there', async () => {
    expect(await removeCardCheckouts(db, 'APP-9', ENV)).toEqual({ ok: false, reason: 'There is no card APP-9.' });
  });

  // The root's own removal refuses while api sits inside it, so both going proves api went first.
  it('removes the child checkout before the root one', async () => {
    withApi();
    card('APP-1', 'closed');
    const root = await checkout('.', 'main');
    const api = await checkout('api', 'develop');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: ['api', '.'], kept: [], folder: null });
    expect(existsSync(api)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it('keeps the root while a child checkout it holds stays, and names both', async () => {
    withApi();
    card('APP-1', 'closed');
    const root = await checkout('.', 'main');
    const api = await checkout('api', 'develop');
    writeFileSync(join(api, 'draft.ts'), 'draft\n');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done.ok && done.kept.map((one) => one.repo)).toEqual(['api', '.']);
    expect(done.ok && done.kept[0]?.reason).toBe(`${api} has 1 uncommitted change, so it is not safe to remove. Commit them, or remove it yourself if they are not wanted.`);
    expect(done.ok && done.kept[1]?.reason).toContain('still holds the checkout of api');
    expect(existsSync(join(root, 'README.md'))).toBe(true);
  });

  // With no "." in the list, the card's root is a plain folder the loop made to hold the clones.
  it('removes the plain root folder of a workspace card once its clones are gone', async () => {
    rmSync(join(project, 'README.md'));
    writeFileSync(join(project, '.gitignore'), '/api/\n/worktrees/\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'workspace');
    repoAt(join(project, 'api'), 'develop');
    writeSetting(db, 'workspace', true);
    writeSetting(db, 'repos', [{ path: 'api', base: 'develop' }]);
    card('APP-1', 'closed');
    mkdirSync(join(project, 'worktrees', 'APP-1'), { recursive: true });
    await checkout('api', 'develop');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: ['api'], kept: [], folder: null });
    expect(existsSync(join(project, 'worktrees', 'APP-1'))).toBe(false);
  });

  it('keeps a workspace card folder that still holds other files, and names it as the card folder', async () => {
    writeFileSync(join(project, '.gitignore'), '/api/\n/worktrees/\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'workspace');
    repoAt(join(project, 'api'), 'develop');
    writeSetting(db, 'workspace', true);
    writeSetting(db, 'repos', [{ path: 'api', base: 'develop' }]);
    card('APP-1', 'closed');
    const root = join(project, 'worktrees', 'APP-1');
    mkdirSync(root, { recursive: true });
    await checkout('api', 'develop');
    writeFileSync(join(root, 'notes.md'), 'notes\n');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: ['api'], kept: [], folder: `The card folder ${root} still holds other files, so it stays. Look inside and move them away yourself.` });
    expect(existsSync(join(root, 'notes.md'))).toBe(true);
    expect(done.ok && checkoutsSaid('APP-1', done)).toBe(`Removed the checkout of api. The card folder ${root} still holds other files, so it stays. Look inside and move them away yourself.`);
  });

  // In a project with "." and api, a card that picked only api has a plain root folder, not a checkout.
  it('removes the plain root folder of a card that picked only a child, and does not call it a checkout', async () => {
    withApi();
    card('APP-1', 'closed');
    const root = join(project, 'worktrees', 'APP-1');
    mkdirSync(root, { recursive: true });
    const api = await checkout('api', 'develop');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: ['api'], kept: [], folder: null });
    expect(existsSync(api)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it('does not count a folder git has no checkout at as removed', async () => {
    withApi();
    card('APP-1', 'closed');
    const api = join(project, 'worktrees', 'APP-1', 'api');
    mkdirSync(join(api, '.git'), { recursive: true });

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: [], kept: [{ repo: 'api', reason: `git has no checkout at ${api}, so Nolzu leaves the folder alone. Move it away yourself.` }], folder: null });
    expect(existsSync(api)).toBe(true);
  });

  // Most tests drive APP-1 alone, so a key read from the wrong place would pass them. Here a second
  // card has checkouts of its own, and only the one asked for goes.
  it('removes the checkouts of the card asked for, and leaves another card\'s alone', async () => {
    withApi();
    card('APP-1', 'closed');
    card('APP-2', 'closed');
    const other = await checkout('.', 'main', 'APP-1');
    const root = await checkout('.', 'main', 'APP-2');
    const api = await checkout('api', 'develop', 'APP-2');

    const done = await removeCardCheckouts(db, 'APP-2', ENV);

    expect(done).toEqual({ ok: true, removed: ['api', '.'], kept: [], folder: null });
    expect(existsSync(api)).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(other, 'README.md'))).toBe(true);
  });

  it('refuses an open card while another card is closed', async () => {
    card('APP-1', 'closed');
    card('APP-2', 'implement');
    const at = await checkout('.', 'main', 'APP-2');

    const done = await removeCardCheckouts(db, 'APP-2', ENV);

    expect(done).toEqual({ ok: false, reason: 'APP-2 is not closed, so its checkouts stay. A card keeps them until it reaches Closed.' });
    expect(existsSync(at)).toBe(true);
  });

  // A checkout on no branch has only the card's own branch name to send the person to.
  it('names the branch of the card asked for when its checkout is on no branch', async () => {
    card('APP-1', 'closed');
    card('APP-2', 'closed');
    const at = await checkout('.', 'main', 'APP-2');
    commitIn(at, 'search.ts');
    git(at, 'switch', '-q', '--detach');

    const done = await removeCardCheckouts(db, 'APP-2', ENV);

    expect(done.ok && done.kept[0]?.reason).toMatch(/^1 commit is not pushed, so removing this checkout would leave them only on this machine\. Push feature\/APP-2\/\S+ first\.$/);
    expect(existsSync(join(at, 'search.ts'))).toBe(true);
  });

  it('keeps a leftover card folder git does not know, and says so', async () => {
    card('APP-1', 'closed');
    const root = join(project, 'worktrees', 'APP-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'notes.md'), 'notes\n');

    const done = await removeCardCheckouts(db, 'APP-1', ENV);

    expect(done).toEqual({ ok: true, removed: [], kept: [], folder: `The card folder ${root} still holds other files, so it stays. Look inside and move them away yourself.` });
    expect(existsSync(join(root, 'notes.md'))).toBe(true);
  });
});

describe('the sentence on the card page', () => {
  it('names what went', () => {
    expect(checkoutsSaid('APP-1', { ok: true, removed: ['api', '.'], kept: [], folder: null })).toBe('Removed the checkout of api, the project folder.');
  });

  it('names what stayed with its reason', () => {
    expect(checkoutsSaid('APP-1', { ok: true, removed: [], kept: [{ repo: '.', reason: 'Push APP-1-work first.' }], folder: null })).toBe('The checkout of the project folder stays. Push APP-1-work first.');
  });

  it('names both', () => {
    expect(checkoutsSaid('APP-1', { ok: true, removed: ['api'], kept: [{ repo: 'web', reason: 'It has 1 uncommitted change.' }], folder: null })).toBe(
      'Removed the checkout of api. The checkout of web stays. It has 1 uncommitted change.',
    );
  });

  it('says so when there was nothing', () => {
    expect(checkoutsSaid('APP-1', { ok: true, removed: [], kept: [], folder: null })).toBe('APP-1 has no checkout.');
  });
});

describe('removing the checkouts of every closed card', () => {
  it('removes what is safe, names what stays, and leaves open cards alone', async () => {
    card('APP-1', 'closed');
    card('APP-2', 'closed');
    card('APP-3', 'implement');
    card('APP-4', 'closed');
    const one = await checkout('.', 'main', 'APP-1');
    const two = await checkout('.', 'main', 'APP-2');
    const three = await checkout('.', 'main', 'APP-3');
    writeFileSync(join(two, 'draft.ts'), 'draft\n');

    const said = await removeClosedCheckouts(db, ENV);

    expect(said).toBe(`Removed the checkouts of APP-1. APP-2 keeps the checkout of the project folder. ${two} has 1 uncommitted change, so it is not safe to remove. Commit them, or remove it yourself if they are not wanted.`);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(true);
    expect(existsSync(three)).toBe(true);
  });

  it('says so when no closed card has a checkout', async () => {
    card('APP-1', 'closed');

    expect(await removeClosedCheckouts(db, ENV)).toBe('No closed card has a checkout.');
  });

  it('says once that no project is set', async () => {
    card('APP-1', 'closed');
    card('APP-2', 'closed');
    writeSetting(db, 'projectPath', null);

    expect(await removeClosedCheckouts(db, ENV)).toBe('There is no project set, so there is no checkout to remove.');
  });
});
