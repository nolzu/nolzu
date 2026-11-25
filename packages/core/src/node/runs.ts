import type { DatabaseSync } from 'node:sqlite';
import { bumpVersion } from './db.ts';
import { getSetting } from './settings-store.ts';
import { startsInCardFolder } from '../phase-policy.ts';
import type { OutputCheck } from '../output-check.ts';
import { ASK_PHASE, CLOUD_OPEN, type Effort, PASSES, type QuestionOption, type ReadOnlyBreak, type RunRecord, type RunState, type RunTokens, type Verdict, type WallKind } from '@nolzu/protocol';

export interface RunStart {
  cardKey: string;
  // A string and not a board phase, because a run can belong to a pseudo-ticket such as
  // extract-summary. The released schema puts no foreign key on card_key for that reason.
  phase: string;
  engine: string;
  model: string | null;
  effort: Effort | null;
  sessionId: string | null;
  // Written now rather than at the end, so a run that dies before its first line still names the
  // file holding what it did.
  logPath: string;
  lane: string | null;
  // The run goes on from earlier work: an answer, a discussion message, a retry or a fresh run told
  // to go on from a progress file. The estimates leave it out. Absent is a first run.
  resumed?: boolean;
  // The ask discussion an Ask run answers in. Absent on every other run.
  thread?: string;
}

// What the row holds, read back. There is no failure status here: `RunRecord` carries one and no
// column holds it. The run's own log carries the raw status, and `log_path` names that file, so
// nothing is invented for it here.
export interface StoredRun {
  id: number;
  cardKey: string;
  phase: string;
  engine: string;
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  tokens: RunTokens | null;
  question: string | null;
  failureReason: string | null;
  state: RunState | null;
  attempt: number | null;
  lane: string | null;
  logPath: string;
  startedAt: string | null;
  endedAt: string | null;
  // What a QA run decided. Null on every other run, and on a QA run that printed no verdict line,
  // which is not a pass: the reason then says so and the card waits for a person.
  verdict: Verdict | null;
  verdictReason: string | null;
  // The stack the run ran against, as the runner's own words for it, and null for a run that had
  // no stack hook to load.
  stackState: string | null;
  stackReason: string | null;
  // The wall that held the run, and null on a row made before the column.
  wall: WallKind | null;
}

interface Row {
  id: number;
  card_key: string;
  phase: string;
  engine: string;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  cost_estimate: number | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  question: string | null;
  error: string | null;
  state: string | null;
  attempt: number | null;
  lane: string | null;
  log_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  verdict: string | null;
  verdict_reason: string | null;
  stack_state: string | null;
  stack_reason: string | null;
  wall: string | null;
}

// A WHERE condition that leaves the passes and Ask runs out, for a query that asks for a card's newest
// phase run. A commit message asked for while a card waits on a question is newer than the run that
// asked, and so is a question asked in an Ask discussion, which never speaks for the card.
export const NOT_A_PASS = `phase NOT IN (${[...PASSES, ASK_PHASE].map((one) => `'${one}'`).join(', ')})`;

// The states a run does not come back from. The end time is stamped once, when the run first
// reports one of them, so a later write cannot move it.
export const ENDED: readonly RunState[] = ['complete', 'failed', 'stopped', 'interrupted'];

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ')";

