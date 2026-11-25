import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PROFILE } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, isMachineKey, MACHINE_KEYS, projectRepos, type SettingKey, type Settings } from '../settings.ts';
import { createLocalTicket } from './cards.ts';
import { createProject, openDatabase, openMachine, registeredProjects } from './db.ts';
import { startRun } from './runs.ts';
import { getSetting, machineRow, projectOutsideGit, projectProfiles, readSettings, settingProblem, writeSetting } from './settings-store.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-settings-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('returns the defaults on a database nobody has written to', () => {
  expect(readSettings(db)).toEqual(DEFAULTS);
});

// The engine choice is the project's, the logins are the machine's: another project keeps its order.
it('puts the project preset engine first in the profiles every resolve takes', () => {
  const codex = { id: 'codex', label: 'Codex', vendor: 'codex', configDir: null } as const;
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, codex]);
  expect(projectProfiles(db).map((one) => one.id)).toEqual(['claude-code', 'codex']);

  writeSetting(db, 'presetEngine', 'codex');
  expect(projectProfiles(db).map((one) => one.id)).toEqual(['codex', 'claude-code']);
  expect(getSetting(db, 'engineProfiles').map((one) => one.id)).toEqual(['claude-code', 'codex']);
});

it('reads a written value back with its own type, not as a string', () => {
  writeSetting(db, 'agentSlots', 5);
  writeSetting(db, 'keepAwake', false);

  expect(getSetting(db, 'agentSlots')).toBe(5);
  expect(getSetting(db, 'keepAwake')).toBe(false);
  expect(readSettings(db).agentSlots).toBe(5);
});

it('keeps one row per key and the value written last', () => {
  writeSetting(db, 'agentSlots', 2);
  writeSetting(db, 'agentSlots', 7);

  expect(getSetting(db, 'agentSlots')).toBe(7);
  const rows = db.prepare("SELECT count(*) AS n FROM machine.settings WHERE key = 'agentSlots'").get() as { n: number };
  expect(rows.n).toBe(1);
});

it('leaves a key it does not know alone, so a newer version can write one and keep it', () => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('fromANewerVersion', '"keep me"');
  writeSetting(db, 'agentSlots', 4);

  const row = db.prepare("SELECT value FROM settings WHERE key = 'fromANewerVersion'").get() as { value: string };
  expect(row.value).toBe('"keep me"');
});

it('falls back to the default when a stored value no longer parses, and does not throw', () => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('agentSlots', 'not json');

  expect(() => readSettings(db)).not.toThrow();
  expect(getSetting(db, 'agentSlots')).toBe(DEFAULTS.agentSlots);
});

it('refuses an invalid value and writes nothing', () => {
  expect(() => writeSetting(db, 'agentSlots', 0)).toThrow(/1 (to|and) 20/);

  const row = db.prepare("SELECT count(*) AS n FROM machine.settings WHERE key = 'agentSlots'").get() as { n: number };
  expect(row.n).toBe(0);
  expect(getSetting(db, 'agentSlots')).toBe(DEFAULTS.agentSlots);
});

it('stores the settings the wizard collects', () => {
  writeSetting(db, 'projectPath', '/tmp/demo/repo');
  writeSetting(db, 'deliveryFlow', 'pull-request');
  writeSetting(db, 'modelPreset', 'heavy');
  writeSetting(db, 'localKeyPrefix', 'APP');

  const settings = readSettings(db);
  expect(settings.projectPath).toBe('/tmp/demo/repo');
  expect(settings.deliveryFlow).toBe('pull-request');
  expect(settings.modelPreset).toBe('heavy');
  expect(settings.localKeyPrefix).toBe('APP');
});

