import { describe, expect, it } from 'vitest';
import { besideCard, boardKey, focusMove, shutColumns, visibleColumns } from './keys.ts';

// Visible cards per column, in board order. An empty column is a column the filter or the board left empty.
const COLUMNS = [['APP-1', 'APP-2', 'APP-3'], [], ['APP-4'], ['APP-5', 'APP-6']];

describe('focusMove', () => {
  it('moves right to the card at the same height in the next column that has cards', () => {
    expect(focusMove(COLUMNS, 'APP-1', 'ArrowRight')).toBe('APP-4');
  });

  it('keeps the height when the next column is as tall', () => {
    expect(focusMove([['APP-1', 'APP-2'], ['APP-3', 'APP-4']], 'APP-2', 'ArrowRight')).toBe('APP-4');
  });

  it('lands on the last card when the next column is shorter', () => {
    expect(focusMove(COLUMNS, 'APP-3', 'ArrowRight')).toBe('APP-4');
  });

  it('stays put at the last column', () => {
    expect(focusMove(COLUMNS, 'APP-6', 'ArrowRight')).toBe('APP-6');
  });

  it('moves left back over an empty column, and stays put at the first', () => {
    expect(focusMove(COLUMNS, 'APP-4', 'ArrowLeft')).toBe('APP-1');
    expect(focusMove(COLUMNS, 'APP-2', 'ArrowLeft')).toBe('APP-2');
  });

  it('moves down and up inside a column and stops at the ends', () => {
    expect(focusMove(COLUMNS, 'APP-1', 'ArrowDown')).toBe('APP-2');
    expect(focusMove(COLUMNS, 'APP-3', 'ArrowDown')).toBe('APP-3');
    expect(focusMove(COLUMNS, 'APP-2', 'ArrowUp')).toBe('APP-1');
    expect(focusMove(COLUMNS, 'APP-1', 'ArrowUp')).toBe('APP-1');
  });

  it('starts at the first card when nothing is selected, or the selected card is gone', () => {
    expect(focusMove(COLUMNS, null, 'ArrowDown')).toBe('APP-1');
    expect(focusMove(COLUMNS, 'APP-9', 'ArrowRight')).toBe('APP-1');
  });

  it('visits only the cards it is given, which is how the filter hides the rest', () => {
    expect(focusMove([['APP-2'], ['APP-4']], 'APP-2', 'ArrowRight')).toBe('APP-4');
  });

  it('returns no selection on an empty board instead of throwing', () => {
    expect(focusMove([[], []], null, 'ArrowRight')).toBeNull();
    expect(focusMove([], 'APP-1', 'ArrowDown')).toBeNull();
  });
});

describe('boardKey', () => {
  const at = (key: string, over: Partial<Parameters<typeof boardKey>[0]> = {}) =>
    boardKey({ key, typing: false, onCard: true, modifier: false, selected: 'APP-2', filtered: false, ...over });

  it.each([
    ['n', { kind: 'add' }],
    ['N', { kind: 'add' }],
    ['w', { kind: 'filter' }],
    ['W', { kind: 'filter' }],
    ['t', { kind: 'theme' }],
    ['?', { kind: 'help' }],
    ['Enter', { kind: 'peek', key: 'APP-2' }],
    [' ', { kind: 'peek', key: 'APP-2' }],
    ['ArrowDown', { kind: 'move', key: 'ArrowDown' }],
  ])('%s does %j', (key, action) => {
    expect(at(key)).toEqual(action);
  });

  it('peeks at nothing with Enter when no card is selected', () => {
    expect(at('Enter', { selected: null })).toBeNull();
  });

  it('clears the selection with Escape, and with none selected clears the filter', () => {
    expect(at('Escape')).toEqual({ kind: 'clear' });
    expect(at('Escape', { selected: null, filtered: true })).toEqual({ kind: 'filter' });
    expect(at('Escape', { selected: null, filtered: false })).toBeNull();
  });

  it.each(['n', 'w', 't', '?', 'Enter', 'Escape', 'ArrowDown'])('does nothing for %s while a text field has focus', (key) => {
    expect(at(key, { typing: true })).toBeNull();
  });

  it.each(['n', 'w', 't', 'ArrowDown'])('leaves %s with a modifier to the browser', (key) => {
    expect(at(key, { modifier: true })).toBeNull();
  });

  // A focused button or link keeps its own Enter, and a scrolled panel keeps its own arrows.
  it.each(['Enter', 'ArrowDown', 'Escape'])('leaves %s alone while focus is on a control that is not a card', (key) => {
    expect(at(key, { onCard: false, filtered: true })).toBeNull();
  });

  it.each([['n', 'add'], ['w', 'filter'], ['t', 'theme'], ['?', 'help']])('still takes %s away from a card, because no control uses a letter', (key, kind) => {
    expect(at(key, { onCard: false })).toEqual({ kind });
  });

  it('ignores a key it has no use for', () => {
    expect(at('x')).toBeNull();
  });

  // Focus can sit on a dialog button, or fall to the body after a click on dialog text, and neither is
  // a text field. The open dialog is what holds the keys, so nothing acts on the board behind it.
  it.each(['n', 'w', 't', '?', 'Enter', 'Escape', 'ArrowDown'])('does nothing for %s while a dialog is open', (key) => {
    expect(at(key, { dialog: true })).toBeNull();
    expect(at(key, { dialog: true, onCard: false })).toBeNull();
  });

  it('acts as before when the page says no dialog is open', () => {
    expect(at('n', { dialog: false })).toEqual({ kind: 'add' });
  });
});

