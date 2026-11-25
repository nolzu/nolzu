import type { DatabaseSync } from 'node:sqlite';
import { isScoutSourceKind, type ScoutSourceKind } from '@nolzu/protocol';

/**
 * One place Scout looks, as the screens read it.
 *
 * The secret is not here and never is. It lives in the OS keychain under the name `scoutEntryName`
 * builds from the kind, the project and the id, and nothing in this module reads or writes it, so a
 * row can be listed without asking the person for their keychain password.
 */
export interface ScoutSource {
  id: number;
  kind: ScoutSourceKind;
  label: string;
  // The adapter's own settings. A secret never goes in here, which is what keeps sqlite free of one.
  config: Readonly<Record<string, string>>;
  enabled: boolean;
  // The two opt-ins. Both off until a person turns them on.
  createCards: boolean;
  autoAssess: boolean;
  // How often Nolzu cloud checks this source, in minutes, and whether a finding notifies the person.
  // Zero is off. Nothing on this machine reads the number: the check a schedule starts runs on the
  // server, and the client keeps the row so the screen still shows it after a restart.
  scheduleMinutes: number;
  notify: boolean;
  cursor: string | null;
  lastChecked: string | null;
  lastError: string | null;
}

interface Row {
  id: number;
  kind: string;
  label: string;
  config_json: string;
  enabled: number;
  create_cards: number;
  auto_assess: number;
  schedule_minutes: number;
  notify: number;
  cursor: string | null;
  last_checked: string | null;
  last_error: string | null;
}

/**
 * The field names a secret hides behind.
 *
 * A source secret goes to the OS keychain, never into sqlite and never
 * into a log, and a comment saying so is not what holds it: the config is a map of whatever the
 * caller passes, so one forgotten field puts a token in the database file and in every backup of
 * it. These names are refused instead. A secret with a name nobody guessed still gets through, so
 * this catches the mistake and not an attacker.
 */
const SECRET_NAMES = ['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'credential', 'bearer', 'privatekey', 'private_key'];

function refuseSecret(config: Readonly<Record<string, string>>): void {
  const named = Object.keys(config).find((name) => SECRET_NAMES.some((secret) => name.toLowerCase().includes(secret)));
  if (named === undefined) return;
  throw new Error(
    `A source's settings may not hold ${JSON.stringify(named)}. A secret goes to the OS keychain under the source's own entry, never into the database, so store it there and keep the settings to what a person may read.`,
  );
}

// A config written by an older version, or by hand, that is not an object of strings. Read as
// nothing rather than handed on: an adapter that got a number where it expects a query would fail
// somewhere further away, with the stored row nowhere in the sentence.
function readConfig(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value]] : [])));
  } catch {
    return {};
  }
}

const read = (row: Row): ScoutSource => ({
  id: row.id,
  // The column carries a CHECK, so a kind this version does not know is a row written by a newer
  // one. It is kept and shown as it is rather than dropped, the way a gone model is.
  kind: isScoutSourceKind(row.kind) ? row.kind : 'paste',
  label: row.label,
  config: readConfig(row.config_json),
  enabled: row.enabled === 1,
  createCards: row.create_cards === 1,
  autoAssess: row.auto_assess === 1,
  scheduleMinutes: row.schedule_minutes,
  notify: row.notify === 1,
  cursor: row.cursor,
  lastChecked: row.last_checked,
  lastError: row.last_error,
});

// In the order they were added, which is the order the screen lists them in, so a source does not
// move under a person's hand when they turn one off.
export function scoutSources(db: DatabaseSync): ScoutSource[] {
  return (db.prepare('SELECT * FROM scout_sources ORDER BY id').all() as unknown as Row[]).map(read);
}

export function scoutSource(db: DatabaseSync, id: number): ScoutSource | null {
  const row = db.prepare('SELECT * FROM scout_sources WHERE id = ?').get(id) as unknown as Row | undefined;
  return row === undefined ? null : read(row);
}

