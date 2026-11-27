import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRepos } from '@nolzu/core';
import { getSetting, reposOfCard } from '@nolzu/core/node';
import { type ChangeGroup, type Changes, hasUncommitted, hasWork } from '@nolzu/protocol';
import { cardCommits, cardPlace, cardDiff, commitCard, commitDiff, diffStat, draftedMessage, fileTree, filePatch, checkoutPath, git, gitEnv, isPlainName, listWorktrees, uncommittedDiff, unquotePath, type CommitResult, type FilePatch, type PushResult } from '@nolzu/runner';
import { commitMessagePrompt } from '@nolzu/skills';
import { projectName } from './app-header.ts';
import { cardRepo, noCheckout } from './checkout.ts';
import type { Loop } from './loop.ts';
import { publishFor, pushFor, type Publish } from './publish.ts';

const group = (entries: Parameters<typeof diffStat>[0]): ChangeGroup => ({ stat: diffStat(entries), tree: fileTree(entries) });

// The card's checkout of one repository as git reports it, with that repository's base and the
// checkouts inside it. Or the reason there is none.
type Checkout = { ok: true; project: string; real: string; baseBranch: string; nested: string[] } | { ok: false; reason: string };

function checkoutOf(db: DatabaseSync, key: string, repo: string): Checkout {
  // The key names the folder, so a key that is not one plain name could name another card's folder.
  if (!isPlainName(key)) return { ok: false, reason: `The card key ${JSON.stringify(key)} is not one plain name, so it names no checkout.` };

  const project = getSetting(db, 'projectPath');
  if (project === null) return { ok: false, reason: 'There is no project set, so this card has no checkout yet.' };
  const picked = cardRepo(db, key, repo);
  if (!picked.ok) return picked;

  // The same folder the loop checks the card out into.
  const path = checkoutPath(project, key, repo);
  if (!existsSync(path)) return { ok: false, reason: noCheckout(key, repo) };
  // Git reports the physical path, so the card's folder is compared and read the same way.
  return { ok: true, project, real: realpathSync(path), baseBranch: picked.base, nested: picked.nested };
}

const failed = (error: unknown): { ok: false; reason: string } => ({
  ok: false,
  // The runner's errors already name the problem and the setting that fixes it.
  reason: error instanceof Error ? error.message : String(error),
});

export async function changesFor(
  db: DatabaseSync,
  key: string,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
): Promise<Changes> {
  const at = checkoutOf(db, key, repo);
  if (!at.ok) return at;
  const given = env as Record<string, string>;
  try {
    const row = (await listWorktrees({ projectPath: at.project, baseBranch: at.baseBranch, repo, env: given, signal })).find((one) => one.path === at.real);
    if (row === undefined) return { ok: false, reason: `The checkout of ${key} is not a git worktree of the project, so there is nothing to compare.` };
    // Git lists a stale checkout but cannot read it, and the row says why.
    if (row.stale) return { ok: true, row, committed: null, uncommitted: null, untracked: [] };

    const diff = await cardDiff({ worktreePath: at.real, baseBranch: at.baseBranch, env: given, signal });
    // Asked of git and not read off the diff: a new file already staged is in the diff as added, and a
    // commit takes it whether it is ticked or not.
    const others = await git(['ls-files', '--others', '--exclude-standard'], { cwd: at.real, env: gitEnv(given), signal });
    const untracked = others.stdout.split('\n').filter((line) => line.trim() !== '').map(unquotePath);
    // A merge that stopped, such as a pull into the checkout, leaves these for the person to fix.
    const unmerged = await git(['diff', '--name-only', '-z', '--diff-filter=U'], { cwd: at.real, env: gitEnv(given), signal });
    const conflicted = unmerged.stdout.split('\0').filter((path) => path !== '');
    return {
      ok: true,
      row,
      committed: group(diff.committed),
      uncommitted: group(diff.uncommitted),
      untracked,
      ...(conflicted.length === 0 ? {} : { conflicted }),
      branch: diffStat(diff.branch),
      pushes: diffStat(diff.pushes),
      diff: group(diff.branch),
    };
  } catch (error) {
    return failed(error);
  }
}

export interface ChangeGroupOf {
  repo: string;
  // What the tab calls the repository: the root goes by its folder's name, so one repository is named too.
  name: string;
  changes: Changes;
  publish: Publish;
}

