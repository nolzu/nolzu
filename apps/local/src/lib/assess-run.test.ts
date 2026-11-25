import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@nolzu/core';
import { readRun, scoutFinding, writeSetting } from '@nolzu/core/node';
import { assessKey, type Job } from '@nolzu/protocol';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLoop, type Loop } from './loop.ts';
import { readAssessment } from './scout-assess.ts';

// Every wait below watches a run that spawns a real shell, so the window is the machine's and not
// the product's. vitest waits one second by default, and a full suite run on a busy machine takes
// longer than that to write the first row. `qa-run.test.ts` was given this window for the same
// reason, and these three files were missed.
const WAIT = { timeout: 10_000 };

// The read-only assessment. It belongs to no card, so everything a card's run reads from its row
// comes from somewhere else: the key of its finding, the finding itself as the ticket text, and the
// Scout lane. It works in the project folder, where the run guard is the only wall, which is why a
// project without that file starts no assessment at all.
let dir = '';
let project = '';
let live: Loop;

// No config of the person's own, and one author, so the test runs the same on every machine.
const CLEAN = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...CLEAN }, encoding: 'utf8' });

// The line a person pasted. It carries an id and a number, which is what makes the two collected
// lines of one finding differ.
const LINE = "TypeError: Cannot read properties of undefined (reading 'length') at rating.ts:31";

// The guard file the wizard writes. An assessment works in the project itself, so this file is the
// only thing holding it to reading, and a project without it starts no such run.
function writeGuard(): void {
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes. The fake engine runs no hook.\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-assess-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-assess-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  writeGuard();
  live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', project);
  live.db.prepare("INSERT INTO scout_sources (id, kind, label) VALUES (1, 'paste', 'Pasted logs')").run();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// One finding, the way a check leaves it: seen twice, with the first and the newest line kept.
const addFinding = (fingerprint: string, last = LINE): number =>
  Number(
    live.db
      .prepare(
        `INSERT INTO scout_findings (source_id, fingerprint, occurrences, first_seen, last_seen, first_message, last_message, location)
         VALUES (1, ?, 2, '2026-09-20T08:00:00.000Z', '2026-09-26T09:30:00.000Z', ?, ?, 'src/recipes/rating.ts')
         RETURNING id`,
      )
      .get(fingerprint, LINE, last)?.id,
  );

const addCard = (key: string, stage = 'inbox') =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);

const lastRun = (): number => (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;

const statusOf = (id: number): string | undefined => scoutFinding(live.db, id)?.status;

async function assessToEnd(findingId: number): Promise<number> {
  expect(live.assess(findingId)).toBe(true);
  const runId = lastRun();
  // Out of the queue too: the summary pass and its git compare still hold the slot.
  await vi.waitFor(() => {
    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(live.scheduler.queue().running.some((job) => job.runId === runId)).toBe(false);
  }, WAIT);
  return runId;
}

// The job, which is where the policy, the lane and the folder all show at once. The tool list is
// what the engine is handed; the guard is what refuses a write, and `spawn.test.ts` asks it.
it('builds an assessment job in the Scout lane, with no command', () => {
  const id = addFinding('a1');

  const job = live.buildJob(assessKey(id), 'assess', 1);

  expect(job.lane).toBe('scout');
  expect(job.tools).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit']);
  expect(job.knowledgeDir).toBeNull();
  expect(job.mcpConfigPath).toBeNull();
  // The project itself and no checkout of its own, because the run changes nothing and a checkout
  // would be a branch made for it.
  expect(job.cwd).toBe(project);
  expect(job.taskDir).toBe(join(project, '.tasks', `assess-${id}`));
  // The runtime contract says the run changes nothing, and it comes from the policy row.
  expect(job.prompt).toContain('This phase changes no code.');
  expect(job.prompt).toContain('/assess/instructions.md`');
});

// The evidence travels into the prompt, because it is the whole ticket of this run. It stays out of
// the key and the log path, which are built from the id: a collected line can hold a real token.
it('carries the finding as the ticket text and never as the key', () => {
  const id = addFinding('a2', `${LINE} on recipe 91`);

  const job = live.buildJob(assessKey(id), 'assess', 1);

  expect(job.cardKey).toBe(`assess-${id}`);
  expect(job.prompt).toContain(LINE);
  expect(job.prompt).toContain(`${LINE} on recipe 91`);
  expect(job.prompt).toContain('Seen 2 times');
  expect(job.prompt).toContain('src/recipes/rating.ts');
  expect(job.logPath).not.toContain('TypeError');
});

/**
 * The lane, proved the way QA proves it: one assessment holds it, the next one waits, and work that
 * has nothing to do with Scout goes past both.
 *
 * Each assessment carries the key of its own finding, so the second one waits on the lane. Under one
 * reserved key the queue would throw for it instead, and a throw is not a wait.
 */
it('runs one assessment at a time and lets unrelated work past', async () => {
  const first = addFinding('a3');
  const second = addFinding('a4');
  addCard('APP-3');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'assess') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.assess(first);
  const firstRun = lastRun();
  live.assess(second);
  const secondRun = lastRun();
  live.start('APP-3', 'refine');
  const unrelated = lastRun();

  expect(live.scheduler.queue().running.map((job) => job.runId)).toEqual([firstRun, unrelated]);
  expect(live.scheduler.queue().running.map((job) => job.lane)).toEqual(['scout', null]);
  expect(waitFor(live.scheduler.queue(), secondRun)).toEqual({ reason: 'lane', position: 1 });
  await vi.waitFor(() => expect(readRun(live.db, unrelated)?.state).toBe('complete'), WAIT);

  release();
  await vi.waitFor(() => expect(readRun(live.db, secondRun)?.state).toBe('complete'), WAIT);
});

