import { expect, it, vi } from 'vitest';

// The PATH scan is the runner's and has its own tests. Here the load hands on how many it found, and
// it asks the PATH the engines run with.
const scan = vi.hoisted(() => ({ found: ['claude-code', 'codex'] as string[], path: '' }));
vi.mock('@nolzu/runner', async (real) => ({
  ...(await real<object>()),
  loginShellPath: () => '/fake/bin',
  enginesOnPath: (path: string) => {
    scan.path = path;
    return scan.found;
  },
}));

const { load } = await import('./+layout.server.ts');
const enginesFound = () => (load as unknown as () => { enginesFound: number })().enginesFound;

it('counts the engine tools on the PATH the engines run with, for the menu', () => {
  expect(enginesFound()).toBe(2);
  expect(scan.path).toBe('/fake/bin');
  scan.found = [];
  expect(enginesFound()).toBe(0);
});
