import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting } from '@nolzu/core/node';
import { cloneRepository, type CloneOptions, type CloneProgress, type Cloned, cloneTarget, git, gitEnv } from '@nolzu/runner';
import { inTurn, readManifest, recordInRoot } from './manifest.ts';
import { scannedBase, writeRepoKnowledge } from './onboard.ts';
import { addToList, listedRepos, manifestState } from './projects.ts';

// The runner's clone. Tests pass one that clones a local bare repository, which the app never can.
export type Clone = (options: CloneOptions) => Promise<Cloned>;

// `added` names the folder a clone went into, so the answer can offer Learn this project for it.
type Answer = { said: string; added?: string } | { problem: string };
type Env = Record<string, string | undefined>;

export const SHAPE_ONE =
  'This project has one repository, so there is no list to add another one to. Use "Make this a workspace" in Settings, Project first, then add the repository there.';

// The folder a clone goes into, or why there is none.
function projectFolder(db: DatabaseSync): { project: string } | { problem: string } {
  const project = getSetting(db, 'projectPath');
  if (project === null) return { problem: 'There is no project set, so there is no folder to clone into.' };
  if (getSetting(db, 'repos') === null) return { problem: SHAPE_ONE };
  return { project };
}

/**
 * The branch a fresh clone's cards start from, or why there is none.
 *
 * With no base asked for it is the branch the clone is on, which is the remote's default. A base the
 * manifest names that is only on the remote gets its local branch here, because Nolzu made this clone
 * a moment ago and nothing of the person's is in it.
 */
async function cloneBase(project: string, folder: string, wanted: string | null, env: Env): Promise<{ base: string } | { reason: string }> {
  const run = (args: string[]) => git(args, { cwd: join(project, folder), env: gitEnv(env as Record<string, string>) });
  if (wanted !== null && (await run(['rev-parse', '--verify', '--quiet', `refs/heads/${wanted}`])).code !== 0) {
    const made = await run(['branch', '--quiet', '--track', wanted, `refs/remotes/origin/${wanted}`]);
    if (made.code !== 0) return { reason: `The base branch ${wanted} that the manifest names is not in ${folder}.` };
  }
  const on = wanted ?? (await run(['symbolic-ref', '--short', '--quiet', 'HEAD'])).stdout.trim();
  const base = on === '' ? ({ kind: 'detached', commit: '' } as const) : ({ kind: 'branch', name: on } as const);
  return scannedBase(project, { path: folder, base, remotes: [] }, env, 'add it again');
}

/**
 * What every new clone goes through after git cloned it: the base, the .gitignore line and the
 * manifest entry with their commit, the list, then the knowledge file.
 *
 * Until something is written for it, the clone is only a folder Nolzu made seconds ago, so a failure
 * there removes it. After that nothing is removed, and the sentence says what is there.
 */
async function settle(db: DatabaseSync, project: string, clone: { folder: string; url: string; base: string | null }, env: Env): Promise<Answer> {
  const drop = (problem: string): Answer => {
    rmSync(join(project, clone.folder), { recursive: true, force: true });
    return { problem };
  };
  const found = await cloneBase(project, clone.folder, clone.base, env);
  if ('reason' in found) return drop(`${found.reason} The clone was removed again.`);
  const base = found.base;

  const recorded = await recordInRoot(project, [{ folder: clone.folder, url: clone.url, base }], getSetting(db, 'workspace') === true, env);
  if (recorded.problem !== null && !recorded.recorded) return drop(`${recorded.problem} The clone was removed again.`);
  const notes = recorded.problem === null ? [] : [recorded.problem];

  const refused = addToList(db, [{ path: clone.folder, base }]);
  if (refused !== null) return { problem: [`The clone is at ${clone.folder}, but the list refused it. ${refused}`, ...notes].join(' ') };
  const knowledge = await writeRepoKnowledge(db, [{ path: clone.folder, base }], env);
  if (knowledge.problem !== null) notes.push(knowledge.problem);
  const files = knowledge.written.length === 0 ? '' : ` Wrote ${knowledge.written.join(', ')} in the knowledge folder.`;
  return { said: [`Added ${clone.folder}, starting from ${base}.${files}`, ...notes].join(' '), added: clone.folder };
}

/**
 * Clones a repository from its URL into the project folder and adds it, the way /projects and the
 * setup's workspace step both do. A project of one repository has no list to add to.
 */
