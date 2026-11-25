import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { ASK_PHASE } from '@nolzu/protocol';
import { GUARD_PATH, savePhaseInstructions } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

// Each run is told which files of its card folder the earlier phases wrote, and Plan is told where
// the project's instructions for Implement and QA are.
let dir = '';
let project = '';
let live: Loop;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-read-first-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: GIT_ENV });
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', ...GIT_ENV });
  writeSetting(live.db, 'projectPath', project);
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-2', 'delivery', 'plan', 'Search recipes')").run();
  for (const doc of ['refine/refined.md', 'discoveries.md']) {
    mkdirSync(join(project, '.tasks', 'APP-2', doc, '..'), { recursive: true });
    writeFileSync(join(project, '.tasks', 'APP-2', doc), '# APP-2\n');
  }
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('names the files the earlier phases wrote, and no other', () => {
  const job = live.buildJob('APP-2', 'plan', 99);

  expect(job.prompt).toContain('## Read first');
  expect(job.prompt).toContain('- `../../.tasks/APP-2/refine/refined.md`\n- `../../.tasks/APP-2/discoveries.md`');
  expect(job.prompt).not.toContain('architecture.md');
  expect(job.prompt).not.toContain('.nolzu/phases');
  expect(job).not.toHaveProperty('readFiles');  // An Ask has a method of its own and reads no phase's files.
  expect(live.buildJob('APP-2', ASK_PHASE, 97).prompt).not.toContain('Read first');
});

it("gives Plan the project's instructions for Implement and QA that exist, read only", () => {
  expect(savePhaseInstructions(project, 'implement', 'Every change gets a changelog line.')).toBeNull();

  const job = live.buildJob('APP-2', 'plan', 99);

  expect(job.prompt).toContain('- `../../.nolzu/phases/implement.md`, for Implement');
  expect(job.prompt).not.toContain('qa.md`, for QA');
  expect(job.readFiles).toEqual([join(project, '.nolzu', 'phases', 'implement.md')]);
  // The text itself stays with Implement, whose own prompt carries it.
  expect(job.prompt).not.toContain('changelog line');
  expect(live.buildJob('APP-2', 'implement', 98)).not.toHaveProperty('readFiles');
});

// The rounds a re-review reads are the ones the Review tab lists, so a second spelling of a number is
// not one of them.
it('gives a re-review its earlier rounds, oldest first', () => {
  const review = join(project, '.tasks', 'APP-2', 'pr-review');
  mkdirSync(review, { recursive: true });
  for (const name of ['round-10.md', 'round.md', 'round-2.md', 'round-02.md', 'diff.patch']) writeFileSync(join(review, name), 'x\n');

  const job = live.buildJob('APP-2', 'pr-review', 99);

  expect(job.prompt).toContain('- `../../.tasks/APP-2/pr-review/round.md`\n- `../../.tasks/APP-2/pr-review/round-2.md`\n- `../../.tasks/APP-2/pr-review/round-10.md`\n\n');
  expect(job.prompt).not.toContain('round-02.md');
  expect(job.prompt).not.toContain('refined.md');
});
