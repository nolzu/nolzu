import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@nolzu/core';
import { allCardMoves, cardStack, moveCard, readRun, writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evidenceFor } from './evidence.ts';
import { createLoop, type Loop } from './loop.ts';
import { pressStack } from './stack-action.ts';

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-qa-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-qa-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', project);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage = 'qa') =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);

const lastRun = (): number => (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;

const card = (key: string) => live.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };

async function runToEnd(key: string, phase: 'qa' | 'refine' = 'qa'): Promise<number> {
  live.start(key, phase);
  const runId = lastRun();
  // Real shells and a real git compare, so the window is the machine's: 15 seconds, inside the
  // 20 second test timeout, where a fixed count of 10 ms sleeps ran out on a busy suite.
  await vi.waitFor(
    () => {
      const state = readRun(live.db, runId)?.state;
      // Out of the queue too: the summary pass and its git compare still hold the slot.
      if (!(state === 'complete' || state === 'failed' || state === 'stopped') || live.scheduler.queue().running.some((job) => job.runId === runId)) throw new Error('the QA run did not end');
    },
    { timeout: 15_000, interval: 10 },
  );
  return runId;
}

// A run that says what the test needs it to say, in the shape the engine's parser reads.
const says = (text: string) =>
  async function* () {
    yield JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'qa-session-1',
      model: 'sonnet',
      cwd: '/workspace',
      tools: ['Read', 'Bash'],
    });
    yield JSON.stringify({
      type: 'assistant',
      session_id: 'qa-session-1',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, duration_ms: 20, usage: {} });
  };

// Own commands under `*`, which run once per card in its checkout root, as the stack hook they replace
// did. They write into a file outside the checkout, so the order they wrote in is the proof and nothing
// has to be read out of a call.
const own = (start: string, stop: string | null = null) => writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start, stop, status: null } });
const trail = () => join(dir, 'stack-trail.txt');
const wrote = (): string[] => (existsSync(trail()) ? readFileSync(trail(), 'utf8').trim().split('\n') : []);

// Every wait below watches a run that spawns a real shell, so the window is the machine's and not
// the product's. vitest waits one second by default, and a full suite run on a busy machine takes
// longer than that to write the first row, which failed this file once with the run itself correct.
const WAIT = { timeout: 10_000 };

it('chains the card forward when QA passes', async () => {
  addCard('APP-1');

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.verdict).toBe('PASS');
  expect(card('APP-1')).toEqual({ stage: 'review', state: 'ready' });
});

// The move a PASS makes on its own is on the timeline the way a dragged move is, one row each.
it('writes one timeline row for the move by hand and one for the move a PASS makes', async () => {
  addCard('APP-1', 'implement');

  await moveCard(live.db, live.boardOf('APP-1'), 'APP-1', 'qa', (key, phase) => {
    live.start(key, phase);
  });
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'review', state: 'ready' }), WAIT);

  expect(allCardMoves(live.db).map(({ fromStage, toStage, who, startedPhase }) => ({ fromStage, toStage, who, startedPhase }))).toEqual([
    { fromStage: 'implement', toStage: 'qa', who: 'you', startedPhase: 'qa' },
    { fromStage: 'qa', toStage: 'review', who: 'auto', startedPhase: null },
  ]);
  // Both rows on one pinned day, so a run that crosses midnight UTC still reads both.
  live.db.exec("UPDATE card_events SET at = '2026-03-04T10:00:00.000Z'");
  const { blocks } = await evidenceFor(live.db, { day: '2026-03-04' });
  expect(blocks.filter((block) => block.source === 'move').map((block) => block.description)).toEqual([
    'Moved from Implement to QA',
    'Moved from QA to Review',
  ]);
});

// APP-1 stands by, so a row or a move that lands on the wrong card shows. The move by hand opens a
// write of its own, and that fails while the PASS left its write open.
it('writes the automatic row on the card that passed, and a move by hand after it still lands', async () => {
  addCard('APP-1', 'implement');
  addCard('APP-2');

  await runToEnd('APP-2');
  await vi.waitFor(() => expect(card('APP-2')).toEqual({ stage: 'review', state: 'ready' }), WAIT);
  await moveCard(live.db, live.boardOf('APP-2'), 'APP-2', 'implement', vi.fn());

  expect(card('APP-1')).toEqual({ stage: 'implement', state: 'idle' });
  expect(allCardMoves(live.db).map(({ cardKey, fromStage, toStage, who }) => ({ cardKey, fromStage, toStage, who }))).toEqual([
    { cardKey: 'APP-2', fromStage: 'qa', toStage: 'review', who: 'auto' },
    { cardKey: 'APP-2', fromStage: 'review', toStage: 'implement', who: 'you' },
  ]);
});