// Only a project whose repos list leaves out `.` is outside git. With no project the run's folder is
// the data directory, so a list left over from an earlier project says nothing about it.
it('calls a project outside git only when it has a folder and its list leaves out the root', () => {
  writeSetting(db, 'repos', [{ path: 'api', base: null }]);
  expect(projectOutsideGit(db)).toBe(false);

  writeSetting(db, 'projectPath', '/work/recipes');
  expect(projectOutsideGit(db)).toBe(true);

  writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
  expect(projectOutsideGit(db)).toBe(false);

  writeSetting(db, 'repos', null);
  expect(projectOutsideGit(db)).toBe(false);
});

// The repository list follows the workspace flag stored beside it, so both are read together.
it('stores and reads an empty list in a workspace, and only there', () => {
  expect(() => writeSetting(db, 'repos', [])).toThrow(/empty/);

  writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', []);

  expect(getSetting(db, 'repos')).toEqual([]);
  expect(readSettings(db).repos).toEqual([]);
  expect(readSettings(db).workspace).toBe(true);
});

// Null reads as one repository at the project folder, and in a workspace that is its own repository.
it('reads a workspace with no list, or a list it cannot read, as no repository', () => {
  writeSetting(db, 'workspace', true);
  expect(getSetting(db, 'repos')).toEqual([]);
  expect(readSettings(db).repos).toEqual([]);
  expect(projectRepos(readSettings(db))).toEqual([]);

  writeSetting(db, 'repos', null);
  expect(projectRepos({ repos: getSetting(db, 'repos'), baseBranch: 'main' })).toEqual([]);

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run('repos', '[{"path":"."}]');
  expect(getSetting(db, 'repos')).toEqual([]);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('not json', 'repos');
  expect(readSettings(db).repos).toEqual([]);
});

it('refuses "." in a workspace list', () => {
  writeSetting(db, 'workspace', true);

  expect(settingProblem(db, 'repos', [{ path: '.', base: null }])).toMatch(/"\." is not in its list/);
  expect(() => writeSetting(db, 'repos', [{ path: '.', base: null }])).toThrow(/"\." is not in its list/);
});

// Otherwise the stored list would read back as one repository at the project folder.
it('refuses to change the workspace flag while the stored list breaks the new rule', () => {
  writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', []);
  expect(settingProblem(db, 'workspace', null)).toMatch(/empty/);
  expect(() => writeSetting(db, 'workspace', null)).toThrow(/empty/);
  expect(getSetting(db, 'repos')).toEqual([]);

  writeSetting(db, 'repos', null);
  writeSetting(db, 'workspace', null);
  writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
  expect(() => writeSetting(db, 'workspace', true)).toThrow(/"\." is not in its list/);
});

// A workspace folder is a git repository of its own, so no engine runs outside git there.
it('never calls a workspace outside git', () => {
  writeSetting(db, 'projectPath', '/work/recipes');
  writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', []);
  expect(projectOutsideGit(db)).toBe(false);

  writeSetting(db, 'repos', [{ path: 'api', base: null }]);
  expect(projectOutsideGit(db)).toBe(false);
});

const rowsIn = (on: DatabaseSync, table: string) => on.prepare(`SELECT key, value FROM ${table} ORDER BY key`).all();

