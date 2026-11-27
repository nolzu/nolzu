import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { pinGitLink, repoPlaces } from '@nolzu/runner';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('./hub-link.ts', async (real) => ({ ...(await real<object>()), dialHubAgain: () => false, hubStatus: () => 'closed' }));

// Two projects in one temp data folder, read by the routes of one server. Not fake mode: fake mode ignores
// NOLZU_DATA_DIR on purpose, and nothing here starts a run.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-two-projects-'));
process.env.NOLZU_DATA_DIR = dir;

const { database, pinProjectGit } = await import('./db.ts');
const { createLoop, loop } = await import('./loop.ts');
const { load } = await import('../routes/+layout.server.ts');
const { POST } = await import('../routes/api/cards/+server.ts');

const first = openDatabase(dir);
writeSetting(first, 'projectPath', join(tmpdir(), 'nolzu-two-projects-code', 'recipes'));
const second = createProject(dir);
writeSetting(second, 'projectPath', join(tmpdir(), 'nolzu-two-projects-code', 'shop'));
writeSetting(second, 'localKeyPrefix', 'SHOP');
const open = (id: number) => writeSetting(first, 'currentProject', id);

const rail = async () => ((await load({ url: new URL('http://localhost/b/delivery') } as never)) as { project: string | null }).project;
const addCard = async (title: string) => {
  const answer = await POST({ request: new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify({ input: '', title }) }) } as never);
  expect(answer.status).toBe(201);
};
const keys = (id: number) => (database(id).prepare('SELECT key FROM cards ORDER BY key').all() as { key: string }[]).map((row) => row.key);
const drawn = (id: number) => loop(process.env, id).snapshot().cards.map((card) => card.key);

afterAll(() => {
  createLoop(dir, process.env, { project: 2 }).close();
  createLoop(dir).close();
  first.close();
  second.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('reads each project through its own routes, side by side in one server', async () => {
  // No current project yet: the first one.
  expect(await rail()).toBe('recipes');
  await addCard('Add a search box');

  // New project or the selector made the second one current.
  open(2);
  expect(await rail()).toBe('shop');
  await addCard('Ship the cart');

  expect(keys(1)).toEqual(['APP-1']);
  expect(keys(2)).toEqual(['SHOP-1']);
  expect(database()).toBe(database(2));
  // Both loops run at once, each over its own project, and the current one is what a route gets.
  expect(drawn(1)).toEqual(['APP-1']);
  expect(drawn(2)).toEqual(['SHOP-1']);
  expect(loop()).toBe(loop(process.env, 2));
  expect(loop(process.env, 1)).not.toBe(loop(process.env, 2));
  // The first project has one loop whether it is named by its id or not.
  expect(createLoop(dir, process.env, { project: 1 })).toBe(createLoop(dir));
});

// Every plan holds as many projects as the person makes: a route that names a
// project opens it, with no account, and the rest read the current one.
it('opens a project a route names with no account, and reads the current one otherwise', async () => {
  open(2);
  expect(await rail()).toBe('shop');
  expect(keys(1)).toEqual(['APP-1']);
  expect(drawn(1)).toEqual(['APP-1']);

  open(1);
  expect(await rail()).toBe('recipes');
  expect(database()).toBe(database(1));
  expect(keys(2)).toEqual(['SHOP-1']);
});

// A caller that names the first project by its id before any loop of its data folder is open, as after
// a start, still gets the one loop.
it('gives the first project one loop when its id comes before any loop knew it', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'nolzu-first-key-'));
  const env = { NOLZU_DATA_DIR: fresh };
  openDatabase(fresh).close();
  try {
    const named = createLoop(fresh, env, { project: 1 });
    expect(createLoop(fresh, env)).toBe(named);
    named.close();
  } finally {
    rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A plain .git folder is recorded too, so one later swapped for a link is refused, also after a restart.
it("records a plain .git folder, and refuses a link that later takes its place", async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'nolzu-git-plain-'));
  const project = join(fresh, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const elsewhere = join(fresh, 'elsewhere.git');
  execFileSync('git', ['init', '-q', '--bare', elsewhere]);
  const db = openDatabase(join(fresh, 'data'));
  try {
    writeSetting(db, 'projectPath', project);
    pinProjectGit(db);
    expect(getSetting(db, 'gitLink')).toBe(realpathSync(join(project, '.git')));
    rmSync(join(project, '.git'), { recursive: true });
    symlinkSync(elsewhere, join(project, '.git'));
    // Opened again, as after a restart: the record stays the plain folder.
    pinProjectGit(db);
    expect(getSetting(db, 'gitLink')).toBe(realpathSync(project) + '/.git');
    expect(await repoPlaces({ project, workTree: project }, process.env)).toEqual({ ok: false, reason: expect.stringContaining('where it led when Nolzu first opened the project') });
  } finally {
    pinGitLink(project, null);
    db.close();
    rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A project whose .git is a link to a git folder elsewhere, the person's own setup: where it leads is
// recorded when Nolzu first opens the project, and only that place is allowed after.
it("records where the project's .git leads the first time, and keeps that record", async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'nolzu-git-link-'));
  const project = join(fresh, 'project');
  const kept = join(fresh, 'kept.git');
  mkdirSync(project);
  execFileSync('git', ['init', '-q', '--bare', kept]);
  symlinkSync(kept, join(project, '.git'));
  const db = openDatabase(join(fresh, 'data'));
  try {
    writeSetting(db, 'projectPath', project);
    pinProjectGit(db);
    expect(getSetting(db, 'gitLink')).toBe(realpathSync(kept));
    rmSync(join(project, '.git'));
    symlinkSync(join(fresh, 'elsewhere.git'), join(project, '.git'));
    pinProjectGit(db);
    expect(getSetting(db, 'gitLink')).toBe(realpathSync(kept));
  } finally {
    pinGitLink(project, null);
    db.close();
    rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
