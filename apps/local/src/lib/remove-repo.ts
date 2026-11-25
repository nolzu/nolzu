import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isFolderName, repoKnowledgePath } from '@nolzu/core';
import { cardRepos, getSetting } from '@nolzu/core/node';
import { git, gitEnv, type GitResult, ignoredPaths, type RunGit, somePaths } from '@nolzu/runner';
import { forgetInRoot, inTurn } from './manifest.ts';
import { cardsWithCheckout, listRefusal, removeProjectRepo } from './projects.ts';
import { remoteEnv } from './publish.ts';

/**
 * Removes a repository from a project: its clone or submodule goes from disk, its .gitignore line and
 * manifest entry go from the root, and it goes from the list. Its knowledge file stays.
 *
 * This is the one action that deletes a person's folder, and it cannot be undone. So every check
 * runs before anything is touched, each refusal names its reason, and a refusal removes nothing.
 */

type Env = Record<string, string | undefined>;
type Answer = { said: string } | { problem: string };

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);
const stays = (why: string): Answer => ({ problem: `${why} Nothing was removed.` });
// How long the Remove check waits for origin to list its tags.
const TAGS_MS = 20_000;

// What git shows of the work in a clone, by the line the confirm draws it on: a null holds. `other` is a
// reason the clone cannot be checked at all, and then the three lines are not known.
type Work = { other: string } | { checkouts: string | null; work: string | null; commits: string | null; inner: string | null };

/**
 * What git shows of the work in the clone that exists nowhere else.
 *
 * Remote-tracking branches are what this clone last saw of its remotes. No fetch runs, so a branch
 * deleted on the host still counts as pushed. Commits reachable only from the reflog are not looked
 * at, the way a fresh clone of the remote would not have them either.
 */
async function workLeft(at: string, path: string, env: Env): Promise<Work> {
  const run: RunGit = (args) => git(args, { cwd: at, env: gitEnv(env as Record<string, string>) });
  // A plain folder sends git up to the repository around it, and every answer below would be about that one.
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(at)) return { other: `The folder ${path} is not a git repository of its own, so Nolzu cannot check it for work.` };

  // Card checkouts of deleted cards and checkouts made by hand both keep their history here.
  const trees = await run(['worktree', 'list', '--porcelain']);
  const other = trees.stdout.split('\n').filter((line) => line.startsWith('worktree ')).slice(1)[0];
  const checkouts =
    trees.code !== 0
      ? `git could not list the checkouts of ${path}, so it stays. ${trees.stderr.trim()}`
      : other === undefined
        ? null
        : `${path} has another checkout at ${other.slice('worktree '.length)}, so it stays. Remove that checkout first, or run git worktree prune in ${path} when its folder is gone.`;

  const status = await run(['status', '--porcelain', '--untracked-files=all']);
  const files = status.stdout.split('\n').filter((line) => line !== '').length;
  // The folder goes whole, so the files git ignores go too, a `.env` among them. Folders tools make
  // again, such as node_modules, are left out of the question.
  const listed = status.code === 0 && files === 0 ? await run(['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal']) : null;
  const ignored = listed === null || listed.code !== 0 ? [] : ignoredPaths(listed.stdout).named;
  const work =
    status.code !== 0
      ? `git could not read the state of ${path}, so it stays. ${status.stderr.trim()}`
      : files > 0
        ? `${path} has ${plural(files, 'file', 'files')} that ${files === 1 ? 'is' : 'are'} not committed, so it stays. Commit and push the changes, or move them away.`
        : listed !== null && listed.code !== 0
          ? `git could not list the files ${path} ignores, so it stays. ${listed.stderr.trim()}`
          : ignored.length > 0
            ? `${path} has ${plural(ignored.length, 'file or folder', 'files or folders')} git ignores (${somePaths(ignored)}), so it stays: removing it would delete ${ignored.length === 1 ? 'it' : 'them'}. Move ${ignored.length === 1 ? 'it' : 'them'} away first.`
            : (await run(['rev-parse', '--verify', '--quiet', 'refs/stash'])).code === 0
              ? `${path} has a stash, so it stays. Apply it and push the work, or drop it with git stash drop.`
              : null;

  return { checkouts, work, commits: await commitsLeft(run, at, path, env), inner: await innerModules(run, path) };
}

