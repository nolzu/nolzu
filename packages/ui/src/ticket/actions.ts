import type { CardView, StageView } from '@nolzu/protocol';
import { lockReason } from '../board/drag.ts';
import { refuseDrop } from '../board/drop.ts';

// The card as the snapshot showed it when Move forward was pressed.
export type Seen = Pick<CardView, 'key' | 'stage' | 'state'>;

// The click that is still waiting for the board to answer, or nothing once the snapshot has moved
// on. The answer to the request is not an input on purpose: it can arrive long before the board
// hears of the run, and a button that went free on it would take a second press for a second move.
export function settle(clicked: Seen | null, card: Seen): Seen | null {
  if (clicked === null) return null;
  // The key as well. Two cards in one stage and state look alike without it, and a click on one
  // would hold the button of the other.
  return clicked.key === card.key && clicked.stage === card.stage && clicked.state === card.state ? clicked : null;
}

export interface MoveView {
  text: string;
  // The words the drop target shows, or nothing when the move starts no run.
  starts: string | undefined;
  busy: boolean;
  disabled: boolean;
  // Why the button is held, in words, because a greyed button alone says nothing. A gone model
  // needs none: `starts` already names it and the setting that fixes it.
  why: string | null;
}

// What the Move forward button shows. `next` is the stage one step forward as the snapshot carries
// it, and `starts` is the label core built for that move. Nothing when there is no stage to move to.
export function moveView(card: Seen, next: StageView | null, starts: string | undefined, clicked: Seen | null): MoveView | null {
  if (next === null) return null;

  const locked = lockReason(card);
  // The same refusal the board gives a drop, so the button cannot send a move the column would not.
  const refusal = refuseDrop(next, 'forward');
  const sent = settle(clicked, card) !== null;
  const busy = locked !== null || sent;

  return {
    text: starts === undefined ? `Move to ${next.label}` : 'Move forward',
    starts,
    busy,
    disabled: busy || refusal !== null,
    // Between the press and the board's answer the card is not queued yet, so the run gives no
    // reason, and the button would be held with no word about it.
    why: locked ?? (sent ? 'Sent. Waiting for the board to show the move.' : null),
  };
}

export interface RunView {
  kind: 'retry' | 'stop';
  text: string;
  // The run a stop is for. Null for a retry, which starts a new one.
  runId: number | null;
  busy: boolean;
}

// Retry on a failed card, Stop on a card whose run is queued or running, nothing otherwise. Busy
// from the press until the board shows the card in another state, like Move forward.
export function runView(card: Seen & Pick<CardView, 'runId'>, pressed: Seen | null): RunView | null {
  const busy = settle(pressed, card) !== null;
  if (card.state === 'failed') return { kind: 'retry', text: 'Retry', runId: null, busy };
  if ((card.state === 'queued' || card.state === 'running') && card.runId !== null) return { kind: 'stop', text: 'Stop', runId: card.runId, busy };
  return null;
}

// What the page read off the card's stage and the stored logins: the profiles this phase can start
// on, or the reason there are none.
export interface RunOnOffer {
  profiles: readonly { id: string; label: string }[];
  note: string | null;
}

export interface RunOnView {
  profiles: readonly { id: string; label: string }[];
  // What the card says before the click. Null when there is nothing to offer.
  fresh: string | null;
  // Why there is nothing to offer, when there is nothing.
  note: string | null;
  busy: boolean;
}

// Said before any click, because a session belongs to one profile and nobody should expect the
// stopped run to carry on. The second sentence is what makes the offer worth taking: the work so
// far is in the checkout, and the fresh run reads it.
const FRESH = 'A fresh run, because a session belongs to one profile. The checkout is not touched, so it goes on from the plan, the progress file and the changes already there.';

/**
 * The "Run on" offer as the card draws it, on a failed card and on no other.
 *
 * A card that is running or ready has nothing to move: the offer exists so a phase that stopped,
 * on a usage limit or on anything else, can be started on another login. The words come before the
 * buttons, so the fresh run is not a surprise after the press.
 */
export function runOnView(card: Seen, offer: RunOnOffer | null, pressed: Seen | null): RunOnView | null {
  if (offer === null || card.state !== 'failed') return null;
  const empty = offer.profiles.length === 0;
  return { profiles: offer.profiles, fresh: empty ? null : FRESH, note: empty ? offer.note : null, busy: settle(pressed, card) !== null };
}
