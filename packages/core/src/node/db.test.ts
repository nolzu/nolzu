import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backup, createProject, dropProject, nextSeq, openDatabase, openMachine, openProject, projectFiles, projectOf, registeredProjects, registerProject } from './db.ts';
import { boardFor, canMove } from '../board.ts';
import { machineMigrations, migrations } from './migrations.ts';
import { getSetting } from './settings-store.ts';
import { commitWarningOf, readOnlyBreakOf, saveCommitWarning, saveQuestionOptions, saveReadOnlyBreak, startRun } from './runs.ts';

let dir = '';
let opened: DatabaseSync[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-db-'));
});

afterEach(() => {
  for (const db of opened) if (db.isOpen) db.close();
  opened = [];
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function open(list?: readonly string[]) {
  const db = openDatabase(dir, list);
  opened.push(db);
  return db;
}

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const schema = (db: DatabaseSync) => db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
const tables = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name as string);
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

it('runs the migrations on an empty database, and a second open changes nothing', () => {
  const first = open();
  expect(userVersion(first)).toBe(migrations.length);
  expect(tables(first)).toEqual([
    'card_events',
    'card_links',
    'card_pulls',
    'cards',
    'deleted_tickets',
    'diff_comments',
    'export_entries',
    'exporters',
    'knowledge_changes',
    'messages',
    'notifications',
    'pr_discussions',
    'pr_messages',
    'projects',
    'runs',
    'scout_findings',
    'scout_sources',
    'seq',
    'settings',
    'thread_subjects',
  ]);
  expect(first.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  expect(first.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect((first.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBeGreaterThan(0);
  const before = schema(first);
  first.close();

  const second = open();
  expect(userVersion(second)).toBe(migrations.length);
  expect(schema(second)).toEqual(before);
});

// The review migration rebuilds knowledge_changes, because sqlite cannot widen a CHECK. A rebuild
// that dropped the rows would lose the knowledge history of every project already running.
it('keeps the knowledge rows a database already held when the table is rebuilt', () => {
  // Six, counted, and not `slice(0, -1)`. A relative slice meant "before the rebuild" when this was
  // written and meant "after it" the day the next migration was appended, so the test went quiet
  // rather than red.
  const older = open(migrations.slice(0, 6));
  older.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-1', 'wrapup', 'fake', '')").run();
  older.prepare("INSERT INTO knowledge_changes (card_key, run_id, file_path, commit_sha, summary, status) VALUES ('APP-1', 1, 'knowledge/a.md', 'abc', 'added', 'applied')").run();
  older.close();

  const db = open();

  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT card_key, file_path, commit_sha, status, note FROM knowledge_changes').all()).toEqual([
    { card_key: 'APP-1', file_path: 'knowledge/a.md', commit_sha: 'abc', status: 'applied', note: null },
  ]);
  // The new word is in the check, and a fifth one is still refused.
  db.prepare("UPDATE knowledge_changes SET status = 'returned', note = 'too long' WHERE id = 1").run();
  expect(() => db.prepare("UPDATE knowledge_changes SET status = 'approved' WHERE id = 1").run()).toThrow(/CHECK/);
});

// Nine, counted, and not `slice(0, -1)`: a relative slice would mean "before the findings table"
// today and something else the day the next migration is appended.
it('adds the findings table to a database that already holds sources', () => {
  const older = open(migrations.slice(0, 9));
  older.prepare("INSERT INTO scout_sources (kind, label) VALUES ('paste', 'Pasted by hand')").run();
  expect(tables(older)).not.toContain('scout_findings');
  older.close();

  const db = open();

  expect(userVersion(db)).toBe(migrations.length);
  expect(count(db, 'scout_sources')).toBe(1);
  db.prepare("INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message) VALUES (1, 'paste:0123456789abcdef', 'a', 'a', 'Timeout', 'Timeout')").run();
  // A finding starts as a bug in the New column, counted from nothing.
  expect(db.prepare('SELECT kind, status, occurrences, location, card_key FROM scout_findings').all()).toEqual([
    { kind: 'bug', status: 'new', occurrences: 0, location: '', card_key: null },
  ]);
});

// The project-wide stack hook became your own commands under '*' on Start the app. Forty-four, counted,
// for the same reason as the counts above.
describe('the move of the stack hook to Start the app', () => {
  const before = (rows: Record<string, unknown>) => {
    const older = open(migrations.slice(0, 44));
    for (const [key, value] of Object.entries(rows)) older.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    older.close();
    return open();
  };
  const hookRows = (db: DatabaseSync) => db.prepare("SELECT key FROM settings WHERE key LIKE 'stack%Hook'").all();

  it('turns the three hook commands into own commands under * and drops the hook rows', () => {
    const db = before({ stackHook: ' sh stack.sh load {key} ', stackUnloadHook: 'sh stack.sh unload {key}', stackStatusHook: '  ' });

    expect(getSetting(db, 'qaApp')).toEqual({ '*': { mode: 'own', start: 'sh stack.sh load {key}', stop: 'sh stack.sh unload {key}', status: null } });
    expect(hookRows(db)).toEqual([]);
  });

  it('keeps an answer under * and the per repository answers, and still drops the hook rows', () => {
    const db = before({ stackHook: 'docker compose up -d', qaApp: { '*': { mode: 'code' }, api: { mode: 'running', address: 'http://localhost:3000' } } });

    expect(getSetting(db, 'qaApp')).toEqual({ '*': { mode: 'code' }, api: { mode: 'running', address: 'http://localhost:3000' } });
    expect(hookRows(db)).toEqual([]);
  });

  it('adds own commands beside a single answer stored before answers were per repository', () => {
    const db = before({ stackHook: 'docker compose up -d', qaApp: { mode: 'dev', command: 'npm run dev', repo: 'web' } });

    expect(getSetting(db, 'qaApp')).toEqual({ web: { mode: 'dev', command: 'npm run dev', repo: 'web' }, '*': { mode: 'own', start: 'docker compose up -d', stop: null, status: null } });
  });

  // The setting's reader trims tabs and line ends too, so the migration must, or it stores a blank Start
  // the reader refuses, and with it the whole map.
  it('trims tabs and line ends, and adds nothing for a hook of them', () => {
    expect(getSetting(before({ stackHook: '\t\n', qaApp: { api: { mode: 'code' } } }), 'qaApp')).toEqual({ api: { mode: 'code' } });
  });

  it('trims tabs and line ends from each command it moves', () => {
    const db = before({ stackHook: '\tdocker compose up -d\r\n', stackUnloadHook: '\n', stackStatusHook: ' docker compose ps\t' });

    expect(getSetting(db, 'qaApp')).toEqual({ '*': { mode: 'own', start: 'docker compose up -d', stop: null, status: 'docker compose ps' } });
  });

  it('adds nothing for an empty hook', () => {
    const db = before({ stackHook: '  ', stackUnloadHook: 'docker compose down' });

    expect(getSetting(db, 'qaApp')).toBeNull();
    expect(hookRows(db)).toEqual([]);
  });
});

it('leaves user_version and the schema unchanged when a statement of a migration fails', () => {
  const db = open();
  const before = schema(db);
  const broken = [...migrations, 'CREATE TABLE extra (id INTEGER); INSERT INTO missing VALUES (1)'];

  expect(() => openDatabase(dir, broken)).toThrow(/missing/);
  expect(userVersion(db)).toBe(migrations.length);
  expect(schema(db)).toEqual(before);
});

it('refuses a database newer than the code and names the fix', () => {
  open().exec(`PRAGMA user_version = ${migrations.length + 1}`);
  expect(() => openDatabase(dir)).toThrow(/Update Nolzu/);
});

describe('the machine database', () => {
  it('runs its own migrations in machine.db beside nolzu.db, and a second open changes nothing', () => {
    const machine = openMachine(dir);
    opened.push(machine);
    expect(userVersion(machine)).toBe(machineMigrations.length);
    expect(tables(machine)).toEqual(['project_registry', 'settings', 'writer']);
    expect(machine.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    const before = schema(machine);
    machine.close();

    const again = openMachine(dir);
    opened.push(again);
    expect(schema(again)).toEqual(before);
  });

  it('is attached to every project connection, which keeps its own schema', () => {
    const db = open();
    const attached = db
      .prepare("SELECT name, file FROM pragma_database_list WHERE name != 'temp'")
      .all()
      .map((row) => [row.name, basename(row.file as string)]);
    expect(attached).toEqual([
      ['main', 'nolzu.db'],
      ['machine', 'machine.db'],
    ]);
    expect(userVersion(db)).toBe(migrations.length);
    expect(tables(db)).not.toContain('project_registry');
  });

  it('refuses a machine database newer than the code and names the fix', () => {
    const machine = openMachine(dir);
    machine.exec(`PRAGMA user_version = ${machineMigrations.length + 1}`);
    machine.close();
    expect(() => openDatabase(dir)).toThrow(/machine\.db .*Update Nolzu/);
  });

  // The same call on the machine's own connection and on a project's, so either can list the projects.
  it('lists the registered projects in the order they were added, from either connection', () => {
    const db = open();
    const machine = openMachine(dir);
    opened.push(machine);

    const second = registerProject(machine, 'projects/2.db');
    const third = registerProject(db, 'projects/3.db');

    expect(registeredProjects(db)).toEqual([
      { id: 1, file: 'nolzu.db' },
      { id: second, file: 'projects/2.db' },
      { id: third, file: 'projects/3.db' },
    ]);
    expect(registeredProjects(machine)).toEqual(registeredProjects(db));
    expect(() => registerProject(machine, 'nolzu.db')).toThrow(/UNIQUE/);
  });

  it('makes nolzu.db the first project where it lies, and a second open adds nothing', () => {
    open().close();
    expect(registeredProjects(open())).toEqual([{ id: 1, file: 'nolzu.db' }]);
    expect(readdirSync(dir).filter((name) => name.endsWith('.db')).sort()).toEqual(['machine.db', 'nolzu.db']);
  });

  // An older nolzu.db beside it shows a project migration would have run first.
  it('changes nothing when the machine database is newer than the code', () => {
    open(migrations.slice(0, -1)).close();
    const newer = openMachine(dir);
    newer.exec(`PRAGMA user_version = ${machineMigrations.length + 1}`);
    newer.close();
    const look = () => {
      const project = new DatabaseSync(join(dir, 'nolzu.db'));
      const machine = new DatabaseSync(join(dir, 'machine.db'));
      const seen = [userVersion(project), schema(project), userVersion(machine), schema(machine), registeredProjects(machine)];
      project.close();
      machine.close();
      return [...seen, readdirSync(dir).sort()];
    };
    const before = look();

    expect(() => openDatabase(dir)).toThrow(
      `${join(dir, 'machine.db')} has schema version ${machineMigrations.length + 1}, and this Nolzu knows versions up to ${machineMigrations.length}. Update Nolzu to open it.`,
    );
    expect(look()).toEqual(before);
    expect(before[0]).toBe(migrations.length - 1);
  });
  // One scheduler runs the jobs of every project, and each job writes to its own project's database.
  it('opens a registered project by its id, with its own tables and the machine attached', () => {
    const first = open();
    const id = registerProject(first, 'two.db');
    first.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'inbox', 'idle', 'First')").run();

    const two = openProject(dir, id);
    opened.push(two);

    expect(userVersion(two)).toBe(migrations.length);
    expect(two.prepare('SELECT count(*) AS cards FROM cards').get()).toEqual({ cards: 0 });
    expect(registeredProjects(two)).toEqual(registeredProjects(first));
    expect(() => openProject(dir, id + 1)).toThrow(`There is no project ${id + 1} in ${dir}.`);
  });

  it('keeps the run files of the first project in the data folder, and of every other in a folder of its own', () => {
    expect(projectFiles(dir, { id: 1, file: 'nolzu.db' })).toBe(dir);
    expect(projectFiles(dir, { id: 2, file: 'two.db' })).toBe(join(dir, 'projects', '2'));
  });

  // A registry row is read back as a path, so a row that leads out of the data folder, or onto the
  // machine's own file, opens nothing.
  it('refuses a project file outside the data folder, and makes nothing there', () => {
    const db = open();
    const outside = mkdtempSync(join(tmpdir(), 'nolzu-db-outside-'));
    try {
      for (const file of [`../${basename(outside)}/stolen.db`, join(outside, 'stolen.db'), 'projects/../../stolen.db', 'machine.db', 'MACHINE.db', '.']) {
        const id = registerProject(db, file);
        expect(() => openProject(dir, id)).toThrow(`The project database ${file} is not inside ${dir}, so Nolzu does not open it.`);
      }
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(dir, '..', 'stolen.db'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('makes a new project database in the projects folder under the next id, and knows each connection\'s project', () => {
    const first = open();
    registerProject(first, 'two.db');

    const made = createProject(dir);
    opened.push(made);

    expect(registeredProjects(first).at(-1)).toEqual({ id: 3, file: 'projects/3.db' });
    expect(existsSync(join(dir, 'projects', '3.db'))).toBe(true);
    expect(count(made, 'cards')).toBe(0);
    expect(projectOf(made)).toEqual({ dataDir: dir, project: { id: 3, file: 'projects/3.db' } });
    expect(projectOf(first)).toEqual({ dataDir: dir, project: { id: 1, file: 'nolzu.db' } });
    expect(projectOf(new DatabaseSync(':memory:'))).toBeUndefined();
  });

  // A data folder that never opened its first project still gets it first, so nolzu.db keeps id 1.
  it('adopts nolzu.db before the new project in a new data folder', () => {
    opened.push(createProject(dir));
    expect(registeredProjects(open())).toEqual([
      { id: 1, file: 'nolzu.db' },
      { id: 2, file: 'projects/2.db' },
    ]);
  });

  it('takes back a new project nothing was made in, and never the first one', () => {
    const first = open();
    const made = createProject(dir);

    dropProject(made);

    expect(made.isOpen).toBe(false);
    expect(registeredProjects(first)).toEqual([{ id: 1, file: 'nolzu.db' }]);
    expect(readdirSync(join(dir, 'projects'))).toEqual([]);
    expect(() => dropProject(first)).toThrow('The first project cannot be taken back.');
    expect(first.isOpen).toBe(true);
  });
});

it('counts nextSeq per name', () => {
  const db = open();
  expect([nextSeq(db, 'APP'), nextSeq(db, 'APP'), nextSeq(db, 'run'), nextSeq(db, 'APP')]).toEqual([1, 2, 1, 3]);
});

it('writes a backup that opens with the same row counts', () => {
  const db = open();
  db.exec("INSERT INTO projects (name) VALUES ('recipes')");
  db.exec("INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'delivery', 'inbox', 'Add a recipe')");
  db.exec("INSERT INTO card_events (card_key, to_stage, who) VALUES ('APP-1', 'inbox', 'you')");
  db.exec("INSERT INTO settings (key, value) VALUES ('slots', '2')");
  nextSeq(db, 'APP');

  const file = backup(db, join(dir, 'backups'));
  expect(basename(file)).toMatch(/^nolzu-\d{8}-\d{6}\.db$/);
  const copy = new DatabaseSync(file, { readOnly: true });
  opened.push(copy);
  for (const table of tables(db)) expect([table, count(copy, table)]).toEqual([table, count(db, table)]);
});

// Each release reaches everyone at their next start, so an older database is copied before it changes.
it('copies an older database before migrating it, and a new one never', () => {
  const older = openDatabase(dir, migrations.slice(0, -1));
  older.close();
  expect(existsSync(join(dir, 'backups', 'nolzu'))).toBe(false);

  const later = openDatabase(dir, migrations);
  opened.push(later);
  const copies = readdirSync(join(dir, 'backups', 'nolzu'));
  expect(copies).toHaveLength(1);
  const copy = new DatabaseSync(join(dir, 'backups', 'nolzu', copies[0] ?? ''), { readOnly: true });
  opened.push(copy);
  expect((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(migrations.length - 1);
});

it('does not fail on two backups in the same second', () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-15T10:20:30Z') });
  const db = open();
  const backups = join(dir, 'backups');

  backup(db, backups);
  expect(backup(db, backups)).toBe(join(backups, 'nolzu-20260915-102030.db'));
  expect(readdirSync(backups)).toEqual(['nolzu-20260915-102030.db']);
});

it('prunes only the oldest matching backup and leaves other files alone', () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-15T10:20:30Z') });
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  const old = [1, 2, 3, 4, 5, 6, 7].map((day) => `nolzu-2026090${day}-000000.db`);
  for (const name of [...old, 'notes.txt', 'nolzu-manual.db']) writeFileSync(join(backups, name), '');

  backup(open(), backups);
  expect(readdirSync(backups).sort()).toEqual(
    [...old.slice(1), 'nolzu-20260915-102030.db', 'nolzu-manual.db', 'notes.txt'].sort(),
  );
});

it('removes the partial file when a backup fails', () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-15T10:20:30Z') });
  const backups = join(dir, 'backups');
  // A folder with the backup name makes the final rename fail after the copy is written.
  mkdirSync(join(backups, 'nolzu-20260915-102030.db', 'blocker'), { recursive: true });

  expect(() => backup(open(), backups)).toThrow();
  expect(readdirSync(backups)).toEqual(['nolzu-20260915-102030.db']);
});

const columns = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);

function twoCards(db: DatabaseSync) {
  db.exec("INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'delivery', 'inbox', 'Add a search box')");
  db.exec("INSERT INTO cards (key, board, stage, title) VALUES ('APP-2', 'delivery', 'inbox', 'Sort the recipe list')");
}

it('upgrades a database built by the first migration and keeps its rows', () => {
  const first = open(migrations.slice(0, 1));
  first.exec("INSERT INTO projects (name) VALUES ('recipes')");
  first.exec("INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'delivery', 'inbox', 'Add a search box')");
  first.exec("INSERT INTO runs (card_key, phase, engine) VALUES ('APP-1', 'refine', 'fake')");
  expect(userVersion(first)).toBe(1);
  first.close();

  const second = open();
  expect(userVersion(second)).toBe(migrations.length);
  expect(count(second, 'cards')).toBe(1);
  expect(count(second, 'runs')).toBe(1);
  // A card that existed before the upgrade is a local ticket, because there was no other kind.
  expect(second.prepare("SELECT source, source_ref FROM cards WHERE key = 'APP-1'").get()).toEqual({
    source: 'local',
    source_ref: null,
  });
});

it('replaces the one tokens column with the four counts the engine reports', () => {
  const runs = columns(open(), 'runs');
  expect(runs).toEqual(expect.arrayContaining(['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_creation']));
  // One total cannot produce an honest cost report, because a cache read is far cheaper
  // than an input token. Keeping the old column would leave two sources of truth.
  expect(runs).not.toContain('tokens');
});

it('adds the run lifecycle columns the agents drawer and the phase strip read', () => {
  const runs = columns(open(), 'runs');
  expect(runs).toEqual(
    expect.arrayContaining(['state', 'lane', 'started_at', 'ended_at', 'question', 'attempt', 'plain_summary']),
  );
});

it('refuses a card link that is not in normalized order, so one pair cannot be stored twice', () => {
  const db = open();
  twoCards(db);
  const link = db.prepare('INSERT INTO card_links (a, b) VALUES (?, ?)');

  expect(() => link.run('APP-2', 'APP-1')).toThrow();
  link.run('APP-1', 'APP-2');
  expect(() => link.run('APP-1', 'APP-2')).toThrow();
  expect(db.prepare('SELECT a, b FROM card_links').all()).toEqual([{ a: 'APP-1', b: 'APP-2' }]);
});

it('refuses a link from a card to itself', () => {
  const db = open();
  twoCards(db);
  expect(() => db.prepare('INSERT INTO card_links (a, b) VALUES (?, ?)').run('APP-1', 'APP-1')).toThrow();
});

it('deletes a card link together with its card', () => {
  const db = open();
  twoCards(db);
  db.prepare('INSERT INTO card_links (a, b) VALUES (?, ?)').run('APP-1', 'APP-2');

  db.exec("DELETE FROM cards WHERE key = 'APP-1'");
  expect(count(db, 'card_links')).toBe(0);
});

// The Merge column is gone, so a Delivery card left on merge would stand on no column. The board filter
// is the half worth a test: another board's stage of the same name is that board's own column.
it('moves a Delivery card on merge to pr watch, and leaves every other card where it was', () => {
  const older = open(migrations.slice(0, 14));
  older.exec(`INSERT INTO cards (key, board, stage, title) VALUES
    ('APP-1', 'delivery', 'merge', 'Add a search box'),
    ('APP-2', 'delivery', 'review', 'Sort the recipe list'),
    ('APP-3', 'delivery', 'pr-watch', 'Print a recipe'),
    ('EPIC-1', 'epics', 'merge', 'Meal plans')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT key, board, stage FROM cards ORDER BY key').all()).toEqual([
    { key: 'APP-1', board: 'delivery', stage: 'pr-watch' },
    { key: 'APP-2', board: 'delivery', stage: 'review' },
    { key: 'APP-3', board: 'delivery', stage: 'pr-watch' },
    { key: 'EPIC-1', board: 'epics', stage: 'merge' },
  ]);
});

// Fifteen, counted: the database from before a card had a repository list.
it('adds the repository list to cards made before it, empty', () => {
  const older = open(migrations.slice(0, 15));
  older.exec("INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'delivery', 'inbox', 'Add a search box')");
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT repos, repos_by FROM cards').all()).toEqual([{ repos: null, repos_by: null }]);
  db.prepare(`UPDATE cards SET repos = '["api"]', repos_by = 'person'`).run();
  expect(() => db.prepare("UPDATE cards SET repos_by = 'scout'").run()).toThrow(/CHECK/);
  // Only the three writers, so a word added to the check without a writer behind it shows up here.
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cards'").get() as { sql: string };
  expect(table.sql).toContain("CHECK (repos_by IN ('refine', 'plan', 'person'))");
});

// Twenty-one, counted: the database from before a run said whether it went on from earlier work.
// Nothing an old row holds proves which kind it was, so it stays unknown and the estimates skip it.
it('leaves the runs made before the resumed marker unknown, and writes it on every new run', () => {
  const older = open(migrations.slice(0, 21));
  older.exec(`INSERT INTO runs (card_key, phase, engine, model, effort, session_id, state, cost_estimate)
    VALUES ('APP-1', 'implement', 'claude-code', 'claude-sonnet-4-5', 'high', 'a-session', 'complete', 0.4)`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT model, resumed, asked_model FROM runs').all()).toEqual([{ model: 'claude-sonnet-4-5', resumed: null, asked_model: null }]);

  const first = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });
  const answer = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: 'a-session', logPath: '', lane: null, resumed: true });
  const read = db.prepare('SELECT resumed, asked_model FROM runs WHERE id = ?');
  expect(read.get(first)).toEqual({ resumed: 0, asked_model: 'sonnet' });
  expect(read.get(answer)).toEqual({ resumed: 1, asked_model: 'sonnet' });
  expect(() => db.prepare('UPDATE runs SET resumed = 2 WHERE id = ?').run(first)).toThrow(/CHECK/);
});

// Twenty-two, counted: the database from before a blocked run kept the answers it offered. An old
// question has none, so it stays plain text.
it('leaves the questions asked before the options column with no options', () => {
  const older = open(migrations.slice(0, 22));
  // The column comes from a new migration. Added to a shipped one, a database already past it would never get it.
  expect(columns(older, 'runs')).not.toContain('question_options');
  older.exec(`INSERT INTO runs (card_key, phase, engine, state, question) VALUES ('APP-1', 'plan', 'claude-code', 'complete', 'Stars or thumbs?')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT question, question_options FROM runs').all()).toEqual([{ question: 'Stars or thumbs?', question_options: null }]);

  const asked = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });
  const options = [{ label: '1 to 5 stars', means: 'A new column' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }];
  saveQuestionOptions(db, asked, options);
  const read = db.prepare('SELECT question_options FROM runs WHERE id = ?');
  expect(JSON.parse((read.get(asked) as { question_options: string }).question_options)).toEqual(options);
  saveQuestionOptions(db, asked, null);
  expect(read.get(asked)).toEqual({ question_options: null });
});

/**
 * Nineteen, counted: the database from before a card made from a GitHub issue was keyed `repo#n`.
 *
 * An issue card was keyed `owner/repo#n`, and every run refuses a key with a slash in it. The
 * migration moves the card to `repo#n`, like a pull request card, and every row that names it moves
 * with it. The full name stays on the card as its source ref.
 */
describe('the GitHub issue key migration', () => {
  const GITHUB = `'{"system":"github","repo":"acme/app","query":"label:bug"}'`;

  it('moves an issue card and every row that names it', () => {
    const older = open(migrations.slice(0, 19));
    older.exec(`
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES
        ('cook/recipes#12', 'delivery', 'inbox', 'Search by ingredient', 'github', 'cook/recipes#12'),
        ('dough#3', 'prreview', 'incoming', 'Rest the dough', 'github-pr', 'cook/dough#3'),
        ('APP-1', 'delivery', 'inbox', 'Add a search box', 'local', NULL);
      INSERT INTO card_events (card_key, from_stage, to_stage, who) VALUES ('cook/recipes#12', NULL, 'inbox', 'you');
      INSERT INTO messages (card_key, thread, author, body, at) VALUES ('cook/recipes#12', 'ask', 'person', 'Which unit?', '2026-10-06T09:00:00.000Z');
      INSERT INTO runs (id, card_key, phase, engine, error) VALUES (1, 'cook/recipes#12', 'refine', 'claude', 'not one plain name');
      INSERT INTO knowledge_changes (card_key, run_id, file_path, status) VALUES ('cook/recipes#12', 1, 'search.md', 'applied');
      INSERT INTO card_links (a, b) VALUES ('APP-1', 'cook/recipes#12'), ('cook/recipes#12', 'dough#3');
      INSERT INTO export_entries (destination, external_id, day, minutes, updated_at) VALUES ('toggl', 'nolzu:p-1:cook%2Frecipes%2312:2026-10-05', '2026-10-05', 30, '2026-10-06T09:00:00.000Z');
    `);
    older.close();

    const db = open();

    expect(userVersion(db)).toBe(migrations.length);
    expect(db.prepare('SELECT key, source, source_ref FROM cards ORDER BY key').all()).toEqual([
      { key: 'APP-1', source: 'local', source_ref: null },
      { key: 'dough#3', source: 'github-pr', source_ref: 'cook/dough#3' },
      { key: 'recipes#12', source: 'github', source_ref: 'cook/recipes#12' },
    ]);
    for (const table of ['card_events', 'messages', 'runs', 'knowledge_changes']) {
      expect(db.prepare(`SELECT DISTINCT card_key FROM ${table}`).all(), table).toEqual([{ card_key: 'recipes#12' }]);
    }
    // Still one row per pair, in the order the check asks for: recipes#12 now sorts after dough#3.
    expect(db.prepare('SELECT a, b FROM card_links ORDER BY a').all()).toEqual([
      { a: 'APP-1', b: 'recipes#12' },
      { a: 'dough#3', b: 'recipes#12' },
    ]);
    expect(db.prepare('SELECT external_id FROM export_entries').all()).toEqual([{ external_id: 'nolzu:p-1:recipes%2312:2026-10-05' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  // The key carries no owner, so two owners' repositories of one name meet on it. The card that would
  // land on a taken key stays where it was, which is where it was before: on the board and not runnable.
  it('leaves an issue card on its old key when the new key is taken, and never fails the open', () => {
    const older = open(migrations.slice(0, 19));
    older.exec(`
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES
        ('pasta#5', 'prreview', 'incoming', 'Boil less', 'github-pr', 'cook/pasta#5'),
        ('bake/pasta#5', 'delivery', 'inbox', 'Bake it', 'github', 'bake/pasta#5'),
        ('bake/bread#9', 'delivery', 'inbox', 'Rye bread', 'github', 'bake/bread#9'),
        ('cook/bread#9', 'epics', 'inbox', 'Flat bread', 'github', 'cook/bread#9');
      INSERT INTO card_events (card_key, to_stage, who) VALUES ('cook/bread#9', 'inbox', 'you');
    `);
    older.close();

    const db = open();

    expect(db.prepare('SELECT key, title FROM cards ORDER BY key').all()).toEqual([
      { key: 'bake/pasta#5', title: 'Bake it' },
      { key: 'bread#9', title: 'Rye bread' },
      { key: 'cook/bread#9', title: 'Flat bread' },
      { key: 'pasta#5', title: 'Boil less' },
    ]);
    expect(db.prepare('SELECT card_key FROM card_events').all()).toEqual([{ card_key: 'cook/bread#9' }]);
  });

  // Only the GitHub source moves. A GitLab key has the same shape, group/project#n, so the rows are
  // picked by the source's system and never by the shape of the key.
  it('moves the Scout keys of a GitHub source and its cursor, and leaves GitLab and a broken config alone', () => {
    const older = open(migrations.slice(0, 19));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json, cursor) VALUES
        (1, 'tickets', 'The app issues', ${GITHUB}, 'acme/app#42 acme/app#7 ci:9001 oldacme/app#10'),
        (2, 'tickets', 'The app on GitLab', '{"system":"gitlab","project":"group/app"}', 'group/app#1'),
        (3, 'tickets', 'Written by hand', '{not json', 'acme/app#5');
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES
        ('acme/app#42', 'investigations', 'inbox', 'Cache drops rows', 'external', 'acme/app#42'),
        ('group/app#1', 'delivery', 'inbox', 'Import keeps one page', 'external', 'group/app#1');
      INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key, card_key, status, occurrences) VALUES
        (1, 'tickets:acme%2Fapp%2342', '2026-10-01', '2026-10-01', 'Cache drops rows', 'Cache drops rows', 'acme/app#42', 'acme/app#42', 'acme/app#42', 'started', 1),
        (1, 'tickets:acme%2Fapp%237', '2026-10-01', '2026-10-01', 'Search is slow', 'Search is slow', 'acme/app#7', 'acme/app#7', NULL, 'new', 1),
        (1, 'tickets:0123456789abcdef', '2026-10-01', '2026-10-01', 'Tests failed on main', 'Tests failed on main', 'acme/app@main', NULL, NULL, 'new', 1),
        (2, 'tickets:group%2Fapp%231', '2026-10-01', '2026-10-01', 'Import keeps one page', 'Import keeps one page', 'group/app#1', 'group/app#1', 'group/app#1', 'started', 1),
        (3, 'tickets:acme%2Fapp%235', '2026-10-01', '2026-10-01', 'Old row', 'Old row', 'acme/app#5', 'acme/app#5', NULL, 'new', 1);
    `);
    older.close();

    // Up to this migration only. The next one moves the GitLab rows, and its own tests are below.
    const db = open(migrations.slice(0, 20));

    expect(db.prepare('SELECT source_id, fingerprint, location, external_key, card_key FROM scout_findings ORDER BY id').all()).toEqual([
      { source_id: 1, fingerprint: 'tickets:app%2342', location: 'app#42', external_key: 'app#42', card_key: 'app#42' },
      { source_id: 1, fingerprint: 'tickets:app%237', location: 'app#7', external_key: 'app#7', card_key: null },
      { source_id: 1, fingerprint: 'tickets:0123456789abcdef', location: 'acme/app@main', external_key: null, card_key: null },
      { source_id: 2, fingerprint: 'tickets:group%2Fapp%231', location: 'group/app#1', external_key: 'group/app#1', card_key: 'group/app#1' },
      { source_id: 3, fingerprint: 'tickets:acme%2Fapp%235', location: 'acme/app#5', external_key: 'acme/app#5', card_key: null },
    ]);
    expect(db.prepare('SELECT id, cursor FROM scout_sources ORDER BY id').all()).toEqual([
      { id: 1, cursor: 'app#10 app#42 app#7 ci:9001' },
      { id: 2, cursor: 'group/app#1' },
      { id: 3, cursor: 'acme/app#5' },
    ]);
    // The card a GitHub finding started moves with it. The GitLab one keeps its slash.
    expect(db.prepare('SELECT key, source_ref FROM cards ORDER BY key').all()).toEqual([
      { key: 'app#42', source_ref: 'acme/app#42' },
      { key: 'group/app#1', source_ref: 'group/app#1' },
    ]);
  });

  // An owner renamed, or a repository moved to another owner, leaves two findings for one repo#n. The
  // one last seen moves, whichever was found first and whichever sorts first. The other keeps its old
  // key, which loses nothing: it is never met again.
  it('moves the finding last seen when an owner was renamed, and keeps the other one as it was', () => {
    const older = open(migrations.slice(0, 19));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json) VALUES (1, 'tickets', 'The app issues', ${GITHUB}), (2, 'tickets', 'The app again', ${GITHUB});
      INSERT INTO scout_findings (id, source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key) VALUES
        (1, 1, 'tickets:acme%2Fapp%2342', '2026-10-01', '2026-10-01', 'Cache drops rows', 'Cache drops rows', 'acme/app#42', 'acme/app#42'),
        (2, 1, 'tickets:oldacme%2Fapp%2342', '2026-09-01', '2026-09-01', 'Cache drops rows', 'Cache drops rows', 'oldacme/app#42', 'oldacme/app#42'),
        (3, 2, 'tickets:acme%2Fapp%2342', '2026-09-01', '2026-09-01', 'Cache drops rows', 'Cache drops rows', 'acme/app#42', 'acme/app#42'),
        (4, 2, 'tickets:zest%2Fapp%2342', '2026-10-01', '2026-10-01', 'Cache drops rows', 'Cache drops rows', 'zest/app#42', 'zest/app#42');
    `);
    older.close();

    const db = open();

    expect(db.prepare('SELECT id, fingerprint, external_key FROM scout_findings ORDER BY id').all()).toEqual([
      { id: 1, fingerprint: 'tickets:app%2342', external_key: 'app#42' },
      { id: 2, fingerprint: 'tickets:oldacme%2Fapp%2342', external_key: 'oldacme/app#42' },
      { id: 3, fingerprint: 'tickets:acme%2Fapp%2342', external_key: 'acme/app#42' },
      { id: 4, fingerprint: 'tickets:app%2342', external_key: 'app#42' },
    ]);
  });

  // Only a hand edit leaves a GitHub finding on the new key before the move. The app still opens, and
  // both rows stay as they were.
  it('opens when a finding holds the new key already', () => {
    const older = open(migrations.slice(0, 19));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json) VALUES (1, 'tickets', 'The app issues', ${GITHUB});
      INSERT INTO scout_findings (id, source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key) VALUES
        (1, 1, 'tickets:acme%2Fapp%2342', '2026-10-01', '2026-10-01', 'Cache drops rows', 'Cache drops rows', 'acme/app#42', 'acme/app#42'),
        (2, 1, 'tickets:app%2342', '2026-10-02', '2026-10-02', 'Cache drops rows', 'Cache drops rows', 'app#42', 'app#42');
    `);
    older.close();

    const db = open();

    expect(db.prepare('SELECT id, fingerprint, external_key FROM scout_findings ORDER BY id').all()).toEqual([
      { id: 1, fingerprint: 'tickets:acme%2Fapp%2342', external_key: 'acme/app#42' },
      { id: 2, fingerprint: 'tickets:app%2342', external_key: 'app#42' },
    ]);
  });
});

/**
 * Twenty, counted: the database from before a card Scout started from a GitLab issue was keyed
 * `project#n`.
 *
 * Such a card was keyed `group/project#n`, and every run refuses a key with a slash in it. The
 * migration moves it to the last part of the path, like a GitHub issue card, with every row that
 * names it, and the dedup keys of the GitLab findings move with it.
 */
describe('the slash key migration', () => {
  const GITLAB = `'{"system":"gitlab","project":"group/kitchen/app","query":"label:bug"}'`;
  const GITHUB = `'{"system":"github","repo":"acme/app","query":"label:bug"}'`;
  const cards = (db: DatabaseSync) => db.prepare('SELECT key, source, source_ref FROM cards ORDER BY key').all();

  it('moves a card Scout started from a GitLab issue, every row that names it, its finding and the cursor', () => {
    const older = open(migrations.slice(0, 20));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json, cursor) VALUES (1, 'tickets', 'The app on GitLab', ${GITLAB}, 'group/kitchen/app#12 group/kitchen/app#3');
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES
        ('group/kitchen/app#12', 'delivery', 'inbox', 'Import keeps one page', 'external', 'group/kitchen/app#12'),
        ('dough#3', 'prreview', 'incoming', 'Rest the dough', 'github-pr', 'cook/dough#3'),
        ('APP-1', 'delivery', 'inbox', 'Add a search box', 'local', NULL);
      INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key, card_key, status, occurrences) VALUES
        (1, 'tickets:group%2Fkitchen%2Fapp%2312', '2026-10-01', '2026-10-01', 'Import keeps one page', 'Import keeps one page', 'group/kitchen/app#12', 'group/kitchen/app#12', 'group/kitchen/app#12', 'started', 1),
        (1, 'tickets:group%2Fkitchen%2Fapp%233', '2026-10-01', '2026-10-01', 'Search is slow', 'Search is slow', 'group/kitchen/app#3', 'group/kitchen/app#3', NULL, 'new', 1);
      INSERT INTO card_events (card_key, from_stage, to_stage, who) VALUES ('group/kitchen/app#12', NULL, 'inbox', 'you');
      INSERT INTO messages (card_key, thread, author, body, at) VALUES ('group/kitchen/app#12', 'ask', 'person', 'Which page size?', '2026-10-06T09:00:00.000Z');
      INSERT INTO runs (id, card_key, phase, engine, error) VALUES (1, 'group/kitchen/app#12', 'refine', 'claude', 'not one plain name');
      INSERT INTO knowledge_changes (card_key, run_id, file_path, status) VALUES ('group/kitchen/app#12', 1, 'import.md', 'applied');
      INSERT INTO card_links (a, b) VALUES ('APP-1', 'group/kitchen/app#12'), ('dough#3', 'group/kitchen/app#12');
      INSERT INTO export_entries (destination, external_id, day, minutes, updated_at) VALUES ('toggl', 'nolzu:p-1:group%2Fkitchen%2Fapp%2312:2026-10-05', '2026-10-05', 30, '2026-10-06T09:00:00.000Z');
    `);
    older.close();

    const db = open();

    expect(userVersion(db)).toBe(migrations.length);
    expect(cards(db)).toEqual([
      { key: 'APP-1', source: 'local', source_ref: null },
      { key: 'app#12', source: 'external', source_ref: 'group/kitchen/app#12' },
      { key: 'dough#3', source: 'github-pr', source_ref: 'cook/dough#3' },
    ]);
    for (const table of ['card_events', 'messages', 'runs', 'knowledge_changes']) {
      expect(db.prepare(`SELECT DISTINCT card_key FROM ${table}`).all(), table).toEqual([{ card_key: 'app#12' }]);
    }
    // app#12 now sorts before dough#3, so that pair turns round.
    expect(db.prepare('SELECT a, b FROM card_links ORDER BY a').all()).toEqual([
      { a: 'APP-1', b: 'app#12' },
      { a: 'app#12', b: 'dough#3' },
    ]);
    expect(db.prepare('SELECT external_id FROM export_entries').all()).toEqual([{ external_id: 'nolzu:p-1:app%2312:2026-10-05' }]);
    expect(db.prepare('SELECT fingerprint, location, external_key, card_key FROM scout_findings ORDER BY id').all()).toEqual([
      { fingerprint: 'tickets:app%2312', location: 'app#12', external_key: 'app#12', card_key: 'app#12' },
      { fingerprint: 'tickets:app%233', location: 'app#3', external_key: 'app#3', card_key: null },
    ]);
    expect(db.prepare('SELECT cursor FROM scout_sources').all()).toEqual([{ cursor: 'app#12 app#3' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  // The rows are picked by the source's system. A GitHub finding the migration before this one left
  // on its old key stays, and so do a source whose config cannot be read and the card it names.
  it('leaves the findings of other systems alone, and a card a source of no known system names', () => {
    const older = open(migrations.slice(0, 20));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json, cursor) VALUES
        (1, 'tickets', 'The app issues', ${GITHUB}, 'app#42 oldacme/app#42'),
        (2, 'tickets', 'Written by hand', '{not json', 'group/app#5'),
        (3, 'tickets', 'The recipe board', '{"system":"jira","site":"https://example.atlassian.net","jql":"project = PROJ"}', 'PROJ-1');
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES ('group/app#5', 'delivery', 'inbox', 'Old row', 'external', 'group/app#5');
      INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key, card_key, status, occurrences) VALUES
        (1, 'tickets:oldacme%2Fapp%2342', '2026-09-01', '2026-09-01', 'Cache drops rows', 'Cache drops rows', 'oldacme/app#42', 'oldacme/app#42', NULL, 'new', 1),
        (2, 'tickets:group%2Fapp%235', '2026-10-01', '2026-10-01', 'Old row', 'Old row', 'group/app#5', 'group/app#5', 'group/app#5', 'started', 1),
        (3, 'tickets:PROJ-1', '2026-10-01', '2026-10-01', 'Search by ingredient', 'Search by ingredient', 'PROJ-1', 'PROJ-1', NULL, 'new', 1);
    `);
    older.close();

    const db = open();

    expect(db.prepare('SELECT fingerprint, external_key, card_key FROM scout_findings ORDER BY id').all()).toEqual([
      { fingerprint: 'tickets:oldacme%2Fapp%2342', external_key: 'oldacme/app#42', card_key: null },
      { fingerprint: 'tickets:group%2Fapp%235', external_key: 'group/app#5', card_key: 'group/app#5' },
      { fingerprint: 'tickets:PROJ-1', external_key: 'PROJ-1', card_key: null },
    ]);
    expect(db.prepare('SELECT cursor FROM scout_sources ORDER BY id').all()).toEqual([{ cursor: 'app#42 oldacme/app#42' }, { cursor: 'group/app#5' }, { cursor: 'PROJ-1' }]);
    expect(cards(db)).toEqual([{ key: 'group/app#5', source: 'external', source_ref: 'group/app#5' }]);
  });

  // A removed source takes its findings with it, so nothing says any more which system such a card
  // came from. Only Start on a GitHub or a GitLab issue wrote an external card with a slash. Both take
  // the last part now, so the card moves all the same. An issue card Add card made, left on its old
  // key by the migration before this one, gets another try.
  it('moves an external card no finding names, and an issue card whose new key is free now', () => {
    const older = open(migrations.slice(0, 20));
    older.exec(`
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES
        ('acme/app#9', 'delivery', 'inbox', 'Cache drops rows', 'external', NULL),
        ('group/sub/soup#4', 'investigations', 'inbox', 'Soup goes cold', 'external', 'group/sub/soup#4'),
        ('bake/pasta#5', 'delivery', 'inbox', 'Bake it', 'github', 'bake/pasta#5'),
        ('PROJ-7', 'delivery', 'inbox', 'PROJ-7', 'external', NULL);
      INSERT INTO card_events (card_key, to_stage, who) VALUES ('group/sub/soup#4', 'inbox', 'you');
    `);
    older.close();

    const db = open();

    expect(cards(db)).toEqual([
      { key: 'PROJ-7', source: 'external', source_ref: null },
      { key: 'app#9', source: 'external', source_ref: 'acme/app#9' },
      { key: 'pasta#5', source: 'github', source_ref: 'bake/pasta#5' },
      { key: 'soup#4', source: 'external', source_ref: 'group/sub/soup#4' },
    ]);
    expect(db.prepare('SELECT card_key FROM card_events').all()).toEqual([{ card_key: 'soup#4' }]);
  });

  // The key carries no group, so a GitHub app#1 and a GitLab app#1 meet on it, and so do two groups'
  // projects of one name. The card that would land on a taken key stays where it was, as before.
  it('leaves a card on its old key when the new key is taken, and never fails the open', () => {
    const older = open(migrations.slice(0, 20));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json) VALUES (1, 'tickets', 'The app on GitLab', '{"system":"gitlab","project":"group/app"}');
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES
        ('app#1', 'delivery', 'inbox', 'From GitHub', 'github', 'acme/app#1'),
        ('group/app#1', 'delivery', 'inbox', 'From GitLab', 'external', 'group/app#1'),
        ('a/soup#2', 'delivery', 'inbox', 'First soup', 'external', 'a/soup#2'),
        ('b/soup#2', 'epics', 'inbox', 'Second soup', 'external', 'b/soup#2');
      INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key, card_key, status, occurrences) VALUES
        (1, 'tickets:group%2Fapp%231', '2026-10-01', '2026-10-01', 'From GitLab', 'From GitLab', 'group/app#1', 'group/app#1', 'group/app#1', 'started', 1);
      INSERT INTO card_events (card_key, to_stage, who) VALUES ('group/app#1', 'inbox', 'you'), ('b/soup#2', 'inbox', 'you');
    `);
    older.close();

    const db = open();

    expect(db.prepare('SELECT key, title FROM cards ORDER BY key').all()).toEqual([
      { key: 'app#1', title: 'From GitHub' },
      { key: 'b/soup#2', title: 'Second soup' },
      { key: 'group/app#1', title: 'From GitLab' },
      { key: 'soup#2', title: 'First soup' },
    ]);
    expect(db.prepare('SELECT card_key FROM card_events ORDER BY card_key').all()).toEqual([{ card_key: 'b/soup#2' }, { card_key: 'group/app#1' }]);
    // The finding moves all the same, so the next check does not report the issue again, and it still
    // points at the card that kept its key.
    expect(db.prepare('SELECT fingerprint, external_key, card_key FROM scout_findings').all()).toEqual([
      { fingerprint: 'tickets:app%231', external_key: 'app#1', card_key: 'group/app#1' },
    ]);
  });

  // A source whose project moved to another group left two findings for one project#n. The one last
  // seen moves, and the other keeps its old key, where it is never met again. A finding that holds the
  // new key already, which only a hand edit makes, stops nothing.
  it('moves the finding last seen when a project moved, and opens when a finding holds the new key already', () => {
    const older = open(migrations.slice(0, 20));
    older.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json) VALUES
        (1, 'tickets', 'The app on GitLab', '{"system":"gitlab","project":"group/app"}'),
        (2, 'tickets', 'The soup on GitLab', '{"system":"gitlab","project":"group/soup"}');
      INSERT INTO scout_findings (id, source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key) VALUES
        (1, 1, 'tickets:old%2Fapp%2342', '2026-09-01', '2026-09-01', 'Cache drops rows', 'Cache drops rows', 'old/app#42', 'old/app#42'),
        (2, 1, 'tickets:group%2Fapp%2342', '2026-10-01', '2026-10-01', 'Cache drops rows', 'Cache drops rows', 'group/app#42', 'group/app#42'),
        (3, 2, 'tickets:group%2Fsoup%237', '2026-10-01', '2026-10-01', 'Soup goes cold', 'Soup goes cold', 'group/soup#7', 'group/soup#7'),
        (4, 2, 'tickets:soup%237', '2026-10-02', '2026-10-02', 'Soup goes cold', 'Soup goes cold', 'soup#7', 'soup#7');
    `);
    older.close();

    const db = open();

    expect(userVersion(db)).toBe(migrations.length);
    expect(db.prepare('SELECT id, fingerprint, external_key FROM scout_findings ORDER BY id').all()).toEqual([
      { id: 1, fingerprint: 'tickets:old%2Fapp%2342', external_key: 'old/app#42' },
      { id: 2, fingerprint: 'tickets:app%2342', external_key: 'app#42' },
      { id: 3, fingerprint: 'tickets:group%2Fsoup%237', external_key: 'group/soup#7' },
      { id: 4, fingerprint: 'tickets:soup%237', external_key: 'soup#7' },
    ]);
  });
});

// Twenty-seven, counted: the database from before a person could comment on a diff line. It gains the
// table with no row, and a card that goes takes its comments with it.
it('adds the diff comments table to an older database, empty, and drops a card with its comments', () => {
  const older = open(migrations.slice(0, 27));
  expect(tables(older)).not.toContain('diff_comments');
  older.exec(`INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'implement', 'ready', 'Show a placeholder')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(count(db, 'diff_comments')).toBe(0);
  const add = db.prepare(
    `INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at) VALUES ('APP-1', '.', 'src/RecipeCard.svelte', ?, '  {:else}', 'Use the placeholder.', 'abc123', '2026-10-15T08:00:00.000Z')`,
  );
  add.run(12);
  expect(db.prepare('SELECT line, sent_at FROM diff_comments').all()).toEqual([{ line: 12, sent_at: null }]);
  expect(() => add.run(0)).toThrow(/CHECK/);

  db.exec("DELETE FROM cards WHERE key = 'APP-1'");
  expect(count(db, 'diff_comments')).toBe(0);
});

// Twenty-eight, counted: the database from before an Ask run named the discussion it answers in.
// Every older run belongs to no discussion, and a new Ask run keeps its own.
it('adds the discussion of an Ask run to an older database, and leaves the older runs in none', () => {
  const older = open(migrations.slice(0, 28));
  expect(columns(older, 'runs')).not.toContain('thread');
  older.exec(`INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'plan', 'claude-code', 'complete')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT phase, thread FROM runs').all()).toEqual([{ phase: 'plan', thread: null }]);

  const asked = startRun(db, { cardKey: 'APP-1', phase: 'ask', engine: 'claude-code', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null, thread: 'ask-2' });
  const plain = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });
  const read = db.prepare('SELECT thread FROM runs WHERE id = ?');
  expect(read.get(asked)).toEqual({ thread: 'ask-2' });
  expect(read.get(plain)).toEqual({ thread: null });
});

