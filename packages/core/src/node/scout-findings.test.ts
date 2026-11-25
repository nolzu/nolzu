import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dedup, type ScoutItem } from '../scout.ts';
import { createCard } from './cards.ts';
import { openDatabase } from './db.ts';
import { notifications } from './notifications.ts';
import { allScoutFindings, assessScoutFinding, canStartFinding, dismissScoutFinding, saveScoutFindings, scoutFinding, scoutFindings, startScoutFinding, unmuteScoutFinding } from './scout-findings.ts';
import { addScoutSource } from './scout-sources.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-findings-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const source = (label = 'Pasted by hand') => addScoutSource(db, { kind: 'paste', label });

const item = (message: string, over: Partial<ScoutItem> = {}): ScoutItem => ({ sourceKind: 'paste', errorType: '', message, location: '', ...over });

// Three occurrences of one event, told apart only by the numbers `normalize` takes out.
const timeouts = [
  item('Timeout after 5000ms calling /api/recipes', { location: 'api/recipes.ts:20' }),
  item('Timeout after 7000ms calling /api/recipes', { location: 'api/recipes.ts:20' }),
  item('Timeout after 9000ms calling /api/recipes', { location: 'api/recipes.ts:20' }),
];

const old = '2020-01-01T00:00:00.000Z';

/**
 * A source that keys on its own id keeps the place current.
 *
 * Sentry and the ticket adapters put their own id in the fingerprint, so the location is not part of
 * it, and Sentry moves an issue's culprit when the code behind the events moves. A finding left on the
 * first place would print the old route beside an up to date message and send a person to code that is
 * no longer there.
 */
it('moves the location of a finding keyed on the source own id', () => {
  const id = source();
  const at = (location: string, message: string) => dedup([item(message, { location, sourceId: '4501' })]);

  saveScoutFindings(db, id, at('GET /recipes/{id}', 'TypeError in the recipe reader'));

  expect(saveScoutFindings(db, id, at('GET /recipes/{id}/steps', 'TypeError in the step reader'))).toEqual({ added: 0, met: 1, muted: 0 });
  expect(scoutFindings(db, id)[0]).toMatchObject({ location: 'GET /recipes/{id}/steps', lastMessage: 'TypeError in the step reader', occurrences: 2 });
});

it('writes one row per event, with the count that fetch carried', () => {
  const id = source();

  expect(saveScoutFindings(db, id, dedup(timeouts))).toEqual({ added: 1, met: 0, muted: 0 });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    sourceId: id,
    // A new finding is a bug in the New column until somebody says otherwise.
    kind: 'bug',
    status: 'new',
    occurrences: 3,
    // The lines as they were pasted, so the first and the newest keep their own numbers. The
    // fingerprint read past those numbers, which is why the three are one finding.
    firstMessage: 'Timeout after 5000ms calling /api/recipes',
    lastMessage: 'Timeout after 9000ms calling /api/recipes',
    location: 'api/recipes.ts:20',
    cardKey: null,
  });
  // The one copy of the timestamp format that no other test covers. A stamp in another shape would
  // sort against the rest of the database in the wrong order.
  expect(findings[0]?.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(findings[0]?.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

it('makes a row each for two different events in one fetch', () => {
  const id = source();

  expect(saveScoutFindings(db, id, dedup([...timeouts, item('Cannot read property name of undefined')]))).toEqual({ added: 2, met: 0, muted: 0 });

  expect(
    scoutFindings(db, id)
      .map((one) => one.occurrences)
      .sort((a, b) => a - b),
  ).toEqual([1, 3]);
});

it('keeps one notification per save that found something new, and none for a met event', () => {
  const id = source('Recipe errors');

  saveScoutFindings(db, id, dedup([...timeouts, item('Cannot read property name of undefined')]));
  saveScoutFindings(db, id, dedup(timeouts));

  expect(notifications(db).map((one) => [one.kind, one.text, one.href])).toEqual([['info', 'Scout: 2 new findings from Recipe errors', '/scout']]);
});

/**
 * The rule: the same fingerprint updates one finding.
 *
 * The stamps are pushed back to an old date first, because sqlite's clock counts milliseconds and
 * two saves in one test can land in the same one. Moved and not moved is then an assertion.
 */
it('adds to the count and moves last seen, and leaves first seen and the row count alone', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  db.exec(`UPDATE scout_findings SET first_seen = '${old}', last_seen = '${old}'`);

  expect(saveScoutFindings(db, id, dedup(timeouts))).toEqual({ added: 0, met: 1, muted: 0 });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.occurrences).toBe(6);
  expect(findings[0]?.firstSeen).toBe(old);
  expect(findings[0]?.lastSeen).not.toBe(old);
});

/**
 * The two message columns, which can only be told apart by a fixture whose occurrences differ.
 *
 * `Request 4000 failed` and `Request 2a3f failed` normalize to different strings, `<n>` against
 * `<id>`, and the fingerprint folds both tokens to one, so they are one event with two lines. Swap
 * the two arguments of the write and this is the test that notices.
 */
