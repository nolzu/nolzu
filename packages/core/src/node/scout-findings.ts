import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cardKeyOf, ticketRefProblem } from '@nolzu/protocol';
import { boardFor } from '../board.ts';
import type { ScoutGroup } from '../scout.ts';
import { ticketKeyOf } from '../scout-tickets.ts';
import { createCard, createLocalTicket } from './cards.ts';
import { addNotification } from './notifications.ts';
import { scoutSource } from './scout-sources.ts';
import { getSetting } from './settings-store.ts';

/** The four finding kinds. The kind of the finding, not of the source that found it. */
export type ScoutFindingKind = 'bug' | 'regression' | 'improvement' | 'insight';

/** The five open columns of the findings board, and the two collapsed ones. */
export type ScoutFindingStatus = 'new' | 'assess' | 'decide' | 'started' | 'done' | 'parked' | 'dismissed';

/**
 * One event Scout found, as the findings list and the finding detail read it.
 *
 * One row per event and never one per occurrence: `dedup` folds a fetch into the handful of events
 * behind it before anything reaches this module, so ten thousand pasted lines are a handful of rows
 * and the two messages below are the evidence. They hold the lines as they were pasted, so whatever a
 * person pasted is in the database: a log pasted with a token in it keeps that token here.
 */
export interface ScoutFinding {
  id: number;
  sourceId: number;
  fingerprint: string;
  kind: ScoutFindingKind;
  status: ScoutFindingStatus;
  // Over every check this finding was met in, not in the last one.
  occurrences: number;
  // Set once, when the event opened the row, and never moved after that.
  firstSeen: string;
  lastSeen: string;
  // The line as it was pasted, for the first occurrence and for the newest one. They differ wherever
  // the numbers or the ids in the two occurrences differ, which is the point of keeping both.
  firstMessage: string;
  lastMessage: string;
  // Empty where the source names no place, and pasted text names none.
  location: string;
  cardKey: string | null;
  // The ticket this finding is about, for a finding a ticket query found, and null for every other
  // one. It is the key the card takes when a person starts it, or its last part where it still holds
  // a path.
  externalKey: string | null;
}

interface Row {
  id: number;
  source_id: number;
  fingerprint: string;
  kind: string;
  status: string;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  first_message: string;
  last_message: string;
  location: string;
  card_key: string | null;
  external_key: string | null;
}

// Both columns carry a CHECK, and sqlite cannot widen one, so a row can only hold words this
// version knows. That is why neither needs the guard the source kind has.
const read = (row: Row): ScoutFinding => ({
  id: row.id,
  sourceId: row.source_id,
  fingerprint: row.fingerprint,
  kind: row.kind as ScoutFindingKind,
  status: row.status as ScoutFindingStatus,
  occurrences: row.occurrences,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
  firstMessage: row.first_message,
  lastMessage: row.last_message,
  location: row.location,
  cardKey: row.card_key,
  externalKey: row.external_key,
});

// The clock the run rows use, so every stamp in the file comes from sqlite and a check needs no
// injected time.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ')";

/** What one save changed, which is what a screen says after a check. */
export interface ScoutFindingChange {
  // Events met for the first time, so one row each was opened.
  added: number;
  // Events already on the board, so a count grew and no row was added.
  met: number;
  // Events whose finding is dismissed, so no column of it was written. Its own number, because
  // counting them as met would tell a person a list changed when nothing on it did.
  muted: number;
}

/**
 * The groups of one fetch, written onto the findings of one source.
 *
 * The same fingerprint updates the one finding it already has, adding what this fetch counted and
 * moving the last seen time, because Scout keeps one finding per event and not
 * one per check. `first_seen` and `first_message` are left where the first check put them: they are
 * how the detail says how long the problem has been going on.
 *
 * A dismissed finding is skipped whole. Both lists order by `last_seen`, so moving that column would
 * put the muted finding back at the top of the screen, which is the one thing a mute has to stop.
 */
/**
 * The most occurrences one save may add, and the most a row may hold.
 *
 * The column is read back as a JavaScript number, and a value past 2^53 makes `node:sqlite` throw on
 * the READ, after the write has landed. One such row takes every read of this table with it, so the
 * screen a person would use to delete the row is the screen that stops opening. A hub job carrying
 * `Number.MAX_SAFE_INTEGER` proved that before these two caps existed.
 *
 * A trillion, which no real source reaches: five hundred lines every quarter of an hour is seventeen
 * million a year, so this is twenty thousand years of the widest source.
 *
 * TWO CAPS AND NOT ONE, and the second is double the first on purpose. A row this save opened holds
 * exactly what the save added, which is how the count below tells an opened row from a met one. With
 * one cap a met row already at it would hold exactly the added value too, and every capped finding
 * would report as new on every check. Because a row holds at least one occurrence, a sum capped at
 * twice the addition is always larger than the addition, so that test stays sound. Both are far
 * enough below 2^53 that the sum is exact.
 */
