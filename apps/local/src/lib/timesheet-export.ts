import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, writeSetting } from '@nolzu/core/node';
import { type Timesheet, type TimesheetEntry, timesheetEntries } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { projectName } from './app-header.ts';
import { ExportSkipped } from './timesheet-call.ts';
import { exportClockify } from './timesheet-clockify.ts';
import { exportHarvest } from './timesheet-harvest.ts';
import { exportJira } from './timesheet-jira.ts';
import { exportToggl } from './timesheet-toggl.ts';

/**
 * The timesheet exporters: which time trackers this machine posts a week to, what it has already
 * sent, and what the last export failed with.
 *
 * Everything runs here. The token is in the OS keychain, the call leaves from this machine, and the
 * rows that stop a week being billed twice are in the local database. Nothing about an export goes
 * to the hub: no frame carries it, and the Data sync list has no line for it.
 *
 * WHERE THE ENTRIES COME FROM. The week as the database holds it when Export is pressed.
 * `timesheetEntries` in `@nolzu/protocol` reads them off that week's grid, so an entry cannot disagree
 * with the cell the grid draws for it. A cell with a run still going is held back, because its
 * figure leaves that run out and a sent day is never sent again.
 *
 * WHAT TRIES AGAIN. A person, by pressing Export again. There is no timer and no queue behind this:
 * an export is something somebody asks for, and hours that failed to reach Toggl are not more correct
 * an hour later. What the stored rows give that person is a second press that costs nothing:
 * everything that went out is skipped by its id, and only what failed is tried. `MAX_ATTEMPTS` is
 * where that stops, so a destination that refuses one entry for ever is not asked about it on every
 * export.
 *
 * WHAT HAS ALREADY GONE NEVER GOES AGAIN. The external id carries no figure, so a run added to a
 * day that was exported keeps that day's id. This file then skips it and counts it as changed,
 * which the panel says out loud. The other way round is a second entry for hours a client was
 * already billed for, and no ceiling anywhere would take that money back.
 */

/** The destinations a week can go to. A name here is a column value and part of a keychain name. */
export const EXPORT_DESTINATIONS = ['toggl', 'harvest', 'clockify', 'jira'] as const;
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number];

export const isExportDestination = (value: string): value is ExportDestination => (EXPORT_DESTINATIONS as readonly string[]).includes(value);

export const DESTINATION_LABELS: Record<ExportDestination, string> = { toggl: 'Toggl', harvest: 'Harvest', clockify: 'Clockify', jira: 'Jira' };

/**
 * The keychain entry one destination's token lives under, next to the Scout tokens and under the
 * same service. One entry per destination for the whole data folder, whatever the number of projects.
 */
export const exporterSecretName = (destination: ExportDestination): string => `export-${destination}`;

/**
 * One entry posted to one destination.
 *
 * The adapter gets the entry, the token, the connection's own settings and the timeout signal, and
 * answers with the id the destination gave the entry, or null where it hands none back. That id is
 * stored so a person can follow one row to the other system, and nothing here reads it.
 *
 * WHAT AN ADAPTER HAS TO PROVIDE, and this is the whole of it: a throw whose message is the
 * destination's own words, and the signal passed on to its `fetch`. It stores nothing, it dedups
 * nothing and it counts nothing. An entry it returns from is sent, so an adapter that cannot post
 * has to throw and may not answer quietly.
 *
 * WHAT A THROW DOES NOT PROVE. A timeout, a dropped connection and a 502 from a proxy are throws on
 * this side of a call the destination may already have finished. The stored row is written from this
 * side too, so it says the entry never went and the next press posts it again. Only the adapter can
 * close that, by asking the destination for the entry before it posts, and all four do. An adapter
 * added later that does not may bill a day twice when a person presses Export again after a timeout.
 *
 * AN ENTRY A DESTINATION CAN NEVER TAKE is thrown as `ExportSkipped`, which is neither sent nor
 * failed. Jira is the one that needs it: a card with no Jira issue has nowhere to go.
 */
export type ExportAdapter = (entry: TimesheetEntry, secret: string, settings: Record<string, unknown>, signal: AbortSignal) => Promise<string | null>;

export type ExportAdapters = Partial<Record<ExportDestination, ExportAdapter>>;

/**
 * The adapters this client has. Each is written from its destination's documentation and not from
 * a recorded answer, and the header of each adapter file names what the first real call has to
 * confirm.
 */
