import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { recipeSectionOf, resolveKnowledgeDir, RUN_RECIPE_FILE, withRecipeSection } from '@nolzu/core';
import { applyKnowledgeChanges, getSetting, type KnowledgeChangeRow, knowledgeChangesOfRun, readRun, returnKnowledgeChanges } from '@nolzu/core/node';
import { type BoardSnapshot, isMaintenanceKey, repoOfLearnKey } from '@nolzu/protocol';
import { applyKnowledge, git, gitEnv, type HeldKnowledge, type RunGit } from '@nolzu/runner';
import { knowledgeLane } from './knowledge-page.ts';

/**
 * Approve and Return, the two answers a person gives a knowledge change that waits for review.
 *
 * With the review setting on, a run's own writing is kept aside and the folder is put back, so
 * nothing the person did not approve sits in their knowledge files. Approve writes the kept copy
 * back and commits it under the same card and run as an applied run's commit. Return drops the
 * kept copy and stores the note, which the next wrap-up of that card reads in its prompt.
 *
 * Both act on a whole run, because one run is one commit.
 */

// Where a run's kept change waits. In the data directory, not in the project: it is this machine's
// bookkeeping, and the project folder is the person's.
export const heldPath = (dataDir: string, runId: number): string => join(dataDir, 'knowledge-held', `${runId}.json`);

export function keepHeld(dataDir: string, held: HeldKnowledge): void {
  mkdirSync(join(dataDir, 'knowledge-held'), { recursive: true });
  writeFileSync(heldPath(dataDir, held.runId), JSON.stringify(held));
}

// Null when the file is gone or unreadable. A person who approves a change whose kept copy is gone
// reads that sentence, rather than a commit of nothing.
export function readHeld(dataDir: string, runId: number): HeldKnowledge | null {
  try {
    return JSON.parse(readFileSync(heldPath(dataDir, runId), 'utf8')) as HeldKnowledge;
  } catch {
    return null;
  }
}

/**
 * A kept change as Apply would write it now.
 *
 * Learn your repositories writes one section of the run recipe per repository, and each run's change
 * waits on its own. Its kept copy of the recipe was read before the other runs were applied, so it
 * is taken as that one section put into the recipe as it is now. Applying one repository never drops
 * the section another one's change applied, and the screen shows the section alone as the change.
 * Every other change goes back as it was kept.
 */
export function readHeldNow(db: DatabaseSync, dataDir: string, runId: number): HeldKnowledge | null {
  const held = readHeld(dataDir, runId);
  const repo = held === null ? null : repoOfLearnKey(held.cardKey);
  if (held === null || repo === null) return held;
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  const recipe = folder === null ? null : join(folder, RUN_RECIPE_FILE);
  if (recipe === null || !existsSync(recipe)) return held;
  const now = readFileSync(recipe, 'utf8');
  return {
    ...held,
    files: held.files.map((file) => {
      const section = file.content === null || !(file.path === RUN_RECIPE_FILE || file.path.endsWith(`/${RUN_RECIPE_FILE}`)) ? null : recipeSectionOf(file.content, repo);
      return section === null ? file : { ...file, content: withRecipeSection(now, repo, section) };
    }),
  };
}

export const dropHeld = (dataDir: string, runId: number): void => rmSync(heldPath(dataDir, runId), { force: true });

export interface ReviewAnswer {
  ok: boolean;
  // The one sentence the screen shows, whichever way it went.
  message: string;
}

export interface ReviewOptions {
  dataDir: string;
  runId: number;
  // The card the knowledge lane holds, from the board snapshot. A run writing the folder makes
  // this the wrong moment to commit in it.
  busy?: string | null;
  env?: Record<string, string | undefined>;
}

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

// Why this run's change cannot be answered, or null. The sentence names what happened to it, so a
// second Approve of the same run is not a button that does nothing.
function refuse(rows: readonly KnowledgeChangeRow[], runId: number): string | null {
  // A hand written post can name anything at all, and a sentence about run NaN says nothing to the
  // person reading it.
  if (!Number.isInteger(runId)) return 'That form named no run, so there was nothing to answer.';
  if (rows.length === 0) return `There is no knowledge change from run ${runId}.`;
  if (rows.some((row) => row.status === 'pending')) return null;

  // Any applied row first. Revert answers one file, so a run whose first file was taken back can
  // still have a second one in the knowledge files, and that is what the person needs to read.
  const applied = rows.find((row) => row.status === 'applied');
  if (applied !== undefined) {
    return `The knowledge change of run ${runId} was applied already, as commit ${applied.commitSha?.slice(0, 7)}. Nothing was applied a second time.`;
  }
  if (rows[0]?.status === 'returned') return `The knowledge change of run ${runId} was returned already. Run the wrap-up again to write it fresh.`;
  return `The knowledge change of run ${runId} was applied and then reverted. There is nothing left to answer.`;
}

/**
 * Writes an approved change back into the knowledge folder and commits it.
 *
 * The rows read applied with the sha when this answers ok. When git refuses the commit, or the
 * rows cannot be written, the commit is taken back and the change stays pending, so the person can
 * read what their repository said and try again.
 */