// Implement names no next stage, so a PASS there moves nothing: the card lands ready where it ran, and
// the timeline gets no row.
it('lands a PASS ready on a stage that names no next one, with no timeline row', async () => {
  addCard('APP-1', 'implement');

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.verdict).toBe('PASS');
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'implement', state: 'ready' }), WAIT);
  expect(allCardMoves(live.db)).toEqual([]);
});

// A failing verdict leaves the card where a person finds it, with the sentence QA wrote.
it('leaves a failed card ready on the QA stage, with the reason', async () => {
  addCard('APP-1');
  live.engine.spawn = says('NOLZU: verdict: FAIL An empty search shows no recipes.\n\nNOLZU: complete');

  const runId = await runToEnd('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'ready' });
  expect(readRun(live.db, runId)?.verdict).toBe('FAIL');
  expect(readRun(live.db, runId)?.verdictReason).toBe('An empty search shows no recipes.');
  // The card did not move, so the timeline has no row for it.
  expect(allCardMoves(live.db)).toEqual([]);
});

// BLOCKED is a question for a person. The card is what proves it: it blocks, and the question a
// person reads is the reason QA gave.
it('blocks the card on a BLOCKED verdict and shows its reason as the question', async () => {
  addCard('APP-1');
  live.engine.spawn = says('NOLZU: verdict: BLOCKED The API service is not reachable on port 3001.\n\nNOLZU: complete');

  const runId = await runToEnd('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'blocked' });
  expect(readRun(live.db, runId)?.question).toBe('The API service is not reachable on port 3001.');
  expect(readRun(live.db, runId)?.verdict).toBe('BLOCKED');
});

// The answer composer is the path a blocked card already has, and it resumes the QA session.
it('carries the answer to a blocked QA run back into the same session', async () => {
  addCard('APP-1');
  live.engine.spawn = says('NOLZU: verdict: BLOCKED The API service is not reachable on port 3001.\n\nNOLZU: complete');
  const blocked = await runToEnd('APP-1');

  expect(live.answer('APP-1', 'The API runs on port 3002 now.')).toBe(true);

  const next = readRun(live.db, lastRun());
  expect(next?.phase).toBe('qa');
  expect(next?.sessionId).toBe(readRun(live.db, blocked)?.sessionId);
});

// A run that printed no verdict decided nothing, and reading that as a pass would move a card
// nobody checked.
it('does not chain a run that printed no verdict, and says so', async () => {
  addCard('APP-1');
  live.engine.spawn = says('I read the brief and ran out of things I could check.\n\nNOLZU: complete');

  const runId = await runToEnd('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'ready' });
  expect(readRun(live.db, runId)?.verdict).toBeNull();
  expect(readRun(live.db, runId)?.verdictReason).toContain('no verdict');
});

// The whole point of own commands: the app is up while QA runs, and down after it. Proved by what
// the commands themselves wrote, in the order they ran.
it('loads the stack before the run and unloads it after', async () => {
  addCard('APP-1');
  own(`echo "load {key}" >> ${trail()}`, `echo "unload {key}" >> ${trail()}`);
  const real = live.engine.spawn;
  live.engine.spawn = function (job: Job, signal: AbortSignal) {
    execFileSync('sh', ['-c', `echo "run ${job.cardKey}" >> ${trail()}`]);
    return real(job, signal);
  };

  const runId = await runToEnd('APP-1');

  expect(wrote()).toEqual(['load APP-1', 'run APP-1', 'unload APP-1']);
  expect(readRun(live.db, runId)?.stackState).toBe('off');
});

// Both sides of the run get the card and its repositories, so a script for several repositories
// can find each checkout under the folder it runs in.
it('hands the load and the unload the card key and its repositories', async () => {
  addCard('APP-1');
  own(`echo "load $NOLZU_CARD_KEY $NOLZU_REPOS $NOLZU_PROJECT" >> ${trail()}`, `echo "unload $NOLZU_CARD_KEY $NOLZU_REPOS" >> ${trail()}`);

  await runToEnd('APP-1');

  expect(wrote()).toEqual([`load APP-1 . ${project}`, 'unload APP-1 .']);
});

const addressFile = () => join(project, '.tasks', 'APP-1', 'qa', 'addresses.md');

// The addresses come last on purpose, after the noise a real start prints.
it('writes the addresses a load printed to the card folder for QA', async () => {
  addCard('APP-1');
  own("echo 'Container recipes-db-1  Started'; echo 'web http://localhost:8080'; echo 'api http://localhost:8787'");

  await runToEnd('APP-1');

  expect(readFileSync(addressFile(), 'utf8')).toBe('web http://localhost:8080\napi http://localhost:8787\n');
});

const startFile = () => join(project, '.tasks', 'APP-1', 'qa', 'app-start.md');

// A load that worked can still say a part of the app runs other code than the card's. Dropped, QA
// judges that code and fails the card for a change it never saw.
it('keeps what a load printed besides its addresses, in the run log and for QA', async () => {
  addCard('APP-1');
  own("echo 'web is built into its image, so it still runs the old code.' >&2; echo 'web http://localhost:8080'");

  const runId = await runToEnd('APP-1');

  const note = "```\nweb is built into its image, so it still runs the old code.\n```";
  expect(readFileSync(startFile(), 'utf8')).toContain(note);
  expect(readFileSync(addressFile(), 'utf8')).toBe('web http://localhost:8080\n');
  const logged = readFileSync(readRun(live.db, runId)?.logPath ?? '', 'utf8');
  expect(logged).toContain(JSON.stringify(note).slice(1, -1));
});

it('removes an old start note when a load prints only its addresses', async () => {
  addCard('APP-1');
  mkdirSync(join(project, '.tasks', 'APP-1', 'qa'), { recursive: true });
  writeFileSync(startFile(), 'old\n');
  own("echo 'web http://localhost:8080'");

  await runToEnd('APP-1');

  expect(existsSync(startFile())).toBe(false);
});

// A file an earlier load left would point QA at addresses this load never printed.
it('removes old addresses when a load prints none', async () => {
  addCard('APP-1');
  mkdirSync(join(project, '.tasks', 'APP-1', 'qa'), { recursive: true });
  writeFileSync(addressFile(), 'web http://localhost:9999\n');
  own('echo started');

  await runToEnd('APP-1');

  expect(existsSync(addressFile())).toBe(false);
});

// A second card with one address, so a key fixed to the first card, on the hook or on the card
// folder, shows, and so does a write that needs more than one line.
it('hands a second card its own key and writes its one address to its own folder', async () => {
  addCard('APP-2');
  own(`echo "load $NOLZU_CARD_KEY" >> ${trail()}; echo 'web http://localhost:8080'`, `echo "unload $NOLZU_CARD_KEY" >> ${trail()}`);

  await runToEnd('APP-2');

  expect(wrote()).toEqual(['load APP-2', 'unload APP-2']);
  expect(readFileSync(join(project, '.tasks', 'APP-2', 'qa', 'addresses.md'), 'utf8')).toBe('web http://localhost:8080\n');
});

it('removes old addresses when the load fails', async () => {
  addCard('APP-1');
  mkdirSync(join(project, '.tasks', 'APP-1', 'qa'), { recursive: true });
  writeFileSync(addressFile(), 'web http://localhost:9999\n');
  own("echo 'web http://localhost:8080'; exit 3");

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(existsSync(addressFile())).toBe(false);
});

// The qa skill moves each screenshot into qa/evidence/, and a move into a missing folder fails.
it('makes the evidence folder before QA starts', async () => {
  addCard('APP-1');

  await runToEnd('APP-1');

  expect(existsSync(join(project, '.tasks', 'APP-1', 'qa', 'evidence'))).toBe(true);
});

it('runs QA without an app when the project has no answer', async () => {
  addCard('APP-1');

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('complete');
  // Off, and not failed: a project with no answer is a normal project, and QA runs the checks that
  // need no app.
  expect(readRun(live.db, runId)?.stackState).toBe('off');
});

// A verdict from a stack that never came up is worth nothing, so the run stops before the engine
// and carries the command's own words.
it('stops the run before the engine when the stack will not load', async () => {
  addCard('APP-1');
  own('echo "no compose file for APP-1" >&2; exit 3');
  let started = false;
  const real = live.engine.spawn;
  live.engine.spawn = function (job: Job, signal: AbortSignal) {
    started = true;
    return real(job, signal);
  };

  const runId = await runToEnd('APP-1');

  expect(started).toBe(false);
  expect(readRun(live.db, runId)?.state).toBe('failed');
  expect(readRun(live.db, runId)?.failureReason).toContain('exited 3');
  expect(readRun(live.db, runId)?.failureReason).toContain('no compose file for APP-1');
  expect(readRun(live.db, runId)?.stackState).toBe('failed');
  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'failed' });
});

// A load that dies halfway prints its progress and the dead container's log. The run kept one line of
// it and left the stack half loaded; now all of it goes in the run's log, and the Stop runs.
it('keeps what a failed start printed in the run log, and runs its Stop after it', async () => {
  addCard('APP-1');
  own(`echo "Recreating 7 more containers"; echo "npm error code ENOTEMPTY" >&2; echo "worker is restarting (1)" >&2; exit 1`, `echo "stop $NOLZU_CARD_KEY" >> "${trail()}"`);

  const runId = await runToEnd('APP-1');

  const run = readRun(live.db, runId);
  expect(run?.state).toBe('failed');
  expect(run?.failureReason).toContain('exited 1 before the app answered. worker is restarting (1)');
  const logged = readFileSync(run?.logPath ?? '', 'utf8');
  expect(logged).toContain('printed before it failed');
  for (const line of ['Recreating 7 more containers', 'npm error code ENOTEMPTY']) expect(logged).toContain(line);
  expect(wrote()).toEqual(['stop APP-1']);
  // The run keeps that its start failed; the card's row says the stack is off now, and why.
  expect(run?.stackState).toBe('failed');
  expect(cardStack(live.db, 'APP-1')).toMatchObject({ state: 'off' });
  expect(cardStack(live.db, 'APP-1')?.reason).toContain('did not start the app. The app\'s start command exited 1');
  expect(cardStack(live.db, 'APP-1')?.reason).toContain('Nolzu ran the Stop command after it.');
});

// The QA run is over by then and its verdict stands. What is left to say is that the stack is
// still running.
it('keeps a finished verdict when the unload fails, and says the stack is still up', async () => {
  addCard('APP-1');
  own('true', 'echo "no such container" >&2; exit 1');

  const runId = await runToEnd('APP-1');

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(readRun(live.db, runId)?.verdict).toBe('PASS');
  expect(card('APP-1').stage).toBe('review');
  expect(readRun(live.db, runId)?.stackState).toBe('up');
  expect(readRun(live.db, runId)?.stackReason).toContain('still up');
});

// One QA run at a time, because they all load the same local stack. A job waiting for the lane
// must not hold up work that has nothing to do with the stack.
it('runs one QA at a time and lets unrelated work past', async () => {
  for (const key of ['APP-1', 'APP-2']) addCard(key);
  addCard('APP-3', 'inbox');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'qa') await held;
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };

  live.start('APP-1', 'qa');
  const first = lastRun();
  live.start('APP-2', 'qa');
  const second = lastRun();
  live.start('APP-3', 'refine');
  const unrelated = lastRun();

  expect(live.scheduler.queue().running.map((job) => job.runId)).toEqual([first, unrelated]);
  expect(waitFor(live.scheduler.queue(), second)).toEqual({ reason: 'lane', position: 1 });
  await vi.waitFor(() => expect(readRun(live.db, unrelated)?.state).toBe('complete'), WAIT);

  release();
  await vi.waitFor(() => expect(readRun(live.db, second)?.state).toBe('complete'), { timeout: 5000 });
});

