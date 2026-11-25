import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { weeklyReportFor } from './weekly-report.ts';

// The weekly report, the client half. One week, pinned, because the whole feature is about which week a run
// belongs to: 2026-03-02 is a Monday and 2026-03-08 closes its week. The suite runs with TZ=UTC, so
// a stamp written here is the stamp the fold reads. Every expected text below is typed out by hand.
const WEEK = '2026-03-02';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-weekly-'));
  db = openDatabase(dir);
  writeSetting(db, 'projectPath', join(dir, 'recipes'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function card(key: string, title: string, source = 'local', ref: string | null = null): void {
  db.prepare("INSERT INTO cards (key, board, stage, state, title, source, source_ref) VALUES (?, 'delivery', 'implement', 'idle', ?, ?, ?)").run(
    key,
    title,
    source,
    ref,
  );
}

// A run with its times set by hand, the way the timesheet test writes one. The duration is its own
// field and does not follow the two stamps, because a run can report none. `ended: null` writes a run
// that is still going, which is the other way a run brings no minutes.
function run(over: { card?: string; started: string; ended?: string | null; ms?: number | null; cost?: number | null }): void {
  const written = db
    .prepare("INSERT INTO runs (card_key, phase, engine, log_path, state) VALUES (?, 'implement', 'claude-code', ?, 'complete')")
    .run(over.card ?? 'APP-1', join(dir, 'run.ndjson'));
  db.prepare('UPDATE runs SET started_at = ?, ended_at = ?, cost_estimate = ?, duration_ms = ? WHERE id = ?').run(
    over.started,
    over.ended === undefined ? over.started : over.ended,
    over.cost ?? null,
    over.ms === undefined ? 60_000 : over.ms,
    Number(written.lastInsertRowid),
  );
}

// The whole text, word for word. A card with a pull request and a card without, a run that reported
// a cost and one that did not, and the total under both.
it('writes the week grouped by card, with the pull request and the cost of each', () => {
  card('APP-1', 'Add a search box', 'github-pr', 'owner/recipes#42');
  card('APP-2', 'Print the shopping list');
  run({ started: `${WEEK}T09:00:00.000Z`, ms: 1_800_000, cost: 0.8 });
  run({ started: '2026-03-04T15:00:00.000Z', ms: 900_000, cost: 0.4 });
  run({ card: 'APP-2', started: '2026-03-06T09:00:00.000Z', ms: 300_000, cost: null });
  // The week before, on a card this week has a row for. The minutes are filtered by the timesheet, the
  // money by this file, so a week of money that leaks in shows up here and nowhere else.
  run({ started: '2026-02-25T09:00:00.000Z', ms: 1_800_000, cost: 5 });

  expect(weeklyReportFor(db, WEEK)).toBe(
    [
      'What I shipped, week of 2026-03-02, the UTC week',
      'recipes',
      '',
      'APP-1, Add a search box',
      '- 45 minutes over 2 runs',
      '- $1.20 estimated',
      '- Pull request owner/recipes#42',
      '',
      'APP-2, Print the shopping list',
      '- 5 minutes over 1 run',
      '- No cost reported',
      '',
      'Total',
      '- 50 minutes over 3 runs',
      '- $1.20 estimated, short of 1 run that reported none',
    ].join('\n'),
  );
});

// A week with no run says so, and a run of the week before is not dragged into it.
it('says nothing was recorded in a week with no run', () => {
  card('APP-1', 'Add a search box');
  run({ started: '2026-02-25T09:00:00.000Z', ms: 1_800_000, cost: 0.8 });

  expect(weeklyReportFor(db, WEEK)).toBe(
    ['What I shipped, week of 2026-03-02, the UTC week', 'recipes', '', 'Nothing recorded in this week.'].join('\n'),
  );
});

// The job may name any day of the week. The report is the week that day falls in, so a job queued on
// Monday and taken on Thursday writes the same report.
it('reports the week the day falls in, not the day itself', () => {
  card('APP-1', 'Add a search box');
  run({ started: `${WEEK}T09:00:00.000Z`, ms: 600_000, cost: 0.5 });

  expect(weeklyReportFor(db, '2026-03-05')).toBe(weeklyReportFor(db, WEEK));
  expect(weeklyReportFor(db, '2026-03-05').split('\n')[0]).toBe('What I shipped, week of 2026-03-02, the UTC week');
});

// A reference from a ticket adapter is not a pull request. Only a card made from a pull request has
// one, and a cost nobody reported is never printed as money.
it('leaves out the pull request line for a card that came from no pull request', () => {
  card('APP-1', 'Add a search box', 'jira', 'PROJ-123');
  run({ started: `${WEEK}T09:00:00.000Z`, ms: 600_000, cost: null });

  const text = weeklyReportFor(db, WEEK);

  expect(text).not.toContain('Pull request');
  expect(text).not.toContain('PROJ-123');
  expect(text).not.toContain('$0.00');
  expect(text).toContain('- No cost reported');
});

// A run whose card this database no longer holds, and a maintenance run. Both worked hours, and
// neither has a title to head the group with.
it('heads a group the timesheet way when no card row is left', () => {
  run({ card: KB_MAINTENANCE_KEY, started: `${WEEK}T09:00:00.000Z`, ms: 600_000, cost: 0.25 });
  run({ card: 'APP-9', started: `${WEEK}T10:00:00.000Z`, ms: 600_000, cost: 0.25 });

  const text = weeklyReportFor(db, WEEK);

  expect(text).toContain('\nAPP-9, deleted\n- 10 minutes over 1 run\n- $0.25 estimated');
  expect(text).toContain('\nMaintenance\n- 10 minutes over 1 run\n- $0.25 estimated');
});

// A run that brought no minutes is counted, never billed. The minutes would otherwise read as an
// honest nought. The two ways a run brings none are named apart: one ended and reported no duration,
// the other has not ended yet and has nothing to report.
it('counts a run that reported no time and a run still going beside the minutes', () => {
  card('APP-1', 'Add a search box');
  run({ started: `${WEEK}T09:00:00.000Z`, ms: null, cost: 0.1 });
  run({ started: `${WEEK}T11:00:00.000Z`, ended: null, ms: null, cost: null });

  expect(weeklyReportFor(db, WEEK)).toContain('- 0 minutes over 2 runs, 1 reported no time, 1 still going');
});

// The lines are the whole meaning of this text, and a title is typed by a person or brought in by a
// ticket adapter. A title that holds a newline writes no line of its own.
it('keeps a card title on one line', () => {
  card('APP-1', 'Fix login\n- 99 minutes over 9 runs');
  run({ started: `${WEEK}T09:00:00.000Z`, ms: 600_000, cost: 0.1 });

  const text = weeklyReportFor(db, WEEK);

  expect(text).toContain('APP-1, Fix login - 99 minutes over 9 runs\n- 10 minutes over 1 run\n- $0.10 estimated');
  expect(text).not.toContain('\n- 99 minutes over 9 runs');
});

// The folder name is whatever the person named their folder. `projectPath` is only checked for a
// leading slash, so a newline in it would put a line of its own exactly where a card heading sits,
// and this text is sent to the hub for the board.
it('keeps the project folder name on one line', () => {
  writeSetting(db, 'projectPath', join(dir, 'recipes\n\nAPP-9, Ship it'));
  card('APP-1', 'Add a search box');
  run({ card: 'APP-1', started: `${WEEK}T09:00:00.000Z`, ms: 600_000 });

  const text = weeklyReportFor(db, WEEK);

  // A run of newlines folds to one space, not one space per newline.
  expect(text).toContain('recipes APP-9, Ship it');
  expect(text).not.toContain('\nAPP-9, Ship it');
});

