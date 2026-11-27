import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { ReadOnlyBreak } from '@nolzu/protocol';
import { PATCH_CAP_BYTES } from './diff.ts';
import { git } from './exec.ts';
import { cardPlace, type ExpectedPlaces } from './places.ts';
import { parseWorktrees } from './porcelain.ts';
import { checkoutPath, isPlainName, repoFolder } from './worktree.ts';
import { gitDirs } from '../wall-detect.ts';

// The git compare after a read-only run. The wall should make
// it never fire. It is the last check: it sees a gap in the wall, and says so.

// One repository's state as a read-only run could change it. `files` maps each path git status
// lists to its two letters, and for a file that is not ignored also a hash of its content, so a
// file that was already changed and changed again still reads as a change.
export interface GitSnapshot {
  root: string;
  // `refs/heads/<name>` while on a branch, the commit when detached, '' before the first commit.
  head: string;
  commit: string | null;
  refs: Record<string, string>;
  // The branches another checkout of the same repository has out. A run there commits to them while
  // this one runs, so they are no change of this run's.
  skip: string[];
  files: Record<string, string>;
  // The folders the run may write in, relative to the root, which the compare leaves out.
  exclude: string[];
  ignored: boolean;
}

export interface GitChange {
  head: { from: string; to: string } | null;
  refs: { ref: string; from: string | null; to: string | null }[];
  files: { path: string; from: string | null; to: string | null }[];
}

export interface GitBeforeOptions {
  // Absolute folders the run may write in: the card folder, the knowledge folder, the checkouts.
  exclude: readonly string[];
  // Whether ignored files count. A cache a tool writes while the run goes is ignored, so a caller
  // where something else writes such files leaves them out.
  ignored: boolean;
  env: Record<string, string>;
  signal?: AbortSignal;
}

// `git status --porcelain=v1 -z` as entries in git's order. A rename or a copy names its old path in
// the field after the new one.
export function statusEntries(text: string): { path: string; xy: string; from: string | null }[] {
  const entries: { path: string; xy: string; from: string | null }[] = [];
  const parts = text.split('\0');
  for (let at = 0; at < parts.length; at += 1) {
    const entry = parts[at] ?? '';
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    let from: string | null = null;
    if (xy[0] === 'R' || xy[0] === 'C') {
      at += 1;
      from = parts[at] ?? null;
      if (from === '') from = null;
    }
    entries.push({ path: entry.slice(3), xy, from });
  }
  return entries;
}

// The same as a map of path to its two letters. A rename's old path reads as gone with the rename's
// letters.
export function parseStatusZ(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const { path, xy, from } of statusEntries(text)) {
    files[path] = xy;
    if (from !== null && xy[0] === 'R') files[from] = `${xy} from`;
  }
  return files;
}

/** What changed between two states of one repository, or null when nothing did. Pure. */
export function compareGit(before: GitSnapshot, after: GitSnapshot): GitChange | null {
  const skip = new Set([...before.skip, ...after.skip]);
  const refs = [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])]
    .filter((ref) => !skip.has(ref))
    .sort()
    .flatMap((ref) => {
      const from = before.refs[ref] ?? null;
      const to = after.refs[ref] ?? null;
      return from === to ? [] : [{ ref, from, to }];
    });
  const files = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().flatMap((path) => {
    const from = before.files[path] ?? null;
    const to = after.files[path] ?? null;
    return from === to ? [] : [{ path, from, to }];
  });
  const head = before.head === after.head ? null : { from: before.head, to: after.head };
  return head === null && refs.length === 0 && files.length === 0 ? null : { head, refs, files };
}

// The real path of a folder, or of the nearest folder above it that is there, with the rest after
// it. git answers with real paths, and on macOS a temp folder is a link.
const real = (path: string): string => {
  if (existsSync(path)) return realpathSync(path);
  const up = dirname(path);
  return up === path ? path : join(real(up), basename(path));
};

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

