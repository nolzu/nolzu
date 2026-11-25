import type { GitResult } from './exec.ts';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';
import { withoutCredentials } from './remote.ts';

export interface PushOptions {
  // The card's own checkout, so the branch pushed is the one the card worked on.
  worktreePath: string;
  branch: string;
  remote: string;
  // The ref it lands on at the remote, such as the upstream's `refs/heads/main`. Defaults to the
  // branch of the same name.
  to?: string;
  // As on the commit: a pre-push hook runs only when the person turned hooks on for this push.
  hooks?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

// `rejected` is a push the remote turned down because it holds commits the branch has not got, the one
// failure a pull into the checkout can fix. `command` is the git command that ran, shown above its words.
export type PushResult = { ok: true; alreadyUpToDate: boolean } | { ok: false; reason: string; rejected?: boolean; command?: string };

// The sentence a person agrees to before anything leaves the machine. It names the branch and the
// remote exactly, and the URL goes through the credential stripper, because a clone made by CI
// carries its token there and this is the one line the person actually reads.
export function pushConfirmation(branch: string, remote: string, url: string): string {
  return `Push ${branch} to ${remote} at ${withoutCredentials(url)}.`;
}

// git says this on a push that sent nothing. It is not a failure: the branch is already there.
const UP_TO_DATE = /everything up-to-date/i;

// git's reason in brackets after `! [rejected]` when the remote branch moved on. A hook that refused
// the push reads `[remote rejected]` with a reason of its own, and a pull would not fix it.
const BEHIND = /\((fetch first|non-fast-forward)\)/;

export async function pushBranch(options: PushOptions): Promise<PushResult> {
  const env = gitEnv(options.env ?? process.env);
  const run = (args: readonly string[], hooks = false): Promise<GitResult> =>
    git(args, { cwd: options.worktreePath, env, signal: options.signal, hooks });

  // git reads a leading `+` as a forced push and a leading `-` as a flag, such as `--mirror`. A run
  // can point the card's checkout at a branch named either way.
  if (/^[+-]/.test(options.branch)) {
    return { ok: false, reason: `The checkout is on the branch ${options.branch}, and git would read its first character as a forced push or a flag. Rename the branch with git branch -m, then push.` };
  }

  // Asked before anything runs, so a project with no remote reads as one sentence rather than as
  // git's own error about a repository that does not exist.
  const named = await run(['remote']);
  if (named.code !== 0) {
    return { ok: false, reason: named.stderr.trim() };
  }
  const remotes = named.stdout.split('\n').map((name) => name.trim()).filter((name) => name !== '');
  if (!remotes.includes(options.remote)) {
    return {
      ok: false,
      reason: `This project has no remote called ${options.remote}, so there is nowhere to push. Add one with git remote add, then try again.`,
    };
  }

  // `-u` sets the upstream, so the next push and the ahead count both know where this branch lives.
  // No force flag on any path: the branch may hold work another machine pushed, and rewriting that
  // is not a decision this module gets to make.
  // `--no-follow-tags` because git exits non-zero when any ref in a push fails, not when the named
  // branch fails. With `push.followTags` in the person's own config, a branch and a tag travel
  // together: a rejected tag then leaves the branch on the remote while git reports failure, and
  // every retry says the same. One ref means the exit code answers the only question asked here.
  // The full name on the left: git reads a bare name such as `heads/main` as the branch it resolves
  // to, and a run can make the checkout's branch carry such a name. No right side unless the caller
  // names one, so a `remote.<name>.push` in the person's config, such as `refs/heads/*:refs/for/*`
  // for a review server, still decides where the branch lands, and with none it lands on its own name.
  // `push.default=current` for that last part: under `upstream` or `simple` git sends a source with no
  // right side to the branch's upstream, and a card branch made from `origin/main` tracks main.
  const args = ['-c', 'push.default=current', 'push', '--no-follow-tags', '-u', options.remote, options.to === undefined ? `refs/heads/${options.branch}` : `refs/heads/${options.branch}:${options.to}`];
  const pushed = await run(args, options.hooks === true);
  if (pushed.code !== 0) {
    // git's own text, word for word. It says what to do about a non fast forward better than any
    // sentence written here, and it is what the person would see on the command line.
    const reason = `${pushed.stderr.trim()}\n${pushed.stdout.trim()}`.trim();
    return { ok: false, reason, rejected: BEHIND.test(reason), command: `git ${args.join(' ')}` };
  }

  return { ok: true, alreadyUpToDate: UP_TO_DATE.test(`${pushed.stderr}${pushed.stdout}`) };
}
