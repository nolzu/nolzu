import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isFakeMode } from '@nolzu/protocol';

// Fake mode ignores NOLZU_DATA_DIR, so a leftover export in the shell cannot point a fake run
// at live data.
export function resolveDataDir(env: Record<string, string | undefined>): string {
  if (isFakeMode(env)) return join(homedir(), '.nolzu-fake');
  return env.NOLZU_DATA_DIR ? resolve(env.NOLZU_DATA_DIR) : join(homedir(), '.nolzu');
}