it('keeps the first line and moves the newest one', () => {
  const id = source();
  saveScoutFindings(db, id, dedup([item('Request 4000 failed')]));

  expect(saveScoutFindings(db, id, dedup([item('Request 2a3f failed')]))).toEqual({ added: 0, met: 1, muted: 0 });

  const [only] = scoutFindings(db, id);
  expect(only?.firstMessage).toBe('Request 4000 failed');
  expect(only?.lastMessage).toBe('Request 2a3f failed');
  expect(only?.occurrences).toBe(2);
});

// 13: the order the list is read in, without sorting the result in the test.
it('reads the findings with the one met last at the top', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  db.exec(`UPDATE scout_findings SET last_seen = '${old}'`);
  saveScoutFindings(db, id, dedup([item('Cannot read property name of undefined')]));

  expect(scoutFindings(db, id).map((one) => one.firstMessage)).toEqual(['Cannot read property name of undefined', 'Timeout after 5000ms calling /api/recipes']);
});

// Two places with the same problem are two things to fix, so the unique pair is per source.
it('gives each source its own finding when both see the same line', () => {
  const first = source('Pasted by hand');
  const second = source('Pasted from the other log');
  const groups = dedup(timeouts);

  saveScoutFindings(db, first, groups);
  saveScoutFindings(db, second, groups);

  const one = scoutFindings(db, first);
  const other = scoutFindings(db, second);
  expect([one.length, other.length]).toEqual([1, 1]);
  expect(one[0]?.fingerprint).toBe(other[0]?.fingerprint);
  expect(one[0]?.id).not.toBe(other[0]?.id);
});

it('refuses the same event twice on one source', () => {
  const id = source();
  const groups = dedup(timeouts);
  saveScoutFindings(db, id, groups);

  const write = db.prepare('INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message) VALUES (?, ?, ?, ?, ?, ?)');
  expect(() => write.run(id, groups[0]?.fingerprint ?? '', old, old, 'Timeout', 'Timeout')).toThrow(/UNIQUE/);
});

// The cascade of migration 10, and no application code: a finding whose source is gone can never be
// checked again. The delete is written in SQL here on purpose, so nothing in this package can be
// what cleaned up. The first source's finding is muted first, because a mute is a word on the finding
// row and it has to go with the source too, or a removed source leaves a muted row no screen reaches.
it('takes the findings of a source away with the source, muted ones too', () => {
  const first = source('Pasted by hand');
  const second = source('Pasted from the other log');
  saveScoutFindings(db, first, dedup(timeouts));
  saveScoutFindings(db, second, dedup(timeouts));
  dismissScoutFinding(db, scoutFindings(db, first)[0]?.id ?? 0);

  db.prepare('DELETE FROM scout_sources WHERE id = ?').run(first);

  expect(scoutFindings(db, first)).toEqual([]);
  expect(allScoutFindings(db).map((one) => one.sourceId)).toEqual([second]);
});

// The findings screen shows every source in one list, so the order has to hold across sources. Per
// source it already does, which is why this reads two of them.
it('reads every source in one list, last met first', () => {
  const first = source('Pasted by hand');
  const second = source('Pasted from the other log');
  saveScoutFindings(db, first, dedup(timeouts));
  saveScoutFindings(db, second, dedup([item('Out of memory in the recipe worker')]));

  const all = allScoutFindings(db);

  expect(all.map((one) => one.lastMessage)).toEqual(['Out of memory in the recipe worker', 'Timeout after 9000ms calling /api/recipes']);
  expect(allScoutFindings(db).map((one) => one.sourceId)).toEqual([second, first]);
});

// Every other ordering test here would also pass on `ORDER BY id DESC`, because the row written last
// has the newer id as well as the newer stamp. This one sets the two against each other, so what holds
// the list together is the column the heading names.
it('reads the one seen last first even when it is the older row', () => {
  const first = source('Pasted by hand');
  const second = source('Pasted from the other log');
  saveScoutFindings(db, first, dedup(timeouts));
  saveScoutFindings(db, second, dedup([item('Out of memory in the recipe worker')]));

  // By hand, because sqlite's clock counts milliseconds and both saves can land in the same one.
  db.prepare('UPDATE scout_findings SET last_seen = ? WHERE source_id = ?').run('2031-01-01T00:00:00.000Z', first);

  expect(allScoutFindings(db).map((one) => one.sourceId)).toEqual([first, second]);
});

// The stamp counts milliseconds, so every finding one check opens carries the same `last_seen` and the
// id is the only thing left to tell them apart. Both lists have to break that tie the same way, or the
// newest event of a paste sits at the bottom of a list whose heading says last met first.
it('puts the newest event of one check at the top, in both lists', () => {
  const id = source();
  saveScoutFindings(db, id, dedup([...timeouts, item('Cannot read property name of undefined')]));
  // By hand, so the tie is what this test measures and not how fast the two writes landed.
  db.exec(`UPDATE scout_findings SET last_seen = '${old}'`);

  const newestFirst = ['Cannot read property name of undefined', 'Timeout after 5000ms calling /api/recipes'];
  expect(scoutFindings(db, id).map((one) => one.firstMessage)).toEqual(newestFirst);
  expect(allScoutFindings(db).map((one) => one.firstMessage)).toEqual(newestFirst);
});