// One group per card repository, in the card's order, then one per other repository of the workspace,
// which says the card changes nothing there, so the switcher lists every repository. A card with no
// list yet still gets one group, and its reason says so. `view` is the tab's ?view: the commit list is
// read only for the Not committed view, and only for a repository with commits and nothing to commit,
// because that is the one case the view shows it.
export async function changeGroups(
  db: DatabaseSync,
  key: string,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  view: string | null = null,
): Promise<ChangeGroupOf[]> {
  const groups: ChangeGroupOf[] = [];
  const card = reposOfCard(db, key);
  const root = projectName(db) ?? '.';
  // Limit: one repository after the other, so a card with many does not start them all at once.
  for (const repo of card ?? ['.']) {
    const changes = await changesFor(db, key, env, signal, repo);
    // A repository the card did nothing in is folded on the tab with no push, so its remote and
    // upstream are not asked. A workspace of many repositories otherwise costs four git calls each.
    const publish: Publish = changes.ok && !hasWork(changes) ? { ok: false, reason: `${key} has nothing to push in ${repo === '.' ? root : repo}.` } : await publishFor(db, key, env, repo);
    groups.push({ repo, name: repo === '.' ? root : repo, changes, publish });
  }
  if (view !== 'all') {
    for (const one of groups) {
      if (!one.changes.ok || one.changes.row.ahead === 0 || hasUncommitted(one.changes)) continue;
      const at = checkoutOf(db, key, one.repo);
      if (!at.ok) continue;
      try {
        one.changes = { ...one.changes, commits: await cardCommits({ worktreePath: at.real, baseBranch: at.baseBranch, env: env as Record<string, string>, signal }) };
      } catch (error) {
        // The view still says there is nothing to commit, and says why the list is missing.
        one.changes = { ...one.changes, commits: { list: [], total: 0, reason: failed(error).reason } };
      }
    }
  }
  if (card === null) return groups;
  for (const { path } of projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') })) {
    if (card.includes(path)) continue;
    const untouched = { ok: false as const, reason: `${key} does not work in ${path}, so it has no changes there. The card's repositories are on its Settings tab.` };
    // The root is always on a card's list, so a repository the card leaves out goes by its path.
    groups.push({ repo: path, name: path, changes: untouched, publish: untouched });
  }
  return groups;
}

/**
 * The Changes tab's count in the card page head, "+29 -3": what is not committed in every card
 * repository, which is what the tab opens on. In Review with no commit it opens on the whole card
 * instead, and then the two are the same diff: with no commit of its own, the card's start and its last
 * commit hold the same files. "none yet" while the card has no checkout, and nothing when no file
 * waits for a commit.
 */
export async function changesCount(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let files = 0;
  let added = 0;
  let removed = 0;
  let held = false;
  for (const repo of reposOfCard(db, key) ?? ['.']) {
    // The whole read, because this runs on every load of the card page and a throw would fail it.
    try {
      const at = checkoutOf(db, key, repo);
      if (!at.ok || !existsSync(join(at.real, '.git'))) continue;
      held = true;
      const stat = diffStat((await cardDiff({ worktreePath: at.real, baseBranch: at.baseBranch, env: env as Record<string, string> })).uncommitted);
      files += stat.files;
      added += stat.added;
      removed += stat.removed;
    } catch {
      // The tab itself says why git could not read this checkout. A count is no place for that.
    }
  }
  if (!held) return { changes: 'none yet' };
  return files === 0 ? {} : { changes: `+${added} -${removed}` };
}

