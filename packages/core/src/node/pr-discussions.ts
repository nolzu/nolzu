import type { DatabaseSync } from 'node:sqlite';

/**
 * The pull requests of a Delivery card and the discussions on them, as the last read of GitHub left
 * them. Comment text is kept here and read by the card page only: the board snapshot and the hub never
 * see it.
 */

export type PullFoundBy = 'branch' | 'attached';
export type PullRequestState = 'open' | 'closed' | 'merged';
export type DiscussionKind = 'thread' | 'review' | 'comment';
export type DiscussionStatus = 'new' | 'fixing' | 'fixed' | 'done';
export type DiscussionVerdict = 'fix' | 'reject' | 'clarify' | 'defer' | 'none';

export interface StoredCardPull {
  id: number;
  card: string;
  // owner/name in lower case.
  repo: string;
  number: number;
  url: string | null;
  // As the last read of GitHub saw them, null before one did.
  title: string | null;
  state: PullRequestState | null;
  foundBy: PullFoundBy;
  // When its comments were last read, null before any read.
  readAt: string | null;
}

/** One discussion as GitHub answered it, the shape a read hands in. */
export interface DiscussionInput {
  kind: DiscussionKind;
  githubId: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  messages: { githubId: string; author: string | null; body: string; createdAt: string; url?: string | null }[];
}

export interface StoredMessage {
  id: number;
  githubId: string;
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
  mine: boolean;
  unread: boolean;
}

export interface StoredDiscussion {
  id: number;
  pull: number;
  ref: string;
  kind: DiscussionKind;
  githubId: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  status: DiscussionStatus;
  verdict: DiscussionVerdict | null;
  summary: string | null;
  reason: string | null;
  reply: string | null;
  fixNote: string | null;
  fixedAt: string | null;
  // Why the last Fix failed or was stopped, null once a new one starts or when none failed.
  fixFailed: string | null;
  // The question a Fix stopped on while its card waits for the answer, null otherwise.
  fixAsks: string | null;
  needsAction: boolean | null;
  messages: StoredMessage[];
}

export interface DiscussionsStored {
  // Discussions seen for the first time, and messages added to any of them.
  added: number;
  messages: number;
  // Fixed ones a reviewer answered again, and ones resolved on GitHub since the last read.
  reopened: number;
  done: number;
}

/**
 * Keeps one pull request of a card and answers its row id. A second save of the same one keeps how it
 * was first found, so a pull request a person attached stays attached when the branch finds it too.
 * A title or state left out keeps the one an earlier read saw.
 */
export function saveCardPull(
  db: DatabaseSync,
  card: string,
  pull: { repo: string; number: number; url: string | null; foundBy: PullFoundBy; title?: string | null; state?: PullRequestState | null },
): number {
  const row = db
    .prepare(
      'INSERT INTO card_pulls (card_key, repo, number, url, title, state, found_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (card_key, repo, number) DO UPDATE SET url = coalesce(excluded.url, url), title = coalesce(excluded.title, title), state = coalesce(excluded.state, state) RETURNING id',
    )
    .get(card, pull.repo.toLowerCase(), pull.number, pull.url, pull.title ?? null, pull.state ?? null, pull.foundBy) as { id: number };
  return row.id;
}

export function cardPullRows(db: DatabaseSync, card: string): StoredCardPull[] {
  const rows = db.prepare('SELECT id, card_key, repo, number, url, title, state, found_by, read_at FROM card_pulls WHERE card_key = ? ORDER BY id').all(card) as {
    id: number;
    card_key: string;
    repo: string;
    number: number;
    url: string | null;
    title: string | null;
    state: PullRequestState | null;
    found_by: PullFoundBy;
    read_at: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    card: row.card_key,
    repo: row.repo,
    number: row.number,
    url: row.url,
    title: row.title,
    state: row.state,
    foundBy: row.found_by,
    readAt: row.read_at,
  }));
}

/**
 * Takes an attached pull request off a card, with its discussions and their messages (the foreign keys
 * cascade). One the branch found stays, because the next read would find it again, and so does one a
 * fix is running on. The answer says which it was.
 */
