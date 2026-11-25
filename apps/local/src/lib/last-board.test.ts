import { afterEach, expect, it, vi } from 'vitest';
import { lastBoard, rememberBoard } from './last-board.ts';

afterEach(() => vi.unstubAllGlobals());

const storage = () => {
  const kept = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => kept.set(key, value) });
};

it('goes to the board the tab showed last', () => {
  storage();
  expect(lastBoard([])).toBe('delivery');
  rememberBoard('epics');
  expect(lastBoard([])).toBe('epics');
  rememberBoard('prreview');
  expect(lastBoard([])).toBe('prreview');
});

it('falls back to Delivery for a board that is off now', () => {
  storage();
  rememberBoard('epics');
  expect(lastBoard(['epics'])).toBe('delivery');
});

// A Research page has its own box and no Add card, so it never counts as the last board.
it('falls back to Delivery after a Research page', () => {
  storage();
  rememberBoard('questions');
  expect(lastBoard([])).toBe('delivery');
});

it('falls back to Delivery when the browser blocks storage', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  rememberBoard('epics');
  expect(lastBoard([])).toBe('delivery');
});
