import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase, spendReport } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY, minutesOf, NO_TIMESHEET, timesheetCsv } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import TimesheetWeek from './TimesheetWeek.svelte';
import { billingFor, billingPrompt, saveBilling, timesheetFor } from './timesheet.ts';

// One week, pinned, because the whole feature is about which week and which day a run belongs to.
// 2026-03-02 is a Monday, 2026-03-04 is the Wednesday the timeline's own test pins, and 2026-03-08 is the
// Sunday that closes the week. The suite runs with TZ=UTC, so a stamp written here is the stamp the
// fold reads.
const WEEK = '2026-03-02';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-timesheet-'));
  db = openDatabase(dir);
  card('APP-1', 'Add a search box');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function card(key: string, title: string): void {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', 'implement', 'idle', ?)").run(key, title);
}

// A run with its times set by hand, the way the evidence test writes one. The duration is its own
// field here and does not follow the two stamps: a timesheet is about the figure the engine reported,
// and a run can report none.
function run(over: { card?: string; started?: string | null; ended?: string | null; ms?: number | null; cost?: number | null }): void {
  const written = db
    .prepare("INSERT INTO runs (card_key, phase, engine, log_path, state) VALUES (?, 'implement', 'claude-code', ?, 'complete')")
    .run(over.card ?? 'APP-1', join(dir, 'run.ndjson'));
  db.prepare('UPDATE runs SET started_at = ?, ended_at = ?, cost_estimate = ?, duration_ms = ? WHERE id = ?').run(
    over.started ?? null,
    over.ended ?? null,
    over.cost ?? null,
    over.ms === undefined ? 60_000 : over.ms,
    Number(written.lastInsertRowid),
  );
}

const cells = (key: string) => timesheetFor(db, { week: WEEK }).rows.find((row) => row.key === key)?.cells.map((cell) => cell.minutes);

// The grid the plan asks for, cell by cell and not by its total, over a week of runs on two cards.
it('draws a week of runs, cell by cell', () => {
  card('APP-2', 'Print the shopping list');
  run({ started: `${WEEK}T09:00:00.000Z`, ended: `${WEEK}T09:30:00.000Z`, ms: 1_800_000 });
  run({ started: `${WEEK}T14:00:00.000Z`, ended: `${WEEK}T14:15:00.000Z`, ms: 900_000 });
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T10:00:00.000Z', ms: 3_600_000 });
  run({ card: 'APP-2', started: '2026-03-06T09:00:00.000Z', ended: '2026-03-06T09:05:00.000Z', ms: 300_000 });

  const sheet = timesheetFor(db, { week: WEEK });

  expect(sheet.rows.map((row) => [row.key, row.label])).toEqual([
    ['APP-1', 'Add a search box'],
    ['APP-2', 'Print the shopping list'],
  ]);
  expect(sheet.rows[0]?.cells.map((cell) => [cell.minutes, cell.runs])).toEqual([[45, 2], [0, 0], [60, 1], [0, 0], [0, 0], [0, 0], [0, 0]]);
  expect(sheet.rows[1]?.cells.map((cell) => [cell.minutes, cell.runs])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0], [5, 1], [0, 0], [0, 0]]);
  expect(sheet.perDay.map((cell) => cell.minutes)).toEqual([45, 0, 60, 0, 5, 0, 0]);
  expect(sheet.total.minutes).toBe(110);
});

// The day rule, asserted against the cost report itself so the grid and the cost view cannot drift
// apart about which day a run counts to.
it('counts a day the way the cost report does', () => {
  run({ started: `${WEEK}T09:00:00.000Z`, ended: `${WEEK}T09:30:00.000Z`, ms: 1_800_000, cost: 0.05 });
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:20:00.000Z', ms: 1_200_000, cost: 0.07 });

  const sheet = timesheetFor(db, { week: WEEK });
  const byDay = spendReport(db).byDay;

  for (const [index, day] of sheet.days.entries()) {
    const spend = byDay.get(day);
    expect(sheet.perDay[index]?.runs).toBe(spend?.runs ?? 0);
    expect(sheet.perDay[index]?.minutes).toBe(minutesOf(spend?.durationMs ?? 0));
  }
});