it('reads no finding at all on a fresh database', () => {
  expect(allScoutFindings(db)).toEqual([]);
});

it('reads one finding by id, and nothing for one that is not there', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const [only] = scoutFindings(db, id);

  expect(scoutFinding(db, only?.id ?? 0)).toEqual(only);
  expect(scoutFinding(db, 404)).toBeNull();
});

// All seven board columns are in the check, and an eighth word is refused. sqlite cannot widen a
// CHECK, so a word left out today costs a table rebuild the day it is needed.
it('takes all seven board statuses and refuses an eighth word', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const status = db.prepare('UPDATE scout_findings SET status = ? WHERE source_id = ?');

  for (const word of ['new', 'assess', 'decide', 'started', 'done', 'parked', 'dismissed']) status.run(word, id);
  expect(() => status.run('archived', id)).toThrow(/CHECK/);
  expect(() => db.prepare('UPDATE scout_findings SET kind = ? WHERE source_id = ?').run('question', id)).toThrow(/CHECK/);
});

/**
 * The heart of a mute: a dismissed row is not written at all.
 *
 * Not the count and above all not `last_seen`. Both list readers order by that column, so a bump
 * there would put the muted finding straight back on top of the screen, which is what a mute is
 * there to stop. The stamps are pushed back first, so moved and not moved is an assertion.
 */
it('writes nothing at all to a dismissed finding that is met again', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const [only] = scoutFindings(db, id);
  expect(dismissScoutFinding(db, only?.id ?? 0)).toBe(true);
  db.exec(`UPDATE scout_findings SET first_seen = '${old}', last_seen = '${old}'`);

  expect(saveScoutFindings(db, id, dedup(timeouts))).toEqual({ added: 0, met: 0, muted: 1 });

  expect(scoutFindings(db, id)).toEqual([{ ...only, status: 'dismissed', firstSeen: old, lastSeen: old }]);
});

// The word and nothing else. The count and the first seen time are still true, so the finding comes
// back saying how often it has been seen and since when.
it('brings a muted finding back with the count and the first seen time it had', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const [only] = scoutFindings(db, id);
  dismissScoutFinding(db, only?.id ?? 0);

  expect(unmuteScoutFinding(db, only?.id ?? 0)).toBe(true);

  expect(scoutFindings(db, id)).toEqual([only]);
});

// A mute is a row, and the row is per source, so one source's mute cannot silence another's finding.
// That is the ceiling of the design and the reason no second table is needed.
it('leaves the other source alone when the same line is dismissed on one', () => {
  const first = source('Pasted by hand');
  const second = source('Pasted from the other log');
  const groups = dedup(timeouts);
  saveScoutFindings(db, first, groups);
  saveScoutFindings(db, second, groups);
  dismissScoutFinding(db, scoutFindings(db, first)[0]?.id ?? 0);

  expect(saveScoutFindings(db, first, groups)).toEqual({ added: 0, met: 0, muted: 1 });
  expect(saveScoutFindings(db, second, groups)).toEqual({ added: 0, met: 1, muted: 0 });

  expect(scoutFindings(db, first)[0]?.occurrences).toBe(3);
  expect(scoutFindings(db, second)[0]?.occurrences).toBe(6);
});

// Both answer false rather than throwing, so a screen can say a sentence: the finding may have gone
// with its source while the page was open.
it('says no for a finding that is not there and for one already in that state', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const [only] = scoutFindings(db, id);

  expect(dismissScoutFinding(db, 404)).toBe(false);
  expect(unmuteScoutFinding(db, 404)).toBe(false);
  expect(unmuteScoutFinding(db, only?.id ?? 0)).toBe(false);
  expect(dismissScoutFinding(db, only?.id ?? 0)).toBe(true);
  expect(dismissScoutFinding(db, only?.id ?? 0)).toBe(false);
});

// The word an assessment writes. Only from `new`, so a button on the list cannot bring a muted
// finding back and cannot move a finding that is already being assessed. No migration: all seven
// words have been in the column's CHECK since the table was made, because sqlite cannot widen one.
it('moves a finding into the assessment column, and only from the list', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const only = scoutFindings(db, id)[0]?.id ?? 0;

  expect(assessScoutFinding(db, only)).toBe(true);
  expect(scoutFinding(db, only)?.status).toBe('assess');
  // Already there, so nothing to write.
  expect(assessScoutFinding(db, only)).toBe(false);
  expect(assessScoutFinding(db, 404)).toBe(false);

  dismissScoutFinding(db, only);
  expect(assessScoutFinding(db, only)).toBe(false);
  expect(scoutFinding(db, only)?.status).toBe('dismissed');
});