describe('visibleColumns', () => {
  it('lists each stage in board order, open cards first and minimized ones after, as the columns draw them', () => {
    const stages = [{ id: 'inbox' }, { id: 'refine' }, { id: 'plan' }];
    const cards = [
      { key: 'APP-1', stage: 'refine', minimized: true },
      { key: 'APP-2', stage: 'inbox', minimized: false },
      { key: 'APP-3', stage: 'refine', minimized: false },
    ];

    expect(visibleColumns(stages, cards)).toEqual([['APP-2'], ['APP-3', 'APP-1'], []]);
  });

  // Closed folds over its cards, and the arrows skip it until a click opens it.
  it('leaves the cards of a column it is told to skip out of reach', () => {
    const stages = [{ id: 'review' }, { id: 'closed' }];
    const cards = [
      { key: 'APP-1', stage: 'review', minimized: false },
      { key: 'APP-2', stage: 'closed', minimized: false },
    ];

    expect(visibleColumns(stages, cards, ['closed'])).toEqual([['APP-1'], []]);
    expect(focusMove(visibleColumns(stages, cards, ['closed']), 'APP-1', 'ArrowRight')).toBe('APP-1');
  });
});

describe('shutColumns', () => {
  const stages = [
    { id: 'review', role: 'you' as const },
    { id: 'closed', role: 'archive' as const },
  ];

  it('names every archive column while it is shut, and none once opened', () => {
    expect(shutColumns(stages, false)).toEqual(['closed']);
    expect(shutColumns(stages, true)).toEqual([]);
  });
});

// K and J on the card page walk the cards in the order the board draws them: column by column, open
// cards before the minimized strip, so the next card is the one a person sees after this one.
describe('besideCard', () => {
  const stages = [{ id: 'inbox' }, { id: 'refine' }, { id: 'plan' }];
  const cards = [
    { key: 'APP-1', stage: 'refine', minimized: true },
    { key: 'APP-2', stage: 'inbox', minimized: false },
    { key: 'APP-3', stage: 'refine', minimized: false },
    { key: 'APP-4', stage: 'plan', minimized: false },
  ];
  const columns = visibleColumns(stages, cards);

  it('follows the board order across columns, with a minimized card after the open ones', () => {
    expect(besideCard(columns, 'APP-3')).toEqual({ previous: 'APP-2', next: 'APP-1' });
    expect(besideCard(columns, 'APP-1')).toEqual({ previous: 'APP-3', next: 'APP-4' });
  });

  it('has no previous card at the first and no next card at the last', () => {
    expect(besideCard(columns, 'APP-2')).toEqual({ previous: null, next: 'APP-3' });
    expect(besideCard(columns, 'APP-4')).toEqual({ previous: 'APP-1', next: null });
  });

  it('offers nothing for a card the board does not hold', () => {
    expect(besideCard(columns, 'APP-9')).toEqual({ previous: null, next: null });
  });
});
