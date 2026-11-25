import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, knowledgeChangesOfRun, setCardModels, outputCheckOf, readRun, recordKnowledgeChanges, returnedKnowledgeNote, startRun, writeSetting } from '@nolzu/core/node';
import { hubEnvelope, type Job, readKnowledgeProposal, type RunnerMessageType } from '@nolzu/protocol';
import { git as runGit, knowledgeCommitMessage } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeHubJob } from './hub-jobs.ts';
import { answerApproveAll, approveKnowledge, heldPath, returnKnowledge } from './knowledge-review.ts';
import { stopThenMove } from '../routes/api/board/writes.ts';
import { createLoop, type Loop, type LoopOptions, writtenNotes } from './loop.ts';
import { nowSnapshot } from './now-snapshot.ts';
import { overviewFor } from './overview.ts';
import { peekFor } from './peek.ts';

// A team project's knowledge needs the cloud open (`packages/protocol/src/soon.ts`), so the team cases
// here run with it on. cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

// Every wait below watches a run that spawns a real shell, so the window is the machine's and not
// the product's. vitest waits one second by default, and a full suite run on a busy machine takes
// longer than that to write the first row. `qa-run.test.ts` was given this window for the same
// reason, and these three files were missed.
const WAIT = { timeout: 10_000 };

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

const knowledgeDir = () => join(project, '.nolzu', 'knowledge');

// The loop these tests run. `loop.ts` keys its loops on the data directory, so a test that needs
// other options closes the one below and builds it again over the same folder.
const openLoop = (options: LoopOptions = {}) => {
  live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, options);
  writeSetting(live.db, 'projectPath', project);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-wrapup-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-wrapup-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  openLoop();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage = 'pr-watch') =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);

