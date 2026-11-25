import type { Job } from '@nolzu/protocol';

export type LaneName = 'stack' | 'knowledge' | 'scout';

// One at a time per lane, because each lane owns something that cannot be shared: the local
// stack, the knowledge repository, the read-only Scout checkout. All three are registered
// here, so a new kind of run adds jobs and not machinery.
export const LANES: Record<LaneName, number> = { stack: 1, knowledge: 1, scout: 1 };

// The queue needs four fields of a run, and takes them from the real Job rather than
// declaring a second shape that would drift away from it.
export type QueuedJob = Pick<Job, 'runId' | 'cardKey' | 'lane' | 'project'>;

// One queue holds the runs of every project, and a run id repeats across projects. A caller with one
// project leaves the project out and matches the run id alone.
const isRun = (entry: QueuedJob, runId: number, project?: number): boolean =>
  entry.runId === runId && (project === undefined || entry.project === project);

export type WaitReason = 'slot' | 'lane';

export interface QueueState {
  slots: number;
  waiting: readonly QueuedJob[];
  running: readonly QueuedJob[];
}

export function createQueue(slots: number): QueueState {
  return { slots, waiting: [], running: [] };
}

function laneFree(running: readonly QueuedJob[], lane: string | null, alsoStarting: readonly QueuedJob[]): boolean {
  if (lane === null) return true;
  // A name nobody registered gets a capacity of one, which is the careful direction: an
  // unknown lane holds the queue back rather than letting everything through.
  const capacity = Object.hasOwn(LANES, lane) ? LANES[lane as LaneName] : 1;
  const used = [...running, ...alsoStarting].filter((entry) => entry.lane === lane).length;
  return used < capacity;
}

export function enqueue(state: QueueState, job: QueuedJob): QueueState {
  // One run per card of one project. Two projects can each have an APP-1.
  const taken = [...state.waiting, ...state.running].some((entry) => entry.cardKey === job.cardKey && entry.project === job.project);
  if (taken) {
    throw new Error(`${job.cardKey} already has a run in the queue. A card runs one phase at a time.`);
  }
  return { ...state, waiting: [...state.waiting, job] };
}

// Walks the waiting jobs in order and starts the ones that can start. A job whose lane is
// busy is skipped rather than blocking, so unrelated work behind it still runs, and it takes
// no slot while it waits.
export function pick(state: QueueState): { state: QueueState; started: readonly QueuedJob[] } {
  const started: QueuedJob[] = [];
  const stillWaiting: QueuedJob[] = [];

  for (const job of state.waiting) {
    const slotsUsed = state.running.length + started.length;
    if (slotsUsed < state.slots && laneFree(state.running, job.lane, started)) {
      started.push(job);
    } else {
      stillWaiting.push(job);
    }
  }

  return { state: { ...state, waiting: stillWaiting, running: [...state.running, ...started] }, started };
}

export function promote(state: QueueState, runId: number, project?: number): QueueState {
  const index = state.waiting.findIndex((entry) => isRun(entry, runId, project));
  // A running job and an id nobody has are both nothing to reorder.
  if (index <= 0) return state;

  const job = state.waiting[index];
  if (job === undefined) return state;
  return { ...state, waiting: [job, ...state.waiting.filter((entry) => entry !== job)] };
}

export function remove(state: QueueState, runId: number, project?: number): QueueState {
  return {
    ...state,
    waiting: state.waiting.filter((entry) => !isRun(entry, runId, project)),
    running: state.running.filter((entry) => !isRun(entry, runId, project)),
  };
}

// Why a job has not started, and where it sits. Counted from one, because it is shown to a
// person as "Queued 2nd".
export function waitFor(state: QueueState, runId: number, project?: number): { reason: WaitReason; position: number } | null {
  const index = state.waiting.findIndex((entry) => isRun(entry, runId, project));
  if (index === -1) return null;

  const job = state.waiting[index];
  if (job === undefined) return null;
  return { reason: laneFree(state.running, job.lane, []) ? 'slot' : 'lane', position: index + 1 };
}