// The row for a run that is about to start. One row per run, made once and updated after that, so
// the ticket page reads one history and not three.
export function startRun(db: DatabaseSync, start: RunStart): number {
  const written = db
    .prepare(
      `INSERT INTO runs (card_key, phase, engine, model, effort, session_id, log_path, lane, state, resumed, asked_model, thread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(start.cardKey, start.phase, start.engine, start.model, start.effort, start.sessionId, start.logPath, start.lane, start.resumed === true ? 1 : 0, start.model, start.thread ?? null);

  return Number(written.lastInsertRowid);
}

// What the reducer folded out of the event stream, written onto the row the run already has.
// The model and the session id are kept when the fold has none. Both are chosen by the caller
// before the engine speaks, and the fold only learns them from the session line, so writing its
// nulls over them would blank exactly the run that died before its first line.
// The folder the session started in: the one its first run recorded. Null when no run did, which
// is every run made before the column.
export function sessionFolder(db: DatabaseSync, cardKey: string, sessionId: string): string | null {
  const row = db.prepare('SELECT cwd FROM runs WHERE card_key = ? AND session_id = ? AND cwd IS NOT NULL ORDER BY id LIMIT 1').get(cardKey, sessionId) as
    | { cwd: string }
    | undefined;
  return row?.cwd ?? null;
}

// Whether a session's process started in the card folder, off its first run. A run made before the
// column started there when Codex held it with its own sandbox, which was the rule for every Codex
// run then, so that rule answers for it.
export function sessionInCardFolder(db: DatabaseSync, cardKey: string, sessionId: string, vendor: string, phase: string): boolean {
  const row = db.prepare('SELECT in_card_folder FROM runs WHERE card_key = ? AND session_id = ? ORDER BY id LIMIT 1').get(cardKey, sessionId) as
    | { in_card_folder: number | null }
    | undefined;
  if (row !== undefined && row.in_card_folder !== null) return row.in_card_folder === 1;
  return startsInCardFolder(vendor, phase, true);
}

// The run has its slot, or has come back from a wait. The start is stamped the first time only, so the
// elapsed time on the card starts with the run and no queue wait is part of it.
export function markRunning(db: DatabaseSync, id: number): void {
  db.prepare(`UPDATE runs SET state = 'running', started_at = coalesce(started_at, ${NOW}) WHERE id = ?`).run(id);
  // The card too. The board reads the card's state, and without this it said queued for the whole run.
  db.prepare("UPDATE cards SET state = 'running' WHERE key = (SELECT card_key FROM runs WHERE id = ?)").run(id);
  bumpVersion(db);
}

// This run's share of a cost the engine reported for the whole session: what the earlier runs of
// the session already hold comes off. A run with no session to look up keeps the figure as it came.
function ownCost(db: DatabaseSync, id: number, run: RunRecord): number | null {
  if (run.costUsd === null || run.costIsSessionTotal !== true) return run.costUsd;
  const session = run.sessionId ?? (db.prepare('SELECT session_id FROM runs WHERE id = ?').get(id) as { session_id: string | null } | undefined)?.session_id ?? null;
  if (session === null) return run.costUsd;
  const { earlier } = db.prepare('SELECT coalesce(sum(cost_estimate), 0) AS earlier FROM runs WHERE session_id = ? AND id < ?').get(session, id) as { earlier: number };
  return Math.max(0, run.costUsd - earlier);
}

export function saveRun(db: DatabaseSync, id: number, run: RunRecord): void {
  const cost = ownCost(db, id, run);
  db.prepare(
    `UPDATE runs SET
       model = coalesce(?, model), session_id = coalesce(?, session_id), cost_estimate = ?,
       -- The engine's own time where it reports one. Codex reports none, so an ended run counts it
       -- from its start to now, the end this same write stamps.
       duration_ms = coalesce(?, CASE WHEN ? AND started_at IS NOT NULL THEN CAST(round((julianday(${NOW}) - julianday(started_at)) * 86400000) AS INTEGER) END),
       tokens_input = ?, tokens_output = ?, tokens_cache_read = ?, tokens_cache_creation = ?,
       question = ?, error = ?, state = ?, attempt = ?, retry_reason = ?, retry_max = ?, retry_until = ?,
       -- A wait for an API error resumes the session in this same row, and the cost and the
       -- duration that reach the row are the last attempt's alone. So it leaves the estimates.
       resumed = CASE WHEN ? THEN 1 ELSE resumed END,
       -- Stamped on the first event the run reports, and never moved after that. A job can wait a
       -- long time for a slot or a lane, and the browser counts elapsed from this, so the queue wait
       -- is not part of it.
       started_at = coalesce(started_at, ${NOW}),
       ended_at = CASE WHEN ? THEN coalesce(ended_at, ${NOW}) ELSE ended_at END
     WHERE id = ?`,
  ).run(
    run.model,
    run.sessionId,
    cost,
    run.durationMs,
    ENDED.includes(run.state) ? 1 : 0,
    run.tokens?.input ?? null,
    run.tokens?.output ?? null,
    run.tokens?.cacheRead ?? null,
    run.tokens?.cacheCreation ?? null,
    run.question,
    run.failureReason,
    run.state,
    run.retry?.attempt ?? null,
    run.retry?.reason ?? null,
    run.retry?.maxRetries ?? null,
    run.retry?.until ?? null,
    run.retry === null ? 0 : 1,
    ENDED.includes(run.state) ? 1 : 0,
    id,
  );
  // A run event is a change a person sees on the board, so the board version moves with it.
  bumpVersion(db);
}

// A wait Nolzu holds after an API error, as stored for the countdown.
export interface StoredWait {
  attempt: number;
  maxRetries: number | null;
  reason: string | null;
  // When the next try starts, in Unix milliseconds.
  until: number;
}

// The wait a run sits in now, or null when it sits in none. Only a retrying row: the columns keep the
// last wait until the run's end writes over them, and a resumed attempt is live work again.
export function retryWait(db: DatabaseSync, id: number): StoredWait | null {
  const row = db.prepare('SELECT state, attempt, retry_max, retry_reason, retry_until FROM runs WHERE id = ?').get(id) as
    | { state: string | null; attempt: number | null; retry_max: number | null; retry_reason: string | null; retry_until: number | null }
    | undefined;
  if (row?.state !== 'retrying' || row.retry_until === null || row.attempt === null) return null;
  return { attempt: row.attempt, maxRetries: row.retry_max, reason: row.retry_reason, until: row.retry_until };
}

// What QA decided, on the run that decided it. A null verdict with a reason is a run that printed
// no verdict line: the reason says so, and the card waits for a person rather than chaining on.
export function saveVerdict(db: DatabaseSync, id: number, found: { verdict: Verdict | null; reason: string | null }): void {
  db.prepare('UPDATE runs SET verdict = ?, verdict_reason = ? WHERE id = ?').run(found.verdict, found.reason, id);
  bumpVersion(db);
}

// The answers a blocked run offered with its question. Null clears them, for a run that offered none
// or wrote a list the parser would not take, and the question then shows as plain text.
export function saveQuestionOptions(db: DatabaseSync, id: number, options: readonly QuestionOption[] | null): void {
  db.prepare('UPDATE runs SET question_options = ? WHERE id = ?').run(options === null ? null : JSON.stringify(options), id);
  bumpVersion(db);
}

// How the stack stood for this run, written when it is loaded and again when it is let go, so the
// card shows a stack that is coming up, one that failed, and one an unload left running.
export function saveStackStatus(db: DatabaseSync, id: number, status: { state: string; reason: string | null }): void {
  db.prepare('UPDATE runs SET stack_state = ?, stack_reason = ? WHERE id = ?').run(status.state, status.reason, id);
  bumpVersion(db);
}

// What the git compare after a read-only run found. The card page reads it back with
// `readOnlyBreakOf`, so the mark outlives a reload.
export function saveReadOnlyBreak(db: DatabaseSync, id: number, found: ReadOnlyBreak): void {
  db.prepare('UPDATE runs SET read_only_break = ? WHERE id = ?').run(JSON.stringify(found), id);
  bumpVersion(db);
}

// A later read-only run of the card compared clean, so the marks of the runs before it are old news.
// The run logs keep what each one found.
export function clearReadOnlyBreaks(db: DatabaseSync, key: string, before: number): boolean {
  const cleared = db.prepare('UPDATE runs SET read_only_break = NULL WHERE card_key = ? AND id < ? AND read_only_break IS NOT NULL').run(key, before).changes > 0;
  if (cleared) bumpVersion(db);
  return cleared;
}

// Whether a run of the card other than this one is queued or running, or, with `since`, ended at or
// after that time (an ISO time, as the rows stamp it). A read-only run beside it cannot tell its own
// change from that run's or the person's, so its compare stays out of it.
export function otherRunOfCard(db: DatabaseSync, key: string, id: number, since?: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM runs WHERE card_key = ? AND id != ? AND (state IN ('queued', 'running') OR (? IS NOT NULL AND ended_at >= ?)) LIMIT 1")
      .get(key, id, since ?? null, since ?? null) !== undefined
  );
}

// The newest run of a card that changed files while it should have read only, with its phase and
// engine profile, or null. `walled` is a run Nolzu's wall held, which could not write there. A row
// that does not parse reads as none.
export function readOnlyBreakOf(db: DatabaseSync, key: string): (ReadOnlyBreak & { phase: string; engine: string; walled: boolean }) | null {
  const row = db.prepare('SELECT phase, engine, wall, read_only_break FROM runs WHERE card_key = ? AND read_only_break IS NOT NULL ORDER BY id DESC LIMIT 1').get(key) as
    | { phase: string; engine: string; wall: string | null; read_only_break: string }
    | undefined;
  if (row === undefined) return null;
  try {
    const found = JSON.parse(row.read_only_break) as ReadOnlyBreak;
    const walled = row.wall === 'macos' || row.wall === 'bubblewrap';
    return { phase: row.phase, engine: row.engine, walled, restored: found.restored === true, diff: String(found.diff ?? ''), undone: found.undone ?? [], left: found.left ?? [] };
  } catch {
    return null;
  }
}

// What the commit check found when an Implement run ended. The run moves on as it would; this
// is only the warning the card page reads back with `commitWarningOf`.
export function saveCommitWarning(db: DatabaseSync, id: number, sentences: string): void {
  db.prepare('UPDATE runs SET commit_warning = ? WHERE id = ?').run(sentences, id);
  bumpVersion(db);
}

// The warning of the card's newest Implement run, or null. Only the newest, so the next Implement run
// clears it the moment it is made.
export function commitWarningOf(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT commit_warning FROM runs WHERE card_key = ? AND phase = 'implement' ORDER BY id DESC LIMIT 1").get(key) as { commit_warning: string | null } | undefined;
  return row?.commit_warning ?? null;
}

// What the output check found when the run ended. A failed check is a warning and moves nothing.
export function saveOutputCheck(db: DatabaseSync, id: number, check: OutputCheck): void {
  db.prepare('UPDATE runs SET output_check = ? WHERE id = ?').run(JSON.stringify(check), id);
  bumpVersion(db);
}

// What the output check found on one run, or null when it was not checked. A row that does not parse
// reads as not checked.
export function outputCheckOf(db: DatabaseSync, id: number): OutputCheck | null {
  const row = db.prepare('SELECT output_check FROM runs WHERE id = ?').get(id) as { output_check: string | null } | undefined;
  return parseOutputCheck(row?.output_check ?? null);
}

/**
 * What a card still holds for the person that a closed card would hide, as the sentence Now shows, or
 * null. A knowledge change of any of its runs that waits for review comes first, then problems the
 * output check found on the run the card shows. A wrap-up that leaves either stays on Wrap-up.
 */
export function cardHolds(db: DatabaseSync, key: string): string | null {
  if (db.prepare("SELECT 1 FROM knowledge_changes WHERE card_key = ? AND status = 'pending' LIMIT 1").get(key) !== undefined) {
    // A team project's change waits for the team, and the person's own Approve only takes over when
    // the hub never got it. While the cloud is closed there is no team to wait for.
    //
    // Limit: a change held while the cloud is closed is never sent to the team when it opens. The
    // person's own Approve and Return still answer it, and a resend needs the owed-frame store the team
    // proposal in `loop.ts` names.
    return !CLOUD_OPEN || getSetting(db, 'teamProjectId') === null ? 'A knowledge change waits for your review on Knowledge.' : 'A knowledge change waits for the team to review it.';
  }
  const newest = db.prepare(`SELECT output_check FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as { output_check: string | null } | undefined;
  return (parseOutputCheck(newest?.output_check ?? null)?.problems.length ?? 0) > 0 ? 'The output check found problems in what the run wrote. Open the card to read them.' : null;
}

// The stored column, read the same way where a query already holds it.
export function parseOutputCheck(stored: string | null): OutputCheck | null {
  if (stored === null) return null;
  try {
    const found = JSON.parse(stored) as Partial<OutputCheck>;
    return { problems: Array.isArray(found.problems) ? found.problems : [], note: typeof found.note === 'string' ? found.note : null };
  } catch {
    return null;
  }
}

// The plain summary a phase run ends with, for the overview of the ticket page.
export function savePlainSummary(db: DatabaseSync, id: number, text: string): void {
  db.prepare('UPDATE runs SET plain_summary = ? WHERE id = ?').run(text, id);
  bumpVersion(db);
}

const COLUMNS = `id, card_key, phase, engine, model, effort, session_id, cost_estimate, duration_ms,
  tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
  question, error, state, attempt, lane, log_path, started_at, ended_at,
  verdict, verdict_reason, stack_state, stack_reason, wall`;

export function readRun(db: DatabaseSync, id: number): StoredRun | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`).get(id) as Row | undefined;
  return row === undefined ? null : stored(row);
}

// Every run of a card, oldest first, which is the order they ran in.
export function cardRuns(db: DatabaseSync, key: string): StoredRun[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM runs WHERE card_key = ? ORDER BY id`).all(key) as unknown as Row[]).map(stored);
}

