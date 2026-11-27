import type { FailedRun } from '@nolzu/protocol';
import { ghRunner, type GhOptions } from './gh.ts';
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

// How much of a job's log Fix CI keeps. The error is near the end of a failed job, and the run reads
// the file, so the end is what it needs and the rest only costs tokens.
export const LOG_LINES = 300;
export const LOG_BYTES = 60_000;

/**
 * The end of a log: the last `lines` lines that fit in `bytes`, whether anything was cut, and how many
 * lines the whole log had. A last line longer than `bytes` alone keeps its end.
 */
export function trimLog(text: string, lines = LOG_LINES, bytes = LOG_BYTES): { text: string; cut: boolean; total: number } {
  const all = text.replace(/\r?\n$/, '').split(/\r?\n/);
  let from = all.length;
  let used = 0;
  while (from > 0 && all.length - from < lines) {
    const size = Buffer.byteLength(all[from - 1] ?? '', 'utf8') + 1;
    if (used + size > bytes) break;
    used += size;
    from -= 1;
  }
  // A character is at most four bytes, so this end fits whatever the text.
  if (from === all.length) return { text: (all.at(-1) ?? '').slice(-Math.floor(bytes / 4)), cut: true, total: all.length };
  return { text: all.slice(from).join('\n'), cut: from > 0, total: all.length };
}

// Limit: a job log over 32 MB is not read at all, because gh hands the whole answer over at once and
// only its end is kept. The check is then named with no log, and Fix CI goes on with the others.
export const LOG_MAX_STDOUT = 32_000_000;
export const LOG_TOO_LARGE = 'The log is larger than Nolzu reads. Open it on GitHub.';

/** The real `gh` for a job log: a cap of its own, and a sentence about the log, not about an issue. */
export const ghLogRunner = (options: GhOptions = {}): RunGh => ghRunner({ maxStdout: LOG_MAX_STDOUT, ...options, cut: LOG_TOO_LARGE });

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

// Why gh gave no log, in its own words, or a throw for what stops every read: a rate limit.
function failedRead(slug: string, answer: { stdout: string; stderr: string }): string {
  const said = `${answer.stderr}\n${answer.stdout}`;
  if (/rate limit/i.test(said)) throw new Error(`GitHub's rate limit for this gh login is used up, so the logs of ${slug} were not read. Wait for it to reset, at most an hour, then press Fix CI again.`);
  return firstLine(answer.stderr) || firstLine(answer.stdout) || 'gh gave no reason';
}

/**
 * One GitHub Actions job's log and the commit it ran on, through `gh api`, read-only (`-X GET`). Two
 * calls: the job, for its head commit, then its log, which GitHub answers as plain text. A job whose
 * log GitHub does not hand over, such as one past the retention days, answers why in gh's words. A rate
 * limit, a missing gh and a lost login throw, because they stop every other read too.
 */
export async function readJobLog(run: RunGh, job: { owner: string; repo: string; job: string }, signal: AbortSignal): Promise<{ ok: true; log: string; head: string | null } | { ok: false; why: string }> {
  if (!NAME.test(job.owner) || !NAME.test(job.repo) || !/^\d+$/.test(job.job)) return { ok: false, why: 'The link names no job Nolzu can read.' };
  const slug = `${job.owner}/${job.repo}`;
  const about = await run(['api', '-X', 'GET', `repos/${slug}/actions/jobs/${job.job}`], signal);
  if (about.code !== 0) return { ok: false, why: `GitHub did not hand over its log (${failedRead(slug, about)}).` };
  let head: string | null;
  try {
    const sha = (JSON.parse(about.stdout) as { head_sha?: unknown }).head_sha;
    head = typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  } catch {
    head = null;
  }
  let log: { code: number; stdout: string; stderr: string };
  try {
    log = await run(['api', '-X', 'GET', `repos/${slug}/actions/jobs/${job.job}/logs`], signal);
  } catch (error) {
    // The log runner's own cut sentence: this one log is too large, and the other checks still read.
    if ((error as Error).message.endsWith(LOG_TOO_LARGE)) return { ok: false, why: 'The log is larger than Nolzu reads.' };
    throw error;
  }
  if (log.code !== 0) return { ok: false, why: `GitHub did not hand over its log (${failedRead(slug, log)}).` };
  return { ok: true, log: log.stdout, head };
}