// Start as Delivery. One finding accepted becomes a card, and the card and the finding's two
// columns are written in one transaction.
describe('starting a finding as a delivery card', () => {
  // The finding a check left, and its id.
  const found = (): number => {
    const id = source();
    saveScoutFindings(db, id, dedup(timeouts));
    return scoutFindings(db, id)[0]?.id ?? 0;
  };

  const card = (key: string) =>
    db.prepare('SELECT board, stage, title, summary, state FROM cards WHERE key = ?').get(key) as
      | { board: string; stage: string; title: string; summary: string; state: string }
      | undefined;

  const cardCount = () => (db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n;

  it('makes a card on the first Delivery column and remembers it on the finding', () => {
    const id = found();

    const start = startScoutFinding(db, id);

    expect(start).toEqual({ ok: true, key: 'APP-1' });
    if (!start.ok) return;
    const row = card(start.key);
    expect(row?.board).toBe('delivery');
    expect(row?.stage).toBe('inbox');
    // The made title, with the id and the source label. Never the collected line: a title reaches a
    // branch name, and a collected line can hold a token.
    expect(row?.title).toBe(`Scout finding ${id}, from Pasted by hand`);
    expect(row?.title).not.toContain('Timeout');
    // The evidence in the body: the newest line, where it happens, the count, and where the rest is.
    expect(row?.summary).toContain('Timeout after 9000ms calling /api/recipes');
    expect(row?.summary).toContain('api/recipes.ts:20');
    expect(row?.summary).toContain('Seen 3 times.');
    expect(row?.summary).toContain(`Finding ${id} on the Scout screen`);
    // Nothing runs. The card waits in the first column like any other.
    expect(row?.state).toBe('idle');

    const after = scoutFinding(db, id);
    expect(after?.status).toBe('started');
    expect(after?.cardKey).toBe(start.key);
  });

  // One problem, one card. Without this a person pressing the button twice, or two windows on one
  // finding, would put the same problem on the board twice under two keys.
  it('refuses a finding that already has a card, and names the card', () => {
    const id = found();
    const first = startScoutFinding(db, id);

    const again = startScoutFinding(db, id);

    expect(again).toEqual({ ok: false, message: expect.stringContaining('APP-1') });
    expect(cardCount()).toBe(1);
    expect(scoutFinding(db, id)?.cardKey).toBe(first.ok ? first.key : '');
  });

  // Both refusals are sentences a person can act on, and neither writes anything.
  it('refuses a muted finding and one that is done', () => {
    const muted = found();
    dismissScoutFinding(db, muted);

    expect(startScoutFinding(db, muted)).toEqual({ ok: false, message: expect.stringContaining('muted') });

    const done = found();
    db.prepare("UPDATE scout_findings SET status = 'done' WHERE id = ?").run(done);

    expect(startScoutFinding(db, done)).toEqual({ ok: false, message: expect.stringContaining('done') });
    expect(cardCount()).toBe(0);
    expect(scoutFinding(db, muted)?.status).toBe('dismissed');
    expect(scoutFinding(db, muted)?.cardKey).toBe(null);
  });

  // A sentence and never a throw, the way dismiss and unmute answer: the finding may have gone with
  // its source in another tab.
  it('refuses a finding that is not there', () => {
    expect(startScoutFinding(db, 404)).toEqual({ ok: false, message: expect.stringContaining('404') });
    expect(cardCount()).toBe(0);
  });

  // A finding whose card was deleted names a key the board does not answer. It starts again rather
  // than sitting on that key for good, and the column follows the new card.
  it('starts again when the card it was on is gone', () => {
    const id = found();
    const first = startScoutFinding(db, id);
    db.prepare('DELETE FROM cards WHERE key = ?').run(first.ok ? first.key : '');

    const again = startScoutFinding(db, id);

    expect(again).toEqual({ ok: true, key: 'APP-2' });
    expect(scoutFinding(db, id)?.cardKey).toBe('APP-2');
    expect(scoutFinding(db, id)?.status).toBe('started');
  });

  // The button on both screens is drawn off this, so it is offered exactly where the writer takes it.
  it('offers the start on the columns the writer takes, and on no card', () => {
    expect(canStartFinding('new', false)).toBe(true);
    expect(canStartFinding('assess', false)).toBe(true);
    expect(canStartFinding('decide', false)).toBe(true);
    expect(canStartFinding('parked', false)).toBe(true);
    // The card is gone, which is the one way a started finding starts again.
    expect(canStartFinding('started', false)).toBe(true);
    expect(canStartFinding('new', true)).toBe(false);
    expect(canStartFinding('done', false)).toBe(false);
    expect(canStartFinding('dismissed', false)).toBe(false);
  });
});

// The second board. One writer with the board as its argument, which is what keeps Start as
// Delivery and Start as Investigation from being two copies of the same write.
it('starts a finding on the Investigations board when that is what was asked for', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const one = scoutFindings(db, id)[0]?.id ?? 0;

  const start = startScoutFinding(db, one, 'investigations');

  // An investigation counts under its own prefix, as every new one on Research does.
  expect(start).toEqual({ ok: true, key: 'INV-1' });
  const row = db.prepare('SELECT board, stage FROM cards WHERE key = ?').get('INV-1') as { board: string; stage: string };
  expect(row.board).toBe('investigations');
  // The first column of that board. Both boards a finding starts on begin at `inbox`, so this holds
  // where the card lands and not that the column was read off the board. Nothing can hold the second
  // until two of these boards start on different words.
  expect(row.stage).toBe('inbox');
  expect(scoutFinding(db, one)?.status).toBe('started');
});

