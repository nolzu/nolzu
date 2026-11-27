import { baseCommit } from './base.ts';
import { git } from './exec.ts';
import type { ExpectedPlaces } from './places.ts';

export interface RenameOptions {
  // Each checkout of the card, with the base its branch started from and its place in Nolzu's record.
  checkouts: readonly { path: string; base: string; place: ExpectedPlaces }[];
  from: string;
  to: string;
  env: Record<string, string>;
  // A name the person picked. Their own commits do not stop it; only a push does.
  byPerson?: boolean;
}

/**
 * Why a checkout's branch counts as pushed, or null. An upstream or a copy on a remote means someone
 * outside this machine may know the name, so it stays.
 */
export async function pushedReason(run: (args: readonly string[]) => ReturnType<typeof git>, branch: string): Promise<string | null> {
  if ((await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).code === 0) {
    return `${branch} has an upstream, so it keeps its name.`;
  }
  const remote = (await run(['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes'])).stdout.split('\n');
  return remote.includes(branch) ? `A remote holds ${branch}, so it keeps its name.` : null;
}

/**
 * Renames the card's branch in each of its checkouts, while nothing outside this machine knows it.
 *
 * The branch is made at the first run, which can be before Refine wrote the words its name takes.
 * A branch with an upstream, a copy on a remote, or a commit of its own has been seen or built on,
 * so it keeps its name. Every checkout is checked before any is renamed, so the repositories of one
 * card never end up on two names. `reason` says why nothing changed, null when the name was right.
 */
export async function renameFreshBranch(options: RenameOptions): Promise<{ renamed: true } | { renamed: false; reason: string | null }> {
  const { from, to } = options;
  if (from === to || options.checkouts.length === 0) return { renamed: false, reason: null };
  for (const checkout of options.checkouts) {
    const run = (args: readonly string[]) => git(args, { cwd: checkout.path, env: options.env });
    const on = (await run(['branch', '--show-current'])).stdout.trim();
    if (on !== from) return { renamed: false, reason: `${checkout.path} is on ${on || 'no branch'}, not ${from}, so the branch keeps its name.` };
    const pushed = await pushedReason(run, from);
    if (pushed !== null) return { renamed: false, reason: pushed };
    if ((await run(['rev-parse', '--verify', '--quiet', `refs/heads/${to}`])).code === 0) {
      return { renamed: false, reason: `${to} is a branch already, so ${from} keeps its name.` };
    }
    if (options.byPerson === true) continue;
    const base = await baseCommit(run, checkout.base);
    const ahead = base.code === 0 ? (await run(['rev-list', '--count', `${base.stdout.trim()}..HEAD`])).stdout.trim() : '';
    if (ahead !== '0') return { renamed: false, reason: `${from} has commits of its own, so it keeps its name.` };
  }
  const moved: (typeof options.checkouts)[number][] = [];
  for (const checkout of options.checkouts) {
    const done = await git(['branch', '-m', from, to], { cwd: checkout.path, env: options.env, repo: checkout.place });
    if (done.code !== 0) {
      // Git can still refuse here, such as for a branch named `feature` when `to` is feature/APP-1/x.
      // The ones renamed already go back, so the card stays on one name.
      for (const back of moved) await git(['branch', '-m', to, from], { cwd: back.path, env: options.env, repo: back.place });
      return { renamed: false, reason: `Git refused to rename ${from} to ${to}, so it keeps its name. ${done.stderr.trim()}`.trim() };
    }
    moved.push(checkout);
  }
  return { renamed: true };
}