// A run over midnight belongs to the day it started, which is the timesheet's rule and the timeline's.
it('keeps a run that crossed midnight in the last column, and out of the next week', () => {
  run({ started: '2026-03-08T23:50:00.000Z', ended: '2026-03-09T00:20:00.000Z', ms: 1_800_000 });

  expect(cells('APP-1')).toEqual([0, 0, 0, 0, 0, 0, 30]);
  expect(timesheetFor(db, { week: '2026-03-09' }).rows).toEqual([]);
});

// A queued run has no start, so it is in no column. Putting it under today would invent a day it
// never ran on, which is what the cost report refuses as well.
it('leaves a queued run out of every column', () => {
  run({ started: null, ended: null, ms: null });

  expect(timesheetFor(db, { week: WEEK }).rows).toEqual([]);
});

// The two runs a cell must not present as work: one that reported no duration, and one still going.
// Both are counted and neither adds a minute.
it('counts a run with no duration and a run still going, and adds no minutes for either', () => {
  run({ started: '2026-03-03T09:00:00.000Z', ended: '2026-03-03T09:30:00.000Z', ms: null });
  run({ started: '2026-03-03T11:00:00.000Z', ended: null, ms: null });

  const cell = timesheetFor(db, { week: WEEK }).rows[0]?.cells[1];

  expect(cell).toEqual({ minutes: 0, runs: 2, untimed: 1, running: 1 });
});

// A maintenance run and a run whose card was deleted are both `card: null` on an evidence block, so a
// grid built from blocks would add one to the other. Each gets its own row here, named after what the
// hours were for.
it('gives a maintenance run and a deleted card their own rows', () => {
  run({ card: KB_MAINTENANCE_KEY, started: `${WEEK}T09:00:00.000Z`, ended: `${WEEK}T09:10:00.000Z`, ms: 600_000 });
  run({ card: 'APP-9', started: `${WEEK}T10:00:00.000Z`, ended: `${WEEK}T10:20:00.000Z`, ms: 1_200_000 });

  const sheet = timesheetFor(db, { week: WEEK });

  expect(sheet.rows.map((row) => [row.key, row.label, row.total.minutes])).toEqual([
    ['APP-9', 'APP-9, deleted', 20],
    [KB_MAINTENANCE_KEY, 'Maintenance', 10],
  ]);
});

// Delete card moves its runs to "APP-3 (deleted)", which is already the label. It goes to the time
// trackers as it is, never as "APP-3 (deleted), deleted".
it('labels the runs Delete card kept by their key as it is', () => {
  run({ card: 'APP-3 (deleted)', started: `${WEEK}T10:00:00.000Z`, ended: `${WEEK}T10:20:00.000Z`, ms: 1_200_000 });

  expect(timesheetFor(db, { week: WEEK }).rows.map((row) => [row.key, row.label, row.source])).toEqual([['APP-3 (deleted)', 'APP-3 (deleted)', null]]);
});

// The file and the grid are one object, so the check is the file read back against that object and
// not against a second hand-written table.
it('exports a file that reads back as the grid', () => {
  run({ started: '2026-03-05T09:00:00.000Z', ended: '2026-03-05T09:30:00.000Z', ms: 1_800_000 });
  const sheet = timesheetFor(db, { week: WEEK });
  const lines = timesheetCsv(sheet).split('\r\n');

  expect(lines[0]).toBe('Card,Title,2026-03-02,2026-03-03,2026-03-04,2026-03-05,2026-03-06,2026-03-07,2026-03-08,Total minutes,Runs with no time');
  expect(lines[1]).toBe('APP-1,Add a search box,,,,30,,,,30,0');
  expect(lines[2]).toBe('Total,Every card,,,,30,,,,30,0');
});

it('draws the empty sentence and the export link for a week with no run', () => {
  const html = render(TimesheetWeek, { props: { week: timesheetFor(db, { week: WEEK }), csvHref: '/api/evidence/timesheet' } }).body;

  expect(html).toContain(NO_TIMESHEET);
  expect(html).toContain('href="/api/evidence/timesheet"');
  expect(html).not.toContain('<table');
});

it('draws the grid with a mark on a cell whose minutes are short', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  run({ started: '2026-03-04T11:00:00.000Z', ended: null, ms: null });

  const html = render(TimesheetWeek, { props: { week: timesheetFor(db, { week: WEEK }), csvHref: '/api/evidence/timesheet' } }).body;

  expect(html).toContain('>30<');
  expect(html).toContain('short');
  expect(html).toContain('Add a search box');
});