// One commit of the card's branch as a diff group, for the commit list of the Not committed view.
export async function commitChanges(
  db: DatabaseSync,
  key: string,
  commit: string,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
): Promise<{ ok: true; diff: ChangeGroup } | { ok: false; reason: string }> {
  const at = checkoutOf(db, key, repo);
  if (!at.ok) return at;
  if (!existsSync(join(at.real, '.git'))) return { ok: false, reason: `The checkout of ${key} is not a git worktree, so it has no commits to show.` };
  try {
    return { ok: true, diff: group(await commitDiff({ worktreePath: at.real, baseBranch: at.baseBranch, commit, env: env as Record<string, string>, signal })) };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The commit a comment on the card's diff is made on, once the file is checked against the change.
 * Refused for a repository the card does not work in and for a file its change does not touch, so no
 * comment names a file the diff never showed.
 */
export async function commentTarget(
  db: DatabaseSync,
  key: string,
  repo: string,
  file: string,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<{ ok: true; commit: string } | { ok: false; reason: string }> {
  const at = checkoutOf(db, key, repo);
  if (!at.ok) return at;
  if (!existsSync(join(at.real, '.git'))) return { ok: false, reason: `The checkout of ${key} is not a git worktree, so it has no diff to comment on.` };
  try {
    const diff = await cardDiff({ worktreePath: at.real, baseBranch: at.baseBranch, env: env as Record<string, string>, signal });
    const entry = diff.branch.find((one) => one.path === file);
    const where = repo === '.' ? '' : ` in ${repo}`;
    if (entry === undefined) return { ok: false, reason: `${key} does not change ${file}${where}, so it takes no comment.` };
    // A deleted file has no line in the folder, which is where a comment points.
    if (entry.status === 'deleted') return { ok: false, reason: `${key} deletes ${file}${where}, so it has no line to comment on.` };
    const head = await git(['rev-parse', 'HEAD'], { cwd: at.real, env: gitEnv(env as Record<string, string>), signal });
    if (head.code !== 0) return { ok: false, reason: `The checkout of ${key} has no commit to pin the comment to. ${head.stderr.trim()}` };
    return { ok: true, commit: head.stdout.trim() };
  } catch (error) {
    return failed(error);
  }
}

// The repository a request names, from its query or its body. No name means the root, so a request
// from a page of one repository needs none.
export function repoAsk(value: unknown): string {
  return value === undefined || value === null ? '.' : String(value);
}

// The folder part is resolved through links, and the file itself is not, so a link to one file
// stays readable: git shows a file link as the path it points to, never the file's contents.
function inside(root: string, path: string): boolean {
  const full = resolve(root, path);
  if (!full.startsWith(`${root}${sep}`)) return false;
  const folder = dirname(full);
  return !existsSync(folder) || `${realpathSync(folder)}${sep}`.startsWith(`${root}${sep}`);
}

// A child repository's checkout sits inside the root's, and its files belong to its own group. The
// path is relative to the root's checkout, so it is resolved there and compared by prefix.
function nestedAt(at: { real: string; nested: string[] }, path: string): string | undefined {
  const full = resolve(at.real, path);
  return at.nested.find((one) => full === join(at.real, one) || full.startsWith(`${join(at.real, one)}${sep}`));
}

// What the patch endpoint was asked, from its query, or null when the query does not say.
export function patchAsk(query: URLSearchParams): PatchAsk | null {
  const path = query.get('path');
  const group = query.get('group');
  const commit = query.get('commit');
  if (path === null || path === '' || (group !== 'committed' && group !== 'uncommitted' && group !== 'branch' && group !== 'commit')) return null;
  if (group !== 'commit') return { path, oldPath: query.get('old'), group };
  return commit === null || commit === '' ? null : { path, oldPath: query.get('old'), group, commit };
}

export interface PatchAsk {
  path: string;
  oldPath: string | null;
  // `branch` is the base to the folder, `uncommitted` what a commit would take now, and `commit` one
  // commit of the branch against its parent, named by `commit`.
  group: 'committed' | 'uncommitted' | 'branch' | 'commit';
  commit?: string;
}

// One file's patch, asked for when the person opens that file, so one large file never floods the page.
export async function patchFor(
  db: DatabaseSync,
  key: string,
  ask: PatchAsk,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
): Promise<FilePatch> {
  const at = checkoutOf(db, key, repo);
  if (!at.ok) return at;
  // A plain folder would let git find the project's own repository above it.
  if (!existsSync(join(at.real, '.git'))) return { ok: false, reason: `The checkout of ${key} is not a git worktree, so there is no patch to show.` };
  // An untracked file is read straight from the folder, so a path that leaves the checkout would
  // show any file on the disk: by climbing with .., or through a folder link that points outside.
  for (const path of [ask.path, ask.oldPath]) {
    if (path !== null && !inside(at.real, path)) {
      return { ok: false, reason: `${path} is not inside the card's checkout, so it is not shown.` };
    }
    const other = path === null ? undefined : nestedAt(at, path);
    if (other !== undefined) return { ok: false, reason: `${path} is in the checkout of ${other}, so it is shown in that group.` };
  }
  try {
    return await filePatch({
      worktreePath: at.real,
      baseBranch: at.baseBranch,
      path: ask.path,
      ...(ask.oldPath === null ? {} : { oldPath: ask.oldPath }),
      group: ask.group,
      ...(ask.commit === undefined ? {} : { commit: ask.commit }),
      env: env as Record<string, string>,
      signal,
    });
  } catch (error) {
    return failed(error);
  }
}

// A run of the card writes into this checkout, so a commit now, or a message about it, would take
// half done work.
function busy(db: DatabaseSync, key: string, doing: string): string | null {
  const card = db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string } | undefined;
  return card !== undefined && (card.state === 'queued' || card.state === 'running')
    ? `${key} is ${card.state}, and its run writes into this checkout. ${doing} once the run ends.`
    : null;
}

// A message for the work a commit would take, asked of the engine when the person presses one of the
// two buttons. Nothing is drafted ahead: no phase writes a message, so a person who types their own
// spends nothing.
export async function messageFor(
  db: DatabaseSync,
  key: string,
  short: boolean,
  write: Loop['writeMessage'],
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
): Promise<{ ok: true; message: string; model?: string; cost?: number | null } | { ok: false; reason: string }> {
  const held = busy(db, key, 'Ask for a message');
  if (held !== null) return { ok: false, reason: held };
  const at = checkoutOf(db, key, repo);
  if (!at.ok) return at;
  if (!existsSync(join(at.real, '.git'))) return { ok: false, reason: `The checkout of ${key} is not a git worktree, so there is no change to write a message for.` };
  try {
    const diff = await uncommittedDiff({ worktreePath: at.real, env: env as Record<string, string>, signal });
    if (diff === '') return { ok: false, reason: `${key} has no uncommitted change, so there is nothing to write a message for.` };
    // Only this repository's change goes in, so each group's message is about its own commit.
    const answer = await write(key, commitMessagePrompt(diff, short), signal, repo);
    if (!answer.ok) return answer;
    const message = draftedMessage(answer.answer, short);
    if (message === '') return { ok: false, reason: 'The engine answered with no message. Press the button again, or write your own.' };
    // The push dialog names the model and the cost the run reported, never an estimate.
    return { ok: true, message, ...(answer.model === undefined ? {} : { model: answer.model }), ...(answer.cost === undefined ? {} : { cost: answer.cost }) };
  } catch (error) {
    return failed(error);
  }
}

// The message request's body: { short }, true for a subject alone.
export function messageAsk(body: unknown): { short: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { short } = body as { short?: unknown };
  return typeof short === 'boolean' ? { short } : null;
}

// Commits the card's work as the person confirmed it: the tracked changes, and the untracked files
// they ticked. Git's own words come back when it refuses, a failing hook's included. The repository's
// hooks run only when the person ticked Run hooks for this commit, because an agent wrote the work.
export async function commitFor(
  db: DatabaseSync,
  key: string,
  message: string,
  include: readonly string[],
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
  hooks = false,
  // Every ticked path, tracked ones too. Given, the commit takes exactly these, and `include` is not read.
  only?: readonly string[],
): Promise<CommitResult> {
  const held = busy(db, key, 'Commit');
  if (held !== null) return { ok: false, reason: held };
  const at = checkoutOf(db, key, repo);
  if (!at.ok) return at;
  if (!existsSync(join(at.real, '.git'))) return { ok: false, reason: `The checkout of ${key} is not a git worktree, so there is nothing to commit.` };
  // Ticking a child's folder in the root would commit a pointer to the card's own checkout of it.
  for (const path of only ?? include) {
    const other = nestedAt(at, path);
    if (other !== undefined) return { ok: false, reason: `${path} is in the checkout of ${other}, so it is committed in that group.` };
  }
  try {
    return await commitCard({ worktreePath: at.real, repo: cardPlace(at.project, key, repo), message, include, ...(only === undefined ? {} : { only }), hooks, env: env as Record<string, string>, signal });
  } catch (error) {
    return failed(error);
  }
}

/**
 * A commit and then a push in one request, which the push route takes when a message comes with it. The
 * Changes tab sends a push alone, because Commit and Push are separate there. The press is the consent
 * for both. A refused
 * commit sends nothing. A push the remote refuses after the commit leaves the commit in the checkout,
 * so the next press pushes it with nothing left to commit.
 */
export async function commitAndPush(
  db: DatabaseSync,
  key: string,
  confirmed: boolean,
  commit: { message: string; include: readonly string[]; hooks?: boolean; only?: readonly string[] },
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
): Promise<PushResult> {
  if (!confirmed) return { ok: false, reason: 'A push needs the confirmation first. Nothing was committed or sent.' };
  const made = await commitFor(db, key, commit.message, commit.include, env, signal, repo, commit.hooks, commit.only);
  if (!made.ok) return made;
  return pushFor(db, key, true, env, signal, repo, commit.hooks);
}

// The commit request's body: { message, include, hooks, only }. `only` names every ticked path, tracked
// ones too, and the commit takes exactly those; without it the tracked changes go in with the untracked
// files `include` names. Hooks are on only for a literal true, so a missing or odd value keeps them skipped.
export function commitAsk(body: unknown): { message: string; include: string[]; hooks: boolean; only?: string[] } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { message, include = [], hooks, only } = body as { message?: unknown; include?: unknown; hooks?: unknown; only?: unknown };
  const paths = (value: unknown): value is string[] => Array.isArray(value) && value.every((path) => typeof path === 'string');
  if (typeof message !== 'string' || !paths(include) || (only !== undefined && !paths(only))) return null;
  return { message, include, hooks: hooks === true, ...(only === undefined ? {} : { only }) };
}
