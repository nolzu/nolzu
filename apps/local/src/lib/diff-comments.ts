import type { DatabaseSync } from 'node:sqlite';
import { cardRuns } from '@nolzu/core/node';
import type { DiffComment } from '@nolzu/protocol';
import { commentTarget, repoAsk } from './changes.ts';

// Enough for a paragraph about one line, and short enough that a log pasted by mistake is refused.
export const COMMENT_LIMIT = 4000;

interface Row {
  id: number;
  repo: string;
  file: string;
  line: number;
  line_text: string;
  body: string;
  commit_sha: string;
  created_at: string;
  sent_at: string | null;
}

const COLUMNS = 'id, repo, file, line, line_text, body, commit_sha, created_at, sent_at';

const shaped = (row: Row): DiffComment => ({
  id: row.id,
  repo: row.repo,
  file: row.file,
  line: row.line,
  lineText: row.line_text,
  text: row.body,
  commit: row.commit_sha,
  createdAt: row.created_at,
  sentAt: row.sent_at,
});

// What a comment route answers: the status, and the comment or the sentence that says why not.
export interface Said {
  status: number;
  body: { ok: true; comment?: DiffComment } | { ok: false; reason: string };
}

const refused = (status: number, reason: string): Said => ({ status, body: { ok: false, reason } });

// Every comment of the card, every repository, in the order they were made.
export function commentsOf(db: DatabaseSync, key: string): DiffComment[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM diff_comments WHERE card_key = ? ORDER BY id`).all(key) as unknown as Row[]).map(shaped);
}

// The diff comments not sent back yet, which Send back with comments counts in its label.
export function openCommentCount(db: DatabaseSync, key: string): number {
  return commentsOf(db, key).filter((one) => one.sentAt === null).length;
}

// The Implement session Send back with comments and Fix it go on in, shortened as the facts show it.
// None, and Implement starts fresh.
export function implementSession(db: DatabaseSync, key: string): string | null {
  return cardRuns(db, key).findLast((run) => run.phase === 'implement' && run.sessionId !== null)?.sessionId?.slice(0, 8) ?? null;
}

function textOf(body: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  const text = typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined;
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'A comment needs a text. Write what should change on this line.' };
  if (text.length > COMMENT_LIMIT) return { ok: false, reason: `A comment is at most ${COMMENT_LIMIT} characters. Shorten it and save again.` };
  return { ok: true, text: text.trim() };
}

/**
 * A new comment on one line of the card's diff: { repo, file, line, lineText, text }. `line` is the
 * line's number in the folder, and `lineText` the line as the page showed it, which is how the line
 * is found again after an edit moves it. A repository the card does not work in and a file its change
 * does not touch are refused.
 */
export async function addComment(
  db: DatabaseSync,
  key: string,
  body: unknown,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<Said> {
  const ask = (typeof body === 'object' && body !== null ? body : {}) as { repo?: unknown; file?: unknown; line?: unknown; lineText?: unknown };
  if (typeof ask.file !== 'string' || ask.file === '' || !Number.isInteger(ask.line) || (ask.line as number) < 1 || typeof ask.lineText !== 'string') {
    return refused(400, 'A comment needs a file, a line number and the text of that line.');
  }
  const text = textOf(body);
  if (!text.ok) return refused(400, text.reason);
  const repo = repoAsk(ask.repo);
  const target = await commentTarget(db, key, repo, ask.file, env, signal);
  if (!target.ok) return refused(422, target.reason);
  const row = db
    .prepare(
      `INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .get(key, repo, ask.file, ask.line as number, ask.lineText, text.text, target.commit, new Date().toISOString()) as unknown as Row;
  return { status: 201, body: { ok: true, comment: shaped(row) } };
}

// The comment's id comes from the address, so it is read as a number and looked for on this card only.
const idOf = (id: string): number => (/^\d+$/.test(id) ? Number(id) : 0);

// A new text for one of the card's comments: { text }. Its line stays where it was made. A sent one
// keeps the text Implement was told, as the page shows it with no Edit.
export function editComment(db: DatabaseSync, key: string, id: string, body: unknown): Said {
  const text = textOf(body);
  if (!text.ok) return refused(400, text.reason);
  const row = db
    .prepare(`UPDATE diff_comments SET body = ? WHERE id = ? AND card_key = ? AND sent_at IS NULL RETURNING ${COLUMNS}`)
    .get(text.text, idOf(id), key) as unknown as Row | undefined;
  if (row !== undefined) return { status: 200, body: { ok: true, comment: shaped(row) } };
  if (db.prepare('SELECT 1 FROM diff_comments WHERE id = ? AND card_key = ?').get(idOf(id), key) !== undefined) {
    return refused(409, 'That comment was sent back already, so it keeps the text Implement got. Write a new comment instead.');
  }
  return refused(404, `${key} has no comment ${id}. Read the page again.`);
}

export function deleteComment(db: DatabaseSync, key: string, id: string): Said {
  const done = db.prepare('DELETE FROM diff_comments WHERE id = ? AND card_key = ?').run(idOf(id), key);
  if (done.changes === 0) return refused(404, `${key} has no comment ${id}. Read the page again.`);
  return { status: 200, body: { ok: true } };
}