// Twenty-nine, counted: the database from before a card could follow a preset of its own. Every older
// card follows the project's preset.
it('adds the preset a card follows to an older database, and leaves the older cards on the project', () => {
  const older = open(migrations.slice(0, 29));
  expect(columns(older, 'cards')).not.toContain('preset');
  older.exec(`INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'delivery', 'plan', 'Sort')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT key, preset FROM cards').all()).toEqual([{ key: 'APP-1', preset: null }]);
});

// Thirty, counted: the database from before a pull request card kept the head its review read. No
// older card claims a round or a push.
it('adds the review head and round to an older database, and leaves the older cards with none', () => {
  const older = open(migrations.slice(0, 30));
  expect(columns(older, 'cards')).not.toContain('pr_round');
  older.exec(`INSERT INTO cards (key, board, stage, title, pr_decision) VALUES ('recipes#41', 'prreview', 'awaiting-author', 'Sort', 'CHANGES_REQUESTED')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT pr_seen_sha, pr_seen_commits, pr_head_sha, pr_head_commits, pr_round FROM cards').all()).toEqual([
    { pr_seen_sha: null, pr_seen_commits: null, pr_head_sha: null, pr_head_commits: null, pr_round: null },
  ]);
});

// Thirty-four, counted: the database from before Mockups became Design. An epic on the old stage keeps
// its column, its moves and its history, and moves on like any other card.
it('moves an epic on mockups to design with its runs, moves and discussion, and leaves other boards alone', () => {
  const older = open(migrations.slice(0, 34));
  older.exec(`INSERT INTO cards (key, board, stage, title) VALUES
    ('EPIC-1', 'epics', 'mockups', 'Meal plans'),
    ('APP-1', 'delivery', 'mockups', 'Sort the recipe list')`);
  older.exec(`INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase) VALUES
    ('EPIC-1', 'architecture', 'mockups', 'person', 'mockups'),
    ('EPIC-1', 'mockups', 'plan', 'person', NULL),
    ('APP-1', 'mockups', 'review', 'person', NULL),
    ('APP-1', 'review', 'mockups', 'person', NULL)`);
  older.exec("INSERT INTO runs (card_key, phase, engine) VALUES ('EPIC-1', 'mockups', 'claude-code')");
  older.exec("INSERT INTO messages (card_key, thread, author, body, at) VALUES ('EPIC-1', 'mockups', 'agent', 'One screen.', '2026-10-01T10:00:00Z')");
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT key, stage FROM cards ORDER BY key').all()).toEqual([
    { key: 'APP-1', stage: 'mockups' },
    { key: 'EPIC-1', stage: 'design' },
  ]);
  expect(db.prepare('SELECT card_key, from_stage, to_stage, started_phase FROM card_events ORDER BY id').all()).toEqual([
    { card_key: 'EPIC-1', from_stage: 'architecture', to_stage: 'design', started_phase: 'design' },
    { card_key: 'EPIC-1', from_stage: 'design', to_stage: 'plan', started_phase: null },
    { card_key: 'APP-1', from_stage: 'mockups', to_stage: 'review', started_phase: null },
    { card_key: 'APP-1', from_stage: 'review', to_stage: 'mockups', started_phase: null },
  ]);
  expect(db.prepare('SELECT phase FROM runs').all()).toEqual([{ phase: 'design' }]);
  expect(db.prepare('SELECT thread FROM messages').all()).toEqual([{ thread: 'design' }]);

  const epics = boardFor('epics', 'pull-request');
  expect(epics.stages.find((stage) => stage.id === 'design')).toMatchObject({ label: 'Design', phase: 'design' });
  expect(canMove(epics, { stage: 'design', state: 'ready' }, 'plan')).toBe(true);
});

