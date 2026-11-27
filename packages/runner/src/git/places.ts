import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';
import { checkoutPath, repoFolder } from './worktree.ts';

export interface RepoPlaces {
  workTree: string;
  // The repository's own git folder: the shared one for a plain repository, `<common>/worktrees/<name>`
  // for a linked worktree.
  gitDir: string;
  commonDir: string;
}

export interface ExpectedPlaces {
  // The project folder Nolzu's record names. Every path below must sit inside it, with no link on
  // the way down from it.
  project: string;
  workTree: string;
  // The shared git folder. Left out, it is `<workTree>/.git`, a plain repository.
  commonDir?: string;
  // The own git folder of a linked worktree. Left out, it is the one folder in the shared folder's
  // `worktrees` whose `gitdir` names this work tree. A run of one card can write only its own.
  gitDir?: string;
  // Set when the record already shows the repository is not where it was: every write there is
  // refused with this sentence, and the repository is marked.
  refuse?: string;
}

// `missing` is set when a folder is simply not there, which is no sign that anybody moved a pointer.
export type PlacesAnswer = { ok: true; places: RepoPlaces } | { ok: false; reason: string; missing?: boolean };

type Place = string | { reason: string; missing?: boolean };

/** The repository of a project, or of one of its repositories by folder name. */
export const projectPlace = (project: string, repo = '.'): ExpectedPlaces => ({ project, workTree: repoFolder(project, repo) });

/** A card's checkout of one repository of the project, which shares that repository's git folder. */
export const cardPlace = (project: string, key: string, repo = '.'): ExpectedPlaces => ({
  project,
  workTree: checkoutPath(project, key, repo),
  commonDir: join(repoFolder(project, repo), '.git'),
});

// The native realpath, so a path a record holds in another case on macOS names the folder as git does.
const real = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

// Undefined for a path that is not there, also when a step on the way is a file.
const lstat = (path: string) => {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
};

const inside = (step: string): boolean => step !== '..' && !step.startsWith(`..${sep}`) && !isAbsolute(step);

// The folder a pointer file names, relative to the folder it sits in, as git reads it.
const named = (file: string, from: string, prefix: string): string | null => {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text.startsWith(prefix) ? resolve(from, text.slice(prefix.length).trim()) : null;
  } catch {
    return null;
  }
};

/**
 * Where a project's `.git` leads when it is a link, or a file that names a git folder, as the
 * person set it up: the real folder. Null for a plain `.git` folder or none.
 */
export function gitLinkOf(project: string): string | null {
  const dotGit = join(project, '.git');
  const stat = lstat(dotGit);
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return real(dotGit);
  if (!stat.isFile()) return null;
  const to = named(dotGit, project, 'gitdir:');
  return to === null ? null : real(to);
}

/**
 * The git folder a project's `.git` leads to: the folder itself when it is a plain one, else where the
 * link or the file leads (`gitLinkOf`). Null when there is none.
 */
export function gitFolderOf(project: string): string | null {
  const dotGit = join(project, '.git');
  return lstat(dotGit)?.isDirectory() === true ? real(dotGit) : gitLinkOf(project);
}

// Where each project's `.git` led when Nolzu first opened the project, by the project folder.
const gitLinks = new Map<string, string>();

/** Holds where a project's `.git` led when Nolzu first opened it. Null forgets it. */
export function pinGitLink(project: string, led: string | null): void {
  for (const key of new Set([resolve(project), real(project) ?? resolve(project)])) {
    if (led === null) gitLinks.delete(key);
    // As recorded, never resolved again: a link swapped in since would be followed.
    else gitLinks.set(key, resolve(led));
  }
}

/**
 * Where a repository's work tree and git folders are on disk, checked against where Nolzu's own record
 * says they are. Each folder is walked from the project folder down, one step at a time, and no step
 * may be a link. A project's own `.git` that is a link or a file may lead elsewhere only where it led
 * when Nolzu first opened the project (`pinGitLink`), and its folders are then walked from there. The
 * `.git` file and the `commondir` file must name the expected folders as
 * written, and git's own answer must agree. So a pointer a run edited to lead into another repository,
 * a pointer that reaches the right folder through a link, or a folder swapped for a link is refused
 * with a sentence before any git call writes there. Read only: it runs one `rev-parse`.
 */