// The run the start made, whatever happens to it after.
const lastRun = (): number => (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;

async function runToEnd(key: string, phase: 'wrapup' | 'refine' = 'wrapup'): Promise<number> {
  live.start(key, phase);
  const runId = lastRun();
  // Real git commits, so the window is the machine's: 15 seconds, inside the 20 second test timeout,
  // where a fixed count of 10 ms sleeps ran out on a busy suite.
  await vi.waitFor(
    () => {
      const state = readRun(live.db, runId)?.state;
      if (!(state === 'complete' || state === 'failed' || state === 'stopped')) throw new Error('the wrap-up run did not end');
    },
    { timeout: 15_000, interval: 10 },
  );
  return runId;
}

// The knowledge folder is made when the first wrap-up needs it. A person who typed a path gets a
// sentence instead, because a typo would leave a new empty folder somewhere on their machine.
it('makes the default knowledge folder before the first wrap-up writes in it', async () => {
  addCard('APP-1');
  expect(existsSync(knowledgeDir())).toBe(false);

  await runToEnd('APP-1');

  expect(existsSync(knowledgeDir())).toBe(true);
});

it('commits what the wrap-up wrote, and names the card and the run in the message', async () => {
  addCard('APP-1');

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: APP-1 run ${runId}`);
  expect(git('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('.nolzu/knowledge/browser-filtering.md');
});

// The row and the commit are one answer. The screen reads the rows and reverts the commit, so a
// row naming another commit would revert somebody else's work.
it('writes one row per file, all on the run its commit', async () => {
  addCard('APP-1');

  const runId = await runToEnd('APP-1');

  const head = git('rev-parse', 'HEAD').trim();
  expect(knowledgeChangesOfRun(live.db, runId)).toEqual([
    { id: 1, cardKey: 'APP-1', runId, filePath: '.nolzu/knowledge/browser-filtering.md', commitSha: head, summary: 'added', status: 'applied', note: null, movedFrom: null },
  ]);
});

// The output check reads the notes the run wrote, so a note with no description gets a badge.
it('checks the notes the wrap-up wrote, and finds the fake one in the entry shape', async () => {
  addCard('APP-1');

  const runId = await runToEnd('APP-1');

  expect(outputCheckOf(live.db, runId)).toEqual({ problems: [], note: null });
});

it('hands the output check each note the run added or changed, by its path in the folder', async () => {
  mkdirSync(join(knowledgeDir(), 'deep'), { recursive: true });
  writeFileSync(join(knowledgeDir(), 'deep', 'search.md'), 'Search lower cases.\n');
  writeFileSync(join(knowledgeDir(), 'logo.png'), 'not text');
  const run = (args: readonly string[]) => runGit(args, { cwd: knowledgeDir(), env: { ...process.env, ...CLEAN } as Record<string, string> });

  const changes = [
    { path: '.nolzu/knowledge/deep/search.md', kind: 'added' },
    { path: '.nolzu/knowledge/logo.png', kind: 'added' },
    { path: '.nolzu/knowledge/old.md', kind: 'removed' },
  ];
  expect(await writtenNotes(run, knowledgeDir(), changes)).toEqual({ notes: { 'knowledge/deep/search.md': 'Search lower cases.\n' }, created: ['knowledge/deep/search.md'] });
  // A note the run only corrected is no note it made.
  expect((await writtenNotes(run, knowledgeDir(), [{ path: '.nolzu/knowledge/deep/search.md', kind: 'corrected' }])).created).toEqual([]);
});

// The run may write the knowledge folder, and Nolzu reads its notes outside the wall after it.
it('reads no note through a link, and answers at once for a named pipe', async () => {
  mkdirSync(knowledgeDir(), { recursive: true });
  const secret = join(dir, 'id_test');
  writeFileSync(secret, 'not-a-real-key\n');
  symlinkSync(secret, join(knowledgeDir(), 'linked.md'));
  execFileSync('mkfifo', [join(knowledgeDir(), 'pipe.md')]);
  const run = (args: readonly string[]) => runGit(args, { cwd: knowledgeDir(), env: { ...process.env, ...CLEAN } as Record<string, string> });
  const changes = [
    { path: '.nolzu/knowledge/linked.md', kind: 'added' },
    { path: '.nolzu/knowledge/pipe.md', kind: 'added' },
  ];
  expect(await writtenNotes(run, knowledgeDir(), changes)).toEqual({ notes: {}, created: [] });
});

it('writes no commit and no row when the wrap-up changed nothing', async () => {
  addCard('APP-1');
  const head = git('rev-parse', 'HEAD').trim();
  // A run that reads the card and decides it taught nothing, which the skill asks for.
  live.engine.spawn = async function* () {
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(knowledgeChangesOfRun(live.db, runId)).toEqual([]);
});

// A run that died halfway wrote no knowledge anybody reviewed. What it left stays in the folder
// until a run of the same card finishes and commits it.
it('commits nothing when the run did not finish', async () => {
  addCard('APP-1');
  const head = git('rev-parse', 'HEAD').trim();
  live.engine.spawn = async function* () {
    mkdirSync(knowledgeDir(), { recursive: true });
    writeFileSync(join(knowledgeDir(), 'half-written.md'), 'half of a thought\n');
    yield JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(knowledgeChangesOfRun(live.db, runId)).toEqual([]);
});

// The card is started again after a run that did not finish, which is what Retry does and what
// answering a question does. Without the folder's earlier reading the second run would read the
// first run's file as the person's own work and commit nothing, and still report success.
it('commits what a run that did not finish left, when the card runs again', async () => {
  addCard('APP-1');
  const real = live.engine.spawn;
  live.engine.spawn = async function* () {
    mkdirSync(knowledgeDir(), { recursive: true });
    writeFileSync(join(knowledgeDir(), 'half-written.md'), 'half of a thought\n');
    yield JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  await runToEnd('APP-1');
  live.engine.spawn = real;
  const second = await runToEnd('APP-1');

  expect(readRun(live.db, second)?.state).toBe('complete');
  expect(git('show', '--name-only', '--pretty=', 'HEAD').trim().split('\n').sort()).toEqual([
    '.nolzu/knowledge/browser-filtering.md',
    '.nolzu/knowledge/half-written.md',
  ]);
  expect(knowledgeChangesOfRun(live.db, second).map((row) => row.filePath).sort()).toEqual([
    '.nolzu/knowledge/browser-filtering.md',
    '.nolzu/knowledge/half-written.md',
  ]);
});

// Once a wrap-up has finished, what is in the folder is the person's again. A reading held past
// that would make the next run commit their file under a card's name.
it('reads the folder fresh again once a wrap-up has finished', async () => {
  addCard('APP-1');
  await runToEnd('APP-1');
  const head = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(knowledgeDir(), 'mine.md'), 'my own note\n');

  const second = await runToEnd('APP-1');

  expect(readRun(live.db, second)?.state).toBe('complete');
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(git('status', '--porcelain', '-uall').trim()).toBe('?? .nolzu/knowledge/mine.md');
});

// git lists nothing in a folder it ignores, so a wrap-up there would write knowledge, commit
// nothing and end as if the card had taught nothing.
it('refuses a wrap-up into a folder git ignores', async () => {
  addCard('APP-1');
  writeFileSync(join(project, '.gitignore'), '.nolzu/\n');
  const head = git('rev-parse', 'HEAD').trim();

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(readRun(live.db, runId)?.failureReason).toContain('git ignores');
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
});

// A line such as `api/` with no leading slash also matches the api folder in the knowledge folder, where
// the notes about api go. git status would never list them, so the run is refused before it starts.
it('refuses a wrap-up when git ignores a repository folder of the knowledge folder, and names the line', async () => {
  addCard('APP-1');
  writeSetting(live.db, 'repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  live.db.prepare(`UPDATE cards SET repos = '["api"]', repos_by = 'plan' WHERE key = 'APP-1'`).run();
  for (const repo of ['api', 'web']) {
    execFileSync('git', ['init', '-q', '-b', 'main', join(project, repo)], { env: { ...process.env, ...CLEAN } });
    execFileSync('git', ['-C', join(project, repo), 'commit', '-q', '--allow-empty', '-m', 'first'], { env: { ...process.env, ...CLEAN } });
  }
  writeFileSync(join(project, '.gitignore'), 'api/\n');

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(readRun(live.db, runId)?.failureReason).toContain('git ignores api/ in the knowledge folder, through the .gitignore line api/');
});

// The default folder is made, a folder a person typed never is. A typo would otherwise leave a new
// empty folder on their machine instead of the sentence that names the mistake.
it('makes no folder a person typed, and says the folder is not there', async () => {
  addCard('APP-1');
  const typed = join(project, 'nowhere');
  writeSetting(live.db, 'knowledgeDir', typed);

  const runId = await runToEnd('APP-1');

  expect(existsSync(typed)).toBe(false);
  expect(readRun(live.db, runId)?.failureReason).toContain('There is no folder');
  expect(readRun(live.db, runId)?.state).toBe('failed');
});

// The check runs before the engine, so a folder nothing can be committed from costs no run at all.
it('fails the run before the engine starts when the folder is refused', async () => {
  addCard('APP-1');
  const folder = join(project, '.tasks', 'APP-1', 'knowledge');
  // The folder is there, so the refusal is the one about .tasks and nothing else.
  mkdirSync(folder, { recursive: true });
  writeSetting(live.db, 'knowledgeDir', folder);
  let started = false;
  const real = live.engine.spawn;
  live.engine.spawn = function (...args: Parameters<typeof real>) {
    started = true;
    return real(...args);
  };

  const runId = await runToEnd('APP-1');

  expect(started).toBe(false);
  expect(readRun(live.db, runId)?.failureReason).toContain('.tasks');
  expect(readRun(live.db, runId)?.state).toBe('failed');
});

// The person works in the same repository. A wrap-up that swept their file into its commit would
// put half-finished work into the knowledge history under a card's name.
it('leaves a file the person edited before the run out of the commit', async () => {
  addCard('APP-1');
  mkdirSync(knowledgeDir(), { recursive: true });
  writeFileSync(join(knowledgeDir(), 'mine.md'), 'my own note\n');

  const runId = await runToEnd('APP-1');

  expect(git('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('.nolzu/knowledge/browser-filtering.md');
  expect(git('status', '--porcelain', '-uall').trim().split('\n')).toContain('?? .nolzu/knowledge/mine.md');
  expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.filePath)).toEqual(['.nolzu/knowledge/browser-filtering.md']);
});

// A pending change from an earlier run is already on disk, so a second run's own files could not
// be told from it. On a first run that change is what Learn wrote, so the card waits for the person
// rather than failing, and starts once the change is answered.
it('waits while a change from an earlier run is pending, and starts once it is answered', async () => {
  addCard('APP-1');
  live.db
    .prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')")
    .run();
  const earlier = lastRun();
  live.db
    .prepare("INSERT INTO knowledge_changes (card_key, run_id, file_path, commit_sha, summary, status) VALUES ('APP-9', ?, '.nolzu/knowledge/importer.md', NULL, 'added', 'pending')")
    .run(earlier);

  const started = live.start('APP-1', 'wrapup');

  expect(started).toBe(true);
  const waiting = lastRun();
  expect(readRun(live.db, waiting)?.state).toBe('waiting_review');
  expect(live.snapshot().cards.find((card) => card.key === 'APP-1')).toMatchObject({ state: 'queued', runState: 'waiting_review' });
  // The rail's Knowledge item counts the change that holds it, off the Now stream.
  expect(nowSnapshot(live).knowledgePending).toBe(1);
  expect(git('log', '-1', '--pretty=%s').trim()).toBe('first');

  // An answer that leaves another change waiting starts nothing.
  live.reviewAnswered();
  expect(readRun(live.db, waiting)?.state).toBe('waiting_review');

  expect(returnKnowledge(live.db, { dataDir: dir, runId: earlier, note: 'Not this one.' }).ok).toBe(true);
  live.reviewAnswered();

  // The row that stood for the wait is gone, and the run that started has its own.
  expect(live.db.prepare("SELECT count(*) AS n FROM runs WHERE state = 'waiting_review'").get()).toEqual({ n: 0 });
  expect(nowSnapshot(live).knowledgePending).toBe(0);
  const runId = lastRun();
  await vi.waitFor(() => expect(readRun(live.db, runId)?.state).toBe('complete'), WAIT);
  expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: APP-1 run ${runId}`);
});

