import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRepos } from '@nolzu/core';
import { getSetting } from '@nolzu/core/node';
import { commitPaths, git, gitEnv, outsideRepo, pushUpstream, readRepo, repoPatch, type CommitResult, type FilePatch, type PushResult, type RepoState, type WorkspaceFile } from '@nolzu/runner';
import { projectName } from './app-header.ts';
import { NOLZU_FILES } from './onboard.ts';
import { remoteEnv, stopAfter } from './publish.ts';

// The Workspace page: the project folder and each repository of the project, read from disk when the
// page opens and after a commit or a push. Never on a timer: git runs only when the person asks.

export interface WorkspaceRepo {
  // What every request names the repository by: '.' for the project folder, else its path in the
  // repository list. The server gave it out, so no request carries a folder of its own.
  id: string;
  // The project folder by its folder's name, a repository by its path.
  name: string;
  state: RepoState;
}

export type WorkspaceStatus = { ok: true; repos: WorkspaceRepo[]; changed: number; checkedAt: number } | { ok: false; reason: string };

interface Target {
  id: string;
  name: string;
  folder: string;
  skip: string[];
  nolzu: readonly string[];
}

// The project folder first, with the files Nolzu writes there, then every other repository. The folder
// leaves out the repositories inside it, the card checkouts and the card folders, whose files are not its own.
function targets(db: DatabaseSync): Target[] | null {
  const project = getSetting(db, 'projectPath');
  if (project === null) return null;
  const inner = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') })
    .map((repo) => repo.path)
    .filter((path) => path !== '.');
  return [
    { id: '.', name: projectName(db) ?? '.', folder: project, skip: [...inner, 'worktrees', '.tasks'], nolzu: NOLZU_FILES },
    ...inner.map((path) => ({ id: path, name: path, folder: resolve(project, path), skip: [], nolzu: [] })),
  ];
}

const NO_PROJECT = 'There is no project set, so there is no workspace to show.';

// Limit: the count of the last read, kept in this process. A restart forgets it, and the first page
// load reads again.
let last: { project: string; changed: number } | null = null;
let reading: Promise<unknown> | null = null;

/** Every folder of the workspace, one after the other. A folder that fails says why and the rest still read. */
export async function workspaceStatus(db: DatabaseSync, env: Record<string, string | undefined> = process.env, signal?: AbortSignal): Promise<WorkspaceStatus> {
  const all = targets(db);
  if (all === null) return { ok: false, reason: NO_PROJECT };
  const repos: WorkspaceRepo[] = [];
  for (const target of all) {
    let state: RepoState;
    try {
      state = await readRepo({ folder: target.folder, skip: target.skip, nolzuFiles: target.nolzu, env: gitEnv(env), signal });
    } catch (error) {
      state = { ok: false, reason: (error as Error).message };
    }
    repos.push({ id: target.id, name: target.name, state });
  }
  const changed = repos.reduce((sum, repo) => sum + (repo.state.ok ? repo.state.files.length : 0), 0);
  // A read the page left halfway has failed folders in it, and its count would be wrong.
  if (signal?.aborted !== true) last = { project: all[0]?.folder ?? '', changed };
  return { ok: true, repos, changed, checkedAt: Date.now() };
}

/**
 * The rail's changed-file count from the last read, with no git. Before the first read since the app
 * started, or after the project changed, it starts one read and does not wait for it, so no page load
 * waits on git.
 */
export function workspaceCount(db: DatabaseSync, env: Record<string, string | undefined> = process.env): number | null {
  const project = getSetting(db, 'projectPath');
  if (project === null) return null;
  if (last?.project === project) return last.changed;
  reading ??= workspaceStatus(db, env)
    .catch(() => null)
    .finally(() => {
      reading = null;
    });
  return null;
}

// One folder by the id the status gave out, and one changed file of it by its path. The file is checked
// against a fresh status and against leaving the folder, so a request reaches only what the page lists.
async function fileOf(
  db: DatabaseSync,
  id: string,
  paths: readonly string[],
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ ok: true; target: Target; files: WorkspaceFile[] } | { ok: false; reason: string }> {
  const target = targets(db)?.find((one) => one.id === id);
  if (target === undefined) return { ok: false, reason: `${JSON.stringify(id)} is not a folder of this workspace.` };
  const state = await readRepo({ folder: target.folder, skip: target.skip, nolzuFiles: target.nolzu, env: gitEnv(env), signal });
  if (!state.ok) return { ok: false, reason: `${target.name}: ${state.reason}` };
  const files: WorkspaceFile[] = [];
  for (const path of paths) {
    if (outsideRepo(target.folder, path)) return { ok: false, reason: `${path} is not inside ${target.name}, so Nolzu does not touch it.` };
    const file = state.files.find((one) => one.path === path);
    if (file === undefined) return { ok: false, reason: `${path} has no change in ${target.name}. Check again, then pick from the list.` };
    files.push(file);
  }
  return { ok: true, target, files };
}

/** One changed file's patch. */
export async function workspacePatch(db: DatabaseSync, id: string, path: string, env: Record<string, string | undefined> = process.env, signal?: AbortSignal): Promise<FilePatch> {
  const found = await fileOf(db, id, [path], env, signal);
  if (!found.ok) return found;
  const [file] = found.files;
  if (file === undefined) return { ok: false, reason: 'No file was named.' };
  try {
    return await repoPatch({ folder: found.target.folder, file, env: gitEnv(env), signal });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** Commits the ticked files of one folder, and nothing the person staged and left unticked. */
export async function workspaceCommit(
  db: DatabaseSync,
  ask: { repo: string; message: string; paths: string[]; hooks: boolean },
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<CommitResult> {
  const found = await fileOf(db, ask.repo, ask.paths, env, signal);
  if (!found.ok) return found;
  const project = getSetting(db, 'projectPath') ?? found.target.folder;
  return commitPaths({ folder: found.target.folder, repo: { project, workTree: found.target.folder }, message: ask.message, files: found.files, hooks: ask.hooks, env: gitEnv(env), signal });
}

/** Pushes the current branch of one folder to its upstream, only with the confirmation. */
export async function workspacePush(
  db: DatabaseSync,
  id: string,
  confirmed: boolean,
  hooks: boolean,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<PushResult> {
  if (!confirmed) return { ok: false, reason: 'A push needs the confirmation first. Nothing was sent.' };
  const target = targets(db)?.find((one) => one.id === id);
  if (target === undefined) return { ok: false, reason: `${JSON.stringify(id)} is not a folder of this workspace.` };
  const state = await readRepo({ folder: target.folder, skip: target.skip, env: gitEnv(env), signal });
  if (!state.ok) return { ok: false, reason: `${target.name}: ${state.reason}` };
  const forGit = await remoteEnv(env, (args) => git(args, { cwd: target.folder, env: gitEnv(env) }));
  return pushUpstream({ folder: target.folder, repo: { project: getSetting(db, 'projectPath') ?? target.folder, workTree: target.folder }, hooks, env: forGit, signal: stopAfter(signal) });
}

// The commit request's body: { repo, message, paths, hooks }. Hooks are on only for a literal true.
export function workspaceCommitAsk(body: unknown): { repo: string; message: string; paths: string[]; hooks: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { repo, message, paths, hooks } = body as { repo?: unknown; message?: unknown; paths?: unknown; hooks?: unknown };
  if (typeof repo !== 'string' || typeof message !== 'string' || !Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) return null;
  return { repo, message, paths, hooks: hooks === true };
}