export async function approveKnowledge(db: DatabaseSync, options: ReviewOptions): Promise<ReviewAnswer> {
  const rows = knowledgeChangesOfRun(db, options.runId);
  const refused = refuse(rows, options.runId);
  if (refused !== null) return { ok: false, message: refused };

  const busy = options.busy ?? null;
  if (busy !== null) {
    const who = isMaintenanceKey(busy) ? 'A maintenance run' : busy;
    return { ok: false, message: `${who} is writing the knowledge folder right now. Approve this change once that run has ended.` };
  }

  const held = readHeldNow(db, options.dataDir, options.runId);
  if (held === null) {
    return {
      ok: false,
      message: `The kept copy of this change is gone from ${heldPath(options.dataDir, options.runId)}, so there is nothing to apply. Return the change and run the wrap-up again.`,
    };
  }

  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  if (folder === null || !existsSync(folder)) {
    return { ok: false, message: `There is no knowledge folder${folder === null ? '' : ` ${folder}`} to commit in. Make a project on New project at /new.` };
  }

  const env = options.env ?? process.env;
  const run: RunGit = (args) => git(args, { cwd: folder, env: gitEnv(env) });
  try {
    const commit = await applyKnowledge({
      run,
      held,
      record: (sha) => {
        // Nothing left to apply means somebody answered this run in the meantime. The commit is
        // taken back, so the rows and the knowledge history still say the same thing.
        if (applyKnowledgeChanges(db, options.runId, sha) === 0) {
          throw new Error(`The knowledge change of run ${options.runId} was answered while this one was being applied. Nothing was committed.`);
        }
      },
    });
    dropHeld(options.dataDir, options.runId);
    return { ok: true, message: `Applied ${files(held.files.length)} as commit ${commit.slice(0, 7)}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * Drops a change the person sent back, and stores the note they wrote with it.
 *
 * The folder is already back to what it was: the run's own writing was kept aside when the run
 * ended. So a return is a row update and a file the kept copy lived in, and no git work at all.
 */
export function returnKnowledge(db: DatabaseSync, options: ReviewOptions & { note: string }): ReviewAnswer {
  const rows = knowledgeChangesOfRun(db, options.runId);
  const refused = refuse(rows, options.runId);
  if (refused !== null) return { ok: false, message: refused };

  const note = options.note.trim();
  if (note === '') {
    return { ok: false, message: 'Write what the next run should do differently. It reads the note in its prompt, and a return with no note is a delete.' };
  }

  returnKnowledgeChanges(db, options.runId, note);
  dropHeld(options.dataDir, options.runId);
  const cardKey = rows[0]?.cardKey;
  // Optimize and Learn this project share the reserved key, and each reads only the notes on its own kind.
  // A Learn your repositories run has a key per repository, so the next run of that repository reads it.
  const phase = readRun(db, options.runId)?.phase;
  const maintenance = phase === 'learn-repo' ? 'The next Learn your repositories run of that repository' : phase === 'orient' ? 'The next Learn this project run' : 'The next Optimize run';
  const next = cardKey === undefined || isMaintenanceKey(cardKey) ? maintenance : `The next wrap-up of ${cardKey}`;
  return { ok: true, message: `Returned. ${next} reads the note.` };
}

// What the two forms on the Knowledge screen post. The run travels as a number, and the card
// holding the knowledge lane is read off the board snapshot, which is the one place busy state may
// come from.
export interface ReviewPost {
  dataDir: string;
  snapshot: () => Pick<BoardSnapshot, 'lanes'>;
}

const asked = (form: FormData): number => Number.parseInt(form.get('run')?.toString() ?? '', 10);

export const answerApprove = (db: DatabaseSync, live: ReviewPost, form: FormData): Promise<ReviewAnswer> =>
  approveKnowledge(db, { dataDir: live.dataDir, runId: asked(form), busy: knowledgeLane(live.snapshot()) });

/**
 * Apply all: the runs the screen showed, oldest first, each its own commit as Apply makes it. The first
 * refusal stops it, so nothing is applied past a change the person would have to read about, and the
 * answer says how many went in before it. Only the runs the post names, so a run that ended after the
 * page drew still waits for a person.
 */
export async function answerApproveAll(db: DatabaseSync, live: ReviewPost, form: FormData, env?: NodeJS.ProcessEnv): Promise<ReviewAnswer> {
  const runs = [...new Set(form.getAll('run').map((one) => Number.parseInt(one.toString(), 10)))].filter(Number.isInteger).sort((a, b) => a - b);
  if (runs.length === 0) return { ok: false, message: 'Nothing waits for a person, so there is nothing to apply.' };
  const word = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`;
  for (const [done, runId] of runs.entries()) {
    const answer = await approveKnowledge(db, { dataDir: live.dataDir, runId, busy: knowledgeLane(live.snapshot()), env });
    if (!answer.ok) return { ok: false, message: done === 0 ? answer.message : `Applied ${done} of ${word(runs.length)}, then stopped. ${answer.message}` };
  }
  return { ok: true, message: runs.length === 1 ? 'Applied 1 change.' : `Applied ${word(runs.length)}, one commit each.` };
}

export const answerReturn = (db: DatabaseSync, live: ReviewPost, form: FormData): ReviewAnswer =>
  returnKnowledge(db, { dataDir: live.dataDir, runId: asked(form), note: form.get('note')?.toString() ?? '' });
