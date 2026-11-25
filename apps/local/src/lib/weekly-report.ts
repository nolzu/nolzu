import type { DatabaseSync } from 'node:sqlite';
import { allRuns } from '@nolzu/core/node';
import { formatCost, oneLine, type Spend, spendOf, type TimesheetCell, utcDay, weekOf } from '@nolzu/protocol';
import { projectName } from './app-header.ts';
import { timesheetFor } from './timesheet.ts';

/**
 * The week of work the hub asks for and the web app shows.
 *
 * What the machine shipped on its project: each card with its
 * minutes and cost, the pull request of a card made from one, and a total. One database is one
 * project, so a machine writes one report and the hub keeps the reports of several machines.
 *
 * Every number here is a number another screen already shows. Minutes come from the timesheet,
 * which rounds once per cell and adds the cells up. Money comes from `spendOf`, which never adds a
 * cost nobody reported as zero. A fresh sum in this file would be a second answer to the same
 * question.
 *
 * This is not the standup. `standupText` carries no number on purpose, because what a run cost is
 * the freelancer's figure and not their team's. This text is written for the freelancer.
 */

// What a week with no run says, rather than handing a person an empty box to paste. Same shape as
// `NO_STANDUP`, because the same person reads both.
export const NO_WEEKLY_WORK = 'Nothing recorded in this week.';

const count = (many: number, word: string): string => `${many} ${word}${many === 1 ? '' : 's'}`;

// The runs that brought no minutes are counted beside them. A figure of 45 with a run that reported
// nothing behind it is not forty five minutes of work, which is the rule the timesheet keeps on
// screen as well. The two states stay apart in the words, the way the screen keeps them apart: a run
// that ended and reported no duration has answered, a run still going has not been asked yet.
const timeLine = (cell: TimesheetCell): string => {
  const missing = [
    ...(cell.untimed === 0 ? [] : [`${cell.untimed} reported no time`]),
    ...(cell.running === 0 ? [] : [`${cell.running} still going`]),
  ];
  return `- ${count(cell.minutes, 'minute')} over ${count(cell.runs, 'run')}${missing.length === 0 ? '' : `, ${missing.join(', ')}`}`;
};

// A cost nobody reported stays missing, the way `mergeSpend` keeps it missing. It is never a zero,
// and the sentence says how many runs the figure is short of.
//
// The word "estimated" is on the money because the figure is the engine's own estimate, from the
// token counts it reports, and is labelled so everywhere. This text
// leaves the machine and gets pasted, so it carries the label with it the way the run log does.
const costLine = (spend: Spend): string => {
  if (spend.costUsd === null) return '- No cost reported';
  const missing = spend.runs - spend.reported;
  return `- ${formatCost(spend.costUsd)} estimated${missing === 0 ? '' : `, short of ${count(missing, 'run')} that reported none`}`;
};

interface CardRow {
  key: string;
  title: string;
  source: string;
  source_ref: string | null;
}

// The reference a card made from a pull request carries, word for word. `parseTicketRef` takes a
// full URL, `owner/repo#42` and `repo#42`, and no row says which host any of them came from, so no
// link is built here. A card from a ticket adapter carries a reference too and it is not a pull
// request, which is what the source is read for.
const pullOf = (card: CardRow | undefined): string | null =>
  card !== undefined && card.source === 'github-pr' && card.source_ref !== null ? card.source_ref : null;

/**
 * One week of work as text, for the week the given day falls in.
 *
 * The day arrives with the job from the hub, so a job that waited in the queue still reports the
 * week it was queued for. `weekOf` turns it into the Monday, so any day of that week names the same
 * report.
 */
export function weeklyReportFor(db: DatabaseSync, day: string): string {
  const week = weekOf(day);
  const sheet = timesheetFor(db, { week });
  const days = new Set(sheet.days);
  const cards = new Map(
    (db.prepare('SELECT key, title, source, source_ref FROM cards').all() as unknown as CardRow[]).map((row) => [row.key, row]),
  );
  // The runs the sheet counted and no others: a run with no start is in no week, and a run outside
  // these seven days belongs to another report.
  const inWeek = allRuns(db).filter((run) => run.startedAt !== null && days.has(utcDay(run.startedAt)));

  // Limit: one pass over the week's runs per row, because a week holds tens of runs. Group them
  // into a Map by card key if a week ever holds thousands.
  const groups = sheet.rows.map((row) => {
    const card = cards.get(row.key);
    const pull = pullOf(card);
    return [
      // The key and the title, the way the standup heads a group. The timesheet's own label is the
      // answer for a key this database holds no card for: a deleted card, or maintenance.
      card === undefined ? oneLine(row.label) : `${oneLine(row.key)}, ${oneLine(card.title)}`,
      timeLine(row.total),
      costLine(spendOf(inWeek.filter((run) => run.cardKey === row.key))),
      ...(pull === null ? [] : [`- Pull request ${pull}`]),
    ].join('\n');
  });

  // The folder name, the way the rail shows it. A machine with no project folder writes no name
  // rather than a sentence about one. Flattened like every other value here: a folder name is
  // whatever the person named their folder, and the only check on `projectPath` is that it starts
  // with a slash, so a newline in it would put a line of its own where a card heading sits.
  const name = projectName(db);
  const top = [`What I shipped, week of ${week}, the UTC week`, ...(name === null ? [] : [oneLine(name)])].join('\n');
  const total = ['Total', timeLine(sheet.total), costLine(spendOf(inWeek))].join('\n');
  // No trailing newline: the person pastes this into a message box.
  return [top, ...(groups.length === 0 ? [NO_WEEKLY_WORK] : [...groups, total])].join('\n\n');
}
