import { boardFor, nextStage, startsLabel, tabAnywhere, tabsFor, type Tab } from '@nolzu/core';
import { BOARD_KINDS, type BoardKind, type BoardSnapshot, type CardView, cardStarts, type StageView } from '@nolzu/protocol';

// The seam the route loads through. A test proves the rules with a plain object, so it needs no
// sqlite file and never opens a database a person actually uses.
export interface RowSource {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export interface Ticket {
  key: string;
  title: string;
  stage: string;
  state: string;
  // Read so the page offers the tabs of the board the card is on, and not the Delivery tabs for
  // every card there is.
  board: BoardKind;
  // Small, medium or large, for the head's size pill. Null for a card nobody sized.
  size: string | null;
}

export type TicketResult = { ok: true; ticket: Ticket } | { ok: false; status: number; message: string };

export function loadTicket(db: RowSource, key: string): TicketResult {
  const row = db.prepare('SELECT key, title, stage, state, board, size FROM cards WHERE key = ?').get(key) as Ticket | undefined;
  if (row === undefined) {
    return { ok: false, status: 404, message: `There is no card ${key} here. Check the key, or open the board.` };
  }
  return { ok: true, ticket: row };
}

// A tab that is not built yet sends the reader to the overview rather than to a
// 404, because the URL is one a person can reasonably have bookmarked. `ticketTab` below splits that
// from a tab this app does build and this card's board has not got, which is a 404.
export function resolveTab(tab: string | undefined, tabs: readonly Tab[]): string {
  return tabs.some((known) => known.id === tab) && tab !== undefined ? tab : 'overview';
}

// The stage ids of every board, with the words a person reads, keyed by the board as well as by the
// stage. The board is part of the key because the ids repeat: `plan` is a stage of Epics and of
// Delivery, and one map over both would answer with whichever was written last.
const STAGE_LABELS = new Map<string, string>(
  BOARD_KINDS.flatMap((kind) => boardFor(kind, 'pull-request').stages.map((stage) => [`${kind}:${stage.id}`, stage.label] as [string, string])),
);

// A stage nothing names is shown as its id, which is what a card left on a stage a later version
// dropped would be.
export const stageLabel = (board: BoardKind, id: string): string => STAGE_LABELS.get(`${board}:${id}`) ?? id;

export type LayoutResult = { ok: true; ticket: Ticket; tabs: readonly Tab[] } | { ok: false; status: number; message: string };

// What the layout route loads. Kept here so the rules have a test that needs no Kit runtime.
export function ticketLayout(db: RowSource, key: string): LayoutResult {
  const found = loadTicket(db, key);
  if (!found.ok) return found;
  const pulled = db.prepare('SELECT 1 AS one FROM card_pulls WHERE card_key = ? LIMIT 1').get(key) !== undefined;
  return { ok: true, ticket: found.ticket, tabs: tabsFor(found.ticket.board, found.ticket.stage, pulled) };
}

// 307 and not 308: the tab a card shows is not a permanent property of the card, and a browser
// that cached a permanent redirect would keep sending the reader to the overview after the tab is
// built.
export const TAB_REDIRECT = 307;

export interface TabTarget {
  current: string;
  redirect: string | null;
  // A tab this app builds that this card's board has not got. Drawing it empty reads as a screen
  // that broke, so the address answers 404 and names the tab that is not there.
  gone: { status: number; message: string } | null;
}

export function ticketTab(tab: string | undefined, tabs: readonly Tab[], key: string, board?: string): TabTarget {
  const current = resolveTab(tab, tabs);
  // A tab of the card's own board that its stage has not reached, such as PRs before Pull request,
  // comes later, so it leads to the overview the way a tab not built yet does.
  const later = board !== undefined && tabsFor(board).some((known) => known.id === tab);
  const foreign = current === tab || later ? undefined : tabAnywhere(tab);
  if (foreign !== undefined) {
    return { current, redirect: null, gone: { status: 404, message: `There is no ${foreign.label} tab on ${key}. Open the card to see the tabs it has.` } };
  }
  // The whole target is built here, so the encoding of the key is covered by a test rather than
  // living in a route file that no test can import.
  return { current, redirect: current === tab ? null : `/t/${encodeURIComponent(key)}/${current}`, gone: null };
}

export interface ForwardMove {
  card: CardView;
  // The stage one step forward as the snapshot carries it, or nothing after the last stage.
  next: StageView | null;
  starts: string | undefined;
}

// What the action cluster needs, read off one snapshot, so the button, its label and the card's
// state always come from the same moment. The flow comes from the snapshot too, so the page needs
// no second source for it.
export function forwardMove(snapshot: BoardSnapshot, key: string): ForwardMove | null {
  const card = snapshot.cards.find((found) => found.key === key);
  if (card === undefined) return null;

  const board = boardFor(snapshot.kind, snapshot.flow);
  const to = nextStage(board, card.stage);
  const next = to === undefined ? null : (snapshot.stages.find((stage) => stage.id === to.id) ?? null);
  // The card's own model over the stage's, in the label and in the stage the button checks, so both say
  // what this card's run will use.
  const stages = snapshot.stages.map((stage) => ({ ...stage, starts: cardStarts(stage, card) }));
  const ownNext = next === null ? null : (stages.find((stage) => stage.id === next.id) ?? null);
  return { card, next: ownNext, starts: ownNext === null ? undefined : startsLabel(board, card.stage, ownNext.id, stages) };
}

/**
 * The column the gate offers once its questions are settled: the next one, while it starts a run and
 * the card is at rest, so the offer goes as soon as the card moves or a run starts. Null otherwise.
 */
export function gateMove(snapshot: BoardSnapshot | undefined, key: string): StageView | null {
  const ahead = snapshot === undefined ? null : forwardMove(snapshot, key);
  const resting = ahead?.card.state === 'ready' || ahead?.card.state === 'idle';
  return resting && ahead?.next != null && ahead.next.starts !== null ? ahead.next : null;
}

// A stopped run counts only in the stage that ran it: a card moved back after the stop is idle with
// that run still newest, and starting its new stage would be a run nobody asked for.
const canRetry = (card: Pick<CardView, 'state' | 'runState' | 'runPhase'>, stage: StageView): boolean =>
  card.state === 'failed' || (card.state === 'idle' && card.runState === 'stopped' && stage.starts !== null && card.runPhase === stage.starts.phase);

// The stage a retry runs again, with the card's own models over the stage's, as the run will use
// them. Null unless the card failed, or sits idle after its stage's run was stopped: either way that
// run did not finish, and nothing else starts it again. A run cut off by a restart leaves the card
// failed, so it needs no case here.
export function retryStage(snapshot: BoardSnapshot, key: string): StageView | null {
  const card = snapshot.cards.find((found) => found.key === key);
  const stage = card === undefined ? undefined : snapshot.stages.find((found) => found.id === card.stage);
  if (card === undefined || stage === undefined) return null;
  const own = { ...stage, starts: cardStarts(stage, card) };
  return canRetry(card, own) ? own : null;
}

// The one line shown where the buttons would be, or nothing. No snapshot means no buttons, and a
// card that left the board means the header still shows what the page loaded, so both get a
// sentence rather than an empty corner.
export function clusterNote(snapshot: BoardSnapshot | null, down: boolean, key: string): string | null {
  if (snapshot === null) return down ? 'The board is not answering. Check that Nolzu is still running.' : null;
  if (snapshot.cards.some((card) => card.key === key)) return null;
  return `${key} is not on the board any more. What this page shows may be out of date.`;
}

type Send = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

// Answers nothing when the server took the write, and otherwise the sentence to show. It never
// throws, because the caller is a click handler and a rejection there reaches nobody.
export async function postWrite(send: Send, url: string, body: unknown): Promise<string | null> {
  try {
    const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) return null;
    const said = (await response.json().catch(() => null)) as { message?: unknown } | null;
    return typeof said?.message === 'string' ? said.message : `The board answered ${response.status} and gave no reason.`;
  } catch {
    return 'The board could not be reached. Check that Nolzu is still running.';
  }
}
