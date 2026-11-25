import { expect, it } from 'vitest';
import {
  minutesOf,
  NO_TIMESHEET,
  type Timesheet,
  type TimesheetRun,
  timesheetCsv,
  timesheetEntries,
  timesheetOf,
  weekDays,
  weekOf,
} from './timesheet.ts';

// One week, pinned, because the whole feature is about which week and which day a run belongs to.
// 2026-03-02 is a Monday and 2026-03-08 is the Sunday that closes the week. The suite runs with
// TZ=UTC, so a stamp written here is the stamp the fold reads, here and on CI.
const WEEK = '2026-03-02';

const run = (start: string, over: Partial<TimesheetRun> = {}): TimesheetRun => ({
  start,
  key: 'APP-1',
  label: 'Add a search box',
  source: 'local',
  durationMs: 60_000,
  running: false,
  ...over,
});

const cell = (minutes: number, runs: number, over: { untimed?: number; running?: number } = {}) => ({
  minutes,
  runs,
  untimed: over.untimed ?? 0,
  running: over.running ?? 0,
});

// A real parse and not a split on the comma: a field may hold a comma inside its quotes. The file
// ends with the line ending, so no empty last row comes back.
function parse(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let at = 0; at < csv.length; at += 1) {
    const char = csv[at];
    if (quoted) {
      if (char === '"' && csv[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && csv[at + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      at += 1;
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

it('starts the week on the Monday, in UTC', () => {
  expect(weekOf('2026-03-02')).toBe('2026-03-02');
  expect(weekOf('2026-03-04')).toBe('2026-03-02');
  // The Sunday is the last day of its week and not the first day of the next one.
  expect(weekOf('2026-03-08')).toBe('2026-03-02');
  expect(weekOf('2026-03-09')).toBe('2026-03-09');
  // Across a month edge, and over a year edge, where the Monday is in the month or the year before.
  expect(weekOf('2026-03-01')).toBe('2026-02-23');
  expect(weekOf('2027-01-01')).toBe('2026-12-28');
  expect(weekDays(WEEK)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
});

// The week boundary: the last run of one week and the first of the next are in two
// weeks and not in one.
it('puts the last run of a week and the first of the next in different weeks', () => {
  const last = run('2026-03-08T23:30:00.000Z');
  const first = run('2026-03-09T00:30:00.000Z');

  expect(weekOf('2026-03-08')).not.toBe(weekOf('2026-03-09'));
  expect(timesheetOf([last, first], WEEK).rows[0]?.cells.map((one) => one.runs)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  expect(timesheetOf([last, first], '2026-03-09').rows[0]?.cells.map((one) => one.runs)).toEqual([1, 0, 0, 0, 0, 0, 0]);
});

// A run over midnight belongs to the day it started, which is `spendReport`'s rule and the timeline's.
it('keeps a run that crossed midnight in the column of the day it started', () => {
  const sheet = timesheetOf([run('2026-03-04T23:50:00.000Z', { durationMs: 1_800_000 })], WEEK);

  expect(sheet.rows[0]?.cells.map((one) => one.minutes)).toEqual([0, 0, 30, 0, 0, 0, 0]);
});

// The grid a person reads, cell by cell and not by its total. Two cards, two days each, one run
// under half a minute, one that reported no duration and one still going.
it('draws a week of runs, cell by cell', () => {
  const sheet = timesheetOf(
    [
      run('2026-03-02T09:00:00.000Z', { durationMs: 40_000 }),
      run('2026-03-02T10:00:00.000Z', { durationMs: 40_000 }),
      run('2026-03-04T09:00:00.000Z', { durationMs: 20_000 }),
      run('2026-03-04T11:00:00.000Z', { durationMs: null }),
      run('2026-03-05T09:00:00.000Z', { durationMs: null, running: true }),
      run('2026-03-06T09:00:00.000Z', { key: 'APP-2', label: 'Print the shopping list', durationMs: 7_200_000 }),
    ],
    WEEK,
  );

  expect(sheet.week).toBe(WEEK);
  expect(sheet.rows.map((one) => [one.key, one.label])).toEqual([
    ['APP-1', 'Add a search box'],
    ['APP-2', 'Print the shopping list'],
  ]);
  // Two runs of forty seconds are one cell of eighty seconds, so the cell reads 1 and not 0 twice.
  expect(sheet.rows[0]?.cells).toEqual([cell(1, 2), cell(0, 0), cell(0, 2, { untimed: 1 }), cell(0, 1, { running: 1 }), cell(0, 0), cell(0, 0), cell(0, 0)]);
  expect(sheet.rows[0]?.total).toEqual(cell(1, 5, { untimed: 1, running: 1 }));
  expect(sheet.rows[1]?.cells).toEqual([cell(0, 0), cell(0, 0), cell(0, 0), cell(0, 0), cell(120, 1), cell(0, 0), cell(0, 0)]);
  expect(sheet.perDay).toEqual([cell(1, 2), cell(0, 0), cell(0, 2, { untimed: 1 }), cell(0, 1, { running: 1 }), cell(120, 1), cell(0, 0), cell(0, 0)]);
  expect(sheet.total).toEqual(cell(121, 6, { untimed: 1, running: 1 }));
});

// A run of twenty seconds is an honest nought and not a missing figure, so its cell prints 0 while a
// day nothing ran on prints nothing at all. The grid and the file agree on which of the two it is.
it('rounds a run under half a minute to a reported nought', () => {
  const sheet = timesheetOf([run('2026-03-03T09:00:00.000Z', { durationMs: 20_000 })], WEEK);
  // Card, Title, then the seven days, so the Tuesday the run is on is the fourth field.
  const [, , , tuesday, wednesday] = parse(timesheetCsv(sheet))[1] ?? [];

  expect(minutesOf(20_000)).toBe(0);
  expect(tuesday).toBe('0');
  expect(wednesday).toBe('');
});

// The other side of the boundary. Rounded down a run of three quarters of a minute bills nothing, in
// the grid and in the file, and a cell holding a minute and a half reads as one.
it('rounds half a minute up, so a short run is not free', () => {
  expect(minutesOf(30_000)).toBe(1);
  expect(minutesOf(45_000)).toBe(1);
  expect(minutesOf(90_000)).toBe(2);
  expect(timesheetOf([run('2026-03-03T09:00:00.000Z', { durationMs: 45_000 })], WEEK).rows[0]?.total.minutes).toBe(1);
});

// The literal, not the constant. The check below reads the first half of the sentence, and the half
// it does not read is the half that says what puts a row here.
it('tells a person what puts a row in an empty week', () => {
  expect(NO_TIMESHEET).toBe('No run in this week. A row appears here when a run starts on a card.');
});

it('says a week with no run is empty, and exports the header row alone', () => {
  const sheet = timesheetOf([], WEEK);

  expect(sheet.rows).toEqual([]);
  expect(sheet.total).toEqual(cell(0, 0));
  expect(NO_TIMESHEET).toContain('No run in this week');
  expect(timesheetCsv(sheet)).toBe(`Card,Title,2026-03-02,2026-03-03,2026-03-04,2026-03-05,2026-03-06,2026-03-07,2026-03-08,Total minutes,Runs with no time\r\n`);
});

// The file parsed back gives the numbers the grid holds, asserted against the
// same object both were built from and not against a second hand-written table.
it('exports numbers that parse back into the grid', () => {
  const sheet = timesheetOf(
    [
      run('2026-03-02T09:00:00.000Z', { durationMs: 1_800_000 }),
      run('2026-03-05T09:00:00.000Z', { durationMs: 900_000 }),
      run('2026-03-05T10:00:00.000Z', { durationMs: null }),
      run('2026-03-07T09:00:00.000Z', { key: 'kb-maintenance', label: 'Maintenance', durationMs: 120_000 }),
    ],
    WEEK,
  );
  const rows = parse(timesheetCsv(sheet));
  const numbers = (row: string[]) => row.slice(2, 9).map((text) => (text === '' ? null : Number(text)));
  const grid = (cells: Timesheet['perDay']) => cells.map((one) => (one.runs === 0 ? null : one.minutes));

  expect(rows[0]).toEqual(['Card', 'Title', ...sheet.days, 'Total minutes', 'Runs with no time']);
  expect(rows).toHaveLength(1 + sheet.rows.length + 1);
  for (const [index, row] of sheet.rows.entries()) {
    const parsed = rows[index + 1] ?? [];
    expect(parsed.slice(0, 2)).toEqual([row.key, row.label]);
    expect(numbers(parsed)).toEqual(grid(row.cells));
    expect(Number(parsed[9])).toBe(row.total.minutes);
    expect(Number(parsed[10])).toBe(row.total.untimed + row.total.running);
  }
  const last = rows[rows.length - 1] ?? [];
  expect(last[0]).toBe('Total');
  expect(numbers(last)).toEqual(grid(sheet.perDay));
  // The week total is the columns added up, so the file adds up to the grid's own figure.
  expect(Number(last[9])).toBe(sheet.total.minutes);
  expect(Number(last[9])).toBe(sheet.perDay.reduce((total, one) => total + one.minutes, 0));
});

// The last column holds every run the week could not time, and a run still going is one of them. The
// grid beside the file shows the running mark, so a nought here is the file disagreeing with it.
it('counts a run still going under the runs with no time', () => {
  const rows = parse(
    timesheetCsv(
      timesheetOf(
        [run('2026-03-02T09:00:00.000Z', { durationMs: null }), run('2026-03-03T09:00:00.000Z', { durationMs: null, running: true })],
        WEEK,
      ),
    ),
  );

  expect(rows[1]?.[10]).toBe('2');
  expect(rows[2]?.[10]).toBe('2');
});

// A title comes in from a ticket system, so it can hold anything. Each trap gets its own check: the
// parse has to give the title back and the row count must not change.
it('survives a comma, a quote and a newline in a title', () => {
  const rows = parse(
    timesheetCsv(
      timesheetOf(
        [
          run('2026-03-02T09:00:00.000Z', { key: 'APP-1', label: 'Search, fast' }),
          run('2026-03-02T10:00:00.000Z', { key: 'APP-2', label: 'The "quoted" box' }),
          run('2026-03-02T11:00:00.000Z', { key: 'APP-3', label: 'First line\r\nsecond line' }),
        ],
        WEEK,
      ),
    ),
  );

  expect(rows).toHaveLength(5);
  expect(rows.map((row) => row[1])).toEqual(['Title', 'Search, fast', 'The "quoted" box', 'First line second line', 'Every card']);
});

// A spreadsheet runs a cell starting with = as a formula even when the CSV quoted it, so the field
// carries a leading apostrophe. The round trip is not byte for byte on that one title, and that is
// the point: what comes back is text and not a sum.
it('guards a title a spreadsheet would run as a formula', () => {
  const titles = ['=1+1', '+49 hours', '-1 hour', '@card'];
  const runs = titles.map((title, index) => run('2026-03-02T09:00:00.000Z', { key: `APP-${index}`, label: title }));
  const rows = parse(timesheetCsv(timesheetOf(runs, WEEK)));

  expect(rows.slice(1, 5).map((row) => row[1])).toEqual(["'=1+1", "'+49 hours", "'-1 hour", "'@card"]);
  // The minutes beside it are numbers and are never guarded, so a parser reads them as numbers.
  expect(rows[1]?.[2]).toBe('1');
});

it('writes a non-ASCII title as it is, with CRLF lines and no byte order mark', () => {
  const csv = timesheetCsv(timesheetOf([run('2026-03-02T09:00:00.000Z', { label: 'Búsqueda rápida 日本語' })], WEEK));

  expect(parse(csv)[1]?.[1]).toBe('Búsqueda rápida 日本語');
  expect(csv.startsWith('Card,')).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  expect(csv.split('\r\n')).toHaveLength(4);
  expect(csv).not.toContain('﻿');
});

// The entries a time tracker takes, written out by hand, ids and all. Building the expected list
// from `timesheetEntries` would prove nothing about the id a destination stores for a year.
it('maps a week to one entry per card and day, with the project, the card and the minutes on each', () => {
  const sheet = timesheetOf(
    [
      run('2026-03-02T09:00:00.000Z', { durationMs: 1_800_000 }),
      run('2026-03-02T14:00:00.000Z', { durationMs: 900_000 }),
      run('2026-03-05T09:00:00.000Z', { durationMs: 3_600_000 }),
      run('2026-03-06T09:00:00.000Z', { key: 'APP-2', label: 'Print the shopping list', durationMs: 7_200_000 }),
    ],
    WEEK,
  );

  // Two runs on the Monday are one entry of 45 minutes, because a worklog is a day and not a run.
  // The stamp is the first of the two, so a destination in any zone files the day the grid drew.
  expect(timesheetEntries(sheet, 'acme-shop')).toEqual([
    { externalId: 'nolzu:acme-shop:APP-1:2026-03-02', project: 'acme-shop', day: '2026-03-02', start: '2026-03-02T09:00:00.000Z', card: 'APP-1', source: 'local', title: 'Add a search box', minutes: 45 },
    { externalId: 'nolzu:acme-shop:APP-1:2026-03-05', project: 'acme-shop', day: '2026-03-05', start: '2026-03-05T09:00:00.000Z', card: 'APP-1', source: 'local', title: 'Add a search box', minutes: 60 },
    { externalId: 'nolzu:acme-shop:APP-2:2026-03-06', project: 'acme-shop', day: '2026-03-06', start: '2026-03-06T09:00:00.000Z', card: 'APP-2', source: 'local', title: 'Print the shopping list', minutes: 120 },
  ]);
});

// The one fact a key cannot carry. A local card and a Jira issue are both spelled LETTERS-digits,
// and the default local prefix is APP, so a Jira project named APP would take `APP-7` as its own and
// log these hours on somebody else's issue. The source is what stops it, and a deleted card or a
// maintenance run answers null, which is not a ticket either.
it('says where each card key came from, so an export posts on a ticket key alone', () => {
  const sheet = timesheetOf(
    [
      run('2026-03-02T09:00:00.000Z', { key: 'APP-7', source: 'local' }),
      run('2026-03-02T09:00:00.000Z', { key: 'SHOP-3', source: 'jira' }),
      run('2026-03-02T09:00:00.000Z', { key: 'APP-9', label: 'APP-9, deleted', source: null }),
    ],
    WEEK,
  );

  expect(timesheetEntries(sheet, 'acme-shop').map((one) => [one.card, one.source])).toEqual([
    ['APP-7', 'local'],
    ['APP-9', null],
    ['SHOP-3', 'jira'],
  ]);
});

// The stamp is a real one and not midnight. A person in New York works at 09:00 on the Monday, which
// is 14:00Z. Midnight UTC would show the hour on the Sunday evening in Toggl, in the week before.
it('carries the first run stamp of the day, not midnight', () => {
  const sheet = timesheetOf([run('2026-03-02T14:00:00.000Z', { durationMs: 3_600_000 }), run('2026-03-02T19:30:00.000Z')], WEEK);
  const [entry] = timesheetEntries(sheet, 'acme-shop');

  expect(entry?.start).toBe('2026-03-02T14:00:00.000Z');
  expect(entry?.day).toBe('2026-03-02');
  // Read back in New York it is still the Monday. Midnight of the day would have been the Sunday.
  expect(new Date(entry?.start ?? '').toLocaleDateString('en-CA', { timeZone: 'America/New_York' })).toBe('2026-03-02');
  expect(new Date(`${entry?.day}T00:00:00.000Z`).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })).toBe('2026-03-01');
});

// The dedup the four adapters lean on. The second export of the week carries one more run on a day
// already sent and a longer title, and the id does not move, so the store still recognises the day.
it('gives the same ids on a second export of the same week', () => {
  const first = timesheetEntries(timesheetOf([run('2026-03-02T09:00:00.000Z', { durationMs: 1_800_000 })], WEEK), 'acme-shop');
  const second = timesheetEntries(
    timesheetOf(
      [
        run('2026-03-02T09:00:00.000Z', { durationMs: 1_800_000 }),
        run('2026-03-02T15:00:00.000Z', { durationMs: 600_000, label: 'Add a search box to the header' }),
      ],
      WEEK,
    ),
    'acme-shop',
  );

  expect(first.map((one) => one.externalId)).toEqual(['nolzu:acme-shop:APP-1:2026-03-02']);
  expect(second.map((one) => one.externalId)).toEqual(['nolzu:acme-shop:APP-1:2026-03-02']);
  expect(first[0]?.minutes).toBe(30);
  expect(second[0]?.minutes).toBe(40);
});

// A key and a project a ticket system wrote. Encoded part by part, so two different pairs can never
// spell one id and post one card's hours under another card's name.
it('keeps a colon in a key or a project out of the id', () => {
  const sheet = timesheetOf([run('2026-03-02T09:00:00.000Z', { key: 'a:b' })], WEEK);

  expect(timesheetEntries(sheet, 'one').map((one) => one.externalId)).toEqual(['nolzu:one:a%3Ab:2026-03-02']);
  // The project is encoded as well. A project name is free text, so a colon, a space or a percent in
  // one would otherwise land in the id a destination stores for a year.
  expect(timesheetEntries(sheet, 'a:b').map((one) => one.externalId)).toEqual(['nolzu:a%3Ab:a%3Ab:2026-03-02']);
  expect(timesheetEntries(sheet, 'a b%c').map((one) => one.externalId)).toEqual(['nolzu:a%20b%25c:a%3Ab:2026-03-02']);
});

// A run the engine never timed is left out rather than sent as nought, which is the rule the whole
// column is built on. The grid still counts it, so the two screens do not disagree.
it('leaves out a run that reported no duration', () => {
  const sheet = timesheetOf(
    [
      run('2026-03-02T09:00:00.000Z', { durationMs: null }),
      run('2026-03-03T09:00:00.000Z', { durationMs: null, running: true }),
      run('2026-03-04T09:00:00.000Z', { durationMs: 600_000 }),
      run('2026-03-04T11:00:00.000Z', { durationMs: null }),
    ],
    WEEK,
  );

  expect(timesheetEntries(sheet, 'acme-shop')).toEqual([
    { externalId: 'nolzu:acme-shop:APP-1:2026-03-04', project: 'acme-shop', day: '2026-03-04', start: '2026-03-04T09:00:00.000Z', card: 'APP-1', source: 'local', title: 'Add a search box', minutes: 10 },
  ]);
  expect(sheet.total.runs).toBe(4);
  expect(sheet.total.untimed + sheet.total.running).toBe(3);
});

// The week billed is the week drawn. A deleted card and a maintenance run keep their hours, and the
// Thursday run of twenty seconds rounds to nought in the grid, so it is in neither figure.
it('exports entries that add up to the week the grid shows', () => {
  const sheet = timesheetOf(
    [
      run('2026-03-02T09:00:00.000Z', { durationMs: 1_800_000 }),
      run('2026-03-03T09:00:00.000Z', { key: 'APP-9', label: 'APP-9, deleted', durationMs: 600_000 }),
      run('2026-03-04T09:00:00.000Z', { key: 'kb-maintenance', label: 'Maintenance', durationMs: 1_200_000 }),
      run('2026-03-05T09:00:00.000Z', { durationMs: 20_000 }),
    ],
    WEEK,
  );
  const entries = timesheetEntries(sheet, 'acme-shop');

  expect(entries.map((one) => [one.card, one.title, one.day, one.minutes])).toEqual([
    ['APP-1', 'Add a search box', '2026-03-02', 30],
    ['APP-9', 'APP-9, deleted', '2026-03-03', 10],
    ['kb-maintenance', 'Maintenance', '2026-03-04', 20],
  ]);
  expect(sheet.total.minutes).toBe(60);
  expect(entries.reduce((total, one) => total + one.minutes, 0)).toBe(60);
});
