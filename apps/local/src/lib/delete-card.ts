import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRepos } from '@nolzu/core';
import { addNotification, deleteCardRows, epicOfTask, getSetting, relatedCards } from '@nolzu/core/node';
import type { WorktreeRow } from '@nolzu/protocol';
import { projectPlace, baseCommit, branchNameProblem, checkoutPath, git, gitEnv, isPlainName, listWorktrees, removeWorktree, repoFolder } from '@nolzu/runner';
import { branchGoes, changedSince, type DeleteBranch, type DeleteFacts, deletePlan, type DeletePlan, type DeleteRepo, ignoredPaths, pickedUp, type SeenCheckout, seenOf } from './card-delete.ts';
import { templateBranch } from './checkout.ts';
import { cardFolder } from './files.ts';
import type { Loop } from './loop.ts';
import { appHeld } from './stack-action.ts';

/**
 * Delete card: the check the confirm shows, and the delete. The words are in `card-delete.ts`, the
 * database part is `deleteCardRows` in core, and this file reads git and removes the files.
 */

type Env = Record<string, string | undefined>;
type Live = Pick<Loop, 'db' | 'scheduler' | 'changed'>;

const said = (message: string, status: number): Response => new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } });

const plainEnv = (env: Env): Record<string, string> => Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

// What the confirm draws: the plan, and the card folder as the person finds it in the project, or null
// when the card has none.
// `seen` is what the confirm sends back with the delete: the counts it showed for each checkout.
// `keepsBranch` is whether a card branch stays, which the folder note names.
export type DeleteCheck = DeletePlan & { folder: string | null; seen: SeenCheckout[]; keepsBranch: boolean };

const isSeen = (value: unknown): value is SeenCheckout[] =>
  Array.isArray(value) &&
  value.every((one: unknown) => {
    const row = one as Partial<SeenCheckout> | null;
    return typeof row === 'object' && row !== null && typeof row.repo === 'string' && Number.isInteger(row.changed) && Number.isInteger(row.unpushed) && Number.isInteger(row.ignored);
  });

// The answer of a delete: what it said, what stayed by choice, and what failed to go. A failure also
// goes to the bell, so it is still there after the toast closes.
export interface Deleted {
  ok: true;
  said: string;
  stays: string[];
  failed: string[];
}

interface Read {
  facts: DeleteFacts;
  project: string | null;
}

// How many commits of `ref` are not in the base, and how many of those are on no remote branch as this
// clone last fetched. Null when git cannot count them. The base is resolved as the runner resolves it
// (`baseCommit`), so a tag named like the base branch cannot stand in for it.
async function countsOf(cwd: string, ref: string, base: string, env: Env): Promise<{ ahead: number | null; unpushed: number | null }> {
  const run = (args: readonly string[]) => git(args, { cwd, env: gitEnv(plainEnv(env)) });
  const at = await baseCommit(run, base);
  if (at.code !== 0) return { ahead: null, unpushed: null };
  const counted = async (args: string[]) => {
    const answer = await run(['rev-list', '--count', ref, '--not', ...args, at.stdout.trim(), '--']);
    return answer.code === 0 ? Number(answer.stdout.trim()) || 0 : null;
  };
  return { ahead: await counted([]), unpushed: await counted(['--remotes']) };
}