// The export half of the panel. These render the component with the rows `timesheetSync` hands the
// route, written by hand, and `timesheet-export.test.ts` proves the rows themselves.
const week = () => timesheetFor(db, { week: WEEK });

it('names no destination and says the free plan when it is drawn with a week alone', () => {
  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/api/evidence/timesheet' } }).body;

  // The default. A panel built without the display document draws the free note, not the paid words.
  // The note names the trackers Solo sends to, and no Export.
  expect(html).not.toContain('Export posts it');
  expect(html).toContain('Send weeks to Toggl, Harvest or Clockify with Solo');
  // The file is free and stays on the screen either way.
  expect(html).toContain('href="/api/evidence/timesheet"');
});

it('names the four destinations and says no tracker is connected on a plan that has them', () => {
  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/api/evidence/timesheet', canExport: true } }).body;

  expect(html).toContain('Sending a week to Toggl, Harvest, Clockify or Jira is part of Solo. Export posts it from this machine');
  expect(html).toContain('No time tracker is connected, so no cell has an export status.');
  expect(html).not.toContain('Nothing in this app can send');
  expect(html).not.toContain('free plan');
});

// Eight columns of minutes are wider than a phone, so the grid scrolls in a box of its own and the
// page never scrolls sideways. A server render carries no CSS, so the rule is read from the source.
it('puts the grid in a box of its own that scrolls sideways', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });

  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c' } }).body;
  const source = readFileSync(new URL('./TimesheetWeek.svelte', import.meta.url), 'utf8');

  expect(html).toMatch(/<div class="scroll[^"]*">(<!---->|\s)*<table/);
  expect(source).toMatch(/\.scroll \{[^}]*overflow-x: auto;/);
});

it('names the tracker the marks are for', () => {
  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync: [], syncTo: 'Harvest' } }).body;

  expect(html).toContain('The marks in the grid are');
  expect(html).toContain('for Harvest.');
  expect(html).not.toContain('No time tracker is connected');
});

it('says a skipped day is one the tracker does not take, with its reason', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  const sync = [{ card: 'APP-1', day: '2026-03-04', state: 'skipped' as const, reason: 'APP-1 is not a Jira issue, so its hours were not sent to Jira.' }];

  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync, syncTo: 'Jira' } }).body;

  expect(html).toContain('>skipped<');
  expect(html).toContain('Not sent, because this tracker does not take it.');
  expect(html).toContain('APP-1 is not a Jira issue, so its hours were not sent to Jira.');
});

it('marks the cell an entry was sent from', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  const sync = [{ card: 'APP-1', day: '2026-03-04', state: 'sent' as const, reason: null }];

  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync } }).body;

  // The Wednesday cell of that card, and no other. A mark on the row or on the week would not carry
  // the day, and the export bills a card and a day. The count is the assertion: the string above is
  // built from the day the test passed in, so it holds on a row of seven marks as well.
  expect(html).toContain('data-sync="APP-1 2026-03-04"');
  expect(html.match(/data-sync=/g)).toHaveLength(1);
  // The word a person reads in the cell.
  expect(html).toContain('>sent<');
  // A sent entry needs no sentence under the grid.
  expect(html).not.toContain('data-note=');
  expect(html).not.toContain('no cell has an export status');
});

it('draws no mark and no line for a card that is not in the week', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  const sync = [{ card: 'GONE-9', day: '2026-03-04', state: 'failed' as const, reason: 'The workspace refused it.' }];

  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync } }).body;

  // A line about a card with no row points at nothing a person can find on the screen.
  expect(html).not.toContain('data-note=');
  expect(html).not.toContain('The workspace refused it.');
});

it('refuses two rows for one cell, because that is two destinations', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  const sync = [
    { card: 'APP-1', day: '2026-03-04', state: 'sent' as const, reason: null },
    { card: 'APP-1', day: '2026-03-04', state: 'failed' as const, reason: 'The workspace refused it.' },
  ];

  // Keeping the last row would draw the cell as sent and hide the refusal of the other destination.
  // `.body` inside the callback, because the server render only draws the grid when it is read.
  expect(() => render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync } }).body).toThrow(
    'Two sync rows for APP-1 2026-03-04',
  );
});