export interface NewScoutSource {
  kind: ScoutSourceKind;
  label: string;
  config?: Readonly<Record<string, string>>;
}

// The id comes back, because it names the keychain entry the caller writes the secret to.
export function addScoutSource(db: DatabaseSync, source: NewScoutSource): number {
  refuseSecret(source.config ?? {});
  const made = db
    .prepare('INSERT INTO scout_sources (kind, label, config_json) VALUES (?, ?, ?) RETURNING id')
    .get(source.kind, source.label, JSON.stringify(source.config ?? {})) as unknown as { id: number };
  return made.id;
}

export interface ScoutSourcePatch {
  label?: string;
  config?: Readonly<Record<string, string>>;
  enabled?: boolean;
  createCards?: boolean;
  autoAssess?: boolean;
  scheduleMinutes?: number;
  notify?: boolean;
}

/**
 * One source's own settings, as far as a person sets them.
 *
 * The cursor, the last check and the last error are not here. Those belong to a check, and
 * `finishScoutCheck` below is the one writer of them, so a screen cannot make a source look checked
 * when nothing ran.
 */
export function setScoutSource(db: DatabaseSync, id: number, patch: ScoutSourcePatch): void {
  refuseSecret(patch.config ?? {});
  const columns: [string, string | number][] = [];
  if (patch.label !== undefined) columns.push(['label', patch.label]);
  if (patch.config !== undefined) columns.push(['config_json', JSON.stringify(patch.config)]);
  if (patch.enabled !== undefined) columns.push(['enabled', patch.enabled ? 1 : 0]);
  if (patch.createCards !== undefined) columns.push(['create_cards', patch.createCards ? 1 : 0]);
  if (patch.autoAssess !== undefined) columns.push(['auto_assess', patch.autoAssess ? 1 : 0]);
  if (patch.scheduleMinutes !== undefined) columns.push(['schedule_minutes', patch.scheduleMinutes]);
  if (patch.notify !== undefined) columns.push(['notify', patch.notify ? 1 : 0]);
  if (columns.length === 0) return;

  db.prepare(`UPDATE scout_sources SET ${columns.map(([name]) => `${name} = ?`).join(', ')} WHERE id = ?`).run(...columns.map(([, value]) => value), id);
}

/**
 * The marker of one source, cleared.
 *
 * Its own function and not a field of `setScoutSource`, so a screen still cannot make a source look
 * checked. A settings change that names other rows has to clear it: a source pointed at another index
 * keeps asking for rows newer than the last check of the old one, and an older index answers nothing
 * for good, on every press, with no way out but removing the source and its findings.
 */
export function clearScoutCursor(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE scout_sources SET cursor = NULL WHERE id = ?').run(id);
}

// The clock the run rows use, so every stamp in the file comes from sqlite and a check needs no
// injected time.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ')";

export interface ScoutCheckEnd {
  // Where the fetch stopped, as the adapter wrote it. A check that read nothing hands back the
  // cursor it was given, so the marker does not move on an empty read.
  cursor: string | null;
  // What the check failed with, in the source's own words. Left out for a check that worked, which
  // clears the error a previous one left.
  //
  // The caller owes a sentence with no part of a credential in it. This column is read on the
  // settings screen and kept until the next check that works, and on macOS a refused command echoes
  // what it was given, so an adapter that passes a tool's raw output on can put a token here.
  error?: string | null;
}

/**
 * Where a check ends: the three columns `setScoutSource` cannot write.
 *
 * All three move together, because a cursor written without a time would leave a source that looks
 * unchecked while it has already read everything, and the person would paste it all again.
 */
export function finishScoutCheck(db: DatabaseSync, id: number, end: ScoutCheckEnd): void {
  db.prepare(`UPDATE scout_sources SET cursor = ?, last_checked = ${NOW}, last_error = ? WHERE id = ?`).run(end.cursor, end.error ?? null, id);
}

// The row goes. Its secret is the caller's to remove, because this package holds no keychain.
export function removeScoutSource(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM scout_sources WHERE id = ?').run(id);
}