// Remove from queue is the way out while the person does not want to answer the change yet.
it('stops a wrap-up that waits for a review, and starts nothing after the answer', async () => {
  addCard('APP-1');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  const earlier = lastRun();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: earlier, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });
  live.start('APP-1', 'wrapup');
  const waiting = lastRun();

  live.stop(waiting);

  expect(readRun(live.db, waiting)?.state).toBe('stopped');
  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('idle');
  returnKnowledge(live.db, { dataDir: dir, runId: earlier, note: 'Not this one.' });
  live.reviewAnswered();
  expect(lastRun()).toBe(waiting);
});

// Two cards waiting: the oldest goes alone, and the next waits until that run has ended, so it runs on
// top of what the first one wrote.
it('starts the waiting cards one at a time, oldest first', async () => {
  addCard('APP-1');
  addCard('APP-2');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  const earlier = lastRun();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: earlier, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });
  live.start('APP-1', 'wrapup');
  live.start('APP-2', 'wrapup');
  const waitingOf = () => (live.db.prepare("SELECT card_key FROM runs WHERE state = 'waiting_review' ORDER BY id").all() as { card_key: string }[]).map((row) => row.card_key);
  expect(waitingOf()).toEqual(['APP-1', 'APP-2']);

  returnKnowledge(live.db, { dataDir: dir, runId: earlier, note: 'Not this one.' });
  live.reviewAnswered();
  // The scheduler's change asks again in a microtask, and the first run is still in the queue then.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(waitingOf()).toEqual(['APP-2']);
  const ran = (key: string) => (live.db.prepare("SELECT state FROM runs WHERE card_key = ? AND phase = 'wrapup' AND state != 'waiting_review' ORDER BY id DESC LIMIT 1").get(key) as { state: string } | undefined)?.state;
  await vi.waitFor(() => expect(ran('APP-2')).toBe('complete'), WAIT);
  expect(ran('APP-1')).toBe('complete');
  expect(waitingOf()).toEqual([]);
});

