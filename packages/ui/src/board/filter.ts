import type { CardView } from '@nolzu/protocol';

// A card waits on a person when it has a question, a result to read, or a failure to look at, a
// wrap-up that waits for a knowledge review, and an epic when every task is done, since it does not
// move on by itself. Pure, so the phone view filters with the same rule.
// `finished` and `runState` are optional, so a caller that knows only the state still asks.
export function waitingOnMe(card: Pick<CardView, 'state'> & Partial<Pick<CardView, 'finished' | 'runState'>>): boolean {
  return card.state === 'blocked' || card.state === 'ready' || card.state === 'failed' || card.finished === true || card.runState === 'waiting_review';
}

// The board's filter box: a card whose key or title holds the typed text, in any case. Read on the
// client off the snapshot it already has, so typing asks the server nothing.
export function matchesFilter(card: Pick<CardView, 'key' | 'title'>, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return wanted === '' || card.key.toLowerCase().includes(wanted) || card.title.toLowerCase().includes(wanted);
}
