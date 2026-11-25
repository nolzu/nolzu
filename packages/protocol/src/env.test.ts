import { expect, it } from 'vitest';
import { isFakeMode } from './env.ts';

it('reads 1 as on', () => {
  expect(isFakeMode({ NOLZU_FAKE_AGENT: '1' })).toBe(true);
});

it.each(['0', 'true', '', undefined])('reads %j as off', (value) => {
  expect(isFakeMode({ NOLZU_FAKE_AGENT: value })).toBe(false);
});