const MAX_ADDED = 1_000_000_000_000;
const MAX_OCCURRENCES = MAX_ADDED * 2;

export function saveScoutFindings(db: DatabaseSync, sourceId: number, groups: readonly ScoutGroup[]): ScoutFindingChange {
  // One statement, so two checks of one source at the same moment cannot both miss a read and then
  // collide on the unique pair. The location moves with the message, because a source that keys on its
  // own id, such as Sentry or a ticket system, can move one issue to another place and it stays one
  // finding. Sentry moves an issue's culprit when the code moves, and a finding left on the old place
  // would send a person to code that is not there any more. Where the fingerprint is a hash instead,
  // the location is part of that hash, so this writes the same string back.
  const write = db.prepare(
    `INSERT INTO scout_findings (source_id, fingerprint, occurrences, first_seen, last_seen, first_message, last_message, location, external_key)
     VALUES (?, ?, ?, ${NOW}, ${NOW}, ?, ?, ?, ?)
     ON CONFLICT (source_id, fingerprint) DO UPDATE SET
       -- Capped, because the sum is read back as a JavaScript number and node:sqlite throws a
       -- RangeError on one past 2^53. That throw is not recoverable by a person: the row is already
       -- written, and every later read of this table raises it, which takes the whole findings screen
       -- down and with it the Dismiss and Unmute buttons that would have removed the row. An adapter
       -- that reports a wrong count is a bug worth a wrong number on a screen and never worth that.
       occurrences = min(occurrences + excluded.occurrences, ${MAX_OCCURRENCES}),
       last_seen = excluded.last_seen,
       last_message = excluded.last_message,
       location = excluded.location,
       -- coalesce and not the new value alone, so a row written before the column was there picks its
       -- ticket up on the next check. Nothing reaches the null side today: a ticket's fingerprint is
       -- built from its key, so a row cannot be met by an item carrying no key.
       external_key = coalesce(excluded.external_key, external_key)
       WHERE status <> 'dismissed'
     RETURNING occurrences`,
  );

  const change: ScoutFindingChange = { added: 0, met: 0, muted: 0 };
  for (const group of groups) {
    // The raw line, not the normalized one. The normalized form is what the fingerprint is built
    // from and a screen can work it out again, while the numbers and the ids in the real line are
    // the evidence a person copies into a bug report and they are nowhere else.
    // Capped the same way the sum above is, so a new row and the comparison below agree on what was
    // stored. Clamping and not refusing: a count too large to hold is still a real event, and losing
    // the finding whole would hide it.
    const count = Math.min(Math.max(Math.trunc(group.count), 0), MAX_ADDED);
    const after = write.get(
      sourceId,
      group.fingerprint,
      count,
      group.first.message,
      group.last.message,
      group.last.location,
      ticketKeyOf(group.last),
    ) as unknown as { occurrences: number } | undefined;
    // Nothing comes back when the WHERE above refuses the update, which is the dismissed row, and
    // then every column of it is as it was. The condition sits on the whole update on purpose: a
    // dismissed finding may not move its count either, so there is nothing to write by halves.
    if (after === undefined) change.muted += 1;
    // A row this save opened holds exactly what this fetch counted. One it met already held at least
    // one occurrence before, so the sum is larger.
    else if (after.occurrences === count) change.added += 1;
    else change.met += 1;
  }
  // Kept for the bell as well as the toast, so a find while the person was away is still there. Each
  // save is its own event, so its key is new each time.
  if (change.added > 0) {
    const label = scoutSource(db, sourceId)?.label;
    const text = `Scout: ${change.added} new ${change.added === 1 ? 'finding' : 'findings'}${label === undefined ? '' : ` from ${label}`}`;
    addNotification(db, { id: `scout:${sourceId}:${randomUUID()}`, kind: 'info', text, href: '/scout' });
  }
  return change;
}

// Last met first, because that is the order a person reads the list in after pressing Check now.
export function scoutFindings(db: DatabaseSync, sourceId: number): ScoutFinding[] {
  return (db.prepare('SELECT * FROM scout_findings WHERE source_id = ? ORDER BY last_seen DESC, id DESC').all(sourceId) as unknown as Row[]).map(read);
}

