import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { NO_REPOSITORY, projectRepos } from '@nolzu/core';
import { getSetting, reposOfCard } from '@nolzu/core/node';
import { refinedBranch } from '@nolzu/protocol';
import { baseCommit, branchName, branchNameProblem, cardPlace, checkoutPath, type ExpectedPlaces, git, gitEnv, isPlainName, parseStatus, readCardText, renameFreshBranch } from '@nolzu/runner';
import { isClosed } from './checkouts.ts';
import { cardFolder } from './files.ts';

export type CardRepo = { ok: true; base: string; nested: string[] } | { ok: false; reason: string };

/**
 * The card repository a request names, with the base it branches from, and the card's repositories
 * whose checkouts sit inside its checkout. The name comes from the request, so it is checked
 * against the card's list before it names any folder: `../x` is in no list.
 */
export function cardRepo(db: DatabaseSync, key: string, repo: string): CardRepo {
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  if (repos.length === 0) return { ok: false, reason: NO_REPOSITORY };
  // One repository needs no pick, so a card that has no row yet still reads the one there is.
  const card = repos.length === 1 ? repos.map((one) => one.path) : reposOfCard(db, key);
  if (card === null) return { ok: false, reason: `${key} has no repository list yet.` };
  const found = card.includes(repo) ? repos.find((one) => one.path === repo) : undefined;
  if (found === undefined) return { ok: false, reason: `${key} has no repository named ${JSON.stringify(repo)}.` };
  // Only the root's checkout holds others: each child repository's sits inside it.
  return { ok: true, base: found.base, nested: repo === '.' ? card.filter((one) => one !== '.') : [] };
}

// Not "yet": a closed card whose checkouts were removed gets no next run.
export const noCheckout = (key: string, repo: string): string =>
  `${key} has no checkout${repo === '.' ? '' : ` of ${repo}`}. A run makes one. A closed card has none once its checkouts are removed.`;

export type Checkout =
  | { ok: true; project: string; path: string; branch: string; base: string; place: ExpectedPlaces; run: (args: readonly string[]) => ReturnType<typeof git> }
  | { ok: false; reason: string };

/**
 * The card's own checkout of one repository, ready to run git in, or the sentence that says why there
 * is none.
 *
 * The word names what the caller wanted to do with it, so the refusal reads as one sentence. Every
 * push and every pull need the same four answers, and a second copy of them would drift.
 */
export async function checkoutOf(db: DatabaseSync, key: string, env: Record<string, string | undefined>, what: 'push' | 'pull', repo = '.'): Promise<Checkout> {
  const project = getSetting(db, 'projectPath');
  // The key names the folder, so a key that is not one plain name could name another card's checkout.
  if (!isPlainName(key) || project === null) return { ok: false, reason: `${key} has no checkout to ${what}.` };
  const picked = cardRepo(db, key, repo);
  if (!picked.ok) return picked;
  const at = checkoutPath(project, key, repo);
  if (!existsSync(join(at, '.git'))) return { ok: false, reason: noCheckout(key, repo) };
  const path = realpathSync(at);
  const forGit = gitEnv(env);
  const place = cardPlace(project, key, repo);
  const run = (args: readonly string[]) => git(args, { cwd: path, env: forGit, repo: place });
  const branch = (await run(['branch', '--show-current'])).stdout.trim();
  if (branch === '') return { ok: false, reason: `The checkout of ${key} is on no branch, so there is nothing to ${what}.` };
  return { ok: true, project, path, branch, base: picked.base, place, run };
}

// The card's branch is fixed at its first start. Worked out again from a title or a template that
// changed since, it would not match the checkout, and every later start would fail. So a checkout
// that is there keeps the branch it is on, and the template names only a new one.
// The first checkout that exists is asked, so a card whose root is a plain folder still keeps the
// branch its first repository is on. A run and PR watch both ask here, so they name one branch.
export async function cardBranch(db: DatabaseSync, key: string, targets: readonly string[], env: Record<string, string>): Promise<string> {
  for (const target of targets) {
    if (!existsSync(join(target, '.git'))) continue;
    const current = await git(['branch', '--show-current'], { cwd: target, env });
    if (current.code === 0 && current.stdout.trim() !== '') return current.stdout.trim();
  }
  return templateBranch(db, key);
}