// What the folder still holds, the rule removeWorktree applies to the same question: only a folder
// that is gone holds nothing. One that cannot be read may hold anything.
const holdsFiles = (at: string): boolean => {
  try {
    return readdirSync(at).some((entry) => entry !== '.DS_Store');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
};

// Files git ignores in a checkout, the folders tools make again left out, or null when git cannot say.
// --ignored=matching lists a folder once rather than every file in it, whatever showUntrackedFiles says,
// and -z gives the paths as they are, never quoted.
async function ignoredIn(at: string, others: readonly string[], env: Env): Promise<{ named: string[] | null; remade: string | null }> {
  const listed = await git(['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal'], { cwd: at, env: gitEnv(plainEnv(env)) });
  return listed.code === 0 ? ignoredPaths(listed.stdout, others) : { named: null, remade: null };
}

/**
 * Why removeWorktree would refuse this checkout even with force, or null. Asked before anything is
 * deleted, so a card is never half gone: the database row deleted and the checkout left behind.
 */
async function stuckOf(row: WorktreeRow, repo: string, env: Env): Promise<string | null> {
  const at = row.path;
  const run = (args: string[]) => git(args, { cwd: at, env: gitEnv(plainEnv(env)) });
  if (row.stale) {
    return holdsFiles(at) ? `git cannot read the checkout of ${where(repo)} and it still holds files, so nothing in it can be checked. Move the folder ${at} away yourself, then delete the card. ${row.staleReason ?? ''}`.trim() : null;
  }
  // Commits on no branch hang from the checkout's own HEAD, whose history goes with the checkout.
  if (row.branch === null && row.ahead > 0) {
    // for-each-ref and not branch --contains, which lists the checkout's own detached HEAD as a holder.
    const holders = await run(['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    if (holders.code !== 0 || holders.stdout.trim() === '') {
      return `The checkout of ${where(repo)} is on no branch, and ${row.ahead === 1 ? '1 commit is' : `${row.ahead} commits are`} held by nothing else. Put them on a branch first, with git switch -c inside the checkout, then delete the card.`;
    }
  }
  // A card submodule keeps its history inside the checkout's own git folder, which goes with it.
  const own = await run(['rev-parse', '--absolute-git-dir']);
  if (own.code === 0 && holdsFiles(join(own.stdout.trim(), 'modules'))) {
    return `The checkout of ${where(repo)} holds a submodule whose history lives inside it. Push the submodule's work, or move the folder ${at} away yourself, then delete the card.`;
  }
  return null;
}

const where = (repo: string): string => (repo === '.' ? 'the project folder' : repo);

async function reposOf(db: DatabaseSync, project: string, key: string, env: Env): Promise<DeleteRepo[]> {
  const repos: DeleteRepo[] = [];
  // The card lock and the folder both refuse a key that is no plain folder name, so it has no checkout.
  if (!isPlainName(key)) return repos;
  // The card's own branch by the name Nolzu gives it. A branch template a person broke throws here:
  // the checkouts are still read, and a branch is taken only from a checkout then.
  let named: string | null;
  try {
    named = templateBranch(db, key);
  } catch {
    named = null;
  }
  const all = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  for (const one of all) {
    let folder: string;
    try {
      folder = repoFolder(project, one.path);
    } catch {
      continue;
    }
    if (!existsSync(folder)) continue;
    // Only a branch that carries the card key, as every name Nolzu gives a card does, and never the
    // base. A checkout a person switched to the base or to a branch of their own leaves that branch alone.
    const own = (name: string | null): name is string => name !== null && name !== one.base && branchNameProblem(name, key) === null;
    const branchOf = async (name: string | null): Promise<DeleteBranch | null> => {
      if (!own(name)) return null;
      const ref = `refs/heads/${name}`;
      const exists = await git(['rev-parse', '--verify', '--quiet', ref], { cwd: folder, env: gitEnv(plainEnv(env)) });
      return exists.code === 0 ? { name, ...(await countsOf(folder, ref, one.base, env)) } : null;
    };
    let row: WorktreeRow | undefined;
    let unlisted: string | null = null;
    try {
      const target = checkoutPath(realpathSync(project), key, one.path);
      row = (await listWorktrees({ projectPath: project, baseBranch: one.base, repo: one.path, env: plainEnv(env) })).find((entry) => entry.path === target);
    } catch (error) {
      // Only a checkout on disk matters. A repository git cannot list holds no checkout of this card.
      if (existsSync(checkoutPath(project, key, one.path))) unlisted = (error as Error).message;
    }
    const base = { repo: one.path, base: one.base, checkout: true, changed: 0, ignored: [] as string[] | null, unpushed: null, branch: null, stuck: null };
    if (unlisted !== null) {
      // removeWorktree lists the same way, so it would refuse this checkout too.
      repos.push({ ...base, stuck: `git could not list the checkout of ${where(one.path)}, so it cannot be removed. ${unlisted}` });
      continue;
    }
    if (row !== undefined) {
      const stuck = await stuckOf(row, one.path, env);
      const unpushed = row.stale ? null : (await countsOf(row.path, 'HEAD', one.base, env)).unpushed;
      // The root of a workspace card holds the other repositories' checkouts, ignored.
      const others = one.path === '.' ? all.filter((other) => other.path !== '.').map((other) => other.path) : [];
      const { named: ignored, remade } = row.stale ? { named: [], remade: null } : await ignoredIn(row.path, others, env);
      const branch = await branchOf(own(row.branch) ? row.branch : named);
      repos.push({ ...base, changed: row.changed + row.untracked, ignored, remade, unpushed, branch, stuck });
      continue;
    }
    // No checkout, as after the card closed: the branch it worked on can still be there.
    const branch = await branchOf(named);
    if (branch !== null) repos.push({ ...base, checkout: false, ignored: [], branch });
  }
  return repos;
}

async function read(live: Live, key: string, env: Env): Promise<Read | null> {
  const { db } = live;
  const card = db.prepare('SELECT board, state, source, stack_state FROM cards WHERE key = ?').get(key) as { board: string; state: string; source: string; stack_state: string | null } | undefined;
  if (card === undefined) return null;
  const queue = live.scheduler.queue();
  const busy = db.prepare("SELECT state FROM runs WHERE card_key = ? AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1").get(key) as { state: 'queued' | 'running' } | undefined;
  const running = queue.running.some((job) => job.cardKey === key) || card.state === 'running' || busy?.state === 'running' ? 'running' : queue.waiting.some((job) => job.cardKey === key) || card.state === 'queued' || busy !== undefined ? 'queued' : null;
  // Only a press or a process this Nolzu holds refuses. The stored state outlives a restart, and often
  // nothing can reset it, so on its own it only warns.
  const held = appHeld(key);
  const appState = card.stack_state !== null && card.stack_state !== 'off';
  const tasks = card.board === 'epics' ? relatedCards(db, key).filter((one) => (db.prepare('SELECT board FROM cards WHERE key = ?').get(one.key) as { board: string } | undefined)?.board === 'delivery').map((one) => one.key) : [];
  const project = getSetting(db, 'projectPath');
  const repos = project === null ? [] : await reposOf(db, project, key, env);
  return { facts: { key, running, source: card.source === 'local' ? null : card.source, tasks, epic: epicOfTask(db, key)?.key ?? null, repos, appHeld: held, appState }, project };
}

// The card folder as the person finds it in the project, such as .tasks/APP-3.
function folderShown(db: DatabaseSync, key: string, env: Env): string | null {
  const folder = cardFolder(db, key, env);
  if (folder === null || !existsSync(folder)) return null;
  const project = getSetting(db, 'projectPath');
  return project === null ? folder : relative(project, folder);
}

/** The confirm of Delete card: what goes, what is lost, and the refusal. It reads and changes nothing. */
export async function deleteCheck(live: Live, key: string, env: Env = process.env): Promise<Response> {
  const found = await read(live, key, env);
  if (found === null) return said(`There is no card ${key} on the board, so there is nothing to delete.`, 404);
  const keepsBranch = found.facts.repos.some((repo) => repo.branch !== null && !branchGoes(repo));
  const check: DeleteCheck = { ...deletePlan(found.facts), folder: folderShown(live.db, key, env), seen: seenOf(found.facts.repos), keepsBranch };
  return new Response(JSON.stringify(check), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Deletes a card. The checks run again here, because the confirm may be old and a post can come from
 * anywhere, and a checkout that holds more work than the confirm showed (`seen`) is refused. The
 * database goes in one transaction first. The files go after the commit: each checkout, each branch
 * merged into its base, the run logs, and the card folder when asked for. The answer names what
 * stayed and what could not be removed.
 */
export async function deleteCard(live: Live, key: string, body: unknown, env: Env = process.env): Promise<Response> {
  const asked = (typeof body === 'object' && body !== null ? body : {}) as { folder?: unknown; seen?: unknown };
  if (asked.folder !== undefined && typeof asked.folder !== 'boolean') return said('Send folder as true or false: whether the card folder goes too.', 400);
  if (!isSeen(asked.seen)) return said('Send seen: the changed files, commits not pushed and ignored files the confirm showed for each checkout.', 400);
  const found = await read(live, key, env);
  if (found === null) return said(`There is no card ${key} on the board, so there is nothing to delete.`, 404);
  const plan = deletePlan(found.facts);
  if (plan.refused !== null) return said(plan.refused, 409);
  if (changedSince(found.facts.repos, asked.seen)) return said('The checkout changed since this confirm opened. Read what it holds now, then delete again.', 409);
  // Read while the card row is there: the folder name needs the project, the branch name needs the row.
  const folder = cardFolder(live.db, key, env);
  const shown = folderShown(live.db, key, env);

  // Asked again with nothing awaited before the transaction, so a press that began while git was read
  // still refuses. deleteCardRows cannot see this process's presses.
  if (appHeld(key)) return said(`${key} has its app started. Stop the app first, then delete the card.`, 409);
  const done = deleteCardRows(live.db, key);
  if ('refused' in done) return said(done.refused, 409);
  live.changed();

  const stays: string[] = [];
  const failed: string[] = [];
  let branchStays = false;
  let folderStays = false;
  const { project } = found;
  if (project !== null) {
    // Children first: the root's own removal refuses while a child sits inside it.
    const held = found.facts.repos.filter((repo) => repo.checkout);
    const ordered = [...held.filter((repo) => repo.repo !== '.'), ...held.filter((repo) => repo.repo === '.')];
    for (const repo of ordered) {
      const gone = await removeWorktree({ projectPath: project, key, branch: repo.branch?.name ?? '', baseBranch: repo.base, repo: repo.repo, force: true, env: plainEnv(env) });
      if (!gone.ok) failed.push(`The checkout of ${where(repo.repo)} could not be removed. ${gone.reason}`);
    }
    // The root folder of a workspace card only holds the children's checkouts. rmdir, so a file left in
    // it stops it. reposOf found no checkout for a key that is no plain name, and neither is this.
    const root = isPlainName(key) ? checkoutPath(project, key) : null;
    if (root !== null && failed.length === 0 && existsSync(root)) {
      try {
        rmSync(join(root, '.DS_Store'), { force: true });
        rmdirSync(root);
      } catch {
        failed.push(`The folder ${root} still holds other files, so it stays. Look inside and move them away yourself.`);
      }
    }
    for (const repo of found.facts.repos) {
      // reposOf never takes the base, and this says it again where -D runs.
      if (repo.branch === null || repo.branch.name === repo.base) continue;
      if (!branchGoes(repo)) {
        branchStays = true;
        stays.push(`The branch ${repo.branch.name} stays, so its commits are not lost.`);
        continue;
      }
      const cut = await git(['branch', '-D', '--', repo.branch.name], { cwd: repoFolder(project, repo.repo), env: gitEnv(plainEnv(env)), repo: projectPlace(project, repo.repo) });
      if (cut.code !== 0) failed.push(`The branch ${repo.branch.name} could not be deleted. ${cut.stderr.trim()}`);
    }
  }
  for (const log of done.logs) {
    try {
      rmSync(log, { force: true });
    } catch (error) {
      failed.push(`The run log ${log} could not be removed. ${(error as Error).message}`);
    }
  }
  if (folder !== null && shown !== null) {
    if (asked.folder === true) {
      try {
        rmSync(folder, { recursive: true, force: true });
      } catch (error) {
        failed.push(`The card folder ${shown} could not be removed. ${(error as Error).message}`);
      }
    } else {
      folderStays = true;
      stays.push(`The card folder ${shown} stays.`);
    }
  }
  // Whatever stays on disk under this key is what a card added later on it starts from.
  const later = pickedUp(folderStays, branchStays);
  if (later !== null) stays.push(later);
  if (failed.length > 0) {
    addNotification(live.db, { id: `delete:${key}:${Date.now()}`, kind: 'error', text: `Deleted ${key}, but not everything went. ${failed.join(' ')}` });
    live.changed();
  }
  const answer: Deleted = { ok: true, said: `Deleted ${key}.`, stays, failed };
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}
