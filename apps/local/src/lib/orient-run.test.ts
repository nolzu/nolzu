import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeChangesOfRun, readRun, recordKnowledgeChanges, returnKnowledgeChanges, startRun, writeSetting } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY, type Job } from '@nolzu/protocol';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { learnAsking } from './knowledge-learn.ts';
import { createLoop, type Loop } from './loop.ts';

// Learn this project. It belongs to no card, asks the person on the
// way, and what it writes waits for review even with the review setting off.
let dir = '';
let project = '';
let live: Loop;

const CLEAN = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...CLEAN }, encoding: 'utf8' });
const knowledgeDir = () => join(project, '.nolzu', 'knowledge');
const lastRun = (): number => (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;

async function untilEnd(runId: number): Promise<number> {
  for (let tries = 0; tries < 300; tries += 1) {
    const state = readRun(live.db, runId)?.state;
    if (state === 'complete' || state === 'failed' || state === 'stopped') return runId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the orient run did not end');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-orient-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-orient-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes. The fake engine runs no hook.\n');
  live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', project);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('asks with answers, goes on with the answer, and holds what it wrote with review off', async () => {
  writeSetting(live.db, 'reviewKnowledge', false);
  const head = git('rev-parse', 'HEAD').trim();

  expect(live.learn()).toBe(true);
  const asked = await untilEnd(lastRun());

  const question = learnAsking(live.db);
  expect(question?.runId).toBe(asked);
  expect(question?.question).toBe('Is there a folder in this project an agent must never change?');
  expect(question?.options.map((one) => one.label)).toEqual(['The tickets folder', 'None', 'Skip']);
  expect(knowledgeChangesOfRun(live.db, asked)).toEqual([]);

  expect(live.answer(KB_MAINTENANCE_KEY, 'The tickets folder')).toBe(true);
  const wrote = await untilEnd(lastRun());

  expect(readRun(live.db, wrote)?.state).toBe('complete');
  expect(learnAsking(live.db)).toBeNull();
  // Held: one pending row, no commit, and the folder as it was before the run.
  expect(knowledgeChangesOfRun(live.db, wrote).map((row) => [row.filePath, row.status])).toEqual([['.nolzu/knowledge/project-rules.md', 'pending']]);
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(existsSync(join(knowledgeDir(), 'project-rules.md'))).toBe(false);
});

it('runs in the project folder under the reserved key, and names the repository it starts with', () => {
  writeSetting(live.db, 'repos', [{ path: 'api', base: 'main' }]);
  mkdirSync(join(project, 'api'), { recursive: true });
  const job: Job = live.buildJob(KB_MAINTENANCE_KEY, 'orient', 0, 'api');

  expect(job.cwd).toBe(project);
  expect(job.lane).toBe('knowledge');
  expect(job.knowledgeDir).toBe(knowledgeDir());
  expect(job.knowledgeFile).toBeNull();
  expect(job.tools).not.toContain('Bash');
  expect(job.prompt).toContain('## This run');
  expect(job.prompt).toContain('Learn this project');
  expect(job.prompt).toContain('Start with the repository `api`, which was added a moment ago.');
  expect(job.prompt).toContain('.tasks/kb-maintenance/orient/instructions.md');
});

it('starts nothing for a repository the project does not have, or without a run guard', () => {
  expect(() => live.learn('../elsewhere')).toThrow(/There is no repository "..\/elsewhere" in this project/);
  rmSync(join(project, GUARD_PATH));
  expect(() => live.learn()).toThrow(`This project has no run guard at ${GUARD_PATH}, so nothing would hold a maintenance run to the knowledge folder. Press Write the project files in Project settings.`);
  expect(live.scheduler.queue().running).toEqual([]);
});

it('refuses an answer when it asked nothing', () => {
  expect(() => live.answer(KB_MAINTENANCE_KEY, 'The tickets folder')).toThrow(/not waiting for an answer/);
});

// A run row of another knowledge run, with the given phase and key.
const runOf = (cardKey: string, phase: string): number =>
  startRun(live.db, { cardKey, phase, engine: 'claude-code', model: 'sonnet', effort: 'low', sessionId: null, logPath: '', lane: 'knowledge' });

// A failed start would be the newest run under the key and take the question with it, so the answer
// is refused as a sentence and the question still waits.
it('keeps the question when the answer cannot start, and says why', async () => {
  expect(live.learn()).toBe(true);
  const asked = await untilEnd(lastRun());
  recordKnowledgeChanges(live.db, { cardKey: 'APP-1', runId: runOf('APP-1', 'wrapup'), commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/rows.md', summary: 'added' }] });

  expect(() => live.answer(KB_MAINTENANCE_KEY, 'The tickets folder')).toThrow(/still waiting for a person: \.nolzu\/knowledge\/rows\.md\. .* then send your answer again\.$/);
  expect(learnAsking(live.db)?.runId).toBe(asked);
});

// Optimize shares the reserved key. Going on from the folder a waiting Learn this project left, it
// would commit what that run wrote, which always waits for review.
it('keeps what a waiting Learn this project wrote out of an Optimize commit', async () => {
  writeSetting(live.db, 'reviewKnowledge', false);
  mkdirSync(knowledgeDir(), { recursive: true });
  writeFileSync(join(knowledgeDir(), 'rows.md'), '---\ndescription: Read before changing the importer.\n---\n\nThe importer refuses a row with no id.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'knowledge');
  expect(live.learn()).toBe(true);
  await untilEnd(lastRun());
  // What a real run may write before it stops to ask.
  writeFileSync(join(knowledgeDir(), 'project-rules.md'), '- Never change the tickets folder, because the recording follows them. (told by the person)\n');

  expect(live.optimize('rows.md')).toBe(true);
  const optimized = await untilEnd(lastRun());

  expect(knowledgeChangesOfRun(live.db, optimized).map((row) => [row.filePath, row.status])).toEqual([['.nolzu/knowledge/rows.md', 'applied']]);
  expect(git('ls-files', '--', '.nolzu/knowledge/project-rules.md').trim()).toBe('');
});

// Optimize and Learn this project share the reserved key, and a note returned to one is no
// instruction for the other.
it('hands the note of a returned change to the next run of its own kind only', () => {
  mkdirSync(knowledgeDir(), { recursive: true });
  writeFileSync(join(knowledgeDir(), 'rows.md'), '---\ndescription: Read before changing the importer.\n---\n\nThe importer refuses a row with no id.\n');
  const learned = runOf(KB_MAINTENANCE_KEY, 'orient');
  recordKnowledgeChanges(live.db, { cardKey: KB_MAINTENANCE_KEY, runId: learned, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/project-rules.md', summary: 'added' }] });
  returnKnowledgeChanges(live.db, learned, 'Drop the rule about the tickets folder.');

  expect(live.buildJob(KB_MAINTENANCE_KEY, 'orient', 0).prompt).toContain('Drop the rule about the tickets folder.');
  expect(live.buildJob(KB_MAINTENANCE_KEY, 'optimize', 0, 'rows.md').prompt).not.toContain('Drop the rule');
});