/**
 * The branch the template names for a card now: its title, and the kind and words Refine wrote under
 * it in `refine/refined.md`. A card Refine has not run on yet gets the fallbacks `branchName` has.
 * A name the person typed on the card page wins over all of it. Throws for a template `branchName`
 * refuses.
 */
export function templateBranch(db: DatabaseSync, key: string, title?: string): string {
  const chosen = chosenBranch(db, key);
  if (chosen !== null) return chosen;
  const named = title ?? (db.prepare('SELECT title FROM cards WHERE key = ?').get(key) as { title: string } | undefined)?.title ?? '';
  const folder = cardFolder(db, key);
  // No brief yet, or one that cannot be read, such as a link a run left there: the name takes its fallbacks.
  const refined = (folder === null ? null : readCardText(folder, join('refine', 'refined.md'))) ?? '';
  return branchName(getSetting(db, 'branchTemplate'), key, named, refinedBranch(refined));
}

// The name the person typed on the card page, or null while the card keeps the template's.
export const chosenBranch = (db: DatabaseSync, key: string): string | null =>
  (db.prepare('SELECT branch FROM cards WHERE key = ?').get(key) as { branch: string | null } | undefined)?.branch ?? null;

// Every checkout the card has on disk, with the base its branch started from. A card with one
// repository needs no list row, the same as `cardRepo`.
export function cardCheckouts(db: DatabaseSync, key: string): { path: string; base: string; place: ExpectedPlaces }[] {
  const project = getSetting(db, 'projectPath');
  if (project === null || !isPlainName(key)) return [];
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  const picked = repos.length > 1 ? (reposOfCard(db, key) ?? []) : repos.map((repo) => repo.path);
  return picked
    .map((repo) => ({ path: checkoutPath(project, key, repo), base: repos.find((one) => one.path === repo)?.base ?? getSetting(db, 'baseBranch'), place: cardPlace(project, key, repo) }))
    .filter((one) => existsSync(join(one.path, '.git')));
}

/**
 * What the card's checkouts hold that no remote has: files not committed, and commits on no remote
 * branch and not in the base. A repository with no remote has nowhere to push, so its commits do not
 * count there.
 */
export async function unsentWork(db: DatabaseSync, key: string, env: Record<string, string | undefined>): Promise<{ files: number; commits: number }> {
  let files = 0;
  let commits = 0;
  const forGit = gitEnv(env);
  for (const one of cardCheckouts(db, key)) {
    const run = (args: readonly string[]) => git(args, { cwd: one.path, env: forGit });
    const status = await run(['status', '--porcelain=v2', '--untracked-files=all']);
    if (status.code === 0) {
      const counted = parseStatus(status.stdout);
      files += counted.changed + counted.untracked;
    }
    if ((await run(['remote'])).stdout.trim() === '') continue;
    const base = await baseCommit(run, one.base);
    const left = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes', ...(base.code === 0 ? [base.stdout.trim()] : []), '--']);
    if (left.code === 0) commits += Number(left.stdout.trim()) || 0;
  }
  return { files, commits };
}

/**
 * The branch name the person typed on the card page. Each checkout's branch takes it, while nothing
 * was pushed and no run writes there, and the card keeps it, so a card with no checkout yet starts on
 * it and Refine leaves it alone.
 */
export async function renameCardBranch(db: DatabaseSync, key: string, name: string, env: Record<string, string | undefined>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const card = db.prepare('SELECT state, board, stage FROM cards WHERE key = ?').get(key) as { state: string; board: string; stage: string } | undefined;
  if (card === undefined) return { ok: false, reason: `There is no card ${key} here.` };
  const { state } = card;
  if (isClosed(card.board, card.stage, getSetting(db, 'deliveryFlow'))) return { ok: false, reason: 'A closed card keeps its branch.' };
  if (state === 'queued' || state === 'running') return { ok: false, reason: `${key} is ${state}, and its run works on this branch. Rename it once the run ends.` };
  const problem = branchNameProblem(name, key);
  if (problem !== null) return { ok: false, reason: problem };
  const checkouts = cardCheckouts(db, key);
  if (checkouts.length > 0) {
    const forGit = gitEnv(env);
    const from = await cardBranch(db, key, checkouts.map((one) => one.path), forGit);
    const done = await renameFreshBranch({ checkouts, from, to: name, env: forGit, byPerson: true });
    if (!done.renamed && done.reason !== null) return { ok: false, reason: done.reason };
  }
  db.prepare('UPDATE cards SET branch = ? WHERE key = ?').run(name, key);
  return { ok: true };
}