export async function addRepository(db: DatabaseSync, url: string, env: Env = process.env, clone: Clone = cloneRepository): Promise<Answer> {
  const where = projectFolder(db);
  if ('problem' in where) return where;
  const { project } = where;
  return inTurn(project, async () => {
    const cloned = await clone({ workspace: project, url, env, taken: listedRepos(db).map((repo) => repo.path) });
    if (!cloned.ok) return { problem: cloned.reason };
    return settle(db, project, { folder: cloned.name, url: url.trim(), base: null }, env);
  });
}

/**
 * Clones each repository the manifest names that is not on disk, on the base the manifest names, or
 * only the one in `folder`, as its row's Clone asks.
 *
 * One that fails is named and the others still go, because a teammate may have no access to one of
 * them.
 */
export async function cloneMissing(db: DatabaseSync, env: Env = process.env, clone: Clone = cloneRepository, folder?: string): Promise<Answer> {
  const where = projectFolder(db);
  if ('problem' in where) return where;
  return inTurn(where.project, () => cloneEach(db, where.project, env, clone, folder));
}

async function cloneEach(db: DatabaseSync, project: string, env: Env, clone: Clone, folder: string | undefined): Promise<Answer> {
  const { missing } = manifestState(db);
  const wanted = readManifest(project).repos.filter((repo) => missing.includes(repo.folder) && (folder === undefined || repo.folder === folder));
  // The folder comes from a post, so one the manifest does not name as missing clones nothing.
  if (wanted.length === 0 && folder !== undefined) return { problem: `The manifest names no missing folder ${folder}, so nothing was cloned.` };
  if (wanted.length === 0) return { said: 'Every repository the manifest names is on disk already.' };

  const said: string[] = [];
  let added = 0;
  for (const repo of wanted) {
    // A listed repository whose folder went is cloned back into the same place.
    const taken = listedRepos(db)
      .map((one) => one.path)
      .filter((path) => path.toLowerCase() !== repo.folder.toLowerCase());
    const cloned = await clone({ workspace: project, url: repo.url, env, taken });
    const answer = cloned.ok ? await settle(db, project, { folder: cloned.name, url: repo.url, base: repo.base }, env) : { problem: `${repo.folder} was not cloned. ${cloned.reason}` };
    if ('said' in answer) added += 1;
    said.push('said' in answer ? answer.said : answer.problem);
  }
  // With nothing cloned the action failed, so the page shows it as a refusal.
  return added === 0 ? { problem: said.join(' ') } : { said: said.join(' ') };
}

// One clone the New project screen shows. `url` passed the clone rules, so it holds no login. `said`
// is the answer once the clone ended: what was added, or why nothing was.
export interface CloneJob {
  id: string;
  name: string;
  url: string;
  state: 'waiting' | 'cloning' | 'added' | 'failed';
  progress: CloneProgress | null;
  said: string | null;
}

export const CLONE_STOPPED = 'The clone was stopped, so nothing was added.';

// Limit: a finished job stays until the server stops, as a person adds a handful. Drop the
// finished ones when a screen can clear them.
const jobs = new Map<string, CloneJob[]>();
const stops = new Map<string, AbortController>();
const watchers = new Set<() => void>();
// Called from git's stderr handler, where a throw would end the server. A stream whose page went
// throws on its closed controller, so it stops being told.
const tell = (): void => {
  for (const watcher of [...watchers]) {
    try {
      watcher();
    } catch {
      watchers.delete(watcher);
    }
  }
};

// The clones of one project, in the order they were asked for.
export const cloneJobs = (project: string): readonly CloneJob[] => jobs.get(project) ?? [];