// The commits of the clone that are on no remote, or null when every one is on one.
async function commitsLeft(run: RunGit, at: string, path: string, env: Env): Promise<string | null> {
  // The full ref, because the short name of a branch that shares its name with a tag is heads/<name>.
  const branches = (await run(['for-each-ref', '--format=%(refname)', 'refs/heads'])).stdout.split('\n').filter((ref) => ref !== '');
  const local: string[] = [];
  for (const ref of branches) {
    const ahead = await run(['rev-list', '--count', ref, '--not', '--remotes']);
    if (ahead.code !== 0 || ahead.stdout.trim() !== '0') local.push(ref.slice('refs/heads/'.length));
  }
  if (local.length > 0) return `The ${local.length === 1 ? 'branch' : 'branches'} ${local.join(', ')} of ${path} ${local.length === 1 ? 'has' : 'have'} commits on no remote, so ${path} stays. Push them first.`;
  // --all takes HEAD and every tag too, so a detached commit or a tag of its own is found here. A stash
  // has its own line, so its commits are left out of this one.
  const other = `${path} has commits on no branch and on no remote, from a detached HEAD or another ref, so it stays. Push them or drop them first.`;
  const left = await notOnRemotes(run, []);
  if (left === null) return other;
  if (left.size === 0) return null;
  const mine = await tagCommits(run(['show-ref', '--tags', '-d']));
  const holding = 'problem' in mine ? [] : [...mine].filter(([, commit]) => left.has(commit));
  if (holding.length === 0) return other;

  // A release tag whose branch was deleted on the host is on no remote branch, but the host still has
  // it. Asked now and not read off the clone, because a tag deleted on the host stays in every clone.
  const ask = git(['ls-remote', '--tags', 'origin'], { cwd: at, env: await remoteEnv(env, run), signal: AbortSignal.timeout(TAGS_MS) });
  const remote = await tagCommits(ask.catch((error: Error) => ({ code: 1, stdout: '', stderr: error.message })));
  if ('problem' in remote) {
    const tags = holding.map(([name]) => name);
    return `Nolzu could not reach origin to check the ${tags.length === 1 ? 'tag' : 'tags'} ${names(tags)} of ${path}, so ${path} stays. Check the connection, then try again. ${remote.problem.replace(/[^.]$/, '$&.')}`.trim();
  }
  // The same commit is enough: a tag the host has under another name holds the same history.
  const there = new Set(remote.values());
  const still = await notOnRemotes(run, holding.flatMap(([, commit]) => (there.has(commit) ? [commit] : [])));
  if (still === null) return other;
  if (still.size === 0) return null;
  const own = holding.filter(([, commit]) => still.has(commit)).map(([name]) => name);
  if (own.length === 0) return other;
  return own.length === 1
    ? `The tag ${own[0]} of ${path} is on no remote, so ${path} stays. Push it with git push origin ${own[0]}, or delete it.`
    : `The tags ${names(own)} of ${path} are on no remote, so ${path} stays. Push them with git push origin --tags, or delete them.`;
}

// The commits of every ref that no remote branch and none of `also` reach, or null when git cannot say.
async function notOnRemotes(run: RunGit, also: string[]): Promise<Set<string> | null> {
  const listed = await run(['rev-list', '--exclude=refs/stash', '--all', '--not', '--remotes', ...also]);
  return listed.code === 0 ? new Set(listed.stdout.split('\n').filter((line) => line !== '')) : null;
}

// Each tag by name with the commit it points at, read from show-ref -d or ls-remote, which print the
// same lines. An annotated tag has a second line ending in ^{} with its commit, and that one wins.
async function tagCommits(listed: Promise<GitResult>): Promise<Map<string, string> | { problem: string }> {
  const { code, stdout, stderr } = await listed;
  // show-ref answers 1 with nothing printed for a clone with no tags. Only 1: a git killed by a signal
  // also prints nothing, and that is no answer about origin's tags.
  if (code === 1 && stdout === '' && stderr === '') return new Map();
  if (code !== 0) return { problem: stderr.trim().split('\n')[0] ?? '' };
  const tags = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [commit, ref] = line.split(/\s+/);
    if (commit === undefined || ref === undefined || !ref.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) tags.set(name.slice(0, -3), commit);
    else if (!tags.has(name)) tags.set(name, commit);
  }
  return tags;
}

// A submodule of the clone keeps its history inside the clone's git folder, out of reach of the checks above.
async function innerModules(run: RunGit, path: string): Promise<string | null> {
  const gitDir = (await run(['rev-parse', '--absolute-git-dir'])).stdout.trim();
  return gitDir === '' || existsSync(join(gitDir, 'modules')) ? `${path} holds submodules of its own, and Nolzu cannot check their work. Remove ${path} by hand.` : null;
}

