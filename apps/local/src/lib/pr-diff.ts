import { join } from 'node:path';
import { parseTicketRef } from '@nolzu/protocol';
import type { PullHead } from '@nolzu/core/node';
import { getPull, git, type RunGh, writeCardFile } from '@nolzu/runner';
import { remoteEnv } from './publish.ts';

/**
 * The diff a pr-review run reads, on disk before the engine starts.
 *
 * The skill reads `<card folder>/pr-review/diff.patch` and refuses the run when it is not there, so
 * this is the writer of that file. It is fetched once per run and not once per card: a re-review has
 * to read the head as it is now, and a patch written when the card was made would be the first
 * round's.
 *
 * `gh pr diff` has not been recorded against the real GitHub CLI here, so the stub in
 * `pr-diff.test.ts` is a documented shape and not a measured one. That test names what the first
 * real call has to confirm.
 */

// What a fake run gets instead of a call. A real diff's shape, small enough to read: the file
// header, one hunk, a removed line and an added one, so a run in fake mode
// sees a real file.
// Numbered, these are the bytes `packages/runner/fake/pr-review.ndjson` replays as the result of its
// Read of this file. One diff, so the transcript, the file on disk and the Files tab show a run in fake mode
// the same change.
const FAKE_PATCH = `diff --git a/services/api/src/recipes/list.ts b/services/api/src/recipes/list.ts
index 4f2a1c3..9b8e2d1 100644
--- a/services/api/src/recipes/list.ts
+++ b/services/api/src/recipes/list.ts
@@ -1,3 +1,7 @@
+export function filterRecipes(recipes, query) {
+  return recipes.filter((recipe) => recipe.title.includes(query));
+}
+
 export function listRecipes(recipes) {
   return recipes.map((recipe) => recipe.title);
 }
`;

export interface PrDiffRequest {
  // The card folder, as the job carries it. The patch goes under the phase inside it, beside the
  // round the run writes.
  taskDir: string;
  // What the card knows the pull request by, which is `owner/repo#number`. The card key holds no
  // owner, so the ref is the only place the owner is.
  sourceRef: string | null;
  // How to reach `gh`, or null in fake mode, where the built-in patch is written and nothing is
  // called. A function, so a test hands in a stub and no test reaches GitHub.
  gh: RunGh | null;
  signal: AbortSignal;
  // The project repository whose origin is the pull request's repository, asked only when GitHub
  // sends no diff, and git's environment for reading it there.
  localRepo?: (owner: string, repo: string) => Promise<string | null>;
  gitEnv?: Record<string, string>;
  // A line for the run log, when the diff came from git and not from GitHub.
  note?: (line: string) => void;
}

// GitHub answers 406 for a diff it finds too big (over 300 files, seen live), and `gh`'s runner drops an answer
// over its cap. Either way the diff is there, only too big for that road.
// How long the fetch of a pull request too big for GitHub's diff may take.
const FETCH_MS = 10 * 60_000;
const TOO_BIG = /HTTP 406/;
const OVER_CAP = /sent more than \d+ characters/;

/**
 * Write the pull request's diff into the card folder, and answer with the path.
 *
 * Throws, and writes no file, when the card names no GitHub pull request, when `gh` exits non-zero
 * or when it prints nothing. In fake mode nothing is called and the built-in patch is written,
 * whatever the card names. The run then fails with that sentence and no engine is spawned, which
 * is the point of doing this before the spawn.
 */
const DIFF_FILE = join('pr-review', 'diff.patch');

