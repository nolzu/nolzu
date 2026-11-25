import { expect, it } from 'vitest';
import { typedName } from './confirm.ts';

it('turns the confirm on for the exact name', () => {
  expect(typedName('web', 'web')).toBe(true);
});

// The server compares the typed name exactly, so a looser gate would turn on a button the server refuses.
it.each([
  ['', 'nothing typed yet'],
  ['we', 'part of the name'],
  ['web ', 'a space after it'],
  [' web', 'a space before it'],
  ['Web', 'another case'],
  ['webs', 'a letter more'],
])('keeps the confirm off for %j, %s', (typed) => {
  expect(typedName(typed, 'web')).toBe(false);
});

it('never turns on for an empty name', () => {
  expect(typedName('', '')).toBe(false);
});
