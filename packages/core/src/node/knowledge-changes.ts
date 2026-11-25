import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeStatus } from '@nolzu/protocol';

export type { KnowledgeStatus };

export interface KnowledgeChangeRow {
  id: number;
  // The card the knowledge came from, or the reserved key of a maintenance run that belongs to
  // no card.
  cardKey: string;
  runId: number;
  // From the knowledge repository's root, which is the path git itself prints.
  filePath: string;
  // Null while a change waits for review, because there is no commit yet.
  commitSha: string | null;
  summary: string | null;
  status: KnowledgeStatus;
  // What the person wrote when they returned the change, and null for every other status.
  note: string | null;
  // The knowledge folder the commit is in, when that is no longer the folder in use: the project
  // became a workspace and its knowledge moved. Null for a change made in the folder in use now.
  movedFrom: string | null;
}

export interface KnowledgeWrite {
  cardKey: string;
  runId: number;
  commitSha: string | null;
  status: KnowledgeStatus;
  files: readonly { path: string; summary: string | null }[];
}

interface Row {
  id: number;
  card_key: string;
  run_id: number;
  file_path: string;
  commit_sha: string | null;
  summary: string | null;
  status: string;
  note: string | null;
  moved_from: string | null;
}

const read = (row: Row): KnowledgeChangeRow => ({
  id: row.id,
  cardKey: row.card_key,
  runId: row.run_id,
  filePath: row.file_path,
  commitSha: row.commit_sha,
  summary: row.summary,
  status: row.status as KnowledgeStatus,
  note: row.note,
  movedFrom: row.moved_from,
});

/**
 * The rows behind one knowledge commit, written together.
 *
 * One transaction, because every row of a run names the same commit. Half of them would describe a
 * commit the screen could revert only in part.
 */
export function recordKnowledgeChanges(db: DatabaseSync, write: KnowledgeWrite): void {
  const insert = db.prepare(
    'INSERT INTO knowledge_changes (card_key, run_id, file_path, commit_sha, summary, status) VALUES (?, ?, ?, ?, ?, ?)',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of write.files) {
      insert.run(write.cardKey, write.runId, file.path, write.commitSha, file.summary, write.status);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Every change still waiting for a person. A knowledge run does not start while one is outstanding,
// because it would write against knowledge the waiting change has not applied yet, and the person
// could no longer approve both. A card's wrap-up waits for the answer, and every other run is refused.
export function pendingKnowledgeChanges(db: DatabaseSync): KnowledgeChangeRow[] {
  const rows = db.prepare("SELECT * FROM knowledge_changes WHERE status = 'pending' ORDER BY id").all() as unknown as Row[];
  return rows.map(read);
}

/**
 * Every change ever recorded, oldest first.
 *
 * The Knowledge screen reads them all in one go: the history of the open file, the pending list and
 * the day of the last applied change come from the same rows.
 */
export function allKnowledgeChanges(db: DatabaseSync): KnowledgeChangeRow[] {
  const rows = db.prepare('SELECT * FROM knowledge_changes ORDER BY id').all() as unknown as Row[];
  return rows.map(read);
}

/**
 * One change by its id, or null when there is no such row.
 *
 * The Knowledge screen's revert names a row and not a run. The history it sits in is per file, and
 * one run's commit can carry several files.
 */
export function knowledgeChange(db: DatabaseSync, id: number): KnowledgeChangeRow | null {
  const row = db.prepare('SELECT * FROM knowledge_changes WHERE id = ?').get(id) as unknown as Row | undefined;
  return row === undefined ? null : read(row);
}

// One run's whole change, in the order the files were committed.
export function knowledgeChangesOfRun(db: DatabaseSync, runId: number): KnowledgeChangeRow[] {
  const rows = db.prepare('SELECT * FROM knowledge_changes WHERE run_id = ? ORDER BY id').all(runId) as unknown as Row[];
  return rows.map(read);
}

/**
 * The rows of one run, from pending to applied, with the commit they were applied as.
 *
 * Only the pending rows, so a second approve of the same run moves nothing and the caller sees
 * that it changed no row.
 */
export function applyKnowledgeChanges(db: DatabaseSync, runId: number, commitSha: string): number {
  const done = db
    .prepare("UPDATE knowledge_changes SET status = 'applied', commit_sha = ? WHERE run_id = ? AND status = 'pending'")
    .run(commitSha, runId);
  return Number(done.changes);
}

// The rows of one run, from pending to returned, each carrying the note the person wrote. The note
// is on every row of the run because one return answers one run's whole change.
export function returnKnowledgeChanges(db: DatabaseSync, runId: number, note: string): number {
  const done = db
    .prepare("UPDATE knowledge_changes SET status = 'returned', note = ? WHERE run_id = ? AND status = 'pending'")
    .run(note, runId);
  return Number(done.changes);
}

/**
 * The note the next knowledge run of a card has to read, or null.
 *
 * Only when the card's newest change is a returned one. A run that wrote knowledge after the
 * return left newer rows, so its own answer to the note is already in the folder and the note is
 * read once rather than handed to every run of that card forever.
 *
 * `phase` keeps to the changes runs of that phase made. Optimize and Learn this project share the
 * reserved key, and a note written for one is no instruction for the other.
 */
export function returnedKnowledgeNote(db: DatabaseSync, cardKey: string, phase?: string): string | null {
  const ofPhase = phase === undefined ? '' : ' AND run_id IN (SELECT id FROM runs WHERE phase = ?)';
  const row = db.prepare(`SELECT status, note FROM knowledge_changes WHERE card_key = ?${ofPhase} ORDER BY id DESC LIMIT 1`).get(cardKey, ...(phase === undefined ? [] : [phase])) as
    | { status: string; note: string | null }
    | undefined;
  return row?.status === 'returned' ? row.note : null;
}

/**
 * One row, from applied to reverted.
 *
 * Only an applied row, so a second revert of the same change moves nothing and the caller sees that
 * it changed no row. The commit stays on the row: the screen still shows what the change was, with
 * the word that says it was taken back.
 */
export function revertKnowledgeChange(db: DatabaseSync, id: number): number {
  const done = db.prepare("UPDATE knowledge_changes SET status = 'reverted' WHERE id = ? AND status = 'applied'").run(id);
  return Number(done.changes);
}

/**
 * Marks every change not marked yet as committed in `folder`, which the project no longer uses.
 *
 * A row marked by an earlier move keeps its folder, because its commit is still in that one.
 */
export function markKnowledgeMoved(db: DatabaseSync, folder: string): number {
  return Number(db.prepare('UPDATE knowledge_changes SET moved_from = ? WHERE moved_from IS NULL').run(folder).changes);
}
