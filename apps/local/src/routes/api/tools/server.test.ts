import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

// A fake PATH of one temp folder and no login shell to ask, set before the route reads the PATH once.
// No real claude, codex or cursor-agent can be found or started from here.
const bin = mkdtempSync(join(tmpdir(), 'nolzu-tools-path-'));
vi.stubEnv('SHELL', '');
vi.stubEnv('PATH', bin);
const { GET } = await import('./+server.ts');
const look = async () => (await (GET as unknown as () => Response)()).json() as Promise<string[]>;

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(bin, { recursive: true, force: true });
});

it('answers which engines are on the PATH, and finds claude once it lands there, without running it', async () => {
  expect(await look()).toEqual([]);
  vi.unstubAllEnvs();

  const ran = join(bin, 'ran');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch '${ran}'\n`);
  chmodSync(join(bin, 'claude'), 0o755);

  expect(await look()).toEqual(['claude-code']);
  expect(existsSync(ran)).toBe(false);
});
