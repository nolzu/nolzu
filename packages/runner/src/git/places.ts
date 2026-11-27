import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';

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
  // The own git folder from Nolzu's record. A linked worktree needs it: a run can write the files that
  // would otherwise tell which one it is.
  gitDir?: string;
}

export type PlacesAnswer = { ok: true; places: RepoPlaces } | { ok: false; reason: string };

type Place = string | { reason: string };

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

/**
 * Where a repository's work tree and git folders are on disk, checked against where Nolzu's own record
 * says they are. Each folder is walked from the project folder down, one step at a time, and no step
 * may be a link. The `.git` file and the `commondir` file must name the expected folders as written,
 * and git's own answer must agree. So a pointer a run edited to lead into another repository, a
 * pointer that reaches the right folder through a link, or a folder swapped for a link is refused
 * with a sentence before any git call writes there. Read only: it runs one `rev-parse`.
 */
export async function repoPlaces(want: ExpectedPlaces, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<PlacesAnswer> {
  const project = real(want.project);
  if (project === null) return { ok: false, reason: `The project folder ${want.project} is not there, so Nolzu did not run git in it.` };
  // The folder as git names it, reached from the project folder with no link followed. A path may be
  // written from the project folder as the record has it, or as the real one, as git writes pointers.
  const below = (path: string, what: string): Place => {
    const step = [relative(resolve(want.project), resolve(path)), relative(project, resolve(path))].find(inside);
    if (step === undefined) return { reason: `${what} ${path} is outside the project folder ${want.project}, so Nolzu did not run git there.` };
    let at = project;
    for (const part of step.split(sep).filter((part) => part !== '')) {
      at = join(at, part);
      const stat = lstat(at);
      if (stat === undefined) return { reason: `${what} ${path} is not there, so Nolzu did not run git in it.` };
      if (stat.isSymbolicLink()) return { reason: `${at} is a link, on the way to ${what} ${path}. Nolzu stopped before running git there. Remove the link, and check what it points to.` };
    }
    return real(at) ?? { reason: `${what} ${path} is not there, so Nolzu did not run git in it.` };
  };
  // The folder a pointer file names, relative to the folder it sits in, as git reads it.
  const named = (file: string, from: string, prefix: string): string | null => {
    try {
      const text = readFileSync(file, 'utf8').trim();
      return text.startsWith(prefix) ? resolve(from, text.slice(prefix.length).trim()) : null;
    } catch {
      return null;
    }
  };
  const fail = (place: Place): PlacesAnswer => ({ ok: false, reason: typeof place === 'string' ? place : place.reason });

  const workTree = below(want.workTree, 'the work tree');
  if (typeof workTree !== 'string') return fail(workTree);
  const commonDir = below(want.commonDir ?? join(want.workTree, '.git'), 'the git folder');
  if (typeof commonDir !== 'string') return fail(commonDir);
  // A shared git folder with a `commondir` of its own would send git on to another one.
  if (lstat(join(commonDir, 'commondir')) !== undefined) {
    return fail(`${join(commonDir, 'commondir')} leads git to another git folder. Nolzu stopped before running git there. Remove the file.`);
  }
  let gitDir: string;
  if (commonDir === join(workTree, '.git')) {
    gitDir = commonDir;
  } else {
    if (want.gitDir === undefined) return fail(`Nolzu has no record of the git folder of ${want.workTree}, so it did not run git there.`);
    const own = below(want.gitDir, 'the git folder');
    if (typeof own !== 'string') return fail(own);
    gitDir = own;
    // Read as git reads them, and held to the folders the record names, as written.
    const dotGit = below(join(want.workTree, '.git'), 'the .git file');
    if (typeof dotGit !== 'string') return fail(dotGit);
    const pointed = named(dotGit, workTree, 'gitdir:');
    const pointedAt = pointed === null ? null : below(pointed, 'the folder the .git file names');
    if (pointedAt !== gitDir) {
      return fail(`The .git file of ${want.workTree} names ${pointed ?? 'no folder'}, not ${want.gitDir}. Nolzu stopped before running git there. Check the .git file in the work tree.`);
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
