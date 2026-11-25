import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packageFolder } from './project-files.ts';

// An installed client has the skills package's code in its bundle, the skill files copied into dist/,
// and no @nolzu/skills package beside it.
vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: () => {
      throw new Error('Cannot find module @nolzu/skills/package.json');
    },
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

it('reads the folders the nolzu command copied when the package cannot be found', () => {
  vi.stubEnv('NOLZU_SKILLS_DIR', join('opt', 'nolzu', 'dist'));

  expect(packageFolder('skills')).toBe(join('opt', 'nolzu', 'dist', 'skills'));
  expect(packageFolder('shared')).toBe(join('opt', 'nolzu', 'dist', 'shared'));
});

it('falls back to its own place when nothing names the copied folders', () => {
  vi.stubEnv('NOLZU_SKILLS_DIR', undefined);

  expect(packageFolder('shared')).toBe(join(import.meta.dirname, '..', 'shared'));
});
