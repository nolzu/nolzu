import type { DatabaseSync } from 'node:sqlite';
import { allCardMoves, allRuns, allScoutFindings, type CardMove, getSetting, type StoredRun } from '@nolzu/core/node';
import {
  ASK_PHASE,
  type BoardKind,
  type BoardSnapshot,
  capSummary,
  type CardStart,
  cardStarts,
  type EvidenceBlock,
  type FindingResult,
  type FindingResults,
  isBoardKind,
  type PullDecision,
  type PullState,
  type QuestionOption,
  type RunCost,
  type RunCosts,
  type RunnerMessageType,
  SCOUT_AND_EVIDENCE,
  storedQuestionOptions,
} from '@nolzu/protocol';
import { evidenceFor } from './evidence.ts';

/**
 * Board sync, evidence history and Scout findings, the client half. The field names below are
 * the ones the hub reads, so neither side translates a name. Findings use the field names of
 * `FindingResult` in `@nolzu/protocol`.
 *
 * Only what changed goes out. The sender keeps what it put on this socket and sends a row again only
 * when it reads differently, so a run that streams two hundred events costs the frames of the few
 * state changes the loop reports, and a queue change that touched no row costs nothing.
 *
 * What was sent is forgotten on every open, so the first push after a connect is the whole board.
 * Sending only the tail needs the hub to send its marks first, and the hub has no message to send
 * them under today. The hub's changed-guard makes the whole board cheap to resend: a row it
 * already holds costs no write.
 *
 * Limit: the whole board on every open, and one remembered copy of every row for the life of the
 * socket. Send the tail once the protocol has a marks message for the hub to send.
 *
 * Never a file body, a diff, a transcript or a session id. `summary`, `extra_context` and `result`
 * are not read here. `log_path` and `session_id` come back from `allRuns`, and no frame copies them.
 * A run's plain summary goes, cut to `SUMMARY_CAP`, with the answers its question offers, and a card's
 * next start goes with its estimate. Plan steps, paths, tool activity, logs,
 * discussion and the usage window stay here.
 */

/** One card as the hub reads it. */
export interface CardSync {
  key: string;
  title: string;
  stage: string;
  state: string;
  source: string;
  sourceRef: string | null;
  // `state` is left out while the card does not know it, so a hub reads that as it reads an older build.
  pull: { author: string | null; decision: PullDecision; headCommittedAt: string | null; draft: boolean; state?: PullState } | null;
  // Left out on a card that offers no start, and on the team socket. Today's hub does not read it.
  start?: CardStart;
}

/** One run as the hub reads it. */
export interface RunSync {
  id: number;
  cardKey: string;
  phase: string;
  engine: string;
  model: string | null;
  effort: string | null;
  state: string | null;
  lane: string | null;
  attempt: number | null;
  startedAt: string | null;
  endedAt: string | null;
  question: string | null;
  error: string | null;
  verdict: string | null;
  verdictReason: string | null;
  costUsd: number | null;
  durationMs: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  // Both left out when the run has none. Today's hub does not read them.
  summary?: string;
  questionOptions?: QuestionOption[];
}

/** One `card.state` payload. A stage move is the client's own `CardMove`, which is the hub's shape. */
export interface CardStatePayload {
  kind: BoardKind;
  cards: CardSync[];
  events: CardMove[];
  runs: RunSync[];
}

// Rows per frame, so a board with years of history does not go out as one frame larger than the
// socket takes.
const CHUNK = 200;

// How many days of evidence a connect sends. Each day is one `git log`.
//
// Limit: a gap longer than this leaves the older days missing on the hub. Send the days the hub
// asks for once it can ask.
export const EVIDENCE_DAYS_ON_OPEN = 7;

// What the hub gets in place of a run's failure reason. The reason itself stays on the machine.
export const RUN_FAILED = 'The run failed. The reason is on the machine that ran it.';

interface CardRow {
  key: string;
  board: string;
  stage: string;
  state: string;
  title: string;
  source: string;
  source_ref: string | null;
  pr_author: string | null;
  pr_decision: PullDecision | null;
  pr_head_at: string | null;
  pr_draft: number;
  pr_state: PullState | null;
}

