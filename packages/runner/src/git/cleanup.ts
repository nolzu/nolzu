import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';
import { listWorktrees } from './list.ts';
import { projectPlace } from './places.ts';
import { ownFolder, withCardLock, withRepoLock } from './lock.ts';
import { checkoutPath, notOwnRepository, repoFolder } from './worktree.ts';
import { ignoredPaths, parseWorktrees, somePaths } from './porcelain.ts';

export interface RemoveWorktreeOptions {
  projectPath: string;
  key: string;
  branch: string;
  baseBranch: string;
  // Asked for by name, never defaulted. Assumption R: the branch is kept because a delete cannot be
  // undone, and the checkout can hold the only copy of work nobody pushed.
  force?: boolean;
  // The repository whose checkout goes: "." for the project folder, or one folder inside it.
  repo?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export type RemoveResult = { ok: true; stale: boolean } | { ok: false; reason: string };

const count = (many: number, one: string, more: string): string => `${many} ${many === 1 ? one : more}`;

// What the folder still holds. A folder that is gone and one holding nothing but a .DS_Store give
// the same answer, which is the rule worktree.ts already applies to this same question.
const holds = (at: string): 'nothing' | 'files' | 'unreadable' => {
  try {
    return readdirSync(at).some((entry) => entry !== '.DS_Store') ? 'files' : 'nothing';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'nothing' : 'unreadable';
  }
};

// A linked worktree's .git file points at an admin folder that names its common dir. A submodule's
// points at a whole git dir of its own, and the submodule checks below already cover that one.
const isLinkedCheckout = (at: string): boolean => {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(at, '.git'), 'utf8'))?.[1];
    return pointer !== undefined && existsSync(join(resolve(at, pointer.trim()), 'commondir'));
  } catch {
    return false;
  }
};

// Removes a card's checkout once the card is closed, and only when git can see that nothing would be
// lost. A checkout holding files git ignores, such as a .env, stays unless the removal is forced, as the
// card delete forces it after its confirm names them. Caches tools make again do not count. The branch
// stays behind either way, so anything committed is still reachable by name.
// Where a forced removal moves a checkout before git clears its entry, inside the repository's own
// folder. Whatever is there while the repository lock is held is past its git step, so it can go.
const REMOVING = 'nolzu-removing';
// A link in its place, which a run that may write the git folder could leave, is removed and never
// listed through: everything listed here is deleted. A link inside it is deleted as a link.
const asideLeft = (commonDir: string): string[] => {
  const at = join(commonDir, REMOVING);
  const found = lstatSync(at, { throwIfNoEntry: false });
  if (found?.isSymbolicLink() === true) unlinkSync(at);
  return found?.isDirectory() === true ? readdirSync(at).map((name) => join(at, name)) : [];
};
// Deletes what a removal that did not finish left aside, outside the locks, one line for each.
const deleteLeft = (paths: readonly string[]): void => {
  for (const path of paths) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.error(`Removed ${path}, a checkout an earlier removal moved aside and did not delete.`);
  }
};

/**
 * Deletes what a crash left in this repository's `.git/nolzu-removing`, for the boot. Listed under the
 * repository lock and deleted after it, as a removal does. A folder that is not a repository has
 * nothing to sweep.
 */
export async function sweepRemovals(repoPath: string, env?: Record<string, string | undefined>): Promise<void> {
  if (!existsSync(repoPath)) return;
  const common = await git(['rev-parse', '--git-common-dir'], { cwd: repoPath, env: gitEnv(env ?? process.env) });
  if (common.code !== 0) return;
  const dir = common.stdout.trim();
  const commonDir = isAbsolute(dir) ? dir : join(repoPath, dir);
  deleteLeft(await withRepoLock(commonDir, async () => asideLeft(commonDir)));
}

