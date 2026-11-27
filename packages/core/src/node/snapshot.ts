import type { DatabaseSync } from 'node:sqlite';
import { type BoardSnapshot, type Board, type CardState, type CardView, type DeliveryFlow, type DeliveryPhase, type Effort, type EpicTask, type LaneView, matchPlan, type PullDecision, type RunState, spendOf, type StageView, type StartsDescriptor, storedQuestionOptions, type Verdict } from '@nolzu/protocol';
import { boardFor, stageSays } from '../board.ts';
import { LANES, type LaneName, type QueueState, waitFor } from '../queue.ts';
import { isAction, type ModelsByVendor, type ResolvedTable, resolveModels } from '../models.ts';
import type { RunPlace, WallState } from '../phase-policy.ts';
import { cardBase, cardModels, cardPreset, cardSavedPreset } from './cards.ts';
import { boardVersion } from './db.ts';
import { pendingKnowledgeChanges } from './knowledge-changes.ts';
import { feedbackCounts, mergeBlockersByCard } from './pr-discussions.ts';
import { WATCHED_STAGES } from '../merge.ts';
import { startEstimate } from './estimates.ts';
import { boardRuns, NOT_A_PASS, parseOutputCheck } from './runs.ts';
import { getSetting, projectOutsideGit, projectProfiles } from './settings-store.ts';

export interface SnapshotInput {
  board: Board;
  // The one queue of this machine, every project's runs in it, because the slots and the lanes are
  // shared: the slots line, a lane's holder and a run's place count the other projects too.
  queue: QueueState;
  // The project this board belongs to, by its registry id. Only its own runs mark its cards, since a
  // card key repeats across projects. Left out, every run in the queue is this board's.
  project?: number;
  // What each vendor offers today, by vendor. A stage whose resolved model is not on the list of
  // the vendor its profile runs says so, rather than offering a drop that reads as if it would
  // start a run.
  models: ModelsByVendor;
  // The step titles of an epic's plan, or null with no plan in the step form. Asked only for an epic in
  // In delivery, whose count takes in each step not added to Delivery yet. Left out, no step counts.
  planned?: (key: string) => readonly string[] | null;
  // Whether Nolzu's wall starts on this machine, read once by the server, so a drop never offers a
  // phase the spawn would refuse.
  wall: WallState;
}

interface CardRow {
  key: string;
  title: string;
  stage: string;
  state: CardState;
  minimized: number;
  pr_author: string | null;
  // The word that says this card has a pull request. Null on every other card.
  pr_decision: PullDecision | null;
  pr_head_at: string | null;
  pr_draft: number;
  pr_state: 'open' | 'closed' | 'merged' | null;
  pr_seen_sha: string | null;
  pr_seen_commits: number | null;
  pr_head_sha: string | null;
  pr_head_commits: number | null;
  pr_round: number | null;
}

/**
 * The commits pushed since the last review round read the head, or null while there is nothing new.
 *
 * A head is compared and not a count, because a force push can leave the count as it was.
 * Limit: a rewrite that drops commits reads as 1 new commit. The head did move, which is what the
 * person needs to know; telling a rewrite apart needs a compare call per card.
 */
export function newCommitsOf(row: { pr_seen_sha: string | null; pr_seen_commits: number | null; pr_head_sha: string | null; pr_head_commits: number | null }): number | null {
  if (row.pr_seen_sha === null || row.pr_head_sha === null || row.pr_seen_sha === row.pr_head_sha) return null;
  return Math.max(1, (row.pr_seen_commits ?? 0) - (row.pr_head_commits ?? 0));
}

interface RunRow {
  id: number;
  card_key: string;
  phase: string;
  engine: string;
  model: string | null;
  effort: Effort | null;
  state: RunState | null;
  started_at: string | null;
  lane: string | null;
  cost_estimate: number | null;
  question: string | null;
  question_options: string | null;
  error: string | null;
  verdict: Verdict | null;
  verdict_reason: string | null;
  output_check: string | null;
}

// The badge of a run whose files the output check found problems in. Left out at none, so a card
// that was never checked and one that passed read the same.
function outputProblemsOf(stored: string | null): Pick<CardView, 'outputProblems'> {
  const problems = parseOutputCheck(stored)?.problems ?? [];
  return problems.length === 0 ? {} : { outputProblems: problems };
}