// Move back on the peek sheet sends `stop`: a waiting wrap-up is in no queue, so its row is stopped
// and the card moves.
it('moves a waiting wrap-up back after stopping the wait', async () => {
  addCard('APP-1', 'wrapup');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: lastRun(), commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });
  live.start('APP-1', 'wrapup');
  const waiting = lastRun();

  expect(await stopThenMove(live, 'APP-1', 'pr-watch')).toBeNull();

  expect(readRun(live.db, waiting)?.state).toBe('stopped');
  expect(live.db.prepare("SELECT stage, state FROM cards WHERE key = 'APP-1'").get()).toEqual({ stage: 'pr-watch', state: 'idle' });
});

// The checks every start makes run before the wait, so a card that cannot run says so now.
it('refuses a waiting wrap-up on a login this machine lacks at once, not after the review', () => {
  addCard('APP-1');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: lastRun(), commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });
  setCardModels(live.db, 'APP-1', { wrapup: { engine: 'codex#gone' } });

  expect(live.start('APP-1', 'wrapup')).toBe(false);
  expect(readRun(live.db, lastRun())?.failureReason).toContain('codex#gone');
  expect(live.db.prepare("SELECT count(*) AS n FROM runs WHERE state = 'waiting_review'").get()).toEqual({ n: 0 });
});

// A clean stop ends the wait as stopped, so the next start does not report a run cut off.
it('stops a waiting wrap-up when Nolzu shuts down', async () => {
  addCard('APP-1');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: lastRun(), commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });
  live.start('APP-1', 'wrapup');
  const waiting = lastRun();

  await live.shutdown();

  expect(readRun(live.db, waiting)?.state).toBe('stopped');
  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('idle');
});

// Approve, Apply all and Return on Knowledge, and a team approve, are the answers a wait waits for.
it('tells the loop after every answer to a knowledge change', () => {
  const route = readFileSync(new URL('../routes/knowledge/+page.server.ts', import.meta.url), 'utf8');
  for (const action of ['approve', 'approveAll', 'return']) expect(route).toMatch(new RegExp(`\\n  ${action}: async \\(\\{ request \\}\\) => answered\\(`));
  expect(route).toMatch(/const answered = \(answer: ReviewAnswer\) => \{\n {2}loop\(\)\.reviewAnswered\(\);/);
  expect(readFileSync(new URL('./hub-jobs.ts', import.meta.url), 'utf8')).toMatch(/await approveKnowledge\([^\n]*\);\n[^\n]*\n {4}live\.reviewAnswered\(\);/);
});

// git refuses a commit the person's own repository refuses, and no row may then say a change was
// applied. Signing with no signer there is how this one says no: the knowledge commit runs no hooks.
it('writes no row when git refuses the commit', async () => {
  addCard('APP-1');
  git('config', 'commit.gpgsign', 'true');
  git('config', 'gpg.program', join(project, 'no-such-gpg'));
  const head = git('rev-parse', 'HEAD').trim();

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(readRun(live.db, runId)?.failureReason).toMatch(/gpg|sign/i);
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  expect(knowledgeChangesOfRun(live.db, runId)).toEqual([]);
});

// The other direction: the commit is made and the rows cannot be written. A commit no row names is
// invisible to the Knowledge screen, so nobody could read it or revert it.
it('takes the commit back when the rows cannot be written', async () => {
  addCard('APP-1');
  const head = git('rev-parse', 'HEAD').trim();
  // The row write alone, and the reading the start does still works.
  live.db.exec("CREATE TRIGGER no_rows BEFORE INSERT ON knowledge_changes BEGIN SELECT RAISE(ABORT, 'the row write failed'); END");

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(readRun(live.db, runId)?.failureReason).toContain('the row write failed');
  expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  // What the run wrote is still on disk, so nothing it did is lost.
  expect(existsSync(join(knowledgeDir(), 'browser-filtering.md'))).toBe(true);
});

// One knowledge-writing run at a time, because they all commit into the same repository. A job
// waiting for the lane must not hold up work that has nothing to do with knowledge.
it('runs one wrap-up at a time and lets unrelated work past', async () => {
  for (const key of ['APP-1', 'APP-2']) addCard(key);
  addCard('APP-3', 'inbox');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'wrapup') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.start('APP-1', 'wrapup');
  const first = lastRun();
  live.start('APP-2', 'wrapup');
  const second = lastRun();
  live.start('APP-3', 'refine');
  const unrelated = lastRun();

  expect(live.scheduler.queue().running.map((job) => job.runId)).toEqual([first, unrelated]);
  // The second wrap-up waits outside the queue until the first has left it, so it is built on what
  // the first wrote.
  expect(readRun(live.db, second)?.state).toBe('waiting_review');
  await vi.waitFor(() => expect(readRun(live.db, unrelated)?.state).toBe('complete'), WAIT);

  release();
  const wrapupOf = (key: string) => (live.db.prepare("SELECT state FROM runs WHERE card_key = ? AND phase = 'wrapup' ORDER BY id DESC LIMIT 1").get(key) as { state: string } | undefined)?.state;
  await vi.waitFor(() => expect(wrapupOf('APP-2')).toBe('complete'), WAIT);
  expect(readRun(live.db, first)?.state).toBe('complete');
});