// Thirty-six, counted: the database from before the git compare after a read-only run. Its runs read
// as no mark, and a mark written now reads back with the run's phase and engine.
it('adds the read-only mark to the runs of an older database', () => {
  const older = open(migrations.slice(0, 36));
  older.exec("INSERT INTO runs (card_key, phase, engine) VALUES ('APP-1', 'research', 'claude-code')");
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(readOnlyBreakOf(db, 'APP-1')).toBeNull();
  saveReadOnlyBreak(db, 1, { restored: false, diff: 'New file notes.txt.', undone: [], left: [] });
  expect(readOnlyBreakOf(db, 'APP-1')).toEqual({ phase: 'research', engine: 'claude-code', walled: false, restored: false, diff: 'New file notes.txt.', undone: [], left: [] });
});

// The database from before the commit warning: its runs read as none. Only the newest
// Implement run counts, so a new one clears the warning and a run of another phase does not.
it('adds the commit warning to the runs of an older database, and reads the newest Implement run only', () => {
  const older = open(migrations.slice(0, migrations.length - 1));
  older.exec("INSERT INTO runs (card_key, phase, engine) VALUES ('APP-1', 'implement', 'claude-code')");
  older.close();

  const db = open();
  expect(commitWarningOf(db, 'APP-1')).toBeNull();
  saveCommitWarning(db, 1, 'The implement run made a commit in web (1111111 to 2222222).');
  db.exec("INSERT INTO runs (card_key, phase, engine) VALUES ('APP-1', 'qa', 'claude-code')");
  expect(commitWarningOf(db, 'APP-1')).toBe('The implement run made a commit in web (1111111 to 2222222).');
  db.exec("INSERT INTO runs (card_key, phase, engine) VALUES ('APP-1', 'implement', 'claude-code')");
  expect(commitWarningOf(db, 'APP-1')).toBeNull();
});

