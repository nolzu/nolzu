import type { FailedRun } from '@nolzu/protocol';
import type { RunGh } from './github.ts';

/**
 * The failed CI runs of a repository's default branch, through `gh`.
 *
 * NOT RECORDED. Every field name below is written from the REST API's shape and not from an answer
 * this project has read, because reading one would be a call to GitHub. The test beside this file
 * says what a first real recording has to confirm. Until then treat a CI finding as unverified.
 *
 * Read-only, the same way `github.ts` is: `-X GET` on every call, because `gh api` with a `-f` field
 * defaults to POST.
 */

// The same name rule `github.ts` uses, so a typed owner or repository cannot extend a path.
const NAME = /^[A-Za-z0-9._-]+$/;

// The API caps a page at 100. Above it the call is refused rather than cut.
const MAX_PAGE = 100;

/** The repository's default branch, or null when the answer did not name one. */
export function defaultBranch(stdout: string): string | null {
  try {
    const body = JSON.parse(stdout) as { default_branch?: unknown };
    return typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : null;
  } catch {
    return null;
  }
}

/**
 * The failed runs in one answer.
 *
 * `conclusion` is asserted here as well as asked for in the query. The filter is the server's and
 * this is ours: a run that came back with any other conclusion is dropped, so a passing run can
 * never become a finding because a query field was spelled wrong or was ignored.
 *
 * A body with no `workflow_runs` is a refusal and not an empty list. A rate limited or unauthorised
 * `gh api` prints readable JSON with no rows in it, and an empty list would read as a repository
 * whose CI is green.
 */
export function readRuns(repo: string, branch: string, stdout: string): readonly FailedRun[] {
  let body: { workflow_runs?: unknown };
  try {
    body = JSON.parse(stdout) as typeof body;
  } catch {
    throw new Error(`GitHub answered the CI runs of ${repo} with something Nolzu could not read. Run gh api repos/${repo}/actions/runs in a terminal to see what it says.`);
  }
  if (!Array.isArray(body.workflow_runs)) {
    throw new Error(`GitHub did not list the CI runs of ${repo}. Check that the repository name is right and that gh may read its Actions.`);
  }
  const found: FailedRun[] = [];
  for (const row of body.workflow_runs as { id?: unknown; name?: unknown; conclusion?: unknown; head_branch?: unknown }[]) {
    if (row.conclusion !== 'failure') continue;
    if (typeof row.id !== 'number' || !Number.isInteger(row.id)) continue;
    // A run of another branch is dropped rather than relabelled. The branch is part of what the
    // finding is about, so reporting it under the default branch would be a claim nobody measured.
    if (typeof row.head_branch === 'string' && row.head_branch !== branch) continue;
    found.push({ repo, workflow: typeof row.name === 'string' && row.name !== '' ? row.name : 'CI', branch, id: row.id });
  }
  return found;
}

/**
 * Two calls: which branch is the default one, then its failed runs.
 *
 * The branch is asked for rather than taken from the project's own git remote, because a source can
 * watch a repository this machine has no clone of.
 */
export async function failedRuns(run: RunGh, owner: string, repo: string, limit: number, signal: AbortSignal): Promise<readonly FailedRun[]> {
  if (!NAME.test(owner) || !NAME.test(repo)) {
    throw new Error(`${owner}/${repo} is not a repository name. Write it as owner/repo, such as acme/app.`);
  }
  const slug = `${owner}/${repo}`;
  const head = await run(['api', '-X', 'GET', `repos/${slug}`], signal);
  const branch = defaultBranch(head.stdout);
  if (branch === null) {
    throw new Error(`GitHub did not name the default branch of ${slug}. Check the repository name in the source on the Scout page, and that your gh login may read it.`);
  }
  const answer = await run(
    ['api', '-X', 'GET', `repos/${slug}/actions/runs`, '-f', `branch=${branch}`, '-f', 'status=failure', '-F', `per_page=${Math.min(limit, MAX_PAGE)}`],
    signal,
  );
  return readRuns(slug, branch, answer.stdout);
}
