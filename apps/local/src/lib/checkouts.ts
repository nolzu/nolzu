import { existsSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardFor, projectRepos } from '@nolzu/core';
import { getSetting } from '@nolzu/core/node';
import { type DeliveryFlow, isBoardKind } from '@nolzu/protocol';
import { checkoutPath, isPlainName, removeWorktree } from '@nolzu/runner';
import { templateBranch } from './checkout.ts';

// folder is the sentence about a card folder that is no checkout and still holds files, else null.
export type CheckoutsResult = { ok: true; removed: string[]; kept: { repo: string; reason: string }[]; folder: string | null } | { ok: false; reason: string };

const NO_PROJECT = 'There is no project set, so there is no checkout to remove.';

// The board's archive stage, read from the board rule, so a renamed stage needs no second copy here.
const archiveOf = (board: string, flow: DeliveryFlow) => (isBoardKind(board) ? boardFor(board, flow).stages.find((stage) => stage.role === 'archive') : undefined);

export const isClosed = (board: string, stage: string, flow: DeliveryFlow): boolean => archiveOf(board, flow)?.id === stage;

const plainEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/**
 * Removes the checkouts of one closed card, children before the root. A checkout stays when git
 * cannot show it is safe to lose.
 *
 * The repositories come from the project's list, not from the card's own list, because a checkout
 * made before the card's list changed still sits there. A folder for a repository no longer on the
 * list is not looked for. The branch is never deleted, so committed work stays reachable by name.
 */
export async function removeCardCheckouts(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): Promise<CheckoutsResult> {
  const card = db.prepare('SELECT board, stage, title FROM cards WHERE key = ?').get(key) as { board: string; stage: string; title: string } | undefined;
  if (card === undefined) return { ok: false, reason: `There is no card ${key}.` };
  if (!isClosed(card.board, card.stage, getSetting(db, 'deliveryFlow'))) {
    const last = archiveOf(card.board, getSetting(db, 'deliveryFlow'))?.label ?? 'its last stage';
    return { ok: false, reason: `${key} is not closed, so its checkouts stay. A card keeps them until it reaches ${last}.` };
  }
  const project = getSetting(db, 'projectPath');
  if (project === null) return { ok: false, reason: NO_PROJECT };
  // The card lock refuses a key that is no plain folder name by throwing, and only a hand edit writes one.
  if (!isPlainName(key)) return { ok: false, reason: `${key} cannot name a checkout folder, so there is none to remove.` };

  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  const root = checkoutPath(project, key);
  // A child counts once it has its .git. The root counts while its folder is there.
  const held = repos.filter((repo) => existsSync(repo.path === '.' ? root : join(checkoutPath(project, key, repo.path), '.git')));
  // Children first: the root's own removal refuses while a child sits inside it.
  const ordered = [...held.filter((repo) => repo.path !== '.'), ...held.filter((repo) => repo.path === '.')];
  const branch = templateBranch(db, key, card.title);
  const removed: string[] = [];
  const kept: { repo: string; reason: string }[] = [];
  for (const repo of ordered) {
    const done = await removeWorktree({ projectPath: project, key, branch, baseBranch: repo.base, repo: repo.path, env: plainEnv(env) });
    const at = checkoutPath(project, key, repo.path);
    if (!done.ok) kept.push({ repo: repo.path, reason: done.reason });
    // removeWorktree answers ok for a path git has no checkout at, and leaves the folder alone. The
    // root of a card whose list has no "." is such a folder, and the plain folder step below takes it.
    else if (!existsSync(at)) removed.push(repo.path);
    else if (repo.path !== '.') kept.push({ repo: repo.path, reason: `git has no checkout at ${at}, so Nolzu leaves the folder alone. Move it away yourself.` });
  }

  // A root that is no checkout is a plain folder the loop made to hold the children. Left there, it
  // would still decide where a later refine or plan starts.
  let folder: string | null = null;
  if (kept.length === 0 && existsSync(root)) {
    // rmdir, not a recursive remove, so a checkout made after the look still stops it.
    try {
      rmSync(join(root, '.DS_Store'), { force: true });
      rmdirSync(root);
    } catch {
      folder = `The card folder ${root} still holds other files, so it stays. Look inside and move them away yourself.`;
    }
  }
  return { ok: true, removed, kept, folder };
}

const where = (repo: string): string => (repo === '.' ? 'the project folder' : repo);

// One sentence for the card page: what went, and each checkout that stayed with its reason.
export function checkoutsSaid(key: string, done: Extract<CheckoutsResult, { ok: true }>): string {
  if (done.removed.length === 0 && done.kept.length === 0 && done.folder === null) return `${key} has no checkout.`;
  const gone = done.removed.length === 0 ? '' : `Removed the checkout of ${done.removed.map(where).join(', ')}.`;
  const stays = done.kept.map((one) => `The checkout of ${where(one.repo)} stays. ${one.reason}`);
  return [gone, ...stays, done.folder ?? ''].filter((part) => part !== '').join(' ');
}

/**
 * Removes the checkouts of every closed card, for the Projects page.
 *
 * One card at a time, because each takes its own lock. A card git refuses keeps its checkouts and
 * is named with the reason, and the rest still go.
 */
export async function removeClosedCheckouts(db: DatabaseSync, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (getSetting(db, 'projectPath') === null) return NO_PROJECT;
  const flow = getSetting(db, 'deliveryFlow');
  const rows = db.prepare('SELECT key, board, stage FROM cards ORDER BY key').all() as { key: string; board: string; stage: string }[];
  const closed = rows.filter((row) => isClosed(row.board, row.stage, flow));
  const cleared: string[] = [];
  const stays: string[] = [];
  for (const row of closed) {
    const done = await removeCardCheckouts(db, row.key, env);
    if (!done.ok) {
      stays.push(`${row.key} keeps its checkouts. ${done.reason}`);
      continue;
    }
    if (done.removed.length > 0) cleared.push(row.key);
    for (const one of done.kept) stays.push(`${row.key} keeps the checkout of ${where(one.repo)}. ${one.reason}`);
    if (done.folder !== null) stays.push(done.folder);
  }
  if (cleared.length === 0 && stays.length === 0) return 'No closed card has a checkout.';
  return [cleared.length === 0 ? '' : `Removed the checkouts of ${cleared.join(', ')}.`, ...stays].filter((part) => part !== '').join(' ');
}
