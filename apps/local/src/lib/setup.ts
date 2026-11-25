import type { DatabaseSync } from 'node:sqlite';
import type { QueuedJob } from '@nolzu/core';
import { addNotification, bumpVersion, getSetting, writeSetting } from '@nolzu/core/node';
import { type BoardSnapshot, learnGates, repoOfLearnKey, SETUP_MARKS, shortReason, SETUP_STEPS, type SetupMark, type SetupStep, type SetupStepId, setupSteps, type SetupView } from '@nolzu/protocol';
import { personStarted } from './coach.ts';
import { learnReposOffer, repoStubs, startLearnReposPost } from './knowledge-learn.ts';
import type { Loop } from './loop.ts';
import { qaHasBrowser } from './mcp-store.ts';

/**
 * Set up the project, the server side: the steps read off the project, the marks a press
 * stores, the Learn gate on the first run, and "Learn and then start".
 */
export function setupFor(db: DatabaseSync): SetupStep[] {
  const marks = getSetting(db, 'setupSteps') ?? {};
  return setupSteps({
    marks,
    // Read from the files only while Learn has no mark, so a project that chose once reads no file
    // again. Limit: a few small files per snapshot until then; cache by project path if that shows.
    learned: marks.learn === undefined && repoStubs(db).every((repo) => !repo.stub),
    browser: qaHasBrowser(db),
    tickets: getSetting(db, 'ticketSystem') !== 'local',
  });
}

// Only a project New project made gates (its marks are not null): one made before the steps may have runs already.
export function setupView(db: DatabaseSync): SetupView {
  const steps = setupFor(db);
  return { steps, gates: getSetting(db, 'setupSteps') !== null && learnGates(steps, personStarted(db)) };
}

export function markSetup(db: DatabaseSync, step: SetupStepId, mark: SetupMark): void {
  writeSetting(db, 'setupSteps', { ...(getSetting(db, 'setupSteps') ?? {}), [step]: mark });
}

// The sentence a move that would start the first run is refused with while Learn is open. A screen
// opens the dialog before it sends the move, so this reaches only a move nobody could ask on, such as
// one from a phone or a stale page. Null when the move goes on.
export function learnFirst(db: DatabaseSync, key: string): string | null {
  return setupView(db).gates
    ? `Learn your repositories comes before the first run. Start ${key} again from its board to choose: learn them first, or write the knowledge yourself.`
    : null;
}

// Learn your repositories from Knowledge: a start does the step, so the banner goes and the first run
// is not held back. A refused start marks nothing.
export function startLearnRepos(live: Pick<Loop, 'db' | 'learnRepos' | 'changed'>, form: FormData) {
  const answer = startLearnReposPost(live, form);
  if (answer.ok) {
    markSetup(live.db, 'learn', 'done');
    live.changed();
  }
  return answer;
}

type Live = Pick<Loop, 'db' | 'scheduler' | 'onChange' | 'learnRepos' | 'changed'>;

// Whether a Learn your repositories run is in the queue, running or waiting.
const learning = (live: Pick<Loop, 'scheduler'>): QueuedJob | undefined => {
  const queue = live.scheduler.queue();
  return [...queue.running, ...queue.waiting].find((job) => repoOfLearnKey(job.cardKey) !== null);
};

/**
 * Learn and then start: one Learn run per repository not learned yet, and the card's move once every
 * one has left the queue, however it ended. The press is the consent for both. The move is stored, so
 * `followLearn` makes it after a restart too.
 */
export function learnThenStart(live: Live, key: string, to: string): void {
  const repos = repoStubs(live.db)
    .filter((repo) => repo.stub)
    .map((repo) => repo.path);
  // Throws the loop's sentence, such as knowledge still waiting for review, before anything is marked.
  live.learnRepos(repos);
  markSetup(live.db, 'learn', 'done');
  writeSetting(live.db, 'afterLearn', [...getSetting(live.db, 'afterLearn').filter((one) => one.key !== key), { key, to, at: new Date().toISOString() }]);
  // The board draws the held card from the snapshot, so the version moves.
  bumpVersion(live.db);
  live.changed();
}

/**
 * The check that makes the moves Learn and then start holds, once no Learn run is left in the queue.
 * The loop calls it on every change it tells, and once when it starts, so a move held when Nolzu
 * stopped is made when it starts again. It is no listener of the loop's, so a shut down loop holds
 * none. Each move goes once, whatever it answers, as a drag does.
 */
