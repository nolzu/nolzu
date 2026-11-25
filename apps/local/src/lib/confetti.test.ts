import { expect, it } from 'vitest';
import { confettiPieces } from './confetti.ts';

// The burst the ready screen throws: about 120 pieces in three shapes, all thrown up and out from the
// middle to both sides, each falling well past where it started, and all off within the first moment.
it('throws about 120 strips and squares up and out to both sides, and lets every one fall', () => {
  const pieces = confettiPieces();

  expect(pieces).toHaveLength(120);
  expect(new Set(pieces.map((one) => `${one.w}x${one.h}`))).toEqual(new Set(['4x12', '3x8', '7x7']));
  expect(new Set(pieces.map((one) => one.colour)).size).toBe(4);
  expect(pieces.every((one) => one.up > 0 && one.fall > one.up)).toBe(true);
  expect(pieces.some((one) => one.dx < -10) && pieces.some((one) => one.dx > 10)).toBe(true);
  expect(pieces.every((one) => one.delay >= 0 && one.delay < 200 && Math.abs(one.flip) >= 540)).toBe(true);
  // Seeded: every look sees the same burst.
  expect(confettiPieces()).toEqual(pieces);
});
