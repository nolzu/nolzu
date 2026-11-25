import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MACHINE_KEYS } from '../settings.ts';
import { machineMigrations, migrations as releasedMigrations } from './migrations.ts';

const MACHINE_FILE = 'machine.db';
// The project a data folder had before there were several. The boot registers it first.
export const FIRST_PROJECT = 'nolzu.db';

// The project connections that have the machine database attached, with the data folder and the file
// each one opened. A connection made any other way keeps every setting in its own table, as before the
// machine database.
const withMachine = new WeakMap<DatabaseSync, { dataDir: string; file: string }>();
export const machineAttached = (db: DatabaseSync): boolean => withMachine.has(db);

// A registry row is read back as a path, so a project's database is always resolved inside the data
// folder. A name that leads anywhere else, or onto the machine's own file, is refused before it opens.
function insideDataDir(dataDir: string, file: string): string {
  const path = resolve(dataDir, file);
  const from = relative(resolve(dataDir), path);
  // The machine's file in any case, because the file system of a Mac ignores case.
  if (from === '' || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from) || from.toLowerCase() === MACHINE_FILE) {
    throw new Error(`The project database ${file} is not inside ${dataDir}, so Nolzu does not open it.`);
  }
  return from;
}

// `file` is a project's database, relative to the data folder, as its registry row names it.
export function openDatabase(dataDir: string, migrations: readonly string[] = releasedMigrations, file: string = FIRST_PROJECT): DatabaseSync {
  const inside = insideDataDir(dataDir, file);
  // The machine first, on a connection of its own because its migrations name no schema. One newer
  // than this build then refuses before the project's database is touched.
  openMachine(dataDir).close();
  const db = openFile(dataDir, inside, migrations);
  try {
    // Attached rather than held open beside it, so it closes with the project's connection.
    // Limit: BEGIN IMMEDIATE on a project connection takes the machine's write lock too. Harmless
    // with one project; with several writing at once, a machine connection of its own avoids the wait.
    db.prepare('ATTACH DATABASE ? AS machine').run(join(dataDir, MACHINE_FILE));
    withMachine.set(db, { dataDir, file });
    adoptFirstProject(db);
    if (file === FIRST_PROJECT) takeBackProjectKeys(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * A data folder from before the machine database: its `nolzu.db` becomes the first project, where it
 * lies, and its machine keys are copied by the rule of `machineRow`, for every key at once.
 *
 * One write, so a registry row means the copy is done too, and every later boot changes nothing.
 */
function adoptFirstProject(db: DatabaseSync): void {
  if (registeredProjects(db).length > 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again under the write lock: another connection may have adopted it while this one waited.
    if (registeredProjects(db).length === 0) {
      registerProject(db, FIRST_PROJECT);
      db.prepare(
        `INSERT OR IGNORE INTO machine.settings (key, value)
         SELECT key, value FROM main.settings WHERE key IN (${MACHINE_KEYS.map(() => '?').join(', ')})`,
      ).run(...MACHINE_KEYS);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Keys that were machine keys for a while and belong to one project again.
const BACK_TO_PROJECT = ['teamHubJobDone'];

/**
 * Moves a key that left `MACHINE_KEYS` from the machine database back into the first project, once.
 *
 * `teamHubJobDone` was the mark of the one team socket a machine held, and that socket belonged to the
 * project open at start, which is the first project on a machine that held a team socket before
 * several projects. The machine's row is the newer one: the project's row was never written after the
 * machine database came.
 */
function takeBackProjectKeys(db: DatabaseSync): void {
  const marks = BACK_TO_PROJECT.map(() => '?').join(', ');
  if (db.prepare(`SELECT 1 FROM machine.settings WHERE key IN (${marks})`).get(...BACK_TO_PROJECT) === undefined) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT OR REPLACE INTO main.settings (key, value) SELECT key, value FROM machine.settings WHERE key IN (${marks})`).run(...BACK_TO_PROJECT);
    db.prepare(`DELETE FROM machine.settings WHERE key IN (${marks})`).run(...BACK_TO_PROJECT);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// The machine settings and the project registry. One per data folder, whatever the number of projects.
export function openMachine(dataDir: string): DatabaseSync {
  return openFile(dataDir, MACHINE_FILE, machineMigrations);
}

function openFile(dataDir: string, name: string, migrations: readonly string[]): DatabaseSync {
  const file = join(dataDir, name);
  // The data folder, or the projects folder in it for every project after the first.
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // First, because the app and a command line call can hold the write lock at the same time.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, file, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface RegisteredProject {
  id: number;
  // The project's database, relative to the data folder.
  file: string;
}

export const registeredProjects = (db: DatabaseSync): RegisteredProject[] =>
  db.prepare('SELECT id, file FROM project_registry ORDER BY id').all() as unknown as RegisteredProject[];

export function registerProject(db: DatabaseSync, file: string): number {
  return Number(db.prepare('INSERT INTO project_registry (file) VALUES (?)').run(file).lastInsertRowid);
}

// A registered project's database by its id, with the machine attached, as `openDatabase` opens the first.
export function openProject(dataDir: string, id: number): DatabaseSync {
  const machine = openMachine(dataDir);
  let file: string | undefined;
  try {
    file = registeredProjects(machine).find((one) => one.id === id)?.file;
  } finally {
    machine.close();
  }
  if (file === undefined) throw new Error(`There is no project ${id} in ${dataDir}.`);
  return openDatabase(dataDir, releasedMigrations, file);
}

// The data folder and the registered project of a connection `openDatabase` made, so code handed only
// the connection reaches the machine's other projects. Undefined for any other connection.
export function projectOf(db: DatabaseSync): { dataDir: string; project: RegisteredProject } | undefined {
  const own = withMachine.get(db);
  const project = own === undefined ? undefined : registeredProjects(db).find((one) => one.file === own.file);
  return own === undefined || project === undefined ? undefined : { dataDir: own.dataDir, project };
}

/**
 * A new project, for New project on a plan with several: its database in the projects folder, named by
 * the id the registry gives it, which counts on from the highest.
 *
 * Written through the machine's own connection, so a damaged first project does not stop New project.
 * A registry with no row yet opens the first project once, so a data folder that never opened it still
 * adopts `nolzu.db` as project 1 before this one.
 */
export function createProject(dataDir: string): DatabaseSync {
  let machine = openMachine(dataDir);
  if (registeredProjects(machine).length === 0) {
    machine.close();
    openDatabase(dataDir).close();
    machine = openMachine(dataDir);
  }
  let id: number;
  try {
    // One statement, so two at once cannot take the same id.
    id = Number(
      machine
        .prepare("INSERT INTO project_registry (id, file) SELECT next, 'projects/' || next || '.db' FROM (SELECT coalesce(max(id), 0) + 1 AS next FROM project_registry)")
        .run().lastInsertRowid,
    );
  } finally {
    machine.close();
  }
  return openProject(dataDir, id);
}

// Takes back a project `createProject` made when New project made nothing in it, so no project with no
// folder stays in the registry. It closes the connection and deletes the database.
export function dropProject(db: DatabaseSync): void {
  const own = withMachine.get(db);
  if (own === undefined || own.file === FIRST_PROJECT) throw new Error('The first project cannot be taken back.');
  db.prepare('DELETE FROM project_registry WHERE file = ?').run(own.file);
  db.close();
  const path = join(own.dataDir, own.file);
  for (const end of ['', '-wal', '-shm']) rmSync(`${path}${end}`, { force: true });
}

// Where a project's run files go: the run logs, the guard settings a run is handed, the knowledge kept
// for review. The first project keeps the data folder, as before there were several. Every other has a
// folder of its own, because card keys and run ids repeat across projects and so would the file names.
export const projectFiles = (dataDir: string, project: RegisteredProject): string =>
  project.file === FIRST_PROJECT ? dataDir : join(dataDir, 'projects', String(project.id));

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function migrate(db: DatabaseSync, file: string, migrations: readonly string[]) {
  // An older database is copied once before it changes. `npx nolzu@latest` brings each release to
  // everyone at their next start, and a step that rewrites rows wrongly would leave no way back.
  const start = userVersion(db);
  if (start > 0 && start < migrations.length) {
    try {
      backup(db, join(dirname(file), 'backups', basename(file, '.db')));
    } catch (error) {
      // SQLite's code stays on it, so a damaged project is still told from any other failure.
      throw Object.assign(new Error(`Nolzu could not copy ${file} before updating it, so it left it as it is. ${(error as Error).message}`, { cause: error }), { errcode: (error as { errcode?: number }).errcode });
    }
  }
  for (;;) {
    const version = userVersion(db);
    if (version > migrations.length) {
      throw new Error(
        `${file} has schema version ${version}, and this Nolzu knows versions up to ${migrations.length}. Update Nolzu to open it.`,
      );
    }
    if (version === migrations.length) return;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Read again under the write lock: another process may have migrated while this one waited.
      const current = userVersion(db);
      const sql = migrations[current];
      if (sql !== undefined) {
        db.exec(sql);
        db.exec(`PRAGMA user_version = ${current + 1}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      // Some errors roll back on their own, and a second ROLLBACK would hide the first error.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
}

// One statement, so two writers never get the same number.
export function nextSeq(db: DatabaseSync, name: string): number {
  const row = db
    .prepare('INSERT INTO seq (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value')
    .get(name) as { value: number };
  return row.value;
}

// The board version the snapshot carries, which the stream uses as its event id. Bumped by the two
// writes a person can see happen: a move, and a run event. It lives in the database rather than in
// the loop, because a number held in memory resets to zero on a restart and the event id would then
// go backwards, and the snapshot promises it never falls.
const VERSION = 'snapshot';

export function bumpVersion(db: DatabaseSync): number {
  return nextSeq(db, VERSION);
}

export function boardVersion(db: DatabaseSync): number {
  return (db.prepare('SELECT value FROM seq WHERE name = ?').get(VERSION) as { value: number } | undefined)?.value ?? 0;
}

const backupName = /^nolzu-\d{8}-\d{6}\.db$/;
const keptBackups = 7;

export function backup(db: DatabaseSync, dir: string): string {
  mkdirSync(dir, { recursive: true });
  // UTC, so the name order is the time order, also across daylight saving changes.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const file = join(dir, `nolzu-${stamp}.db`);
  // VACUUM INTO refuses an existing file, and the rename means a half-written copy never
  // carries a backup name. A second backup in the same second replaces the first.
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  try {
    db.prepare('VACUUM INTO ?').run(partial);
    renameSync(partial, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  const backups = readdirSync(dir)
    .filter((name) => backupName.test(name))
    .sort();
  for (const name of backups.slice(0, -keptBackups)) rmSync(join(dir, name));
  return file;
}
