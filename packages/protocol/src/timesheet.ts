import { oneLine, utcDay } from './evidence.ts';

/**
 * The week grid and the file it exports.
 *
 * Pure, the way `evidence.ts` is. It takes the runs of a week, already carrying UTC stamps, and
 * gives back one object. The grid draws that object and the CSV is written from the same one, so the
 * screen and the file cannot show different numbers.
 *
 * Minutes are rounded here and nowhere else. `EvidenceBlock.durationMs` stays the engine's own
 * figure on purpose, and this is the column that rounds it.
 */

// One run, as the grid reads it. `key` is the run's stored card key, which survives a card that was
// deleted. `EvidenceBlock.card` cannot carry it: that field is null for a maintenance run and for a
// deleted card both, and a timesheet must not add one row's hours to the other's.
export interface TimesheetRun {
  // A UTC stamp with the Z on it, the same shape a block's `start` has.
  start: string;
  key: string;
  // What the row is called on screen and in the file.
  label: string;
  // Where the card came from: `cards.source`, so 'local' for a card this app numbered and the
  // adapter's name for one pulled from a ticket system. Null when no card row answers the key any
  // more, which is a deleted card and a maintenance run. A key alone cannot carry this: a local key
  // and a Jira key are spelled the same way, `LETTERS-digits`, and the default local prefix is APP.
  source: string | null;
  // What the engine reported. Null is not nought: the run reported nothing.
  durationMs: number | null;
  running: boolean;
}

// One day of one row, and the shape every total uses as well. `minutes` covers the runs that
// reported a duration and no others, so `untimed` and `running` say how many runs it leaves out. A
// figure of 12 with a run that reported nothing beside it is not twelve minutes of work.
export interface TimesheetCell {
  minutes: number;
  runs: number;
  // Ended, and reported no duration.
  untimed: number;
  // Not ended yet, so it has no duration to report. A timesheet never bills an unfinished run.
  running: number;
}

// One card, or one owner a card cannot be found for. `cells` is seven long and in the order of
// `Timesheet.days`.
export interface TimesheetRow {
  key: string;
  label: string;
  // The card's source, as `TimesheetRun` carries it.
  source: string | null;
  cells: TimesheetCell[];
  // The first run stamp of each day, beside `cells` and in the same order, or null for a day with no
  // run. It sits here and not on the cell because a cell is also a total, and a total of seven days
  // has no one instant. An export needs it: a day alone would place the work at midnight UTC, which
  // is the day before for anyone west of Greenwich.
  starts: (string | null)[];
  total: TimesheetCell;
}

export interface Timesheet {
  // The Monday the week starts on, `YYYY-MM-DD`.
  week: string;
  // Seven UTC days, Monday first. Always seven, so the file has the same shape on any day of the
  // week and a parser reads the same columns every time.
  days: string[];
  // One row per owner that has a run in the week, by key. A card with no run in the week has no row:
  // a freelancer's board holds cards that cost no time this week.
  rows: TimesheetRow[];
  perDay: TimesheetCell[];
  total: TimesheetCell;
}

// An empty week says so rather than drawing seven empty columns, the way `NO_EVIDENCE` does for a
// day. Named here so a test reads the words without mounting anything.
export const NO_TIMESHEET = 'No run in this week. A row appears here when a run starts on a card.';

// A week starts on Monday, in UTC. Monday is the ISO week and the week the dates this app prints
// already read in. UTC because a day is the first ten characters of the stamp, so a boundary in any
// other zone would cut a day in half and the grid would disagree with the timeline about which
// column a run sits in.
export function weekOf(day: string): string {
  const at = new Date(`${utcDay(day)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return utcDay(at.toISOString());
}

/** The seven UTC days of the week that starts on this Monday, Monday first. */
export function weekDays(monday: string): string[] {
  const start = new Date(`${monday}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return utcDay(day.toISOString());
  });
}

/** The one place milliseconds become minutes, so the grid and the file round the same way. */
export const minutesOf = (ms: number): number => Math.round(ms / 60_000);

const add = (numbers: readonly number[]) => numbers.reduce((total, number) => total + number, 0);

const EMPTY: TimesheetCell = { minutes: 0, runs: 0, untimed: 0, running: 0 };

