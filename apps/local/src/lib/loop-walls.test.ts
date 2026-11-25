import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { createLoop } from './loop.ts';

// Outside fake mode every job leaves through the loop's adapter. The real engine is swapped for one
// that records the job it is handed, so no engine binary runs.
const seen = vi.hoisted(() => ({ jobs: [] as Job[] }));
vi.mock('@nolzu/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nolzu/runner')>();
  return {
    ...actual,
    selectEngine: (...args: Parameters<typeof actual.selectEngine>) => ({
      ...actual.selectEngine(...args),
      spawn: (job: Job) => {
        seen.jobs.push(job);
        return (async function* () {})();
      },
    }),
  };
});

let folder = '';
afterEach(() => {
  if (folder !== '') rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  folder = '';
  seen.jobs.length = 0;
});

it("hands a real engine's job the project's stored wall lists", async () => {
  folder = mkdtempSync(join(tmpdir(), 'nolzu-loop-walls-'));
  mkdirSync(join(folder, 'project'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: join(folder, 'project'), stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const real = createLoop(folder, {}, { wall: { ready: false, reason: 'test' } as never });
  try {
    writeSetting(real.db, 'projectPath', join(folder, 'project'));
    writeSetting(real.db, 'wallLists', { hidden: ['~/secrets'], exceptions: ['.env.test'], writable: ['~/.gradle'] });
    real.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'idle', 'A card')").run();
    expect(real.start('APP-1', 'refine')).toBe(true);
    await vi.waitFor(() => expect(seen.jobs.length).toBeGreaterThan(0), { timeout: 10000 });
    expect(seen.jobs[0]?.walls).toEqual({ hidden: ['~/secrets'], exceptions: ['.env.test'], writable: ['~/.gradle'] });
  } finally {
    real.close();
  }
});
