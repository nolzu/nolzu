import type { DatabaseSync } from 'node:sqlite';
import { boardFor, SMALL_CHAINS } from '@nolzu/core';
import { getSetting } from '@nolzu/core/node';
import { BOARD_LABELS, type BoardKind, isBoardKind } from '@nolzu/protocol';
import { type ChainView, planDecisions, type PlanMove, suggestAfter } from './chain.ts';
import type { Loop } from './loop.ts';
import { storeSetting } from './settings-page.ts';

const DELIVERY = SMALL_CHAINS.delivery;

/**
 * What Now's suggestion slot shows, read from stored events only: Delivery's moves in and out of Plan,
 * and the start time of each plan run.
 *
 * Limit: every Now read scans the plan moves and runs of every Delivery card. They grow by a few
 * rows per card, so this stays small; keep a running count in a table if a project ever shows it.
 */
export function chainView(db: DatabaseSync): ChainView {
  if (getSetting(db, 'chainBoards').includes('delivery')) return { on: true, approved: null };
  const phase = boardFor('delivery', getSetting(db, 'deliveryFlow')).stages.find((stage) => stage.id === DELIVERY.from)?.phase ?? DELIVERY.from;
  const moves = db
    .prepare(
      `SELECT e.id, e.card_key AS key, e.from_stage AS "from", e.to_stage AS "to", e.who, e.started_phase AS startedPhase, e.at
       FROM card_events e JOIN cards c ON c.key = e.card_key
       WHERE c.board = 'delivery' AND (e.from_stage = ? OR e.to_stage = ?) ORDER BY e.id`,
    )
    .all(DELIVERY.from, DELIVERY.from) as unknown as PlanMove[];
  // The start, or the end of a run stopped before it started.
  const runs = db
    .prepare(`SELECT r.card_key AS key, coalesce(r.started_at, r.ended_at) AS at FROM runs r JOIN cards c ON c.key = r.card_key WHERE c.board = 'delivery' AND r.phase = ?`)
    .all(phase) as { key: string; at: string | null }[];
  return { on: false, approved: suggestAfter(planDecisions(moves, runs, DELIVERY), getSetting(db, 'chainNotNow')) };
}

const answer = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The newest move, so the suggestion counts only plans decided after this moment.
const newestMove = (db: DatabaseSync): number => (db.prepare('SELECT coalesce(max(id), 0) AS id FROM card_events').get() as { id: number }).id;

/**
 * The suggestion's two buttons and the off switch, as POST /api/chain.
 *
 * `{ board, on }` turns the chain on or off for one board. `{ notNow: true }` hides the suggestion. Off
 * leaves the suggestion free to show again, because it is the only place the chain is turned back on.
 * Every open Now hears the change, because the slot draws what the stream says.
 */
export async function writeChain(live: Pick<Loop, 'db' | 'changed'>, request: Request): Promise<Response> {
  let asked: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === 'object' && parsed !== null) asked = parsed as Record<string, unknown>;
  } catch {
    // A body that is not JSON asks for nothing, and the sentence below says so.
  }
  const db = live.db;
  const { board, on, notNow } = asked;
  let refused: string | null;
  if (notNow === true) {
    refused = storeSetting(db, 'chainNotNow', newestMove(db));
  } else if (typeof board === 'string' && isBoardKind(board) && typeof on === 'boolean') {
    if (!Object.hasOwn(SMALL_CHAINS, board)) return answer({ message: `The ${BOARD_LABELS[board]} board has no chain to turn on.` }, 400);
    const others = getSetting(db, 'chainBoards').filter((kind) => kind !== board);
    refused = storeSetting(db, 'chainBoards', on ? [...others, board] : others);
  } else {
    return answer({ message: 'A chain change needs a board and on or off, or Not now.' }, 400);
  }
  if (refused !== null) return answer({ message: refused }, 400);
  live.changed();
  return answer({ ok: true }, 200);
}

/**
 * The card's tick on its Settings tab, "Go on to Implement after Plan", or null where the tab draws
 * none: a board with no chain, or one the person has not turned the chain on for. A ticked card stores
 * the size small, the value `smallChain` reads, so the column the chain always read keeps its meaning.
 */
export function cardChain(db: DatabaseSync, key: string): { ticked: boolean } | null {
  const card = db.prepare('SELECT board, size FROM cards WHERE key = ?').get(key) as { board: BoardKind; size: string | null } | undefined;
  if (card === undefined || !Object.hasOwn(SMALL_CHAINS, card.board) || !getSetting(db, 'chainBoards').includes(card.board)) return null;
  return { ticked: card.size === 'small' };
}

// The tick, as PATCH /api/card/[key]/chain with `{ on }`. The board and Now read the size, so they are told.
export async function saveCardChain(live: Pick<Loop, 'db' | 'changed'>, key: string, request: Request): Promise<Response> {
  let on: unknown;
  try {
    on = ((await request.json()) as { on?: unknown } | null)?.on;
  } catch {
    on = undefined;
  }
  if (typeof on !== 'boolean') return answer({ message: 'Send on as true or false.' }, 400);
  const card = live.db.prepare('SELECT board FROM cards WHERE key = ?').get(key) as { board: BoardKind } | undefined;
  if (card === undefined) return answer({ message: `There is no card ${key}, so there is nothing to tick.` }, 404);
  if (!Object.hasOwn(SMALL_CHAINS, card.board)) return answer({ message: `The ${BOARD_LABELS[card.board]} board has no chain to tick.` }, 400);
  live.db.prepare('UPDATE cards SET size = ? WHERE key = ?').run(on ? 'small' : null, key);
  live.changed();
  return answer({ ok: true }, 200);
}
