import { expect, it } from 'vitest';
import { createQueue, enqueue, pick, promote, type QueuedJob, remove, waitFor } from './queue.ts';

const job = (runId: number, cardKey: string, lane: QueuedJob['lane'] = null): QueuedJob => ({ runId, cardKey, lane });

const add = (state: ReturnType<typeof createQueue>, ...jobs: QueuedJob[]) => jobs.reduce(enqueue, state);
const ids = (jobs: readonly QueuedJob[]) => jobs.map((entry) => entry.runId);

it('starts the first job and queues the second when there is one slot', () => {
  const { state, started } = pick(add(createQueue(1), job(1, 'APP-1'), job(2, 'APP-2')));

  expect(ids(started)).toEqual([1]);
  expect(waitFor(state, 2)).toEqual({ reason: 'slot', position: 1 });
  expect(waitFor(state, 1)).toBeNull();
});

it('queues the third job when every slot is busy', () => {
  const { state, started } = pick(add(createQueue(2), job(1, 'APP-1'), job(2, 'APP-2'), job(3, 'APP-3')));

  expect(ids(started)).toEqual([1, 2]);
  expect(waitFor(state, 3)).toEqual({ reason: 'slot', position: 1 });
});

it('lets the job behind a busy lane start in the same pick', () => {
  // This is the case the whole design exists for. A job waiting on a lane must not hold up
  // the unrelated work behind it.
  const queue = add(createQueue(3), job(1, 'APP-1', 'stack'), job(2, 'APP-2', 'stack'), job(3, 'APP-3'));
  const { state, started } = pick(queue);

  expect(ids(started)).toEqual([1, 3]);
  expect(waitFor(state, 2)).toEqual({ reason: 'lane', position: 1 });
});

it('gives a job waiting on a lane no slot of its own', () => {
  const queue = add(
    createQueue(3),
    job(1, 'APP-1', 'stack'),
    job(2, 'APP-2', 'stack'),
    job(3, 'APP-3'),
    job(4, 'APP-4'),
  );
  const { started } = pick(queue);

  // Three slots, and the one job stuck on the lane costs none of them.
  expect(ids(started)).toEqual([1, 3, 4]);
});

// The Scout lane, which holds one read-only assessment at a time. Registered with the other two from
// the start, so this asks the one thing that could still be wrong: that the name is in the table
// and gets a capacity of one, and that an assessment of another finding waits rather than being
// refused.
it('lets one assessment hold the Scout lane and the work behind it past', () => {
  const queue = add(createQueue(3), job(1, 'assess-1', 'scout'), job(2, 'assess-2', 'scout'), job(3, 'APP-3'));
  const { state, started } = pick(queue);

  expect(ids(started)).toEqual([1, 3]);
  expect(waitFor(state, 2)).toEqual({ reason: 'lane', position: 1 });
  // Three slots, and the assessment stuck on the lane costs none of them.
  expect(ids(pick(add(state, job(4, 'APP-4'))).started)).toEqual([4]);
});

it('starts jobs in the order they arrived', () => {
  let state = add(createQueue(1), job(1, 'APP-1'), job(2, 'APP-2'), job(3, 'APP-3'), job(4, 'APP-4'));
  const order: number[] = [];

  for (let turn = 0; turn < 4; turn += 1) {
    const result = pick(state);
    order.push(...ids(result.started));
    state = remove(result.state, result.started[0]?.runId ?? 0);
  }

  expect(order).toEqual([1, 2, 3, 4]);
});

it('moves a promoted job to the front of the queue', () => {
  const { state } = pick(add(createQueue(1), job(1, 'APP-1'), job(2, 'APP-2'), job(3, 'APP-3')));
  const promoted = promote(state, 3);

  expect(waitFor(promoted, 3)?.position).toBe(1);
  expect(waitFor(promoted, 2)?.position).toBe(2);
  expect(ids(pick(remove(promoted, 1)).started)).toEqual([3]);
});

it('changes nothing when a running job or an unknown id is promoted', () => {
  const { state } = pick(add(createQueue(1), job(1, 'APP-1'), job(2, 'APP-2')));

  expect(promote(state, 1)).toEqual(state);
  expect(promote(state, 99)).toEqual(state);
});