// Every source in one list, for the findings screen, which shows what was met last and not which
// source met it. The order is here and not in the screen, so the two readers cannot disagree.
export function allScoutFindings(db: DatabaseSync): ScoutFinding[] {
  return (db.prepare('SELECT * FROM scout_findings ORDER BY last_seen DESC, id DESC').all() as unknown as Row[]).map(read);
}

export function scoutFinding(db: DatabaseSync, id: number): ScoutFinding | null {
  const row = db.prepare('SELECT * FROM scout_findings WHERE id = ?').get(id) as unknown as Row | undefined;
  return row === undefined ? null : read(row);
}

/**
 * The finding one source holds under one fingerprint, or null when it holds none.
 *
 * The pair is the table's unique key, so this answers one row and reads the index that key made. It
 * is how a caller that has just saved a group learns the id of the row the save opened or met:
 * `saveScoutFindings` counts what changed and a count names no row.
 */
export function scoutFindingOf(db: DatabaseSync, sourceId: number, fingerprint: string): ScoutFinding | null {
  const row = db
    .prepare('SELECT * FROM scout_findings WHERE source_id = ? AND fingerprint = ?')
    .get(sourceId, fingerprint) as unknown as Row | undefined;
  return row === undefined ? null : read(row);
}

/**
 * One finding muted, which is the mute itself and no second table: the row is already unique on
 * `(source_id, fingerprint)`, and that pair is what a mute applies to.
 *
 * False for an id that is not there and for one that is dismissed already, so a screen answers a
 * sentence instead of claiming a change nothing made.
 *
 * Limit: no reason and no muted_at. Both are columns, so both cost a migration, and the row
 * already says when the finding was last seen. They arrive with the migration that adds them.
 */
export function dismissScoutFinding(db: DatabaseSync, id: number): boolean {
  return db.prepare("UPDATE scout_findings SET status = 'dismissed' WHERE id = ? AND status <> 'dismissed'").run(id).changes > 0;
}

/**
 * A muted finding back on the list, with the count and the first seen time it went away with.
 *
 * Only the word moves. Those two numbers are still true, so the finding comes back saying how often
 * it has been seen and since when, and the next check adds to what it kept.
 *
 * It comes back as `started` where it already has a card key, and as `new` otherwise. `new` for both
 * threw away the one column that says a finding is on a board: the row then read New beside a live
 * card, and Assess was offered on work somebody had already started. A key whose card was deleted
 * still reads `started`, which is the column Start is offered from again.
 */
export function unmuteScoutFinding(db: DatabaseSync, id: number): boolean {
  return db.prepare("UPDATE scout_findings SET status = CASE WHEN card_key IS NULL THEN 'new' ELSE 'started' END WHERE id = ? AND status = 'dismissed'").run(id).changes > 0;
}

/**
 * One finding moved to the assessment column, which is what starting an assessment writes.
 *
 * Only from `new`, so a dismissed finding is not brought back by a button on the list and a finding
 * already in assessment does not move twice. False in both cases, the way dismiss and unmute answer,
 * so the screen says a sentence instead of claiming a change nothing made.
 *
 * The assessment itself is a file in the run's own folder and no column here: every phase writes its
 * artifact there, the run row already carries the state, the cost and the log path, and a column
 * costs an appended migration. The status word is all the board needs to draw the finding in the
 * right column.
 */
export function assessScoutFinding(db: DatabaseSync, id: number): boolean {
  return db.prepare("UPDATE scout_findings SET status = 'assess' WHERE id = ? AND status = 'new'").run(id).changes > 0;
}

/**
 * The columns a finding can be started from.
 *
 * `done` is finished and `dismissed` is muted, so neither starts. `started` is in the list because a
 * card can be deleted: the finding then names a key the board does not answer, and without this it
 * would sit on that key for good. A finding whose card is still there is refused by the card check
 * below, not by this list.
 */
const CAN_START: readonly ScoutFindingStatus[] = ['new', 'assess', 'decide', 'parked', 'started'];

/**
 * Whether Start would be accepted, so a screen offers the button exactly where the writer takes it.
 *
 * The writer asks the status half of this too. Two copies of that list would let a button appear
 * where the answer is a refusal, which is the one thing a button must not do. The card half is the
 * writer's own line, because it has a sentence naming the card and this answers only true or false.
 */
export const canStartFinding = (status: ScoutFindingStatus, hasCard: boolean): boolean => !hasCard && CAN_START.includes(status);

/**
 * What one Start did: the card it made, or the reason there is none.
 *
 * `alreadyOnBoard` is set where the card was there before the button was pressed, which only a
 * ticket can be. The finding then points at that card and no second one is written, so the sentence
 * the screen prints may not say a card was made.
 */