describe('the machine database', () => {
  it('keeps a machine key in the machine database and a project key in the project one', () => {
    writeSetting(db, 'agentSlots', 5);
    writeSetting(db, 'baseBranch', 'develop');

    expect(rowsIn(db, 'machine.settings')).toEqual([{ key: 'agentSlots', value: '5' }]);
    expect(rowsIn(db, 'main.settings')).toEqual([{ key: 'baseBranch', value: '"develop"' }]);
    expect(getSetting(db, 'agentSlots')).toBe(5);
    expect(getSetting(db, 'baseBranch')).toBe('develop');
  });

  // An upgrade finds every machine key in the project's own table.
  it('takes a machine key the machine lacks from the project once, and never writes the project row again', () => {
    db.prepare('INSERT INTO main.settings (key, value) VALUES (?, ?)').run('agentSlots', '7');

    expect(machineRow(db, 'agentSlots')).toBe('7');
    expect(rowsIn(db, 'machine.settings')).toEqual([{ key: 'agentSlots', value: '7' }]);

    db.prepare("UPDATE main.settings SET value = '2' WHERE key = 'agentSlots'").run();
    expect(getSetting(db, 'agentSlots')).toBe(7);
    writeSetting(db, 'agentSlots', 9);
    expect(getSetting(db, 'agentSlots')).toBe(9);
    expect(rowsIn(db, 'main.settings')).toEqual([{ key: 'agentSlots', value: '2' }]);
  });

  it('writes nothing for a machine key neither database holds', () => {
    expect(machineRow(db, 'seenNotes')).toBeUndefined();
    expect(getSetting(db, 'seenNotes')).toEqual([]);
    expect(rowsIn(db, 'machine.settings')).toEqual([]);
  });

  // A broken row reads as the default before the upgrade, so it has to after it too.
  it('takes a project row it cannot read as it is, so it still reads as the default', () => {
    db.prepare('INSERT INTO main.settings (key, value) VALUES (?, ?)').run('engineProfiles', '[]');

    expect(getSetting(db, 'engineProfiles')).toEqual([DEFAULT_PROFILE]);
    expect(rowsIn(db, 'machine.settings')).toEqual([{ key: 'engineProfiles', value: '[]' }]);
  });

  it('keeps every key in its own table on a connection with no machine database', () => {
    const plain = new DatabaseSync(':memory:');
    plain.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    writeSetting(plain, 'agentSlots', 4);

    expect(rowsIn(plain, 'settings')).toEqual([{ key: 'agentSlots', value: '4' }]);
    expect(getSetting(plain, 'agentSlots')).toBe(4);
    expect(machineRow(plain, 'agentSlots')).toBe('4');
    plain.close();
  });
});

// A value of every machine key that is not its default, and a few project keys beside them.
const STORED: Partial<Settings> = {
  agentSlots: 5,
  runTimeoutMs: 45 * 60_000,
  retryWaitsMs: [60_000],
  keepAwake: false,
  engineProfiles: [DEFAULT_PROFILE, { id: 'codex', label: 'Codex', vendor: 'codex', configDir: null }],
  engineLimits: { 'claude-code': { seenAt: 1_760_000_000_000, windows: [{ name: 'five_hour', used: 0.4, resetsAt: 1_760_000_100, status: 'allowed' }], card: 'APP-1' } },
  hubJobDone: 57,
  teamHubJobDone: 3,
  accountProjects: [{ id: 'p-1', name: 'recipes', lastActivity: null }],
  syncPaused: true,
  onboarding: { done: true },
  seenNotes: ['first-drag'],
  gettingStarted: ['summary'],
  currentProject: 1,
  jiraSite: 'https://you.atlassian.net',
  jiraEmail: 'dana@example.com',
  termsAccepted: { version: '2026-11-23', at: '2026-11-23T09:30:00.000Z' },
  baseBranch: 'develop',
  projectPath: '/work/recipes',
  quietAfterMs: 10 * 60_000,
};

// Every row the project's database holds that a boot could touch.
const projectRows = (on: DatabaseSync) => ['settings', 'cards', 'runs', 'card_events', 'seq'].map((table) => on.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all());
const machineState = (on: DatabaseSync) => [rowsIn(on, 'machine.settings'), registeredProjects(on)];