export const EXPORT_ADAPTERS: ExportAdapters = { toggl: exportToggl, harvest: exportHarvest, clockify: exportClockify, jira: exportJira };

/** How long one entry's post may take, its read before it included. */
export const EXPORT_TIMEOUT_MS = 20_000;

/** The sentence an entry gets when the destination did not answer in time. */
export const EXPORT_TIMEOUT_SENTENCE = 'The destination did not answer in time, so the entry was not sent.';

/**
 * How many times one entry is tried before it is left alone.
 *
 * Past this the entry is skipped with the sentence it last failed with, which is the difference
 * between an export that shows what is wrong and one that asks a destination the same refused
 * question for ever. The panel marks it stuck.
 */
export const MAX_ATTEMPTS = 5;

/**
 * How many failures in a row end the run.
 *
 * Three refusals in a row is a destination that is down, a token that was revoked or a workspace
 * that was renamed, and the entries behind them would each pay the timeout before failing the same
 * way. They stay untried, so the next press starts where this one stopped.
 */
export const MAX_FAILURES_PER_EXPORT = 3;

// What a stored sentence is cut to.
const MAX_ERROR_CHARS = 300;

// What the settings of one connection may weigh, as JSON. A handful of ids is far under it.
export const MAX_SETTINGS_CHARS = 4096;

/** One field of a connection form. The name is the input's name and the key it is stored under. */
export interface ExporterField {
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
}

/** The form one destination is connected with. Drawn by the panel, read back by `postExporter`. */
export interface ExporterForm {
  destination: ExportDestination;
  label: string;
  fields: ExporterField[];
  // What the token is called at that destination.
  secret: string;
  // Where a person finds the token, and anything else the form cannot say in a field label.
  where: string;
}

export const EXPORTER_FORMS: readonly ExporterForm[] = [
  {
    destination: 'toggl',
    label: 'Toggl',
    fields: [
      { name: 'workspace', label: 'Workspace id', placeholder: '1234567', required: true },
      { name: 'project', label: 'Project id', placeholder: 'optional', required: false },
    ],
    secret: 'API token',
    where: 'The API token is at the bottom of your Toggl profile. The ids are in the address of the workspace and the project.',
  },
  {
    destination: 'harvest',
    label: 'Harvest',
    fields: [
      { name: 'account', label: 'Account id', placeholder: '123456', required: true },
      { name: 'project', label: 'Project id', placeholder: '1234567', required: true },
      { name: 'task', label: 'Task id', placeholder: '1234567', required: true },
    ],
    secret: 'personal access token',
    where: 'Create a personal access token on the Harvest developers page. The account id is on the same page.',
  },
  {
    destination: 'clockify',
    label: 'Clockify',
    fields: [
      { name: 'workspace', label: 'Workspace id', placeholder: '24 characters, 0-9 and a-f', required: true },
      { name: 'project', label: 'Project id', placeholder: 'optional', required: false },
    ],
    secret: 'API key',
    where: 'Generate an API key in your Clockify profile settings. The ids are in the address of the workspace and the project.',
  },
  {
    destination: 'jira',
    label: 'Jira',
    fields: [
      { name: 'site', label: 'Site address', placeholder: 'https://your-site.atlassian.net', required: true },
      { name: 'email', label: 'Account email', placeholder: 'you@example.com', required: true },
    ],
    secret: 'API token',
    where: 'Create an API token for that email in your Atlassian account. Only a card made from a Jira issue is logged, on that issue.',
  },
];

/** One connection as the panel and an export read it. Never the token. */
export interface Exporter {
  destination: ExportDestination;
  label: string;
  settings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastExportAt: string | null;
  lastError: string | null;
}

/** What one export to one destination did. */
export interface ExportResult {
  // Entries this run posted.
  sent: number;
  // Entries an earlier run had already posted, so nothing was sent for them.
  already: number;
  // Of those, the ones whose minutes have changed since. A person fixes those by hand.
  changed: number;
  // Entries this run tried and could not send.
  failed: number;
  // Entries the destination can never take, such as a local card on a Jira export. Each row holds
  // the reason, and none of them counts as a failure.
  skipped: number;
  // Entries past `MAX_ATTEMPTS`, skipped with the sentence they last failed with.
  stuck: number;
  // Entries the run never reached, because it stopped on `MAX_FAILURES_PER_EXPORT`.
  left: number;
  // What the connection row now says, and null for a run that had nothing go wrong.
  error: string | null;
}