export type ScoutStart = { ok: true; key: string; alreadyOnBoard?: boolean } | { ok: false; message: string };

/**
 * The boards a finding can be started on.
 *
 * The two the Scout screen offers, and not every word of `BoardKind`: a finding is work to do or a
 * thing to look into. Epics, Questions and PR reviews are none of those, and a button that made an
 * Epic from a log line would need its own screen to say why.
 */
export type ScoutStartBoard = 'delivery' | 'investigations';

/**
 * How much of the collected line the card carries.
 *
 * One pasted line can be fifty thousand characters. The card is a ticket a person reads and an agent
 * is handed, not the evidence store, and every character stays on the finding's own page, so the
 * card takes the head of the line and says where the rest is.
 */
const LINE_CAP = 2_000;

/**
 * What the card says about the finding it was made from.
 *
 * The newest line and not both of them: the first line seen, the times and the count are on the
 * finding's page, and a card that copied the whole page would be a second place to keep it up to
 * date. The newest line is here because it is the one thing the work needs in front of it, on the
 * card page and in the prompt of whatever run the card starts later.
 *
 * The line goes in the body and never in the title. A title reaches a branch name, and `slugify`
 * keeps the letters and the digits of whatever it is handed, so a token in a collected line would
 * become part of a name that is pushed to a remote and cannot be taken back.
 *
 * The body is not free of it. The summary is what the prompt of a later run carries, so a token in
 * the line is in front of the engine. That is the exposure the pasted line already has, on the
 * finding's own page and in sqlite, and the person pasting it chose it. A card a run is handed
 * without the line it is about would send that run to read the finding instead.
 */
function cardBody(one: ScoutFinding): string {
  const line = one.lastMessage.length > LINE_CAP ? `${one.lastMessage.slice(0, LINE_CAP)}\n[The line is cut here. Finding ${one.id} has all of it.]` : one.lastMessage;
  const parts = ['Scout found this, and a person started it from the Scout screen.', 'The newest line it was seen on:', line];
  if (one.location !== '') parts.push(`Where it happens: ${one.location}`);
  // Two branches, because "Seen 1 times" is not English.
  parts.push(one.occurrences === 1 ? 'Seen once.' : `Seen ${one.occurrences} times.`);
  parts.push(`Finding ${one.id} on the Scout screen keeps the whole evidence: the first line seen, the newest one and the times.`);
  return parts.join('\n\n');
}

/**
 * One finding accepted, as a card on the board that was asked for.
 *
 * One writer for both buttons, with the board as its argument. Start as Delivery and Start as
 * Investigation differ in that one word, so a second writer would be a copy of this one.
 *
 * The card and the two columns of the finding move in one transaction, so the board never holds a
 * card whose finding still reads `new`, and a finding never points at a card that was not written.
 *
 * No run starts. The card lands in the board's first column and waits there like every other card,
 * which is what keeps this a person's decision.
 *
 * The key is the project's own ticket key, the same counter the Add card dialog draws from. It is
 * one plain name, so the card gets a card folder, it is unique because the counter skips a number
 * another card already holds, and a person reads `APP-7` on the board rather than a shape only this
 * screen writes.
 *
 * A finding a ticket query found is the one exception. It keeps the ticket's own key, because the
 * card is that ticket, and where the ticket is already on the board the finding points at the card
 * that is there. Both are what stops one Jira ticket becoming two cards.
 */
