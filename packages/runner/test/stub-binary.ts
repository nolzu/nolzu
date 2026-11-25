import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StubBinary {
  path: string;
  remove: () => void;
}

// A real executable standing in for the engine. Spawning one exercises real pipes, real
// chunk boundaries, real exit codes and real signals, so the tests prove the spawning code
// rather than a mock of it, and no test ever reaches the vendor binary or the network.
export function stubBinary(body: string, name = 'claude-stub'): StubBinary {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-stub-'));
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