it('gives a cell that failed the words the destination sent back', () => {
  run({ started: '2026-03-03T09:00:00.000Z', ended: '2026-03-03T09:20:00.000Z', ms: 1_200_000 });
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  run({ started: '2026-03-05T09:00:00.000Z', ended: '2026-03-05T09:10:00.000Z', ms: 600_000 });
  const sync = [
    { card: 'APP-1', day: '2026-03-03', state: 'sent' as const, reason: null },
    { card: 'APP-1', day: '2026-03-04', state: 'failed' as const, reason: 'The workspace does not take an entry of that project.' },
    { card: 'APP-1', day: '2026-03-05', state: 'stuck' as const, reason: 'The workspace does not take an entry of that project.' },
  ];

  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync } }).body;

  expect(html).toContain('data-note="APP-1 2026-03-04"');
  expect(html).toContain('Not sent. A later export tries it again.');
  expect(html).toContain('The workspace does not take an entry of that project.');
  // A stuck day is the same refusal five times over, so the line says how to get it tried again and
  // names the word the cell carries.
  expect(html).toContain('>stuck<');
  expect(html).toContain('Not sent, and stuck: it failed too often. Save the connection again and the next export tries it.');
  // The day that went is not in the list, so the line a person reads is the one they can act on.
  expect(html).not.toContain('data-note="APP-1 2026-03-03"');
});

it('says a sent day whose minutes moved since, because those hours were billed', () => {
  run({ started: '2026-03-04T09:00:00.000Z', ended: '2026-03-04T09:30:00.000Z', ms: 1_800_000 });
  const sync = [{ card: 'APP-1', day: '2026-03-04', state: 'changed' as const, reason: null }];

  const html = render(TimesheetWeek, { props: { week: week(), csvHref: '/c', canExport: true, sync } }).body;

  // The figure on screen is not the one the client is billed from, and nothing on this screen sends
  // the difference, so the line has to say who fixes it and where.
  expect(html).toContain('>changed<');
  expect(html).toContain(
    'Sent, and the minutes have changed since. The tracker holds the figure that went, and only you can fix it there.',
  );
});

// Client and rate moved here from Settings, Project. The three fields save together, and a refused one
// stores none of them, so a typo in the rate does not leave a new client beside the old rate.
it('saves the client, the rate and the currency together, and none of them when one is refused', () => {
  expect(billingFor(db)).toEqual({ clientName: null, hourlyRate: null, currency: 'USD' });

  expect(saveBilling(db, { client: ' The recipe app ', rate: '80', currency: 'eur' })).toBeNull();
  expect(billingFor(db)).toEqual({ clientName: 'The recipe app', hourlyRate: 80, currency: 'EUR' });

  expect(saveBilling(db, { client: 'Another client', rate: 'eighty', currency: 'EUR' })).toEqual({ field: 'hourlyRate', message: 'The hourly rate is a number, such as 80, or nothing at all.' });
  expect(saveBilling(db, { client: 'Another client', rate: '90', currency: 'euro' })).toEqual({ field: 'currency', message: 'The currency is a three-letter code, such as USD.' });
  expect(billingFor(db)).toEqual({ clientName: 'The recipe app', hourlyRate: 80, currency: 'EUR' });
});

// Optional on Free, and nothing refuses an empty one. The hub's cost view reads
// the synced null as no rate set, and the currency goes back to the default.
it('takes the answers back when the boxes are cleared', () => {
  saveBilling(db, { client: 'The recipe app', rate: '80', currency: 'EUR' });

  expect(saveBilling(db, { client: '', rate: '  ', currency: '' })).toBeNull();

  expect([getSetting(db, 'clientName'), getSetting(db, 'hourlyRate'), getSetting(db, 'currency')]).toEqual([null, null, 'USD']);
});

// "Bill this project?" asks once: the first visit to the timesheet. The visit is what is stored, so
// the prompt does not come back after a save, a "Not now" or a visit that ignored it.
it('asks about billing on the first visit only', () => {
  expect(billingPrompt(db)).toBe(true);
  expect(getSetting(db, 'billingAsked')).toBe(true);

  expect(billingPrompt(db)).toBe(false);
  expect(billingPrompt(db)).toBe(false);
});

// A client or a rate typed before the prompt existed is an answer already, so there is nothing to ask.
it('does not ask a project that already has a client or a rate', () => {
  saveBilling(db, { client: '', rate: '80', currency: 'USD' });

  expect(billingPrompt(db)).toBe(false);
  expect(getSetting(db, 'billingAsked')).toBe(false);
});
