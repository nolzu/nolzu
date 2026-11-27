import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gitEnv } from './env.ts';
import { withCardLock, withRepoLock } from './lock.ts';
import { git } from './exec.ts';
import { projectPlace } from './places.ts';
import { parseWorktrees } from './porcelain.ts';

// Both sit under the project root, so every agent's git status would list them as untracked and
// one could be committed by accident. They go into the repository's own exclude file and never
// into the tracked .gitignore, which belongs to the user and to their team.
const EXCLUDED = ['/worktrees/', '/.tasks/'];

export interface EnsureWorktreeOptions {
  projectPath: string;
  key: string;
  branch: string;
  baseBranch: string;
  // The repository this checkout is of: "." for the project folder, or one folder inside it.
  repo?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Worktree {
  path: string;
  branch: string;
  // False when it was already there, so a second call is a no-op the caller can see.
  created: boolean;
}

// Checked by code point rather than by a regular expression, which cannot carry a control
// character without tripping the lint rule that exists to catch one written by accident.
const unsafeInAName = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || character === '/' || character === '\\';
  });



// One folder name and nothing more, so a card key can name the card's checkout and its card folder
// without reaching another folder.
export const isPlainName = (value: string): boolean => value !== '' && value !== '.' && value !== '..' && !unsafeInAName(value);

// The one place that knows where card checkouts live, so a second layout cannot creep in beside it.
export const worktreesFolder = (project: string): string => join(project, 'worktrees');

// The key is not checked here. The callers that act on the checkout refuse a key that is not a
// plain name with their own sentence, and discussion.ts only prints the path in a resume command.
export const checkoutRoot = (project: string, key: string): string => join(worktreesFolder(project), key);

// The root repository is the card root itself, so a card on one repository keeps the path it always
// had. A child repository is one folder inside it, and a name that climbs out or nests is refused.
// .git is refused too: inside the card root it is the root checkout's own link to its repository.
const checkRepo = (repo: string): void => {
  if (repo !== '.' && (!isPlainName(repo) || repo.toLowerCase() === '.git')) {
    throw new Error(`The repository ${JSON.stringify(repo)} is not one plain folder name, so it cannot name a checkout.`);
  }
};

export const checkoutPath = (project: string, key: string, repo = '.'): string => {
  checkRepo(repo);
  return repo === '.' ? checkoutRoot(project, key) : join(checkoutRoot(project, key), repo);
};

// Where git runs for one repository of the project. The project folder itself for ".", so a project
// with one repository runs git exactly where it always did.
export const repoFolder = (project: string, repo = '.'): string => {
  checkRepo(repo);
  return repo === '.' ? project : join(project, repo);
};

// A base from the repository list can start with a dash, and git reads such an argument as an
// option. Measured: `worktree add -b B <path> -f` branches from HEAD and not from any base.
export const dashedBase = (base: string): string | null =>
  base.startsWith('-') ? `The base branch ${base} starts with a dash, so git would read it as an option. Set a base branch that is a branch name.` : null;

// The setting a missing base sends the person to. A child repository's base is its own entry in
// the repository list, and the base branch setting does nothing for it.
export const baseAdvice = (repo: string): string =>
  repo === '.' ? 'Set the base branch setting to a branch that exists.' : `Set the base of ${repo} in the project's repositories to a branch that exists.`;

// A child folder that is no repository of its own, an uninitialised submodule say, sends git up to
// the repository around it. Every answer would then be about that one, and the card's checkout and
// branch would land in it. Null when the folder is its own repository, or when git cannot tell,
// which the caller's own rev-parse reports.
export async function notOwnRepository(at: string, repo: string, env: Record<string, string>, signal?: AbortSignal): Promise<string | null> {
  if (repo === '.') return null;
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: at, env, signal });
  if (top.code !== 0 || realpathSync(top.stdout.trim()) === realpathSync(at)) return null;
  return `The repository folder ${at} is not a git repository of its own. Run git init in it, or remove ${repo} from the project's repositories.`;
}

// Finder writes .DS_Store into any folder it opens. Counting it as work refused a card whose
// checkout had been cleared for good, and the person sees an empty folder and no way to start.
const keeps = (entry: string): boolean => entry !== '.DS_Store';

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