// The git folder of a submodule of the root, or why it cannot be removed safely. It must sit in the
// root's own modules folder: anything else could be a folder of the person's.
async function submoduleGitDir(project: string, at: string, path: string, env: Env): Promise<{ dir: string } | { why: string }> {
  const run = (cwd: string, args: string[]) => git(args, { cwd, env: gitEnv(env as Record<string, string>) });
  const common = (await run(project, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  const dir = (await run(at, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const modules = common === '' ? null : join(realpathSync(common), 'modules') + sep;
  if (modules === null || dir === '' || lstatSync(dir).isSymbolicLink() || !realpathSync(dir).startsWith(modules)) {
    return { why: `The history of the submodule ${path} is not in the root's .git/modules folder, so Nolzu leaves it alone.` };
  }
  return { dir: realpathSync(dir) };
}

// deinit -f throws away changes in the folder, which the checks have shown there are none of. With
// no dir the folder was empty, and its history, if it has one, stays where git keeps it.
async function dropSubmodule(project: string, path: string, dir: string | null, env: Env): Promise<string | null> {
  const run: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>) });
  const spec = `:(literal)${path}`;
  const deinit = await run(['submodule', 'deinit', '-f', '-q', '--', spec]);
  if (deinit.code !== 0) return `git could not deinit the submodule ${path}. ${deinit.stderr.trim()}`;
  const keep = dir === null ? `Run git submodule update --init ${path} to bring it back.` : `Its history is still in ${dir}, so git submodule update --init ${path} brings it back.`;
  const rm = await run(['rm', '-q', '--', spec]);
  if (rm.code !== 0) return `git emptied the submodule folder ${path}, but could not remove it. ${rm.stderr.trim()} ${keep}`;
  // Not commitKnowledgeFiles: its git add fails on a path that git rm took away.
  const commit = await run(['commit', '-q', '--cleanup=verbatim', '-m', `chore: remove ${path}`, '--', `:(top,literal)${path}`, ':(top,literal).gitmodules']);
  if (commit.code !== 0) return `git removed the submodule ${path}, but could not commit it. ${commit.stderr.trim()} ${keep}`;
  if (dir !== null) rmSync(dir, { recursive: true });
  return null;
}

// The lines the confirm ticks when they hold, in the order it draws them.
export const REMOVE_CHECKS = { checkouts: 'No card has a checkout of it', work: 'Nothing uncommitted, no stash', commits: 'Every commit is on a remote' } as const;

/** What the check pass found: each line that holds, and each finding that keeps the repository. */
export interface RemoveChecks {
  passed: string[];
  // One sentence each. Remove stays off while one is here, and the delete pass refuses with them.
  failed: string[];
}

// What the delete pass needs of the checks, so it acts on what was checked and asks git nothing twice.
type Plan = { at: string; stat: Stats | null; submodule: boolean; gitDir: string | null };
type Checked = RemoveChecks & { plan: Plan | null };

const NO_PROJECT = 'There is no project set, so there is no repository to remove.';
const names = (keys: readonly string[]) => (keys.length === 1 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1) ?? ''}`);

// The cards with a checkout of `path` on disk, as one finding.
function heldBy(db: DatabaseSync, project: string, path: string): string | null {
  const keys = cardsWithCheckout(db, project, path);
  if (keys.length === 0) return null;
  return keys.length === 1
    ? `${names(keys)} has a checkout of ${path}, so ${path} stays. The card's work there would be left out of its changes.`
    : `${names(keys)} have a checkout of ${path}, so ${path} stays. Their work there would be left out of their changes.`;
}

// The cards with a run queued or going that can use `path`. A card that picked no repositories works
// on all of them, and a plan reads the whole project.
function runningOn(db: DatabaseSync, path: string): string | null {
  const busy = db.prepare("SELECT key FROM cards WHERE state IN ('queued', 'running') ORDER BY key").all() as { key: string }[];
  const keys = busy.map((row) => row.key).filter((key) => cardRepos(db, key)?.repos.includes(path) ?? true);
  if (keys.length === 0) return null;
  return `${names(keys)} ${keys.length === 1 ? 'is' : 'are'} running on ${path} now, so ${path} stays until ${keys.length === 1 ? 'that run ends' : 'those runs end'}.`;
}

/**
 * The check pass of Remove: every check the delete pass makes, with nothing deleted, so the confirm
 * shows what it found before it asks for the name. It reads git and the database and changes nothing.
 */
export async function removeChecks(db: DatabaseSync, path: string, env: Env = process.env): Promise<RemoveChecks> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return { passed: [], failed: [NO_PROJECT] };
  const { passed, failed } = await check(db, project, path, env);
  return { passed, failed };
}

/**
 * The delete pass: removes one repository once the checks hold and the typed name matches it, or
 * answers why it stays.
 *
 * The checks run again here and the typed name is checked here, not only on the page, because the
 * page may be old and a post can come from anywhere.
 */
export async function removeRepository(db: DatabaseSync, path: string, typed: string, env: Env = process.env): Promise<Answer> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return stays(NO_PROJECT);
  // A remove commits the manifest too, so it waits behind a clone that runs. The checks run after the
  // wait, on the list as that clone left it.
  return inTurn(project, () => remove(db, project, path, typed, env));
}