export function onCloneChange(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/**
 * Starts a clone in the background and answers at once. It waits for its turn behind any other clone
 * of the project, and its progress and its end reach the page through `cloneStream`.
 *
 * The URL passes the clone rules first, so a refused one, which can hold a token, never becomes a job
 * the stream would show. `failed` words every way the job can fail, a Stop while it waits included.
 */
export function startClone(db: DatabaseSync, url: string, env: Env = process.env, clone: Clone = cloneRepository, failed: (reason: string) => string = (reason) => reason): { job: CloneJob } | { problem: string } {
  const where = projectFolder(db);
  if ('problem' in where) return where;
  const target = cloneTarget(url, listedRepos(db).map((repo) => repo.path));
  if (!target.ok) return { problem: target.reason };
  const same = (job: CloneJob) => job.name.toLowerCase() === target.name.toLowerCase();
  const list = cloneJobs(where.project);
  if (list.some((job) => same(job) && (job.state === 'waiting' || job.state === 'cloning'))) return { problem: `${target.name} is being cloned already.` };

  const job: CloneJob = { id: randomUUID(), name: target.name, url: url.trim(), state: 'waiting', progress: null, said: null };
  // A new try takes the place of the one that failed, so the screen has one row per repository.
  jobs.set(where.project, [...list.filter((one) => !(same(one) && one.state === 'failed')), job]);
  const stop = new AbortController();
  stops.set(job.id, stop);
  const change = (patch: Partial<CloneJob>): void => {
    Object.assign(job, patch);
    tell();
  };
  // A clone that waits is stopped at once. One that runs ends when git is gone and its folder removed.
  stop.signal.addEventListener(
    'abort',
    () => {
      if (job.state === 'waiting') change({ state: 'failed', said: failed(CLONE_STOPPED) });
    },
    { once: true },
  );

  const running: Clone = async (options) => {
    if (stop.signal.aborted) return { ok: false, reason: CLONE_STOPPED };
    change({ state: 'cloning' });
    return clone({ ...options, signal: stop.signal, onProgress: (progress) => change({ progress }) });
  };
  addRepository(db, url, env, running)
    .then((answer) => change('said' in answer ? { state: 'added', said: answer.said } : { state: 'failed', said: failed(answer.problem) }))
    // Git missing from the PATH throws. The job ends, or the screen would show it cloning for ever.
    .catch((error: unknown) => change({ state: 'failed', said: failed(`The clone stopped with an error: ${(error as Error).message}`) }))
    .finally(() => stops.delete(job.id));
  tell();
  return { job };
}

// The job once it was added or failed, for a caller that answers only after the clone.
export function cloneEnded(job: CloneJob): Promise<CloneJob> {
  return new Promise((done) => {
    const check = (): void => {
      if (job.state !== 'added' && job.state !== 'failed') return;
      leave();
      done(job);
    };
    const leave = onCloneChange(check);
    check();
  });
}

// Stop on a clone that waits or runs. False when there is none by that id, or it has ended.
export function stopClone(id: string): boolean {
  const stop = stops.get(id);
  stop?.abort();
  return stop !== undefined;
}

// Every clone stopped, for Ctrl+C. git runs in a process group of its own, which the terminal's
// Ctrl+C does not reach, so without this it went on cloning after Nolzu was gone, into a folder
// nothing would finish or remove. Ends once each clone has killed git and removed its folder.
export async function stopAllClones(): Promise<void> {
  const open = [...jobs.values()].flat().filter((job) => job.state === 'waiting' || job.state === 'cloning');
  for (const stop of stops.values()) stop.abort();
  for (const stop of direct.keys()) stop.abort();
  await Promise.all([...open.map((job) => cloneEnded(job)), ...[...direct.values()].map((done) => done.catch(() => undefined))]);
}

// The clones Settings, Project starts with no job, each with the stop Ctrl+C reaches and the promise
// that ends once git is gone and the folder removed.
const direct = new Map<AbortController, Promise<unknown>>();
export function stoppable(clone: Clone = cloneRepository): Clone {
  return (options) => {
    const stop = new AbortController();
    const done = clone({ ...options, signal: options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]) });
    direct.set(stop, done);
    return done.finally(() => direct.delete(stop));
  };
}

/**
 * The clones of the project as an event stream. Each event is the whole list, as the board stream
 * sends whole snapshots, so a page that connects late or again has nothing to catch up on.
 */
export function cloneStream(db: DatabaseSync, request: Request): Response {
  const encode = new TextEncoder();
  let leave = (): void => undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    leave();
    clearInterval(beat);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (): void => {
        const project = getSetting(db, 'projectPath');
        controller.enqueue(encode.encode(`data: ${JSON.stringify(project === null ? [] : cloneJobs(project))}\n\n`));
      };
      send();
      leave = onCloneChange(send);
      // The board stream's beat. Not imported from it, because that pulls the browser's stream client
      // into the scripts that run this module under plain Node.
      beat = setInterval(() => controller.enqueue(encode.encode(': keep alive\n\n')), 15_000);
    },
    cancel: stop,
  });
  request.signal.addEventListener('abort', stop, { once: true });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' } });
}
