import type { Job } from '@nolzu/protocol';
import { expect, it, vi } from 'vitest';
import { createScheduler, type SchedulerPorts } from './scheduler.ts';

const job = (runId: number, cardKey: string, lane: string | null = null): Job => ({
  runId,
  cardKey,
  engine: 'claude-code',
  phase: 'implement',
  cwd: '/demo',
  prompt: 'do the thing',
  model: 'sonnet',
  effort: 'medium',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 1000,
  logPath: 'log.ndjson',
  taskDir: '/tmp/demo/.tasks/APP-1',
  lane,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read'],
});

interface Started {
  job: Job;
  signal: AbortSignal;
  settle: () => void;
  fail: (reason: Error) => void;
}

// A stub the test settles by hand, so there is no timer and no engine anywhere in these tests.
function harness(slots: number) {
  const started: Started[] = [];
  const onChange = vi.fn();
  const startJob: SchedulerPorts['startJob'] = (job, signal) =>
    new Promise<void>((resolve, reject) => {
      started.push({ job, signal, settle: () => resolve(), fail: reject });
    });
  return { started, onChange, scheduler: createScheduler(slots, { startJob, onChange }) };
}

const keys = (started: readonly Started[]) => started.map((entry) => entry.job.cardKey);
// Lets whatever the scheduler chained onto a settled promise run.
const tick = () => Promise.resolve().then(() => undefined);

it('holds the second job until the first one ends, then starts it', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));

  expect(keys(started)).toEqual(['APP-1']);

  started[0]?.settle();
  await tick();

  expect(keys(started)).toEqual(['APP-1', 'APP-2']);
});

it('starts a lane job and a free job together when there are slots for both', async () => {
  const { started, scheduler } = harness(2);
  scheduler.add(job(1, 'APP-1', 'stack'));
  scheduler.add(job(2, 'APP-2'));

  expect(keys(started)).toEqual(['APP-1', 'APP-2']);
});

it('never starts a job that was stopped while it was queued', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));

  scheduler.stop(2);
  started[0]?.settle();
  await tick();

  expect(keys(started)).toEqual(['APP-1']);
});

it('stops a running job by aborting it, and gives the slot to the next one', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));

  scheduler.stop(1);

  expect(started[0]?.signal.aborted).toBe(true);
  // The run ends the way an aborted run really does, by settling.
  started[0]?.settle();
  await tick();

  expect(keys(started)).toEqual(['APP-1', 'APP-2']);
});

// A Stop pressed while Ctrl+C stops everything, or Ctrl+C pressed twice. The run is already ending,
// so the second stop sends nothing and draws no second board.
it('stops a run once, and a second stop of a run already ending does nothing', () => {
  const { started, onChange, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  let aborts = 0;
  started[0]?.signal.addEventListener('abort', () => (aborts += 1));

  scheduler.stop(1);
  const told = onChange.mock.calls.length;
  scheduler.stop(1);

  expect(aborts).toBe(1);
  expect(onChange.mock.calls.length).toBe(told);
});

it('treats stopping a run that already ended as nothing to do', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  started[0]?.settle();
  await tick();

  expect(() => scheduler.stop(1)).not.toThrow();
});

it('frees the slot and the lane when a run fails, and keeps going', async () => {
  const { started, onChange, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1', 'stack'));
  scheduler.add(job(2, 'APP-2', 'stack'));

  const before = onChange.mock.calls.length;
  started[0]?.fail(new Error('the engine died'));
  await tick();

  // Same lane and same slot, so the second only starts if both were given back.
  expect(keys(started)).toEqual(['APP-1', 'APP-2']);
  // The failure is a change like any other. An unhandled rejection would take the process down.
  expect(onChange.mock.calls.length).toBeGreaterThan(before);
});

it('starts a promoted job before the one that was waiting ahead of it', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));
  scheduler.add(job(3, 'APP-3'));

  scheduler.promote(3);
  started[0]?.settle();
  await tick();

  expect(keys(started)).toEqual(['APP-1', 'APP-3']);
});

// Counted, so a change that quietly skips the callback fails here rather than showing up later as
// a board that does not move.
it('reports every change, so nothing moves without the board hearing about it', async () => {
  const { started, onChange, scheduler } = harness(1);

  scheduler.add(job(1, 'APP-1'));
  const afterAdd = onChange.mock.calls.length;
  expect(afterAdd).toBeGreaterThan(0);

  scheduler.add(job(2, 'APP-2'));
  expect(onChange.mock.calls.length).toBeGreaterThan(afterAdd);

  const afterQueued = onChange.mock.calls.length;
  started[0]?.settle();
  await tick();
  expect(onChange.mock.calls.length).toBeGreaterThan(afterQueued);

  const afterFinish = onChange.mock.calls.length;
  scheduler.add(job(3, 'APP-3'));
  scheduler.promote(3);
  expect(onChange.mock.calls.length).toBeGreaterThan(afterFinish);

  const afterPromote = onChange.mock.calls.length;
  scheduler.stop(2);
  expect(onChange.mock.calls.length).toBeGreaterThan(afterPromote);
});

