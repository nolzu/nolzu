import type { DatabaseSync } from 'node:sqlite';
import { type Effort, type EngineName, type Estimate, estimateSum } from '@nolzu/protocol';
import { type EstimateSample, estimateOf, historyEstimate } from '../estimate.ts';
import { isAction, presetRange } from '../models.ts';
import { boardVersion } from './db.ts';

interface Row {
  engine: string;
  phase: string;
  asked_model: string;
  effort: string;
  cost_estimate: number | null;
  started_at: string;
  ended_at: string;
}

// Keyed by vendor too, because one model name can run on two vendors at two prices. The vendor is the
// part of a profile id before `#`, so a second login of one vendor counts as the same run.
const keyOf = (vendor: string | undefined, phase: string, model: string, effort: string) => JSON.stringify([vendor ?? '', phase, model, effort]);
const vendorOf = (profile: string) => profile.split('#')[0];

// One per project database. A finished run moves the board version, so the version is what says the
// history changed, and every snapshot in between reads the figures from here.
const held = new WeakMap<DatabaseSync, { version: number; figures: Map<string, Estimate> }>();

/**
 * The history figure of every phase, model and effort this project has enough runs of.
 *
 * A sample is a completed first run. Complete includes a run that ended on a question, because a
 * drop starts exactly that run and the answer is a start of its own. A row from before the resumed
 * column is null there and left out, since nothing says what kind of run it was.
 */
function history(db: DatabaseSync): Map<string, Estimate> {
  const version = boardVersion(db);
  const cached = held.get(db);
  if (cached?.version === version) return cached.figures;

  // Every card counts, whatever size an older row kept: no one picks a size any more, and a run
  // outlives a card that is gone.
  const rows = db
    .prepare(
      `SELECT r.engine, r.phase, r.asked_model, r.effort, r.cost_estimate, r.started_at, r.ended_at
       FROM runs r
       WHERE r.state = 'complete' AND r.resumed = 0 AND r.asked_model IS NOT NULL AND r.effort IS NOT NULL
         AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL`,
    )
    .all() as unknown as Row[];
  const all = new Map<string, EstimateSample[]>();
  for (const row of rows) {
    const wallMs = Date.parse(row.ended_at) - Date.parse(row.started_at);
    // A clock set back during a run gives no wall time worth reading.
    if (!(wallMs >= 0)) continue;
    const key = keyOf(vendorOf(row.engine), row.phase, row.asked_model, row.effort);
    const sample = { costUsd: row.cost_estimate, wallMs };
    const group = all.get(key);
    if (group === undefined) all.set(key, [sample]);
    else group.push(sample);
  }
  const figures = new Map<string, Estimate>();
  for (const [key, samples] of all) {
    const found = historyEstimate(samples);
    if (found !== null) figures.set(key, found);
  }
  held.set(db, { version, figures });
  return figures;
}

// What a start of this phase on this vendor, model and effort will likely cost and take, or undefined when
// neither the project's runs nor the preset measured it.
export function startEstimate(db: DatabaseSync, start: { phase: string; model: string; effort: Effort; vendor: EngineName | undefined }): Estimate | undefined {
  const found = history(db).get(keyOf(start.vendor, start.phase, start.model, start.effort));
  if (found !== undefined) return found;
  const range = isAction(start.phase) ? presetRange(start.vendor, start.phase, start.model, start.effort) : null;
  return estimateOf([], range) ?? undefined;
}

/**
 * What a card costs and takes when each of its steps runs on the engine profile, model and effort
 * given, or undefined when one step has too few measured runs.
 *
 * Read over this project's own runs, and never off a preset's range: a sum with one made-up step is a
 * made-up number.
 */
// Limit: the medians of each step's first runs added up. Answers and retries are not in it, so a
// card that needed them cost more. A per-card total needs the preset each card ran on, which no row keeps.
export function cardEstimate(db: DatabaseSync, steps: readonly { engine: string; phase: string; model: string; effort: string }[]): Estimate | undefined {
  const figures = history(db);
  let total: Estimate | undefined;
  for (const step of steps) {
    const one = figures.get(keyOf(vendorOf(step.engine), step.phase, step.model, step.effort));
    if (one === undefined) return undefined;
    total = total === undefined ? one : estimateSum(total, one);
  }
  return total;
}
