// The board's keys, as pure functions, so the page only carries out what these decide.
import { KEYS, matchKey, NO_LEAD } from '../keymap.ts';

export type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

// The card focus moves to, given the visible cards of each column in board order. Right and left skip
// empty columns and keep the height, or take the last card of a shorter column. Every move stops at the
// edge. Null only when the board shows no card at all.
export function focusMove(columns: readonly (readonly string[])[], current: string | null, key: Arrow): string | null {
  const filled = columns.filter((column) => column.length > 0);
  const first = filled[0]?.[0];
  if (first === undefined) return null;

  const col = filled.findIndex((column) => current !== null && column.includes(current));
  if (col === -1) return first;
  const column = filled[col]!;
  const row = column.indexOf(current!);

  if (key === 'ArrowDown') return column[Math.min(row + 1, column.length - 1)]!;
  if (key === 'ArrowUp') return column[Math.max(row - 1, 0)]!;
  const next = filled[key === 'ArrowRight' ? col + 1 : col - 1];
  if (next === undefined) return current;
  return next[Math.min(row, next.length - 1)]!;
}

export type BoardAction =
  | { kind: 'add' }
  | { kind: 'filter' }
  | { kind: 'theme' }
  | { kind: 'help' }
  | { kind: 'peek'; key: string }
  | { kind: 'clear' }
  | { kind: 'move'; key: Arrow };

export interface KeyPress {
  key: string;
  // A text field has focus, so the key is the person's text.
  typing: boolean;
  // Focus is on a card, or on nothing.
  onCard: boolean;
  // Ctrl, Cmd or Alt is held, so the key belongs to the browser or the system.
  modifier: boolean;
  selected: string | null;
  filtered: boolean;
  // A modal dialog is open. It has the keys: Esc closes it, and the board behind it gets none.
  dialog?: boolean;
}

// The registry's answer, in the shape this package exported before it had a registry. The app reads
// the registry itself, and this stays for code built on the old export.
const BOARD_KEYS = KEYS.filter((binding) => binding.scope !== 'card');
const ARROW_OF: Readonly<Record<string, Arrow>> = { next: 'ArrowDown', previous: 'ArrowUp', right: 'ArrowRight', left: 'ArrowLeft' };

export function boardKey(press: KeyPress): BoardAction | null {
  const found = matchKey(
    BOARD_KEYS,
    { key: press.key, shift: false, mod: press.modifier, alt: false, repeat: false, typing: press.typing, onCard: press.onCard, dialog: press.dialog === true },
    NO_LEAD,
    0,
  ).binding;
  switch (found?.action) {
    case 'add':
      return { kind: 'add' };
    case 'filter':
      return { kind: 'filter' };
    case 'theme':
      return { kind: 'theme' };
    case 'help':
      return { kind: 'help' };
    // Enter peeks, as Space and a click on the card do. The open sheet has its own way to the page.
    case 'open':
    case 'peek':
      return press.selected === null ? null : { kind: 'peek', key: press.selected };
    case 'back':
      // One step back at a time: first the selection, then the filter.
      if (press.selected !== null) return { kind: 'clear' };
      return press.filtered ? { kind: 'filter' } : null;
  }
  const arrow = found === null ? undefined : ARROW_OF[found.action];
  return arrow === undefined ? null : { kind: 'move', key: arrow };
}

// The cards of each column in the order the column draws them: open cards, then the minimized strip.
// A column in `skip` is folded over its cards, so none of them can be reached.
export function visibleColumns(
  stages: readonly { id: string }[],
  cards: readonly { key: string; stage: string; minimized: boolean }[],
  skip: readonly string[] = [],
): string[][] {
  return stages.map((stage) => {
    const here = skip.includes(stage.id) ? [] : cards.filter((card) => card.stage === stage.id);
    return [...here.filter((card) => !card.minimized), ...here.filter((card) => card.minimized)].map((card) => card.key);
  });
}

// The archive columns folded over their cards until a click opens them.
export function shutColumns(stages: readonly { id: string; role: string }[], open: boolean): string[] {
  return open ? [] : stages.filter((stage) => stage.role === 'archive').map((stage) => stage.id);
}

// The cards before and after this one in board order, for K and J on the card page. Null at either end
// and for a card the board does not hold.
export function besideCard(columns: readonly (readonly string[])[], key: string): { previous: string | null; next: string | null } {
  const order = columns.flat();
  const at = order.indexOf(key);
  return at === -1 ? { previous: null, next: null } : { previous: order[at - 1] ?? null, next: order[at + 1] ?? null };
}
