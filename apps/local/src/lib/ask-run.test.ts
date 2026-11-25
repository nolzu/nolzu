import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRun, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE, type Job } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { addMessage, messagesIn, sendMessage } from './discussion.ts';
import { createLoop, type Loop } from './loop.ts';
import { overviewFor } from './overview.ts';
import { logFor } from './run-log.ts';

// An Ask message on the real loop with the fake engine: a read-only session reads
// one file and answers in its discussion, and the card's stage, state, trail and phase runs stay
// as they were. The `ask` scenario is what the fake engine replays for it.
let dir = '';
let loop: Loop;
let spawned: Job[] = [];
let replay: (job: Job, signal: AbortSignal) => AsyncIterable<string>;

const ASK_SESSION = '8c4f1e2a-3b7d-4a96-9e05-1d6c2b8a7f19';
const ANSWER = 'The list comes from one file. `listRecipes` in `services/api/src/recipes/list.ts` reads `data.json` beside it on every call, so a recipe added to that file shows on the next request. Nothing caches it.';
const WAIT = { timeout: 10_000 };
// Whether the wall starts on this machine, pinned so a test reads the same on every machine.
const WALL = { ready: true } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-ask-'));
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });
  spawned = [];
  replay = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    return replay(job, signal);
  };
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const card = () => loop.db.prepare("SELECT stage, state FROM cards WHERE key = 'APP-1'").get() as { stage: string; state: string };
const askRuns = () =>
  loop.db.prepare("SELECT id, state, thread, session_id AS sessionId, cost_estimate AS cost, resumed FROM runs WHERE phase = 'ask' ORDER BY id").all() as {
    id: number;
    state: string;
    thread: string;
    sessionId: string | null;
    cost: number | null;
    resumed: number;
  }[];
