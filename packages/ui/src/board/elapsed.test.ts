import { describe, expect, it } from 'vitest';
import { age, elapsed } from './elapsed.ts';

const START = '2026-09-16T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000);

// The form the running pill draws: "0m 40s", "2m 14s", then hours and minutes.
it.each([
  [0, '0m 00s'],
  [40, '0m 40s'],
  [59, '0m 59s'],
  [61, '1m 01s'],
  [134, '2m 14s'],
  [3599, '59m 59s'],
  [3600, '1h 00m'],
  [3720, '1h 02m'],
])('turns %i seconds into %s', (seconds, shown) => {
  expect(elapsed(START, at(seconds))).toBe(shown);
});

it('never counts backwards when the start is ahead of the clock', () => {
  // Two clocks are never exactly equal. A start a few seconds in the future must read as zero
  // and never as a minus, which is what a plain subtraction would show.
  expect(elapsed(START, at(-5))).toBe('0m 00s');
});

it('reports nothing when the start cannot be read', () => {
  expect(elapsed('yesterday', at(0))).toBeNull();
});

describe('age', () => {
  const minutes = (count: number) => new Date(Date.parse(START) + count * 60_000);

  // One unit in the short form ("head 20m old"), and the boundary where the unit changes. A
  // head commit is hours and days old, and a figure in seconds there says nothing a person can use.
  it.each([
    [0, '0m'],
    [59, '59m'],
    [60, '1h'],
    [23 * 60 + 59, '23h'],
    [24 * 60, '1d'],
    [9 * 24 * 60, '9d'],
  ])('turns %i minutes into %s', (count, shown) => {
    expect(age(START, minutes(count))).toBe(shown);
  });

  it('never counts backwards, and reports nothing when the time cannot be read', () => {
    expect(age(START, minutes(-5))).toBe('0m');
    expect(age('yesterday', minutes(0))).toBeNull();
  });
});