// The guard is the whole wall, because the run reads the person's own tree. Without the file the hook
// names nothing, so it refuses nothing, and a read-only phase would have write access to every file
// there.
it('starts nothing in a project that has no run guard', () => {
  const id = addFinding('a5');
  rmSync(join(project, GUARD_PATH));

  expect(() => live.assess(id)).toThrow(`This project has no run guard at ${GUARD_PATH}, so nothing would hold an assessment run to reading. Press Write the project files in Project settings.`);
  expect(live.scheduler.queue().running).toEqual([]);
  expect(statusOf(id)).toBe('new');
});

// An assessment causes no git write, and a branch cut for a finding would be one. The repository is
// the proof: one branch, and no worktrees folder.
it('makes no branch and no checkout for an assessment', async () => {
  const id = addFinding('a6');

  await assessToEnd(id);

  expect(git('branch', '--format=%(refname:short)').trim()).toBe('main');
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
  expect(git('status', '--porcelain', '-uno').trim()).toBe('');
});

// The status word the run sets, and the only one an assessment writes. The finding moves when the run has
// started, so a refusal leaves it where it was.
it('moves the finding into the assessment column once the run has started', async () => {
  const id = addFinding('a7');

  await assessToEnd(id);

  expect(statusOf(id)).toBe('assess');
});

// The output, read back whole out of the file the run wrote in its own folder.
it('leaves an assessment a screen can read back with all five parts', async () => {
  const id = addFinding('a8');

  const runId = await assessToEnd(id);

  const written = readFileSync(join(project, '.tasks', `assess-${id}`, 'assess', 'assessment.md'), 'utf8');
  const read = readAssessment(written);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.parts.evidence).toContain('rating.ts:31');
  expect(read.parts.effort).not.toBe('');
  // The run row is how a screen finds the file, because the key names the folder.
  expect(readRun(live.db, runId)?.cardKey).toBe(assessKey(id));
  const summary = live.db.prepare('SELECT plain_summary AS text FROM runs WHERE id = ?').get(runId) as { text: string | null };
  expect(summary.text).toContain('vote');
});

// A second assessment of one finding while the first is still in the queue. The queue refuses a
// second run under one key with an exception, so this is refused before the run row is written.
it('refuses a second assessment of the same finding while one is in the queue', async () => {
  const id = addFinding('a9');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'assess') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.assess(id);
  const runId = lastRun();

  expect(() => live.assess(id)).toThrow(/has an assessment in the queue already/);
  expect(lastRun()).toBe(runId);

  release();
  await vi.waitFor(() => {
    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(live.scheduler.queue().running.some((job) => job.runId === runId)).toBe(false);
  }, WAIT);
  // Once it has ended, another one runs and writes over the file in the same folder, the way a
  // second run of any phase does.
  expect(live.assess(id)).toBe(true);
  expect(lastRun()).not.toBe(runId);
});

// A person can mute a finding while its assessment is running. The run is not stopped: it costs the
// same either way and what it wrote is worth reading. The finding stays muted, because the status
// write only moves a finding out of `new`.
it('leaves a finding muted when it was dismissed while the assessment ran', async () => {
  const id = addFinding('a10');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'assess') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.assess(id);
  const runId = lastRun();
  live.db.prepare("UPDATE scout_findings SET status = 'dismissed' WHERE id = ?").run(id);

  release();
  await vi.waitFor(() => {
    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(live.scheduler.queue().running.some((job) => job.runId === runId)).toBe(false);
  }, WAIT);
  expect(statusOf(id)).toBe('dismissed');
});

// Removing a source takes its findings with it. A run already going finishes, because its ticket text
// was read when the job was built, and a run stopped halfway would cost the same and say nothing.
it('finishes an assessment whose finding went with its source, and refuses the next one', async () => {
  const id = addFinding('a11');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'assess') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.assess(id);
  const runId = lastRun();
  live.db.prepare('DELETE FROM scout_sources WHERE id = 1').run();

  release();
  await vi.waitFor(() => {
    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(live.scheduler.queue().running.some((job) => job.runId === runId)).toBe(false);
  }, WAIT);
  expect(scoutFinding(live.db, id)).toBeNull();
  expect(() => live.assess(id)).toThrow(`There is no finding ${id} on this machine, so there is nothing to assess. It may have gone with the source that found it.`);
});