// Each folder from `from` down to `to`, made when it is not there. One that is there must be a folder
// and not a link, so nothing is made where a link points.
function makeFolders(from: string, to: string): void {
  let at = from;
  for (const step of relative(from, to).split(sep)) {
    at = join(at, step);
    try {
      mkdirSync(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const found = lstatOrNull(at);
    if (found === null || found.isSymbolicLink() || !found.isDirectory()) {
      throw new Error(`${at} is ${found?.isSymbolicLink() === true ? 'a link' : 'not a folder'}, so Nolzu did not make the card's checkout in it. Move it away, then start the card again.`);
    }
  }
}

function addExcludes(commonDir: string): void {
  const info = join(commonDir, 'info');
  const file = join(info, 'exclude');
  // Never read or written through a link: a run that may write the git folder could point the file at
  // a secret, and Nolzu would copy it into the repository. A pipe would hold the read for good.
  for (const path of [info, file]) {
    const found = lstatOrNull(path);
    if (found !== null && (found.isSymbolicLink() || (path === file ? !found.isFile() : !found.isDirectory()))) {
      throw new Error(`${path} is ${found.isSymbolicLink() ? 'a link' : 'not what git keeps there'}, so Nolzu does not read or write it. Remove it, then start the card again.`);
    }
  }
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = EXCLUDED.filter((entry) => !current.split('\n').some((line) => line.trim() === entry));
  if (missing.length === 0) return;

  mkdirSync(info, { recursive: true });
  // Appended, so every line the user wrote keeps its place and its neighbours.
  const head = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  // Written beside the file and renamed over it. This runs before the card lock is taken, and the
  // lock is per card anyway, so two cards starting together both read and rewrite this file. A
  // plain write truncates first, and the loser's copy would take the winner's lines, including the
  // ones the person wrote themselves. Rename is the one step that cannot half happen.
  const partial = `${file}.${process.pid}.tmp`;
  try {
    // Made new, so a link left at this name is removed and never written through.
    rmSync(partial, { force: true });
    writeFileSync(partial, `${head}${missing.join('\n')}\n`, { flag: 'wx' });
    renameSync(partial, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

// Gives a card its own checkout on its own branch. Plain arguments only: the runner never reads
// the settings or the database, core passes what it decided.
export async function ensureWorktree(options: EnsureWorktreeOptions): Promise<Worktree> {
  const { projectPath, key, branch, baseBranch } = options;
  const repo = options.repo ?? '.';
  // The repository's own folder. The checkout path still comes from the project, so every
  // repository of a card lands in that card's one root.
  const at = repoFolder(projectPath, repo);
  // Always built here rather than passed straight through. A stray GIT_DIR points
  // rev-parse --git-common-dir at another repository, so the excludes and this card's worktree
  // and branch would land in one nobody chose. Left undefined, spawn inherits this process's
  // own environment, where such a variable also sits.
  const env = gitEnv(options.env ?? process.env);
  // The project is the owner: a link on the way from it down to the card's checkout is refused.
  const repoPlace = projectPlace(projectPath, repo);
  const run = (args: readonly string[]) => git(args, { cwd: at, env, signal: options.signal, owner: projectPath, repo: repoPlace });

  // The key becomes a folder name. A segment that climbs out would put the checkout somewhere the
  // exclude does not cover, which is the thing conflict 17 exists to prevent.
  // One plain folder name. A slash would nest one card's checkout inside another's, where the
  // exclude line does not reach, and a newline would be read as a second entry by the parser that
  // reads `worktree list`.
  if (!isPlainName(key)) {
    throw new Error(`The card key ${JSON.stringify(key)} cannot be used as a folder name, so no worktree can be made for it.`);
  }
  if (!existsSync(at)) {
    throw new Error(`The ${repo === '.' ? 'project' : 'repository'} folder ${at} is not there, so no worktree can be made in it.`);
  }

  const common = await run(['rev-parse', '--git-common-dir']);
  if (common.code !== 0) {
    throw new Error(`${at} is not a git repository, so a worktree cannot be made there. ${common.stderr.trim()}`);
  }
  const stray = await notOwnRepository(at, repo, env, options.signal);
  if (stray !== null) throw new Error(stray);
  const dir = common.stdout.trim();
  const commonDir = isAbsolute(dir) ? dir : join(at, dir);
  // Written before anything is created, and on every call. Doing it last meant a run that failed
  // here left a worktree behind with no exclude line, and the next call returned before retrying.
  try {
    addExcludes(commonDir);
  } catch (error) {
    throw new Error(`${join(commonDir, 'info', 'exclude')} could not be written, so the worktree would show up as untracked in every run. ${(error as Error).message}`, { cause: error });
  }

  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) {
    throw new Error(`The repository at ${at} has no commit to branch from, so this ${repo === '.' ? 'project' : 'repository'} needs a first commit before a card can start.`);
  }

  // Everything from here is a snapshot of the repository followed by an action on it, and git makes
  // a branch visible about two milliseconds before its worktree is registered. Measured: without
  // this, eight calls for one card left one worktree and seven errors, because git refuses the
  // second caller while it builds. They wait and are handed the same worktree instead.
  // Then the repository's lock, because two cards' builds also collide inside git (`withRepoLock`).
  return withCardLock(join(commonDir, 'nolzu-locks'), key, () => withRepoLock(commonDir, build, options.signal), options.signal);

  async function build(): Promise<Worktree> {
  const target = checkoutPath(projectPath, key, repo);
  // git prints resolved paths. Comparing against a path built from the resolved project root
  // matches them even when the folder itself is gone, which realpath on the folder cannot do.
  const resolved = checkoutPath(realpathSync(projectPath), key, repo);
  const list = async () => parseWorktrees((await run(['worktree', 'list', '--porcelain'])).stdout);

  let worktrees = await list();
  const here = worktrees.find((entry) => entry.path === resolved || entry.path === target);
  // git holds this lock only while it is building a worktree, so finding one means the creation
  // never finished. Checked before the worktree is trusted: the folder and its .git file are both
  // there by then, so trusting it first handed the card a tree where the project reads as deleted.
  const unfinished = here !== undefined && here.locked === 'initializing';
  // A folder that is there is not proof of a checkout either. git marks the entry prunable when
  // its gitdir is gone, and without that check the engine is handed a directory it cannot run in.
  // `.git` existing is not proof of ownership: any repository has one, and a clone left at the card
  // path was handed to the agent as the card's worktree. git has to resolve the folder back to this
  // repository before it counts.
  const belongsHere = async (): Promise<boolean> => {
    if (!existsSync(join(target, '.git'))) return false;
    // A symlink at the card path makes the proof answer itself: the pointer and this folder's own
    // .git resolve through the same link, so the comparison passes for whatever it points at, and
    // both the cross card case and the project case come straight back. git never makes the card
    // path a symlink, so one here is never this card's. Only the last part is checked, so a link
    // further up the path is untouched.
    if (lstatOrNull(target)?.isSymbolicLink() === true) return false;
    // `--absolute-git-dir` and not the common dir. git walks up when a folder is not a repository,
    // so asking for the common dir inside a folder that sits in the project answered with the
    // project itself, and the card was then run in the person's own checkout. A linked worktree's
    // own git dir is `<common>/worktrees/<name>`, which nothing outside this repository can be.
    const own = await git(['-C', target, 'rev-parse', '--absolute-git-dir'], { cwd: at, env });
    if (own.code !== 0) return false;
    try {
      const admin = own.stdout.trim();
      // Sitting under this repository's worktrees folder is not enough. Two folders answer with an
      // admin directory that is not their own: a card folder moved or copied over another card's,
      // which answers with that card's, and a project that is itself a linked worktree, whose own
      // admin directory lives in the very same folder. The admin directory records which folder it
      // serves, so the proof is that it points back at this one.
      const pointer = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
      // worktree.useRelativePaths writes that pointer relative to the admin directory, so comparing
      // it as it stands would refuse every healthy card in a repository that has the setting on.
      const back = isAbsolute(pointer) ? pointer : join(admin, pointer);
      return realpathSync(back) === realpathSync(join(target, '.git'));
    } catch {
      return false;
    }
  };

  // A lock is the person saying they are in it, so a locked worktree is never reused. This is asked
  // before usable and not after, or a healthy locked worktree was handed to an agent to write in.
  const usable = here !== undefined && here.locked === null && here.prunable === null && (await belongsHere());
  if (here !== undefined && usable) {
    if (here.branch !== branch) {
      throw new Error(`The worktree at ${target} is on ${here.branch ?? 'no branch'} and not on ${branch}. Remove it first, so nothing in it is lost by surprise.`);
    }
    return { path: target, branch, created: false };
  }
  const holdsNothing = (): boolean => {
    const at = lstatOrNull(target);
    if (at === null) return true;
    try {
      return at.isDirectory() && readdirSync(target).filter(keeps).length === 0;
    } catch {
      return false;
    }
  };

  if (unfinished && holdsNothing()) {
    // git holds this lock while it is building a worktree, so a run that was killed mid checkout
    // leaves it behind. It is git's own and not a person's, and reporting it told the user to undo
    // something they never did, which left the card unable to start for good.
    // `remove --force` refuses a locked worktree outright and says to release the lock first, so
    // the lock goes before the removal. Both are git's own leftovers from the killed run.
    await run(['worktree', 'unlock', target]);
    await run(['worktree', 'remove', '--force', target]);
    worktrees = await list();
  } else if (here !== undefined && here.locked !== null) {
    // Every other locked worktree is refused, whatever the reason says. `initializing` records only
    // that a checkout once started and never cleared the flag: a person can repair a half checkout
    // and work in it for a week while it still says that, so the word is not proof the folder is
    // git's. Nothing is unlocked before this point, or a refusal would take the person's own lock
    // with it.
    const why = here.locked === '' ? '' : ` (${here.locked})`;
    throw new Error(`The worktree at ${target} is locked${why}, so Nolzu will not touch it. Release it in git, then start the card again.`);
  }
  if (here !== undefined) {
    // git lists this one but it cannot be used: the folder is gone, or its gitdir is. The entry has
    // to go or every later call reports the branch as checked out at a path that does not work.
    //
    // What is NOT allowed is deleting the folder when it holds something. A prunable entry says
    // nothing about whose files those are: a card whose `.git` was lost still holds the person's
    // work, and deleting it took staged files with no commit behind them. Only an empty folder, or
    // none at all, is cleared here. `initializing` is different and is handled above, because there
    // git is telling us the folder is its own unfinished build.
    const leftAt = lstatOrNull(target);
    if (leftAt !== null && !leftAt.isDirectory()) {
      throw new Error(`${target} is in the way and is not a folder. Nothing was deleted. Move it away, then start the card again.`);
    }
    let left: string[];
    try {
      left = leftAt === null ? [] : readdirSync(target).filter(keeps);
    } catch (error) {
      throw new Error(`${target} cannot be read, so it is not safe to check whether it is empty. ${(error as Error).message}`, { cause: error });
    }
    if (left.length > 0) {
      throw new Error(`${target} is registered with git but cannot be used, and it holds files. Nothing was deleted. Move it away, then start the card again.`);
    }
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      throw new Error(`${target} could not be cleared, so the card cannot start again. ${(error as Error).message}`, { cause: error });
    }
    // By path, never `worktree prune`, which reaches every worktree of the person's repository and
    // clears any whose folder is away at that moment, on a drive not mounted, say. With the folder
    // gone, `worktree remove` clears only this entry.
    await run(['worktree', 'remove', '--force', here.path]);
    worktrees = await list();
  }

  const elsewhere = worktrees.find((entry) => entry.branch === branch);
  if (elsewhere !== undefined) {
    throw new Error(`The branch ${branch} is already checked out at ${elsewhere.path}. Git allows one checkout per branch, so that one has to move first.`);
  }

  // A tag with the same name does not fail. git quietly checks out the tag and leaves the worktree
  // on a detached HEAD, so the card would have no branch at all.
  if ((await run(['rev-parse', '--verify', '--quiet', `refs/tags/${branch}`])).code === 0) {
    throw new Error(`The name ${branch} is already a tag in this repository, so it cannot also be this card's branch. Rename the tag, or change the branch template.`);
  }

  const leaf = lstatOrNull(target);
  if (leaf !== null && !leaf.isDirectory()) {
    // A broken symlink answers false to an existence check, so only lstat sees it.
    throw new Error(`${target} is in the way and is not a folder. Nothing was deleted. Move it away, then start the card again.`);
  }
  // Whether this call is the one that makes the folder. The cleanup may only remove what this call
  // created: it used to remove the target whenever nothing was registered there, which deleted a
  // folder that was already on disk, with whatever was in it.
  //
  // Kept as a guarantee rather than a promise a test keeps. Measured: git sometimes removes an empty
  // folder that was already there, when the creation fails while writing `<target>/.git`, so this
  // guard does not always save one. A folder with anything in it never reaches the cleanup, because
  // it is refused before the creation, which is what actually protects a person's files.
  const ours = leaf === null;
  let inside: string[];
  try {
    inside = leaf === null ? [] : readdirSync(target).filter(keeps);
  } catch (error) {
    throw new Error(`${target} cannot be read, so it is not safe to check whether it is empty. ${(error as Error).message}`, { cause: error });
  }
  if (leaf !== null && inside.length > 0) {
    // Never cleared, whatever is in it. Nolzu used to try to tell git's own leftovers from a
    // person's folder by reading the `.git` pointer, and that rule deleted committed files, a
    // submodule, another repository's live checkout, and uncommitted work in a card whose entry
    // Nolzu's own prune had removed. A pruned entry and a killed checkout look identical from the
    // outside, so the pointer cannot prove whose folder this is. It is named and left alone.
    throw new Error(`${target} already holds files and is not a worktree of this repository. Nothing was deleted. Move it away, then start the card again.`);
  }

  const local = (await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  // A branch that exists only on the remote holds work another machine pushed. Cutting a fresh
  // branch from the base would throw it away and the later push would be refused.
  // Asked per remote by name. A glob of refs/remotes/*/<branch> never matches a remote whose own
  // name holds a slash, which is the case this is here for.
  const carrying: string[] = [];
  if (!local) {
    const names = (await run(['remote'])).stdout.split('\n').map((name) => name.trim()).filter((name) => name !== '');
    for (const name of names) {
      if ((await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${name}/${branch}`])).code === 0) {
        carrying.push(`refs/remotes/${name}/${branch}`);
      }
    }
  }
  if (carrying.length > 1) {
    throw new Error(`The branch ${branch} is on more than one remote (${carrying.join(', ')}), so Nolzu will not guess which one the card continues. Delete the ones that do not belong, or make the branch locally first.`);
  }
  const remote = carrying[0] ?? '';
  const dashed = !local && remote === '' ? dashedBase(baseBranch) : null;
  if (dashed !== null) throw new Error(dashed);
  if (!local && remote === '' && (await run(['rev-parse', '--verify', '--quiet', baseBranch])).code !== 0) {
    throw new Error(`The base branch ${baseBranch} is not in this repository. ${baseAdvice(repo)}`);
  }

  // The commit this call would cut the branch from. The cleanup compares against it, so a branch
  // that someone else made or moved in the meantime is left alone: it is theirs, and deleting it
  // would make their commit unreachable.
  const cutFrom = local ? '' : (await run(['rev-parse', '--verify', '--quiet', `${remote === '' ? baseBranch : remote}^{commit}`])).stdout.trim();

  // Cleanup runs without the caller's signal: after an abort every further call through it would
  // reject at once and leave the half made worktree and the new branch behind for good.
  const undo = async () => {
    const plain = { cwd: at, env, repo: repoPlace };
    // The state is read again here. Another call for the same key may have finished in between,
    // and deleting what that one created would be worse than the half made state being cleaned.
    let owned: readonly { path: string; branch: string | null }[];
    try {
      const listed = await git(['worktree', 'list', '--porcelain'], plain);
      // An empty answer from a failed or killed git reads as nobody owning the path, which is the
      // most destructive reading there is. The code is checked before the output is believed.
      if (listed.code !== 0) return;
      owned = parseWorktrees(listed.stdout);
    } catch {
      // Without a reliable answer, touching nothing is the safe move.
      return;
    }
    if (owned.some((entry) => entry.path === resolved || entry.path === target)) return;

    // Each step stands on its own: a removal that races the killed git child used to throw and
    // take the prune and the branch delete down with it.
    if (ours) {
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // The folder stays. The next call reports it rather than deleting a person's files.
      }
    }
    if (!local && cutFrom !== '' && !owned.some((entry) => entry.branch === branch)) {
      try {
        const now = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], plain)).stdout.trim();
        // Only the branch this call made, still where it was put. Anything else belongs to
        // whoever moved it.
        if (now === cutFrom) await git(['branch', '-D', branch], plain);
      } catch {
        // The branch is gone already, or another call is using it.
      }
    }
  };

  // A repository one folder down sits in the card's root folder, which git's wall does not open: only
  // the checkout itself. So Nolzu makes the root first.
  if (repo !== '.') makeFolders(projectPath, checkoutRoot(projectPath, key));

  const add = local
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, remote === '' ? baseBranch : remote];

  let failure: string | null = null;
  try {
    const added = await run(add);
    if (added.code !== 0) failure = added.stderr.trim();
  } catch (error) {
    await undo();
    throw error;
  }
  if (failure !== null) {
    await undo();
    throw new Error(`Git refused to create the worktree at ${target}. ${failure}`);
  }

  return { path: target, branch, created: true };
  }
}