// Forty-six, counted: the database from before Research became one board. A question and an
// investigation on the old columns land on Research and Review with their moves, and a Delivery card
// whose column carries one of the old names stays where it is.
it('moves Research cards and their moves onto the shared column ids, and leaves other boards alone', () => {
  const older = open(migrations.slice(0, 46));
  older.exec(`INSERT INTO cards (key, board, stage, title) VALUES
    ('Q-1', 'questions', 'researching', 'Where is the title checked?'),
    ('Q-2', 'questions', 'answer', 'Which sizes does the api send?'),
    ('INV-1', 'investigations', 'running', 'Why do uploads fail?'),
    ('INV-2', 'investigations', 'report', 'Why is the list slow?'),
    ('APP-1', 'delivery', 'report', 'Sort the recipe list')`);
  older.exec(`INSERT INTO card_events (card_key, from_stage, to_stage, who) VALUES
    ('Q-2', 'inbox', 'researching', 'person'),
    ('Q-2', 'researching', 'answer', 'agent'),
    ('INV-2', 'running', 'report', 'agent'),
    ('APP-1', 'running', 'report', 'person')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT key, stage FROM cards ORDER BY key').all()).toEqual([
    { key: 'APP-1', stage: 'report' },
    { key: 'INV-1', stage: 'research' },
    { key: 'INV-2', stage: 'review' },
    { key: 'Q-1', stage: 'research' },
    { key: 'Q-2', stage: 'review' },
  ]);
  expect(db.prepare('SELECT card_key, from_stage, to_stage FROM card_events ORDER BY id').all()).toEqual([
    { card_key: 'Q-2', from_stage: 'inbox', to_stage: 'research' },
    { card_key: 'Q-2', from_stage: 'research', to_stage: 'review' },
    { card_key: 'INV-2', from_stage: 'research', to_stage: 'review' },
    { card_key: 'APP-1', from_stage: 'running', to_stage: 'report' },
  ]);

  const questions = boardFor('questions', 'pull-request');
  expect(canMove(questions, { stage: 'review', state: 'ready' }, 'wrapup')).toBe(true);
});

// Forty-seven, counted: the database from before PR reviews lost its Re-review column. A card there
// lands on Agent pre-review with its moves, so its trail still draws, and a card of another board
// whose column has the same name stays.
it('moves PR review cards and their moves off Re-review onto Agent pre-review', () => {
  const older = open(migrations.slice(0, 47));
  older.exec(`INSERT INTO cards (key, board, stage, title) VALUES
    ('api#7', 'prreview', 're-review', 'Fix the search'),
    ('api#8', 'prreview', 'my-review', 'Sort the list'),
    ('APP-1', 'delivery', 're-review', 'Sort the recipe list')`);
  older.exec(`INSERT INTO card_events (card_key, from_stage, to_stage, who) VALUES
    ('api#7', 'awaiting-author', 're-review', 'person'),
    ('api#8', 're-review', 'my-review', 'auto'),
    ('APP-1', 'review', 're-review', 'person')`);
  older.close();

  const db = open();
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.prepare('SELECT key, stage FROM cards ORDER BY key').all()).toEqual([
    { key: 'APP-1', stage: 're-review' },
    { key: 'api#7', stage: 'pre-review' },
    { key: 'api#8', stage: 'my-review' },
  ]);
  expect(db.prepare('SELECT card_key, from_stage, to_stage FROM card_events ORDER BY id').all()).toEqual([
    { card_key: 'api#7', from_stage: 'awaiting-author', to_stage: 'pre-review' },
    { card_key: 'api#8', from_stage: 'pre-review', to_stage: 'my-review' },
    { card_key: 'APP-1', from_stage: 'review', to_stage: 're-review' },
  ]);
  const reviews = boardFor('prreview', 'pull-request');
  expect(reviews.stages.map((stage) => stage.id)).toContain('pre-review');
  expect(canMove(reviews, { stage: 'pre-review', state: 'idle' }, 'my-review')).toBe(true);
});
