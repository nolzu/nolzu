import { expect, it } from 'vitest';
import { FOLLOW_SLACK, nearBottom } from './follow.ts';

it('counts the end and the slack above it as the end, and anything higher as reading', () => {
  expect(nearBottom(1000, 800, 1800)).toBe(true);
  expect(nearBottom(1000 - FOLLOW_SLACK, 800, 1800)).toBe(true);
  expect(nearBottom(1000 - FOLLOW_SLACK - 1, 800, 1800)).toBe(false);
  // A page shorter than the window is always at its end.
  expect(nearBottom(0, 800, 500)).toBe(true);
});