// One pasted line can be fifty thousand characters. The card is a ticket a person reads, so it takes
// the head of the line and says where the rest is.
it('cuts a long line in the card body and says where the whole one is', () => {
  const id = source();
  const long = `Timeout after 5000ms calling /api/recipes ${'context '.repeat(700)}`;
  expect(long.length).toBeGreaterThan(5000);
  saveScoutFindings(db, id, dedup([item(long)]));
  const one = scoutFindings(db, id)[0]?.id ?? 0;

  const start = startScoutFinding(db, one);

  expect(start.ok).toBe(true);
  const summary = (db.prepare('SELECT summary FROM cards WHERE key = ?').get(start.ok ? start.key : '') as { summary: string }).summary;
  expect(summary).toContain(`[The line is cut here. Finding ${one} has all of it.]`);
  // The head of the line and not the whole one. The prose around it is short, so the body stays near
  // the cap rather than near the fifty thousand characters the finding keeps.
  expect(summary.length).toBeLessThan(2600);
  expect(summary).not.toContain(long);
  // One occurrence reads as English, because "Seen 1 times" is not.
  expect(summary).toContain('Seen once.');
  expect(summary).not.toContain('Seen 1 times.');
});

// Starting a finding made the status word carry the fact that it is on a board. Unmute wrote `new` over any
// column, so three clicks a screen offers left a finding reading New beside a live card, with Assess
// offered on work already started.
it('brings a started finding back as started, and a plain one back as new', () => {
  const id = source();
  saveScoutFindings(db, id, dedup(timeouts));
  const started = scoutFindings(db, id)[0]?.id ?? 0;
  const start = startScoutFinding(db, started);
  dismissScoutFinding(db, started);

  expect(unmuteScoutFinding(db, started)).toBe(true);

  expect(scoutFinding(db, started)?.status).toBe('started');
  expect(scoutFinding(db, started)?.cardKey).toBe(start.ok ? start.key : '');
  // The assessment column is not offered on a finding that is already a card.
  expect(assessScoutFinding(db, started)).toBe(false);

  // A finding that never became a card still comes back on the list as new.
  saveScoutFindings(db, id, dedup([item('Cannot read property name of undefined')]));
  const plain = scoutFindings(db, id).find((one) => one.id !== started)?.id ?? 0;
  dismissScoutFinding(db, plain);

  expect(unmuteScoutFinding(db, plain)).toBe(true);
  expect(scoutFinding(db, plain)?.status).toBe('new');
});

