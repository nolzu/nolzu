import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSkills } from '@nolzu/runner';
import { expect, it } from 'vitest';

const packageDir = (path: string) => fileURLToPath(new URL(`../../../../packages/skills/${path}`, import.meta.url));

// The pipeline skills as the package ships them, synced into a project the way onboarding does it,
// then checked by the same lint command CI runs. A copy that breaks the lint breaks in every project.
it('syncs the shipped skills into a copy that passes the skills lint', () => {
  const project = mkdtempSync(join(tmpdir(), 'nolzu-sync-'));
  try {
    const target = join(project, '.claude', 'skills');
    const result = syncSkills(packageDir('skills/'), target);
    const linted = spawnSync(process.execPath, [packageDir('src/cli.ts'), target], { encoding: 'utf8' });

    expect(result.conflicts).toEqual([]);
    expect(linted.stderr).toBe('');
    expect(linted.status).toBe(0);
    // Counted from the folder, not written here. A hard-coded number turns every new skill into
    // a failure in a test that is about the sync, not about how many skills there are.
    const shipped = readdirSync(packageDir('skills/'), { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    ).length;
    expect(shipped).toBeGreaterThan(0);
    expect(linted.stdout).toContain(`checked ${shipped} skills`);
  } finally {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