export interface ExportRequest {
  destination: ExportDestination;
  entries: TimesheetEntry[];
}

/** One stored entry, as the panel reads it back. */
export interface SentEntry {
  external_id: string;
  day: string;
  minutes: number;
  sent_at: string | null;
  remote_id: string | null;
  attempts: number;
  last_error: string | null;
}

/** One cell's state at the destination the panel draws. An entry is one card on one UTC day. */
export interface TimesheetSync {
  card: string;
  day: string;
  state: 'sent' | 'failed' | 'stuck' | 'changed' | 'skipped';
  // The destination's own words, and null for a state that has none of its own.
  reason: string | null;
}

interface ExporterRow {
  destination: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
  last_export_at: string | null;
  last_error: string | null;
}

const empty = (): ExportResult => ({ sent: 0, already: 0, changed: 0, failed: 0, skipped: 0, stuck: 0, left: 0, error: null });

const iso = (now: number): string => new Date(now).toISOString();

/**
 * The sentence with the token taken out of it.
 *
 * A destination that echoes the token back in its error text would otherwise put it on a row, in a
 * log line and on the screen. The destination's own words are what a person acts on, so the words
 * stay and the secret goes.
 */
export const hide = (text: string, secret: string): string => (secret === '' ? text : text.split(secret).join('…'));

/**
 * What one entry failed with: the destination's own words, without the token and cut to a length a
 * row can hold.
 *
 * The token comes out before the cut and not after it. A cut that lands inside the token leaves the
 * first half of it on the row and in the log line, because `hide` matches the whole secret.
 */
export function said(error: unknown, secret: string): string {
  const text = hide(error instanceof Error ? error.message.trim() : '', secret);
  if (text === '') return 'The destination refused the entry and said nothing about why.';
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

// A settings object written by an older version, or by hand, that is not an object of strings is
// read as nothing, and the adapter then names the setting that is missing.
function settingsOf(stored: string): Record<string, string> {
  try {
    const held: unknown = JSON.parse(stored);
    if (held === null || typeof held !== 'object' || Array.isArray(held)) return {};
    return Object.fromEntries(Object.entries(held).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value]] : [])));
  } catch {
    return {};
  }
}