// A data folder as an older Nolzu left it: every setting in nolzu.db and no machine database.
it('makes the old nolzu.db the first project at boot, reads every key the same, and a second boot changes nothing', () => {
  const old = mkdtempSync(join(tmpdir(), 'nolzu-upgrade-'));
  try {
    openDatabase(old).close();
    for (const file of readdirSync(old)) if (file.startsWith('machine.db')) rmSync(join(old, file));
    const before = new DatabaseSync(join(old, 'nolzu.db'));
    for (const [key, value] of Object.entries(STORED)) writeSetting(before, key as SettingKey, value as never);
    const { key } = createLocalTicket(before, { projectId: 1, prefix: 'APP', title: 'Add a recipe', description: '' });
    startRun(before, { cardKey: key, phase: 'refine', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });
    const was = readSettings(before);
    const project = projectRows(before);
    const machineKeyRows = rowsIn(before, 'settings').filter((row) => isMachineKey(row.key as SettingKey));
    before.close();
    expect(MACHINE_KEYS.filter((key) => !(key in STORED))).toEqual([]);

    // The boot copies every machine key as stored, before anything reads one.
    const after = openDatabase(old);
    expect(registeredProjects(after)).toEqual([{ id: 1, file: 'nolzu.db' }]);
    expect(rowsIn(after, 'machine.settings')).toEqual(machineKeyRows);
    expect(readSettings(after)).toEqual(was);
    expect(projectRows(after)).toEqual(project);
    const machine = machineState(after);
    after.close();

    const again = openDatabase(old);
    expect(machineState(again)).toEqual(machine);
    expect(projectRows(again)).toEqual(project);
    expect(readSettings(again)).toEqual(was);
    again.close();
  } finally {
    rmSync(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('finishes a half-done upgrade without replacing a machine row that is already there', () => {
  const half = mkdtempSync(join(tmpdir(), 'nolzu-half-'));
  try {
    const first = openDatabase(half);
    // Raw rows in the project's table, as an older Nolzu left them.
    first.exec(`INSERT INTO main.settings (key, value) VALUES ('agentSlots', '5'), ('runTimeoutMs', '${45 * 60_000}')`);
    // The start stopped after the machine row was written and before the first project was added.
    first.exec("DELETE FROM machine.project_registry; DELETE FROM machine.settings; INSERT INTO machine.settings (key, value) VALUES ('agentSlots', '2')");
    first.close();

    const after = openDatabase(half);
    expect(registeredProjects(after)).toEqual([{ id: 1, file: 'nolzu.db' }]);
    expect(rowsIn(after, 'machine.settings')).toEqual([
      { key: 'agentSlots', value: '2' },
      { key: 'runTimeoutMs', value: String(45 * 60_000) },
    ]);
    after.close();
  } finally {
    rmSync(half, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The team mark was a machine key until each team project got a socket of its own. The machine's
// row is the newer one, so it goes back to the first project, once, and a later project never takes it.
it('leaves the team job mark in the machine until the first project opens, and a later project never takes it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-team-mark-later-'));
  try {
    openDatabase(folder).close();
    createProject(folder).close();
    // The machine row comes back after both projects exist, so only an open decides where it goes.
    const machine = openMachine(folder);
    machine.exec(`INSERT INTO settings (key, value) VALUES ('teamHubJobDone', '12')`);
    machine.close();

    const later = openDatabase(folder, undefined, 'projects/2.db');
    expect(getSetting(later, 'teamHubJobDone')).toBe(0);
    later.close();
    const first = openDatabase(folder);
    expect(getSetting(first, 'teamHubJobDone')).toBe(12);
    first.close();
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('moves the team job mark from the machine back into the first project, once', () => {
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-team-mark-'));
  try {
    const first = openDatabase(folder);
    first.exec(`INSERT INTO main.settings (key, value) VALUES ('teamHubJobDone', '3'); INSERT INTO machine.settings (key, value) VALUES ('teamHubJobDone', '12')`);
    first.close();
    createProject(folder).close();

    const later = openDatabase(folder, undefined, 'projects/2.db');
    expect(getSetting(later, 'teamHubJobDone')).toBe(0);
    later.close();
    const after = openDatabase(folder);
    expect(getSetting(after, 'teamHubJobDone')).toBe(12);
    expect(rowsIn(after, 'machine.settings')).toEqual([]);
    writeSetting(after, 'teamHubJobDone', 13);
    after.close();

    const again = openDatabase(folder);
    expect(getSetting(again, 'teamHubJobDone')).toBe(13);
    again.close();
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
