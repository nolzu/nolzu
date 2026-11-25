import type { CardView } from '@nolzu/protocol';

// The drag as the board holds it. The counts are what keep a target steady: a dragenter fires again
// for every child element the pointer reaches, and a dragleave fires when it crosses into one, so a
// column that only watched the last event would flicker under the card's own text.
// What a column answers about this card: the move it would be, or false for a move git refuses.
// One predicate rather than two, so the direction cannot drift away from the permission.
export type Allowed = (stage: string) => 'forward' | 'back' | false;

export interface Drag {
  key: string;
  over: string | null;
  depth: Readonly<Record<string, number>>;
}

const settle = (key: string, depth: Record<string, number>): Drag => ({
  key,
  // The first column still holding at least one enter. After a leave takes one column to zero, the
  // column the pointer moved into is the one left standing.
  over: Object.entries(depth).find(([, count]) => count > 0)?.[0] ?? null,
  depth,
});

export const startDrag = (key: string): Drag => ({ key, over: null, depth: {} });

export const enterColumn = (drag: Drag, stage: string): Drag =>
  settle(drag.key, { ...drag.depth, [stage]: (drag.depth[stage] ?? 0) + 1 });

// `gone` is a leave the browser says went outside the column. The count alone can stay up: a child
// that goes away under the pointer, as a folded strip's text does when it opens, never sends its
// leave, and the column would keep the target after the pointer left it.
export const leaveColumn = (drag: Drag, stage: string, gone = false): Drag =>
  // Never below zero. A leave that arrives without its enter, which happens when a drag starts
  // inside a column, would otherwise swallow the next enter and the target would never show.
  settle(drag.key, { ...drag.depth, [stage]: gone ? 0 : Math.max(0, (drag.depth[stage] ?? 0) - 1) });

// What a drop on this column means. Null is a drop that changes nothing: no card is being dragged,
// or the column refuses it, which is a mistake rather than a request.
export function dropped(drag: Drag | null, stage: string, allowed: Allowed): { key: string; stage: string } | null {
  if (drag === null || allowed(stage) === false) return null;

  return { key: drag.key, stage };
}

// A card whose run owns it cannot be dragged, and the board has to say which state that is rather
// than refusing in silence. One function, so the title a person reads and the flag that stops the
// drag can never disagree.
//
// This is the same rule `canMove` enforces in core. `packages/ui` may import protocol only, so the
// two cannot share one copy. Nothing checks the two against each other yet: that test belongs in
// `apps/local`, which may import both, the way a test there cross-checks the fixture's stage ids
// against `deliveryBoard`. Until it exists, this copy can drift and no test will say so.
export function lockReason(card: Pick<CardView, 'key' | 'state'>): string | null {
  if (card.state !== 'queued' && card.state !== 'running') return null;

  return `${card.key} is ${card.state}. It cannot move until its run ends.`;
}

// The snapshot is the truth and it can arrive mid drag. A drag still held over a card that has since
// been queued would send a move the server refuses, after the person already let go, so it is
// dropped instead. A card that left the board entirely goes the same way.
export function keepDrag(drag: Drag | null, cards: readonly Pick<CardView, 'key' | 'state'>[]): Drag | null {
  if (drag === null) return null;
  const card = cards.find((one) => one.key === drag.key);

  return card === undefined || lockReason(card) !== null ? null : drag;
}