export async function removeWorktree(options: RemoveWorktreeOptions): Promise<RemoveResult> {
  const { projectPath, key, branch, baseBranch } = options;
  const repo = options.repo ?? '.';
  let at: string;
  try {
    at = repoFolder(projectPath, repo);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const env = gitEnv(options.env ?? process.env);
  const run = (args: readonly string[]) => git(args, { cwd: at, env, signal: options.signal, repo: projectPlace(projectPath, repo) });

  if (!existsSync(at)) {
    // A folder that is gone is the same kind of settings mistake as a folder that is no repository,
    // and the one below returns a reason. Without this, git's own failure to start in a missing
    // directory arrives as a rejected promise, which a confirmation screen cannot show.
    const fix = repo === '.' ? 'Set the project folder to one that exists.' : `Remove ${repo} from the project's repositories, or put its folder back.`;
    return { ok: false, reason: `${at} is not there, so there is no worktree to remove. ${fix}` };
  }

  const common = await run(['rev-parse', '--git-common-dir']);
  if (common.code !== 0) {
    return { ok: false, reason: `${at} is not a git repository, so there is no worktree to remove. ${common.stderr.trim()}` };
  }
  const stray = await notOwnRepository(at, repo, env, options.signal);
  if (stray !== null) return { ok: false, reason: stray };
  const dir = common.stdout.trim();
  // isAbsolute, not a test for a leading slash, because ensureWorktree answers this same question
  // about this same value that way. Two spellings of one rule can disagree, and when they do the
  // two callers take different locks, which is the one thing the lock below exists for.
  const commonDir = isAbsolute(dir) ? dir : join(at, dir);

  // A forced removal's folder, moved aside under the locks and deleted once they are released, so a
  // large checkout does not hold every other card of this repository while its files go.
  let discard: string | null = null;
  // What an earlier removal left there, read under the repository lock: anything in the folder then is
  // past its git step, a crash's leftover or another removal's that is about to go, so it is safe to
  // delete. Read under the lock, never deleted under it.
  let leftovers: string[] = [];

  // The same locks a checkout is made under, so a cleanup cannot run beside a card starting again, nor
  // remove or prune beside another card's build in this repository.
  const result = await withCardLock(join(commonDir, 'nolzu-locks'), key, () => withRepoLock(commonDir, async (): Promise<RemoveResult> => {
    leftovers = asideLeft(commonDir);
    // git prints resolved paths, so the project root is resolved once and the card path is built
    // from it. Comparing an unresolved path matches nothing wherever a folder on the way is a
    // symlink, and the suffix test that used to cover for that also accepted another card's folder.
    const target = checkoutPath(realpathSync(projectPath), key, repo);
    // A base branch setting naming a branch nobody has is the same class of mistake as the two above,
    // and the screen that confirms a removal shows all three, so it has to arrive as a sentence.
    let rows: Awaited<ReturnType<typeof listWorktrees>>;
    try {
      rows = await listWorktrees({ projectPath, baseBranch, repo, env: options.env, signal: options.signal });
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    const here = rows.find((row) => row.path === target);

    if (here === undefined) {
      // Nothing registered under this card. A worktree the person made somewhere else is not this
      // card's to touch, and neither is a folder git does not know about.
      return { ok: true, stale: false };
    }

    if (here.stale) {
      // Stale is wider than "git calls it prunable". list.ts also sets it when the status call
      // failed or the counts failed, and such a checkout is still registered and still on disk.
      // Nothing in it can be checked, and its index lives in the administrative folder, so clearing
      // the entry would take whatever was staged there with it.
      if (holds(target) !== 'nothing') {
        return {
          ok: false,
          reason:
            `${target} still holds files and git cannot read it, so nothing in it can be checked and clearing its entry would take anything staged there with it. Move the folder away yourself, then close the card again. ${here.staleReason ?? ''}`.trim(),
        };
      }
      // By path, never `worktree prune`. Prune reaches the whole repository, so it would also clear
      // the administrative folder of any other worktree whose own folder is away at that moment, an
      // unmounted drive or a restore, and that cannot be undone.
      //
      // git refuses to clear a checkout whose .git pointer is missing, and --force does not change
      // that (measured: exit 128 both ways), while a folder that a person emptied, or that Finder
      // left a .DS_Store in, is exactly that shape. The folder holds nothing, so it goes first and
      // the per path remove then does its work. Measured: `worktree remove` exits 0 once the folder
      // is gone, clears only that entry, and keeps the branch.
      rmSync(target, { recursive: true, force: true });
      const gone = await run(['worktree', 'remove', here.path]);
      if (gone.code !== 0) {
        return { ok: false, reason: `${target} could not be removed. ${gone.stderr.trim()}` };
      }
      return { ok: true, stale: true };
    }

    // A child repository's checkout sits inside the root one, and the root ignores it, so the counts
    // above miss its work. Removing the root would delete that checkout and leave its entry behind.
    if (repo === '.') {
      const inside = readdirSync(target).filter((entry) => isLinkedCheckout(join(target, entry)));
      if (inside.length > 0) {
        return { ok: false, reason: `${target} still holds the checkout of ${inside.join(', ')}, so removing it would delete that checkout too. Remove ${inside.join(', ')} first.` };
      }
    }

    // The branch the counted commits are actually on. The caller names the branch the card asked
    // for, and a person can rename it or put the checkout on another one, so the row is what the
    // sentences have to name.
    const on = here.branch ?? branch;
    const force = options.force ?? false;

    // A checkout on no branch. Its commits hang from the worktree's own HEAD, whose reflog lives in
    // the administrative folder git deletes with the checkout, so nothing the card keeps reaches
    // them. Assumption R keeps a branch, and here there is none, so this refusal stands even when
    // force was asked for by name. The refs are asked first, because a detached HEAD sitting on a
    // commit some branch already holds loses nothing, and refusing that would leave the card with
    // no way out at all.
    if (here.branch === null && here.ahead > 0) {
      const head = await run(['-C', target, 'rev-parse', 'HEAD']);
      const held = head.code === 0 ? await run(['branch', '--all', '--contains', head.stdout.trim()]) : null;
      if (held !== null && held.code === 0 && held.stdout.trim() === '') {
        return {
          ok: false,
          reason: `${target} is on no branch, and ${count(here.ahead, 'commit is', 'commits are')} held by nothing else, so removing it would leave nothing pointing at them. Put them on a branch first, with git switch -c inside the checkout.`,
        };
      }
    }

    if (force) {
      // git keeps a card submodule's object store inside this checkout's own administrative folder,
      // so removing the checkout takes that history with it. git stops a plain remove for exactly
      // that reason, and --force walks straight past the stop. The branch the card keeps does not
      // reach any of it, so this refusal stands even when force was asked for by name.
      const own = await run(['-C', target, 'rev-parse', '--absolute-git-dir']);
      if (own.code === 0 && holds(join(own.stdout.trim(), 'modules')) !== 'nothing') {
        return {
          ok: false,
          reason: `${target} holds a submodule whose history lives inside this checkout, so forcing would delete commits no branch can bring back. Push the submodule's work, or move the folder away yourself, then close the card again.`,
        };
      }
    }

    if (!force) {
      const dirty = here.changed + here.untracked;
      if (dirty > 0) {
        return {
          ok: false,
          reason: `${target} has ${count(dirty, 'uncommitted change', 'uncommitted changes')}, so it is not safe to remove. Commit them, or remove it yourself if they are not wanted.`,
        };
      }
      // `worktree remove` deletes the files git ignores with no word, a `.env` among them. Folders
      // tools make again, such as node_modules, are left out of the question.
      const listed = await run(['-C', target, 'status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal']);
      if (listed.code !== 0) return { ok: false, reason: `git could not list the files ${target} ignores, so it stays. ${listed.stderr.trim()}` };
      const { named } = ignoredPaths(listed.stdout);
      if (named.length > 0) {
        return {
          ok: false,
          reason: `${target} holds ${count(named.length, 'file or folder', 'files or folders')} git ignores (${somePaths(named)}), and removing the checkout would delete ${named.length === 1 ? 'it' : 'them'}. Move ${named.length === 1 ? 'it' : 'them'} away, or remove the checkout yourself.`,
        };
      }
      if (here.unpushed !== null && here.unpushed > 0) {
        return {
          ok: false,
          reason: `${count(here.unpushed, 'commit is', 'commits are')} not pushed, so removing this checkout would leave them only on this machine. Push ${on} first.`,
        };
      }
      if (here.unpushed === null && here.ahead > 0) {
        // Null is not proof there is no remote: it also covers a branch with no upstream yet, which
        // is the ordinary state of a card nobody pushed. The remotes are read before the sentence
        // names one, or it sends the person to merge when pushing is the fix.
        const remotes = (await run(['remote'])).stdout.trim();
        return {
          ok: false,
          reason:
            remotes === ''
              ? `${count(here.ahead, 'commit is', 'commits are')} not in ${baseBranch}, and this project has no remote to push to. Merge ${on} first, or remove the checkout yourself.`
              : `${count(here.ahead, 'commit is', 'commits are')} not pushed, so removing this checkout would leave them only on this machine. Push ${on} first.`,
        };
      }
    }

    if (force) {
      // Moved aside within the repository's own folder, the same disk, so the rename is instant and
      // nothing that reads the project sees it. git then clears the entry of a checkout whose folder
      // is gone (measured above: it exits 0 and keeps the branch), and the files go after the locks.
      // A crash between the rename and the delete leaves the folder there, and the next boot or the
      // next removal in this repository deletes it (`sweepRemovals`, `deleteLeft`).
      const aside = join(commonDir, REMOVING, `${key}-${randomUUID().slice(0, 8)}`);
      ownFolder(dirname(aside));
      let moved = false;
      try {
        renameSync(target, aside);
        moved = true;
      } catch (error) {
        // A checkout on another disk than the repository cannot be renamed there, and git removes it
        // in place below, under the locks as before.
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
          return { ok: false, reason: `${target} could not be moved aside to remove it. ${(error as Error).message}` };
        }
      }
      if (moved) {
        const cleared = await run(['worktree', 'remove', '--force', target]);
        if (cleared.code !== 0) {
          renameSync(aside, target);
          return { ok: false, reason: `${target} could not be removed. ${cleared.stderr.trim()}` };
        }
        discard = aside;
        return { ok: true, stale: false };
      }
    }

    const removed = await run(['worktree', 'remove', ...(force ? ['--force'] : []), target]);
    if (removed.code !== 0) {
      // git deletes what it can and then drops the administrative entry, so a failure is not proof
      // the checkout survived. A refusal made before any delete leaves it registered. Those two need
      // different sentences: one means try again, the other means move the folder away first.
      const listed = parseWorktrees((await run(['worktree', 'list', '--porcelain'])).stdout);
      if (!listed.some((entry) => entry.path === here.path)) {
        return {
          ok: false,
          reason: `${target} was partly removed. Git no longer tracks it and some of its files could not be deleted, so move the folder away before this card starts again. ${removed.stderr.trim()}`,
        };
      }
      return { ok: false, reason: `${target} could not be removed. ${removed.stderr.trim()}` };
    }

    return { ok: true, stale: false };
  }));
  deleteLeft(leftovers);
  if (discard !== null) rmSync(discard, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return result;
}
