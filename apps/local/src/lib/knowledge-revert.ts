import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { resolveKnowledgeDir } from '@nolzu/core';
import { getSetting, knowledgeChange, type KnowledgeChangeRow, revertKnowledgeChange } from '@nolzu/core/node';
import { type BoardSnapshot, isMaintenanceKey } from '@nolzu/protocol';
import { git, gitEnv, revertKnowledgeFile, type RunGit } from '@nolzu/runner';
import { knowledgeLane } from './knowledge-page.ts';
import type { ReviewAnswer } from './knowledge-review.ts';

/**
 * Revert, the one click that takes an applied knowledge change back.
 *
 * It is a revert commit, and the row reads `reverted`. It
 * answers one row, because the Revert button sits in the change history of one file
 * and a run's commit can carry several files. The revert of a whole run
 * belongs to the wrap-up tab, which has no such button yet.
 *
 * A revert is a commit and never a reset. The knowledge repository is the person's, and its
 * history is theirs.
 */

// An applied change is the only one that can be reverted, and it always names a commit.
export type AppliedChange = KnowledgeChangeRow & { commitSha: string };

/**
 * Whether this row can be reverted, or the one sentence saying why not.
 *
 * Each refusal names the file, and the commit where there is one, so a second click on a change
 * somebody already answered is not a button that does nothing.
 */
export function revertable(row: KnowledgeChangeRow | null, changeId: number): { ok: true; row: AppliedChange } | { ok: false; message: string } {
  // A hand written post can name anything at all, and a sentence about change NaN says nothing to
  // the person reading it.
  if (!Number.isInteger(changeId)) return { ok: false, message: 'That form named no change, so there was nothing to revert.' };
  if (row === null) return { ok: false, message: `There is no knowledge change ${changeId}.` };
  if (row.status === 'pending') {
    return { ok: false, message: `The change to ${row.filePath} waits for review, so it was never applied. There is nothing to revert.` };
  }
  if (row.status === 'returned') {
    return { ok: false, message: `The change to ${row.filePath} was returned, so it was never applied. There is nothing to revert.` };
  }
  if (row.commitSha === null) return { ok: false, message: `The change to ${row.filePath} names no commit, so there is nothing to revert.` };
  if (row.status === 'reverted') {
    return {
      ok: false,
      message: `The change to ${row.filePath} was reverted already. Commit ${row.commitSha.slice(0, 7)} is not in the knowledge files any more.`,
    };
  }
  // A revert run here would look for the commit in the wrong repository.
  if (row.movedFrom !== null) {
    return {
      ok: false,
      message: `The change to ${row.filePath} was committed in ${row.movedFrom}, before this project became a workspace. Commit ${row.commitSha.slice(0, 7)} is not in the knowledge folder in use now, so Nolzu cannot revert it here. Revert it in that folder with git revert.`,
    };
  }
  return { ok: true, row: { ...row, commitSha: row.commitSha } };
}

export interface RevertOptions {
  changeId: number;
  // The card the knowledge lane holds, from the board snapshot. A run writing the folder makes this
  // the wrong moment to commit in it.
  busy?: string | null;
  env?: Record<string, string | undefined>;
}

/**
 * Makes the revert commit and marks the row reverted.
 *
 * The row reads reverted when this answers ok. When git refuses the commit, or the row cannot be
 * written, the commit is taken back and the file is put where it was, so the rows and the knowledge
 * history still say the same thing.
 */
export async function revertKnowledge(db: DatabaseSync, options: RevertOptions): Promise<ReviewAnswer> {
  const found = revertable(Number.isInteger(options.changeId) ? knowledgeChange(db, options.changeId) : null, options.changeId);
  if (!found.ok) return found;
  const row = found.row;

  const busy = options.busy ?? null;
  if (busy !== null) {
    const who = isMaintenanceKey(busy) ? 'A maintenance run' : busy;
    return { ok: false, message: `${who} is writing the knowledge folder right now. Revert ${row.filePath} once that run has ended.` };
  }

  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  if (folder === null || !existsSync(folder)) {
    return { ok: false, message: `There is no knowledge folder${folder === null ? '' : ` ${folder}`} to commit in. Make a project on New project at /new.` };
  }

  const env = options.env ?? process.env;
  const run: RunGit = (args) => git(args, { cwd: folder, env: gitEnv(env) });
  try {
    const commit = await revertKnowledgeFile({
      run,
      sha: row.commitSha,
      path: row.filePath,
      cardKey: row.cardKey,
      runId: row.runId,
      record: () => {
        // Nothing left to revert means somebody answered this change in the meantime. The commit is
        // taken back, so no revert commit is left that no row names.
        if (revertKnowledgeChange(db, row.id) === 0) {
          throw new Error(`The change to ${row.filePath} was answered while this revert was being made. Nothing was committed.`);
        }
      },
    });
    return {
      ok: true,
      message: `Took ${row.filePath} back to what it was before commit ${row.commitSha.slice(0, 7)}. The revert is commit ${commit.slice(0, 7)}.`,
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

// What the Revert button posts. The change travels as a number, and the card holding the knowledge
// lane is read off the board snapshot, which is the one place busy state may come from.
export interface RevertPost {
  snapshot: () => Pick<BoardSnapshot, 'lanes'>;
}

export const answerRevert = (db: DatabaseSync, live: RevertPost, form: FormData): Promise<ReviewAnswer> =>
  revertKnowledge(db, { changeId: Number.parseInt(form.get('change')?.toString() ?? '', 10), busy: knowledgeLane(live.snapshot()) });