// A finding a ticket query found is about one ticket, and the card a person starts from it is
// that ticket. The key is kept in its own column: `location` holds `PROJ-123` for a ticket and
// `acme/app@main` for a failed run, so nothing there tells the two apart.
describe('a finding from a ticket source', () => {
  const tickets = (label = 'The ticket query') => addScoutSource(db, { kind: 'tickets', label });

  const ticketItem = (key: string, title: string): ScoutItem => ({ sourceKind: 'tickets', errorType: '', message: title, location: key, sourceId: key });

  const ciItem = (): ScoutItem => ({ sourceKind: 'tickets', errorType: 'ci', message: 'Tests failed on main', location: 'acme/app@main' });

  const cardCount = () => (db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n;

  it('keeps the ticket key on the finding, and keeps none on a failed run', () => {
    const id = tickets();

    saveScoutFindings(db, id, dedup([ticketItem('PROJ-123', 'Search by ingredient'), ciItem()]));

    const found = scoutFindings(db, id);
    expect(found.find((one) => one.location === 'PROJ-123')?.externalKey).toBe('PROJ-123');
    expect(found.find((one) => one.location === 'acme/app@main')?.externalKey).toBe(null);
  });

  // A finding written before this column was there has no key, and the next check fills it in. The
  // coalesce in the save is a guard on top of that and nothing here can reach it: a ticket's
  // fingerprint is built from its key, so a row can never be met by an item carrying no key.
  it('fills the key in on a later check of a row that was written without one', () => {
    const id = tickets();
    saveScoutFindings(db, id, dedup([ticketItem('PROJ-123', 'Search by ingredient')]));
    const one = scoutFindings(db, id)[0]?.id ?? 0;
    db.prepare('UPDATE scout_findings SET external_key = NULL WHERE id = ?').run(one);

    saveScoutFindings(db, id, dedup([ticketItem('PROJ-123', 'Ingredient search is wrong')]));

    expect(scoutFinding(db, one)?.externalKey).toBe('PROJ-123');
  });

  // A known limit of starting a finding, now closed. A new local key here put one ticket on the board
  // twice, once as `PROJ-123` from the Add card dialog and once as `APP-1` from this button.
  it('starts as a card keyed by the ticket, and not by the local counter', () => {
    const id = tickets();
    saveScoutFindings(db, id, dedup([ticketItem('PROJ-123', 'Search by ingredient')]));
    const one = scoutFindings(db, id)[0]?.id ?? 0;

    const start = startScoutFinding(db, one);

    expect(start).toEqual({ ok: true, key: 'PROJ-123' });
    const row = db.prepare('SELECT board, stage, title, summary, source, source_ref FROM cards WHERE key = ?').get('PROJ-123') as {
      board: string;
      stage: string;
      title: string;
      summary: string;
      source: string;
      source_ref: string;
    };
    expect(row.board).toBe('delivery');
    expect(row.stage).toBe('inbox');
    // The ticket's own title, which is what the finding's newest line holds for a ticket.
    expect(row.title).toBe('Search by ingredient');
    expect(row.summary).toContain(`Finding ${one} on the Scout screen`);
    // The same two fields the Add card dialog writes for a ticket it could not read, so a later
    // adapter fills this card in the same way.
    expect(row.source).toBe('external');
    expect(row.source_ref).toBe('PROJ-123');
    expect(scoutFinding(db, one)?.cardKey).toBe('PROJ-123');
    expect(scoutFinding(db, one)?.status).toBe('started');
    // The local counter is untouched, so the next card made by hand is still APP-1.
    expect(db.prepare("SELECT key FROM cards WHERE key LIKE 'APP-%'").get()).toBe(undefined);
  });

  // The Jira worklog export logs only a card of source jira, so a Jira finding's card has to say so.
  it('writes source jira for a finding of a Jira source, and external for the others', () => {
    const jira = addScoutSource(db, { kind: 'tickets', label: 'Open bugs', config: { system: 'jira', site: 'https://you.atlassian.net', email: 'dana@example.com', jql: 'project = PROJ' } });
    saveScoutFindings(db, jira, dedup([ticketItem('PROJ-123', 'Search by ingredient')]));
    const linear = addScoutSource(db, { kind: 'tickets', label: 'Team issues', config: { system: 'linear', teams: 'OPS' } });
    saveScoutFindings(db, linear, dedup([ticketItem('OPS-7', 'Import is slow')]));

    expect(startScoutFinding(db, scoutFindings(db, jira)[0]?.id ?? 0)).toEqual({ ok: true, key: 'PROJ-123' });
    expect(startScoutFinding(db, scoutFindings(db, linear)[0]?.id ?? 0)).toEqual({ ok: true, key: 'OPS-7' });

    expect(db.prepare('SELECT source, source_ref FROM cards WHERE key = ?').get('PROJ-123')).toEqual({ source: 'jira', source_ref: 'PROJ-123' });
    expect(db.prepare('SELECT source FROM cards WHERE key = ?').get('OPS-7')).toEqual({ source: 'external' });
  });

  // The ticket is on the board because somebody added it by hand. Whoever did wrote its title and
  // moved its column, so the finding only points at it and nothing is written over.
  it('points at a ticket already on the board and makes no second card', () => {
    const id = tickets();
    saveScoutFindings(db, id, dedup([ticketItem('PROJ-123', 'Search by ingredient')]));
    const one = scoutFindings(db, id)[0]?.id ?? 0;
    createCard(db, { key: 'PROJ-123', board: 'delivery', stage: 'plan', title: 'What a person called it', summary: null, source: 'external', sourceRef: 'PROJ-123' });

    const start = startScoutFinding(db, one, 'investigations');

    expect(start).toEqual({ ok: true, key: 'PROJ-123', alreadyOnBoard: true });
    expect(cardCount()).toBe(1);
    const row = db.prepare('SELECT board, stage, title FROM cards WHERE key = ?').get('PROJ-123') as { board: string; stage: string; title: string };
    expect(row).toEqual({ board: 'delivery', stage: 'plan', title: 'What a person called it' });
    expect(scoutFinding(db, one)?.cardKey).toBe('PROJ-123');
    expect(scoutFinding(db, one)?.status).toBe('started');
  });

  // A GitHub ticket is keyed app#42 with no owner, like a pull request card, so the card can run. The
  // source names the repository, so the card keeps the full name as its ref, the way Add card does.
  const github = () => addScoutSource(db, { kind: 'tickets', label: 'The app issues', config: { system: 'github', repo: 'Acme/app' } });
  const githubFinding = (): number => {
    const id = github();
    saveScoutFindings(db, id, dedup([ticketItem('app#42', 'Search by ingredient')]));
    return scoutFindings(db, id)[0]?.id ?? 0;
  };

  it('starts a GitHub ticket as a card keyed by repository and number, with the full name as its ref', () => {
    const one = githubFinding();

    expect(startScoutFinding(db, one)).toEqual({ ok: true, key: 'app#42' });
    expect(db.prepare('SELECT source, source_ref FROM cards WHERE key = ?').get('app#42')).toEqual({ source: 'external', source_ref: 'acme/app#42' });
  });

  it('points at the card of the same issue, made by Add card', () => {
    const one = githubFinding();
    createCard(db, { key: 'app#42', board: 'epics', stage: 'inbox', title: 'Search by ingredient', source: 'github', sourceRef: 'acme/app#42' });

    expect(startScoutFinding(db, one)).toEqual({ ok: true, key: 'app#42', alreadyOnBoard: true });
  });

  // The key carries no owner, so another owner's app#42 is the same key. Pointing the finding at that
  // card would send the person to somebody else's issue.
  it("refuses to point at another owner's card under the same key, and leaves the finding as it was", () => {
    const one = githubFinding();
    createCard(db, { key: 'app#42', board: 'delivery', stage: 'inbox', title: 'Another app', source: 'github', sourceRef: 'bake/app#42' });

    expect(startScoutFinding(db, one)).toEqual({
      ok: false,
      message: `Finding ${one} is acme/app#42, and app#42 on the board is bake/app#42. A card key carries no owner or group, so no card was made.`,
    });
    expect(scoutFinding(db, one)).toMatchObject({ status: 'new', cardKey: null });
  });

  // A GitLab project is keyed by its own name too, so a GitHub repository of that name holds the key.
  it("refuses a GitLab ticket whose key another owner's card holds, and names the group", () => {
    createCard(db, { key: 'app#42', board: 'delivery', stage: 'inbox', title: 'Another app', source: 'github', sourceRef: 'acme/app#42' });
    const id = addScoutSource(db, { kind: 'tickets', label: 'The app on GitLab', config: { system: 'gitlab', project: 'group/kitchen/app' } });
    saveScoutFindings(db, id, dedup([ticketItem('app#42', 'Import keeps one page')]));
    const one = scoutFindings(db, id)[0]?.id ?? 0;

    expect(startScoutFinding(db, one)).toEqual({
      ok: false,
      message: `Finding ${one} is group/kitchen/app#42, and app#42 on the board is acme/app#42. A card key carries no owner or group, so no card was made.`,
    });
    expect(scoutFinding(db, one)).toMatchObject({ status: 'new', cardKey: null });
  });

  // A GitLab issue is keyed by the project's own name, so its card runs too. The group is in the
  // source, and the card keeps the full reference as its ref.
  it('starts a GitLab ticket as a card keyed by project and number, with the full reference as its ref', () => {
    const id = addScoutSource(db, { kind: 'tickets', label: 'The app on GitLab', config: { system: 'gitlab', project: 'Group/Kitchen/app' } });
    saveScoutFindings(db, id, dedup([ticketItem('app#12', 'Import keeps one page')]));
    const one = scoutFindings(db, id)[0]?.id ?? 0;

    expect(startScoutFinding(db, one)).toEqual({ ok: true, key: 'app#12' });
    expect(db.prepare('SELECT source, source_ref FROM cards WHERE key = ?').get('app#12')).toEqual({ source: 'external', source_ref: 'group/kitchen/app#12' });
    expect(scoutFinding(db, one)?.cardKey).toBe('app#12');
  });

  // A finding an earlier migration could not move, such as the older of two after an owner rename,
  // still holds the full reference. Its card takes the last part all the same, so it can run.
  it('starts a finding whose key still holds a path as a card keyed by the last part', () => {
    const one = githubFinding();
    db.prepare("UPDATE scout_findings SET external_key = 'oldacme/app#42' WHERE id = ?").run(one);

    expect(startScoutFinding(db, one)).toEqual({ ok: true, key: 'app#42' });
    expect(db.prepare('SELECT source_ref FROM cards WHERE key = ?').get('app#42')).toEqual({ source_ref: 'oldacme/app#42' });
  });

  // A failed run is no ticket, so it takes a local key the way a pasted line does.
  it('starts a failed run as a local card', () => {
    const id = tickets();
    saveScoutFindings(db, id, dedup([ciItem()]));
    const one = scoutFindings(db, id)[0]?.id ?? 0;

    expect(startScoutFinding(db, one)).toEqual({ ok: true, key: 'APP-1' });
  });
});

/**
 * A ticket key a card cannot carry.
 *
 * A ticket key is copied out of somebody else's answer and written straight into the card row, with
 * no check before this one. A key carrying a line break broke the card address and forged a line in
 * every text that pastes a key, so it is refused at the Start now and the finding says why.
 *
 * A slash is not refused: a key with a path in it starts as its last part, the way the GitHub and the
 * GitLab tests above show.
 */
describe('a ticket key a card cannot carry', () => {
  const ticketItem = (key: string, title: string): ScoutItem => ({ sourceKind: 'tickets', errorType: '', message: title, location: key, sourceId: key });

  const findingWith = (key: string): number => {
    const id = addScoutSource(db, { kind: 'tickets', label: 'The ticket query' });
    saveScoutFindings(db, id, dedup([ticketItem(key, 'Search by ingredient')]));
    return scoutFindings(db, id)[0]?.id ?? 0;
  };

  it('refuses the start, and leaves the finding as it was', () => {
    const one = findingWith('APP-42\nAPP-43, Ship it');

    const start = startScoutFinding(db, one);

    expect(start).toEqual({
      ok: false,
      message: `Finding ${one} is a ticket whose key cannot be a card key, so no card was made. A card key is one line of plain text, with no line break and no control character.`,
    });
    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 0 });
    expect(scoutFinding(db, one)?.status).toBe('new');
    expect(scoutFinding(db, one)?.cardKey).toBe(null);
  });

  // A key out of an answer nobody vetted. The sentence is the shape rule and never the key itself:
  // the key can hold a whole pasted line, and this sentence is drawn on a page.
  it('refuses a key with a line break', () => {
    const one = findingWith('PROJ-123\nPROJ-124');

    expect(startScoutFinding(db, one)).toEqual({
      ok: false,
      message: `Finding ${one} is a ticket whose key cannot be a card key, so no card was made. A card key is one line of plain text, with no line break and no control character.`,
    });
    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 0 });
  });

  // The cut takes the line break off the key, but the card would still keep it in its source ref,
  // and the sentence below a card on that key would print it.
  it('refuses a key with a line break before its last slash', () => {
    const one = findingWith('PROJ-1\nPROJ-2/app#1');
    createCard(db, { key: 'app#1', board: 'delivery', stage: 'inbox', title: 'Another app', source: 'external', sourceRef: 'acme/app#1' });
    const shape = `Finding ${one} is a ticket whose key cannot be a card key, so no card was made. A card key is one line of plain text, with no line break and no control character.`;

    expect(startScoutFinding(db, one)).toEqual({ ok: false, message: shape });
    db.prepare('DELETE FROM cards').run();
    expect(startScoutFinding(db, one)).toEqual({ ok: false, message: shape });
    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 0 });
    expect(scoutFinding(db, one)).toMatchObject({ status: 'new', cardKey: null });
  });

  // The Jira and the Linear readers check the key shape themselves, so their findings are the ones
  // that still start. This is the line that says the guard refuses the broken keys and not all of
  // them.
  it('starts a Jira shaped key as before', () => {
    const one = findingWith('PROJ-123');

    expect(startScoutFinding(db, one)).toEqual({ ok: true, key: 'PROJ-123' });
  });
});

