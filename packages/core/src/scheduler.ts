import type { Job, RunEvent } from '@nolzu/protocol';
import { createQueue, enqueue, pick, promote as promoteInQueue, type QueueState, remove } from './queue.ts';

export interface SchedulerPorts {
  // The one way out to the runner, so core never imports it. The promise settles when the run
  // ends, however it ends.
  startJob: (job: Job, signal: AbortSignal, onEvent: (event: RunEvent) => void) => Promise<void>;
  // Called after every change, so whatever draws the board can read the new state.
  onChange: () => void;
  onEvent?: (runId: number, event: RunEvent) => void;
}

export interface Scheduler {
  // The queue as it stands. The board snapshot needs it, and the state lives here rather than in the
  // database, so there is no other way to read it.
  queue: () => QueueState;
  add: (job: Job) => void;
  // A run id repeats across projects, so these name the project too. Left out, the run id alone,
  // which is all a caller with one project has.
  stop: (runId: number, project?: number) => void;
  promote: (runId: number, project?: number) => void;
  // A slot count saved in Settings, taken at once. Fewer slots stop no run: the next start waits
  // until enough running ones end.
  resize: (slots: number) => void;
}

// Both halves of a run's name, since one scheduler holds the runs of every project.
const idOf = (runId: number, project?: number): string => `${project ?? ''}:${runId}`;

// The only stateful piece of the loop. The queue itself stays a plain value, and this holds it.
export function createScheduler(slots: number, ports: SchedulerPorts): Scheduler {
  let state: QueueState = createQueue(slots);
  // The queue keeps four fields of a run. The whole job is kept here, because that is what
  // starting one needs.
  const jobs = new Map<string, Job>();
  const running = new Map<string, AbortController>();

  const startReady = (): void => {
    const picked = pick(state);
    state = picked.state;

    for (const entry of picked.started) {
      const id = idOf(entry.runId, entry.project);
      const job = jobs.get(id);
      if (job === undefined) continue;

      // One controller per job, so stopping is an abort and nothing else.
      const controller = new AbortController();
      running.set(id, controller);
      ports.onChange();

      ports
        .startJob(job, controller.signal, (event) => ports.onEvent?.(entry.runId, event))
        // Swallowed here and not left to the caller. A run that crashes is an ordinary end for the
        // queue, and an unhandled rejection would take the whole process down with it.
        .catch(() => undefined)
        .finally(() => {
          running.delete(id);
          jobs.delete(id);
          // Frees the slot and the lane together, whichever way the run ended.
          state = remove(state, entry.runId, entry.project);
          ports.onChange();
          startReady();
        });
    }
  };

  return {
    queue: () => state,

    add(job) {
      // enqueue refuses a second run for a card, and that refusal belongs to the caller.
      state = enqueue(state, { runId: job.runId, cardKey: job.cardKey, lane: job.lane, project: job.project });
      jobs.set(idOf(job.runId, job.project), job);
      ports.onChange();
      startReady();
    },

    stop(runId, project) {
      const controller = running.get(idOf(runId, project));
      if (controller !== undefined) {
        // A run whose stop is already out is ending. Telling the board again changes nothing.
        if (controller.signal.aborted) return;
        // The slot is not freed here. The run frees it when it actually ends, which is the only
        // moment the engine is really gone.
        controller.abort();
        ports.onChange();
        return;
      }

      // A run that already ended is nothing to stop, and saying so is not an error. Asked by the full
      // name, so a stop that leaves the project out never takes another project's run off the queue.
      if (!jobs.delete(idOf(runId, project))) return;
      state = remove(state, runId, project);
      ports.onChange();
      startReady();
    },

    promote(runId, project) {
      // No start attempt here. Promote reorders the waiting jobs and frees neither a slot nor a
      // lane, so anything that could run would already be running.
      state = promoteInQueue(state, runId, project);
      ports.onChange();
    },

    resize(slots) {
      state = { ...state, slots };
      ports.onChange();
      startReady();
    },
  };
}
