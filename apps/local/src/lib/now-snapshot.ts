import type { DatabaseSync } from 'node:sqlite';
import { type QueueState, waitFor } from '@nolzu/core';
import { cardHolds, getSetting, NOT_A_PASS, retryWait, scoutSources, shownRunState } from '@nolzu/core/node';
import { BOARD_KINDS, type BoardSnapshot, type Effort, findingOfKey, isMaintenanceKey, LIMIT_SIGNAL, phaseLabel, type RunState, spendOf } from '@nolzu/protocol';
import { waitingOnMe } from '@nolzu/ui';
import { chainView } from './chain-store.ts';
import { firstRun } from './coach.ts';
import { qaSetupFor, stackAnswered } from './qa-setup.ts';
import type { Loop } from './loop.ts';
import type { DoneRow, NowSnapshot, RunEnd, RunRow, ScoutTeaser, TodayView, WaitingExtra } from './now.ts';
import { notificationsView } from './notifications.ts';
import { scoutFindingsFor } from './scout-findings.ts';
import { setupView } from './setup.ts';

// The start of today on this machine's clock, which is the person's: Now says "today" beside the
// date the browser prints. Evidence keeps its UTC day.
function dayStart(clock: Date): string {
  const start = new Date(clock);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

// Both columns are written by sqlite in one ISO form, so the later string is the later time.
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null || a > b ? a : b);

