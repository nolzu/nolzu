import type { DatabaseSync } from 'node:sqlite';
import { boardFor, type GettingStartedStep } from '@nolzu/core';
import { getSetting, writeSetting } from '@nolzu/core/node';
import { isBoardKind } from '@nolzu/protocol';
import { type FirstRun, firstRunOf } from './getting-started.ts';
import { storeSetting } from './settings-page.ts';
import { systemLoginItem } from './start-at-login.ts';

const answer = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Got it on a coach note. The note's name joins the `seenNotes` setting, and a page reads that list
// into `CoachNote`, so the note never shows again. Closing it twice stores it once.
export async function closeNote(db: DatabaseSync, request: Request): Promise<Response> {
  let note: unknown = null;
  try {
    note = ((await request.json()) as { note?: unknown } | null)?.note ?? null;
  } catch {
    // A body that is not JSON names no note, and the sentence below says so.
  }
  if (typeof note !== 'string') return answer({ message: 'Closing a coach note needs the name of the note.' }, 400);

  const seen = getSetting(db, 'seenNotes');
  const refused = seen.includes(note) ? null : storeSetting(db, 'seenNotes', [...seen, note]);
  return refused === null ? answer({ ok: true }, 200) : answer({ message: refused }, 400);
}

// Whether a person ever started a phase in this project: a drag, Move forward or Add and start, never
// the chain. Getting started's first drag and the Learn gate of Set up the project both read it.
export const personStarted = (db: DatabaseSync): boolean =>
  db.prepare("SELECT 1 FROM card_events WHERE who = 'you' AND started_phase IS NOT NULL LIMIT 1").get() !== undefined;

/**
 * What the first run shows in the rail and on the board, read fresh on each load and each Now snapshot.
 *
 * The first card and the first drag come off their own rows: a card, and a move by a person that
 * started a phase (a drag, Move forward or Add and start, never the chain). The plain summary read and
 * the first push leave no row, so `markStep` records them.
 */
export function firstRun(db: DatabaseSync, canStartAtLogin = systemLoginItem() !== null): FirstRun {
  const first = db.prepare('SELECT board FROM cards ORDER BY rowid LIMIT 1').get() as { board: string } | undefined;
  const kind = first !== undefined && isBoardKind(first.board) ? first.board : 'delivery';
  const board = boardFor(kind, getSetting(db, 'deliveryFlow'));
  return firstRunOf({
    card: first !== undefined,
    dragTo: board.stages.find((stage) => stage.role === 'agent')?.label ?? 'Refine',
    dragged: personStarted(db),
    recorded: getSetting(db, 'gettingStarted'),
    seen: getSetting(db, 'seenNotes'),
    canStartAtLogin,
  });
}

// A step of Getting started that leaves no row, marked where it happens. True when this marked it, so
// the caller tells the open streams once; a project with no list marks nothing.
export function markStep(db: DatabaseSync, step: GettingStartedStep): boolean {
  const done = getSetting(db, 'gettingStarted');
  if (done === null || done.includes(step)) return false;
  writeSetting(db, 'gettingStarted', [...done, step]);
  return true;
}
