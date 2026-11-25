import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '@nolzu/core';
import { allRuns, getSetting, settingProblem, writeSetting } from '@nolzu/core/node';
import { isMaintenanceKey, type Timesheet, type TimesheetRun, timesheetOf, weekOf } from '@nolzu/protocol';

/**
 * What the timesheet panel reads. The rules are in `@nolzu/protocol`; this file reads the rows and
 * names them, the way `evidence.ts` does for the timeline.
 *
 * Runs only, and no git call: a cell counts the minutes an engine reported, and a move and a commit
 * report none. It reads the whole runs table once, so a week costs one query.
 */

export interface TimesheetOptions {
  // The Monday of the week to read, `YYYY-MM-DD`. This week by default, and injectable so a test
  // pins a week without faking the clock.
  week?: string;
}

const thisWeek = () => weekOf(new Date().toISOString().slice(0, 10));

// A run's `card_key` has no foreign key behind it, so it can name a card that was deleted or the key
// a maintenance run holds. Those hours were still worked, so each gets its own row: a deleted card's
// row keeps the key it was billed under, and maintenance is not client work.
function label(key: string, titles: Map<string, string>): string {
  const title = titles.get(key);
  if (title !== undefined) return title;
  // Delete card moves the runs to `deletedKey`, which says it already. No card key holds a space.
  if (key.endsWith(' (deleted)')) return key;
  return isMaintenanceKey(key) ? 'Maintenance' : `${key}, deleted`;
}

/** One week of run minutes, this week by default. */
export function timesheetFor(db: DatabaseSync, options: TimesheetOptions = {}): Timesheet {
  const rows = db.prepare('SELECT key, title, source FROM cards ORDER BY key').all() as unknown as {
    key: string;
    title: string;
    source: string;
  }[];
  const titles = new Map(rows.map((row) => [row.key, row.title]));
  // Where the key came from, for an export that may only post against a real ticket. A key with no
  // row left answers null, which is a deleted card and a maintenance run.
  const sources = new Map(rows.map((row) => [row.key, row.source]));

  // A queued run has no start, so it is in no column. The cost report drops it for the same reason:
  // putting it under today would invent a day it never ran on.
  const runs = allRuns(db).flatMap((run): TimesheetRun[] =>
    run.startedAt === null
      ? []
      : [
          {
            start: run.startedAt,
            key: run.cardKey,
            label: label(run.cardKey, titles),
            source: sources.get(run.cardKey) ?? null,
            durationMs: run.durationMs,
            running: run.endedAt === null,
          },
        ],
  );
  return timesheetOf(runs, options.week ?? thisWeek());
}

// The Monday a number of weeks away, for the previous and next week links on the evidence screen.
// UTC arithmetic, because the week the grid draws is a UTC week.
export function weekShift(monday: string, weeks: number): string {
  const at = new Date(`${monday}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + weeks * 7);
  return at.toISOString().slice(0, 10);
}

// What Evidence asks for so it can show value next to cost. All three are optional, and nothing
// on Free reads them.
export interface Billing {
  clientName: string | null;
  hourlyRate: number | null;
  currency: string;
}

export const billingFor = (db: DatabaseSync): Billing => ({ clientName: getSetting(db, 'clientName'), hourlyRate: getSetting(db, 'hourlyRate'), currency: getSetting(db, 'currency') });

/**
 * Whether this visit shows "Bill this project?": true on the first visit of a project with no client
 * and no rate, and never again. The visit itself is stored, so a save, "Not now" and a visit that
 * ignored the prompt all end it the same way. The three fields stay at #billing for a later answer.
 */
export function billingPrompt(db: DatabaseSync): boolean {
  if (getSetting(db, 'billingAsked') || getSetting(db, 'clientName') !== null || getSetting(db, 'hourlyRate') !== null) return false;
  writeSetting(db, 'billingAsked', true);
  return true;
}

/**
 * Saves the client, the rate and the currency as typed, or stores none of them and names the first
 * one refused, in its setting's words.
 *
 * An empty box takes the answer back, and USD is the currency's default. The rate goes through
 * `Number`, so text lands as NaN and the setting's own sentence refuses it.
 */
export function saveBilling(db: DatabaseSync, typed: { client: string; rate: string; currency: string }): { field: keyof Billing; message: string } | null {
  const client = typed.client.trim();
  const rate = typed.rate.trim();
  const currency = typed.currency.trim();
  const billing: Billing = { clientName: client === '' ? null : client, hourlyRate: rate === '' ? null : Number(rate), currency: currency === '' ? DEFAULTS.currency : currency.toUpperCase() };
  for (const field of ['clientName', 'hourlyRate', 'currency'] as const) {
    const refused = settingProblem(db, field, billing[field]);
    if (refused !== null) return { field, message: refused };
  }
  writeSetting(db, 'clientName', billing.clientName);
  writeSetting(db, 'hourlyRate', billing.hourlyRate);
  writeSetting(db, 'currency', billing.currency);
  return null;
}