async function check(db: DatabaseSync, project: string, path: string, env: Env): Promise<Checked> {
  const stop = (why: string): Checked => ({ passed: [], failed: [why], plan: null });
  const refused = listRefusal(db, path);
  if (refused !== null) return stop(refused);
  // The list passed this check when it was stored. A hand edit of it must still not reach rmSync.
  if (!isFolderName(path)) return stop(`${JSON.stringify(path)} is not one folder name.`);

  const at = join(project, path);
  let stat: Stats | null = null;
  try {
    stat = lstatSync(at);
  } catch {
    // A folder that is gone holds nothing to lose. Its list entry and its records still go.
  }
  const root: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>) });
  const prefix = stat === null ? null : await root(['rev-parse', '--show-prefix']);
  // Only a project folder that is the top of its own repository has submodules Nolzu may change.
  const isTop = prefix !== null && prefix.code === 0 && prefix.stdout.trim() === '';
  const submodule = isTop && (await root(['ls-files', '--stage', '--', `:(literal)${path}`])).stdout.startsWith('160000 ');

  let work: Work = { checkouts: null, work: null, commits: null, inner: null };
  // A submodule that was never set up, or one a deinit already emptied, has no work in its folder.
  const filled = stat !== null && stat.isDirectory() && !stat.isSymbolicLink() && (!submodule || readdirSync(at).length > 0);
  if (stat !== null) {
    // rmSync of a link removes only the link, but every check would have run in what it points at.
    if (stat.isSymbolicLink()) return stop(`The folder ${path} is a link, so Nolzu leaves it and what it points at alone.`);
    if (!stat.isDirectory()) return stop(`${path} in the project folder is not a folder.`);
    if (!realpathSync(at).startsWith(realpathSync(project) + sep)) return stop(`The folder ${path} is outside the project folder.`);
    if (submodule) {
      // The commit takes all of .gitmodules, so an edit of the person's would ride along.
      const edits = await root(['status', '--porcelain', '--', '.gitmodules']);
      if (edits.code !== 0 || edits.stdout.trim() !== '') return stop(`.gitmodules has changes of yours that are not committed, so ${path} stays. Commit them first.`);
    }
    if (filled) {
      work = await workLeft(at, path, env);
      if ('other' in work) return stop(work.other);
    }
  }

  const lines = [
    { ok: REMOVE_CHECKS.checkouts, found: heldBy(db, project, path) ?? work.checkouts },
    { ok: null, found: runningOn(db, path) },
    { ok: REMOVE_CHECKS.work, found: work.work },
    { ok: REMOVE_CHECKS.commits, found: work.commits },
    { ok: null, found: work.inner },
  ];
  const passed = lines.flatMap((line) => (line.found === null && line.ok !== null ? [line.ok] : []));
  const failed = lines.flatMap((line) => (line.found === null ? [] : [line.found]));
  let gitDir: string | null = null;
  if (failed.length === 0 && submodule && filled) {
    const found = await submoduleGitDir(project, at, path, env);
    if ('why' in found) failed.push(found.why);
    else gitDir = found.dir;
  }
  return { passed, failed, plan: failed.length === 0 ? { at, stat, submodule, gitDir } : null };
}

async function remove(db: DatabaseSync, project: string, path: string, typed: string, env: Env): Promise<Answer> {
  const checked = await check(db, project, path, env);
  if (checked.plan === null) return stays(checked.failed.join(' '));
  if (typed !== path) return stays(`To remove ${path}, type its folder name ${path} exactly.`);
  const { at, stat, submodule, gitDir } = checked.plan;

  const forget = await forgetInRoot(project, path, env);
  if ('problem' in forget) return stays(forget.problem);

  // Limit: no lock against a card that starts between the checks and the delete. A checkout made in
  // that gap loses its git folder with the clone. removeProjectRepo below sees it and answers a problem.
  // A lock shared with the run start would close the gap.
  if (submodule && stat !== null) {
    const failed = await dropSubmodule(project, path, gitDir, env);
    if (failed !== null) return { problem: failed };
  } else if (stat !== null) {
    try {
      rmSync(at, { recursive: true });
    } catch (error) {
      return { problem: `Nolzu could not remove the folder ${path}, and part of it may be gone. ${(error as Error).message}` };
    }
  }
  const notes: string[] = [];
  const records = await forget.finish();
  if (records !== null) notes.push(records);
  const listed = removeProjectRepo(db, path);
  if (listed !== null) return { problem: [`The folder ${path} is gone, but the list kept it. ${listed}`, ...notes].join(' ') };
  return { said: [`Removed ${path}. Its knowledge file ${repoKnowledgePath(path)} stays.`, ...notes].join(' ') };
}