const send = (thread: string, text: string, key = 'APP-1') =>
  sendMessage(
    loop.db,
    key,
    new Request(`http://localhost/api/card/${key}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread, text }) }),
    loop.discuss,
    loop.models(),
  );

// What the card shows of itself, all of it read the way the screens read it.
const cardView = () => {
  const view = loop.snapshot().cards.find((one) => one.key === 'APP-1');
  const overview = overviewFor(loop.db, 'APP-1');
  return {
    stage: view?.stage,
    state: view?.state,
    runId: view?.runId,
    runState: view?.runState,
    model: view?.model,
    trail: JSON.stringify(overview?.strip),
    moves: overview?.moves.length,
  };
};

// A card whose plan ended ready, so it has a phase run and a trail to keep.
async function planned(): Promise<void> {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'ready', 'Search the recipes')").run();
  expect(await moveTo(loop, 'APP-1', 'plan')).toBeNull();
  await vi.waitFor(() => expect(card().state).toBe('ready'), WAIT);
}

it('answers in its thread from the fake engine and leaves the card stage, state, trail and phase runs as they were', async () => {
  await planned();
  const before = cardView();
  const planCost = overviewFor(loop.db, 'APP-1')?.spend.costUsd ?? 0;

  const answer = await send('ask', 'Where does the recipe list come from?');

  expect(answer.status).toBe(200);
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask')).toHaveLength(2), WAIT);
  const [question, reply] = messagesIn(loop.db, 'APP-1', 'ask');
  expect([question?.author, question?.body]).toEqual(['person', 'Where does the recipe list come from?']);
  expect([reply?.author, reply?.body]).toEqual(['agent', ANSWER]);

  const [run] = askRuns();
  expect(run).toMatchObject({ id: reply?.runId, state: 'complete', thread: 'ask', sessionId: ASK_SESSION, cost: 0.0068, resumed: 0 });
  // A read-only job, on haiku from the preset, with the question under the prompt's last heading.
  // The ask job, not the subject pass that follows the first answer.
  const asked = spawned.find((job) => job.phase === 'ask');
  expect(asked).toMatchObject({ phase: 'ask', model: 'haiku', effort: 'low', tools: ['Read', 'Grep', 'Glob'], resumeFrom: null });
  expect(asked?.prompt).toMatch(/## The question\n\nWhere does the recipe list come from\?\n$/);

  // Nothing about the card moved: no state, no stage, no move, no pip, no trail row, and its newest run
  // is still the plan.
  expect(cardView()).toEqual(before);
  expect(card()).toEqual({ stage: 'plan', state: 'ready' });
  // Its cost counts where the card's other runs count, and the Log tab lists it as an Ask run.
  // The subject pass after the first answer counts too, once it ended.
  await vi.waitFor(() => expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'thread-title'").get()).toEqual({ state: 'complete' }), WAIT);
  expect(overviewFor(loop.db, 'APP-1')?.spend.costUsd).toBeCloseTo(planCost + 0.0068 + 0.0009, 6);
  expect(logFor(loop.db, 'APP-1', null).runs.find((one) => one.phase === 'ask')).toMatchObject({ id: run?.id, phase: 'ask', state: 'complete' });
});

it('goes on in the same read-only session with the next message', async () => {
  await planned();
  await send('ask', 'Where does the recipe list come from?');
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask')).toHaveLength(2), WAIT);

  expect((await send('ask', 'And who reads it?')).status).toBe(200);

  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask')).toHaveLength(4), WAIT);
  expect(spawned.at(-1)).toMatchObject({ phase: 'ask', resumeFrom: ASK_SESSION, sessionId: null, prompt: 'And who reads it?' });
  expect(askRuns().map((one) => [one.thread, one.resumed])).toEqual([
    ['ask', 0],
    ['ask', 1],
  ]);
  expect(card()).toEqual({ stage: 'plan', state: 'ready' });
});

// The card's run slot stays the phase's: a phase run starts while an Ask runs, and the Ask's end lands
// nothing on the card.
it('takes no place in the queue, so a phase run of the card starts while it runs', async () => {
  await planned();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    if (job.phase !== 'ask') return replay(job, signal);
    return (async function* () {
      await held;
      yield* replay(job, signal);
    })();
  };

  await send('ask', 'Where does the recipe list come from?');
  expect(askRuns()[0]?.state).toBe('running');
  // A second message waits for the answer to the first.
  const busy = await send('ask', 'And who reads it?');
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ message: expect.stringContaining('still answering') });

  expect(await moveTo(loop, 'APP-1', 'implement')).toBeNull();
  await vi.waitFor(() => expect(card()).toEqual({ stage: 'implement', state: 'ready' }), WAIT);
  const implemented = cardView();

  release();
  await vi.waitFor(() => expect(askRuns()[0]?.state).toBe('complete'), WAIT);
  expect(cardView()).toEqual(implemented);
});

// A run that ends with no answer says why in the thread, so the person never waits on nothing.
it('says in the thread why no answer came, for a failed run and for one that ended silent', async () => {
  await planned();
  const before = cardView();
  // An engine that prints nothing and exits with an error.
  loop.engine.spawn = () =>
    (async function* (): AsyncGenerator<string> {
      yield* [];
      throw new Error('The engine exited with code 1.');
    })();

  await send('ask', 'Where does the recipe list come from?');

  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask')).toHaveLength(2), WAIT);
  expect(messagesIn(loop.db, 'APP-1', 'ask')[1]?.body).toBe('No answer came. The engine exited with code 1. Its log is on the Log tab.');
  expect(askRuns()[0]?.state).toBe('failed');

  // A run that read a file and stopped with nothing after it.
  const session = 's-silent';
  loop.engine.spawn = () =>
    (async function* () {
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'haiku' });
      yield JSON.stringify({ type: 'assistant', session_id: session, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } });
      yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001, duration_ms: 100, session_id: session });
    })();

  await send('ask-2', 'And who reads it?');

  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask-2')).toHaveLength(2), WAIT);
  expect(messagesIn(loop.db, 'APP-1', 'ask-2')[1]?.body).toBe('The agent ended without an answer. Its log is on the Log tab.');
  expect(cardView()).toEqual(before);
});

// A restart stops the run before `answerIn` can post, so the next boot says it in the thread, once.
it('says in the thread that a restart cut the answer off, and says it once', () => {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'plan', 'ready', 'Search the recipes')").run();
  const run = startRun(loop.db, { cardKey: 'APP-1', phase: 'ask', engine: 'claude-code', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null, thread: 'ask' });
  loop.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(run);
  addMessage(loop.db, 'APP-1', 'ask', 'person', 'Where does the recipe list come from?', null);
  const reopen = () => {
    loop.close();
    loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });
  };

  reopen();

  const said = () => messagesIn(loop.db, 'APP-1', 'ask').map((one) => [one.author, one.body, one.runId]);
  const cut = ['agent', 'No answer came. Nolzu restarted while this run was going, so it was stopped. Its log is on the Log tab.', run];
  expect(said()).toEqual([['person', 'Where does the recipe list come from?', null], cut]);
  expect(card()).toEqual({ stage: 'plan', state: 'ready' });

  reopen();
  expect(said()).toHaveLength(2);
});

// Every refusal of a run comes before anything is written, and leaves the card alone. Cursor cannot
// run an Ask where the wall cannot start.
it('refuses an Ask the engine cannot run, and writes no run and touches no card', async () => {
  await planned();
  loop.close();
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: { ready: false, reason: 'bubblewrap is not installed.' } });
  writeSetting(loop.db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: '/tmp/nolzu-ask-cursor' }]);
  writeSetting(loop.db, 'models', { ask: { engine: 'cursor#work' } });
  const before = cardView();

  const answer = await send('ask', 'Where does the recipe list come from?');

  expect(answer.status).toBe(409);
  expect(await answer.json()).toMatchObject({ message: expect.stringContaining("only Nolzu's wall holds Cursor to reading") });
  expect(askRuns()).toEqual([]);
  expect(cardView()).toEqual(before);
});

// `sendMessage` checks the text first, but the loop is the one that starts the run, so it refuses an
// empty message itself and starts nothing.
it('refuses an empty message in the loop itself, and starts no run', async () => {
  await planned();

  expect(() => loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, '   ')).toThrow('The message is empty.');
  expect(askRuns()).toEqual([]);
  expect(spawned.filter((job) => job.phase === 'ask')).toEqual([]);
});

// The busy check and the run row belong to the card the message is for: a second card asks while the
// first one's Ask still goes, and its run is its own.
it('starts an Ask on the card it was sent to, whatever another card has running', async () => {
  await planned();
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'plan', 'ready', 'Another card')").run();
  startRun(loop.db, { cardKey: 'APP-1', phase: 'ask', engine: 'claude-code', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null, thread: 'ask' });

  const answer = await send('ask', 'Where does the recipe list come from?', 'APP-2');

  expect(answer.status).toBe(200);
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-2', 'ask')).toHaveLength(2), WAIT);
  expect(loop.db.prepare("SELECT card_key AS key FROM runs WHERE phase = 'ask' AND session_id IS NOT NULL").all()).toEqual([{ key: 'APP-2' }]);
  expect(messagesIn(loop.db, 'APP-1', 'ask')).toEqual([]);
});

// After the first answer a small pass names the discussion. It runs on the plain summary row, with a
// run row of its own, so its cost counts on the card and the Log tab lists it, and the next answers
// start no second one.
it('names the discussion after its first answer, in a pass of its own, once', async () => {
  await planned();
  writeSetting(loop.db, 'models', { 'extract-summary': { model: 'sonnet', effort: 'low' } });
  await send('ask', 'Where does the recipe list come from?');

  await vi.waitFor(() => expect(loop.db.prepare("SELECT subject, by_person AS byPerson FROM thread_subjects WHERE card_key = 'APP-1' AND thread = 'ask'").get()).toEqual({ subject: 'Where the recipe list comes from', byPerson: 0 }), WAIT);
  const titles = () => loop.db.prepare("SELECT state, model, effort, thread, cost_estimate AS cost FROM runs WHERE phase = 'thread-title'").all();
  expect(titles()).toEqual([{ state: 'complete', model: 'sonnet', effort: 'low', thread: 'ask', cost: 0.0009 }]);
  const pass = spawned.find((job) => job.phase === 'thread-title');
  expect(pass).toMatchObject({ tools: ['Read'], model: 'sonnet' });
  // In a scratch folder of the data folder, never in the person's files.
  expect(pass?.cwd).toBe(join(loop.dataDir, 'passes'));
  expect(pass?.prompt).toContain('Where does the recipe list come from?');
  expect(pass?.prompt).toContain(ANSWER);
  expect(logFor(loop.db, 'APP-1', null).runs.map((run) => run.phase)).toContain('thread-title');
  // The card still shows the plan as its newest run: a pass never stands in for it.
  expect(card()).toEqual({ stage: 'plan', state: 'ready' });

  await send('ask', 'And who reads it?');
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask')).toHaveLength(4), WAIT);
  // A second pass would have its row by now: it starts before the answer it follows is announced.
  expect(titles()).toHaveLength(1);
});

// The subject never holds the conversation up, and a pass that fails leaves no subject and no message.
it('leaves no subject when the pass fails, and the conversation goes on', async () => {
  await planned();
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    if (job.phase === 'thread-title') return replay({ ...job, phase: 'api-error' }, signal);
    return replay(job, signal);
  };
  await send('ask', 'Where does the recipe list come from?');
  await vi.waitFor(() => expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'thread-title'").get()).toEqual({ state: 'failed' }), WAIT);

  expect(loop.db.prepare('SELECT COUNT(*) AS n FROM thread_subjects').get()).toEqual({ n: 0 });
  expect(messagesIn(loop.db, 'APP-1', 'ask').map((one) => one.author)).toEqual(['person', 'agent']);
  expect((await send('ask', 'And who reads it?')).status).toBe(200);
});

// A first try that ended with no answer still leaves the discussion its subject on the next answer.
it('names the discussion after a first try that failed', async () => {
  await planned();
  let first = true;
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    if (job.phase === 'ask' && first) {
      first = false;
      return replay({ ...job, phase: 'api-error' }, signal);
    }
    return replay(job, signal);
  };
  await send('ask', 'Where does the list come from?');
  await vi.waitFor(() => expect(messagesIn(loop.db, 'APP-1', 'ask')).toHaveLength(2), WAIT);
  expect(loop.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE phase = 'thread-title'").get()).toEqual({ n: 0 });

  await send('ask', 'Where does the recipe list come from?');
  await vi.waitFor(() => expect(loop.db.prepare("SELECT subject FROM thread_subjects WHERE thread = 'ask'").get()).toEqual({ subject: 'Where the recipe list comes from' }), WAIT);
  expect(spawned.find((job) => job.phase === 'thread-title')?.prompt).toContain('The question:\n\nWhere does the recipe list come from?');
});