export async function writePrDiff(request: PrDiffRequest): Promise<string> {
  const { sourceRef, gh } = request;
  const file = join(request.taskDir, DIFF_FILE);

  // Fake mode first, before the ref is read at all. Every card a run in fake mode can make names no pull
  // request, because the only writer of a source ref is the GitHub read in `create-card.ts`, which
  // needs a login. A ref check above this line would leave the PR reviews board unusable in fake mode
  // without one, and a run in fake mode on that board needs a real file to show.
  if (gh === null) {
    write(request.taskDir, FAKE_PATCH);
    return file;
  }

  const ref = sourceRef === null ? null : parseTicketRef(sourceRef);
  // The owner as well, because `--repo` takes `owner/repo`. A bare `recipes#41` names no owner, and
  // guessing one would read somebody else's pull request.
  if (ref === null || ref.kind !== 'github' || ref.owner === null) {
    const named = sourceRef === null ? 'no pull request' : JSON.stringify(sourceRef);
    throw new Error(`This card names ${named}, so Nolzu does not know which diff to read. A pull request card carries its pull request as owner/repo#number.`);
  }
  const repo = `${ref.owner}/${ref.repo}`;
  const named = `${repo}#${ref.number}`;
  const pull = { owner: ref.owner, repo: ref.repo, number: ref.number };

  // `--color never`, because a diff with escape codes in it is a diff the agent reads codes out of.
  // The arguments go as an array, so the `#` in a card key never reaches a shell: it is not in this
  // list at all, since GitHub takes the number and the repository apart.
  const args = ['pr', 'diff', String(ref.number), '--repo', repo, '--color', 'never'];
  let answer;
  try {
    answer = await gh(args, request.signal);
  } catch (error) {
    if (!OVER_CAP.test(String(error))) throw error;
    return fromGit(request, pull, file, 'the diff is bigger than gh reads at once');
  }
  const say = `Run gh ${args.join(' ')} in a terminal to see what it says.`;
  if (answer.code !== 0) {
    const said = answer.stderr.trim().split('\n')[0]?.trim() ?? '';
    if (TOO_BIG.test(said)) return fromGit(request, pull, file, `GitHub said: ${said}`);
    throw new Error(`gh could not read the diff of ${named}, so there is nothing to review. It exited ${answer.code}${said === '' ? '' : ` and said: ${said}`}. ${say}`);
  }
  if (answer.stdout.trim() === '') {
    throw new Error(`gh read an empty diff for ${named}, so there is nothing to review. The pull request may hold no change, or gh may not be able to open that repository. ${say}`);
  }
  // The bytes as `gh` printed them, with only the line numbers added. A patch the agent reads must
  // match the pull request to the character, so nothing here trims or rewrites the answer.
  write(request.taskDir, answer.stdout);
  return file;
}

/**
 * The head of the card's pull request as GitHub has it now, read right before the diff, so the round
 * saves the head it reviewed and not the one the last Read pull requests saw. Null in fake mode, for a
 * card that names no GitHub pull request, and for an answer that cannot be read: the caller then keeps
 * the head that read saw, and a missing head never claims a push.
 */
export async function readPrHead(sourceRef: string | null, gh: RunGh | null, signal: AbortSignal): Promise<PullHead | null> {
  const ref = gh === null || sourceRef === null ? null : parseTicketRef(sourceRef);
  if (gh === null || ref === null || ref.kind !== 'github' || ref.owner === null) return null;
  try {
    const found = (await getPull(gh, { owner: ref.owner, repo: ref.repo, number: ref.number }, signal)).pull;
    return found?.headSha === undefined ? null : { sha: found.headSha, commits: found.commits ?? null };
  } catch {
    return null;
  }
}

/**
 * The diff GitHub would not send, from git: the pull request's head and its base branch fetched from
 * the local repository's origin into refs of Nolzu's own, compared the way GitHub compares them (from
 * where the head left the base), and the refs removed again. The person's branches stay as they are.
 */
