import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProject, FIRST_PROJECT, getSetting, openDatabase, registeredProjects, writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('./hub-link.ts', async (real) => ({ ...(await real<object>()), dialHubAgain: () => false, hubStatus: () => 'closed' }));

// Two data folders: one whose first project is damaged and has a second one, one with nothing else.
// Not fake mode, which ignores NOLZU_DATA_DIR on purpose. Nothing here starts a run.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-first-'));
const alone = mkdtempSync(join(tmpdir(), 'nolzu-first-'));
process.env.NOLZU_DATA_DIR = dir;

const damage = (folder: string) => {
  for (const tail of ['', '-wal', '-shm']) rmSync(join(folder, FIRST_PROJECT + tail), { force: true });
  writeFileSync(join(folder, FIRST_PROJECT), 'not a database');
};

const one = openDatabase(dir);
writeSetting(one, 'projectPath', join(tmpdir(), 'nolzu-first-code', 'recipes'));
one.close();
const two = createProject(dir);
writeSetting(two, 'projectPath', join(tmpdir(), 'nolzu-first-code', 'shop'));
two.close();
damage(dir);
openDatabase(alone).close();
damage(alone);

// A third folder of two projects, each opened by a newer Nolzu in turn below.
const newer = mkdtempSync(join(tmpdir(), 'nolzu-first-'));
openDatabase(newer).close();
createProject(newer).close();
const fromTheFuture = (file: string) => {
  const at = new DatabaseSync(join(newer, file));
  at.exec('PRAGMA user_version = 100000');
  at.close();
};

const { database, openFirstThatOpens } = await import('./db.ts');
const { createLoop, loop, loopOf } = await import('./loop.ts');

afterAll(() => {
  createLoop(dir, process.env, { project: 2 }).close();
  for (const folder of [dir, alone, newer]) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('starts on the next project that opens when the first one is damaged, and makes it the current one', () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const opened = loop();

    expect(opened.project).toBe(2);
    expect(getSetting(opened.db, 'currentProject')).toBe(2);
    // One line for the one failure.
    expect(said).toHaveBeenCalledTimes(1);
    expect(said).toHaveBeenCalledWith(expect.stringMatching(/^The first project could not open \(.*\), so Nolzu opened project 2 in its place\. Restart Nolzu and pick it again once it is fixed\.$/));
    // The routes read the same project, and a second start does not try the damaged file again.
    expect(getSetting(database(), 'projectPath')).toBe(join(tmpdir(), 'nolzu-first-code', 'shop'));
    // A route that names the damaged project gets its error, not the stand-in.
    expect(() => database(1)).toThrow();
    expect(() => loop(process.env, 1)).toThrow();
    said.mockClear();
    expect(loop().project).toBe(2);
    expect(said).not.toHaveBeenCalled();
  } finally {
    said.mockRestore();
  }
});

// A write names its project, and New project adds one, both with the first project damaged.
it('takes writes and makes new projects while a project stands in for the first', () => {
  expect(loopOf(new URL('http://localhost/api/board/move?project=2')).project).toBe(2);
  expect(loopOf(new URL('http://localhost/api/board/move')).project).toBe(2);

  const made = createProject(dir);
  try {
    expect(registeredProjects(made).map((one) => one.id)).toEqual([1, 2, 3]);
  } finally {
    made.close();
  }
});

// node:sqlite gives every SQLite error the code ERR_SQLITE_ERROR. Only a damaged file switches.
const sqliteError = (errcode: number) => Object.assign(new Error(`sqlite says ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode });

it.each([
  ['busy', 5],
  ['read only', 8],
  ['I/O', 10],
  ['cannot open', 14],
  ['a failed migration step', 1],
])('passes a %s error from the first project through and opens no other', (_name, errcode) => {
  const asked: (number | undefined)[] = [];
  const thrown = sqliteError(errcode);

  expect(() =>
    openFirstThatOpens(alone, (id) => {
      asked.push(id);
      throw thrown;
    }),
  ).toThrow(thrown);
  expect(asked).toEqual([undefined]);
});

it.each([
  ['not a database', 26],
  ['corrupt', 11],
  ['corrupt, extended code', 267],
])('looks for another project on a %s error', (_name, errcode) => {
  const asked: (number | undefined)[] = [];
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // The folder has no other project, so the search ends in the sentence that names it.
    expect(() =>
      openFirstThatOpens(alone, (id) => {
        asked.push(id);
        throw sqliteError(errcode);
      }),
    ).toThrow(/^No project in .* could open\./);
    expect(asked).toEqual([undefined]);
  } finally {
    said.mockRestore();
  }
});

// A project a newer Nolzu wrote is no damaged file: the start stops and says to update, whether it is
// the current project or the first one, and no other project takes its place.
it('stops the start on a project from a newer version, and switches to no other', () => {
  const env = { ...process.env, NOLZU_DATA_DIR: newer };
  const first = loop(env);
  writeSetting(first.db, 'currentProject', 2);
  first.close();
  fromTheFuture('projects/2.db');
  expect(() => loop(env)).toThrow(/Update Nolzu/);

  // The first project's loop stays open after that, so it is closed before the first one changes.
  createLoop(newer, env).close();
  fromTheFuture(FIRST_PROJECT);
  expect(() => loop(env)).toThrow(/Update Nolzu/);
});

// The next project is held to the same rule: a refusal that is no damaged file stops the search.
it('passes on an error from the next project that is no damaged file', () => {
  const held = new Error('Nolzu is already running on that folder.');
  const asked: (number | undefined)[] = [];

  expect(() =>
    openFirstThatOpens(newer, (id) => {
      asked.push(id);
      throw id === undefined ? sqliteError(26) : held;
    }),
  ).toThrow(held);
  expect(asked).toEqual([undefined, 2]);
});

it('says which data folder has no project that opens', () => {
  expect(() => loop({ ...process.env, NOLZU_DATA_DIR: alone })).toThrow(new RegExp(`^No project in ${alone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could open\\. The first one says: `));
});

// A second Nolzu on the data folder refuses every project alike, so its sentence is said as it is.
it('passes a refusal that is no damaged database straight through', () => {
  const asked: (number | undefined)[] = [];
  const held = new Error('Nolzu is already running on that folder.');

  expect(() =>
    openFirstThatOpens(alone, (id) => {
      asked.push(id);
      throw held;
    }),
  ).toThrow(held);
  expect(asked).toEqual([undefined]);
});