export function followLearn(live: Pick<Loop, 'db' | 'scheduler'>, move: (key: string, to: string) => unknown): () => void {
  return () => {
    const held = getSetting(live.db, 'afterLearn');
    if (held.length === 0 || learning(live) !== undefined) return;
    writeSetting(live.db, 'afterLearn', []);
    for (const one of held) {
      saySkippedLearn(live.db, one);
      void move(one.key, one.to);
    }
  };
}

// The card a Learn run held starts all the same when that run did not finish, as the press asked, and
// its bell entry says it started without Learn. Each repository counts by its newest Learn run, if
// that ended after the press: failed, or cut off by a restart. A Learn started again that passed is fine.
function saySkippedLearn(db: Pick<Loop, 'db'>['db'], one: { key: string; at: string }): void {
  const failed = db
    .prepare(
      `SELECT card_key AS key, error FROM runs AS one WHERE phase = 'learn-repo' AND ended_at >= ? AND state IN ('failed', 'interrupted')
         AND id = (SELECT max(id) FROM runs WHERE phase = 'learn-repo' AND card_key = one.card_key) ORDER BY id`,
    )
    .all(one.at) as { key: string; error: string | null }[];
  if (failed.length === 0) return;
  const repos = failed.map((run) => repoOfLearnKey(run.key) ?? run.key).join(', ');
  const reason = failed.map((run) => run.error).find((error): error is string => error !== null);
  const text = `${one.key} started without Learn, because learning ${repos} did not finish${reason === undefined ? '.' : `: ${shortReason(reason)}`}`;
  addNotification(db, { id: `after-learn:${one.key}:${one.at}`, kind: 'warning', card: one.key, text, href: '/knowledge' });
}

/**
 * The board as it draws a card Learn and then start holds: the column it starts after Learn, the
 * repository a Learn run reads now, and when the person pressed.
 */
export function withAfterLearn(snapshot: BoardSnapshot, live: Pick<Loop, 'db' | 'scheduler'>): BoardSnapshot {
  const held = getSetting(live.db, 'afterLearn');
  if (held.length === 0) return snapshot;
  const job = learning(live);
  const repo = job === undefined ? null : repoOfLearnKey(job.cardKey);
  const cards = snapshot.cards.map((card) => {
    const one = held.find((wait) => wait.key === card.key);
    if (one === undefined) return card;
    const column = snapshot.stages.find((stage) => stage.id === one.to)?.label ?? one.to;
    return { ...card, afterLearn: { column, repo, since: one.at } };
  });
  return { ...snapshot, cards };
}

const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const isStep = (value: unknown): value is SetupStepId => (SETUP_STEPS as readonly unknown[]).includes(value);
const isMark = (value: unknown): value is SetupMark => (SETUP_MARKS as readonly unknown[]).includes(value);

/**
 * The one write of the steps: `{ step, mark }` stores a mark, and `{ then: { key, to } }` is Learn and
 * then start. Each tells the open streams, so the banner and the gate change on every page.
 */
export async function postSetup(live: Live, request: Request): Promise<Response> {
  const body = ((await request.json().catch(() => null)) ?? {}) as { step?: unknown; mark?: unknown; then?: { key?: unknown; to?: unknown } };
  if (body.then !== undefined) {
    const { key, to } = body.then;
    if (typeof key !== 'string' || typeof to !== 'string') return answer({ message: 'Learn and then start needs a card key and the column it goes to.' }, 400);
    try {
      learnThenStart(live, key, to);
    } catch (error) {
      return answer({ message: (error as Error).message }, 409);
    }
    return answer({ ok: true });
  }
  if (!isStep(body.step) || !isMark(body.mark)) return answer({ message: 'A setup step needs its name, such as learn, and done, self or dismissed.' }, 400);
  if (body.mark === 'dismissed' && body.step === 'learn') return answer({ message: 'Learn your repositories is required, so it cannot be put away. Choose "I will write it myself" instead.' }, 400);
  markSetup(live.db, body.step, body.mark);
  live.changed();
  return answer({ ok: true });
}

// What the Learn dialog shows before a press: the repositories not learned yet and what each run
// starts on, as Knowledge offers it.
export function learnGateOffer(live: Pick<Loop, 'db' | 'models'>) {
  const offer = learnReposOffer(live.db, live.models());
  return { ...offer, repos: offer.repos.filter((repo) => repo.stub) };
}