async function fromGit(request: PrDiffRequest, ref: { owner: string; repo: string; number: number }, file: string, why: string): Promise<string> {
  const named = `${ref.owner}/${ref.repo}#${ref.number}`;
  const refuse = (rest: string) => new Error(`GitHub sends no diff for ${named} (${why}), and Nolzu could not read it from git either: ${rest}`);
  const folder = (await request.localRepo?.(ref.owner, ref.repo)) ?? null;
  if (folder === null) throw refuse(`no repository of this project has ${ref.owner}/${ref.repo} as its origin. Add it to the project, or review this pull request on GitHub.`);
  const base = await request.gh?.(['pr', 'view', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, '--json', 'baseRefName', '--jq', '.baseRefName'], request.signal);
  const branch = base?.code === 0 ? base.stdout.trim() : '';
  if (branch === '') throw refuse(`gh could not read its base branch. ${base?.stderr.trim().split('\n')[0] ?? ''}`.trim());

  const head = `refs/nolzu/pull/${ref.number}/head`;
  const onto = `refs/nolzu/pull/${ref.number}/base`;
  const run = (args: readonly string[]) => git(args, { cwd: folder, env: request.gitEnv, signal: request.signal });
  const first = (text: string) => text.trim().split('\n')[0] ?? '';
  try {
    // ssh in batch mode, as a push, and a time limit: a key prompt or a host that never answers would
    // hold the review run where nobody sees it.
    const env = await remoteEnv(request.gitEnv ?? process.env, run);
    const fetched = await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${ref.number}/head:${head}`, `+refs/heads/${branch}:${onto}`], {
      cwd: folder,
      env,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(FETCH_MS)]),
    }).catch((error: Error) => {
      throw request.signal.aborted ? error : refuse(`git fetch in ${folder} took longer than ${FETCH_MS / 60_000} minutes, so Nolzu stopped it.`);
    });
    if (fetched.code !== 0) throw refuse(`git fetch in ${folder} exited ${fetched.code} and said: ${first(fetched.stderr)}`);
    // Limit: the whole diff in memory, as every git read here. Stream it to the file if one ever
    // passes Node's string limit.
    const diff = await run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', `${onto}...${head}`]);
    if (diff.code !== 0) throw refuse(`git diff in ${folder} exited ${diff.code} and said: ${first(diff.stderr)}`);
    if (diff.stdout.trim() === '') throw refuse(`git found no change between ${branch} and the pull request's head.`);
    write(request.taskDir, diff.stdout);
    const files = diff.stdout.split('\n').filter((line) => line.startsWith('diff --git ')).length;
    request.note?.(`GitHub sends no diff for ${named} (${why}), so Nolzu read it from git in ${folder}: ${files} ${files === 1 ? 'file' : 'files'}.`);
    return file;
  } finally {
    await run(['update-ref', '-d', head]).catch(() => undefined);
    await run(['update-ref', '-d', onto]).catch(() => undefined);
  }
}

// Inside the card folder only, never through a link a run left at the name or above it.
function write(taskDir: string, patch: string): void {
  // Overwritten on every run of the card, which is what a second round needs: the round before read
  // the head as it was then.
  writeCardFile(taskDir, DIFF_FILE, numberDiff(patch));
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The diff with each hunk line's number in the file after the change in front of it, which is the
 * number a finding's place names and the one GitHub shows on that line. A reviewer left to count from
 * the `@@` header miscounts, and the number its file reader prints is the line of the diff file:
 * a real round put a finding ten lines off that way. A removed line has no such number and gets a
 * blank. Headers stay as they are, and every line keeps its bytes after the number.
 */
export function numberDiff(patch: string): string {
  let old = 0;
  let next = 0;
  let at = 0;
  const lines = patch.split('\n').map((line) => {
    const hunk = HUNK.exec(line);
    if (hunk) {
      old = Number(hunk[1] ?? 1);
      at = Number(hunk[2]);
      next = Number(hunk[3] ?? 1);
      return { line, n: null, body: false };
    }
    // "\ No newline at end of file" can follow the last line, after the counts ran out.
    if (line.startsWith('\\')) return { line, n: null, body: true };
    if (old <= 0 && next <= 0) return { line, n: null, body: false };
    if (line.startsWith('-')) {
      old--;
      return { line, n: null, body: true };
    }
    if (line.startsWith('+')) {
      next--;
      return { line, n: at++, body: true };
    }
    if (line.startsWith(' ')) {
      old--;
      next--;
      return { line, n: at++, body: true };
    }
    return { line, n: null, body: false };
  });
  const width = String(Math.max(0, ...lines.map((l) => l.n ?? 0))).length;
  return lines.map((l) => (l.body ? `${(l.n === null ? '' : String(l.n)).padStart(width)} ${l.line}` : l.line)).join('\n');
}