// Every total is the printed cells added up, never a fresh sum of milliseconds. Rounding twice would
// leave a row total that is not the sum of the cells a person can see, and the file would then not
// add up to the grid.
const addCells = (cells: readonly TimesheetCell[]): TimesheetCell => ({
  minutes: add(cells.map((cell) => cell.minutes)),
  runs: add(cells.map((cell) => cell.runs)),
  untimed: add(cells.map((cell) => cell.untimed)),
  running: add(cells.map((cell) => cell.running)),
});

// Rounded once, from the millisecond figures of this cell added together, so two runs of forty
// seconds read as one minute and not as nought. A run that reported no duration adds nothing and is
// counted instead, because `Spend.durationMs` would add it as zero and a timesheet is the screen
// where that lie shows.
function cellOf(runs: readonly TimesheetRun[]): TimesheetCell {
  return {
    minutes: minutesOf(add(runs.map((run) => run.durationMs ?? 0))),
    runs: runs.length,
    untimed: runs.filter((run) => run.durationMs === null && !run.running).length,
    running: runs.filter((run) => run.running).length,
  };
}

// The earliest stamp of a day's runs. Stamps are UTC with the Z on them, so they compare as text.
const firstStart = (runs: readonly TimesheetRun[]): string | null =>
  runs.reduce<string | null>((first, run) => (first !== null && first <= run.start ? first : run.start), null);

/**
 * The week grid. Runs outside the seven days are dropped here, so a caller hands over whatever it
 * has and the week rule is applied in one place.
 *
 * Rows are sorted by key, so the grid and the file read the same way on every load.
 */
export function timesheetOf(runs: readonly TimesheetRun[], week: string): Timesheet {
  const days = weekDays(week);
  const owners = new Map<string, { label: string; source: string | null; runs: TimesheetRun[] }>();
  for (const run of runs) {
    if (!days.includes(utcDay(run.start))) continue;
    const mine = owners.get(run.key);
    if (mine === undefined) owners.set(run.key, { label: run.label, source: run.source, runs: [run] });
    else mine.runs.push(run);
  }

  const rows = [...owners]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, mine]) => {
      const byDay = days.map((day) => mine.runs.filter((run) => utcDay(run.start) === day));
      const cells = byDay.map(cellOf);
      return { key, label: mine.label, source: mine.source, cells, starts: byDay.map(firstStart), total: addCells(cells) };
    });
  const perDay = days.map((_, index) => addCells(rows.map((row) => row.cells[index] ?? EMPTY)));
  return { week, days, rows, perDay, total: addCells(perDay) };
}

// Nothing when no run touched the cell, the figure otherwise. So an empty cell reads as no work and
// a run the engine timed under half a minute reads as 0, which is a reported nought.
const cellText = (cell: TimesheetCell): string => (cell.runs === 0 ? '' : String(cell.minutes));

// A spreadsheet runs a cell that starts with one of these as a formula, whatever quoting is around
// it, so a text field gets a leading apostrophe. Card titles arrive from outside through the ticket
// adapters, so they are not ours to trust. A number is never guarded: these figures are never
// negative, so none of them starts with a character this looks at.
const guarded = (text: string): string => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

// A newline inside a title would give the file more lines than rows, and every parser that splits on
// the line ending would then read a wrong row count that still looks right. `oneLine` is that rule
// and this adds the spreadsheet guard on top, so the package holds the newline rule once.
const flat = (text: string): string => guarded(oneLine(text));

// Quoted only when it has to be, so a number stays a bare number a spreadsheet reads as one. An
// inner quote is written twice, which is the escape RFC 4180 gives. A backslash is not an escape
// here, so `JSON.stringify` is the wrong quoter however handy it looks.
const field = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * The week as a CSV file, for a spreadsheet and not for a reader: plain integers, no formatted
 * durations and no currency. `formatDuration` and `formatCost` write words no parser reads back.
 *
 * CRLF and no byte order mark, which is RFC 4180 and plain UTF-8, the way every other text this app
 * hands out is written. An empty week is the header row alone, which is the honest answer for a week
 * with no run.
 */