it('keeps a promoted job waiting while its lane is busy, and starts the one behind it', () => {
  // One stack job is already running, so it holds the lane.
  const holding = pick(add(createQueue(3), job(1, 'APP-1', 'stack'))).state;
  const queued = add(holding, job(2, 'APP-2', 'stack'), job(3, 'APP-3'));
  // Promote never jumps a lane. It only changes the order of the jobs that could start.
  const { state, started } = pick(promote(queued, 2));

  expect(ids(started)).toEqual([3]);
  expect(waitFor(state, 2)).toEqual({ reason: 'lane', position: 1 });
});

it('drops a queued job that is removed', () => {
  const { state } = pick(add(createQueue(1), job(1, 'APP-1'), job(2, 'APP-2')));
  const without = remove(state, 2);

  expect(waitFor(without, 2)).toBeNull();
  expect(ids(pick(without).started)).toEqual([]);
});

it('frees the slot and the lane when a running job is removed', () => {
  const { state } = pick(add(createQueue(1), job(1, 'APP-1', 'stack'), job(2, 'APP-2', 'stack')));
  const { started } = pick(remove(state, 1));

  expect(ids(started)).toEqual([2]);
});

it('refuses a second job for a card that already has one, and names the card', () => {
  const state = add(createQueue(2), job(1, 'APP-1'));

  expect(() => enqueue(state, job(2, 'APP-1'))).toThrow(/APP-1/);
});

it('refuses a second job for a card whose first one is running', () => {
  const { state } = pick(add(createQueue(2), job(1, 'APP-1')));

  expect(() => enqueue(state, job(2, 'APP-1'))).toThrow(/APP-1/);
});

it('leaves the state it was given untouched, so nothing mutates behind a caller', () => {
  const before = add(createQueue(1), job(1, 'APP-1'), job(2, 'APP-2'));
  const copy = structuredClone(before);

  pick(before);
  promote(before, 2);
  remove(before, 1);

  expect(before).toEqual(copy);
});

// One queue for every project. Run ids and card keys come from each project's own
// database, so both repeat across projects, and only the project tells two runs apart.
const inProject = (project: number, runId: number, cardKey: string, lane: QueuedJob['lane'] = null): QueuedJob => ({ runId, cardKey, lane, project });

it('queues the same card key once in each project, and refuses it twice in one', () => {
  const state = add(createQueue(1), inProject(1, 1, 'APP-1'), inProject(2, 1, 'APP-1'));

  expect(state.waiting).toHaveLength(2);
  expect(() => enqueue(state, inProject(2, 2, 'APP-1'))).toThrow(/APP-1 already has a run in the queue/);
});

it('tells the runs of two projects with one id apart', () => {
  const { state } = pick(add(createQueue(1), inProject(1, 7, 'APP-1'), inProject(2, 7, 'APP-1'), inProject(2, 8, 'APP-2')));

  expect(waitFor(state, 7, 1)).toBeNull();
  expect(waitFor(state, 7, 2)).toEqual({ reason: 'slot', position: 1 });
  expect(promote(state, 8, 2).waiting.map((entry) => [entry.project, entry.runId])).toEqual([[2, 8], [2, 7]]);
  // A stop of project 2's run 7 leaves project 1's run 7 running.
  const left = remove(state, 7, 2);
  expect(left.running.map((entry) => entry.project)).toEqual([1]);
  expect(left.waiting.map((entry) => [entry.project, entry.runId])).toEqual([[2, 8]]);
});

it('shares the slots and the lanes across projects', () => {
  const { state, started } = pick(add(createQueue(2), inProject(1, 1, 'APP-1', 'stack'), inProject(2, 1, 'PROJ-123', 'stack'), inProject(2, 2, 'PROJ-124')));

  // The stack is one stack on this machine, so the QA of the second project waits on the first one.
  expect(started.map((entry) => entry.cardKey)).toEqual(['APP-1', 'PROJ-124']);
  expect(waitFor(state, 1, 2)).toEqual({ reason: 'lane', position: 1 });
});
