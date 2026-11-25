import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRepos, resolveKnowledgeDir } from '@nolzu/core';
import { allKnowledgeChanges, getSetting } from '@nolzu/core/node';
import { git, gitEnv, type HeldKnowledge, type KnowledgeEntry, repoFolder } from '@nolzu/runner';
import { type BoardSnapshot, frontmatterPaths } from '@nolzu/protocol';
import { changeIsOf, fileBody, frontmatterDescription, type KnowledgeChangeInput, type KnowledgeInput, knowledgeView, type KnowledgeView } from '@nolzu/ui/knowledge';
import { homePath } from './home-path.ts';

/**
 * What the Knowledge screen reads, from the folder, the database and git.
 *
 * The rules are in `@nolzu/ui/knowledge`; this file only gathers. The diff of a change comes from
 * git every time it is shown, never from a copy in the database: the row holds the sha, and the
 * repository the person can open holds the patch, so the two can never disagree.
 */

// The card the knowledge lane is holding, which is the card writing the folder right now. The board
// snapshot is the one source of busy state, so the screen never guesses from a click or a run row.
export const knowledgeLane = (snapshot: Pick<BoardSnapshot, 'lanes'>): string | null =>
  snapshot.lanes.find((lane) => lane.name === 'knowledge')?.heldBy ?? null;

