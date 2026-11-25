import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RunGit } from './git/base.ts';
import { PATCH_CAP_BYTES } from './git/diff.ts';
import { git } from './git/exec.ts';

/**
 * Where a project's knowledge may live.
 *
 * The knowledge directory is a git repository, or a path inside one,
 * because every applied change is a commit and a revert is a revert commit. Nothing here picks a
 * default: `resolveKnowledgeDir` in `@nolzu/core` does that, and it answers `.nolzu/knowledge` in
 * the project when the setting is empty.
 */
export type KnowledgeProblem =
  | 'not-absolute'
  | 'missing'
  | 'not-a-folder'
  | 'no-repository'
  | 'ignored'
  | 'inside-worktrees'
  | 'inside-tasks'
  | 'holds-project'
  | 'repo-ignored';

export interface KnowledgeCheck {
  ok: boolean;
  problem: KnowledgeProblem | null;
  // The one sentence a person reads. Null when the folder is fine.
  reason: string | null;
}

const fine: KnowledgeCheck = { ok: true, problem: null, reason: null };
const no = (problem: KnowledgeProblem, reason: string): KnowledgeCheck => ({ ok: false, problem, reason });

// True when `path` is the folder itself or something under it. The separator matters: without it
// a folder named `worktrees-old` passes as `worktrees`.
const under = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + sep);

/**
 * Check a knowledge folder before anything is written into it.
 *
 * Two of the refusals are about the project's own layout rather than about git. A knowledge folder
 * inside `worktrees/` belongs to one card's branch, so every wrap-up would write into a checkout
 * that is deleted when the card closes, and the knowledge would go with it. A folder inside
 * `.tasks/` belongs to one card as well, and the Knowledge screen reads one folder for the whole
 * project.
 *
 * A folder that is not there is refused, not made. That is right for a path a person typed, and it
 * is why the code that writes knowledge makes the default folder before it asks here.
 *
 * `run` is git in the folder itself. It is passed in so this is testable without a repository on
 * the caller's side, and so the caller decides the environment git runs with.
 */
export async function checkKnowledgeDir(
  path: string,
  // The project's repositories by their path. Each one's folder in the knowledge folder is checked too.
  options: { projectPath: string | null; run: RunGit; repos?: readonly string[] },
): Promise<KnowledgeCheck> {
  if (!isAbsolute(path)) {
    return no('not-absolute', 'The knowledge folder is a full path, such as /home/you/recipes/.nolzu/knowledge.');
  }
  const folder = resolve(path);

  if (options.projectPath !== null) {
    const project = resolve(options.projectPath);
    if (under(folder, resolve(project, 'worktrees'))) {
      return no(
        'inside-worktrees',
        'The knowledge folder is inside worktrees, which belongs to one card and is removed when that card closes. Pick a folder outside it.',
      );
    }
    if (under(folder, resolve(project, '.tasks'))) {
      return no(
        'inside-tasks',
        'The knowledge folder is inside .tasks, which belongs to one card. Knowledge is read for the whole project, so pick a folder outside it.',
      );
    }
  }

  if (!existsSync(folder)) {
    return no('missing', `There is no folder ${folder}. Make it first, or pick one that is there.`);
  }
  if (!statSync(folder).isDirectory()) {
    return no('not-a-folder', `${folder} is a file, not a folder.`);
  }

  // After a knowledge run Nolzu deletes every `.git` that is new in the folder, because one the run
  // made would steer the next commit. In the project folder or above it, that would take the checkout
  // or the clone another card made meanwhile. Real paths, so a link to the project counts too.
  if (options.projectPath !== null && existsSync(options.projectPath) && under(realpathSync(options.projectPath), realpathSync(folder))) {
    return no('holds-project', `The knowledge folder ${folder} is the project folder or holds it. Pick a folder inside the project, such as .nolzu/knowledge.`);
  }

  // A repository, or a path inside one. `--is-inside-work-tree` answers for both, and it answers
  // false inside a bare repository's own folder, which is the case a plain `.git` check would let
  // through.
  const inside = await run(options.run, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return no(
      'no-repository',
      `${folder} is in no git repository. Every knowledge change is a commit, so it has to be one, or sit inside one.`,
    );
  }

  // A folder git ignores takes no commit. `status` never lists an ignored file either, so without
  // this a wrap-up would read an empty folder, commit nothing and end as if it had taught nothing.
  // `check-ignore` exits 0 when the path is ignored and 1 when it is not. `--no-index` reads the
  // patterns alone: a folder with files git tracks still takes no new file.
  const ignored = await options.run(['check-ignore', '-q', '--no-index', '.']);
  if (ignored.code === 0) {
    return no(
      'ignored',
      `git ignores ${folder}, so nothing written there can be committed. Take it out of .gitignore, or pick another folder.`,
    );
  }

  const repoIgnored = await ignoredRepoFolders(options.run, options.repos ?? []);
  return repoIgnored === null ? fine : no('repo-ignored', repoIgnored);
}

