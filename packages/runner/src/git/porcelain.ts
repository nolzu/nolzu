import type { DiffStatus } from '@nolzu/protocol';
export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  dirty: boolean;
}

export interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  // The reason git gave, when git itself reports the worktree as prunable. There is no
  // separate bookkeeping to keep in sync, because git already knows.
  prunable: string | null;
  // Set when a person locked the worktree. git's own remove refuses one, and so does Nolzu.
  locked: string | null;
}

export interface GitDiffEntry {
  path: string;
  // Set only for a rename, so the tab shows both paths and the stat bar still counts one file.
  oldPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
}

// `status --porcelain=v2 --branch`. The ahead and behind counts come from a `# branch.ab`
// line that git prints only when the branch has an upstream, so a branch without one reports
// zero here and the caller counts against the base branch with rev-list instead.
export function parseStatus(text: string): GitStatus {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changed = 0;
  let untracked = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /\+(\d+)\s+-(\d+)/.exec(line);
      if (counts) {
        ahead = Number(counts[1]);
        behind = Number(counts[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      // 1 is a plain change, 2 is a rename or copy, u is an unmerged path.
      changed += 1;
    } else if (line.startsWith('? ')) {
      untracked += 1;
    }
  }

  return { branch, upstream, ahead, behind, changed, untracked, dirty: changed > 0 || untracked > 0 };
}

// `worktree list --porcelain`. Blocks are separated by a blank line, and a block without a
// `branch` line is a detached worktree.
export function parseWorktrees(text: string): GitWorktree[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').filter((line) => line.trim() !== ''))
    .map((lines) => {
      let path = '';
      let head = '';
      let branch: string | null = null;
      let prunable: string | null = null;
      let locked: string | null = null;
      for (const line of lines) {
        if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
        else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
        else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        else if (line.startsWith('prunable ')) prunable = line.slice('prunable '.length);
        else if (line === 'locked') locked = '';
        else if (line.startsWith('locked ')) locked = line.slice('locked '.length);
      }
      return { path, head, branch, prunable, locked };
    })
    .filter((entry) => entry.path !== '');
}

const ESCAPED: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

// git wraps a path in double quotes and escapes it when the name holds a quote, a backslash or a
// control character. `core.quotepath=false` only stops the escaping of bytes above 0x80, so the
// quoted form still arrives and has to be undone, or the tab shows a name nobody has on disk and
// the patch for that file comes back empty.
export function unquotePath(field: string): string {
  if (field.length < 2 || !field.startsWith('"') || !field.endsWith('"')) return field;
  // The split keeps the plain runs at the even places and whatever followed a backslash at the odd
  // ones, so a character built from two code units is never cut in half.
  const parts = field.slice(1, -1).split(/\\([0-7]{3}|[^])/);
  return Buffer.concat(
    parts.map((part, at) =>
      at % 2 === 0
        ? Buffer.from(part, 'utf8')
        : Buffer.from([/^[0-7]{3}$/.test(part) ? Number.parseInt(part, 8) : ESCAPED[part] ?? part.charCodeAt(0)]),
    ),
  ).toString('utf8');
}

// A rename arrives inside the path, not as a second column. git writes the shared part once
// and the changed part in braces, and falls back to a plain arrow when nothing is shared.
export function splitRename(spec: string): [string, string | null] {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(spec);
  if (brace) {
    const [, prefix = '', from = '', to = '', suffix = ''] = brace;
    return [`${prefix}${from}${suffix}`, `${prefix}${to}${suffix}`];
  }
  // The spaces matter. A file called `a=>b.ts` is a name, not a rename.
  if (spec.includes(' => ')) {
    const [from, to] = spec.split(' => ');
    if (from !== undefined && to !== undefined) return [from, to];
  }
  return [spec, null];
}

// `diff --numstat`. Columns are tab separated, and a binary file carries a dash for both
// counts, which is why the counts are read as zero rather than as NaN.
export function parseNumstat(text: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [addedRaw = '', removedRaw = '', ...rest] = parts;
    // A path can hold a tab, so everything after the two counts is the path.
    const [first, second] = splitRename(rest.join('\t'));
    const binary = addedRaw === '-' && removedRaw === '-';

    entries.push({
      path: unquotePath(second ?? first),
      oldPath: second === null ? null : unquotePath(first),
      added: binary ? 0 : Number(addedRaw),
      removed: binary ? 0 : Number(removedRaw),
      binary,
    });
  }

  return entries;
}

