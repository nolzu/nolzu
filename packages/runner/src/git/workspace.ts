import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { messageProblem, type CommitResult } from './commit.ts';
import { filePatch, type FilePatch } from './diff.ts';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';
import { parseStatus } from './porcelain.ts';
import { pushBranch, pushConfirmation, type PushResult } from './push.ts';
import { statusEntries } from './read-only-check.ts';

// The Workspace page: the project folder and each repository of the project as the person has them,
// not a card's checkout. Nothing here fetches, pulls, switches a branch or forces a push.

export type WorkspaceFileStatus = 'changed' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface WorkspaceFile {
  path: string;
  // The path before a staged rename, and null for everything else.
  oldPath: string | null;
  status: WorkspaceFileStatus;
  // Something of this file is in the index already.
  staged: boolean;
  // A file Nolzu writes, which the page ticks by default. Every other file is the person's.
  owner: 'nolzu' | 'yours';
}

export type RepoState =
  | {
      ok: true;
      // Null on a detached head.
      branch: string | null;
      upstream: string | null;
      // Against the upstream as git last knew it. Nothing is fetched to read them.
      ahead: number;
      behind: number;
      files: WorkspaceFile[];
      // The sentence the person agrees to before a push, or null when there is nowhere to push.
      confirmation: string | null;
    }
  | { ok: false; reason: string };

export interface ReadRepoOptions {
  folder: string;
  // Folders inside this one, relative to it, whose files are not this repository's: the other
  // repositories of the project and the card checkouts.
  skip?: readonly string[];
  // Paths of the files Nolzu writes, relative to the folder. One that ends in a slash is a folder.
  nolzuFiles?: readonly string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

const statusOf = (xy: string): WorkspaceFileStatus => {
  if (CONFLICTS.has(xy)) return 'conflicted';
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'A' || xy[0] === 'C') return 'added';
  return 'changed';
};

const under = (path: string, folder: string): boolean => {
  const clean = folder.replace(/\/+$/, '');
  return path === clean || path.startsWith(`${clean}/`);
};

const ownerOf = (path: string, nolzu: readonly string[]): 'nolzu' | 'yours' =>
  nolzu.some((one) => (one.endsWith('/') ? under(path, one) : path === one)) ? 'nolzu' : 'yours';

/**
 * A path the client sent that leaves the repository: empty, absolute, climbing with `..`, or through a
 * folder link that points outside. The file itself is not resolved, because git shows a file link as
 * the path it points to and never its contents.
 */