function cardRows(db: DatabaseSync): CardRow[] {
  return db
    .prepare('SELECT key, board, stage, state, title, source, source_ref, pr_author, pr_decision, pr_head_at, pr_draft, pr_state FROM cards ORDER BY key')
    .all() as unknown as CardRow[];
}

const cardSync = (row: CardRow): CardSync => ({
  key: row.key,
  title: row.title,
  stage: row.stage,
  state: row.state,
  source: row.source,
  sourceRef: row.source_ref,
  // The decision is what makes a card a pull request, the same rule the snapshot builder follows.
  pull:
    row.pr_decision === null
      ? null
      : {
          author: row.pr_author,
          decision: row.pr_decision,
          headCommittedAt: row.pr_head_at,
          draft: row.pr_draft === 1,
          ...(row.pr_state === null ? {} : { state: row.pr_state }),
        },
});

/** The board rows as the hub reads them, keyed so two reads can be compared row by row. */
function boardRows(
  db: DatabaseSync,
  withRuns: boolean,
  snapshot: ((kind: BoardKind) => BoardSnapshot) | undefined,
): { key: string; kind: BoardKind; item: { card: CardSync } | { event: CardMove } | { run: RunSync } }[] {
  const boardOf = new Map<string, BoardKind>();
  const rows: ReturnType<typeof boardRows> = [];
  const snapshots = new Map<BoardKind, BoardSnapshot>();
  const vendors = new Map(getSetting(db, 'engineProfiles').map((profile) => [profile.id, profile.vendor]));
  for (const row of cardRows(db)) {
    // A board this build does not know would make the hub refuse the whole frame, so that card stays
    // here rather than taking the rest of the board down with it.
    if (!isBoardKind(row.board)) continue;
    boardOf.set(row.key, row.board);
    const card = cardSync(row);
    if (snapshot !== undefined) {
      const board = snapshots.get(row.board) ?? snapshot(row.board);
      snapshots.set(row.board, board);
      const start = startOf(board, row.key, vendors);
      if (start !== undefined) card.start = start;
    }
    rows.push({ key: `card ${row.key}`, kind: row.board, item: { card } });
  }
  // The plain summary and a question's answers are not on `allRuns`, which every other reader shares.
  const extras = new Map(
    (withRuns ? (db.prepare('SELECT id, plain_summary, question_options, thread FROM runs').all() as { id: number; plain_summary: string | null; question_options: string | null; thread: string | null }[]) : []).map(
      (row) => [row.id, row],
    ),
  );
  // A move or a run rides with its card's board. Neither row on the hub has a board column, so a run
  // of a maintenance pass or an assessment, which has no card, rides on the delivery one.
  const kindOf = (key: string): BoardKind => boardOf.get(key) ?? 'delivery';
  for (const move of allCardMoves(db)) rows.push({ key: `move ${move.id}`, kind: kindOf(move.cardKey), item: { event: move } });
  for (const run of withRuns ? allRuns(db) : []) {
    // The hub leaves out only the plain summary when it picks a card's newest run, so a commit message
    // asked for on a blocked card would take the question's place on the team board. It stays here.
    // Limit: its cost stays off the hub too. Send it once the hub skips every pass in PASSES.
    // An Ask run stays here for the same reason: it never speaks for its card, on the team board either.
    // A discussion subject is the same: a pass about an Ask discussion, which stays on this machine.
    if (run.phase === 'commit-message' || run.phase === 'thread-title' || run.phase === ASK_PHASE) continue;
    // A triage's summary and question are written from the pull request's comments, and comment text
    // never leaves the machine. So are a Fix's, the one other run that names a thread. The run still
    // goes, so its cost counts on the hub.
    const comments = run.phase === 'feedback' || extras.get(run.id)?.thread != null;
    rows.push({
      key: `run ${run.id}`,
      kind: kindOf(run.cardKey),
      item: {
        run: {
          id: run.id,
          cardKey: run.cardKey,
          phase: run.phase,
          engine: run.engine,
          model: run.model,
          effort: run.effort,
          state: run.state,
          lane: run.lane,
          attempt: run.attempt,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          question: comments ? null : run.question,
          // The stored reason can hold engine limit state, a path on this machine or git's own words,
          // and NEVER_SENT keeps the first of those here. The hub learns that the run failed, not why.
          // Limit: one fixed sentence for every failure. Send a reason class once the protocol names some.
          error: run.failureReason === null ? null : RUN_FAILED,
          verdict: run.verdict,
          verdictReason: run.verdictReason,
          costUsd: run.costUsd,
          durationMs: run.durationMs,
          tokens: run.tokens,
          ...(comments ? {} : runExtras(run.question, extras.get(run.id))),
        },
      },
    });
  }
  return rows;
}