// The folder as a list of files, relative to it, with forward slashes whatever this machine uses.
// `.git` is left out: it is the repository's own bookkeeping and not knowledge.
export function knowledgeFiles(folder: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { recursive: true, withFileTypes: true });
  } catch {
    // A knowledge run may be writing the folder while this page loads, which is what the busy dot
    // says. A folder that went mid-walk lists nothing, rather than turning the screen into a 500.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.startsWith('.git/'))
    // By codepoint, so every machine shows the same order. `localeCompare` reads two different
    // names as equal when only punctuation tells them apart.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The same race as the listing above: the file can go between the two, and then nothing is open.
export const readOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The folder's notes for the knowledge index in a run's prompt: each one's description, else its
 * first line, and when it last changed.
 *
 * Only markdown, because a first line of anything else says nothing a run can pick by.
 */
// Limit: reads every note in full for one line each. A knowledge folder is small; read a head only
// if one ever grows to thousands of files.
export function knowledgeIndexFiles(folder: string): KnowledgeEntry[] {
  return knowledgeFiles(folder)
    .filter((path) => path.endsWith('.md'))
    .flatMap((path) => {
      try {
        const text = readFileSync(join(folder, path), 'utf8');
        const first = fileBody(text).split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find((line) => line !== '');
        return [{ path, about: frontmatterDescription(text) ?? first ?? 'No description.', changed: statSync(join(folder, path)).mtimeMs }];
      } catch {
        // The same race as the listing: a knowledge run may remove the file between the two.
        return [];
      }
    });
}

const run = (folder: string, args: readonly string[], env: Record<string, string | undefined>, signal?: AbortSignal, maxStdout?: number) =>
  git(args, { cwd: folder, env: gitEnv(env), signal, maxStdout });

// Limit: a knowledge file is a note, so no real commit of one comes near this. The cap is here
// because past node's string limit the join inside git's stdout handler throws where no promise can
// catch it, which is the reason `filePatch` in @nolzu/runner gives for its own cap.
const PATCH_CAP_BYTES = 256 * 1024;

/**
 * Where the folder sits in its repository, with a trailing slash.
 *
 * A change row names a file from the repository root, and the file list names it from the folder,
 * so this is what joins the two. Empty when git answers nothing, which is a folder in no
 * repository: there is then no history to show either.
 */
export async function repoPrefix(folder: string, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<string> {
  const said = await run(folder, ['rev-parse', '--show-prefix'], env, signal);
  return said.code === 0 ? said.stdout.trim() : '';
}

// Limit: the newest 500 commits that touched the folder. A file last changed before them shows no
// day; raise the count if a folder ever outgrows it.
const LOG_LIMIT = '500';

/**
 * When each commit in the folder's history was made, and when each file in it last changed.
 *
 * One git call for the whole folder, newest first, so the first day seen for a file is its last
 * change. A commit git does not have is absent, because a row whose commit is gone is still a row
 * the screen has to draw. A folder in no repository answers two empty maps.
 */
export async function folderDates(
  folder: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ commits: Map<string, string>; files: Map<string, string> }> {
  const commits = new Map<string, string>();
  const files = new Map<string, string>();
  const said = await run(folder, ['log', '-n', LOG_LIMIT, '--format=%x00%H %cI', '--name-only', '--relative', '--', '.'], env, signal);
  if (said.code !== 0) return { commits, files };
  for (const entry of said.stdout.split('\0').slice(1)) {
    const [head = '', ...names] = entry.split('\n');
    const [sha = '', at = ''] = head.split(' ');
    commits.set(sha, at);
    for (const name of names) if (name !== '' && !files.has(name)) files.set(name, at);
  }
  return { commits, files };
}

/**
 * The day one commit was made and what it did to one file.
 *
 * One git call for both: the format line comes first and the patch follows it. A sha git does not
 * have, or a commit that never touched this path, answers with nulls rather than throwing, because
 * a row whose commit is gone is still a row the screen has to draw.
 */
export async function commitPatch(
  folder: string,
  sha: string,
  path: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  cap = PATCH_CAP_BYTES,
): Promise<{ committedAt: string | null; diff: string | null; diffTooLarge: boolean }> {
  // `literal` because a knowledge file named with a bracket is a name and not a pattern, and `top`
  // because the path is from the repository root while git runs in the folder. One character past
  // the cap is enough to know the patch is over it, and reading stops there.
  const args = ['show', '--no-color', '--format=%cI', '--patch', sha, '--', `:(top,literal)${path}`];
  const said = await run(folder, args, env, signal, cap + 1);
  // A capped read kills git, so the exit code has to be read after the size, or an oversized patch
  // would report as a commit git does not have.
  const tooLarge = Buffer.byteLength(said.stdout) > cap;
  if (!tooLarge && said.code !== 0) return { committedAt: null, diff: null, diffTooLarge: false };

  const start = said.stdout.search(/^diff --git /m);
  const head = (start === -1 ? said.stdout : said.stdout.slice(0, start)).trim();
  return {
    committedAt: head === '' ? null : (head.split('\n')[0] ?? null),
    diff: tooLarge || start === -1 ? null : said.stdout.slice(start),
    diffTooLarge: tooLarge,
  };
}

/**
 * Whether each path the notes name is on its repository's base branch, for the path check on the
 * Knowledge screen. A path is named from the project folder, so a workspace's repository folder
 * comes first in it.
 *
 * One `git ls-tree` per repository, asking for the named paths only: `-t` lists each folder on the
 * way, so a folder and a file in it both answer. A path in no listed repository, or in one git cannot
 * read, is left out, which the screen shows as not checked. A path that leaves the project cannot be
 * on any base branch.
 */
export async function pathsOnBase(
  project: string,
  repos: readonly { path: string; base: string }[],
  paths: readonly string[],
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {};
  // The deepest repository folder that holds the path, and the project folder last.
  const depth = (repo: { path: string }) => (repo.path === '.' ? 0 : repo.path.length);
  const owner = (path: string) => repos.filter((repo) => repo.path === '.' || path === repo.path || path.startsWith(`${repo.path}/`)).sort((a, b) => depth(b) - depth(a))[0];
  const asked = new Map<{ path: string; base: string }, { named: string; inside: string }[]>();
  for (const named of new Set(paths)) {
    if (named.startsWith('/') || named.startsWith('~') || named.split('/').includes('..')) {
      found[named] = false;
      continue;
    }
    const repo = owner(named);
    if (repo === undefined) continue;
    const inside = repo.path === '.' ? named : named.slice(repo.path.length + 1);
    asked.set(repo, [...(asked.get(repo) ?? []), { named, inside }]);
  }
  for (const [repo, mine] of asked) {
    const wanted = mine.filter((one) => one.inside !== '').map((one) => one.inside);
    // A repository that is not cloned yet has no folder, and git then throws rather than answers.
    const said = await run(repoFolder(project, repo.path), ['ls-tree', '-t', '-z', '--name-only', '--end-of-options', repo.base, '--', ...wanted], env, signal).catch(() => null);
    if (said === null || said.code !== 0) continue;
    const names = new Set(said.stdout.split('\0'));
    for (const one of mine) found[one.named] = one.inside === '' || names.has(one.inside);
  }
  return found;
}

/**
 * The folder as the screen names it: from the project when it sits inside it (`.nolzu/knowledge`), or
 * with the home folder as `~`. The long path of a scratch folder wraps over six lines in the foot.
 */
export function shortFolder(folder: string, projectPath: string | null, home: string): string {
  const inside = projectPath === null ? null : relative(projectPath, folder).split(sep).join('/');
  if (inside !== null && inside !== '' && !inside.startsWith('..') && !inside.startsWith('/')) return inside;
  return homePath(folder, home);
}

export interface KnowledgePageOptions {
  // The file the query asks for. A name that is not in the folder opens nothing, which also keeps
  // the reader inside the folder.
  file?: string | null;
  // The card the knowledge lane is holding, from the board snapshot.
  busy?: string | null;
  // The kept copy of a run whose change waits for review, out of the data folder.
  held?: (runId: number) => HeldKnowledge | null;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export async function knowledgePage(db: DatabaseSync, options: KnowledgePageOptions = {}): Promise<KnowledgeView> {
  const env = options.env ?? process.env;
  const busy = options.busy ?? null;
  const projectPath = getSetting(db, 'projectPath');
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath });
  const gather = (over: Partial<KnowledgeInput>): KnowledgeInput => ({
    folder,
    ...(folder === null ? {} : { shown: shortFolder(folder, projectPath, env.HOME ?? homedir()) }),
    exists: false,
    prefix: '',
    files: [],
    open: null,
    changes: [],
    cards: [],
    busy,
    repos: projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path),
    ...over,
  });

  if (folder === null || !existsSync(folder) || !statSync(folder).isDirectory()) return knowledgeView(gather({}));

  const files = knowledgeFiles(folder);
  const asked = options.file ?? null;
  const path = asked !== null && files.includes(asked) ? asked : null;
  // Limit: the whole file is read and rendered. Knowledge files are notes a run wrote, so they
  // are small. Cap the read if a person ever points the folder at something huge.
  const text = path === null ? null : readOrNull(join(folder, ...path.split('/')));
  const open = path === null || text === null ? null : { path, text };
  const prefix = await repoPrefix(folder, env, options.signal);
  const rows = allKnowledgeChanges(db);
  // The phase of each run that wrote knowledge, because Optimize and Learn this project share the reserved key.
  const phases = new Map(
    (db.prepare('SELECT id, phase FROM runs WHERE id IN (SELECT run_id FROM knowledge_changes)').all() as unknown as { id: number; phase: string }[]).map((run) => [run.id, run.phase]),
  );
  const cards = db.prepare('SELECT key, title FROM cards ORDER BY key').all() as unknown as { key: string; title: string }[];

  const dates = await folderDates(folder, env, options.signal);
  // Read once per run, because one run's kept copy holds all the files it changed.
  const kept = new Map<number, HeldKnowledge | null>();
  const heldOf = (row: (typeof rows)[number]): KnowledgeChangeInput['held'] => {
    if (row.status !== 'pending' || options.held === undefined || !row.filePath.startsWith(prefix)) return null;
    if (!kept.has(row.runId)) kept.set(row.runId, options.held(row.runId));
    const file = kept.get(row.runId)?.files.find((one) => one.path === row.filePath);
    if (file === undefined) return null;
    return { before: readOrNull(join(folder, ...row.filePath.slice(prefix.length).split('/'))), after: file.content };
  };

  const changes: KnowledgeChangeInput[] = [];
  for (const row of rows) {
    const mine = open !== null && changeIsOf(row.filePath, prefix, open.path);
    // Limit: one git call per change of the open file, which is one call per run that taught it.
    // Read the file's whole history in one `git log -p` if a file ever collects enough runs to feel it.
    // A moved change's commit is in another repository, so this one is not asked for it.
    const said = mine && row.commitSha !== null && row.movedFrom === null ? await commitPatch(folder, row.commitSha, row.filePath, env, options.signal) : null;
    changes.push({
      id: row.id,
      runId: row.runId,
      cardKey: row.cardKey,
      ...(phases.has(row.runId) ? { phase: phases.get(row.runId) } : {}),
      filePath: row.filePath,
      commitSha: row.commitSha,
      summary: row.summary,
      status: row.status,
      note: row.note,
      // A moved change's commit is in another repository, so this folder's dates are not its own.
      committedAt: said?.committedAt ?? (row.commitSha === null || row.movedFrom !== null ? null : (dates.commits.get(row.commitSha) ?? null)),
      diff: said?.diff ?? null,
      diffTooLarge: said?.diffTooLarge ?? false,
      movedFrom: row.movedFrom,
      held: heldOf(row),
    });
  }

  const fileDates = Object.fromEntries(dates.files);
  // Limit: every file is read on each load for the search box. They are short notes; search on
  // the server if a folder ever grows large.
  const fileTexts = Object.fromEntries(files.map((one) => [one, readOrNull(join(folder, ...one.split('/'))) ?? '']));
  const named = Object.values(fileTexts).flatMap(frontmatterPaths);
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  const onBase = projectPath === null || named.length === 0 ? {} : await pathsOnBase(projectPath, repos, named, env, options.signal);
  return knowledgeView(gather({ exists: true, prefix, files, open, changes, cards, fileDates, fileTexts, pathsOnBase: onBase }));
}
