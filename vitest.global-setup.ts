import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    liveDataDir: string;
  }
}

// Runs in the main process before the workers start, so every worker inherits the temp HOME.
export default function setup(project: TestProject) {
  // userInfo reads the account database, so it still finds the real home after HOME changes.
  project.provide('liveDataDir', join(userInfo().homedir, '.nolzu'));
  const home = mkdtempSync(join(tmpdir(), 'nolzu-test-'));
  process.env.HOME = home;
  process.env.NOLZU_DATA_DIR = join(home, 'data');
  // A flag left in the shell would send resolveDataDir to the fake directory. Tests that need
  // fake mode pass it in their own env object.
  delete process.env.NOLZU_FAKE_AGENT;
  // The spend roll-up groups by the UTC day and the times a screen prints come from Intl. Pinned
  // here so a test means the same thing on this machine and on the CI runner.
  process.env.TZ = 'UTC';
  return () => rmSync(home, { recursive: true, force: true });
}