// Stop is optional, so a start with no Stop leaves what it started running. The run row says so.
it('says the stack is still up when the project set no unload command', async () => {
  addCard('APP-1');
  own(`echo "load {key}" >> ${trail()}`);

  const runId = await runToEnd('APP-1');

  expect(wrote()).toEqual(['load APP-1']);
  expect(readRun(live.db, runId)?.stackState).toBe('up');
  expect(readRun(live.db, runId)?.stackReason).toContain('still up');
});

// The skill may print the verdict and then ask a question, because the question is the last line
// of the format. The question is the card's answer, and a PASS printed before it cannot undo it.
it('does not chain a run that printed a verdict and then asked a question', async () => {
  addCard('APP-1');
  live.engine.spawn = says('NOLZU: verdict: PASS\n\nNOLZU: needs_input: Which port does the API listen on?');

  const runId = await runToEnd('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'blocked' });
  expect(readRun(live.db, runId)?.question).toBe('Which port does the API listen on?');
  expect(readRun(live.db, runId)?.verdict).toBeNull();
});

// The verdict still counts with no sentence behind it, so the card blocks. What a person reads has
// to be a sentence they can act on, and not an empty question.
it('blocks on a BLOCKED verdict with no reason, and asks a question a person can read', async () => {
  addCard('APP-1');
  live.engine.spawn = says('NOLZU: verdict: BLOCKED\n\nNOLZU: complete');

  const runId = await runToEnd('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'blocked' });
  expect(readRun(live.db, runId)?.verdict).toBe('BLOCKED');
  expect(readRun(live.db, runId)?.question).toBe('QA is blocked and gave no reason. Read its log, then answer with what it needs.');
});

// Only QA has a verdict. Another phase that ends ready must leave the two columns empty, or every
// card would carry a sentence about a QA run that never happened.
it('stores no verdict on a phase that is not QA', async () => {
  addCard('APP-1', 'refine');

  const runId = await runToEnd('APP-1', 'refine');

  expect(readRun(live.db, runId)?.state).toBe('complete');
  expect(readRun(live.db, runId)?.verdict).toBeNull();
  expect(readRun(live.db, runId)?.verdictReason).toBeNull();
});

// The stack panel on the ticket page reads the card and not the run row, because a person can load
// a stack with no run going. The run has to leave the card saying the same thing.
it('leaves the card saying its stack is off after the run took it down', async () => {
  addCard('APP-1');
  own('true', 'true');

  await runToEnd('APP-1');

  expect(cardStack(live.db, 'APP-1')?.state).toBe('off');
});

it('leaves the card saying its stack failed when the load command failed', async () => {
  addCard('APP-1');
  own('echo "no compose file" >&2; exit 3');

  await runToEnd('APP-1');

  expect(cardStack(live.db, 'APP-1')?.state).toBe('failed');
  expect(cardStack(live.db, 'APP-1')?.reason).toContain('no compose file');
});

// The load can end without an answer: a person stops the run while `docker compose up` pulls
// images. Nothing else writes the card then, and a card left saying loading refuses every button
// on the panel, Force included.
it('leaves no card saying loading when the run was stopped during the load', async () => {
  addCard('APP-1');
  own('sleep 10; true');

  live.start('APP-1', 'qa');
  const runId = lastRun();
  await vi.waitFor(() => expect(cardStack(live.db, 'APP-1')?.state).toBe('loading'), WAIT);
  live.stop(runId);

  await vi.waitFor(() => expect(cardStack(live.db, 'APP-1')?.state).toBe('failed'), WAIT);
  expect(cardStack(live.db, 'APP-1')?.reason).toContain('stopped with the run');
});

// A first `docker compose up` that pulls images takes minutes. The card says so while it happens,
// rather than showing the state the last run left.
it('says the stack is loading while the load command runs', async () => {
  addCard('APP-1');
  own('sleep 1; true');

  live.start('APP-1', 'qa');

  await vi.waitFor(() => expect(cardStack(live.db, 'APP-1')?.state).toBe('loading'), WAIT);
  await vi.waitFor(() => expect(readRun(live.db, lastRun())?.state).toBe('complete'), WAIT);
});

// A Start pressed by hand on the App line, whose server keeps running. It notes each start and each
// stop in the trail, so the order says whether QA stopped it before its own start.
describe('a Start pressed by hand', () => {
  const handServer = () => {
    const script = join(dir, 'hand-server.mjs');
    writeFileSync(
      script,
      `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(${JSON.stringify(trail())}, 'start\\n');
process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(trail())}, 'stopped\\n'); process.exit(0); });
createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT));
`,
    );
    own(`node ${script}`);
  };
  const FREE = { lanes: [{ name: 'stack', heldBy: null }] };

  it('is stopped before QA starts the app again, so the two never run on top of each other', async () => {
    addCard('APP-1');
    own('true');
    await runToEnd('APP-1');
    handServer();
    expect(await pressStack(live.db, FREE, 'APP-1', 'load', process.env)).toEqual({ ok: true, said: 'The app is up.' });

    await runToEnd('APP-1');

    expect(wrote()).toEqual(['start', 'stopped', 'start', 'stopped']);
  });

  it('is stopped when Nolzu shuts down', async () => {
    addCard('APP-1');
    own('true');
    await runToEnd('APP-1');
    handServer();
    expect(await pressStack(live.db, FREE, 'APP-1', 'load', process.env)).toEqual({ ok: true, said: 'The app is up.' });

    await live.shutdown();

    expect(wrote()).toEqual(['start', 'stopped']);
  });
});