export async function repoPlaces(want: ExpectedPlaces, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<PlacesAnswer> {
  const project = real(want.project);
  if (project === null) return { ok: false, reason: `The project folder ${want.project} is not there, so Nolzu did not run git in it.`, missing: true };
  const fail = (place: Place): PlacesAnswer => (typeof place === 'string' ? { ok: false, reason: place } : { ok: false, ...place });
  // Where the project's `.git` led when Nolzu first opened it, and the shared folder of that one: the
  // one its `commondir` names when the project is itself a linked worktree.
  const linked = gitLinks.get(resolve(want.project)) ?? gitLinks.get(project);
  const projectGit = join(project, '.git');
  const viaLink = linked !== undefined && lstat(projectGit)?.isDirectory() === false;
  const linkedCommon = linked === undefined ? undefined : (real(named(join(linked, 'commondir'), linked, '') ?? linked) ?? linked);
  // Where a path may be written from, and the real folder its walk starts at: the project as the
  // record names it, or as the real one, as git writes pointers, and the folders its `.git` leads to.
  const roots: [string, string][] = [[resolve(want.project), project], [project, project]];
  if (viaLink && linked !== undefined && linkedCommon !== undefined) roots.push([linkedCommon, linkedCommon], [linked, linked]);
  // The folder as git names it, reached from a root with no link followed.
  const below = (path: string, what: string): Place => {
    const from = roots.map(([written, start]) => [relative(written, resolve(path)), start] as const).find(([step]) => inside(step));
    if (from === undefined) return { reason: `${what} ${path} is outside the project folder ${want.project}, so Nolzu did not run git there.` };
    const [step, start] = from;
    const gone = { reason: `${what} ${path} is not there, so Nolzu did not run git in it.`, missing: true };
    let at = start;
    for (const part of step.split(sep).filter((part) => part !== '')) {
      at = join(at, part);
      const stat = lstat(at);
      if (stat === undefined) return gone;
      if (stat.isSymbolicLink()) return { reason: `${at} is a link, on the way to ${what} ${path}. Nolzu stopped before running git there. Remove the link, and check what it points to.` };
    }
    return real(at) ?? gone;
  };

  const workTree = below(want.workTree, 'the work tree');
  if (typeof workTree !== 'string') return fail(workTree);
  const dotGit = join(want.workTree, '.git');
  // The project's own repository, or a card checkout that shares it, when the project's `.git` leads
  // elsewhere: it must lead where it led, and its folders are the recorded ones.
  const ownRepo = workTree === project && want.commonDir === undefined;
  const sharesIt = want.commonDir !== undefined && [join(resolve(want.project), '.git'), projectGit].includes(resolve(want.commonDir));
  if (viaLink && linked !== undefined && (ownRepo || sharesIt)) {
    const now = gitLinkOf(project);
    if (now !== linked) {
      return fail(`${projectGit} leads to ${now ?? 'no git folder'}, not to ${linked}, where it led when Nolzu first opened the project. Nolzu stopped before running git there. Point it back at ${linked}. If you moved it on purpose, choose the project folder again in Settings, Project.`);
    }
  }
  const linkedHere = viaLink && linked !== undefined && linkedCommon !== undefined;
  const commonDir = linkedHere && (ownRepo || sharesIt) ? (linkedCommon ?? '') : below(want.commonDir ?? dotGit, 'the git folder');
  if (typeof commonDir !== 'string') return fail(commonDir);
  // A shared git folder with a `commondir` of its own would send git on to another one.
  if (lstat(join(commonDir, 'commondir')) !== undefined) {
    return fail(`${join(commonDir, 'commondir')} leads git to another git folder. Nolzu stopped before running git there. Remove the file.`);
  }
  let gitDir: string;
  if (linkedHere && ownRepo) {
    gitDir = linked ?? '';
  } else if (commonDir === below(dotGit, 'the git folder')) {
    gitDir = commonDir;
  } else {
    const own = want.gitDir === undefined ? ownGitDir(commonDir, workTree) : below(want.gitDir, 'the git folder');
    if (own === null) return fail(`No one git folder in ${join(commonDir, 'worktrees')} names ${want.workTree}, so Nolzu did not run git there. Remove the checkout, and start the card again.`);
    if (typeof own !== 'string') return fail(own);
    gitDir = own;
    // Read as git reads them, and held to the folders the record names, as written.
    const file = below(dotGit, 'the .git file');
    if (typeof file !== 'string') return fail(file);
    const pointed = named(file, workTree, 'gitdir:');
    const pointedAt = pointed === null ? null : below(pointed, 'the folder the .git file names');
    if (pointedAt !== gitDir) {
      return fail(`The .git file of ${want.workTree} names ${pointed ?? 'no folder'}, not ${want.gitDir ?? gitDir}. Nolzu stopped before running git there. Check the .git file in the work tree.`);
    }
    const common = named(join(gitDir, 'commondir'), gitDir, '');
    const commonAt = common === null ? null : below(common, 'the folder commondir names');
    if (commonAt !== commonDir) {
      return fail(`${join(gitDir, 'commondir')} names ${common ?? 'no folder'}, not ${commonDir}. Nolzu stopped before running git there. Check the commondir file.`);
    }
  }
  if (want.gitDir !== undefined && below(want.gitDir, 'the git folder') !== gitDir) {
    return fail(`The git folder of ${want.workTree} is ${gitDir}, not ${want.gitDir}. Nolzu stopped before running git there.`);
  }

  const said = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd: workTree, env: gitEnv(env), signal });
  const [top, own, common] = said.stdout.split('\n').map((line) => (line === '' ? null : real(line)));
  if (said.code !== 0 || top == null || own == null || common == null) {
    return fail(`git could not say where the repository at ${want.workTree} is. ${said.stderr.trim()}`.trim());
  }
  if (top !== workTree || own !== gitDir || common !== commonDir) {
    return fail(`git finds the repository of ${want.workTree} at ${top}, with its git folders at ${own} and ${common}, not where Nolzu made them. Nolzu stopped before running git there. Check the .git file in the work tree.`);
  }
  return { ok: true, places: { workTree, gitDir, commonDir } };
}

// The one folder in `<common>/worktrees` whose `gitdir` names `<workTree>/.git`, or null when none
// does or more than one does. Each card's run may write only its own such folder, so a run that points
// its own at another card's checkout makes two, and both are refused.
function ownGitDir(commonDir: string, workTree: string): string | null {
  const folder = join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return null;
  }
  const want = join(workTree, '.git');
  const namesThis = (admin: string) => {
    const back = named(join(admin, 'gitdir'), admin, '');
    return back !== null && (back === want || real(back) === want);
  };
  const found = names.map((name) => join(folder, name)).filter((admin) => lstat(admin)?.isDirectory() === true && namesThis(admin));
  return found.length === 1 ? (found[0] ?? null) : null;
}