// The summary cut to the cap, and the answers only beside the question they answer.
function runExtras(question: string | null, row: { plain_summary: string | null; question_options: string | null; thread: string | null } | undefined): Pick<RunSync, 'summary' | 'questionOptions'> {
  const summary = row?.plain_summary?.trim() ? capSummary(row.plain_summary) : null;
  const options = question === null ? null : storedQuestionOptions(row?.question_options ?? null);
  return { ...(summary === null ? {} : { summary }), ...(options === null ? {} : { questionOptions: options }) };
}

/**
 * What the go button on the card page would start, as the board resolved it: the next stage for a card
 * that waits on nobody, its own stage for a failed one to retry. Nothing for a card that runs, waits,
 * asks or sits in a stage that starts no run, and nothing on a row whose model or login is not there,
 * because that start would be refused.
 *
 * Limit: a QA FAIL offers Fix it and open diff comments offer Send back on the card page; both read
 * here as the plain next start. Send the decision's own start once the phone draws those two.
 */
export function startOf(board: BoardSnapshot, key: string, vendors: ReadonlyMap<string, CardStart['engine']>): CardStart | undefined {
  const card = board.cards.find((one) => one.key === key);
  if (card === undefined) return undefined;
  const at = board.stages.findIndex((stage) => stage.id === card.stage);
  const stage = card.state === 'idle' || card.state === 'ready' ? board.stages[at + 1] : card.state === 'failed' ? board.stages[at] : undefined;
  const starts = stage === undefined || at < 0 ? null : cardStarts(stage, card);
  const engine = starts === null ? undefined : vendors.get(starts.engine);
  if (starts === null || starts.modelState !== 'ok' || engine === undefined) return undefined;
  return { phase: starts.phase, engine, model: starts.model, effort: starts.effort, ...(starts.estimate === undefined ? {} : { estimate: starts.estimate }) };
}

/**
 * A run's cost as `run.cost` carries it to the team hub, or null for a run that has not started.
 *
 * Field by field from the run row, so a column added to the row later does not reach the team on its
 * own. The question, the verdict reason, the failure, the log path, the session id, the effort and the
 * engine profile are on the row and are not read here.
 */
export function runCostOf(run: StoredRun): RunCost | null {
  if (run.startedAt === null) return null;
  return {
    runId: run.id,
    cardKey: run.cardKey,
    phase: run.phase,
    model: run.model,
    startedAt: run.startedAt,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    tokens: run.tokens,
  };
}

// The UTC day a move or a run belongs to, which is the day its evidence block lands on.
function dayOf(item: { card: CardSync } | { event: CardMove } | { run: RunSync }): string | null {
  if ('event' in item) return item.event.at.slice(0, 10);
  if ('run' in item) return item.run.startedAt?.slice(0, 10) ?? null;
  return null;
}

export interface HubSync {
  // Forgets what went out, for a socket that has just opened.
  reset: () => void;
  // Sends the board rows that changed since the last push on this socket, and answers the days those
  // rows touched, for the evidence push.
  board: () => string[];
  // Sends the evidence blocks of these days that changed since the last push on this socket.
  evidence: (days: readonly string[]) => Promise<void>;
  // Sends the Scout findings that changed since the last push on this socket. A check, a mute and
  // an assessment all reach it through the loop's change report.
  findings: () => void;
  // Sends the cost of each run that changed since the last push on this socket, for the team hub.
  // Nothing on a project that is not a team project.
  runCosts: () => void;
}

