import type { DatabaseSync } from 'node:sqlite';
import { FIRST_PROJECT, getSetting, openDatabase, openMachine, openProject, type RegisteredProject, registeredProjects, resolveDataDir } from '@nolzu/core/node';
import { activeProject } from './display.ts';

// The project that stands in for the first one, by data folder, once the first could not open.
const standIns = new Map<string, number>();

// A database file SQLite cannot read: not a database (26) or corrupt (11), extended codes included.
// node:sqlite gives every SQLite error one code, so busy, cannot open, read only, I/O and a failed
// migration step carry ERR_SQLITE_ERROR too, and none of those is a damaged file.
export const damagedDatabase = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && [11, 26].includes(code & 0xff);
};

// The project standing in for the first one of this data folder, if any.
export const standInOf = (dataDir: string): number | undefined => standIns.get(dataDir);

/**
 * Opens the first project, the one that reads the machine and boots the data folder. When its database
 * file is damaged (`damagedDatabase`), the next registered project that opens takes its place,
 * so one bad project never stops Nolzu. The stand-in is kept, so a request does not try the damaged
 * file again. `open` gets undefined for the first project and an id for any other. Throws one sentence
 * naming the data folder when no project opens.
 */
export function openFirstThatOpens<T>(dataDir: string, open: (id: number | undefined) => T): T {
  const kept = standIns.get(dataDir);
  if (kept !== undefined) return open(kept);
  let firstError: Error;
  try {
    return open(undefined);
  } catch (error) {
    // Only a damaged file. Another refusal, such as a second Nolzu holding the data folder, a busy
    // database or a newer one, holds for every project or passes, and is said as it is.
    if (!damagedDatabase(error)) throw error;
    firstError = error as Error;
  }
  const machine = openMachine(dataDir);
  let others: RegisteredProject[];
  try {
    others = registeredProjects(machine).filter((one) => one.file !== FIRST_PROJECT);
  } finally {
    machine.close();
  }
  for (const other of others) {
    let opened: T;
    try {
      opened = open(other.id);
    } catch (error) {
      // The same rule as for the first: only a damaged file makes way for the next project.
      if (!damagedDatabase(error)) throw error;
      continue;
    }
    standIns.set(dataDir, other.id);
    console.error(`The first project could not open (${firstError.message}), so Nolzu opened project ${other.id} in its place. Restart Nolzu and pick it again once it is fixed.`);
    return opened;
  }
  throw new Error(`No project in ${dataDir} could open. The first one says: ${firstError.message}`);
}

// The connection that reads the machine, the registry and the current project: the first project's, or
// its stand-in's (`openFirstThatOpens`), with that project's id.
let first: { db: DatabaseSync; id: number } | null = null;
// Every other project's connection, by its registry id.
const others = new Map<number, DatabaseSync>();

// The project a route works on: the one it names, or the current one, by the rules of `activeProject`.
// `db` is any project connection, for the machine's rows.
export function chosenProject(db: DatabaseSync, asked?: number): RegisteredProject {
  const registered = registeredProjects(db);
  const id = activeProject(registered.map((one) => one.id), getSetting(db, 'currentProject'), asked);
  return registered.find((one) => one.id === id)!;
}

// One connection per project for the server process, opened on first use: the project a route names, or
// the current one. The guard in the test setup refuses the live data directory, so a test that reached
// this would fail rather than open the real database.
export function database(project?: number): DatabaseSync {
  const dataDir = resolveDataDir(process.env);
  first ??= openFirstThatOpens(dataDir, (id) => {
    const db = id === undefined ? openDatabase(dataDir) : openProject(dataDir, id);
    return { db, id: id ?? registeredProjects(db).find((one) => one.file === FIRST_PROJECT)!.id };
  });
  const chosen = chosenProject(first.db, project);
  if (chosen.id === first.id) return first.db;
  let db = others.get(chosen.id);
  if (db === undefined) {
    db = openProject(dataDir, chosen.id);
    others.set(chosen.id, db);
  }
  return db;
}

// A project New project took back. A page load may have opened it while its Add waited on git, and
// the next project made gets its id, so that connection to a deleted file must not answer for it.
export function forgetProject(id: number): void {
  others.get(id)?.close();
  others.delete(id);
}