/**
 * Every epic's tasks, read in one query for the whole board, oldest first.
 *
 * A task is a linked card on the Delivery board. `card_links` keeps the pair once in key order, so
 * nothing records which side is the epic and both columns have to be asked. Done is the Delivery
 * board's archive stage, read off the board, because the flow swaps a stage in the middle and a
 * second copy of the id here would be the one that goes stale. Ordered by rowid and not by key: a key
 * sorts as text, so APP-10 would land before APP-2.
 *
 * Limit: a Delivery card a person links to an epic by hand counts as a task as well, which is
 * most likely what they meant by linking it. Telling the two apart needs a column of its own, so a
 * migration, and a second meaning for this table.
 */
// Two filters guard the same mistake from opposite ends: `e.board = 'epics'` below, and the
// `board.kind === 'epics'` test at the call site. Each one hides the other, so breaking either
// alone changes nothing a caller can see. Breaking BOTH puts a task count
// on a Delivery card that a person linked to another Delivery card, and the test named for it holds
// that pair together.
function epicTasks(db: DatabaseSync, flow: DeliveryFlow): Map<string, EpicTask[]> {
  const closed = boardFor('delivery', flow).stages.find((stage) => stage.role === 'archive')?.id ?? 'closed';
  const rows = db
    .prepare(
      `SELECT e.key AS epic, d.key, d.title, d.state, d.stage, l.step
       FROM cards e
       JOIN card_links l ON l.a = e.key OR l.b = e.key
       JOIN cards d ON d.key = CASE WHEN l.a = e.key THEN l.b ELSE l.a END AND d.board = 'delivery'
       WHERE e.board = 'epics'
       ORDER BY d.rowid`,
    )
    .all() as unknown as { epic: string; key: string; title: string; state: CardState; stage: string; step: string | null }[];
  return new Map(
    [...Map.groupBy(rows, (row) => row.epic)].map(([epic, list]) => [
      epic,
      list.map((row) => ({ key: row.key, title: row.title, state: row.state, done: row.stage === closed, ...(row.step === null ? {} : { step: row.step }) })),
    ]),
  );
}

// What an epic card says of its tasks. In delivery is the one column that follows them, so there a
// step of the plan not added yet counts too, and an epic with every task done waits on the person.
function deliveredOf(tasks: readonly EpicTask[], planned: readonly string[] | null, following: boolean): Pick<CardView, 'delivered' | 'tasks' | 'finished'> {
  const notAdded = following ? matchPlan(planned ?? [], tasks).filter((task) => task === null).length : 0;
  const done = tasks.filter((task) => task.done).length;
  const total = tasks.length + notAdded;
  return {
    delivered: total === 0 ? null : { done, total },
    ...(tasks.length === 0 ? {} : { tasks }),
    ...(following && total > 0 && done === total ? { finished: true } : {}),
  };
}

// Everything the board draws, in one read. No elapsed number and no ticking cost: the run start
// travels instead and the browser counts, so a running agent does not produce a snapshot a second.
// Nothing here names a file or a folder either, so the same shape can go to the hosted server later
// without carrying this machine's layout with it.
/**
 * The run state a person is shown. A wrap-up held for Knowledge is the person's only while a change waits
 * for them; held behind a knowledge run alone, it is a wait for the Knowledge lane. Its row keeps
 * `waiting_review`, which is what a Stop finds it by. Every screen that draws a run's state reads it
 * through this, so the board, Now, the trail and History say the same.
 */
export function shownRunState(db: DatabaseSync): (state: RunState | null) => RunState | null {
  const pending = pendingKnowledgeChanges(db).length > 0;
  return (state) => (state === 'waiting_review' && !pending ? 'waiting_lane' : state);
}

