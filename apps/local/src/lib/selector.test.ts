import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, createProject, getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';
import { type ProjectChoice, selectorRows } from './rail.ts';

// A project whose boards cannot be read, by id, to stand for a project whose loop cannot open.
const broken = vi.hoisted(() => new Set<number>());
vi.mock('./now-snapshot.ts', async (real) => {
  const actual = await real<typeof import('./now-snapshot.ts')>();
  return { ...actual, boardsOn: (live: Parameters<typeof actual.boardsOn>[0] & { project: number }) => {
    if (broken.has(live.project)) throw new Error('The project files are gone.');
    return actual.boardsOn(live);
  } };
});
vi.mock('./hub-link.ts', async (real) => ({ ...(await real<object>()), dialHubAgain: () => false, hubStatus: () => 'closed' }));

// Projects in one temp data folder, read by the selector of one server. Not fake mode: fake mode ignores
// NOLZU_DATA_DIR on purpose, and nothing here starts a run.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-selector-'));
process.env.NOLZU_DATA_DIR = dir;

const { database } = await import('./db.ts');
const { createLoop, loop } = await import('./loop.ts');
const { load } = await import('../routes/+layout.server.ts');
const { POST } = await import('../routes/api/current-project/+server.ts');

const first = openDatabase(dir);
writeSetting(first, 'projectPath', join(tmpdir(), 'nolzu-selector-code', 'recipes'));

const projects = async () => ((await load({ url: new URL('http://localhost/knowledge') } as never)) as { projects: ProjectChoice[] }).projects;
const pick = (project: string) => {
  const body = new FormData();
  body.set('project', project);
  return POST({ request: new Request('http://localhost/api/current-project', { method: 'POST', body }) } as never);
};
const cards = (db: ReturnType<typeof openDatabase>, prefix: string, count: number) => {
  for (let index = 1; index <= count; index += 1) createCard(db, { key: `${prefix}-${index}`, board: 'delivery', stage: 'implement', title: 'Add a search box' });
};
const states = (db: ReturnType<typeof openDatabase>, prefix: string, list: readonly string[]) =>
  list.forEach((state, index) => db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, `${prefix}-${index + 1}`));

afterAll(() => {
  createLoop(dir, process.env, { project: 2 }).close();
  createLoop(dir).close();
  first.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Every plan lists every project, so one project is a list of one.
it('lists the one project of a machine that has one', async () => {
  expect((await projects()).map((one) => one.name)).toEqual(['recipes']);
});

it('lists every project, the busiest first, with the cards waiting off its own board', async () => {
  cards(first, 'APP', 3);
  const second = createProject(dir);
  writeSetting(second, 'projectPath', join(tmpdir(), 'nolzu-selector-code', 'shop'));
  cards(second, 'SHOP', 3);
  // A project New project has not given a folder yet is not one to pick.
  createProject(dir).close();
  // Each loop sweeps a run no process is doing when it opens, so the states are set after the first read.
  expect((await projects()).map((one) => [one.name, one.waiting, one.running])).toEqual([
    ['recipes', 0, 0],
    ['shop', 0, 0],
  ]);
  states(first, 'APP', ['ready', 'running', 'idle']);
  states(second, 'SHOP', ['blocked', 'failed', 'idle']);
  second.close();

  const listed = await projects();
  expect(listed).toEqual([
    { id: 1, name: 'recipes', repos: 1, waiting: 1, running: 1, current: true },
    { id: 2, name: 'shop', repos: 1, waiting: 2, running: 0, current: false },
  ]);
  expect(selectorRows(listed).map((one) => one.name)).toEqual(['shop', 'recipes']);
});

it('makes a picked project the current one and opens its Now', async () => {
  await expect(pick('2')).rejects.toMatchObject({ status: 303, location: '/' });
  expect(getSetting(first, 'currentProject')).toBe(2);
  expect(database()).toBe(database(2));
  expect((await projects()).map((one) => [one.name, one.current])).toEqual([
    ['recipes', false],
    ['shop', true],
  ]);

  await expect(pick('9')).rejects.toMatchObject({ status: 400, body: { message: 'There is no such project on this machine.' } });
  await expect(pick('')).rejects.toMatchObject({ status: 400 });
  expect(getSetting(first, 'currentProject')).toBe(2);
});

// With no account, a pick opens the other project, and a route can read either.
it('lets a pick change the open project with no account, and a route read the other one', async () => {
  await expect(pick('1')).rejects.toMatchObject({ status: 303 });
  expect(database()).toBe(database(1));
  expect((await projects()).map((one) => [one.name, one.waiting, one.current])).toEqual([
    ['recipes', 1, true],
    ['shop', 2, false],
  ]);
  expect(database(2)).not.toBe(database(1));
});

// One project whose loop cannot open costs the layout nothing: it is listed by name with no counts.
it('lists a project whose loop cannot open with no counts, and the others as before', async () => {
  broken.add(2);
  try {
    expect((await projects()).map((one) => [one.name, one.waiting, one.running])).toEqual([
      ['recipes', 1, 1],
      ['shop', null, null],
    ]);
  } finally {
    broken.clear();
  }
});

// A project whose database is damaged cannot open at all. The selector lists it by its number, a pick
// of it is refused and leaves the open project as it was, and a start whose current project is that
// one opens the first project instead.
it('lists a project that cannot open by its number, refuses a pick of it, and starts on the first one', async () => {
  const third = createProject(dir);
  writeSetting(third, 'projectPath', join(tmpdir(), 'nolzu-selector-code', 'broken'));
  third.close();
  writeFileSync(join(dir, 'projects', '3.db'), 'not a database');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await projects()).find((one) => one.id === 3)).toEqual({ id: 3, name: 'Project 3', repos: 0, waiting: null, running: null, current: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Project 3 could not be read for the project selector: /));
    // Once, and not again on every page load.
    warn.mockClear();
    await projects();
    expect(warn).not.toHaveBeenCalled();

    await expect(pick('3')).rejects.toMatchObject({ status: 409, body: { message: expect.stringMatching(/^That project could not open, so the open one stays: /) } });
    expect(getSetting(first, 'currentProject')).toBe(1);

    // As a start after a pick from an older version that had no such check.
    writeSetting(first, 'currentProject', 3);
    expect(loop().project).toBe(1);
    expect(getSetting(first, 'currentProject')).toBe(1);
    expect(said).toHaveBeenCalledWith(expect.stringMatching(/^Project 3 could not open \(.*\), so Nolzu opened project 1 instead\. Restart Nolzu and pick it again once it is fixed\.$/));
  } finally {
    warn.mockRestore();
    said.mockRestore();
  }
});
