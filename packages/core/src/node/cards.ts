import type { DatabaseSync } from 'node:sqlite';
import type { Board, BoardKind, CardSize, CardState, DeliveryPhase, PullView, StackState } from '@nolzu/protocol';
import { cardKeyProblem, isBoardKind, keyPrefixFor, localKey, localTitle } from '@nolzu/protocol';
import { canMove, phaseOnEnter } from '../board.ts';
import { type ModelTable, type PresetName, renamedActions, type SavedPreset, validateModelTable } from '../models.ts';
import { projectRepos } from '../settings.ts';
import { bumpVersion } from './db.ts';
import { getSetting } from './settings-store.ts';

// Injected, so core never imports the runner.
export type StartRun = (key: string, phase: DeliveryPhase) => void | Promise<void>;

// `who` is "auto" for the chain a person allowed in advance, which moves the card the way a drop does.
// `reason` is the line a person wrote for the move, such as why a QA FAIL goes on anyway.
export async function moveCard(
  db: DatabaseSync,
  board: Board,
  key: string,
  to: string,
  startRun: StartRun,
  who: 'you' | 'auto' = 'you',
  reason: string | null = null,
): Promise<void> {
  let phase: DeliveryPhase | undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read under the write lock, so two moves of the same card cannot both pass the check.
    const card = db.prepare('SELECT stage, state FROM cards WHERE key = ? AND board = ?').get(key, board.kind) as
      | { stage: string; state: CardState }
      | undefined;
    if (!card) throw new Error(`The ${board.kind} board has no card ${key}.`);
    // A column that is not on this board at all. `canMove` refuses it too, and its sentence blames
    // the card's state for a stage that was never there, which sends a person looking at the card.
    if (!board.stages.some((stage) => stage.id === to)) {
      throw new Error(`The ${board.kind} board has no ${to} column, so ${key} cannot move there.`);
    }
    if (!canMove(board, card, to)) {
      throw new Error(
        `${key} cannot move from ${card.stage} to ${to} while it is ${card.state}. A card moves one stage forward or any number back, and never while it is queued or running.`,
      );
    }
    phase = phaseOnEnter(board, card.stage, to);
    recordMove(db, key, card.stage, to, who, phase ?? null, reason);
    // Queued locks the card until its run reports a state.
    db.prepare('UPDATE cards SET stage = ?, state = ? WHERE key = ?').run(to, phase ? 'queued' : 'idle', key);
    // Inside the same transaction, so a board read never sees the move without the version that
    // announces it.
    bumpVersion(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  if (!phase) return;
  try {
    await startRun(key, phase);
  } catch (error) {
    // A queued card refuses every move, so a run that never started would lock it for good.
    db.prepare("UPDATE cards SET state = 'failed' WHERE key = ?").run(key);
    throw error;
  }
}

// The one writer of a timeline row. A move by hand and a move a card makes on its own both come
// through here, so the Evidence timeline shows them the same way.
export function recordMove(db: DatabaseSync, key: string, from: string, to: string, who: 'you' | 'auto', startedPhase: string | null, reason: string | null = null): void {
  db.prepare('INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase, reason) VALUES (?, ?, ?, ?, ?, ?)').run(
    key,
    from,
    to,
    who,
    startedPhase,
    reason,
  );
}

/**
 * One stage move, as `recordMove` above wrote it.
 *
 * `who` is "you" for a move by hand, and "auto" for a move Nolzu made on its own: QA's PASS, and the
 * chain a person allowed in advance. The timeline reads both the same way. The chain suggestion
 * reads only "you", because a move Nolzu made is no person's approval.
 */
export interface CardMove {
  id: number;
  cardKey: string;
  fromStage: string | null;
  toStage: string;
  who: string;
  // UTC, with the Z on it, from the column's own default.
  at: string;
  // The phase the move started, or null when it started none.
  startedPhase: string | null;
}

// Every move of every card, oldest first, which is the order they happened in. A deleted card takes
// its moves with it: the table's foreign key cascades.
export function allCardMoves(db: DatabaseSync): CardMove[] {
  const rows = db
    .prepare('SELECT id, card_key, from_stage, to_stage, who, at, started_phase FROM card_events ORDER BY id')
    .all() as unknown as { id: number; card_key: string; from_stage: string | null; to_stage: string; who: string; at: string; started_phase: string | null }[];
  return rows.map((row) => ({
    id: row.id,
    cardKey: row.card_key,
    fromStage: row.from_stage,
    toStage: row.to_stage,
    who: row.who,
    at: row.at,
    startedPhase: row.started_phase,
  }));
}

// A value and not a toggle, so a request sent twice, or from two windows at once, ends where both
// asked. A run does not lock this: parking a card moves nothing.
//
// False when the board has no such card. An answer and not a throw, so the caller cannot mistake a
// database that refused the write for a card that is not there.
export function setMinimized(db: DatabaseSync, key: string, minimized: boolean): boolean {
  const done = db.prepare('UPDATE cards SET minimized = ? WHERE key = ?').run(minimized ? 1 : 0, key);
  if (done.changes === 0) return false;
  bumpVersion(db);
  return true;
}

// A pull request's head as one read of GitHub saw it. Null where the read carried none.
export interface PullHead {
  sha: string | null;
  commits: number | null;
}

// The head a pull request card's last read saw, which is what a review run that starts now reads.
export function seenHead(db: DatabaseSync, key: string): PullHead {
  const row = db.prepare('SELECT pr_seen_sha AS sha, pr_seen_commits AS commits FROM cards WHERE key = ?').get(key) as PullHead | undefined;
  return row ?? { sha: null, commits: null };
}

/**
 * The round a review run wrote, and the head it read. A later read that sees another head is how the
 * card says "1 new commit", and how a card that waits on the author goes back to Incoming
 * (`refreshPulls`). No round starts by itself: that is a person's drop on Agent pre-review.
 */
export function savePullRound(db: DatabaseSync, key: string, round: number, head: PullHead): void {
  db.prepare('UPDATE cards SET pr_round = ?, pr_head_sha = ?, pr_head_commits = ? WHERE key = ?').run(round, head.sha, head.commits, key);
  bumpVersion(db);
}

/**
 * The board a card belongs to, or null when there is no such card.
 *
 * A stage id repeats across boards: `inbox`, `refine`, `plan`, `review` and `wrapup` are on Epics
 * as well as on Delivery. So a reader that takes a card's stage against the wrong board's stage
 * list answers about another board's columns rather than answering nothing, which is the failure
 * this exists to stop.
 */
export function boardOfCard(db: DatabaseSync, key: string): BoardKind | null {
  const row = db.prepare('SELECT board FROM cards WHERE key = ?').get(key) as { board: string } | undefined;
  // The column is plain text with no check behind it, so a name this version does not know reads as
  // no board. Handed on, it would build a board with no stages and the first stage lookup would
  // throw somewhere far from here.
  return row !== undefined && isBoardKind(row.board) ? row.board : null;
}

export interface NewCard {
  key: string;
  // One of the five, not any string. The board of a card decides which stages it can move through,
  // so a name that is no board is a card nothing can read.
  board: BoardKind;
  stage: string;
  title: string;
  summary?: string | null;
  // Where the card came from. Everything typed by hand is a local ticket, which is the default.
  source?: string;
  sourceRef?: string | null;
  // The pull request this card was made from, on the PR reviews board. No round: a review run
  // writes that (`savePullRound`). The head and the commit count are what the read saw, kept so a
  // later read can tell the author pushed since a round.
  pull?: (Omit<PullView, 'round' | 'ended' | 'newCommits'> & { headSha?: string; commits?: number }) | null;
  // What the person picked in Add card. Left out means none.
  size?: CardSize | null;
}

export function createCard(db: DatabaseSync, card: NewCard): void {
  // Every card this app writes comes through here, so the key is checked here and nowhere else. A
  // key out of a ticket system is text somebody else wrote, and sqlite takes any of it: the row is
  // made, and the folder, the checkout and the run all refuse it later, one screen at a time.
  const problem = cardKeyProblem(card.key);
  // The key is not printed back. It can hold a line break or a whole log line, and this sentence is
  // drawn on a page.
  if (problem !== null) throw new Error(`${problem} No card was made.`);

  // Asked before the insert, so the person reads a sentence about their board rather than the
  // word sqlite uses for a primary key it already holds.
  if (db.prepare('SELECT key FROM cards WHERE key = ?').get(card.key) !== undefined) {
    throw new Error(`${card.key} is already on the board. Open that card, or use another key.`);
  }

  const pull = card.pull ?? null;
  db.prepare(
    `INSERT INTO cards (key, board, stage, title, summary, source, source_ref, pr_author, pr_decision, pr_head_at, pr_draft, pr_seen_sha, pr_seen_commits, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    card.key,
    card.board,
    card.stage,
    card.title,
    card.summary ?? null,
    card.source ?? 'local',
    card.sourceRef ?? null,
    pull?.author ?? null,
    pull?.decision ?? null,
    pull?.headCommittedAt ?? null,
    pull?.draft === true ? 1 : 0,
    pull?.headSha ?? null,
    pull?.commits ?? null,
    card.size ?? null,
  );
  // A ticket a person deleted and now adds again is wanted back, so the read may bring it again too.
  if (card.sourceRef != null) db.prepare('DELETE FROM deleted_tickets WHERE source_ref = ?').run(card.sourceRef);
  // A new card is a change a person sees on the board, so the board version moves with it.
  bumpVersion(db);
}

export interface NewLocalTicket {
  projectId: number;
  prefix: string;
  title: string;
  description: string;
  // One of the five, the way a card's own board is. Left out means Delivery.
  board?: BoardKind;
  stage?: string;
  size?: CardSize | null;
}

// One counter per project and prefix, so a second project on the same machine starts at 1 again
// rather than continuing someone else's numbering.
const ticketSeq = (projectId: number, prefix: string) => `ticket:${projectId}:${prefix}`;

// The key the next local ticket gets, read without taking it. `createLocalTicket` takes the key this
// finds, so the key Add card shows is the key the card gets, unless another card takes it first.
export function peekLocalKey(db: DatabaseSync, projectId: number, prefix: string): { key: string; n: number } {
  const row = db.prepare('SELECT value FROM seq WHERE name = ?').get(ticketSeq(projectId, prefix)) as { value: number } | undefined;
  let n = (row?.value ?? 0) + 1;
  // A number another card already holds is skipped, such as an external key kept before the prefix
  // changed. Taking it would refuse this card and every one after it.
  while (db.prepare('SELECT key FROM cards WHERE key = ?').get(localKey(prefix, n)) !== undefined) n += 1;
  return { key: localKey(prefix, n), n };
}

// A local ticket is the card. There is no ticket table behind it: the title is the card's title and
// the description is its summary.
export function createLocalTicket(db: DatabaseSync, ticket: NewLocalTicket): { key: string } {
  // A Research kind numbers under its own prefix here, the one writer every caller goes through.
  const prefix = keyPrefixFor(ticket.board ?? 'delivery', ticket.prefix);
  const { key, n } = peekLocalKey(db, ticket.projectId, prefix);
  // Limit: the peek and this write are two statements with no await between them, so nothing in this
  // process comes between. A second process on one database relies on the caller's BEGIN IMMEDIATE,
  // which the app's card writers open, and the key's primary key refuses a duplicate either way.
  db.prepare('INSERT INTO seq (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value').run(ticketSeq(ticket.projectId, prefix), n);

  // Typed text can be a whole paragraph. The board shows its first line, cut, and the card's text keeps
  // every word, above the description when the person wrote one too.
  const typed = ticket.title.trim();
  const title = localTitle(typed);
  const description = ticket.description.trim();
  const summary = title === typed ? description : description === '' ? typed : `${typed}\n\n${description}`;
  createCard(db, {
    key,
    board: ticket.board ?? 'delivery',
    stage: ticket.stage ?? 'inbox',
    title,
    summary: summary === '' ? null : summary,
    size: ticket.size ?? null,
  });

  return { key };
}

/**
 * A card's title, set by Refine or by a person. Answers whether it changed.
 *
 * Refine sets it only on a local card: a GitHub or Jira card keeps the title its ticket has. It never
 * replaces a title a person set. Refine puts the old title in an empty description first, so the
 * idea a card was made from is not lost.
 */
export function setCardTitle(db: DatabaseSync, key: string, title: string, by: 'refine' | 'person'): boolean {
  const next = localTitle(title);
  if (next === '') return false;
  const card = db.prepare('SELECT title, summary, source, title_by FROM cards WHERE key = ?').get(key) as
    | { title: string; summary: string | null; source: string; title_by: string | null }
    | undefined;
  if (card === undefined || card.title === next) return false;
  if (by === 'refine' && (card.source !== 'local' || card.title_by === 'person')) return false;
  const summary = by === 'refine' && (card.summary ?? '').trim() === '' ? card.title : card.summary;
  db.prepare('UPDATE cards SET title = ?, summary = ?, title_by = ? WHERE key = ?').run(next, summary, by, key);
  bumpVersion(db);
  return true;
}

export function linkCards(db: DatabaseSync, one: string, other: string): void {
  if (one === other) {
    throw new Error(`${one} cannot be linked to itself.`);
  }

  // The table keeps the pair once in a fixed order, and its check refuses the mirror image, so the
  // order they arrive in here does not matter and a second call writes nothing.
  const [a, b] = one < other ? [one, other] : [other, one];
  // OR IGNORE covers the check and the primary key, and not the foreign keys, so a key with no card
  // row would reach the person as sqlite's own sentence. The rows are asked for first, the way
  // createCard asks, and the foreign key stays behind it as the backstop.
  const missing = [a, b].find((key) => db.prepare('SELECT key FROM cards WHERE key = ?').get(key) === undefined);
  if (missing !== undefined) {
    throw new Error(`The board has no card ${missing}, so it cannot be linked.`);
  }

  db.prepare('INSERT OR IGNORE INTO card_links (a, b) VALUES (?, ?)').run(a, b);
}

// The cards linked to this one. A link is stored once per pair, so both columns are asked, and the
// check on the table keeps a card from being linked to itself.
export function relatedCards(db: DatabaseSync, key: string): { key: string; title: string }[] {
  return db
    .prepare(
      `SELECT c.key, c.title FROM card_links l JOIN cards c ON c.key = CASE WHEN l.a = ? THEN l.b ELSE l.a END
       WHERE l.a = ? OR l.b = ? ORDER BY c.key`,
    )
    .all(key, key, key) as { key: string; title: string }[];
}

// The epic a Delivery card is a task of: the oldest card on the Epics board linked to it. Null for a card
// on another board or with no epic.
export function epicOfTask(db: DatabaseSync, key: string): { key: string; title: string } | null {
  return (
    (db
      .prepare(
        `SELECT e.key, e.title FROM cards t
         JOIN card_links l ON l.a = t.key OR l.b = t.key
         JOIN cards e ON e.key = CASE WHEN l.a = t.key THEN l.b ELSE l.a END AND e.board = 'epics'
         WHERE t.key = ? AND t.board = 'delivery' ORDER BY e.rowid LIMIT 1`,
      )
      .get(key) as { key: string; title: string } | undefined) ?? null
  );
}

// Removes the link, whichever way round the two keys come. False when there was none.
export function unlinkCards(db: DatabaseSync, one: string, other: string): boolean {
  const [a, b] = one < other ? [one, other] : [other, one];
  return db.prepare('DELETE FROM card_links WHERE a = ? AND b = ?').run(a, b).changes > 0;
}

// The context a person adds to the ticket. Only whitespace clears it, so nothing empty is stored.
// False when there is no such card.
export function setExtraContext(db: DatabaseSync, key: string, text: string): boolean {
  const value = text.trim() === '' ? null : text;
  const changed = db.prepare('UPDATE cards SET extra_context = ? WHERE key = ?').run(value, key).changes > 0;
  if (changed) bumpVersion(db);
  return changed;
}

// The card's own models, or null when it inherits everything. A value that no longer passes the rules,
// from a hand edit or an older version, reads as nothing stored, so the card runs on what it inherits.
export function cardModels(db: DatabaseSync, key: string): ModelTable | null {
  const row = db.prepare('SELECT models_json FROM cards WHERE key = ?').get(key) as { models_json: string | null } | undefined;
  if (row?.models_json == null) return null;
  try {
    const table = renamedActions(JSON.parse(row.models_json));
    return validateModelTable(table) === null ? (table as ModelTable) : null;
  } catch {
    return null;
  }
}

// Null clears the column. False when the board has no such card.
export function setCardModels(db: DatabaseSync, key: string, table: ModelTable | null): boolean {
  const result = db.prepare('UPDATE cards SET models_json = ? WHERE key = ?').run(table === null ? null : JSON.stringify(table), key);
  if (result.changes === 0) return false;
  bumpVersion(db);
  return true;
}

// The preset a card's rows follow: the one picked on its Settings tab, or the project's. Every reader
// that resolves a card's models asks this, so the tab, the board and the run agree.
export function cardPreset(db: DatabaseSync, key: string): PresetName {
  const row = db.prepare('SELECT preset FROM cards WHERE key = ?').get(key) as { preset: PresetName | null } | undefined;
  return row?.preset ?? getSetting(db, 'modelPreset');
}

/**
 * Moves a card onto a preset and clears its own rows in one write, so "follows
 * Heavy" means Heavy and nothing the card set before. The project's own preset is stored as null, so
 * the card keeps following the project when the project changes preset later. A project on a saved
 * preset is not on the built-in one under it, so a pick of that one is stored. False when there is no
 * such card.
 */
export function followPreset(db: DatabaseSync, key: string, preset: PresetName): boolean {
  const stored = preset === getSetting(db, 'modelPreset') && getSetting(db, 'savedPreset') === null ? null : preset;
  const result = db.prepare('UPDATE cards SET preset = ?, saved_preset = NULL, models_json = NULL WHERE key = ?').run(stored, key);
  if (result.changes === 0) return false;
  bumpVersion(db);
  return true;
}

// A card that picked no preset of its own follows whatever the project chose, built in or saved.
export function cardFollowsProject(db: DatabaseSync, key: string): boolean {
  const row = db.prepare('SELECT preset, saved_preset FROM cards WHERE key = ?').get(key) as { preset: string | null; saved_preset: string | null } | undefined;
  return row !== undefined && row.preset === null && row.saved_preset === null;
}

// The project's saved preset a card follows, or null. A name the project no longer holds reads as
// none, so the card follows the project again rather than a table nobody can see.
export function cardSavedPreset(db: DatabaseSync, key: string): SavedPreset | null {
  const row = db.prepare('SELECT saved_preset FROM cards WHERE key = ?').get(key) as { saved_preset: string | null } | undefined;
  const name = row?.saved_preset ?? null;
  return name === null ? null : (getSetting(db, 'savedPresets').find((one) => one.name === name) ?? null);
}

/**
 * The table a card's own rows sit on: its saved preset's, or the project's rows.
 *
 * A saved preset holds the engine, model and effort of every phase, so it takes the place of the
 * project's rows and not of the built-in preset under them. Every reader that resolves a card's
 * models asks this beside `cardPreset`, so the tab, the board and the run agree.
 */
export function cardBase(db: DatabaseSync, key: string): ModelTable {
  return cardSavedPreset(db, key)?.models ?? getSetting(db, 'models');
}

// Moves a card onto a saved preset and clears its own rows in one write, as `followPreset` does. The
// name is kept, not the table, so Update on Settings, Models reaches the card. False when there is no
// such card.
export function followSavedPreset(db: DatabaseSync, key: string, name: string): boolean {
  const result = db.prepare('UPDATE cards SET preset = NULL, saved_preset = ?, models_json = NULL WHERE key = ?').run(name, key);
  if (result.changes === 0) return false;
  bumpVersion(db);
  return true;
}

// A saved preset renamed, or removed with null, on Settings, Models: the cards on it follow the new
// name, or the project again. A removed name left in place would pick up a later preset of that name.
export function renameCardPresets(db: DatabaseSync, from: string, to: string | null): void {
  if (db.prepare('UPDATE cards SET saved_preset = ? WHERE saved_preset = ?').run(to, from).changes > 0) bumpVersion(db);
}

export type CardReposBy = 'refine' | 'plan' | 'person';

const projectPaths = (db: DatabaseSync): string[] =>
  projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path);

// The list as stored, or null when there is none. A value that is not a list of names reads as
// nothing stored, so a hand edit cannot stop the card.
export function cardRepos(db: DatabaseSync, key: string): { repos: string[]; by: CardReposBy } | null {
  const row = db.prepare('SELECT repos, repos_by FROM cards WHERE key = ?').get(key) as
    | { repos: string | null; repos_by: CardReposBy | null }
    | undefined;
  if (row?.repos == null || row.repos_by == null) return null;
  try {
    const repos: unknown = JSON.parse(row.repos);
    const names = Array.isArray(repos) && repos.length > 0 && repos.every((repo) => typeof repo === 'string');
    return names ? { repos: repos as string[], by: row.repos_by } : null;
  } catch {
    return null;
  }
}

// An empty list clears the list and who set it. Refine and plan never replace a list a person
// picked, so a hand pick always wins. False when there is no such card, or the person's list stays.
export function setCardRepos(db: DatabaseSync, key: string, repos: readonly string[], by: CardReposBy): boolean {
  const unique = [...new Set(repos)];
  const known = projectPaths(db);
  const unknown = unique.find((repo) => !known.includes(repo));
  if (unknown !== undefined) throw new Error(`The project has no repository ${unknown}.`);

  const value = unique.length === 0 ? null : JSON.stringify(unique);
  const guard = by === 'person' ? '' : " AND (repos_by IS NULL OR repos_by != 'person')";
  const result = db.prepare(`UPDATE cards SET repos = ?, repos_by = ? WHERE key = ?${guard}`).run(value, value === null ? null : by, key);
  if (result.changes === 0) return false;
  bumpVersion(db);
  return true;
}

// The repositories a card works in, in the project's order. A project with one repository needs no
// pick. Null means not known yet, and each caller decides what that means. The root repository is
// always in the answer when the project has one: its checkout is the card's root, so a child
// checkout made first would fill the folder the root needs.
export function reposOfCard(db: DatabaseSync, key: string): string[] | null {
  if (db.prepare('SELECT 1 FROM cards WHERE key = ?').get(key) === undefined) return null;
  const project = projectPaths(db);
  if (project.length === 1) return project;
  // A path the project no longer lists is dropped, so a removed repository does not stop the card.
  const stored = cardRepos(db, key)?.repos ?? [];
  const picked = project.filter((repo) => stored.includes(repo));
  if (picked.length === 0) return null;
  return project[0] === '.' && picked[0] !== '.' ? ['.', ...picked] : picked;
}

// The stack of one card, as Nolzu last saw it. A run writes it around the QA phase, and the Load,
// Unload and Force buttons write it when a person works the stack by hand. Null on a card whose
// stack nothing has touched, which the panel reads as off.
export interface CardStack {
  state: string;
  reason: string | null;
}

export function cardStack(db: DatabaseSync, key: string): CardStack | null {
  const row = db.prepare('SELECT stack_state, stack_reason FROM cards WHERE key = ?').get(key) as
    | { stack_state: string | null; stack_reason: string | null }
    | undefined;
  return row?.stack_state == null ? null : { state: row.stack_state, reason: row.stack_reason };
}

// The five words come from the writer's side, so a state nobody wrote cannot be stored. What is
// read back is still checked, because a row can be edited by hand.
export function setCardStack(db: DatabaseSync, key: string, stack: { state: StackState; reason: string | null }): void {
  db.prepare('UPDATE cards SET stack_state = ?, stack_reason = ? WHERE key = ?').run(stack.state, stack.reason, key);
  bumpVersion(db);
}

// The key the kept rows of a deleted card move to. A card key holds no space, so no card can take it,
// and a card added later on the same key starts with no runs, sessions or time of the old one.
export const deletedKey = (key: string): string => `${key} (deleted)`;

/**
 * Deletes a card and its rows, in one transaction. Answers the log files of its runs, which the caller
 * removes after the commit, or the sentence the delete was refused with when a run is queued or going.
 * Whether this process holds the card's app is the caller's to ask, right before, since core cannot see
 * it. The stored app state alone refuses nothing: it outlives a restart, and often nothing resets it.
 *
 * The card's moves, discussion, links, diff comments, pull requests and thread names go with the card
 * row, by their foreign keys. Its bell rows go too, since they link to a page that is gone. The runs and
 * knowledge changes stay, under `deletedKey`: the time and cost were spent, and the timesheet, the spend
 * and an export already sent still count them. A Scout finding keeps the old key, so it says its card
 * is gone and offers Start again. A ticket card is recorded in `deleted_tickets`, so a read of its
 * system leaves it off.
 */
export function deleteCardRows(db: DatabaseSync, key: string): { logs: string[] } | { refused: string } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const card = db.prepare('SELECT state, source, source_ref FROM cards WHERE key = ?').get(key) as { state: string; source: string; source_ref: string | null } | undefined;
    // An Ask run holds no queue place and leaves the card's state alone, so the run rows are asked too.
    const run = db.prepare("SELECT state FROM runs WHERE card_key = ? AND state IN ('queued', 'running') ORDER BY state = 'running' DESC LIMIT 1").get(key) as { state: string } | undefined;
    const busy = card?.state === 'running' || run?.state === 'running' ? 'going' : card?.state === 'queued' || run !== undefined ? 'in the queue' : null;
    const refused =
      card === undefined ? `There is no card ${key} on the board, so there is nothing to delete.` : busy !== null ? `${key} has a run ${busy}. Stop the run first, then delete the card.` : null;
    if (refused !== null || card === undefined) {
      db.exec('ROLLBACK');
      return { refused: refused ?? '' };
    }
    const logs = (db.prepare("SELECT log_path FROM runs WHERE card_key = ? AND coalesce(log_path, '') <> ''").all(key) as { log_path: string }[]).map((row) => row.log_path);
    if (card.source !== 'local' && card.source_ref !== null) {
      db.prepare('INSERT OR REPLACE INTO deleted_tickets (source_ref, source, card_key, at) VALUES (?, ?, ?, ?)').run(card.source_ref, card.source, key, new Date().toISOString());
    }
    const gone = deletedKey(key);
    db.prepare('UPDATE runs SET card_key = ?, log_path = NULL WHERE card_key = ?').run(gone, key);
    db.prepare('UPDATE knowledge_changes SET card_key = ? WHERE card_key = ?').run(gone, key);
    // The export id holds the key (nolzu:<project>:<card>:<day>), so a day already sent moves with its
    // runs and is not sent a second time under the new key.
    // Limit: OR IGNORE leaves an entry on the old key when one card key was deleted twice on one day.
    const from = `:${encodeURIComponent(key)}:`;
    db.prepare('UPDATE OR IGNORE export_entries SET external_id = replace(external_id, ?, ?) WHERE instr(external_id, ?) > 0').run(from, `:${encodeURIComponent(gone)}:`, from);
    db.prepare('DELETE FROM notifications WHERE card_key = ?').run(key);
    db.prepare('DELETE FROM cards WHERE key = ?').run(key);
    bumpVersion(db);
    db.exec('COMMIT');
    return { logs };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
