import { createScheduler, type Scheduler, type SchedulerPorts } from '@nolzu/core';

// What the one scheduler of a data folder needs from the loop of each project.
export interface ProjectPorts extends SchedulerPorts {
  // Stops one run of this project and closes its row, as a Stop press does.
  stop: (runId: number) => void;
  // Ctrl+C. An Ask run and a commit message pass take no slot, so the scheduler cannot stop them:
  // `leave` aborts them, and `left` settles once each Ask run has written its end.
  leave: () => void;
  left: () => Promise<void>;
}

export interface SharedScheduler {
  // A project's own view of the scheduler: its runs in the queue, the machine's slot count, and every
  // add, stop and promote under its id. One loop per project joins.
  join: (project: number, ports: ProjectPorts) => Scheduler;
  // A closed loop. The last one out drops the scheduler, as closing the one loop did before.
  leave: (project: number) => void;
  // Every project's runs, for the board: the slots line, a lane's holder and a run's place count them all.
  queue: Scheduler['queue'];
  // Ctrl+C for every project: no slot left, every run in the queue stopped by its own project, and done
  // once none runs and every Ask run has written its end.
  shutdown: () => Promise<void>;
}

// One per data folder, because the slots and the lanes belong to the machine. The
// caller holds the cache beside its loops, so a hot reload that drops the loops drops this with them.
export function sharedScheduler(shared: Map<string, SharedScheduler>, dataDir: string, slots: number): SharedScheduler {
  const already = shared.get(dataDir);
  if (already !== undefined) return already;

  const projects = new Map<number, ProjectPorts>();
  const portsOf = (project: number | undefined): ProjectPorts | undefined => (project === undefined ? undefined : projects.get(project));
  // Ctrl+C waits on these. They hear every change of the queue, whichever project made it.
  const waiters = new Set<() => void>();

  const scheduler = createScheduler(slots, {
    // Each run goes back to the loop of its own project, so its database, its card and its run row are
    // that project's. Not async: the scheduler catches a rejection, and a throw here would escape it.
    startJob(job, signal) {
      const ports = portsOf(job.project);
      if (ports === undefined) return Promise.reject(new Error(`Project ${job.project} has no loop open, so its run cannot start.`));
      return ports.startJob(job, signal, (event) => ports.onEvent?.(job.runId, event));
    },
    // A change in one project's runs moves the slots line and the places every other board shows.
    onChange() {
      for (const ports of [...projects.values()]) ports.onChange();
      for (const wait of [...waiters]) wait();
    },
  });

  const made: SharedScheduler = {
    join(project, ports) {
      // Two loops over one project would run each of its cards twice.
      if (projects.has(project)) throw new Error(`Project ${project} already has a loop open on ${dataDir}.`);
      projects.set(project, ports);
      // A card key and a run id mean something only inside one project, so the queue a loop reads holds
      // its own runs. The slot count is the machine's.
      const mine = (job: { project?: number }): boolean => job.project === project;
      return {
        queue: () => {
          const state = scheduler.queue();
          return { ...state, waiting: state.waiting.filter(mine), running: state.running.filter(mine) };
        },
        add: (job) => scheduler.add({ ...job, project }),
        stop: (runId) => scheduler.stop(runId, project),
        promote: (runId) => scheduler.promote(runId, project),
        resize: (count) => scheduler.resize(count),
      };
    },

    leave(project) {
      projects.delete(project);
      if (projects.size === 0 && shared.get(dataDir) === made) shared.delete(dataDir);
    },

    queue: () => scheduler.queue(),

    async shutdown() {
      // No slot first, so neither a freed slot nor a job the hub or a page sends now starts an engine.
      // An Ask run or a commit message pass asked for from now on ends before it starts, for the same reason.
      scheduler.resize(0);
      for (const ports of [...projects.values()]) ports.leave();
      const { waiting, running } = scheduler.queue();
      for (const job of [...waiting, ...running]) portsOf(job.project)?.stop(job.runId);
      await new Promise<void>((resolve) => {
        const ended = (): void => {
          if (scheduler.queue().running.length > 0) return;
          waiters.delete(ended);
          resolve();
        };
        waiters.add(ended);
        ended();
      });
      await Promise.all([...projects.values()].map((ports) => ports.left()));
    },
  };

  shared.set(dataDir, made);
  return made;
}
