import { existsSync, realpathSync } from 'node:fs';
import { git } from '@nolzu/runner';

/**
 * The check behind the "do not commit, do not push" of every Implement run, Fix runs among them.
 * The wall leaves the git folders writable and the network open, so the skill alone does not
 * stop a run from doing either. Each
 * checkout of the card is read right before the engine starts and again when the run ends: HEAD, and
 * the commit its upstream tracking ref points to. A move in either is a commit or a push the run made.
 * Nothing here undoes it: what to keep is the person's call. Read-only git, and no fetch, so a moved
 * upstream ref is one a push from the checkout moved.
 */

export interface Checkout {
  // The repository's path in the project, '.' for the root one.
  repo: string;
  path: string;
}

export type Heads = { repo: string; head: string; upstream: { ref: string; commit: string | null } | null } | { repo: string; problem: string };

const out = async (args: string[], cwd: string, env: Record<string, string>): Promise<string | null> => {
  const result = await git(args, { cwd, env });
  return result.code === 0 ? result.stdout.trim() : null;
};

async function readOne(checkout: Checkout, env: Record<string, string>): Promise<Heads> {
  const { repo, path } = checkout;
  if (!existsSync(path)) return { repo, problem: `there is no checkout at ${path}` };
  // A checkout sits inside the project folder, so git in a folder that lost its .git answers for the
  // project's own repository instead.
  const top = await out(['rev-parse', '--show-toplevel'], path, env);
  if (top === null || realpathSync(top) !== realpathSync(path)) return { repo, problem: `${path} is not a git checkout` };
  const head = await out(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], path, env);
  if (head === null || head === '') return { repo, problem: `git could not read HEAD in ${path}` };
  // No upstream, or a detached HEAD, fails here, and then only HEAD is compared.
  const ref = await out(['rev-parse', '--symbolic-full-name', '@{upstream}'], path, env);
  if (ref === null || ref === '') return { repo, head, upstream: null };
  // A branch can name an upstream that was never fetched, so its ref is not there yet.
  return { repo, head, upstream: { ref, commit: (await out(['rev-parse', '-q', '--verify', `${ref}^{commit}`], path, env)) || null } };
}

export const readHeads = (checkouts: readonly Checkout[], env: Record<string, string>): Promise<Heads[]> => Promise.all(checkouts.map((one) => readOne(one, env)));

const named = (repo: string): string => (repo === '.' ? 'the card checkout' : repo);
const short = (sha: string | null): string => (sha === null ? 'nothing' : sha.slice(0, 7));

/** The sentences for every checkout a run committed or pushed in, or could not be read, or null. */
export function runMoved(before: readonly Heads[], after: readonly Heads[], run: 'fix' | 'implement'): string | null {
  const said: string[] = [];
  for (const start of before) {
    const end = after.find((one) => one.repo === start.repo) ?? { repo: start.repo, problem: 'it was not read' };
    const where = named(start.repo);
    if ('problem' in start || 'problem' in end) {
      const when = 'problem' in start ? 'started' : 'ended';
      const why = 'problem' in start ? start.problem : (end as { problem: string }).problem;
      said.push(`Nolzu could not read ${where} when the ${run} run ${when} (${why}), so it cannot tell whether the run made a commit or pushed. Look at git log in the checkout before you commit from Changes.`);
      continue;
    }
    if (start.head !== end.head) {
      said.push(`The ${run} run made a commit in ${where} (${short(start.head)} to ${short(end.head)}). Nolzu does not commit for you. Look at git log in the checkout, keep or undo it, then commit from Changes.`);
    }
    const from = start.upstream?.commit ?? null;
    const to = end.upstream?.commit ?? null;
    if (from !== to) {
      const ref = (end.upstream ?? start.upstream)?.ref.replace(/^refs\/remotes\//, '') ?? 'its upstream';
      said.push(`The ${run} run pushed from ${where} (${ref} ${short(from)} to ${short(to)}). Nolzu does not push for you. Look at ${run === 'fix' ? 'the pull request' : 'the branch on GitHub'} and decide whether that push stays.`);
    }
  }
  return said.length === 0 ? null : said.join(' ');
}