const out = async (args: readonly string[], cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<string | null> => {
  const result = await git(args, { cwd, env, signal });
  return result.code === 0 ? result.stdout : null;
};

const pathspec = (exclude: readonly string[]): string[] => ['--', '.', ...exclude.map((path) => `:(exclude)${path}`)];

// The git folder of a repository folder Nolzu knows, when it is a plain clone with a `.git` folder of
// its own, real. A `.git` that is a link to a folder counts: the folder comes from Nolzu's records, and
// a person may keep the repository elsewhere. Null for anything else.
const plainCommon = (folder: string): string | null => {
  const dirs = gitDirs(folder);
  if (dirs === undefined || dirs.own !== dirs.common) return null;
  try {
    return realpathSync(dirs.common);
  } catch {
    return null;
  }
};

export interface RecordedRepos {
  // The project folder, and the paths of its repositories in it ("." for the folder itself).
  project: string;
  repos: readonly string[];
  // The card, and the paths of its repositories, whose checkouts sit at `checkoutPath`. A null key
  // names no card, such as a knowledge maintenance run.
  key: string | null;
  cardRepos: readonly string[];
  // Where the run starts.
  cwd: string;
}

/**
 * The repositories a read-only run reaches, from Nolzu's own records and never from a scan of a folder:
 * the recorded one the run starts in (the project folder, one of its repositories, or one of the card's
 * checkouts), and the card's checkouts inside the folder it starts in, as a card on several repositories
 * has them. A checkout counts only when its git folders are a worktree of the recorded repository. A
 * run that may write a card's folder can leave a repository of its own there, with a config whose
 * filter git would run outside the wall; it is none of these, so the check never runs git in it.
 */
export function recordedRepos(records: RecordedRepos): string[] {
  const commons = new Map<string, string>();
  const places: string[] = [];
  for (const repo of new Set(['.', ...records.repos])) {
    let folder: string;
    try {
      folder = repoFolder(records.project, repo);
    } catch {
      continue;
    }
    const common = plainCommon(folder);
    if (common === null) continue;
    commons.set(repo, common);
    places.push(realpathSync(folder));
  }
  const checkouts = records.key === null || !isPlainName(records.key)
    ? []
    : records.cardRepos.flatMap((repo) => {
        const common = commons.get(repo);
        let at: string;
        try {
          at = checkoutPath(records.project, records.key ?? '', repo);
        } catch {
          return [];
        }
        const dirs = common === undefined ? undefined : gitDirs(at);
        if (common === undefined || dirs === undefined || dirs.own === dirs.common) return [];
        try {
          return realpathSync(dirs.common) === common && dirname(realpathSync(dirs.own)) === join(common, 'worktrees') ? [realpathSync(at)] : [];
        } catch {
          return [];
        }
      });
  const here = real(records.cwd);
  const holding = [...places, ...checkouts].filter((place) => inside(here, place)).sort((one, other) => other.length - one.length)[0];
  return [...new Set([...(holding === undefined ? [] : [holding]), ...checkouts.filter((at) => inside(at, here))])];
}

// A hash of what a file holds, or '-' when it is gone or is no file.
// Limit: reads the whole file; a run that leaves a huge untracked file pays for one read of it.
const hashOf = (path: string): string => {
  try {
    return lstatSync(path).isFile() ? createHash('sha1').update(readFileSync(path)).digest('hex') : '-';
  } catch {
    return '-';
  }
};

async function snapshot(root: string, exclude: string[], ignored: boolean, env: Record<string, string>, signal?: AbortSignal): Promise<GitSnapshot> {
  const symbolic = await out(['symbolic-ref', '-q', 'HEAD'], root, env, signal);
  const commit = (await out(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], root, env, signal))?.trim() || null;
  const head = symbolic?.trim() || commit || '';
  const refs: Record<string, string> = {};
  for (const line of (await out(['for-each-ref', '--format=%(refname)%00%(objectname)'], root, env, signal))?.split('\n') ?? []) {
    const [ref, sha] = line.split('\0');
    // A fetch Nolzu runs for another card moves a remote ref, and a run cannot push one back here.
    if (ref !== undefined && sha !== undefined && ref !== '' && !ref.startsWith('refs/remotes/')) refs[ref] = sha;
  }
  const skip = parseWorktrees((await out(['worktree', 'list', '--porcelain'], root, env, signal)) ?? '')
    .filter((tree) => tree.branch !== null && existsSync(tree.path) && realpathSync(tree.path) !== root)
    .map((tree) => `refs/heads/${tree.branch}`);
  // Limit: with ignored files on, every file of node_modules is listed. git lists 100k paths in
  // about a second, twice per read-only run; leave ignored files out if that ever costs too much.
  const status = await out(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(ignored ? ['--ignored'] : []), ...pathspec(exclude)], root, env, signal);
  if (status === null) throw new Error(`git status failed in ${root}, so the read-only check cannot compare it.`);
  // Filtered again here: with --ignored, git lists an ignored path under an excluded folder all the
  // same (measured, git 2.54), so another card's new checkout read as this run's new file.
  const left = (path: string): boolean => !exclude.some((folder) => path === folder || path.startsWith(`${folder}/`));
  const files = Object.fromEntries(
    Object.entries(parseStatusZ(status))
      .filter(([path]) => left(path))
      .map(([path, xy]) => [path, xy === '!!' ? xy : `${xy} ${hashOf(join(root, path))}`]),
  );
  return { root, head, commit, refs, skip, files, exclude, ignored };
}