export function outsideRepo(root: string, path: string): boolean {
  if (path === '' || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..')) return true;
  const real = realpathSync(root);
  const full = resolve(real, path);
  if (!full.startsWith(`${real}${sep}`)) return true;
  // The nearest folder that is there: a link higher up still leads out when the folders under it are gone.
  let folder = dirname(full);
  while (!existsSync(folder)) folder = dirname(folder);
  return !`${realpathSync(folder)}${sep}`.startsWith(`${real}${sep}`);
}

const runIn = (folder: string, env: Record<string, string> | undefined, signal?: AbortSignal) => {
  const given = gitEnv(env ?? process.env);
  return (args: readonly string[], hooks = false) => git(args, { cwd: folder, env: given, signal, hooks });
};

/** One folder of the workspace as git reads it from disk. Never touches the network. */
export async function readRepo(options: ReadRepoOptions): Promise<RepoState> {
  if (!existsSync(options.folder)) return { ok: false, reason: 'The folder is not there.' };
  // Asked here, or git walks up and answers about the repository around the folder.
  if (!existsSync(resolve(options.folder, '.git'))) return { ok: false, reason: 'The folder is not a git repository.' };
  const run = runIn(options.folder, options.env, options.signal);

  const head = await run(['status', '--porcelain=v2', '--branch', '--untracked-files=no']);
  if (head.code !== 0) return { ok: false, reason: `git could not read the folder. ${head.stderr.trim()}` };
  const { branch, upstream, ahead, behind } = parseStatus(head.stdout);

  const listed = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (listed.code !== 0) return { ok: false, reason: `git could not read the folder. ${listed.stderr.trim()}` };
  const skip = options.skip ?? [];
  const files: WorkspaceFile[] = [];
  for (const { path, xy, from } of statusEntries(listed.stdout)) {
    // git lists a folder that holds its own repository as one entry ending in a slash, as it does a
    // card checkout the exclude file missed. Its files belong to that repository.
    if (path.endsWith('/') || skip.some((folder) => under(path, folder))) continue;
    files.push({ path, oldPath: xy[0] === 'R' ? from : null, status: statusOf(xy), staged: xy[0] !== ' ' && xy[0] !== '?', owner: ownerOf(path, options.nolzuFiles ?? []) });
  }

  let confirmation: string | null = null;
  if (branch !== null && upstream !== null) {
    const remote = (await run(['config', '--get', `branch.${branch}.remote`])).stdout.trim();
    const url = remote === '' ? '' : (await run(['remote', 'get-url', '--push', remote])).stdout.trim();
    if (url !== '') confirmation = pushConfirmation(branch, remote, url);
  }
  return { ok: true, branch, upstream, ahead, behind, files, confirmation };
}

/** One changed file's patch, an untracked one included, with the card patch's size cap. */
export async function repoPatch(options: { folder: string; file: WorkspaceFile; env?: Record<string, string>; signal?: AbortSignal }): Promise<FilePatch> {
  const { file } = options;
  // `uncommitted` is HEAD to the folder, staged and unstaged together, and needs no base branch.
  return filePatch({ worktreePath: options.folder, baseBranch: 'HEAD', path: file.path, ...(file.oldPath === null ? {} : { oldPath: file.oldPath }), group: 'uncommitted', env: options.env, signal: options.signal });
}

export interface CommitPathsOptions {
  folder: string;
  message: string;
  // The ticked files, each checked against the status by the caller.
  files: readonly WorkspaceFile[];
  // As on the card commit: the repository's hooks run only when the person turned them on.
  hooks?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Commits exactly the ticked files. `--only` builds the commit from HEAD plus those paths, so a file the
 * person staged and did not tick stays staged and out of the commit. The author is whoever git is
 * configured as, with no trailer.
 */
export async function commitPaths(options: CommitPathsOptions): Promise<CommitResult> {
  const message = options.message.replace(/\r\n/g, '\n');
  const problem = messageProblem(message);
  if (problem !== null) return { ok: false, reason: problem };
  if (options.files.length === 0) return { ok: false, reason: 'No file is ticked. Tick the files to commit, then commit.' };
  const run = runIn(options.folder, options.env, options.signal);

  const unmerged = await run(['ls-files', '--unmerged']);
  if (unmerged.code !== 0) return { ok: false, reason: unmerged.stderr.trim() };
  if (unmerged.stdout.trim() !== '') {
    return { ok: false, reason: 'This folder has conflicts that are not resolved yet. Fix them in your editor, mark them resolved with git add, then commit.' };
  }

  // `:(literal)` so a name holding a bracket or a star means that file and not its siblings.
  const literal = (paths: readonly string[]) => paths.map((path) => `:(literal)${path}`);
  // git commits only paths it knows, so a new file is added first, and taken out again if the commit fails.
  const added = options.files.filter((file) => file.status === 'untracked').map((file) => file.path);
  if (added.length > 0) {
    const staged = await run(['add', '--', ...literal(added)]);
    if (staged.code !== 0) return { ok: false, reason: staged.stderr.trim() };
  }
  // A rename is two paths to git: without the old one the commit would add the new file and keep the old.
  const paths = options.files.flatMap((file) => (file.oldPath === null ? [file.path] : [file.path, file.oldPath]));
  const made = await run(['commit', '--only', '--cleanup=verbatim', '-m', message, '--', ...literal(paths)], options.hooks === true);
  if (made.code !== 0) {
    // `reset`, not `rm --cached`, which runs git inside a folder whose `.git` is a file (`commitCard`).
    if (added.length > 0) await run(['reset', '-q', '--', ...literal(added.map((path) => path.replace(/\/+$/, '')))]);
    const said = made.stderr.trim();
    return { ok: false, reason: said === '' ? 'git refused the commit and said nothing about why.' : said };
  }
  return { ok: true, commit: (await run(['rev-parse', 'HEAD'])).stdout.trim() };
}

/**
 * Pushes the current branch to its upstream and nowhere else, never with force. A push the remote turns
 * down because it has newer commits is reported, and nothing is pulled: that is the person's to do.
 */
export async function pushUpstream(options: { folder: string; hooks?: boolean; env?: Record<string, string>; signal?: AbortSignal }): Promise<PushResult> {
  const run = runIn(options.folder, options.env, options.signal);
  const branch = (await run(['branch', '--show-current'])).stdout.trim();
  if (branch === '') return { ok: false, reason: 'This folder is on no branch, so there is nothing to push. Check out a branch in your editor or terminal first.' };
  const remote = (await run(['config', '--get', `branch.${branch}.remote`])).stdout.trim();
  const merge = (await run(['config', '--get', `branch.${branch}.merge`])).stdout.trim();
  if (remote === '' || merge === '') {
    return { ok: false, reason: `${branch} has no upstream, so Nolzu does not know where to push it. Push it once with git push -u in a terminal, then push here.` };
  }
  // To the upstream's ref, so the commits land there even when its name differs.
  const pushed = await pushBranch({ worktreePath: options.folder, branch, to: merge, remote, hooks: options.hooks, env: options.env, signal: options.signal });
  if (!pushed.ok && pushed.rejected === true) {
    return { ...pushed, reason: `${remote} has commits on ${branch} that this folder does not have. Pull them in your editor or terminal, then push again. Nothing was pulled.` };
  }
  return pushed;
}
