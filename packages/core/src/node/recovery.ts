import { uptime } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { ENDED } from './runs.ts';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ')";

// What the run row says afterwards. Written as the run's own error, so the ticket page shows a
// sentence rather than a failure with nothing in it.
const RESTARTED = 'Nolzu restarted while this run was going, so it was stopped.';

const FIX_CUT = 'Nolzu restarted while this fix ran, so it was stopped. Look at the Changes tab, then press Fix again.';

export interface Recovery {
  runs: number;
  cards: readonly string[];
}

// A crash leaves rows claiming work no process is doing. `canMove` refuses a queued or running card
// in both directions, so without this sweep a crash locks those cards for good and the person cannot
// even drag them back.
//
// Every state that is not an ending one is swept, rather than only queued, running and retrying.
// `waiting_lane` is live as well, and a run left in it locks its card exactly the way the others do.
// `ENDED` is imported rather than repeated, so the two lists cannot drift apart.
//
// A null state is left alone. `startRun` writes 'queued' in the same insert, so nothing this code can
// make has one: a null means a row from before migration 2 added the column. Sweeping those would
// rewrite finished history as interrupted and put this sentence over the failure they recorded.
export function recoverRuns(db: DatabaseSync, reason: string = RESTARTED): Recovery {
  const marks = ENDED.map(() => '?').join(', ');
  const live = db
    .prepare(`SELECT id, card_key, phase, thread FROM runs WHERE state IS NOT NULL AND state NOT IN (${marks}) ORDER BY id`)
    .all(...ENDED) as { id: number; card_key: string; phase: string; thread: string | null }[];

  for (const row of live) {
    db.prepare(`UPDATE runs SET state = 'interrupted', error = ?, ended_at = coalesce(ended_at, ${NOW}) WHERE id = ?`).run(reason, row.id);
  }

  // Failed rather than idle. The run did not finish, and failed carries a reason a person can read,
  // where idle would quietly hide that work was cut off in the middle of it.
  // A Fix on a pull request comment (an implement run that names its ref) is a side run: its row says
  // the fix was cut off, and its card goes back to idle with the sweep below, where Retry would start
  // nothing on the Pull request column.
  const fix = (row: { phase: string; thread: string | null }) => row.phase === 'implement' && row.thread !== null;
  const cards = [...new Set(live.filter((row) => !fix(row)).map((row) => row.card_key))];
  for (const key of cards) {
    db.prepare("UPDATE cards SET state = 'failed' WHERE key = ? AND state IN ('queued', 'running')").run(key);
  }

  // No run is live now, so a card still claiming queued or running is claiming a run that is not
  // there. That is the crash between the move commit and the enqueue: nothing was started, so there
  // is nothing to report and it goes back to idle.
  db.prepare("UPDATE cards SET state = 'idle' WHERE state IN ('queued', 'running')").run();

  // A Fix on a pull request comment is a run too, so a row still fixing waits on a run that is gone.
  db.prepare("UPDATE pr_discussions SET status = 'new', fix_failed = ? WHERE status = 'fixing'").run(FIX_CUT);

  return { runs: live.length, cards };
}

export interface WriterOptions {
  dataDir: string;
  pid?: number;
  // Swapped in tests. A dead process id cannot be conjured reliably, and spawning one to kill it
  // would put a race in a test written to remove one.
  alive?: (pid: number) => boolean;
  // When the machine last started. A row written before that cannot belong to a process that is
  // still running, whatever its number says now, because process ids are reused across a restart.
  bootedAt?: number;
  // When a process started, or null when this machine cannot say. The runner's `processStart` asks
  // ps; core spawns nothing, so with none given every holder that is alive counts.
  startedAt?: (pid: number) => number | null;
}

// A minute of slack, because uptime has one second of resolution and a lock taken in the first
// moments after a boot must not be read as older than the boot itself.
const BEFORE_BOOT = 60_000;

// Also how the launcher tells a record left by a crash from a Nolzu that runs.
export const processRunning = (pid: number): boolean => {
  try {
    // Signal 0 asks the question without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it is there and owned by somebody else, which still counts as running.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// One writer per data directory, so a second window or a command line call beside the app does not
// start a second scheduler over the same cards. The row is in machine.db, which a project connection
// reads as `writer`, so a second server is refused whatever project it opens.
export function takeWriter(db: DatabaseSync, options: WriterOptions): void {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processRunning;
  const bootedAt = options.bootedAt ?? Date.now() - uptime() * 1000;
  const startedAt = options.startedAt ?? (() => null);

  // Read under the write lock. Two boots that both read before either wrote would both find the lock
  // free and both take it, and neither would be told it lost. `moveCard` and `migrate` in this same
  // folder already read this way, for this reason.
  db.exec('BEGIN IMMEDIATE');
  try {
    const held = db.prepare('SELECT pid, at FROM writer WHERE id = 1').get() as { pid: number; at: string } | undefined;
    // A row from before the machine last started belongs to nobody. Its number may now be some other
    // program's, and trusting it would refuse every start with a sentence naming a stranger and no
    // way back except opening the database by hand.
    const thisBoot = held !== undefined && Date.parse(held.at) >= bootedAt - BEFORE_BOOT;

    // A process that started after the row was written did not write it: after a crash its number
    // went to another program. ps tells the second to the second, so two seconds of slack.
    const started = held === undefined ? null : startedAt(held.pid);
    const reused = held !== undefined && started !== null && started > Date.parse(held.at) + 2000;
    if (held !== undefined && held.pid !== pid && thisBoot && alive(held.pid) && !reused) {
      throw new Error(
        `Nolzu is already running on ${options.dataDir} as process ${held.pid}. Close that window, or stop that process, before starting another one.`,
      );
    }

    // A crash does not release the lock, so a row left by a process that is gone is taken over. Left
    // alone it would lock the person out of their own app until they found the file and deleted it.
    db.prepare(`INSERT INTO writer (id, pid, at) VALUES (1, ?, ${NOW}) ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, at = excluded.at`).run(pid);
    db.exec('COMMIT');
  } catch (error) {
    // Some failures roll the transaction back on their own, and a second rollback would throw over
    // the error that actually matters.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// What a boot calls. The lock first and the sweep second, always: a second Nolzu that swept before it
// was refused would close the runs the first one is still doing, which is the damage this whole
// module exists to prevent. Kept as one function so no caller can get that order wrong.
export function startWriting(db: DatabaseSync, options: WriterOptions): Recovery {
  takeWriter(db, options);

  return recoverRuns(db);
}

// Only its own row. A process that crashed and restarted must not drop the lock the new one took.
export function releaseWriter(db: DatabaseSync, pid: number = process.pid): void {
  db.prepare('DELETE FROM writer WHERE id = 1 AND pid = ?').run(pid);
}