// Every run of the cards on one board, oldest first, in one query. The board snapshot draws each
// card's pips from them.
export function boardRuns(db: DatabaseSync, board: string): StoredRun[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM runs WHERE card_key IN (SELECT key FROM cards WHERE board = ?) ORDER BY id`).all(board) as unknown as Row[]).map(stored);
}

function stored(row: Row): StoredRun {

  // All four together or none. A stopped run reports no tokens at all, which is not the same as a
  // run that used none.
  const counted = [row.tokens_input, row.tokens_output, row.tokens_cache_read, row.tokens_cache_creation];
  const tokens: RunTokens | null = counted.every((count) => count === null)
    ? null
    : {
        input: row.tokens_input ?? 0,
        output: row.tokens_output ?? 0,
        cacheRead: row.tokens_cache_read ?? 0,
        cacheCreation: row.tokens_cache_creation ?? 0,
      };

  return {
    id: row.id,
    cardKey: row.card_key,
    phase: row.phase,
    engine: row.engine,
    model: row.model,
    effort: row.effort,
    sessionId: row.session_id,
    costUsd: row.cost_estimate,
    durationMs: row.duration_ms,
    tokens,
    question: row.question,
    failureReason: row.error,
    state: row.state as RunState | null,
    attempt: row.attempt,
    lane: row.lane,
    logPath: row.log_path ?? '',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    verdict: row.verdict as Verdict | null,
    verdictReason: row.verdict_reason,
    stackState: row.stack_state,
    stackReason: row.stack_reason,
    wall: row.wall as WallKind | null,
  };
}

// Every run in the project database, oldest first. There is one database per project, so this is its
// whole history, pseudo-ticket runs included: a summary pass is a run with a real cost.
export function allRuns(db: DatabaseSync): StoredRun[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM runs ORDER BY id`).all() as unknown as Row[]).map(stored);
}