/**
 * The sentence for the repository folders of the knowledge folder that git ignores, or null.
 *
 * A `.gitignore` line such as `api/` with no leading slash matches every folder named api, so also
 * `api/` in the knowledge folder. A note written there would never show in `git status`, so no run
 * could commit or hold it. `shared/` is checked with them. `run` is git in the knowledge folder.
 */
export async function ignoredRepoFolders(git: RunGit, repos: readonly string[]): Promise<string | null> {
  const folders = [...new Set([...repos.filter((repo) => repo !== '.'), 'shared'])];
  // A file inside each folder, because a pattern with a trailing slash matches only a folder, and
  // git reads each part of a path that is not there yet as a folder.
  const ignored = await git(['check-ignore', '-v', '--no-index', '--', ...folders.map((folder) => `${folder}/repository.md`)]);
  if (ignored.code !== 0) return null;
  const lines = ignored.stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const named = lines.map((line) => (line.split('\t')[1] ?? '').replace(/\/repository\.md$/, '/'));
  const patterns = [...new Set(lines.map((line) => (line.split('\t')[0] ?? '').split(':').slice(2).join(':')))];
  return `git ignores ${named.join(', ')} in the knowledge folder, through the .gitignore ${patterns.length === 1 ? 'line' : 'lines'} ${patterns.join(', ')}, so nothing written there can be committed. Start each with a slash, such as /${(patterns[0] ?? '').replace(/^\//, '')}, so it holds only the folder at the top of the project.`;
}

const run = async (git: RunGit, args: readonly string[]): Promise<string> => {
  const result = await git(args);
  return result.code === 0 ? result.stdout.trim() : '';
};

/**
 * Whether a run of one project could reach another project's knowledge.
 *
 * Project isolation is strict: knowledge of one project is never loaded into another project's
 * run. The free client holds one project, so today this can only be broken by a settings mistake,
 * and it is checked rather than assumed because a paid plan adds a second project.
 */
export function isolated(folder: string, otherFolders: readonly string[]): boolean {
  const mine = resolve(folder);
  return !otherFolders.some((other) => {
    const theirs = resolve(other);
    return under(mine, theirs) || under(theirs, mine);
  });
}

// The path the relative form reads as, for a sentence that names where a folder sits inside the
// project. Outside the project it stays absolute, because a string of `..` names nothing useful.
export const insideProject = (folder: string, projectPath: string): string => {
  const step = relative(resolve(projectPath), resolve(folder));
  return step === '' || step.startsWith('..') ? resolve(folder) : step;
};

/**
 * git in a knowledge folder, held to the repository the folder is in now. Called before the run
 * that may write the folder: that run could make a repository inside it, and git run there would
 * read the run's config, whose filter runs outside the wall. A folder in no repository gets git as
 * it is, and `checkKnowledgeDir` refuses it.
 */
// Every `.git` in the folder at any depth, without walking into one or through a folder link.
function gitsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === '.git') return [path];
    return entry.isDirectory() ? gitsUnder(path) : [];
  });
}

/**
 * The events of a run, with `sweep` called once they end, however they end: done, thrown, or left by
 * the caller. A run that throws partway can still have made a repository in the knowledge folder.
 */
export async function* sweptAfter<T>(events: AsyncIterable<T>, sweep: () => void): AsyncGenerator<T> {
  try {
    yield* events;
  } finally {
    sweep();
  }
}

export async function knowledgeGit(folder: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ run: RunGit; forPatch: RunGit; sweep: () => boolean }> {
  const had = new Set(gitsUnder(folder));
  // A folder that is not there gets the sentence `checkKnowledgeDir` has for it, not git's error.
  const found = existsSync(folder) ? await git(['rev-parse', '--absolute-git-dir', '--show-toplevel', '--git-common-dir'], { cwd: folder, env, signal }) : null;
  const [gitDir, top, common] = found?.stdout.trim().split('\n') ?? [];
  // The shared git folder is pinned too: for a folder in a linked worktree, git reads it from the
  // worktree's `commondir` file, which the run could point at a folder with a config of its own.
  const pinned =
    found?.code === 0 && gitDir !== undefined && top !== undefined && common !== undefined ? { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: top, GIT_COMMON_DIR: resolve(folder, common) } : env;
  return {
    run: (args) => git(args, { cwd: folder, env: pinned, signal }),
    // Reads one character past the cap and no further: `knowledgeDiffs` pipes a file's own content
    // through git, so a note somebody let grow to half a gigabyte would otherwise sit here whole.
    forPatch: (args) => git(args, { cwd: folder, env: pinned, signal, maxStdout: PATCH_CAP_BYTES + 1 }),
    // A `.git` the run made in the folder, at any depth, removed after it: at the top the Knowledge
    // screen's git would use it, and further down a commit would point at it. On macOS the wall
    // stops a run making one at the top; on Linux it cannot hold a name that is not there yet.
    sweep: () => {
      const made = gitsUnder(folder).filter((path) => !had.has(path));
      for (const path of made) rmSync(path, { recursive: true, force: true });
      return made.length > 0;
    },
  };
}
