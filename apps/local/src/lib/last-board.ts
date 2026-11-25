import { type BoardKind, isBoardKind, isResearchKind } from '@nolzu/protocol';

// The board this tab showed last, so Add card opened away from a board (the palette, N on Now) goes to
// the board the person was working on. Kept per tab: two tabs on two boards each add to their own.
const KEY = 'nolzu.lastBoard';

export function rememberBoard(kind: BoardKind): void {
  try {
    sessionStorage.setItem(KEY, kind);
  } catch {
    // Blocked storage forgets the board, and Add card falls back to Delivery.
  }
}

// Delivery when the tab has shown no board yet, or the one it showed is off now. Research has its own
// box on its page and no Add card, so it never counts.
export function lastBoard(off: readonly BoardKind[]): BoardKind {
  let kept: string | null;
  try {
    kept = sessionStorage.getItem(KEY);
  } catch {
    kept = null;
  }
  return kept !== null && isBoardKind(kept) && !isResearchKind(kept) && !off.includes(kept) ? kept : 'delivery';
}
