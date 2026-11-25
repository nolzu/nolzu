import type { GitResult } from './exec.ts';

export type RunGit = (args: readonly string[]) => Promise<GitResult>;

// The base branch as a commit, for every caller that counts against it. The branch ref is asked for
// first, because git resolves a short name against the tags before the branches, and a tag named
// after the base then hid the card's whole diff while only warning on a stderr nobody reads. A base
// that is not a local branch, such as `origin/main` or a tag someone chose on purpose, still
// resolves through the second call.
export async function baseCommit(run: RunGit, name: string): Promise<GitResult> {
  const onBranch = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
  return onBranch.code === 0 ? onBranch : run(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
}