// Review on: the first wrap-up's change waits for review when it ends, so the second, which waited
// behind it, stays waiting until the person answers, and then runs on the answered folder.
it('keeps a wrap-up waiting behind one whose change waits for review, until the answer', async () => {
  for (const key of ['APP-1', 'APP-2']) addCard(key);
  writeSetting(live.db, 'reviewKnowledge', true);
  live.start('APP-1', 'wrapup');
  const first = lastRun();
  live.start('APP-2', 'wrapup');
  const second = lastRun();
  expect(readRun(live.db, second)?.state).toBe('waiting_review');
  // Nothing waits for the person yet, so the board reads a wait for the Knowledge lane.
  const shown = () => live.snapshot().cards.find((card) => card.key === 'APP-2');
  expect(shown()).toMatchObject({ runState: 'waiting_lane', lane: 'knowledge' });
  // Now lists it with the runs, as a wait for the Knowledge lane, and its trail says the same.
  const listed = () => nowSnapshot(live).running.find((row) => row.runId === second);
  expect(listed()).toMatchObject({ key: 'APP-2', state: 'queued', runState: 'waiting_lane', lane: 'knowledge', position: null });
  const trailOf = () => overviewFor(live.db, 'APP-2')?.strip.find((segment) => segment.phase === 'wrapup')?.run?.state;
  expect(trailOf()).toBe('waiting_lane');
  const peeked = async () => (await peekFor(live.db, 'APP-2', () => []))?.trail.find((segment) => segment.phase === 'wrapup')?.run?.state;
  expect(await peeked()).toBe('waiting_lane');

  await vi.waitFor(() => expect(readRun(live.db, first)?.state).toBe('complete'), WAIT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(knowledgeChangesOfRun(live.db, first).map((row) => row.status)).toEqual(['pending']);
  expect(readRun(live.db, second)?.state).toBe('waiting_review');
  // Now a change waits for the person, and the waiting card is theirs.
  expect(shown()?.runState).toBe('waiting_review');
  expect(listed()).toBeUndefined();
  expect(trailOf()).toBe('waiting_review');

  returnKnowledge(live.db, { dataDir: dir, runId: first, note: 'Not this one.' });
  live.reviewAnswered();
  const wrapupOf = (key: string) => (live.db.prepare("SELECT state FROM runs WHERE card_key = ? AND phase = 'wrapup' ORDER BY id DESC LIMIT 1").get(key) as { state: string } | undefined)?.state;
  await vi.waitFor(() => expect(wrapupOf('APP-2')).toBe('complete'), WAIT);
});

// A chain that runs while Nolzu stops would make a wait the stop has already ended.
it('makes no new wait once Nolzu is stopping', async () => {
  addCard('APP-1');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: lastRun(), commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });

  const stopping = live.shutdown();
  expect(live.start('APP-1', 'wrapup')).toBe(false);
  await stopping;

  expect(readRun(live.db, lastRun())?.failureReason).toMatch(/^Nolzu is stopping, so Wrap-up of APP-1 did not start\./);
  expect(live.db.prepare("SELECT count(*) AS n FROM runs WHERE state = 'waiting_review'").get()).toEqual({ n: 0 });
});

