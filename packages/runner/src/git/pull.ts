import { gitEnv } from './env.ts';
import type { GitResult } from './exec.ts';
import { git } from './exec.ts';
import type { ExpectedPlaces } from './places.ts';

export interface BranchPullOptions {
  // The card's own checkout. Nothing else changes: the person's own folder and every other card's
  // checkout keep their files and their branch.
  worktreePath: string;
  // The checkout's repository, from Nolzu's record (`cardPlace`).
  repo: ExpectedPlaces;
  branch: string;
  remote: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

// `conflicts` names the files git could not join, which the checkout keeps with git's markers in them.
export type BranchPullResult = { ok: true; upToDate: boolean } | { ok: false; reason: string; conflicts: string[] };

const words = (result: GitResult): string => `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();

/**
 * Pulls the commits someone else pushed to the card's branch into the card's checkout, after a push
 * the remote turned down because it held them.
 *
 * A fetch of the one branch, then a merge into the checkout. A merge and not a rebase: it adds a commit
 * and rewrites none of the card's. A conflict stops there, with the merge left open and git's markers
 * in the files, because how to join two people's work is the person's call. The fetch updates the
 * remote's ref, which every checkout of the clone shares, and no checkout's files but this one.
 */
export async function pullBranch(options: BranchPullOptions): Promise<BranchPullResult> {
  const env = gitEnv(options.env ?? process.env);
  const run = (args: readonly string[], signal?: AbortSignal): Promise<GitResult> => git(args, { cwd: options.worktreePath, env, signal, repo: options.repo });

  // Only the fetch can be stopped: it waits on the network, and killing it leaves the checkout as it
  // was. A merge killed halfway would leave the files half written and the index locked.
  // The full ref, because git takes a tag of the same name over the branch for a short name.
  const fetched = await run(['fetch', '--no-tags', options.remote, `refs/heads/${options.branch}`], options.signal);
  if (fetched.code !== 0) return { ok: false, reason: words(fetched), conflicts: [] };

  // `--ff` so a person's `merge.ff = only` does not refuse the joining commit, and `--no-edit` because
  // nobody is at the terminal to write its message.
  const merged = await run(['merge', '--ff', '--no-edit', 'FETCH_HEAD']);
  if (merged.code === 0) return { ok: true, upToDate: /already up to date/i.test(merged.stdout) };

  // NUL separated, so a name with a space or a quote comes back as it is on disk.
  const unmerged = await run(['diff', '--name-only', '-z', '--diff-filter=U']);
  const conflicts = unmerged.stdout.split('\0').filter((path) => path !== '');
  return { ok: false, reason: words(merged), conflicts };
}
