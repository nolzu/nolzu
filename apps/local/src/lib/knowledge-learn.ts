import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isRepoStub, type ModelsByVendor, projectRepos, repoKnowledgePath, resolveKnowledgeDir, type WallState } from '@nolzu/core';
import { getSetting, NOT_A_PASS, pendingKnowledgeChanges, projectProfiles } from '@nolzu/core/node';
import { type Estimate, KB_MAINTENANCE_KEY, learnRepoKey, type QuestionOption, storedQuestionOptions } from '@nolzu/protocol';
import type { ReviewAnswer } from './knowledge-review.ts';
import { measured, modelsFor } from './project-models.ts';

/**
 * Learn this project: the posts that start it and answer it, and
 * the question it waits on.
 *
 * It belongs to no card, so it has no card state to be blocked. Its newest run under the reserved key
 * says whether it asked: a run that ended with a question. Nothing here is busy state either. The
 * screens read the knowledge lane off the board snapshot, and these answers only say what happened.
 */

export interface LearnQuestion {
  runId: number;
  question: string;
  // The answers the run offered, each a button. Empty when it offered none.
  options: QuestionOption[];
  sessionId: string | null;
  engine: string;
}

export function learnAsking(db: DatabaseSync): LearnQuestion | null {
  const row = db
    .prepare(`SELECT id, phase, state, question, question_options, session_id, engine FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`)
    .get(KB_MAINTENANCE_KEY) as
    | { id: number; phase: string; state: string | null; question: string | null; question_options: string | null; session_id: string | null; engine: string }
    | undefined;
  if (row === undefined || row.phase !== 'orient' || row.state !== 'complete' || row.question === null || row.question.trim() === '') return null;
  return { runId: row.id, question: row.question, options: storedQuestionOptions(row.question_options) ?? [], sessionId: row.session_id, engine: row.engine };
}

// What the two posts reach of the loop. The loop throws the reason a run cannot start.
export interface LearnPost {
  learn: (repo?: string) => boolean;
  answer: (key: string, text: string) => boolean;
}

// "Open Knowledge again", never "reload": the answer sits on a form post, and reloading posts it twice.
export function startLearnPost(live: LearnPost, form: FormData): ReviewAnswer {
  const repo = form.get('repo')?.toString().trim() ?? '';
  try {
    if (!live.learn(repo === '' ? undefined : repo)) return { ok: false, message: 'Learn this project did not start, so nothing was read. Try it again.' };
    const start = repo === '' ? 'Learn this project is reading what people wrote.' : `Learn this project is reading what people wrote, starting with ${repo}.`;
    return { ok: true, message: `${start} Its questions and the files it writes wait on Knowledge, and nothing is applied before you approve it.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export function answerLearnPost(live: LearnPost, form: FormData): ReviewAnswer {
  const text = form.get('answer')?.toString() ?? '';
  if (text.trim() === '') return { ok: false, message: 'The answer is empty. Pick one of the answers or write your own, then send it.' };
  try {
    if (!live.answer(KB_MAINTENANCE_KEY, text)) return { ok: false, message: 'The run did not go on, so your answer was not read. Try it again.' };
    return { ok: true, message: 'Sent. Learn this project goes on with your answer. Open Knowledge again to see what it asks or writes next.' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * Learn your repositories: what the Knowledge screen offers before a press, and the post.
 *
 * Each repository with whether its file still holds only the lines Nolzu wrote, and what every run
 * starts on, read off the action's own row in the model table, the way a drop reads a stage's row.
 * The estimate is the row's measured one, per repository, and absent until runs measured it. Until
 * then `like` is a Refine run on the same model and effort, the low end of what a Learn run costs.
 */
export interface LearnReposOffer {
  // `waiting` is a learned file that waits in Pending review, so the screen does not call it missing.
  // `queued` is a Learn run for it that runs or waits now, so the screen does not offer it again.
  repos: { path: string; stub: boolean; waiting: boolean; queued?: 'running' | 'waiting' }[];
  // The engine profile, model and effort each run starts on.
  starts: { engine: string; model: string; effort: string; severalProfiles: boolean; estimate?: Estimate; like?: Estimate };
  // Why no run would start on that row, such as a model the engine stopped offering. Null when one would.
  refusal: string | null;
}

// Each repository of the project, and whether its knowledge file is missing or holds only the lines
// Nolzu wrote. Set up the project reads it too, to count Learn as done.
export function repoStubs(db: DatabaseSync): { path: string; stub: boolean }[] {
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  const stub = (path: string): boolean => {
    const file = folder === null ? null : join(folder, repoKnowledgePath(path));
    return file === null || !existsSync(file) || isRepoStub(readFileSync(file, 'utf8'));
  };
  return projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => ({ path: repo.path, stub: stub(repo.path) }));
}

export function learnReposOffer(db: DatabaseSync, models: ModelsByVendor, wall?: WallState, queue?: LearnQueue): LearnReposOffer {
  // A change's path starts at the knowledge folder's repository, which may hold the folder deeper down.
  const waiting = pendingKnowledgeChanges(db).map((change) => change.filePath);
  const inQueue = (path: string): 'running' | 'waiting' | undefined =>
    queue?.running.some((job) => job.cardKey === learnRepoKey(path)) ? 'running' : queue?.waiting.some((job) => job.cardKey === learnRepoKey(path)) ? 'waiting' : undefined;
  const repos = repoStubs(db).map((repo) => {
    const file = repoKnowledgePath(repo.path);
    const queued = inQueue(repo.path);
    return { ...repo, waiting: waiting.some((path) => path === file || path.endsWith(`/${file}`)), ...(queued === undefined ? {} : { queued }) };
  });
  const profiles = projectProfiles(db);
  // Limit: the whole Models section for one row, so the row, its warning and its estimate are the
  // ones Settings, Models shows. A read of that one row is the upgrade if this page load is ever slow.
  const row = modelsFor(db, models, wall).rows.find((one) => one.action === 'learn-repo');
  if (row === undefined) throw new Error('The model table has no Learn your repositories row.');
  const { engine, model, effort } = row.resolved;
  const estimate = measured(db, 'learn-repo', row.resolved, profiles);
  const like = estimate === undefined ? measured(db, 'refine', row.resolved, profiles) : undefined;
  return {
    repos,
    starts: { engine, model, effort, severalProfiles: profiles.length > 1, ...(estimate === undefined ? {} : { estimate }), ...(like === undefined ? {} : { like }) },
    refusal: row.warning,
  };
}

// The scheduler's queue, as far as the offer reads it.
export interface LearnQueue {
  waiting: readonly { cardKey: string }[];
  running: readonly { cardKey: string }[];
}

export interface LearnReposPost {
  learnRepos: (repos: readonly string[]) => number;
}

// Every ticked box is one `repo` field. The loop refuses an empty list, an unknown repository and a
// knowledge change still waiting, before any run starts.
export function startLearnReposPost(live: LearnReposPost, form: FormData): ReviewAnswer {
  const repos = form.getAll('repo').map((value) => value.toString().trim()).filter((value) => value !== '');
  try {
    const started = live.learnRepos(repos);
    if (started === 0) return { ok: false, message: 'No run started, so nothing was read. Try it again.' };
    const count = started === 1 ? '1 repository' : `${started} repositories, one after another`;
    return { ok: true, message: `Learning ${count}. What each run writes waits here for your review, and nothing is applied before you approve it.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