export function timesheetCsv(sheet: Timesheet): string {
  const line = (fields: readonly string[]) => `${fields.map(field).join(',')}\r\n`;
  const row = (key: string, label: string, cells: readonly TimesheetCell[], total: TimesheetCell) =>
    line([flat(key), flat(label), ...cells.map(cellText), String(total.minutes), String(total.untimed + total.running)]);

  return [
    line(['Card', 'Title', ...sheet.days, 'Total minutes', 'Runs with no time']),
    ...sheet.rows.map((one) => row(one.key, one.label, one.cells, one.total)),
    // No total row on an empty week: there is nothing to total.
    ...(sheet.rows.length === 0 ? [] : [row('Total', 'Every card', sheet.perDay, sheet.total)]),
  ].join('');
}

// One card's work on one UTC day, the way a time tracker takes it. Toggl, Harvest, Clockify and the
// Jira worklog differ in the field names and the unit, not in the facts, so the week is mapped once
// here and each adapter converts from this shape.
export interface TimesheetEntry {
  // What the export files the entry under, so a second export of the same week finds it and writes
  // nothing twice.
  externalId: string;
  project: string;
  // `YYYY-MM-DD`, the UTC day the runs started on, which is the column the grid drew them in.
  day: string;
  // `YYYY-MM-DDTHH:MM:SS.sssZ`, the first run of that day. The day above says which column the grid
  // drew, and this says when the work started, which is what Toggl, Clockify and a Jira worklog ask
  // for. Midnight of `day` would be the day before for anyone west of Greenwich.
  start: string;
  // The run's stored card key. It outlives a deleted card, and a maintenance run keeps the key it
  // ran under, so hours with no card on the board are still exported and the week still adds up.
  card: string;
  // Where the key came from, so a destination knows whether it is a ticket key it can post against.
  // 'local' is a key this app numbered and no ticket system knows. Null is a key with no card row
  // behind it any more, which is a deleted card and a maintenance run. The Jira export skips
  // anything but 'jira' and says why: a local `APP-7` and a Jira `APP-7` are spelled the same, so
  // posting on the key alone would put these hours on a stranger's issue.
  source: string | null;
  // What the row is called. A person types it or a ticket adapter writes it, so it can change
  // between two exports and is never part of the id.
  title: string;
  // The cell's own figure, rounded once by `cellOf` and never again. Never nought.
  minutes: number;
}

// Project, card and day, and nothing that changes. The figure is left out on purpose: a run added to
// a day that was exported already keeps that day's id, so the export finds the entry instead of
// billing the same day twice. Each part is encoded, because a card key comes from a ticket system
// and a colon inside one would otherwise read as a separator. The destination is not in the id
// either: the same hours carry one id everywhere, and the store tells destinations apart by the
// connection the id is filed under.
const entryId = (project: string, card: string, day: string): string =>
  `nolzu:${encodeURIComponent(project)}:${encodeURIComponent(card)}:${day}`;

/**
 * One week of work as time tracker entries, one per card and day.
 *
 * Read off the grid and not off the runs a second time, so an entry cannot disagree with the cell a
 * person saw before pressing export, and the minutes of a week's entries add up to the week's total.
 * One entry per day is also what a Jira worklog asks for.
 *
 * A cell with no minutes is left out. A run that reported no duration adds nothing to its cell, so a
 * day holding only such runs has no entry at all: no destination is told the work took nought.
 *
 * The sheet holds one project, because `project` is stamped on every entry and nothing here checks
 * it. `timesheetOf` groups by card key alone, and two projects share the maintenance key and can
 * share a card prefix, so a sheet built from two of them would bill one for the other's hours.
 */
export function timesheetEntries(sheet: Timesheet, project: string): TimesheetEntry[] {
  return sheet.rows.flatMap((row) =>
    sheet.days.flatMap((day, index): TimesheetEntry[] => {
      const minutes = row.cells[index]?.minutes ?? 0;
      const start = row.starts[index] ?? null;
      // A cell with minutes has a run, so it has a stamp. No stamp, no entry: a guessed instant is
      // worse than a day left out of the export.
      if (minutes === 0 || start === null) return [];
      return [
        { externalId: entryId(project, row.key, day), project, day, start, card: row.key, source: row.source, title: row.label, minutes },
      ];
    }),
  );
}
