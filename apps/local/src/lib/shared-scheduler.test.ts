import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMachine, openProject, readRun, registerProject, startRun } from '@nolzu/core/node';
import { DEFAULT_PROFILE, type Job } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addMessage, messagesIn } from './discussion.ts';
import { createLoop, type Loop } from './loop.ts';
import { sharedScheduler } from './shared-scheduler.ts';

// One scheduler for every project: two registered project databases in one temp
// data folder, each with its own loop over the fake engine, sharing the slots and the lanes.
const env = { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' };

let dir = '';
let one: Loop;
let two: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-shared-'));
  one = createLoop(dir, env);
  two = createLoop(dir, env, { project: registerProject(one.db, 'two.db') });
});

afterEach(async () => {
  // Stops whatever a test left held, so no run outlives its folder.
  await one.shutdown();
  two.close();
  one.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (live: Loop, key: string) =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', 'plan', 'idle', ?)").run(key, `${key} title`);

const begin = (live: Loop, key: string) =>
  startRun(live.db, { cardKey: key, phase: 'plan', engine: DEFAULT_PROFILE.id, model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });

const state = (live: Loop, runId: number) => readRun(live.db, runId)?.state;
const cardState = (live: Loop, key: string) => (live.db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string }).state;
const keys = (jobs: readonly { cardKey: string }[]) => jobs.map((job) => job.cardKey);

// Each run of this loop waits at the engine until the test lets it go, or until it is stopped, so the
// queue can be read while runs hold their slots.
function gate(live: Loop) {
  const fake = live.engine.spawn.bind(live.engine);
  const held = new Map<string, () => void>();
  live.engine.spawn = async function* (job: Job, signal: AbortSignal) {
    await new Promise<void>((resolve) => {
      held.set(job.cardKey, resolve);
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield* fake(job, signal);
  };
  return { reached: () => [...held.keys()], release: (key: string) => held.get(key)?.() };
}

it('runs one job at a time across two projects with one slot', async () => {
  one.scheduler.resize(1);
  const [first, second] = [gate(one), gate(two)];
  addCard(one, 'APP-1');
  addCard(two, 'PROJ-123');

  expect(one.start('APP-1', 'plan')).toBe(true);
  expect(two.start('PROJ-123', 'plan')).toBe(true);

  expect(keys(one.scheduler.queue().running)).toEqual(['APP-1']);
  expect(two.scheduler.queue()).toMatchObject({ slots: 1, running: [], waiting: [{ cardKey: 'PROJ-123', project: 2 }] });
  // The board of project 2 counts the slot project 1 holds, and its own run waits first in line.
  expect(two.snapshot().slots).toEqual({ busy: 1, total: 1 });
  expect(two.snapshot().cards[0]).toMatchObject({ key: 'PROJ-123', queuePosition: 1, runState: 'queued' });

  await vi.waitFor(() => expect(first.reached()).toEqual(['APP-1']));
  expect(second.reached()).toEqual([]);
  first.release('APP-1');

  await vi.waitFor(() => expect(second.reached()).toEqual(['PROJ-123']));
  expect(one.scheduler.queue().running).toEqual([]);
  expect(state(one, 1)).toBe('complete');
  second.release('PROJ-123');
  await vi.waitFor(() => expect(state(two, 1)).toBe('complete'));
});

// Both projects have an APP-1 with run 1, which is the case a run sent to the wrong database would
// write over.
it('writes a job of project 2 only to project 2', async () => {
  one.scheduler.resize(2);
  const first = gate(one);
  addCard(one, 'APP-1');
  addCard(two, 'APP-1');

  expect(one.start('APP-1', 'plan')).toBe(true);
  expect(two.start('APP-1', 'plan')).toBe(true);
  await vi.waitFor(() => expect(state(two, 1)).toBe('complete'));
  await vi.waitFor(() => expect(first.reached()).toEqual(['APP-1']));

  expect(cardState(two, 'APP-1')).toBe('ready');
  expect(state(one, 1)).toBe('running');
  expect(cardState(one, 'APP-1')).toBe('running');
  expect(one.db.prepare('SELECT count(*) AS runs FROM runs').get()).toEqual({ runs: 1 });
  expect(one.snapshot().cards[0]).toMatchObject({ key: 'APP-1', state: 'running' });
  // The run files too. Both logs have one name, so each project keeps its own folder, and the log of
  // the run project 1 holds has none of the lines project 2 wrote.
  const log = (live: Loop) => readFileSync(join(live.dataDir, 'logs', 'APP-1-plan-1.ndjson'), 'utf8');
  expect(two.dataDir).toBe(join(dir, 'projects', '2'));
  expect(one.dataDir).toBe(dir);
  expect(log(two)).toMatch(/"type":"result"/);
  expect(log(one)).not.toMatch(/"type":"result"/);

  first.release('APP-1');
  await vi.waitFor(() => expect(state(one, 1)).toBe('complete'));
});

it('shares the lanes across projects', async () => {
  one.scheduler.resize(3);
  const [first, second] = [gate(one), gate(two)];
  addCard(one, 'APP-1');
  addCard(two, 'PROJ-123');
  addCard(two, 'PROJ-124');
  const onStack = (live: Loop, key: string) => live.scheduler.add({ ...live.buildJob(key, 'plan', begin(live, key)), lane: 'stack' });

  onStack(one, 'APP-1');
  onStack(two, 'PROJ-123');
  two.scheduler.add(two.buildJob('PROJ-124', 'plan', begin(two, 'PROJ-124')));

  // The stack of project 1 holds the QA of project 2, and work with no lane goes past it.
  expect(keys(two.scheduler.queue().running)).toEqual(['PROJ-124']);
  const board = two.snapshot();
  expect(board.cards.find((card) => card.key === 'PROJ-123')).toMatchObject({ runState: 'waiting_lane', queuePosition: 1 });
  expect(board.lanes.find((lane) => lane.name === 'stack')?.heldBy).toBe('APP-1');

  await vi.waitFor(() => expect(first.reached()).toEqual(['APP-1']));
  first.release('APP-1');
  await vi.waitFor(() => expect(second.reached().sort()).toEqual(['PROJ-123', 'PROJ-124']));
  second.release('PROJ-123');
  second.release('PROJ-124');
  await vi.waitFor(() => expect(two.scheduler.queue().running).toEqual([]));
});

it('takes a new slot count for every project, and Ctrl+C stops the runs of every project', async () => {
  one.scheduler.resize(1);
  const [first, second] = [gate(one), gate(two)];
  addCard(one, 'APP-1');
  addCard(two, 'PROJ-123');
  addCard(two, 'PROJ-124');
  one.start('APP-1', 'plan');
  two.start('PROJ-123', 'plan');
  await vi.waitFor(() => expect(first.reached()).toEqual(['APP-1']));
  expect(keys(two.scheduler.queue().waiting)).toEqual(['PROJ-123']);

  // Saved through the loop of project 1, and the waiting run of project 2 starts.
  one.scheduler.resize(2);
  await vi.waitFor(() => expect(second.reached()).toEqual(['PROJ-123']));
  // A commit message pass takes no slot, so Ctrl+C reaches it outside the queue.
  const message = two.writeMessage('PROJ-124', 'Write the commit message.');
  await vi.waitFor(() => expect(second.reached()).toContain('PROJ-124'));

  // Pressed on the loop of project 1, it stops the run of project 2 too.
  await one.shutdown();

  expect(one.scheduler.queue().running).toEqual([]);
  expect(two.scheduler.queue().running).toEqual([]);
  expect([state(one, 1), state(two, 1)]).toEqual(['stopped', 'stopped']);
  expect([cardState(one, 'APP-1'), cardState(two, 'PROJ-123')]).toEqual(['idle', 'idle']);
  await expect(message).resolves.toMatchObject({ ok: false });
  expect(two.db.prepare("SELECT state FROM runs WHERE phase = 'commit-message'").get()).toEqual({ state: 'stopped' });
});

it('starts nothing for any project once Ctrl+C was pressed', async () => {
  one.scheduler.resize(2);
  addCard(two, 'PROJ-123');
  await one.shutdown();

  // A job a page or the hub sends now finds no slot, in the project that did not press Ctrl+C too.
  two.scheduler.add(two.buildJob('PROJ-123', 'plan', begin(two, 'PROJ-123')));
  expect(two.scheduler.queue()).toMatchObject({ slots: 0, running: [], waiting: [{ cardKey: 'PROJ-123' }] });
});

// Run 1 exists in both projects, so a promote or a stop that leaves the project out moves or takes the wrong one.
it('promotes and stops a waiting run in its own project when run ids repeat', () => {
  one.scheduler.resize(0);
  for (const key of ['APP-1', 'APP-2']) addCard(one, key);
  addCard(two, 'APP-1');
  for (const [live, key] of [[one, 'APP-1'], [one, 'APP-2'], [two, 'APP-1']] as const) live.scheduler.add(live.buildJob(key, 'plan', begin(live, key)));
  const order = () => one.scheduler.queue().waiting.length + ':' + two.scheduler.queue().waiting.length;
  expect(order()).toBe('2:1');

  const place = () => two.snapshot().cards.find((card) => card.key === 'APP-1')?.queuePosition;
  expect(place()).toBe(3);
  two.scheduler.promote(1);
  expect(place()).toBe(1);
  expect(one.scheduler.queue().waiting.map((job) => job.runId)).toEqual([1, 2]);
  const all = (live: Loop) => live.scheduler.queue().waiting.map((job) => `${job.project}:${job.runId}`);
  expect(all(two)).toEqual(['2:1']);
  one.scheduler.promote(2);
  expect(all(one)).toEqual(['1:2', '1:1']);
  two.scheduler.stop(1);
  expect(order()).toBe('2:0');
});

it('tells the board of every project when a run of one project moves the queue', () => {
  one.scheduler.resize(0);
  addCard(one, 'APP-1');
  let heard = 0;
  const stop = two.onChange(() => (heard += 1));
  one.scheduler.add(one.buildJob('APP-1', 'plan', begin(one, 'APP-1')));
  stop();
  // Project 2's slots line and places moved, though none of its own runs did.
  expect(heard).toBeGreaterThan(0);
});

// The first project named by its id is the loop it has, and the scheduler still refuses a second join.
it('gives the first project named by its id the loop it has, and refuses a second loop over a project', () => {
  expect(createLoop(dir, env, { project: 1 })).toBe(one);
  const shared = sharedScheduler(new Map(), dir, 1);
  const ports = { startJob: async () => undefined, onChange: () => undefined, stop: () => undefined, leave: () => undefined, left: async () => undefined };
  shared.join(1, ports);
  expect(() => shared.join(1, ports)).toThrow(`Project 1 already has a loop open on ${dir}.`);
  // The loop that was there is still the one the queue knows.
  addCard(one, 'APP-1');
  expect(one.start('APP-1', 'plan')).toBe(true);
});

it('waits for the Ask run of every project to write its stop', async () => {
  const fake = two.engine.spawn.bind(two.engine);
  let reached = false;
  // Slow to wind down after the abort, so a Ctrl+C that does not wait for it returns first.
  two.engine.spawn = async function* (job: Job, signal: AbortSignal) {
    reached = true;
    await new Promise<void>((resolve) => (signal.aborted ? setTimeout(resolve, 80) : signal.addEventListener('abort', () => setTimeout(resolve, 80), { once: true })));
    yield* fake(job, signal);
  };
  addCard(two, 'PROJ-124');
  expect(two.discuss('PROJ-124', { id: 'ask', sessionId: null, engine: null }, 'Why?')).toBe(true);
  await vi.waitFor(() => expect(reached).toBe(true));

  await one.shutdown();
  expect(two.db.prepare("SELECT state FROM runs WHERE phase = 'ask'").get()).toEqual({ state: 'stopped' });
});

// What a crash leaves behind in a project: a card claiming a run, and a run claiming to be going.
const crashed = (live: Loop, key: string) => {
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', 'plan', 'running', ?)").run(key, `${key} title`);
  const id = begin(live, key);
  live.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(id);
  return id;
};

// Project 2's database as it lies, read before any loop of it opens.
const inTwo = <T>(read: (db: ReturnType<typeof openProject>) => T): T => {
  const db = openProject(dir, 2);
  try {
    return read(db);
  } finally {
    db.close();
  }
};

it('closes the runs a crash left open in every project when the first loop opens', () => {
  const first = crashed(one, 'APP-1');
  const second = crashed(two, 'PROJ-123');
  // An Ask run project 2 had going says in its discussion that the restart cut it off, as with one project.
  const asked = startRun(two.db, { cardKey: 'PROJ-123', phase: 'ask', engine: DEFAULT_PROFILE.id, model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null, thread: 'ask' });
  two.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(asked);
  addMessage(two.db, 'PROJ-123', 'ask', 'person', 'Where does the recipe list come from?', null);
  two.close();
  one.close();

  // The boot: one scheduler runs every project, so the first loop sweeps project 2 as well.
  one = createLoop(dir, env);

  expect([state(one, first), cardState(one, 'APP-1')]).toEqual(['interrupted', 'failed']);
  expect(inTwo((db) => [readRun(db, second)?.state, readRun(db, asked)?.state])).toEqual(['interrupted', 'interrupted']);
  expect(inTwo((db) => db.prepare("SELECT state FROM cards WHERE key = 'PROJ-123'").get())).toEqual({ state: 'failed' });
  expect(inTwo((db) => db.prepare('SELECT error FROM runs WHERE id = ?').get(second))).toEqual({ error: 'Nolzu restarted while this run was going, so it was stopped.' });
  const said = () => inTwo((db) => messagesIn(db, 'PROJ-123', 'ask').map((message) => message.body));
  expect(said()).toEqual(['Where does the recipe list come from?', 'No answer came. Nolzu restarted while this run was going, so it was stopped. Its log is on the Log tab.']);

  // Its own loop opening later adds nothing.
  two = createLoop(dir, env, { project: 2 });
  expect(said()).toHaveLength(2);
});

it('refuses a second server through the machine lock, whatever project it opens, and sweeps nothing', () => {
  const second = crashed(two, 'PROJ-123');
  two.close();
  one.close();
  // Another Nolzu holds the machine: a live process that is not this one, with a lock from this boot.
  const machine = openMachine(dir);
  machine.prepare('INSERT OR REPLACE INTO writer (id, pid, at) VALUES (1, ?, ?)').run(process.ppid, new Date().toISOString());

  const refusal = `Nolzu is already running on ${dir} as process ${process.ppid}.`;
  expect(() => createLoop(dir, env, { project: 2 })).toThrow(refusal);
  expect(() => createLoop(dir, env)).toThrow(refusal);
  // The lock comes before the sweep, so the run the other Nolzu is doing stays as it is.
  expect(inTwo((db) => readRun(db, second)?.state)).toBe('running');

  // That Nolzu stops, and this one starts.
  machine.prepare('DELETE FROM writer').run();
  machine.close();
  one = createLoop(dir, env);
  two = createLoop(dir, env, { project: 2 });
  expect(state(two, second)).toBe('interrupted');
});

it('opens a project when the boot cannot open another one', () => {
  registerProject(one.db, 'broken.db');
  writeFileSync(join(dir, 'broken.db'), 'not a database');
  two.close();
  one.close();

  one = createLoop(dir, env);
  two = createLoop(dir, env, { project: 2 });

  expect(one.snapshot().cards).toEqual([]);
  expect(() => createLoop(dir, env, { project: 3 })).toThrow(/not a database/);
});

// A hot reload in development builds loop.ts again and keeps the modules it imports, this one among
// them. Its new loops must open as they did before the scheduler was shared, not be refused.
it('opens the loop again when a hot reload builds loop.ts again', async () => {
  const kept = await import('./shared-scheduler.ts');
  vi.resetModules();
  vi.doMock('./shared-scheduler.ts', () => kept);
  try {
    const reloaded = await import('./loop.ts');
    const again = reloaded.createLoop(dir, env);
    try {
      addCard(again, 'APP-1');
      expect(again.start('APP-1', 'plan')).toBe(true);
      await vi.waitFor(() => expect(state(again, 1)).toBe('complete'));
    } finally {
      await again.shutdown();
      again.close();
    }
  } finally {
    vi.doUnmock('./shared-scheduler.ts');
  }
});

// Only the boot sweeps another project. A later loop that swept project 1 would close the run it holds.
it('leaves the runs of an open project alone when another project opens', async () => {
  const first = gate(one);
  addCard(one, 'APP-1');
  one.start('APP-1', 'plan');
  await vi.waitFor(() => expect(first.reached()).toEqual(['APP-1']));
  two.close();

  two = createLoop(dir, env, { project: 2 });

  expect([state(one, 1), cardState(one, 'APP-1')]).toEqual(['running', 'running']);
  first.release('APP-1');
  await vi.waitFor(() => expect(state(one, 1)).toBe('complete'));
});
