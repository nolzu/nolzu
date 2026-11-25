import { userInfo } from 'node:os';
import { resolveDataDir } from '@nolzu/core/node';
import { expect, it } from 'vitest';

it('runs tests written in the app at all', () => {
  // The app was in no Vitest project until now, so a test here ran nowhere and a broken one
  // would still have looked green.
  expect(1 + 1).toBe(2);
});

it('still refuses to resolve the live data directory', () => {
  // The guard lives in the root setup file. A project that did not inherit it would hand back
  // the real ~/.nolzu here, and a test could then open the database a person actually uses.
  const realHome = userInfo().homedir;
  const previous = process.env.HOME;
  process.env.HOME = realHome;
  try {
    expect(() => resolveDataDir({})).toThrow(/live data directory/);
  } finally {
    process.env.HOME = previous;
  }
});
