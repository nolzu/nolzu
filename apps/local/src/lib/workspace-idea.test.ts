import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import type { RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Clone } from './add-repo.ts';
import { createLoop, type Loop } from './loop.ts';
import { startFromIdea } from './new-project.ts';

const ENV = { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });

let dir = '';
let parent = '';
let live: Loop;
let seen: { cwd: string; phase: string }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-idea-db-'));
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-idea-parent-')));
  live = createLoop(dir, ENV);
  seen = [];
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'extract-summary') return;
    seen.push({ cwd: job.cwd, phase: job.phase });
    yield RESULT;
  };
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// GitHub stands in as a bare repository in the temp parent. The recorded gh answers the reads and
// pushes its source there on `repo create`, and the clone reads it back. The real gh is never spawned.
const recorded = (): { run: RunGh; clone: Clone } => {
  const bare = join(parent, 'github', 'recipes.git');
  const git = (...args: string[]) => execFileSync('git', args, { env: ENV });
  const run: RunGh = async (args) => {
    if (args[0] === 'api') return { code: 0, stdout: args[1] === 'user' ? '{"login":"you"}' : '[]', stderr: '' };
    if (args[1] === 'view') return { code: 1, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'you/recipes'. (repository)\n" };
    const source = args[args.indexOf('--source') + 1]!;
    git('init', '-q', '--bare', '-b', 'main', bare);
    git('-C', source, 'remote', 'add', 'origin', 'https://github.com/you/recipes.git');
    git('-C', source, 'push', '-q', bare, 'HEAD');
    return { code: 0, stdout: '', stderr: '' };
  };
  const clone: Clone = async ({ workspace }) => {
    git('clone', '-q', bare, join(workspace, 'recipes'));
    return { ok: true, name: 'recipes', path: join(workspace, 'recipes') };
  };
  return { run, clone };
};

// The whole way through: the idea page makes the workspace, its repository and the card, and refine
// runs on that card in the card's checkout of the new repository, as on any workspace with one.
it('runs refine on the epic an idea starts, in its checkout of the new repository', async () => {
  const started = await startFromIdea(live.db, { idea: 'A site where people share recipes', decided: '', name: 'recipes', folder: join(parent, 'recipes'), owner: 'you', repo: 'recipes' }, { ...recorded(), env: ENV });
  if ('problem' in started) throw new Error(started.problem);
  const workspace = join(parent, 'recipes');

  live.db.prepare("UPDATE cards SET state = 'queued' WHERE key = ?").run(started.key);
  live.start(started.key, 'refine');
  const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  let state: string | undefined;
  for (let tries = 0; tries < 3000 && !['complete', 'failed', 'stopped'].includes(state ?? ''); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = readRun(live.db, runId)?.state ?? undefined;
  }

  expect(readRun(live.db, runId)?.failureReason ?? null).toBeNull();
  expect(state).toBe('complete');
  expect(seen).toEqual([{ cwd: join(workspace, 'worktrees', started.key), phase: 'refine' }]);
  expect(existsSync(join(workspace, 'worktrees', started.key, 'recipes', '.git'))).toBe(true);
});