// The slot belongs to the run until the run really ends. Freeing it when the abort is sent starts
// the next job while the engine it replaces is still shutting down, and the machine runs more
// agents than the person allowed.
it('holds the slot until the aborted run actually ends', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));

  scheduler.stop(1);
  await tick();

  expect(keys(started)).toEqual(['APP-1']);

  started[0]?.settle();
  await tick();

  expect(keys(started)).toEqual(['APP-1', 'APP-2']);
});

// Dropping the queued job out of the queue matters on its own. Without it the entry sits in the
// running list for good and its slot is never given back, which no test saw while the job simply
// failed to start for another reason.
it('gives the slot back after a queued run is stopped', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));

  scheduler.stop(2);
  started[0]?.settle();
  await tick();
  scheduler.add(job(3, 'APP-3'));
  await tick();

  expect(keys(started)).toEqual(['APP-1', 'APP-3']);
});

it('reports the start of a run, not only its arrival', async () => {
  const { onChange, scheduler } = harness(1);

  scheduler.add(job(1, 'APP-1'));

  // Once for arriving in the queue and once for starting. A single call means one of them is
  // silent, and the board would not show the run until something else moved.
  expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
});

// The loop reads a run's activity off this port, so every event a job reports names the run it is from.
it('hands each event a job reports to the onEvent port, with the run it belongs to', () => {
  const heard: [number, string][] = [];
  const scheduler = createScheduler(2, {
    startJob: (_job, _signal, onEvent) => {
      onEvent({ type: 'tool', name: 'Read', input: { file_path: 'src/recipes/list.ts' } });
      return new Promise<void>(() => undefined);
    },
    onChange: () => undefined,
    onEvent: (runId, event) => heard.push([runId, event.type]),
  });

  scheduler.add(job(4, 'APP-1'));
  scheduler.add(job(5, 'APP-2'));

  expect(heard).toEqual([
    [4, 'tool'],
    [5, 'tool'],
  ]);
});

// Settings, Runs saves the slot count while the app runs. More slots start what waits at once; fewer
// stop no run and only hold the next start until enough of the running ones end.
it('takes a new slot count at once, starting what waits and stopping nothing', async () => {
  const { started, onChange, scheduler } = harness(1);
  scheduler.add(job(1, 'APP-1'));
  scheduler.add(job(2, 'APP-2'));
  scheduler.add(job(3, 'APP-3'));
  onChange.mockClear();

  scheduler.resize(2);
  expect(keys(started)).toEqual(['APP-1', 'APP-2']);
  expect(scheduler.queue().slots).toBe(2);
  expect(onChange).toHaveBeenCalled();

  scheduler.resize(1);
  expect(started.every((entry) => !entry.signal.aborted)).toBe(true);
  started[0]?.settle();
  await tick();
  // One slot and one run still going, so the third waits.
  expect(keys(started)).toEqual(['APP-1', 'APP-2']);

  started[1]?.settle();
  await tick();
  expect(keys(started)).toEqual(['APP-1', 'APP-2', 'APP-3']);
});

// One scheduler for every project. A run id repeats across projects, so a stop and
// a promote name the project too.
it('stops and promotes the run of the named project only', async () => {
  const { started, scheduler } = harness(1);
  scheduler.add({ ...job(1, 'APP-1'), project: 1 });
  scheduler.add({ ...job(1, 'APP-1'), project: 2 });
  scheduler.add({ ...job(2, 'APP-2'), project: 2 });

  scheduler.promote(2, 2);
  expect(scheduler.queue().waiting.map((entry) => [entry.project, entry.runId])).toEqual([[2, 2], [2, 1]]);

  // A stop that leaves the project out names no run of a project, so it takes none off the queue.
  scheduler.stop(1);
  expect(started[0]?.signal.aborted).toBe(false);
  expect(scheduler.queue().running.map((entry) => [entry.project, entry.runId])).toEqual([[1, 1]]);
  expect(scheduler.queue().waiting.map((entry) => [entry.project, entry.runId])).toEqual([[2, 2], [2, 1]]);

  scheduler.stop(1, 2);
  expect(started[0]?.signal.aborted).toBe(false);
  expect(scheduler.queue().waiting.map((entry) => [entry.project, entry.runId])).toEqual([[2, 2]]);

  scheduler.stop(1, 1);
  expect(started[0]?.signal.aborted).toBe(true);
  started[0]?.settle();
  await tick();
  expect(started.map((entry) => [entry.job.project, entry.job.runId])).toEqual([[1, 1], [2, 2]]);
});