// A waiting card whose start fails writes its reason on its card, and the next waiting card starts.
it('starts the next waiting card when the one before it cannot start', async () => {
  for (const key of ['APP-1', 'APP-2']) addCard(key);
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-9', 'wrapup', 'fake', '')").run();
  const earlier = lastRun();
  recordKnowledgeChanges(live.db, { cardKey: 'APP-9', runId: earlier, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/importer.md', summary: 'added' }] });
  live.start('APP-1', 'wrapup');
  live.start('APP-2', 'wrapup');
  // APP-1's login goes while it waits.
  setCardModels(live.db, 'APP-1', { wrapup: { engine: 'codex#gone' } });

  returnKnowledge(live.db, { dataDir: dir, runId: earlier, note: 'Not this one.' });
  live.reviewAnswered();

  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('failed');
  const wrapupOf = (key: string) => (live.db.prepare("SELECT state FROM runs WHERE card_key = ? AND phase = 'wrapup' ORDER BY id DESC LIMIT 1").get(key) as { state: string } | undefined)?.state;
  await vi.waitFor(() => expect(wrapupOf('APP-2')).toBe('complete'), WAIT);
});

// The review setting, both ways. Off is what every test above runs: the run's files are committed
// as they were written. On, the person's knowledge files never carry content nobody approved.
describe('the review setting', () => {
  const KNOWLEDGE = '.nolzu/knowledge/browser-filtering.md';
  const file = () => join(knowledgeDir(), 'browser-filtering.md');
  const env = { ...process.env, ...CLEAN };
  const approve = (runId: number, busy: string | null = null) => approveKnowledge(live.db, { dataDir: dir, runId, busy, env });
  const sendBack = (runId: number, note: string) => returnKnowledge(live.db, { dataDir: dir, runId, note });

  it('commits what the run wrote while it is off, which is the default', async () => {
    addCard('APP-1');

    const runId = await runToEnd('APP-1');

    expect(readFileSync(file(), 'utf8')).toContain('filtered in the browser');
    expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: APP-1 run ${runId}`);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['applied']);
  });

  it('leaves the folder as it was while it is on, and writes one pending row per file', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const head = git('rev-parse', 'HEAD').trim();

    const runId = await runToEnd('APP-1');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(existsSync(file())).toBe(false);
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(git('status', '--porcelain', '-uall').trim()).toBe('');
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => [row.filePath, row.status, row.commitSha])).toEqual([[KNOWLEDGE, 'pending', null]]);
  });

  it('writes the file and the commit when the person approves', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');

    const answer = await approve(runId);

    expect(answer.ok).toBe(true);
    expect(readFileSync(file(), 'utf8')).toContain('filtered in the browser');
    // The same message an applied run makes, because the person approved that run's work.
    expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: APP-1 run ${runId}`);
    expect(git('status', '--porcelain', '-uall').trim()).toBe('');
    const head = git('rev-parse', 'HEAD').trim();
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => [row.status, row.commitSha])).toEqual([['applied', head]]);
    expect(answer.message).toContain(head.slice(0, 7));
    // The kept copy is gone, because the folder holds the change now.
    expect(existsSync(heldPath(dir, runId))).toBe(false);
  });

  // Apply all takes the runs the screen named, oldest first, and stops at the first refusal with how
  // many went in before it.
  it('applies every run Apply all names, and stops at the first refusal', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const first = await runToEnd('APP-1');
    // A second waiting change with no kept copy, so its Apply refuses. A real second run would wait,
    // since no knowledge run starts while a change waits for a person.
    const second = startRun(live.db, { cardKey: 'APP-2', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
    recordKnowledgeChanges(live.db, { cardKey: 'APP-2', runId: second, commitSha: null, status: 'pending', files: [{ path: KNOWLEDGE, summary: 'added' }] });
    const form = new FormData();
    for (const run of [second, first]) form.append('run', String(run));
    const post = { dataDir: dir, snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: null }] }) };

    const answer = await answerApproveAll(live.db, post, form, env);

    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(/^Applied 1 of 2 changes, then stopped\. The kept copy of this change is gone/);
    expect(knowledgeChangesOfRun(live.db, first).map((row) => row.status)).toEqual(['applied']);
    expect(knowledgeChangesOfRun(live.db, second).map((row) => row.status)).toEqual(['pending']);
    expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: APP-1 run ${first}`);
  });

  it('leaves the file alone when the person returns the change, and keeps the note', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');
    const head = git('rev-parse', 'HEAD').trim();

    const answer = sendBack(runId, 'Name the endpoint, not the file.');

    expect(answer.ok).toBe(true);
    expect(existsSync(file())).toBe(false);
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => [row.status, row.note])).toEqual([['returned', 'Name the endpoint, not the file.']]);
    expect(existsSync(heldPath(dir, runId))).toBe(false);
  });

  // A return nobody ever reads is the same as a silent delete.
  it('reads the note in the prompt of the next wrap-up of that card', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    sendBack(await runToEnd('APP-1'), 'Name the endpoint, not the file.');
    const prompts: string[] = [];
    const real = live.engine.spawn;
    live.engine.spawn = function (job: Job, signal: AbortSignal) {
      prompts.push(job.prompt);
      return real(job, signal);
    };

    await runToEnd('APP-1');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Name the endpoint, not the file.');
    expect(prompts[0]).toContain('The last knowledge change of this card was returned');
  });

  // The kept copy is the only place the change lives once the folder is back to what it was.
  // Approving with nothing to apply has to say so, and leave the change where a person can return it.
  it('refuses an approve whose kept copy is gone, and commits nothing', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');
    const head = git('rev-parse', 'HEAD').trim();
    rmSync(heldPath(dir, runId));

    const answer = await approve(runId);

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('kept copy');
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
  });

  it('refuses a second approve of the same change, and names the commit it already made', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');
    await approve(runId);
    const head = git('rev-parse', 'HEAD').trim();

    const answer = await approve(runId);

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('applied already');
    expect(answer.message).toContain(head.slice(0, 7));
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  });

  it('refuses a return of a change that was applied already', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');
    await approve(runId);

    const answer = sendBack(runId, 'Too long.');

    expect(answer.ok).toBe(false);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['applied']);
  });

  // The note is the whole point of a return, so a return without one is refused rather than
  // stored as a change nobody can learn from.
  it('refuses a return with no note', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');

    const answer = sendBack(runId, '   ');

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('reads the note');
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
    expect(returnedKnowledgeNote(live.db, 'APP-1')).toBeNull();
  });

  // With review on, a folder waiting for a person is the normal state, so the next wrap-up waits for
  // the approve and then runs on the folder the approve wrote.
  it('waits for the approve of an earlier change, then runs', async () => {
    addCard('APP-1');
    addCard('APP-2');
    writeSetting(live.db, 'reviewKnowledge', true);
    const first = await runToEnd('APP-1');

    expect(live.start('APP-2', 'wrapup')).toBe(true);
    expect(readRun(live.db, lastRun())?.state).toBe('waiting_review');

    expect((await approve(first)).ok).toBe(true);
    live.reviewAnswered();

    const second = lastRun();
    await vi.waitFor(() => expect(readRun(live.db, second)?.state).toBe('complete'), WAIT);
    expect(readRun(live.db, second)?.cardKey).toBe('APP-2');
  });

  // A run writing the folder and a commit in the same folder would fight over the index.
  it('refuses an approve while a run is writing the folder', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'reviewKnowledge', true);
    const runId = await runToEnd('APP-1');
    const head = git('rev-parse', 'HEAD').trim();

    const answer = await approve(runId, 'APP-2');

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('APP-2');
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
  });
});

// A team project's knowledge belongs to the team. This machine writes nothing into the knowledge
// files and sends the diff up the team socket, so the team reads one proposal per run and decides.
describe('a team project', () => {
  const KNOWLEDGE = '.nolzu/knowledge/browser-filtering.md';
  const file = () => join(knowledgeDir(), 'browser-filtering.md');
  type Frame = { type: RunnerMessageType; payload: unknown };

  // The loop again, with a stub in place of the team socket, and the frames the run handed it. No
  // test opens a socket, and `answers` is what that socket says about the frame it took.
  const withWire = (answers: boolean): Frame[] => {
    const sent: Frame[] = [];
    live.close();
    openLoop({
      sendTeam: (type, payload) => {
        sent.push({ type, payload });
        return answers;
      },
    });
    return sent;
  };

  // The id a `project.join` job writes. Holding it is what makes this machine a team machine.
  const joinTeam = (answers = true): Frame[] => {
    const sent = withWire(answers);
    writeSetting(live.db, 'teamProjectId', 'team-project-1');
    return sent;
  };

  it('writes nothing into the knowledge folder and keeps the change on this machine', async () => {
    joinTeam();
    addCard('APP-1');
    const head = git('rev-parse', 'HEAD').trim();

    const runId = await runToEnd('APP-1');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(existsSync(file())).toBe(false);
    expect(git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(git('status', '--porcelain', '-uall').trim()).toBe('');
    expect(existsSync(heldPath(dir, runId))).toBe(true);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => [row.filePath, row.status, row.commitSha])).toEqual([[KNOWLEDGE, 'pending', null]]);
  });

  it('sends the patch of every file the run wrote, and not what the files hold', async () => {
    const sent = joinTeam();
    addCard('APP-1');

    const runId = await runToEnd('APP-1');

    expect(sent.map((frame) => frame.type)).toEqual(['knowledge.proposals']);
    // Read back through the hub's own reader, so a field this machine names wrongly fails here and
    // not on the hub.
    const proposal = readKnowledgeProposal(sent[0]?.payload);
    expect(proposal).toMatchObject({ teamProjectId: 'team-project-1', cardKey: 'APP-1', runId });
    // The file as the knowledge folder holds it, not as the repository root sees it.
    expect(proposal.files.map((one) => one.path)).toEqual(['browser-filtering.md']);
    const diff = proposal.files[0]?.diff ?? '';
    expect(diff.startsWith('diff --git a/browser-filtering.md b/browser-filtering.md')).toBe(true);
    expect(diff).toContain('new file mode');
    // What the run wrote arrives as an added line of a patch, and nothing beside it carries the
    // file. A payload with the contents in it would have a field more.
    expect(diff).toContain('+The recipe list is filtered in the browser');
    expect(Object.keys((sent[0]?.payload as { files: Record<string, unknown>[] }).files[0] ?? {}).sort()).toEqual(['diff', 'path']);
  });

  it('commits as before on a project that has joined no team, and sends nothing', async () => {
    const sent = withWire(true);
    addCard('APP-1');

    const runId = await runToEnd('APP-1');

    expect(sent).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toContain('filtered in the browser');
    expect(git('log', '-1', '--pretty=%s').trim()).toBe(`knowledge: APP-1 run ${runId}`);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['applied']);
  });

  // A frame that did not go is not a change that is gone. It waits on this machine, and the line
  // says so, because nothing here asks the hub for it again.
  it('keeps the change on this machine when the team socket is not open', async () => {
    const sent = joinTeam(false);
    addCard('APP-1');
    const spoke = vi.spyOn(console, 'error').mockImplementation(() => {});

    const runId = await runToEnd('APP-1');
    const lines = spoke.mock.calls.flat().join(' ');
    spoke.mockRestore();

    expect(sent.map((frame) => frame.type)).toEqual(['knowledge.proposals']);
    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(existsSync(heldPath(dir, runId))).toBe(true);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
    expect(lines).toContain(`The knowledge change of APP-1 run ${runId} did not reach the team`);
  });

  // The way back: the team approved the proposal and the hub sends `knowledge.commit`. The job goes
  // through the same Approve the Knowledge screen uses, so the commit is the one a person would make.
  describe('the approved proposal', () => {
    const commit = (runId: number, job = 1, teamProjectId = 'team-project-1', cardKey = 'APP-1', mark: 'hubJobDone' | 'teamHubJobDone' = 'teamHubJobDone') =>
      takeHubJob(live, hubEnvelope('knowledge.commit', job, { teamProjectId, cardKey, runId }), () => true, mark);
    const commits = () => Number(git('rev-list', '--count', 'HEAD').trim());

    // The commit runs git with this process's environment, the way a click on Approve does.
    beforeEach(() => {
      for (const [name, value] of Object.entries(CLEAN)) vi.stubEnv(name, value);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('commits a proposal approved while the runner was offline, once the runner is back', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');
      // Offline: the loop is gone while the team approves, and the job waits in the hub's queue.
      live.close();
      openLoop();

      await commit(runId);

      expect(readFileSync(file(), 'utf8')).toContain('filtered in the browser');
      const sha = git('rev-parse', 'HEAD').trim();
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => [row.cardKey, row.status, row.commitSha])).toEqual([['APP-1', 'applied', sha]]);
      expect(existsSync(heldPath(dir, runId))).toBe(false);
      expect(getSetting(live.db, 'teamHubJobDone')).toBe(1);
    });

    // The mark stops a redelivered job at the door. This is the case it misses: a crash after the
    // commit and before the mark moved, so the job runs again and meets rows already applied.
    it('commits once when the same job runs twice', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');

      await commit(runId);
      const after = commits();
      writeSetting(live.db, 'teamHubJobDone', 0);
      await commit(runId);

      expect(commits()).toBe(after);
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['applied']);
      expect(getSetting(live.db, 'teamHubJobDone')).toBe(1);
    });

    it('refuses a run whose kept change is gone with a sentence naming the run, and commits nothing', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');
      const head = git('rev-parse', 'HEAD').trim();
      rmSync(heldPath(dir, runId));

      await expect(commit(runId)).rejects.toThrow(`run ${runId}`);

      expect(git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
      expect(getSetting(live.db, 'teamHubJobDone')).toBe(0);
    });

    it('writes the commit message a personal approve writes', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');

      await commit(runId);

      expect(git('log', '-1', '--pretty=%s').trim()).toBe(knowledgeCommitMessage('APP-1', runId));
    });

    // A run id is a counter in this machine's own database, so a job for another team project names a
    // run of the same number that has nothing to do with it.
    it('commits nothing for another team project', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');
      const head = git('rev-parse', 'HEAD').trim();

      await expect(commit(runId, 1, 'team-project-2')).rejects.toThrow('another team project');

      expect(git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
    });

    // The same run number on this machine can belong to another card, and the sentence repeats
    // nothing the hub sent.
    it('commits nothing for a run that belongs to another card here', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');
      const head = git('rev-parse', 'HEAD').trim();

      const refused = commit(runId, 1, 'team-project-1', 'APP-9\nforged line');
      await expect(refused).rejects.toThrow('belongs to another card');
      await expect(refused).rejects.not.toThrow('forged');

      expect(git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
    });

    it('commits nothing for a job that came from the personal hub', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');
      const head = git('rev-parse', 'HEAD').trim();

      await expect(commit(runId, 1, 'team-project-1', 'APP-1', 'hubJobDone')).rejects.toThrow('only the team hub');

      expect(git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
    });

    // A run with no rows is not a job done twice, and the sentence repeats nothing the hub sent.
    it('refuses a run that has no knowledge change here', async () => {
      joinTeam();

      const refused = commit(999, 1, 'team-project-1', 'APP-9\nforged line');
      await expect(refused).rejects.toThrow('run 999');
      await expect(refused).rejects.not.toThrow('forged');

      expect(getSetting(live.db, 'teamHubJobDone')).toBe(0);
    });

    // The same rule as the Approve button: a run writing the knowledge folder blocks the commit.
    it('commits nothing while another run holds the knowledge lane', async () => {
      joinTeam();
      addCard('APP-1');
      const runId = await runToEnd('APP-1');
      const head = git('rev-parse', 'HEAD').trim();
      vi.spyOn(live, 'snapshot').mockReturnValue({ ...live.snapshot(), lanes: [{ name: 'knowledge', heldBy: 'APP-2' }] } as never);

      await expect(commit(runId)).rejects.toThrow('APP-2 is writing the knowledge folder');

      expect(git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
    });
  });
});

// A wrap-up of the card on Wrap-up closes it by itself. One that left a knowledge change waiting for
// review stays where it ran, ready, so Now still lists it and the person finds the change.
describe('the chain to Closed', () => {
  const card = () => live.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get('APP-1');

  it('moves the card to Closed, idle, with an auto row on its timeline', async () => {
    addCard('APP-1', 'wrapup');

    await runToEnd('APP-1');

    await vi.waitFor(() => expect(card()).toEqual({ stage: 'closed', state: 'idle' }), WAIT);
    expect(live.db.prepare('SELECT from_stage, to_stage, who, started_phase FROM card_events WHERE card_key = ?').all('APP-1')).toEqual([
      { from_stage: 'wrapup', to_stage: 'closed', who: 'auto', started_phase: null },
    ]);
  });

  it('keeps the card on Wrap-up while its knowledge change waits for review', async () => {
    addCard('APP-1', 'wrapup');
    writeSetting(live.db, 'reviewKnowledge', true);

    const runId = await runToEnd('APP-1');

    await vi.waitFor(() => expect(card()).toEqual({ stage: 'wrapup', state: 'ready' }), WAIT);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['pending']);
  });

  // The other half: problems the output check found, which the board leaves off a closed card. The run
  // here leaves out the changes file its skill promises, and the check says so.
  it('keeps the card on Wrap-up when the output check found problems', async () => {
    addCard('APP-1', 'wrapup');
    const replay = live.engine.spawn.bind(live.engine);
    live.engine.spawn = async function* (job: Job, signal: AbortSignal) {
      yield* replay(job, signal);
      if (job.phase === 'wrapup') rmSync(join(job.taskDir, 'wrapup', 'changes.md'), { force: true });
    };

    const runId = await runToEnd('APP-1');

    await vi.waitFor(() => expect(card()).toEqual({ stage: 'wrapup', state: 'ready' }), WAIT);
    expect(outputCheckOf(live.db, runId)?.problems.length).toBeGreaterThan(0);
    expect(knowledgeChangesOfRun(live.db, runId).map((row) => row.status)).toEqual(['applied']);
  });
});