export function startScoutFinding(db: DatabaseSync, id: number, board: ScoutStartBoard = 'delivery'): ScoutStart {
  db.exec('BEGIN IMMEDIATE');
  const refuse = (message: string): ScoutStart => {
    db.exec('ROLLBACK');
    return { ok: false, message };
  };
  try {
    // Read under the write lock, so the same finding started in two windows cannot make two cards.
    const one = scoutFinding(db, id);
    if (one === null) return refuse(`There is no finding ${id} on this machine. It may have gone with the source that found it.`);
    // The card row and not the column alone. A key with no card behind it is a card somebody deleted,
    // and the finding is then free to start again.
    const hasCard = one.cardKey !== null && db.prepare('SELECT key FROM cards WHERE key = ?').get(one.cardKey) !== undefined;
    if (hasCard) return refuse(`Finding ${id} is already on the board as ${one.cardKey}. Open that card instead of making a second one.`);
    // `false` and not `hasCard`: the line above returned on every finding that has one, so the card
    // half of the rule is answered already, with a sentence this one cannot give.
    if (!canStartFinding(one.status, false)) {
      return refuse(
        one.status === 'dismissed'
          ? `Finding ${id} is muted, so nothing is started from it. Unmute it first, then start it.`
          : `Finding ${id} is done, so there is nothing to start. Its work is over.`,
      );
    }

    const source = scoutSource(db, one.sourceId);
    const label = source?.label ?? '';
    // The board's own first column, read the way the Add card dialog reads it. Writing `inbox` out
    // here is how the two would drift apart.
    const stage = boardFor(board, getSetting(db, 'deliveryFlow')).stages[0]?.id ?? 'inbox';

    // A finding a ticket query found is a ticket, so its card is that ticket and carries its key.
    // A new local key here put the same Jira ticket on the board twice, once under `PROJ-123` from
    // the Add card dialog and once under `APP-7` from this button.
    const ticket = one.externalKey;
    if (ticket !== null) {
      // A GitHub or a GitLab ticket is keyed `app#42` with no owner or group, and its source names the
      // path, so the card keeps the full reference as its ref, the way Add card keeps it. A key that
      // still holds the path, from before the key changed, is cut to its last part here, so the card
      // can run. Another system's key is its full name already.
      // Limit: the path is the source's setting now, not the one at the check, because the finding
      // keeps only app#42. A source moved to another owner between the check and Start gets the new
      // owner. Keep the full name on the finding at the check if that ever matters.
      const key = cardKeyOf(ticket);
      const config = source?.config;
      const path = config?.system === 'github' ? config.repo : config?.system === 'gitlab' ? config.project : undefined;
      const owner = /^(.+)\/[^/]+$/.exec(path ?? '')?.[1];
      const ref = key !== ticket || owner === undefined ? ticket : `${owner.toLowerCase()}/${ticket}`;
      const held = db.prepare('SELECT source_ref FROM cards WHERE key = ?').get(key) as { source_ref: string | null } | undefined;
      const problem = ticketRefProblem(ticket);
      const badKey = `Finding ${id} is a ticket whose key cannot be a card key, so no card was made. ${problem}`;
      // Two owners' repositories or two groups' projects of one name share the key. The card that is
      // there stays, and this finding does not point at somebody else's issue. A bad reference gets the
      // shape sentence instead. The other one prints the reference, and a bad one can hold a whole
      // pasted line.
      if (held !== undefined && held.source_ref !== null && held.source_ref !== ref) {
        return refuse(
          problem !== null ? badKey : `Finding ${id} is ${ref}, and ${key} on the board is ${held.source_ref}. A card key carries no owner or group, so no card was made.`,
        );
      }
      const already = held !== undefined;
      // The card is left alone where it is already there. Whoever put it on the board wrote its
      // title and its column, and the finding only has to point at it.
      if (!already) {
        // The key was copied out of a ticket system's answer. A key the card writer refuses is
        // refused here, as a sentence naming the finding, the way every other refusal on this screen
        // reads. Never repaired: a key that system does not know puts a second card on the board at
        // the next check.
        //
        // Asked only where a card has to be written. A version before this check could put such a
        // key on the board, and a second finding for that ticket only points at the card that is
        // there. Refusing that one would leave the finding stuck on a key whose card it can see.
        if (problem !== null) return refuse(badKey);
        createCard(db, {
          key,
          board,
          stage,
          // The ticket's own title, which is what this finding's newest line holds for a ticket. The
          // made-up title below is for a collected log line, and a board full of "Scout finding 3"
          // beside tickets a person added by hand reads as two kinds of card for one kind of work.
          title: one.lastMessage,
          summary: cardBody(one),
          // A Jira source's ticket is a Jira card, which is what the Jira worklog export logs. Any
          // other system gets the word Add card writes for a ticket it could not read.
          source: config?.system === 'jira' ? 'jira' : 'external',
          sourceRef: ref,
        });
      }
      db.prepare("UPDATE scout_findings SET card_key = ?, status = 'started' WHERE id = ?").run(key, id);
      db.exec('COMMIT');
      return already ? { ok: true, key, alreadyOnBoard: true } : { ok: true, key };
    }

    const { key } = createLocalTicket(db, {
      projectId: 1,
      prefix: getSetting(db, 'localKeyPrefix'),
      // The finding id and the source label, both short and both written by this app or typed by the
      // person. Never the collected line, for the reason cardBody gives.
      title: label === '' ? `Scout finding ${id}` : `Scout finding ${id}, from ${label}`,
      description: cardBody(one),
      board,
      stage,
    });
    // Both columns, in the same transaction as the card. A card with the finding still reading `new`
    // would offer Start again and make a second card for one problem.
    db.prepare("UPDATE scout_findings SET card_key = ?, status = 'started' WHERE id = ?").run(key, id);
    db.exec('COMMIT');
    return { ok: true, key };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