export function boardSnapshot(db: DatabaseSync, input: SnapshotInput): BoardSnapshot {
  const { board, queue, models, project: projectId } = input;
  const preset = getSetting(db, 'modelPreset');
  const global = getSetting(db, 'models');
  // The same resolver that builds the job, so the drop label, the button and the run never disagree.
  const profiles = projectProfiles(db);
  const place: RunPlace = { outsideGit: projectOutsideGit(db), wall: input.wall };
  const project = resolveModels(null, global, preset, models, profiles, null, place);
  const startsOf = (table: ResolvedTable, phase: DeliveryPhase): StartsDescriptor | null => {
    if (!isAction(phase)) return null;
    const resolved = table[phase];
    // A missing login first: with no profile nothing knows the vendor. Then the vendor rule, which
    // no model repairs, and only then the model.
    const modelState = resolved.missingProfile ? 'no-profile' : resolved.refusal !== null ? 'vendor' : resolved.gone ? 'gone' : 'ok';
    const vendor = profiles.find((one) => one.id === resolved.engine)?.vendor;
    return {
      phase,
      model: resolved.model,
      effort: resolved.effort,
      engine: resolved.engine,
      modelState,
      refusal: resolved.refusal,
      // Left off with one profile, so a board of one login reads as it always did.
      ...(profiles.length > 1 ? { severalProfiles: true } : {}),
      // Only for a row that starts a run. A refused drop has nothing to cost.
      estimate: modelState === 'ok' ? startEstimate(db, { phase, model: resolved.model, effort: resolved.effort, vendor }) : undefined,
    };
  };
  // Only for a card that stores models of its own or follows another preset than the project, built
  // in or saved; every other card follows the stage.
  const cardStartsOf = (key: string): CardView['starts'] => {
    const own = cardModels(db, key);
    const mine = cardPreset(db, key);
    if (own === null && mine === preset && cardSavedPreset(db, key) === null) return null;
    const table = resolveModels(own, cardBase(db, key), mine, models, profiles, null, place);
    const starts: NonNullable<CardView['starts']> = {};
    for (const stage of board.stages) {
      const found = stage.phase === undefined ? null : startsOf(table, stage.phase);
      if (found !== null && stage.phase !== undefined) starts[stage.phase] = found;
    }
    return starts;
  };

  const rows = db
    .prepare(
      'SELECT key, title, stage, state, minimized, pr_author, pr_decision, pr_head_at, pr_draft, pr_state, pr_seen_sha, pr_seen_commits, pr_head_sha, pr_head_commits, pr_round FROM cards WHERE board = ? ORDER BY key',
    )
    .all(board.kind) as unknown as CardRow[];

  // Only the epics board has tasks, so every other board pays nothing for the count.
  const tasks = board.kind === 'epics' ? epicTasks(db, getSetting(db, 'deliveryFlow')) : new Map<string, EpicTask[]>();
  // In delivery, the epics board's one column that waits on another board.
  const following = board.kind === 'epics' ? board.stages.find((stage) => stage.role === 'auto')?.id : undefined;
  const archive = board.stages.find((stage) => stage.role === 'archive')?.id;
  // Only Delivery cards have pull request comments, so every other board pays nothing for the count.
  const feedback = board.kind === 'delivery' ? feedbackCounts(db) : new Map<string, NonNullable<CardView['feedback']>>();
  // Only from Review to Wrap-up, the columns the timer keeps the read fresh in.
  const blocked = board.kind === 'delivery' ? mergeBlockersByCard(db) : new Map<string, NonNullable<CardView['blockers']>>();

  // The newest run per card. A card runs one phase at a time, so the newest is either the one it is
  // waiting on or the one that ended last, and that is the only run the board shows. A pass, the
  // summary after a phase or a commit message, is left out: its cost is on its own row, not in place
  // of the phase's.
  const runs = db
    .prepare(
      `SELECT r.id, r.card_key, r.phase, r.engine, r.model, r.effort, r.state, r.started_at, r.lane, r.cost_estimate, r.question, r.question_options, r.error,
              r.verdict, r.verdict_reason, r.output_check
       FROM runs r
       JOIN (SELECT card_key, max(id) AS id FROM runs WHERE ${NOT_A_PASS} GROUP BY card_key) newest ON newest.id = r.id`,
    )
    .all() as unknown as RunRow[];
  const newest = new Map(runs.map((row) => [row.card_key, row]));
  // Every run of each card, for its total.
  const runsOf = Map.groupBy(boardRuns(db, board.kind), (run) => run.cardKey);
  const jobs = new Map(
    [...queue.waiting, ...queue.running].filter((job) => projectId === undefined || job.project === projectId).map((job) => [job.cardKey, job]),
  );

  // A wrap-up held for Knowledge is the person's only while a change waits for them. Held behind a
  // knowledge run alone, it reads as a wait for the Knowledge lane. Its row keeps `waiting_review`,
  // which is what a Stop finds it by.
  const shown = runs.some((run) => run.state === 'waiting_review') ? shownRunState(db) : (state: RunState | null) => state;
  const runStateOf = (run: RunRow | null): RunState | null => shown(run?.state ?? null);

  const cards: readonly CardView[] = rows.map((row) => {
    const run = newest.get(row.key) ?? null;
    const job = jobs.get(row.key) ?? null;
    // Null for a job that is running: waitFor answers about the waiting list only.
    const wait = job === null ? null : waitFor(queue, job.runId, projectId);
    const options = storedQuestionOptions(run?.question_options ?? null);
    const follows = following !== undefined && row.stage === following;
    const pushed = newCommitsOf(row);
    // Not on a closed card, as for the output check: nothing there is left to answer.
    const comments = row.stage === archive ? undefined : feedback.get(row.key);
    const blockers = WATCHED_STAGES.includes(row.stage) ? blocked.get(row.key) : undefined;

    return {
      key: row.key,
      title: row.title,
      stage: row.stage,
      state: row.state,
      queuePosition: wait?.position ?? null,
      runId: run?.id ?? job?.runId ?? null,
      // A job the lane is holding reads waiting_lane, which is why it has not started. The card
      // itself still reads queued, because that is what the person is looking at.
      runState: wait === null ? runStateOf(run) : wait.reason === 'lane' ? 'waiting_lane' : 'queued',
      runPhase: run?.phase ?? null,
      runStartedAt: run?.started_at ?? null,
      lane: job?.lane ?? run?.lane ?? null,
      engine: run?.engine ?? null,
      model: run?.model ?? null,
      effort: run?.effort ?? null,
      costUsd: run?.cost_estimate ?? null,
      totalUsd: spendOf(runsOf.get(row.key) ?? []).costUsd,
      question: run?.question ?? null,
      ...(options === null ? {} : { questionOptions: options }),
      failureReason: run?.error ?? null,
      minimized: row.minimized === 1,
      verdict: run?.verdict ?? null,
      verdictReason: run?.verdict_reason ?? null,
      // Not on a closed card: its page draws no gate to list them, and nothing there needs attention.
      ...(row.stage === archive ? {} : outputProblemsOf(run?.output_check ?? null)),
      ...(comments === undefined ? {} : { feedback: comments }),
      ...(blockers === undefined ? {} : { blockers }),
      pull:
        row.pr_decision === null
          ? null
          : {
              author: row.pr_author,
              decision: row.pr_decision,
              headCommittedAt: row.pr_head_at,
              draft: row.pr_draft === 1,
              round: row.pr_round,
              ...(pushed === null ? {} : { newCommits: pushed }),
              ...(row.pr_state === 'closed' || row.pr_state === 'merged' ? { ended: row.pr_state } : {}),
            },
      starts: cardStartsOf(row.key),
      ...deliveredOf(tasks.get(row.key) ?? [], follows ? (input.planned?.(row.key) ?? null) : null, follows),
    };
  });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);

  const stages: readonly StageView[] = board.stages.map((stage) => {
    const says = stageSays(board.kind, stage.id);
    return {
      ...(says === undefined ? {} : { says }),
      id: stage.id,
      label: stage.label,
      role: stage.role,
      count: counts.get(stage.id) ?? 0,
      // No schedule exists yet. A sentence invented here would be one nobody chose.
      cadence: null,
      starts: stage.phase === undefined ? null : startsOf(project, stage.phase),
    };
  });

  const lanes: readonly LaneView[] = (Object.keys(LANES) as LaneName[]).map((name) => {
    const holder = queue.running.find((job) => job.lane === name);
    const elsewhere = holder?.project !== undefined && projectId !== undefined && holder.project !== projectId;
    return { name, heldBy: holder?.cardKey ?? null, ...(elsewhere ? { project: holder.project } : {}) };
  });

  return {
    version: boardVersion(db),
    kind: board.kind,
    flow: getSetting(db, 'deliveryFlow'),
    stages,
    cards,
    slots: { busy: queue.running.length, total: queue.slots },
    lanes,
    quietAfterMs: getSetting(db, 'quietAfterMs'),
  };
}
