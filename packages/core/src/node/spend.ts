import type { DatabaseSync } from 'node:sqlite';
import { type Spend, spendOf } from '@nolzu/protocol';
import { allRuns, type StoredRun } from './runs.ts';

// The five spend levels. A run's own roll-up is `spendOf([run])`, and the other
// four are here. One read and four groupings of it, so the rules about a missing cost live in one
// place and no level can drift from another.
export interface SpendReport {
  // Every run in this database. There is one per project, so this is the project.
  project: Spend;
  byCard: Map<string, Spend>;
  // The UTC day the run started, as the stored timestamp spells it.
  byDay: Map<string, Spend>;
  // By engine profile id, the value the row holds.
  byProfile: Map<string, Spend>;
}

export function spendReport(db: DatabaseSync): SpendReport {
  const runs = allRuns(db);
  return {
    project: spendOf(runs),
    byCard: grouped(runs, (run) => run.cardKey),
    // Every timestamp here is written in UTC and read as the digits it carries, the way the rest of
    // the app reads a day. So a run started at 01:00 in UTC+2 counts to the day before. The day a
    // run started, never the day it ended, so a run over midnight belongs to one day only.
    byDay: grouped(runs, (run) => (run.startedAt === null ? null : run.startedAt.slice(0, 10))),
    // The stored id, with no check against the profiles this machine holds. A profile the person
    // removed still has runs, and dropping them would lose what they cost.
    byProfile: grouped(runs, (run) => run.engine),
  };
}

// A run the key says nothing about is in no group. A run that never left the queue has no start
// time, and putting it under a day named "null" or under today would invent one.
function grouped(runs: readonly StoredRun[], key: (run: StoredRun) => string | null): Map<string, Spend> {
  const groups = new Map<string, StoredRun[]>();
  for (const run of runs) {
    const name = key(run);
    if (name === null) continue;
    const mine = groups.get(name);
    if (mine === undefined) groups.set(name, [run]);
    else mine.push(run);
  }
  return new Map([...groups].map(([name, mine]) => [name, spendOf(mine)]));
}
