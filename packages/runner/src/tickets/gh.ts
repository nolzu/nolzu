import { cliRunner } from './cli.ts';
import type { RunGh } from './github.ts';

/**
 * The real `gh`, for the GitHub Issues adapter.
 *
 * The spawn itself is `cli.ts`, shared with `glab`. What is left here is what only `gh` has: where
 * the GitHub CLI is installed from, and the exit code it uses for a missing login.
 */

// What `gh` exits with when there is no login. Measured against gh 2.95.0 on 2026-09-25: an empty
// config folder with no token exits 4, prints nothing on stdout and asks for `gh auth login` on
// stderr. A wrong or expired token is a different state: it exits 1 with a body that says
// "Bad credentials", and that reads as a call that failed.
const NO_LOGIN = 4;

const INSTALL = 'Install the GitHub CLI from https://cli.github.com, then start Nolzu again.';
// One read here is one issue for one card, so the issue itself is the thing to open.
const CUT = 'Open the issue on GitHub instead.';

export interface GhOptions {
  // The PATH `gh` is looked up on. The login shell's by default, and a test's own folder in a test.
  path?: () => string;
  maxStdout?: number;
  // What to do about an answer over the cap, for a read that is not one issue, such as a CI log.
  cut?: string;
}

export function ghRunner(options: GhOptions = {}): RunGh {
  const run = cliRunner({ bin: 'gh', system: 'GitHub', install: INSTALL, ...options, cut: options.cut ?? CUT });

  return async (args, signal) => {
    const answer = await run(args, signal);
    // Before the adapter reads stdout, because there is no stdout: a logged out `gh` prints
    // nothing, and "the issue could not be read" would send the person looking at GitHub.
    if (answer.code === NO_LOGIN) {
      // The sentence reaches two places now: the Add card dialog, and a pr-review run that failed
      // because the diff could not be read. So it says to try again rather than to add the card.
      throw new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.');
    }
    return answer;
  };
}