/**
 * The state of each repository the caller names, read right before the run starts. The caller names
 * them from its own records (`recordedRepos`): a folder found by looking around could be one a run made.
 */
export async function gitBefore(repos: readonly string[], options: GitBeforeOptions): Promise<GitSnapshot[]> {
  const roots = [...new Set(repos.map(real))];
  return Promise.all(
    roots.map((root) => {
      const exclude = options.exclude
        .map(real)
        .filter((folder) => folder !== root && inside(folder, root))
        .map((folder) => relative(root, folder));
      return snapshot(root, exclude, options.ignored, options.env, options.signal);
    }),
  );
}

// Whether a ref moved forward only by commits inside the folders the run may write in. That is
// Nolzu's own commit, such as the knowledge commit of a wrap-up that ran at the same time. A ref
// moved back or aside, or an empty commit, still counts.
async function ownCommitsOnly(snap: GitSnapshot, from: string | null, to: string | null, env: Record<string, string>): Promise<boolean> {
  if (from === null || to === null || from === '' || from.startsWith('refs/') || to.startsWith('refs/')) return false;
  if ((await git(['merge-base', '--is-ancestor', from, to], { cwd: snap.root, env })).code !== 0) return false;
  // No rename detection, so a file moved into the folder names its old path too.
  const names = await out(['log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', `${from}..${to}`], snap.root, env);
  const paths = names?.split('\0').map((path) => path.trim()).filter((path) => path !== '') ?? [];
  return paths.length > 0 && paths.every((path) => snap.exclude.some((folder) => path === folder || path.startsWith(`${folder}/`)));
}

// The change without the moves Nolzu's own commits made, or null when nothing else is left.
async function withoutOwnCommits(snap: GitSnapshot, change: GitChange, env: Record<string, string>): Promise<GitChange | null> {
  const refs: GitChange['refs'] = [];
  for (const ref of change.refs) if (!(await ownCommitsOnly(snap, ref.from, ref.to, env))) refs.push(ref);
  const head = change.head !== null && (await ownCommitsOnly(snap, change.head.from, change.head.to, env)) ? null : change.head;
  return head === null && refs.length === 0 && change.files.length === 0 ? null : { head, refs, files: change.files };
}

// A repository named the way the person knows it: the project folder, or its path inside that folder.
// One outside the project keeps its full path, the only name that finds it.
const placeOf = (root: string, project: string | null): string => {
  const base = project === null ? null : real(project);
  if (base === null || !inside(root, base)) return root;
  return root === base ? 'the project folder' : relative(base, root);
};

const short = (sha: string | null): string => (sha === null ? 'nothing' : sha.startsWith('refs/') ? sha : sha.slice(0, 7));

// One line per moved ref, a list of the new files, and the patch of the tracked ones from the
// commit the run started on, capped as the Changes tab caps a patch.
async function changeText(before: GitSnapshot, change: GitChange, env: Record<string, string>, project: string | null): Promise<string> {
  const lines = [`In ${placeOf(before.root, project)}:`];
  if (change.head !== null) lines.push(`HEAD moved from ${short(change.head.from)} to ${short(change.head.to)}.`);
  for (const ref of change.refs) {
    lines.push(ref.from === null ? `${ref.ref} was made at ${short(ref.to)}.` : ref.to === null ? `${ref.ref} was deleted.` : `${ref.ref} moved from ${short(ref.from)} to ${short(ref.to)}.`);
  }
  for (const file of change.files) {
    if (file.to?.startsWith('??') === true || file.to?.startsWith('!!') === true) lines.push(`New file ${file.path}.`);
  }
  if (before.commit !== null) {
    // A commit the run made carries changes no status lists, so its files are named too.
    const committed = (await out(['diff', '--name-only', '-z', before.commit, 'HEAD', ...pathspec(before.exclude)], before.root, env))?.split('\0') ?? [];
    const paths = [...new Set([...change.files.map((file) => file.path), ...committed])].filter((path) => path !== '');
    if (paths.length > 0) {
      const patch = await git(['diff', '--no-color', '--no-ext-diff', before.commit, '--', ...paths], { cwd: before.root, env, maxStdout: PATCH_CAP_BYTES });
      if (patch.code === 0 && patch.stdout !== '') lines.push('', patch.stdout.slice(0, PATCH_CAP_BYTES).trimEnd());
    }
  }
  return lines.join('\n');
}

