import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CLONE_TIMEOUT_MS } from './git/clone-into.ts';
import { gitEnv } from './git/env.ts';
import { git } from './git/exec.ts';
import { ghRunner } from './tickets/gh.ts';
import type { RunGh } from './tickets/github.ts';

/**
 * A new private repository on GitHub, made with the person's own `gh` login.
 *
 * Every call goes through `ghRunner`, so a missing gh and a gh with no login throw the same sentences
 * the ticket reads do. Nothing here can make a public repository: `--private` is the one visibility
 * `createPrivateRepo` passes.
 */

type Env = Record<string, string | undefined>;

const READ_MS = 30_000;

// GitHub's rule for a repository name: letters, digits, ".", "-" and "_", at most 100 characters.
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
// A user or organisation login: letters, digits and single dashes inside, at most 39 characters.
const LOGIN = /^(?=.{1,39}$)[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;

const lastLine = (text: string): string => text.trim().split('\n').at(-1)?.trim() ?? '';

// The logins in one gh answer, read as untrusted: it came over the network.
function logins(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((one: unknown) => (one as { login?: unknown } | null)?.login)
    .filter((login): login is string => typeof login === 'string' && LOGIN.test(login));
}

/**
 * Who a new repository can belong to: the signed-in account first, then its organisations. The owner
 * menu lists them, and Put on GitHub takes the first.
 */
export async function githubOwners(run: RunGh = ghRunner(), signal: AbortSignal = AbortSignal.timeout(READ_MS)): Promise<{ owners: string[] } | { problem: string }> {
  const user = await run(['api', 'user'], signal);
  const [login] = user.code === 0 ? logins(user.stdout) : [];
  if (login === undefined) return { problem: `gh could not read your GitHub account. ${lastLine(user.stderr)}`.trim() };
  // Limit: the first page, thirty organisations. Add --paginate when someone has more.
  const orgs = await run(['api', 'user/orgs'], signal);
  // A token without the org scope cannot list them, and the person's own account still works.
  return { owners: [login, ...(orgs.code === 0 ? logins(orgs.stdout) : [])] };
}

// Why a repository cannot be made under that owner and name, or null when GitHub has none by it.
export async function repoNameProblem(owner: string, name: string, run: RunGh = ghRunner(), signal: AbortSignal = AbortSignal.timeout(READ_MS)): Promise<string | null> {
  if (!LOGIN.test(owner)) return `${JSON.stringify(owner)} is not a GitHub account name.`;
  if (!REPO_NAME.test(name) || name === '.' || name === '..') {
    return `${JSON.stringify(name)} cannot be a repository name on GitHub. Use letters, digits, ".", "-" and "_".`;
  }
  const seen = await run(['repo', 'view', `${owner}/${name}`, '--json', 'name'], signal);
  if (seen.code === 0) return `github.com/${owner}/${name} exists already. Pick another name, or add that repository by its URL.`;
  // Only GitHub's own "not found" frees the name. A network error is no answer, and a name read as
  // free there would end in a create that fails.
  if (/Could not resolve to a Repository/.test(seen.stderr)) return null;
  return `gh could not check the name on GitHub. ${lastLine(seen.stderr)}`.trim();
}

/**
 * Makes `owner/name` on GitHub as a private repository from the local repository at `source`, and
 * pushes its branch there. gh adds `origin` to `source`, which is why `source` is always a copy Nolzu
 * made and never a folder of the person's.
 *
 * The URL is the one gh wrote into `origin`, in the protocol picked at `gh auth login`, so the clone
 * that follows uses the login the push used.
 */
export async function createPrivateRepo(
  source: string,
  owner: string,
  name: string,
  env: Env,
  run: RunGh = ghRunner(),
  signal: AbortSignal = AbortSignal.timeout(CLONE_TIMEOUT_MS),
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const made = await run(['repo', 'create', `${owner}/${name}`, '--private', '--source', source, '--remote', 'origin', '--push'], signal);
  if (made.code !== 0) return { ok: false, reason: `gh could not make github.com/${owner}/${name} or push to it. ${lastLine(made.stderr)}`.trim() };
  const origin = await git(['remote', 'get-url', 'origin'], { cwd: source, env: gitEnv(env) });
  const url = origin.stdout.trim();
  return { ok: true, url: origin.code === 0 && url !== '' ? url : `https://github.com/${owner}/${name}.git` };
}

/**
 * A copy of the person's repository to push from, at `to`: the branch they are on with its history,
 * and no remote. Their own folder is only read, so it keeps its branches, its files and its config.
 */
export async function copyToPush(from: string, to: string, env: Env): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  const base = gitEnv(env);
  const name = basename(from);
  // "--" so a folder whose name starts with "-" is never read as an option.
  const copied = await git(['clone', '--quiet', '--no-recurse-submodules', '--', from, to], { cwd: dirname(to), env: base });
  if (copied.code !== 0) return { ok: false, reason: `Git could not copy ${name}. ${lastLine(copied.stderr)}`.trim() };
  const run = (args: string[]) => git(args, { cwd: to, env: base });
  if ((await run(['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
    return { ok: false, reason: `${name} has no commit yet, so there is nothing to put on GitHub. Make a first commit in it, then try again.` };
  }
  const branch = (await run(['symbolic-ref', '--short', '--quiet', 'HEAD'])).stdout.trim();
  if (branch === '') return { ok: false, reason: `${name} is on no branch, so Nolzu cannot tell what to push. Check out a branch in it, then try again.` };
  // This origin is the person's folder, and gh adds its own. The other branches go with it.
  const dropped = await run(['remote', 'remove', 'origin']);
  if (dropped.code !== 0) return { ok: false, reason: `Git could not prepare the copy of ${name}. ${lastLine(dropped.stderr)}`.trim() };
  return { ok: true, branch };
}

/**
 * A new repository at `to` on main, with one commit that holds the readme, so the repository GitHub
 * gets is never empty: the clone into the workspace refuses an empty one. Null when it is made.
 */
export async function firstCommit(to: string, readme: string, env: Env): Promise<string | null> {
  try {
    mkdirSync(to);
  } catch (error) {
    return `Nolzu could not make the folder ${to}. ${(error as Error).message}`;
  }
  const base = gitEnv(env);
  const run = (args: string[]) => git(args, { cwd: to, env: base });
  writeFileSync(join(to, 'README.md'), readme);
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['commit', '-q', '-m', 'chore: first commit']]) {
    const done = await run(args);
    if (done.code !== 0) return `Git could not make the first commit. ${lastLine(done.stderr)}`.trim();
  }
  return null;
}