// An epic waits from when its last task closed, if that came after its own last move or run, so the
// newest move of any task counts too. Empty for every other card.
function waitingExtra(db: DatabaseSync, key: string, tasks: readonly string[] = [], beforeArchive = false): WaitingExtra {
  const newest = db.prepare(`SELECT ended_at, session_id, chain_refused FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as
    | { ended_at: string | null; session_id: string | null; chain_refused: string | null }
    | undefined;
  const keys = [key, ...tasks];
  const moved = db.prepare(`SELECT max(at) AS at FROM card_events WHERE card_key IN (${keys.map(() => '?').join(', ')})`).get(...keys) as { at: string | null };
  const chain = newest?.chain_refused ?? null;
  const holds = beforeArchive ? cardHolds(db, key) : null;
  return {
    since: later(newest?.ended_at ?? null, moved.at),
    summary: summaryOf(db, key),
    resumable: (newest?.session_id ?? null) !== null,
    ...(chain === null ? {} : { chainRefused: chain }),
    ...(holds === null ? {} : { holds }),
  };
}

// The plain summary the card page's overview shows: the newest run that wrote one.
const summaryOf = (db: DatabaseSync, key: string): string | null =>
  (db.prepare('SELECT plain_summary FROM runs WHERE card_key = ? AND plain_summary IS NOT NULL ORDER BY id DESC LIMIT 1').get(key) as { plain_summary: string } | undefined)?.plain_summary ??
  null;

// Every job of the scheduler, running first, then waiting in its order. The queue holds runs a board
// cannot show: the knowledge upkeep run, a Scout assessment and a card on a board that is off.
function runRows(db: DatabaseSync, queue: QueueState): RunRow[] {
  const runOf = db.prepare('SELECT phase, engine, model, effort, state, started_at FROM runs WHERE id = ?');
  const titleOf = db.prepare('SELECT title FROM cards WHERE key = ?');
  const row = (job: QueueState['running'][number], state: RunRow['state'], position: number | null, waiting: RunState | null): RunRow => {
    const run = runOf.get(job.runId) as { phase: string; engine: string; model: string | null; effort: Effort | null; state: RunState | null; started_at: string | null } | undefined;
    const kind = isMaintenanceKey(job.cardKey) ? 'maintenance' : findingOfKey(job.cardKey) !== null ? 'assessment' : 'card';
    return {
      runId: job.runId,
      key: job.cardKey,
      title: kind === 'card' ? ((titleOf.get(job.cardKey) as { title: string } | undefined)?.title ?? null) : null,
      kind,
      phase: phaseLabel(run?.phase ?? ''),
      state,
      runState: waiting ?? (run?.state === 'retrying' ? 'retrying' : 'running'),
      retry: waiting === null && run?.state === 'retrying' ? retryWait(db, job.runId) : null,
      position,
      startedAt: run?.started_at ?? null,
      engine: run?.engine ?? null,
      model: run?.model ?? null,
      effort: run?.effort ?? null,
      lane: job.lane,
    };
  };
  // A wrap-up held for Knowledge is in no queue. With nothing waiting for the person it waits for the
  // Knowledge lane, so it is listed as queued after the queue, with no place in it. One the person
  // must answer for is on the waiting list instead.
  const held =
    shownRunState(db)('waiting_review') === 'waiting_lane'
      ? (db.prepare("SELECT id, card_key FROM runs WHERE state = 'waiting_review' ORDER BY id").all() as { id: number; card_key: string }[]).map((one) =>
          row({ runId: one.id, cardKey: one.card_key, lane: 'knowledge' } as QueueState['running'][number], 'queued', null, 'waiting_lane'),
        )
      : [];
  return [
    ...queue.running.map((job) => row(job, 'running', null, null)),
    ...queue.waiting.map((job, at) => row(job, 'queued', at + 1, waitFor(queue, job.runId)?.reason === 'lane' ? 'waiting_lane' : 'queued')),
    ...held,
  ];
}

/**
 * The cards done today: moved today into a column that waits on another system or into the archive,
 * such as Pull request and Closed, and not waiting on the person or in the queue now. That keeps a card
 * in one section of Now at a time. The cost and the time are those of its runs that ended today.
 */
function doneRows(db: DatabaseSync, boards: readonly BoardSnapshot[], from: string, busy: ReadonlySet<string>): DoneRow[] {
  // Today's moves in one read, and not one read per card: Closed only grows.
  const moves = db.prepare('SELECT card_key, to_stage, max(at) AS at FROM card_events WHERE at >= ? GROUP BY card_key, to_stage').all(from) as { card_key: string; to_stage: string; at: string }[];
  const movedAt = new Map(moves.map((move) => [`${move.card_key}\n${move.to_stage}`, move.at]));
  const runsOf = db.prepare('SELECT cost_estimate, duration_ms FROM runs WHERE card_key = ? AND ended_at >= ?');
  const rows = boards.flatMap((board) => {
    const past = new Set(board.stages.filter((stage) => stage.role === 'auto' || stage.role === 'archive').map((stage) => stage.id));
    return board.cards.flatMap((card) => {
      if (!past.has(card.stage) || waitingOnMe(card) || busy.has(card.key)) return [];
      const at = movedAt.get(`${card.key}\n${card.stage}`);
      if (at === undefined) return [];
      const spend = spendOf((runsOf.all(card.key, from) as { cost_estimate: number | null; duration_ms: number | null }[]).map((run) => ({ costUsd: run.cost_estimate, durationMs: run.duration_ms, tokens: null })));
      return [{ at, row: { key: card.key, title: card.title, summary: summaryOf(db, card.key), costUsd: spend.costUsd, durationMs: spend.durationMs } }];
    });
  });
  // The newest first.
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((one) => one.row);
}

// Every run that ended today, the passes and the runs with no card too, because each one took agent
// time and some cost money. A cost nobody reported is never summed as zero.
function today(db: DatabaseSync, from: string): TodayView {
  const runs = db.prepare('SELECT cost_estimate, duration_ms FROM runs WHERE ended_at >= ?').all(from) as { cost_estimate: number | null; duration_ms: number | null }[];
  const spend = spendOf(runs.map((run) => ({ costUsd: run.cost_estimate, durationMs: run.duration_ms, tokens: null })));
  const moved = db.prepare('SELECT count(*) AS n FROM card_events WHERE at >= ?').get(from) as { n: number };
  return { runs: spend.runs, reported: spend.reported, costUsd: spend.costUsd, durationMs: spend.durationMs, moved: moved.n };
}

// How many ended runs each snapshot carries. A run's end reaches every open page in the snapshot right
// after it, so a page only ever needs the newest one or two.
const ENDED_RUNS = 5;

/**
 * The newest card runs that ended ready or failed, for the toasts they raise. A run with a question
 * waits on the person and a stopped one was the person's own press, so neither is here. A run still in
 * the queue is left out too: one that ended ready holds its slot for the summary pass and lands its
 * card after, and its toast must not come while the card still reads running.
 */
function endedRuns(db: DatabaseSync, queue: QueueState): RunEnd[] {
  const busy = new Set(queue.running.map((job) => job.runId));
  const rows = db
    .prepare(
      `SELECT id, card_key, phase, state, error, verdict, verdict_reason, ended_at, engine, model, duration_ms, cost_estimate FROM runs
        WHERE ended_at IS NOT NULL AND state IN ('complete', 'failed') AND question IS NULL AND ${NOT_A_PASS} AND card_key IN (SELECT key FROM cards)
        ORDER BY ended_at DESC, id DESC LIMIT ?`,
    )
    .all(ENDED_RUNS) as {
    id: number;
    card_key: string;
    phase: string;
    state: RunEnd['state'];
    error: string | null;
    verdict: RunEnd['verdict'];
    verdict_reason: string | null;
    ended_at: string;
    engine: string;
    model: string | null;
    duration_ms: number | null;
    cost_estimate: number | null;
  }[];
  return rows
    .filter((row) => !busy.has(row.id))
    .map((row) => ({
      runId: row.id,
      key: row.card_key,
      phase: phaseLabel(row.phase),
      state: row.state,
      verdict: row.verdict,
      reason: row.state === 'failed' ? row.error : row.verdict_reason,
      endedAt: row.ended_at,
      engine: row.engine,
      model: row.model,
      durationMs: row.duration_ms,
      costUsd: row.cost_estimate,
    }));
}

// Scout on Now and on the rail: the findings new since the Scout page was last opened (the seen
// marker), and the one seen last in the inbox row's own words. Never a finding that is not in the table.
function scoutTeaser(db: DatabaseSync): ScoutTeaser {
  const view = scoutFindingsFor(db);
  const newest = view.rows[0];
  return {
    sources: scoutSources(db).length,
    fresh: view.fresh,
    newest: newest === undefined ? null : { title: newest.title, line: `${newest.source} · ${newest.often}`, source: newest.source },
  };
}

// Every board that is on, Delivery always, so Now and the project selector count the same cards.
export function boardsOn(live: Pick<Loop, 'db' | 'snapshot'>): BoardSnapshot[] {
  const off = getSetting(live.db, 'offBoards');
  return BOARD_KINDS.filter((kind) => kind === 'delivery' || !off.includes(kind)).map((kind) => live.snapshot(kind));
}

// The waiting extras of every card on these boards that waits on the person.
const waitingOf = (db: DatabaseSync, boards: readonly BoardSnapshot[]): Record<string, WaitingExtra> =>
  Object.fromEntries(
    boards.flatMap((board) =>
      board.cards.filter(waitingOnMe).map((card) => {
        // A ready card whose next column is the archive, which its run would have moved it to unless it holds something.
        const at = board.stages.findIndex((stage) => stage.id === card.stage);
        const beforeArchive = card.state === 'ready' && board.stages[at + 1]?.role === 'archive';
        return [card.key, waitingExtra(db, card.key, card.finished === true ? (card.tasks ?? []).map((task) => task.key) : [], beforeArchive)];
      }),
    ),
  );

/**
 * Everything Now draws, in one read, for every board that is on.
 *
 * Limit: every open tab reads this on every change, because its one stream carries the rail's
 * count and every board a page shows. Each read builds every board's snapshot, and the day's figures
 * and the ended runs scan runs and card_events with no index on ended_at or at. Add those two indexes in an appended
 * migration, or send the rail a count of its own, if that shows on a large project.
 */
export function nowSnapshot(live: Pick<Loop, 'db' | 'snapshot' | 'scheduler'>, clock = new Date()): NowSnapshot {
  const db = live.db;
  const boards = boardsOn(live);
  const queue = live.scheduler.queue();
  const busy = new Set([...queue.waiting, ...queue.running].map((job) => job.cardKey));
  const from = dayStart(clock);
  return {
    version: boards[0]?.version ?? 0,
    boards,
    waiting: waitingOf(db, boards),
    running: runRows(db, queue),
    done: doneRows(db, boards, from, busy),
    today: today(db, from),
    // No folder: the panel names a profile and nothing more.
    profiles: getSetting(db, 'engineProfiles').map((profile) => ({ id: profile.id, label: profile.label, silent: LIMIT_SIGNAL[profile.vendor].knownSilent })),
    scout: scoutTeaser(db),
    knowledgePending: (db.prepare("SELECT count(*) AS n FROM knowledge_changes WHERE status = 'pending'").get() as { n: number }).n,
    chain: chainView(db),
    firstRun: firstRun(db),
    // Limit: read from the repositories on every snapshot until the question is answered, which is a
    // few small files. Cache it by the project path if a project ever waits long with many repositories.
    qaSetup: stackAnswered(db) ? null : qaSetupFor(db),
    // The cards whose move into QA asks, because a repository they changed has no answer yet.
    qaAsks: stackAnswered(db) ? [] : boards.flatMap((board) => board.cards.map((card) => card.key)).filter((key) => !stackAnswered(db, key)),
    setup: setupView(db),
    ended: endedRuns(db, queue),
    notifications: notificationsView(db),
  };
}
