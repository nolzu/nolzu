import type { DatabaseSync } from 'node:sqlite';
import type { EngineProfile } from '@nolzu/protocol';
import { DEFAULTS, isMachineKey, readSetting, type SettingKey, type Settings, validateRepos, validateSetting } from '../settings.ts';
import { presetProfiles } from '../models.ts';
import { bumpVersion, machineAttached } from './db.ts';

const rowIn = (db: DatabaseSync, table: string, key: SettingKey): string | undefined =>
  (db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined)?.value;

/**
 * A machine key's stored row.
 *
 * An upgrade finds every machine key in the project's table, so a key the machine database lacks is
 * copied from there once, as it is stored, and read from the machine from then on. The first boot
 * copies them all this way (`adoptFirstProject` in `db.ts`); this catches a row that turns up later,
 * such as one an older Nolzu wrote. The project's row is never written again. A connection with no
 * machine database reads its own table.
 */
export function machineRow(db: DatabaseSync, key: SettingKey): string | undefined {
  if (!machineAttached(db)) return rowIn(db, 'settings', key);
  const held = rowIn(db, 'machine.settings', key);
  if (held !== undefined) return held;
  const old = rowIn(db, 'main.settings', key);
  if (old === undefined) return undefined;
  db.prepare('INSERT OR IGNORE INTO machine.settings (key, value) VALUES (?, ?)').run(key, old);
  // Read back, because another connection may have copied first, and its row is the one every reader sees.
  return rowIn(db, 'machine.settings', key);
}

// `MACHINE_KEYS` is the one list that sends a key to the machine database.
const rawSetting = (db: DatabaseSync, key: SettingKey): string | undefined => (isMachineKey(key) ? machineRow(db, key) : rowIn(db, 'settings', key));
const tableFor = (db: DatabaseSync, key: SettingKey): string => (isMachineKey(key) && machineAttached(db) ? 'machine.settings' : 'settings');

// The repository list is read by the rule of the workspace flag stored beside it.
const inWorkspace = (db: DatabaseSync): boolean => readSetting('workspace', rawSetting(db, 'workspace')).value === true;

export function getSetting<K extends SettingKey>(db: DatabaseSync, key: K): Settings[K] {
  return readSetting(key, rawSetting(db, key), key === 'repos' && inWorkspace(db)).value;
}

// The repos list names `.` only when the project folder is a repository itself, and the scan and
// the validator keep the list in step with the disk. With no list the folder is the one repository.
// A workspace folder is a repository of its own, so it is never outside git.
export function projectOutsideGit(db: DatabaseSync): boolean {
  const repos = getSetting(db, 'repos');
  return getSetting(db, 'projectPath') !== null && getSetting(db, 'workspace') !== true && repos !== null && !repos.some((repo) => repo.path === '.');
}

// The profiles every resolve of this project's rows takes, the preset engine's main login first. The
// board, the card, the run and Settings, Models all read them here, so none of them can disagree on
// which login a row with no engine of its own runs on.
export function projectProfiles(db: DatabaseSync): readonly EngineProfile[] {
  return presetProfiles(getSetting(db, 'engineProfiles'), getSetting(db, 'presetEngine'));
}

// The checked value, with the rule that ties the repository list to the workspace flag. A flag that
// would make the stored list unreadable is refused, or the list would read back as one repository at
// the project folder. Change the list first.
function checked<K extends SettingKey>(db: DatabaseSync, key: K, value: unknown) {
  const result = validateSetting(key, value, key === 'repos' && inWorkspace(db));
  if (!result.ok || key !== 'workspace') return result;
  const raw = rawSetting(db, 'repos');
  let stored: unknown = null;
  try {
    stored = raw === undefined ? null : JSON.parse(raw);
  } catch {
    // A list that cannot be read falls back either way: to none in a workspace, to "." outside one.
  }
  const refused = stored === null ? null : validateRepos(stored, value === true);
  return refused === null ? result : { ok: false as const, message: refused };
}

// The sentence that refuses the value, or null when it can be stored.
export function settingProblem<K extends SettingKey>(db: DatabaseSync, key: K, value: unknown): string | null {
  const result = checked(db, key, value);
  return result.ok ? null : result.message;
}

// Only the keys this version knows. A row written by a newer version stays in the table untouched,
// so downgrading and upgrading again does not lose it.
export function readSettings(db: DatabaseSync): Settings {
  return Object.fromEntries((Object.keys(DEFAULTS) as SettingKey[]).map((key) => [key, getSetting(db, key)])) as unknown as Settings;
}

export function writeSetting<K extends SettingKey>(db: DatabaseSync, key: K, value: Settings[K]): void {
  const result = checked(db, key, value);
  // Refused before the write, so a screen that ignores the message cannot store a value the
  // reader would then have to fall back from.
  if (!result.ok) throw new Error(result.message);

  db.prepare(`INSERT INTO ${tableFor(db, key)} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(
    key,
    JSON.stringify(result.value),
  );
  // The board draws the preset and the flow, so a setting write changes what every open board shows
  // and the version has to move with it. Written first and bumped after: a read landing between the
  // two sends the new value under the old id and the bump makes the stream resend it, which is
  // harmless, where bumping first would send old content under a new id and leave it stale.
  bumpVersion(db);
}
