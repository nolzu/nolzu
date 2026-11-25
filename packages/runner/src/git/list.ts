import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { WorktreeRow } from '@nolzu/protocol';
import { baseCommit } from './base.ts';
import { gitEnv } from './env.ts';
import { git, type GitResult } from './exec.ts';
import { parseStatus, parseWorktrees } from './porcelain.ts';
import { baseAdvice, dashedBase, notOwnRepository, repoFolder, worktreesFolder } from './worktree.ts';

export interface ListWorktreesOptions {
  projectPath: string;
  // Counted against this, not against the upstream, because the demo project has no remote.
  baseBranch: string;
  // The repository this call reads, as the scan names it: "." for the project folder itself, and
  // the folder name when the project holds several. One call reads one repository.
  repo?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

// Two numbers on one line, left then right, tab separated. Null when git refused the range: a
// killed or failed git prints nothing, and reading that as zero tells the person their card holds
// no work, which is the one direction this must never be wrong in.
const twoCounts = (result: GitResult): [number, number] | null => {
  if (result.code !== 0) return null;
  const [left = '0', right = '0'] = result.stdout.trim().split(/\s+/);
  return [Number(left) || 0, Number(right) || 0];
};

// Every card checkout sits at one depth under the project's own worktrees folder: the card root for
// the project folder, and one folder inside it for a child repository. A worktree the person added
// somewhere else is theirs, and one an agent added inside its own card is that card's business, so
// neither is a row of its own.
const underWorktrees = (path: string, roots: readonly string[], repo: string): boolean =>
  roots.some((root) => {
    if (!path.startsWith(`${root}${sep}`)) return false;
    const parts = path.slice(root.length + 1).split(sep);
    return repo === '.' ? parts.length === 1 : parts.length === 2 && parts[0] !== '' && parts[1] === repo;
  });

// One row per card worktree, for the Changes tab and for the cleanup. There is no dirty flag on
// the row: dirty is changed or untracked above zero, and the tab says which of the two it is.
export async function listWorktrees(options: ListWorktreesOptions): Promise<WorktreeRow[]> {
  const { projectPath, baseBranch } = options;
  const repo = options.repo ?? '.';
  const at = repoFolder(projectPath, repo);
  const dashed = dashedBase(baseBranch);
  if (dashed !== null) throw new Error(dashed);
  // Built here rather than passed through. A stray GIT_DIR points every answer at another
  // repository, and an undefined environment is this process's own, where one can sit.
  const env = gitEnv(options.env ?? process.env);
  const run = (args: readonly string[]) => git(args, { cwd: at, env, signal: options.signal });
  const stray = await notOwnRepository(at, repo, env, options.signal);
  if (stray !== null) throw new Error(stray);

  // Resolved once, before any row is built. The commit is then what every count runs against, so a
  // tag sharing the base branch's name cannot make one row disagree with the next.
  const base = await baseCommit(run, baseBranch);
  // git answers 1 when the name is not there and 128 when the folder holds no repository at all.
  // Blaming the setting for the second sent the person to change a setting that was never wrong.
  if (base.code !== 0 && base.code !== 1) {
    throw new Error(`${at} is not a git repository, so its worktrees cannot be listed. ${base.stderr.trim()}`);
  }
  if (base.code !== 0) {
    throw new Error(`The base branch ${baseBranch} is not in this repository, so nothing can be counted against it. ${baseAdvice(repo)}`);
  }
  const baseAt = base.stdout.trim();

  const listed = await run(['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) {
    throw new Error(`The worktrees of ${at} could not be listed. ${listed.stderr.trim()}`);
  }

  // git prints resolved paths, so the project path is resolved too before they are compared. The
  // unresolved one stays in the list, because a path with no symlink in it never changes.
  const roots = [worktreesFolder(projectPath), worktreesFolder(realpathSync(projectPath))];
  const cards = parseWorktrees(listed.stdout).filter((entry) => underWorktrees(entry.path, roots, repo));

  const rows: WorktreeRow[] = [];
  for (const entry of cards) {
    // The full ref, never the short name. git resolves a short name against the tags first, so a
    // tag named after the card branch counted the tag, said the card was level with the base and
    // had nothing to push, and only warned on a stderr nobody reads. A detached worktree carries a
    // commit id, which is already unambiguous.
    const ref = entry.branch === null ? entry.head : `refs/heads/${entry.branch}`;
    const counted = await run(['rev-list', '--left-right', '--count', `${baseAt}...${ref}`]);
    const pair = twoCounts(counted);

    // git already marks a worktree prunable when it cannot reach its gitdir, so the status call is
    // only made for one it believes in. It can still fail, for a folder that went away between the
    // two calls, and that is reported the same way rather than as a clean checkout.
    const status = entry.prunable === null
      ? await git(['-C', entry.path, 'status', '--porcelain=v2', '--untracked-files=all'], { cwd: at, env, signal: options.signal })
      : null;
    const readable = status !== null && status.code === 0;
    // Each of the three is a card whose numbers cannot be trusted: git disowned the folder, the
    // folder would not be read, or the commits would not be counted.
    const stale = entry.prunable !== null || !readable || pair === null;
    const counts = readable ? parseStatus(status.stdout) : null;

    // Asked in the project and not in the worktree, so a card whose folder is gone still reports
    // what it has not pushed. The full remote ref comes back, for the same reason the branch does.
    const upstream = entry.branch === null
      ? null
      : await run(['rev-parse', '--verify', '--quiet', '--symbolic-full-name', `${entry.branch}@{upstream}`]);
    const tracked = upstream !== null && upstream.code === 0 ? upstream.stdout.trim() : null;
    // Null and not zero. A branch that tracks nothing has nowhere to push to, which is not the
    // same as a branch that is level with its remote.
    const unpushed = tracked === null
      ? null
      : twoCounts(await run(['rev-list', '--left-right', '--count', `${tracked}...${ref}`]))?.[1] ?? null;

    rows.push({
      repo,
      path: entry.path,
      branch: entry.branch,
      base: baseBranch,
      ahead: pair?.[1] ?? 0,
      behind: pair?.[0] ?? 0,
      changed: counts?.changed ?? 0,
      untracked: counts?.untracked ?? 0,
      unpushed,
      stale,
      // git's own words, so the person reads why rather than a sentence Nolzu made up.
      staleReason: !stale
        ? null
        : entry.prunable
          ?? (status !== null && status.code !== 0 ? status.stderr.trim() : null)
          ?? (pair === null ? counted.stderr.trim() : null)
          ?? 'the checkout could not be read',
    });
  }

  return rows;
}