// Puts back what changed in a checkout Nolzu made for the card. Refs and HEAD first, then the files
// against the state after that, because a run that committed left its change in the files.
// A file that was already changed or untracked before the run has no copy to come back from, so it
// is left and named. Only the card's own branch is put back: every other ref lives in the person's
// repository, where a branch, tag or stash they make while the run goes would read as the run's.
async function restore(before: GitSnapshot, change: GitChange, env: Record<string, string>, place: ExpectedPlaces): Promise<{ undone: string[]; left: string[] }> {
  const undone: string[] = [];
  const left: string[] = [];
  const say = async (args: string[], done: string): Promise<void> => {
    const result = await git(args, { cwd: before.root, env, repo: place });
    if (result.code === 0) undone.push(done);
    else left.push(`${done.replace(/\.$/, '')} failed: ${result.stderr.trim()}`);
  };
  for (const ref of change.refs) {
    if (ref.ref !== before.head) left.push(`Nolzu left ${ref.ref} as it is, because the project's own repository holds it.`);
    else if (ref.from === null) await say(['update-ref', '-d', ref.ref], `Deleted ${ref.ref}, which the run made.`);
    else await say(['update-ref', ref.ref, ref.from], `Moved ${ref.ref} back to ${short(ref.from)}.`);
  }
  if (change.head !== null) {
    if (change.head.from === '') left.push('HEAD moved on a repository with no commit before the run.');
    else if (change.head.from.startsWith('refs/')) await say(['symbolic-ref', 'HEAD', change.head.from], `Put HEAD back on ${change.head.from}.`);
    else await say(['update-ref', '--no-deref', 'HEAD', change.head.from], `Put HEAD back at ${short(change.head.from)}.`);
  }
  const now = change.head !== null || change.refs.length > 0 ? compareGit(before, await snapshot(before.root, before.exclude, before.ignored, env)) : change;
  for (const file of now?.files ?? []) {
    if (file.from !== null) {
      left.push(`${file.path} was already changed before the run, so Nolzu has no copy to put back.`);
      continue;
    }
    // A build or a running app writes ignored files all day, a database journal among them, and a
    // delete here could lose that program's data.
    if (file.to?.startsWith('!!') === true) {
      left.push(`${file.path} is a file git ignores, so Nolzu left it.`);
      continue;
    }
    const tracked = before.commit !== null && (await git(['cat-file', '-e', `${before.commit}:${file.path}`], { cwd: before.root, env })).code === 0;
    if (tracked) {
      await say(['restore', `--source=${before.commit}`, '--staged', '--worktree', '--', file.path], `Put back ${file.path}.`);
    } else {
      // `reset`, not `rm --cached`, which runs git inside a folder whose `.git` is a file. Literal, so a
      // name the run chose that holds a star means that file only.
      await git(['reset', '-q', '--', `:(literal)${file.path.replace(/\/+$/, '')}`], { cwd: before.root, env, repo: place });
      rmSync(join(before.root, file.path), { force: true, recursive: true });
      undone.push(`Removed ${file.path}, which the run made.`);
    }
  }
  return { undone, left };
}

export interface GitAfterOptions {
  // The folder of Nolzu's own checkouts. A repository inside it is put back; any other is the
  // person's own, and nothing in it is touched.
  ownFolder: string | null;
  // The project folder, so the text names each repository by its path inside it.
  project?: string | null;
  env: Record<string, string>;
}

/** The compare after the run: null when nothing changed, else what changed and what was done. */
export async function gitAfter(before: readonly GitSnapshot[], options: GitAfterOptions): Promise<ReadOnlyBreak | null> {
  const own = options.ownFolder === null ? null : real(options.ownFolder);
  const texts: string[] = [];
  const undone: string[] = [];
  const left: string[] = [];
  let restored = true;
  for (const one of before) {
    const raw = compareGit(one, await snapshot(one.root, one.exclude, one.ignored, options.env));
    const change = raw === null ? null : await withoutOwnCommits(one, raw, options.env);
    if (change === null) continue;
    texts.push(await changeText(one, change, options.env, options.project ?? null));
    if (own !== null && inside(one.root, own)) {
      // A card checkout, `<key>` or `<key>/<repo>` in the checkouts folder, which sits in the project.
      const [key = '', repo = '.'] = relative(own, one.root).split(sep);
      const done = await restore(one, change, options.env, cardPlace(dirname(own), key, repo));
      undone.push(...done.undone);
      left.push(...done.left);
    } else {
      restored = false;
    }
  }
  return texts.length === 0 ? null : { restored, diff: texts.join('\n\n'), undone, left };
}