export interface NameStatusEntry {
  path: string;
  // The path the file had before a rename or a copy, and null for everything else.
  oldPath: string | null;
  status: DiffStatus;
}

// `diff --name-status`. The letter says what happened, and a rename or a copy carries two paths in
// two more columns rather than the brace form numstat prints. A copy reads as added, because the
// file was not there before, and its source stays on the entry.
export function parseNameStatus(text: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const [letters = '', first = '', second] = line.split('\t');
    if (first === '') continue;

    const kind = letters.charAt(0);
    const moved = kind === 'R' || kind === 'C';
    // A letter nobody planned for is still a change the person made, so it is shown and not dropped.
    const status: DiffStatus = kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : kind === 'R' ? 'renamed' : kind === 'C' ? 'added' : 'changed';

    entries.push({
      path: unquotePath(moved && second !== undefined ? second : first),
      oldPath: moved && second !== undefined ? unquotePath(first) : null,
      status,
    });
  }

  return entries;
}

// Where a clone stands: the step git is on, and the share of objects received, which is the part of a
// clone that takes the time. It stays at 100 while git resolves deltas and checks the files out.
export interface CloneProgress {
  step: string;
  percent: number;
}

// "Receiving objects:  44% (4/9)", or a step of the remote's own with "remote: " before it. The clone
// runs with LC_ALL=C, so the words are git's English ones on every machine.
const PROGRESS_LINE = /^(?:remote: )?([^:]+):\s+(\d{1,3})% \(\d+\/\d+\)/;

// The progress in what `git clone --progress` wrote to stderr so far. The last piece is read only once
// a carriage return or a newline ends it, because a chunk can stop in the middle of a number.
export function cloneProgress(stderr: string): CloneProgress | null {
  const lines = stderr.split(/[\r\n]/).slice(0, -1);
  let step: string | null = null;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = PROGRESS_LINE.exec(lines[at] ?? '');
    if (line === null) continue;
    step ??= line[1] ?? '';
    if (line[1] === 'Receiving objects') return { step, percent: Number(line[2]) };
  }
  return step === null ? null : { step, percent: 0 };
}

// Dependency and build folders that tools make again, so losing them loses nothing a person wrote.
// Matched as a folder at any depth, with `*.egg-info` too. Never a name that can hold a person's own
// files in some stack: not vendor (PHP and Go code), bin (scripts), obj (3D models), deps, log, tmp,
// editor settings such as .vscode and .idea, or .wrangler, which holds the local database, KV and
// bucket data of `wrangler dev`.
const REMADE = new Set([
  'node_modules', '.svelte-kit', 'dist', 'build', '.venv', 'venv', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', 'coverage', '.nyc_output', '.gradle',
  '.astro', '.angular', '.react-router', '.output', '.expo', '.nx', '.vercel', 'test-results', 'playwright-report', 'htmlcov',
  '_build', '.dart_tool', 'Pods', 'DerivedData',
]);
// Cache and log files tools write again, matched by name.
const REMADE_FILE = /^(\.eslintcache|\.stylelintcache|.+\.tsbuildinfo|\.coverage|next-env\.d\.ts|\.phpunit\.result\.cache|.+\.log)$/;
const remadeFolder = (name: string): boolean => REMADE.has(name) || (name.endsWith('.egg-info') && name !== '.egg-info');

// Up to eight paths for a sentence, and how many more, so a refusal shows what is in the way without
// a wall of names.
export function somePaths(paths: readonly string[], most = 8): string {
  const more = paths.length - most;
  return more > 0 ? `${paths.slice(0, most).join(', ')}, and ${more} more` : paths.join(', ');
}

/**
 * The ignored paths of `git status --porcelain -z --ignored=matching` worth naming, and the first
 * folder left out because tools make it again. A Finder .DS_Store is left out too, and so is
 * `others`: the project's other repositories, whose checkouts sit ignored inside a workspace card's root.
 */
export function ignoredPaths(porcelain: string, others: readonly string[] = []): { named: string[]; remade: string | null } {
  const ignored = porcelain
    .split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3))
    .filter((path) => path.replace(/\/$/, '').split('/').at(-1) !== '.DS_Store' && !others.some((other) => path === other || path.startsWith(`${other}/`)));
  const remade = (path: string) =>
    REMADE_FILE.test(path.split('/').at(-1) ?? '') || path.split('/').some((part, at, all) => remadeFolder(part) && (at < all.length - 1 || path.endsWith('/')));
  return { named: ignored.filter((path) => !remade(path)), remade: ignored.find(remade) ?? null };
}