const view = (row: ExporterRow): Exporter | null =>
  isExportDestination(row.destination)
    ? {
        destination: row.destination,
        label: DESTINATION_LABELS[row.destination],
        settings: settingsOf(row.settings_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastExportAt: row.last_export_at,
        lastError: row.last_error,
      }
    : null;

/** Every connection on this machine, in the order the forms list the destinations. */
export function exporters(db: DatabaseSync): Exporter[] {
  const rows = (db.prepare('SELECT * FROM exporters').all() as unknown as ExporterRow[]).flatMap((row) => view(row) ?? []);
  return EXPORT_DESTINATIONS.flatMap((destination) => rows.filter((row) => row.destination === destination));
}

export function exporter(db: DatabaseSync, destination: ExportDestination): Exporter | null {
  const row = db.prepare('SELECT * FROM exporters WHERE destination = ?').get(destination) as unknown as ExporterRow | undefined;
  return row === undefined ? null : view(row);
}

export interface ExporterInput {
  destination: ExportDestination;
  settings: Record<string, string>;
  // Null keeps the token the keychain holds, so a changed id does not ask for the token again.
  token: string | null;
}

/**
 * Stores one connection and its token, replacing what that destination held.
 *
 * The token is written first. A row with no token behind it is an export that fails on every entry,
 * and the keychain refuses before anything is stored. Its messages never repeat the secret.
 *
 * The sent entries are not touched, and a new workspace does not reopen them. A person who moves to
 * another workspace and exports March again is told every entry has gone, because the key is the
 * destination and not the workspace. Clearing the rows on a saved setting would let one corrected
 * field bill a whole week a second time.
 *
 * The entries that never went are dropped. A save is how a person fixes a revoked token or a wrong
 * id, and a stuck entry has no other way back. Every adapter looks for an entry before it posts, so
 * trying one again cannot bill it twice.
 */
export async function saveExporter(db: DatabaseSync, keychain: Keychain, input: ExporterInput, now: number): Promise<void> {
  const settings = JSON.stringify(input.settings);
  if (settings.length > MAX_SETTINGS_CHARS) throw new Error(`The settings of a connection may not be longer than ${MAX_SETTINGS_CHARS} characters.`);
  if (input.token !== null) await keychain.write(exporterSecretName(input.destination), input.token);
  db.prepare(
    `INSERT INTO exporters (destination, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (destination) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  ).run(input.destination, settings, iso(now), iso(now));
  db.prepare('DELETE FROM export_entries WHERE destination = ? AND sent_at IS NULL').run(input.destination);
}

/**
 * Drops one connection and the token behind it, and says whether there was a row.
 *
 * The token goes first, so a refused remove leaves no row without a token and no token without a row.
 * The sent entries stay: they are the record of what this project has already billed through that
 * destination, and dropping them would let the next connection post the same week again.
 */
export async function removeExporter(db: DatabaseSync, keychain: Keychain, destination: string): Promise<boolean> {
  // A name that is no destination would name some other keychain entry, such as a Scout token.
  if (!isExportDestination(destination)) return false;
  await keychain.remove(exporterSecretName(destination));
  return db.prepare('DELETE FROM exporters WHERE destination = ?').run(destination).changes > 0;
}

export interface ExporterAnswer {
  ok: boolean;
  // save or remove, so the panel prints the line that belongs to it.
  did: string;
  destination: string;
  message: string | null;
}

const asked = (form: FormData, name: string): string => (form.get(name)?.toString() ?? '').trim();

const failure = (error: unknown): string => (error instanceof Error ? error.message : 'The keychain refused.');

/**
 * Save or remove one connection from the panel's form.
 *
 * The token is read from its own field and goes to the keychain, and the settings are the form's own
 * fields and nothing else, so no field a page adds can put a token in the database. An empty token
 * field keeps the stored token on a connection that has one, and is refused on a new one.
 */
export async function postExporter(db: DatabaseSync, keychain: Keychain, form: FormData, now: number): Promise<ExporterAnswer> {
  const did = asked(form, 'do');
  const destination = asked(form, 'destination');
  const no = (message: string): ExporterAnswer => ({ ok: false, did, destination, message });
  const chosen = EXPORTER_FORMS.find((one) => one.destination === destination);
  if (chosen === undefined) return no(`Nolzu posts to Toggl, Harvest, Clockify and Jira, and this form names ${destination === '' ? 'none of them' : destination}.`);

  if (did === 'remove') {
    try {
      await removeExporter(db, keychain, chosen.destination);
    } catch (error) {
      return no(`Nothing was removed. ${failure(error)}`);
    }
    return { ok: true, did, destination, message: null };
  }
  if (did !== 'save') return no(`There is nothing called ${did} to do to a connection. This form can save a connection or remove it.`);

  const settings: Record<string, string> = {};
  for (const field of chosen.fields) {
    const value = asked(form, field.name);
    if (value === '' && field.required) return no(`A ${chosen.label} connection needs the ${field.label.toLowerCase()}.`);
    if (value !== '') settings[field.name] = value;
  }
  const token = asked(form, 'secret');
  if (token === '' && exporter(db, chosen.destination) === null) return no(`A ${chosen.label} connection needs its ${chosen.secret}.`);
  try {
    await saveExporter(db, keychain, { destination: chosen.destination, settings, token: token === '' ? null : token }, now);
  } catch (error) {
    return no(`The connection was not saved. ${failure(error)}`);
  }
  return { ok: true, did, destination, message: null };
}

/** What this connection has tried, for the days from and to, so the panel can mark each cell. */
export function sentEntries(db: DatabaseSync, destination: string, from: string, to: string): SentEntry[] {
  return db
    .prepare(
      `SELECT external_id, day, minutes, sent_at, remote_id, attempts, last_error FROM export_entries
        WHERE destination = ? AND day BETWEEN ? AND ? ORDER BY day, external_id`,
    )
    .all(destination, from, to) as unknown as SentEntry[];
}

/**
 * Runs one adapter under the timeout.
 *
 * The signal is handed over and the wait is raced against it, so an adapter that never passes the
 * signal to its `fetch` is stopped all the same. `AbortSignal.timeout` and not a timer of its own,
 * because its timer never keeps the process alive.
 */
function post(adapter: ExportAdapter, entry: TimesheetEntry, secret: string, settings: Record<string, unknown>, timeoutMs: number): Promise<string | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  const stopped = new Promise<never>((_, no) => signal.addEventListener('abort', () => no(new Error(EXPORT_TIMEOUT_SENTENCE)), { once: true }));
  return Promise.race([adapter(entry, secret, settings, signal), stopped]);
}

// What the connection row says after a run. `null` is a run that had nothing go wrong.
function recordExport(db: DatabaseSync, destination: string, error: string | null, now: number): void {
  db.prepare('UPDATE exporters SET last_export_at = ?, last_error = ?, updated_at = ? WHERE destination = ?').run(iso(now), error, iso(now), destination);
}

function heldEntry(db: DatabaseSync, destination: string, externalId: string): SentEntry | undefined {
  return db
    .prepare('SELECT external_id, day, minutes, sent_at, remote_id, attempts, last_error FROM export_entries WHERE destination = ? AND external_id = ?')
    .get(destination, externalId) as unknown as SentEntry | undefined;
}

function writeEntry(
  db: DatabaseSync,
  destination: string,
  entry: TimesheetEntry,
  write: { attempts: number; sentAt: string | null; remoteId: string | null; error: string | null; now: number },
): void {
  db.prepare(
    `INSERT INTO export_entries (destination, external_id, day, minutes, sent_at, remote_id, attempts, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (destination, external_id) DO UPDATE SET
       day = excluded.day, minutes = excluded.minutes, sent_at = excluded.sent_at, remote_id = excluded.remote_id,
       attempts = excluded.attempts, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).run(destination, entry.externalId, entry.day, entry.minutes, write.sentAt, write.remoteId, write.attempts, write.error, iso(write.now));
}

/**
 * Posts the entries of one week to one destination, and says what happened to each.
 *
 * The three failures that stop the whole run leave their sentence on the connection row and touch
 * no entry: no connection, no adapter for that destination, and no token this machine can read.
 * None of them is one entry's fault, and a person reads them in one place.
 *
 * The token is read from the keychain here and handed to the adapter, and what comes back out is a
 * count. The sentence a failure leaves goes through `hide` first, because the words are the
 * destination's own and one of them may be the token.
 *
 * `timeoutMs` is a parameter so a test can prove the race without waiting 20 seconds for it.
 */
export function exportEntries(
  db: DatabaseSync,
  keychain: Keychain,
  request: ExportRequest,
  now: number,
  adapters: ExportAdapters = EXPORT_ADAPTERS,
  timeoutMs: number = EXPORT_TIMEOUT_MS,
): Promise<ExportResult> {
  return queued(request.destination, () => oneExport(db, keychain, request, now, adapters, timeoutMs));
}

/**
 * One export at a time per destination.
 *
 * `node:sqlite` is synchronous, so while an export waits on a destination the server takes the next
 * request and a second press starts its own loop. The row that says an entry has gone is written
 * after the post, so both loops would read no row and post the same hours twice. A person who double
 * presses Export is exactly that pair. The second one waits here and then finds the rows the first
 * one wrote.
 *
 * Limit: a map in this process, not a lock in the database. The app is one process per data
 * folder, so this covers the case that happens. A second process on one folder would need a row lock.
 */
const running = new Map<string, Promise<unknown>>();

function queued<T>(key: string, work: () => Promise<T>): Promise<T> {
  // The previous run's answer is not read, and its failure is not this run's failure.
  const mine = (running.get(key) ?? Promise.resolve()).then(work, work);
  running.set(key, mine);
  const done = (): void => {
    if (running.get(key) === mine) running.delete(key);
  };
  mine.then(done, done);
  return mine;
}

async function oneExport(
  db: DatabaseSync,
  keychain: Keychain,
  request: ExportRequest,
  now: number,
  adapters: ExportAdapters,
  timeoutMs: number,
): Promise<ExportResult> {
  const { destination, entries } = request;
  const label = DESTINATION_LABELS[destination];
  const connection = exporter(db, destination);
  // Nothing to write on, so the sentence goes back to the caller alone.
  if (connection === null) return { ...empty(), left: entries.length, error: `There is no ${label} connection on this machine.` };

  const stopped = (error: string): ExportResult => {
    recordExport(db, destination, error, now);
    return { ...empty(), left: entries.length, error };
  };

  const adapter = adapters[destination];
  if (adapter === undefined) return stopped(`Nolzu does not post to ${label} yet.`);

  let secret: string | null;
  try {
    secret = await keychain.read(exporterSecretName(destination));
  } catch (error) {
    // The keychain's own sentence, which says the entry is missing or locked and never holds a secret.
    return stopped(said(error, ''));
  }
  if (secret === null) return stopped(`There is no ${label} token on this machine. Save the ${label} connection again with its ${formOf(destination).secret}.`);

  const result = await run(db, request, connection.settings, adapter, secret, now, timeoutMs);
  recordExport(db, destination, result.error, now);
  return result;
}

const formOf = (destination: ExportDestination): ExporterForm => EXPORTER_FORMS.find((one) => one.destination === destination) as ExporterForm;

// The loop. Nothing it returns holds the secret.
async function run(
  db: DatabaseSync,
  request: ExportRequest,
  settings: Record<string, unknown>,
  adapter: ExportAdapter,
  secret: string,
  now: number,
  timeoutMs: number,
): Promise<ExportResult> {
  const { destination, entries } = request;
  const result = empty();
  let inARow = 0;

  for (const [index, entry] of entries.entries()) {
    if (inARow >= MAX_FAILURES_PER_EXPORT) {
      result.left = entries.length - index;
      break;
    }
    const held = heldEntry(db, destination, entry.externalId);
    if (held?.sent_at != null) {
      result.already += 1;
      // The hours moved after they were billed. Nothing is sent: the second entry would be paid for
      // as well, and a sentence on the screen costs nobody anything.
      if (held.minutes !== entry.minutes) result.changed += 1;
      continue;
    }
    if (held !== undefined && held.attempts >= MAX_ATTEMPTS) {
      result.stuck += 1;
      result.error = held.last_error ?? result.error;
      continue;
    }

    const attempts = (held?.attempts ?? 0) + 1;
    try {
      const remoteId = await post(adapter, entry, secret, settings, timeoutMs);
      writeEntry(db, destination, entry, { attempts, sentAt: iso(now), remoteId, error: null, now });
      result.sent += 1;
      inARow = 0;
    } catch (error) {
      if (error instanceof ExportSkipped) {
        // No log line, and no attempt left on the row: nothing went wrong, and the row says why. A count
        // from an earlier failure would draw the skip as a failure that a later export tries again.
        writeEntry(db, destination, entry, { attempts: 0, sentAt: null, remoteId: null, error: said(error, secret), now });
        result.skipped += 1;
        continue;
      }
      const failure = said(error, secret);
      writeEntry(db, destination, entry, { attempts, sentAt: null, remoteId: null, error: failure, now });
      // The destination's own words, and the entry they are about. No token and no payload.
      console.error(`An export to ${destination} failed on one entry. ${failure}`);
      result.failed += 1;
      result.error = failure;
      inARow += 1;
    }
  }
  return result;
}

/**
 * The project id inside every external id, minted at the first export and kept from then on.
 *
 * Its own setting and not `projectId`, because other code reads that one as "registered with the
 * hub", and an export registers nothing. Not the project's name: the id is in every external id for
 * good, and a renamed folder would otherwise export its whole history a second time. Null with no
 * project folder, because an id minted then would belong to whatever folder comes later.
 */
export function exportProjectId(db: DatabaseSync): string | null {
  if (projectName(db) === null) return null;
  const stored = getSetting(db, 'exportProjectId');
  if (stored !== null) return stored;
  const id = randomUUID();
  writeSetting(db, 'exportProjectId', id);
  return id;
}

const count = (many: number, one: string, more: string): string => `${many} ${many === 1 ? one : more}`;

/** What one export did, in the words the panel prints under the Export button. */
export function exportSaid(label: string, result: ExportResult): string {
  // Entries left untried with no failure is a run that stopped before its first call: no token, or a
  // keychain that refused. The sentence says why, and the count of failures in a row would be false.
  if (result.left > 0 && result.failed === 0) return `${label}: nothing was sent. ${result.error ?? ''}`.trim();
  const lines = [result.sent === 0 ? `${label}: posted nothing new.` : `${label}: posted ${count(result.sent, 'entry', 'entries')}.`];
  if (result.already > 0) lines.push(`Skipped ${count(result.already, 'entry that was', 'entries that were')} sent before.`);
  if (result.changed > 0) {
    lines.push(`${count(result.changed, 'of them has', 'of them have')} other minutes now, and only you can fix that in ${label}.`);
  }
  if (result.skipped > 0) lines.push(`Skipped ${count(result.skipped, 'entry', 'entries')} that ${label} does not take.`);
  if (result.failed > 0) lines.push(`${count(result.failed, 'entry', 'entries')} failed, and the next press tries again.`);
  if (result.stuck > 0) {
    const one = result.stuck === 1;
    lines.push(
      `${count(result.stuck, 'entry', 'entries')} failed ${MAX_ATTEMPTS} times and ${one ? 'was' : 'were'} not tried again. Save the ${label} connection again and the next export tries ${one ? 'it' : 'them'}.`,
    );
  }
  if (result.left > 0) {
    lines.push(`${count(result.left, 'entry was', 'entries were')} not tried, because the export stopped after ${MAX_FAILURES_PER_EXPORT} failures in a row.`);
  }
  if (result.error !== null) lines.push(result.error);
  return lines.join(' ');
}

export interface WeekExport {
  ok: boolean;
  // One line per destination, or the one sentence the export was refused with.
  lines: string[];
}

/**
 * The Export button: the week on screen, posted once to every connection on this machine.
 *
 * One destination after the other and not side by side, so two trackers never share the timeout and
 * a person reads the lines in the order the forms list them.
 *
 * A cell with a run still going is held back. Its figure leaves that run out, and an entry that went
 * is never posted again, so the rest of that day could never be sent.
 */
export async function exportWeek(
  db: DatabaseSync,
  keychain: Keychain,
  sheet: Timesheet,
  now: number,
  adapters: ExportAdapters = EXPORT_ADAPTERS,
  timeoutMs: number = EXPORT_TIMEOUT_MS,
): Promise<WeekExport> {
  const connected = exporters(db);
  if (connected.length === 0) return { ok: false, lines: ['No time tracker is connected. Connect one below, then press Export.'] };
  const project = exportProjectId(db);
  if (project === null) return { ok: false, lines: ['This machine has no project folder, so there is no project to export hours for.'] };
  const going = new Set(sheet.rows.flatMap((row) => sheet.days.flatMap((day, index) => ((row.cells[index]?.running ?? 0) > 0 ? [`${row.key} ${day}`] : []))));
  const timed = timesheetEntries(sheet, project);
  const entries = timed.filter((entry) => !going.has(`${entry.card} ${entry.day}`));
  const waiting = timed.length - entries.length;
  const held =
    waiting === 0
      ? []
      : [`Held back ${count(waiting, 'entry', 'entries')} with a run still going, because the minutes are not final. Export again once nothing is running.`];
  if (timed.length === 0) return { ok: false, lines: ['This week has no timed runs, so there is nothing to send.'] };
  if (entries.length === 0) return { ok: false, lines: held };
  const lines: string[] = [];
  for (const one of connected) {
    lines.push(exportSaid(one.label, await exportEntries(db, keychain, { destination: one.destination, entries }, now, adapters, timeoutMs)));
  }
  return { ok: true, lines: [...lines, ...held] };
}

/**
 * The marks the panel draws for one destination on the week on screen.
 *
 * Read off the stored rows, matched to the cells by the external id the grid builds, so a mark sits
 * on the cell the entry came from. No project id yet means nothing was ever exported, and reading
 * one here would mint it on a page load.
 */
export function timesheetSync(db: DatabaseSync, sheet: Timesheet, destination: ExportDestination): TimesheetSync[] {
  const project = getSetting(db, 'exportProjectId');
  if (project === null) return [];
  const cells = new Map(timesheetEntries(sheet, project).map((entry) => [entry.externalId, entry]));
  return sentEntries(db, destination, sheet.days[0] ?? sheet.week, sheet.days[6] ?? sheet.week).flatMap((row): TimesheetSync[] => {
    const cell = cells.get(row.external_id);
    if (cell === undefined) return [];
    const at = { card: cell.card, day: cell.day };
    if (row.sent_at !== null) return [{ ...at, state: row.minutes === cell.minutes ? 'sent' : 'changed', reason: null }];
    if (row.attempts >= MAX_ATTEMPTS) return [{ ...at, state: 'stuck', reason: row.last_error }];
    // A skip leaves no attempt on its row, so a row with none and a sentence is one the destination
    // never takes.
    if (row.attempts === 0) return [{ ...at, state: 'skipped', reason: row.last_error }];
    return [{ ...at, state: 'failed', reason: row.last_error }];
  });
}