// `runs: false` is for the team socket. A run row holds the question a card waits on, the verdict
// reason and the failure, and those belong to the person who ran it. The team hub gets the cost,
// tokens and model of each run from `runCosts` instead.
//
// `snapshot` is the loop's board, which resolves each card's next start the way the board does. Left
// out, no card carries a start: the team socket passes none, because the start belongs to the person.
export function createHubSync(
  db: DatabaseSync,
  send: (type: RunnerMessageType, payload: unknown) => boolean,
  { runs = true, snapshot }: { runs?: boolean; snapshot?: (kind: BoardKind) => BoardSnapshot } = {},
): HubSync {
  let sent = new Map<string, string>();

  return {
    reset() {
      sent = new Map();
    },

    board() {
      const changed = boardRows(db, runs, snapshot).flatMap((row) => {
        const text = JSON.stringify(row.item);
        return sent.get(row.key) === text ? [] : [{ ...row, text }];
      });
      const days = new Set<string>();
      for (const kind of new Set(changed.map((row) => row.kind))) {
        const ofKind = changed.filter((row) => row.kind === kind);
        for (let at = 0; at < ofKind.length; at += CHUNK) {
          const part = ofKind.slice(at, at + CHUNK);
          const payload: CardStatePayload = { kind, cards: [], events: [], runs: [] };
          for (const { item } of part) {
            if ('card' in item) payload.cards.push(item.card);
            else if ('event' in item) payload.events.push(item.event);
            else payload.runs.push(item.run);
          }
          // A frame that did not go leaves its rows unsent, and the next push or the next open tries them.
          if (!send('card.state', payload)) return [...days];
          for (const row of part) {
            sent.set(row.key, row.text);
            const day = dayOf(row.item);
            if (day !== null) days.add(day);
          }
        }
      }
      return [...days];
    },

    async evidence(days) {
      // Evidence waits for a later version, so nothing of it leaves the machine meanwhile.
      if (!SCOUT_AND_EVIDENCE) return;
      for (const day of days) {
        const found = await evidenceFor(db, { day });
        const changed = found.blocks.flatMap((block) => {
          const key = `evidence ${day} ${block.source} ${block.ref}`;
          const text = JSON.stringify(block);
          return sent.get(key) === text ? [] : [{ key, text, block }];
        });
        for (let at = 0; at < changed.length; at += CHUNK) {
          const part = changed.slice(at, at + CHUNK);
          const blocks: EvidenceBlock[] = part.map((one) => one.block);
          if (!send('evidence.blocks', { blocks })) return;
          for (const one of part) sent.set(one.key, one.text);
        }
      }
    },

    findings() {
      const projectId = getSetting(db, 'projectId');
      if (projectId === null) return;
      const changed = allScoutFindings(db).flatMap((one) => {
        // The row as `FindingResult` names it, without the local row id. Field by field, so a column
        // added to the finding later does not reach the wire on its own.
        const finding: FindingResult = {
          sourceId: one.sourceId,
          fingerprint: one.fingerprint,
          kind: one.kind,
          status: one.status,
          occurrences: one.occurrences,
          firstSeen: one.firstSeen,
          lastSeen: one.lastSeen,
          location: one.location,
          externalKey: one.externalKey,
          cardKey: one.cardKey,
        };
        const key = `finding ${one.sourceId} ${one.fingerprint}`;
        const text = JSON.stringify(finding);
        return sent.get(key) === text ? [] : [{ key, text, finding }];
      });
      for (let at = 0; at < changed.length; at += CHUNK) {
        const part = changed.slice(at, at + CHUNK);
        const payload: FindingResults = { projectId, findings: part.map((one) => one.finding) };
        if (!send('finding.results', payload)) return;
        for (const one of part) sent.set(one.key, one.text);
      }
    },

    runCosts() {
      // One data folder holds one project, so every run here is a run of the team project.
      const teamProjectId = getSetting(db, 'teamProjectId');
      if (teamProjectId === null) return;
      const changed = allRuns(db).flatMap((run) => {
        const cost = runCostOf(run);
        if (cost === null) return [];
        const key = `cost ${run.id}`;
        const text = JSON.stringify(cost);
        return sent.get(key) === text ? [] : [{ key, text, cost }];
      });
      for (let at = 0; at < changed.length; at += CHUNK) {
        const part = changed.slice(at, at + CHUNK);
        const payload: RunCosts = { teamProjectId, runs: part.map((one) => one.cost) };
        if (!send('run.cost', payload)) return;
        for (const one of part) sent.set(one.key, one.text);
      }
    },
  };
}

/** The last `count` UTC days, today first. */
export function recentDays(count: number, now: Date = new Date()): string[] {
  return Array.from({ length: count }, (_, back) => new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10));
}