export function detachCardPull(db: DatabaseSync, card: string, repo: string, number: number): 'detached' | 'branch' | 'fixing' | 'missing' {
  const row = db.prepare('SELECT id, found_by FROM card_pulls WHERE card_key = ? AND repo = ? AND number = ?').get(card, repo.toLowerCase(), number) as
    | { id: number; found_by: PullFoundBy }
    | undefined;
  if (row === undefined) return 'missing';
  if (row.found_by === 'branch') return 'branch';
  // A fix that runs on one of its discussions would write its note to a row that is gone.
  if (db.prepare("SELECT 1 FROM pr_discussions WHERE pull_id = ? AND status = 'fixing'").get(row.id) !== undefined) return 'fixing';
  db.exec('BEGIN IMMEDIATE');
  try {
    // The highest ref is kept, so a discussion read later never takes a ref the detached ones had.
    db.prepare('INSERT INTO seq (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = max(value, excluded.value)').run(refSeq(card), topRef(db, card));
    db.prepare('DELETE FROM card_pulls WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return 'detached';
}

// The highest ref a card has handed out, counting the ones of pull requests detached since.
const refSeq = (card: string) => `pr-refs:${card}`;
function topRef(db: DatabaseSync, card: string): number {
  const row = db
    .prepare("SELECT max(coalesce((SELECT max(CAST(substr(ref, 2) AS INTEGER)) FROM pr_discussions WHERE card_key = ?), 0), coalesce((SELECT value FROM seq WHERE name = ?), 0)) AS n")
    .get(card, refSeq(card)) as { n: number };
  return row.n;
}

// GitHub answers whole seconds and sqlite stamps milliseconds, so the two only compare as times.
const after = (one: string, other: string): boolean => Date.parse(one) > Date.parse(other);

/**
 * Stores one read of a pull request's discussions, under these rules:
 *
 * - A discussion seen for the first time gets the next free ref of the card, oldest first message first.
 * - A message is added once, by its GitHub id. One by the viewer is mine and never unread.
 * - A message whose text changed on GitHub since takes the new text, and is unread again unless it is
 *   mine. An edit alone changes nothing else on its discussion.
 * - A thread that became resolved on GitHub since the last read is done. While a fix runs on it, it
 *   waits for the first read after the fix.
 * - A reviewer message newer than the fix reopens a fixed discussion.
 * - Nothing else changes the status, so a person's done stays done, and a discussion that is gone on
 *   GitHub stays as it was.
 */
export function storeDiscussions(db: DatabaseSync, pullId: number, viewer: string | null, read: readonly DiscussionInput[]): DiscussionsStored {
  const pull = db.prepare('SELECT card_key FROM card_pulls WHERE id = ?').get(pullId) as { card_key: string } | undefined;
  if (pull === undefined) throw new Error(`No pull request ${pullId} is stored, so its comments have nowhere to go.`);
  const card = pull.card_key;
  const first = (item: DiscussionInput) => item.messages.reduce((min, one) => (min === '' || after(min, one.createdAt) ? one.createdAt : min), '');
  // Sorted so new refs follow the conversation. A discussion with no message left has nothing to show.
  const items = read.filter((item) => item.messages.length > 0).sort((one, other) => Date.parse(first(one)) - Date.parse(first(other)));
  const mineOf = (author: string | null) => viewer !== null && author !== null && author.toLowerCase() === viewer.toLowerCase();
  const done: DiscussionsStored = { added: 0, messages: 0, reopened: 0, done: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    let next = topRef(db, card) + 1;
    const find = db.prepare('SELECT id, resolved, status, fixed_at FROM pr_discussions WHERE pull_id = ? AND github_id = ?');
    const insert = db.prepare(
      'INSERT INTO pr_discussions (card_key, pull_id, ref, kind, github_id, path, line, resolved, outdated, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    );
    const update = db.prepare('UPDATE pr_discussions SET path = ?, line = ?, resolved = ?, outdated = ?, status = ? WHERE id = ?');
    const message = db.prepare('INSERT OR IGNORE INTO pr_messages (discussion_id, github_id, author, body, created_at, url, mine, unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    // GitHub always answers the current text, so a text that differs from the stored one is an edit.
    const edited = db.prepare('UPDATE pr_messages SET body = ?, unread = 1 - mine WHERE discussion_id = ? AND github_id = ? AND body != ?');
    for (const item of items) {
      const was = find.get(pullId, item.githubId) as { id: number; resolved: number; status: DiscussionStatus; fixed_at: string | null } | undefined;
      let id: number;
      let status: DiscussionStatus;
      if (was === undefined) {
        status = item.resolved ? 'done' : 'new';
        id = (insert.get(card, pullId, `T${next}`, item.kind, item.githubId, item.path, item.line, item.resolved ? 1 : 0, item.outdated ? 1 : 0, status) as { id: number }).id;
        next += 1;
        done.added += 1;
      } else {
        id = was.id;
        status = was.status;
      }
      let answered = false;
      for (const one of item.messages) {
        const mine = mineOf(one.author);
        const added = message.run(id, one.githubId, one.author, one.body, one.createdAt, one.url ?? null, mine ? 1 : 0, mine ? 0 : 1).changes > 0;
        if (!added) {
          edited.run(one.body, id, one.githubId, one.body);
          continue;
        }
        done.messages += 1;
        if (!mine && was?.fixed_at != null && after(one.createdAt, was.fixed_at)) answered = true;
      }
      if (was !== undefined) {
        if (item.resolved && was.resolved === 0 && status !== 'fixing' && status !== 'done') {
          status = 'done';
          done.done += 1;
        } else if (answered && status === 'fixed') {
          status = 'new';
          done.reopened += 1;
        }
        // While a fix runs, resolved keeps its old value, so the next read after the fix still sees
        // the thread become resolved and sets it done.
        const resolved = status === 'fixing' ? was.resolved : item.resolved ? 1 : 0;
        update.run(item.path, item.line, resolved, item.outdated ? 1 : 0, status, id);
      }
    }
    db.prepare("UPDATE card_pulls SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?").run(pullId);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return done;
}

/** Sets a discussion's status. Fixed stamps the time, which a later reviewer message is held against. */
export function setDiscussionStatus(db: DatabaseSync, id: number, status: DiscussionStatus): void {
  db.prepare(`UPDATE pr_discussions SET status = ?, fixed_at = CASE WHEN ? = 'fixed' THEN strftime('%Y-%m-%dT%H:%M:%fZ') ELSE fixed_at END WHERE id = ?`).run(status, status, id);
}

/**
 * Starts a Fix on one discussion: it becomes fixing and its last failure goes. Refused with the sentence
 * the PRs tab shows for a ref the card does not have, a done row, and while any row of the card is
 * fixing, because one Implement session cannot take two fixes at once.
 */
export function beginFix(db: DatabaseSync, card: string, ref: string): { ok: true; row: StoredDiscussion } | { ok: false; reason: string } {
  const rows = cardDiscussions(db, card);
  const row = rows.find((one) => one.ref === ref);
  if (row === undefined) return { ok: false, reason: `${card} has no discussion ${ref}. Read comments on its PRs tab first.` };
  const running = rows.find((one) => one.status === 'fixing');
  if (running !== undefined) return { ok: false, reason: running.ref === ref ? `${ref} is being fixed now. Wait for that fix to end.` : `${running.ref} is being fixed now. One fix runs at a time, so wait for it to end.` };
  if (row.status === 'done') return { ok: false, reason: `${ref} is done. Reopen it first if it still needs a fix.` };
  db.prepare("UPDATE pr_discussions SET status = 'fixing', fix_failed = NULL WHERE id = ?").run(row.id);
  // The row keeps why the last fix did not hold, so the run's message can say it.
  return { ok: true, row: { ...row, status: 'fixing' } };
}

/**
 * Starts Fix all: every row triage wants fixed that is new goes fixing, for one Implement run. Refused
 * while any row of the card is fixing, and when no such row is left. The rows come back as they were,
 * with why the last fix of each did not hold, so the run's message can say it.
 */
export function beginFixAll(db: DatabaseSync, card: string): { ok: true; rows: StoredDiscussion[] } | { ok: false; reason: string } {
  const rows = cardDiscussions(db, card);
  const running = rows.find((one) => one.status === 'fixing');
  if (running !== undefined) return { ok: false, reason: `${running.ref} is being fixed now. One fix runs at a time, so wait for it to end.` };
  const due = rows.filter((one) => one.verdict === 'fix' && one.status === 'new');
  if (due.length === 0) return { ok: false, reason: `${card} has no comment left that triage wants fixed. Run triage first, or use Fix on a row.` };
  const mark = db.prepare("UPDATE pr_discussions SET status = 'fixing', fix_failed = NULL WHERE id = ?");
  for (const row of due) mark.run(row.id);
  return { ok: true, rows: due.map((row) => ({ ...row, status: 'fixing' })) };
}

/**
 * The rows QA the fixes checks: fixed after the newest QA run that gave PASS or FAIL. A BLOCKED QA, or
 * one with no verdict, checked nothing, so its rows stay due.
 */
export function fixedSinceQa(db: DatabaseSync, card: string): StoredDiscussion[] {
  const last = lastJudgedQa(db, card);
  return cardDiscussions(db, card).filter((row) => row.status === 'fixed' && row.fixedAt !== null && (last === null || row.fixedAt > last));
}

/** When the newest QA run of the card that gave PASS or FAIL started, or null before one did. */
export function lastJudgedQa(db: DatabaseSync, card: string): string | null {
  return (db.prepare("SELECT max(started_at) AS at FROM runs WHERE card_key = ? AND phase = 'qa' AND verdict IN ('PASS', 'FAIL')").get(card) as { at: string | null }).at;
}

/** QA of the fixes failed these rows: each one still fixed goes back to new with QA's reason. */
export function reopenFixed(db: DatabaseSync, card: string, failed: readonly { ref: string; reason: string }[]): void {
  const back = db.prepare("UPDATE pr_discussions SET status = 'new', fix_failed = ? WHERE card_key = ? AND ref = ? AND status = 'fixed'");
  for (const one of failed) back.run(one.reason, card, one.ref);
}

/**
 * Ends a Fix. One that ended well is fixed with its one line note, stamped, so a later reviewer message
 * reopens it. One that failed, asked or was stopped is new again with the reason. Only a row that is
 * still fixing, so nothing here undoes what happened to it in between.
 */
export function endFix(db: DatabaseSync, id: number, outcome: { ok: true; note: string } | { ok: false; reason: string }): void {
  if (outcome.ok) {
    db.prepare("UPDATE pr_discussions SET status = 'fixed', fix_note = ?, fix_failed = NULL, fixed_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ? AND status = 'fixing'").run(outcome.note, id);
  } else {
    db.prepare("UPDATE pr_discussions SET status = 'new', fix_failed = ? WHERE id = ? AND status = 'fixing'").run(outcome.reason, id);
  }
}

/** Marks every message of a card seen, which opening its PRs tab does, and answers how many were unread. */
export function markDiscussionsSeen(db: DatabaseSync, card: string): number {
  return Number(db.prepare('UPDATE pr_messages SET unread = 0 WHERE unread = 1 AND discussion_id IN (SELECT id FROM pr_discussions WHERE card_key = ?)').run(card).changes);
}

/**
 * The person's own call on a discussion. Done sets it done and drops the override, so it goes to the
 * "Nothing to action" footer. Reopen sets a done one back to new and sets the override, so it stays out
 * of the footer whatever the verdict says. A read never undoes either, except that a thread resolved on
 * GitHub becomes done. One a fix runs on is left alone, because the fix writes its status when it ends.
 */
export function markDiscussion(db: DatabaseSync, card: string, ref: string, action: 'done' | 'reopen'): 'marked' | 'missing' | 'fixing' {
  const row = db.prepare('SELECT id, status FROM pr_discussions WHERE card_key = ? AND ref = ?').get(card, ref) as { id: number; status: DiscussionStatus } | undefined;
  if (row === undefined) return 'missing';
  if (row.status === 'fixing') return 'fixing';
  if (action === 'done') db.prepare("UPDATE pr_discussions SET status = 'done', needs_action = NULL WHERE id = ?").run(row.id);
  else db.prepare("UPDATE pr_discussions SET status = CASE WHEN status = 'done' THEN 'new' ELSE status END, needs_action = 1 WHERE id = ?").run(row.id);
  return 'marked';
}

/**
 * Writes what a triage run said onto the card's rows: the verdict, summary, reason and drafted reply.
 * Only an open row takes it. A done one, whether a person marked it or GitHub resolved it, is left
 * as it is, and so is a ref the card does not have. The status never changes here, so a fix that
 * runs keeps fixing, and a fixed row stays fixed until a reviewer answers.
 */
export function applyTriage(
  db: DatabaseSync,
  card: string,
  blocks: readonly { ref: string; verdict: DiscussionVerdict; summary: string; reason: string; reply: string | null }[],
): { applied: number; ignored: number } {
  const update = db.prepare("UPDATE pr_discussions SET verdict = ?, summary = ?, reason = ?, reply = ? WHERE card_key = ? AND ref = ? AND status != 'done'");
  let applied = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const one of blocks) applied += Number(update.run(one.verdict, one.summary, one.reason, one.reply, card, one.ref).changes);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return { applied, ignored: blocks.length - applied };
}

interface DiscussionRow {
  id: number;
  pull_id: number;
  ref: string;
  kind: DiscussionKind;
  github_id: string;
  path: string | null;
  line: number | null;
  resolved: number;
  outdated: number;
  status: DiscussionStatus;
  verdict: DiscussionVerdict | null;
  summary: string | null;
  reason: string | null;
  reply: string | null;
  fix_note: string | null;
  fixed_at: string | null;
  fix_failed: string | null;
  needs_action: number | null;
}

/** Every discussion of a card in ref order, each with its messages oldest first. */
export function cardDiscussions(db: DatabaseSync, card: string): StoredDiscussion[] {
  const rows = db.prepare('SELECT * FROM pr_discussions WHERE card_key = ? ORDER BY CAST(substr(ref, 2) AS INTEGER)').all(card) as unknown as DiscussionRow[];
  const messages = db.prepare('SELECT id, github_id, author, body, created_at, url, mine, unread FROM pr_messages WHERE discussion_id = ? ORDER BY created_at, id');
  // A row still fixing on a blocked card is a Fix that asked: the fix holds the card, and nothing else
  // can block it meanwhile. The question is on the newest implement run that names a ref, one ref for
  // a Fix and several for Fix all (a Discuss run names one too, and is no implement run).
  const blocked = (db.prepare('SELECT state FROM cards WHERE key = ?').get(card) as { state: string } | undefined)?.state === 'blocked';
  const asked = db.prepare("SELECT question FROM runs WHERE card_key = ? AND phase = 'implement' AND thread IS NOT NULL ORDER BY id DESC LIMIT 1");
  const asks = (row: DiscussionRow) => (blocked && row.status === 'fixing' ? ((asked.get(card) as { question: string | null } | undefined)?.question ?? null) : null);
  return rows.map((row) => ({
    id: row.id,
    pull: row.pull_id,
    ref: row.ref,
    kind: row.kind,
    githubId: row.github_id,
    path: row.path,
    line: row.line,
    resolved: row.resolved === 1,
    outdated: row.outdated === 1,
    status: row.status,
    verdict: row.verdict,
    summary: row.summary,
    reason: row.reason,
    reply: row.reply,
    fixNote: row.fix_note,
    fixedAt: row.fixed_at,
    fixFailed: row.fix_failed,
    fixAsks: asks(row),
    needsAction: row.needs_action === null ? null : row.needs_action === 1,
    messages: (
      messages.all(row.id) as { id: number; github_id: string; author: string | null; body: string; created_at: string; url: string | null; mine: number; unread: number }[]
    ).map((one) => ({ id: one.id, githubId: one.github_id, author: one.author, body: one.body, createdAt: one.created_at, url: one.url, mine: one.mine === 1, unread: one.unread === 1 })),
  }));
}

/**
 * What the board card says about each card's discussions, counts only: the rows triage wants fixed that
 * are not fixed yet, and the rows with a message nobody opened the PRs tab on. A card with neither is
 * left out. One query for the whole board, and no comment text, so the snapshot never carries any.
 */
export function feedbackCounts(db: DatabaseSync): Map<string, { toFix: number; unread: number }> {
  const rows = db
    .prepare(
      `SELECT card_key, count(CASE WHEN verdict = 'fix' AND status IN ('new', 'fixing') THEN 1 END) AS to_fix,
              sum(EXISTS (SELECT 1 FROM pr_messages m WHERE m.discussion_id = d.id AND m.unread = 1)) AS unread
       FROM pr_discussions d GROUP BY card_key`,
    )
    .all() as { card_key: string; to_fix: number; unread: number }[];
  return new Map(rows.filter((row) => row.to_fix > 0 || row.unread > 0).map((row) => [row.card_key, { toFix: row.to_fix, unread: row.unread }]));
}