/**
 * A count no column can hold is capped, and never left to break every later read.
 *
 * The column comes back as a JavaScript number, and `node:sqlite` throws a RangeError converting one
 * past 2^53. The write lands first, so without the cap one wrong count from one adapter makes every
 * read of this table throw for good, including the screen holding Dismiss and Unmute. A hub job
 * carrying `Number.MAX_SAFE_INTEGER` proved exactly that before this cap existed.
 *
 * Red on the `min(...)` in the update, and on the `Math.min` that binds a new row.
 */
it('caps a count too large to hold, and keeps every later read working', () => {
  const id = source();
  const huge = { fingerprint: 'paste:huge', count: Number.MAX_SAFE_INTEGER, first: item('Out of memory'), last: item('Out of memory') };

  expect(saveScoutFindings(db, id, [huge])).toEqual({ added: 1, met: 0, muted: 0 });
  // The read is the half that used to throw, so it is asserted and not assumed.
  expect(allScoutFindings(db)[0]?.occurrences).toBe(1_000_000_000_000);

  // And again, so the sum goes through the same cap rather than past it.
  expect(saveScoutFindings(db, id, [huge])).toEqual({ added: 0, met: 1, muted: 0 });
  expect(allScoutFindings(db)).toHaveLength(1);
  // Twice what one save may add, which is where a row stops growing.
  expect(allScoutFindings(db)[0]?.occurrences).toBe(2_000_000_000_000);
});

/**
 * A row already at the ceiling stops growing, which is the half the cap on the sum owns.
 *
 * The cap on what one save adds keeps two saves inside 2^53 on its own, so the `min(...)` in the
 * update only earns its place once a row has climbed near the ceiling over many checks. Reaching that
 * by saving would take nine thousand saves, so the row is put there directly and then met once.
 *
 * Red on the `min(...)` in the update.
 */
it('leaves a finding at the ceiling there rather than growing past it', () => {
  const id = source();
  const one = { fingerprint: 'paste:ceiling', count: 3, first: item('Out of memory'), last: item('Out of memory') };
  saveScoutFindings(db, id, [one]);
  db.prepare('UPDATE scout_findings SET occurrences = ? WHERE source_id = ?').run(2_000_000_000_000, id);

  expect(saveScoutFindings(db, id, [one])).toEqual({ added: 0, met: 1, muted: 0 });

  expect(allScoutFindings(db)[0]?.occurrences).toBe(2_000_000_000_000);
});
