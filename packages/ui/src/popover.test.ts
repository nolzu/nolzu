import { expect, it } from 'vitest';
import { placePopover } from './popover.ts';

const view = { width: 390, height: 800 };
const button = (top: number, left = 100) => ({ top, bottom: top + 16, left });
const size = { width: 240, height: 120 };

it('opens below the button when the box fits there', () => {
  expect(placePopover(button(100), size, view)).toEqual({ top: 120, left: 100, up: false });
  // Room above as well: below still wins.
  expect(placePopover(button(400), size, view)).toEqual({ top: 420, left: 100, up: false });
});

// The last rows of a long table had their tip cut off at the bottom.
it('opens upward when there is no room below', () => {
  expect(placePopover(button(700), size, view)).toEqual({ top: 576, left: 100, up: true });
});

it('stays below when there is no room above either, so the top of the text shows', () => {
  expect(placePopover(button(60), { width: 240, height: 760 }, view)).toMatchObject({ top: 80, up: false });
});

it('keeps the box inside the screen sideways', () => {
  expect(placePopover(button(100, 300), size, view).left).toBe(390 - 240 - 8);
  expect(placePopover(button(100, -20), size, view).left).toBe(8);
});
