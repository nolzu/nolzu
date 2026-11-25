import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { allowedCommandProblem, parseAllowedCommands, projectRepos, repoKnowledgePath, resolveKnowledgeDir, validateSetting } from '@nolzu/core';
import { allCardMoves, allRuns, getSetting, peekLocalKey, resolveDataDir } from '@nolzu/core/node';
import { BOARD_KINDS, type BoardChoice, choiceLabel, choicesOf, type DeliveryFlow, isResearchKind, RESEARCH_KINDS, type WallLists } from '@nolzu/protocol';
import { branchName, checkKnowledgeDir, checkoutPath, checkoutRoot, cloneTarget, git, gitCommonDir, gitEnv, parseRemoteUrl, qaCopyRoot, resolvedPath, type RunGit, wallEntryProblem, type WallListName, type WallPlaces, worktreesFolder } from '@nolzu/runner';
import { projectName } from './app-header.ts';
import { browserCommand } from './bin.ts';
import { isClosed } from './checkouts.ts';
import { homePath } from './home-path.ts';
import { inTurn, MANIFEST, readManifest, recordInRoot } from './manifest.ts';
import { checkProject, scannedBase, storeTickets, trackBaseBranch, writeRepoKnowledge } from './onboard.ts';
import { appRows, type AppRow, chromeFound } from './qa-setup.ts';
import { qaHasBrowser, qaServers } from './mcp-store.ts';
import { removeChecks } from './remove-repo.ts';
import { storeSetting } from './settings-page.ts';

/**
 * What Settings, Project reads.
 *
 * The page is the current project's row and the settings a person changes on it. The client, the rate and the currency are saved together by
 * `saveBilling`, from Evidence and from the Client and rate row, so this row does not carry them.
 */

export interface ProjectRow {
  // The project folder's own name, the word the rail's project selector shows. Null with no project set.
  name: string | null;
  path: string | null;
  // The words of the button that shows the folder in the file manager, such as "Open in Finder", or
  // null on a system with none to open, such as one reached over SSH.
  opener: string | null;
  ticketSystem: string;
  // The Jira connection, when one was saved. Optional, so a caller that draws a row without one reads
  // as not connected. The token is never here: it is in the keychain, and the page only says so.
  jira?: { site: string | null; email: string | null };
  // What Jira said when last asked whether a project has the key prefix as its key, kept only while
  // the prefix and the site are still the ones asked. Optional, so a row without it shows no warning.
  keyClash?: { prefix: string; site: string; suggestion: string | null } | null;
  baseBranch: string;
  // Each repository with the base its cards start from, or null for one repository at the project
  // folder, which keeps the one base field above.
  repos: readonly { path: string; base: string }[] | null;
  // The folders .nolzu/repositories.json names that are not on disk, and each entry it could not read.
  // Both stay empty for a project of one repository, which has no list to clone into.
  missing: readonly string[];
  manifestProblems: readonly string[];
  // True when the project folder is a repository Nolzu commits a new clone's .gitignore line and
  // manifest entry to: a workspace, or a root that holds code. A plain folder of repositories is not.
  rootRecords: boolean;
  // A workspace may lose its last repository, so its rows keep their Remove button.
  workspace: boolean;
  branchTemplate: string;
  // The branch a card would get from the template, as the hint beside it shows. Null for a template
  // `branchName` refuses, which only a hand edit can store.
  branchExample: string | null;
  // The boards beside Delivery, each with its switch, with one Research switch for its two kinds.
  // Delivery has none: it is always on.
  boards: readonly { kind: BoardChoice; label: string; on: boolean }[];
  deliveryFlow: DeliveryFlow;
  localKeyPrefix: string;
  // The key the next local card gets, from the code that hands keys out.
  nextKey: string;
  // Start the app: one row per repository, after a row for `*` when there is an answer for every one.
  apps: readonly AppRow[];
  // The servers of the MCP list on for QA, whether QA has Nolzu's browser server, whether Google Chrome
  // is on this machine, which that server starts, and why the QA browser of the old setting is not
  // moved into the list yet, which the page load fills in.
  browser: { servers: string[]; on: boolean; chrome: boolean; problem: string | null };
  // The stored folder, or null for the default one, and the folder knowledge goes to either way.
  knowledgeDir: string | null;
  knowledgeFolder: string | null;
  allowedCommands: readonly string[];
  // Whether the person confirmed the command list, the step of Set up the project. Optional, so a
  // caller that draws a row without it offers no "The list is right".
  commandsConfirmed?: boolean;
  // The Walls box: the project's three lists as typed. The fixed rules are on Settings, Wall.
  // Optional, so a caller that draws a row without it shows no box.
  walls?: { lists: WallLists };
  // How many closed cards still have a checkout on disk, for "Remove the checkouts of closed cards".
  closedCheckouts: number;
  // For a project of one repository, what turning it into a workspace changes: the folder name the
  // repository keeps in the workspace, and the own commands under Start the app, which were written for
  // the old folder. Null for a project that has a list already.
  convert: { folder: string; commands: readonly string[] } | null;
}

// One row of the repositories table. `remote` is where it pushes as host and path, and `clone` is set
// for a folder the manifest names that is not on disk, which gets its own Clone.
export interface RepoRow {
  path: string;
  remote: string | null;
  base: string;
  onDisk: boolean;
  clone: boolean;
  remove: boolean;
}

// The typed confirm of one Remove, in the shape `ConfirmTyped` takes, with the lines the check pass
// found to hold.
export interface RemoveConfirm {
  title: string;
  sub: string;
  lost: (string | { text: string; code: string | string[] })[];
  checked: string[];
  gone: string[];
  kept: { text: string; code: string };
  action: string;
}

// What a Remove of one repository touches, as the page shows it: the folder as a person reads it, where
// its pushed code lives, and whether the project folder commits the records of it.
export interface RemoveFacts {
  project: string | null;
  folder: string;
  remote: { host: string; path: string } | null;
  records: boolean;
}

const HOSTS: Readonly<Record<string, string>> = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab' };

/**
 * What the typed confirm says before a repository goes: what is deleted, what the check pass found,
 * and what stays.
 *
 * `gone` is what the check pass found that keeps the repository (a checkout, a running card, work or
 * commits on no remote), for the red box. Remove stays off while it holds a line. `checked` is the
 * lines that hold, which the confirm ticks.
 */
export function removeConfirm(repo: string, facts: RemoveFacts, gone: readonly string[] = [], checked: readonly string[] = []): RemoveConfirm {
  const remote = facts.remote === null ? '' : ` ${HOSTS[facts.remote.host] ?? facts.remote.host} keeps ${facts.remote.path}, so you can add it again later.`;
  return {
    title: `Remove repository ${repo}`,
    sub: `${facts.project === null ? '' : `From the project ${facts.project}. `}This cannot be undone.`,
    lost: [
      { text: `Deletes the folder ${facts.folder}.`, code: facts.folder },
      ...(facts.records ? [{ text: `Takes ${repo} out of .gitignore and .nolzu/repositories.json, and commits that.`, code: ['.gitignore', '.nolzu/repositories.json'] }] : []),
    ],
    checked: [...checked],
    gone: [...gone],
    kept: { text: `Its knowledge file ${repoKnowledgePath(repo)} stays.${remote}`, code: repoKnowledgePath(repo) },
    action: `Remove ${repo}`,
  };
}

// Where a repository's origin points, parsed, so no credential in its URL reaches the page. Null with no
// origin, and for a folder that is gone or is not a repository.
async function originOf(folder: string): Promise<RemoveFacts['remote']> {
  try {
    // A plain folder sends git up to the repository around it, and the confirm would name that remote.
    // A file check and not `git rev-parse`, since each git call slows a table of 29 rows. An empty
    // .git folder fools it, and git then names the remote of the repository around it.
    if (!existsSync(join(folder, '.git'))) return null;
    const found = await git(['remote', 'get-url', 'origin'], { cwd: folder, env: gitEnv(process.env) });
    const place = found.code === 0 ? parseRemoteUrl(found.stdout.trim()) : null;
    return place === null ? null : { host: place.host, path: `${place.owner}/${place.repo}` };
  } catch {
    return null;
  }
}

// The branches origin has, by name, for the base branch select. A plain folder sends git up to the
// repository around it, so only a folder that is its own top level answers.
export async function remoteBranches(folder: string): Promise<string[]> {
  try {
    const run = (args: readonly string[]) => git(args, { cwd: folder, env: gitEnv(process.env) });
    const top = await run(['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(folder)) return [];
    const found = await run(['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin']);
    return found.code === 0 ? found.stdout.split('\n').filter((name) => name !== '' && name !== 'HEAD') : [];
  } catch {
    return [];
  }
}

// Limit: four git calls at a time. Each start of git holds the server for a moment, and 29 repositories
// at once held the first byte of Settings, Project. A pool with a queue if another page needs it.
async function fewAtATime<T, R>(items: readonly T[], work: (item: T) => Promise<R>, size = 4): Promise<R[]> {
  const done: R[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      done[at] = await work(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return done;
}

/**
 * The branches origin has for each base branch select, by repository path, and by `.` for the one
 * field of a project of one repository. Apart from `projectRow`, so the page streams it and draws
 * before git answers. Empty with no origin or no folder.
 */
export async function projectBranches(db: DatabaseSync): Promise<Record<string, string[]>> {
  const path = getSetting(db, 'projectPath');
  if (path === null) return {};
  if (getSetting(db, 'repos') === null) return { '.': await remoteBranches(path) };
  return Object.fromEntries(await fewAtATime(listedRepos(db), async (repo) => [repo.path, await remoteBranches(join(path, repo.path))] as const));
}

/**
 * The repositories found on this machine that Settings, Project offers to add. Add clones from the
 * remote, so a folder with none is left out, and so are the project itself and a repository the table
 * lists already.
 */
export function foundToAdd(row: { path: string | null; table: readonly { remote: string | null }[] }, found: readonly { path: string; url: string | null }[]): { path: string; url: string }[] {
  const listed = new Set(row.table.map((repo) => repo.remote));
  return found.flatMap((repo) => {
    if (repo.url === null) return [];
    if (row.path !== null && (repo.path === row.path || repo.path.startsWith(`${row.path}/`))) return [];
    const place = parseRemoteUrl(repo.url);
    if (place !== null && listed.has(`${place.host}/${place.owner}/${place.repo}`)) return [];
    return [{ path: repo.path, url: repo.url }];
  });
}

const shownRemote = (remote: RemoveFacts['remote']) => (remote === null ? null : `${remote.host}/${remote.path}`);

/**
 * The repositories table, and the confirm of the one Remove `only` names.
 *
 * A folder on disk is asked for its origin, and a missing one shows the URL the manifest names.
 */
async function repositories(db: DatabaseSync, path: string | null, records: boolean, only?: string): Promise<{ table: RepoRow[]; removes: Record<string, RemoveConfirm> }> {
  // The checks of a Remove cost about ten git calls per repository, which kept a page of 29 repositories
  // blank for seconds. So the load runs none, and the dialog asks for its own as it opens (removeConfirmNow).
  if (path === null || getSetting(db, 'repos') === null) return { table: [], removes: {} };
  const project = projectName(db);
  const listed = listedRepos(db);
  const { missing } = manifestState(db);
  const manifest = readManifest(path).repos;
  const removable = (repo: string) => repo !== '.' && (getSetting(db, 'workspace') === true || listed.length > 1);
  const rows = await fewAtATime(
    listed,
    async (repo) => {
      const folder = join(path, repo.path);
      const remote = existsSync(folder) ? await originOf(folder) : null;
      const named = manifest.find((one) => one.folder === repo.path);
      const place = remote ?? (named === undefined ? null : manifestPlace(named.url));
      const row: RepoRow = { path: repo.path, remote: shownRemote(place), base: repo.base, onDisk: existsSync(folder), clone: missing.includes(repo.path), remove: removable(repo.path) };
      if (!row.remove || only === undefined || repo.path !== only) return { row, confirm: null };
      const found = await removeChecks(db, repo.path);
      return { row, confirm: removeConfirm(repo.path, { project, folder: homePath(folder, homedir()), remote: place, records }, found.failed, found.passed) };
    },
  );
  const unlisted = manifest
    .filter((one) => missing.includes(one.folder) && !listed.some((repo) => repo.path === one.folder))
    .map((one): RepoRow => ({ path: one.folder, remote: shownRemote(manifestPlace(one.url)), base: one.base, onDisk: false, clone: true, remove: false }));
  return {
    table: [...rows.map((one) => one.row), ...unlisted],
    removes: Object.fromEntries(rows.flatMap((one) => (one.confirm === null ? [] : [[one.row.path, one.confirm] as const]))),
  };
}

// Whether the project folder commits the records of its repositories: a workspace, or a list with the root in it.
const commitsRecords = (db: DatabaseSync): boolean => getSetting(db, 'workspace') === true || (getSetting(db, 'repos') ?? []).some((repo) => repo.path === '.');

/**
 * The rows of the repositories table: the listed repositories, then each folder the manifest names
 * that is on no list and not on disk. Empty for a project of one repository. One git call per
 * repository, so Settings, Project streams it and draws the page first.
 */
export async function repoTable(db: DatabaseSync): Promise<RepoRow[]> {
  return (await repositories(db, getSetting(db, 'projectPath'), commitsRecords(db))).table;
}

/**
 * The confirm of one Remove with its checks run, which the dialog asks for as it opens: a
 * commit made after the page loaded counts. Null for a repository the table has no Remove for.
 */
export async function removeConfirmNow(db: DatabaseSync, repo: string): Promise<RemoveConfirm | null> {
  return (await repositories(db, getSetting(db, 'projectPath'), commitsRecords(db), repo)).removes[repo] ?? null;
}

function manifestPlace(url: string): RemoveFacts['remote'] {
  const place = parseRemoteUrl(url);
  return place === null ? null : { host: place.host, path: `${place.owner}/${place.repo}` };
}

/**
 * When something last happened on this machine: a card move or a run.
 *
 * Both columns hold the same ISO shape in UTC, so the later text is the later moment and no date is
 * parsed here. A queued run that never started counts for nothing, the way the cost report drops it,
 * because it happened on no day yet.
 */
function lastActivity(db: DatabaseSync): string | null {
  const times = [
    ...allCardMoves(db).map((move) => move.at),
    ...allRuns(db).flatMap((run) => {
      const at = run.endedAt ?? run.startedAt;
      return at === null ? [] : [at];
    }),
  ];
  return times.length === 0 ? null : times.reduce((newest, at) => (at > newest ? at : newest));
}

// The closed cards whose checkout folder is still on disk.
function closedCheckouts(db: DatabaseSync, path: string | null): number {
  if (path === null) return 0;
  const flow = getSetting(db, 'deliveryFlow');
  const rows = db.prepare('SELECT key, board, stage FROM cards').all() as unknown as { key: string; board: string; stage: string }[];
  return rows.filter((row) => isClosed(row.board, row.stage, flow) && existsSync(checkoutRoot(path, row.key))).length;
}

// The core rule asks a stored template for {key} only, so a hand edit can store one `branchName`
// refuses. The page still opens then, because this is where the template is fixed.
function exampleBranch(template: string, key: string): string | null {
  try {
    // The kind and words a refine of this card would write, so {type} and {desc} read as they will.
    return branchName(template, key, 'Add a search box to the recipe list', { type: 'feature', desc: 'search-box' });
  } catch {
    return null;
  }
}

// The words of the button that shows a folder in this system's file manager, which the launcher's own
// opener opens. Null where there is none, such as Linux with no display.
export function openerWords(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string | null {
  if (browserCommand(platform, env) === null) return null;
  return platform === 'darwin' ? 'Open in Finder' : 'Open the folder';
}

export type Launch = (command: string, args: string[]) => void;
const launch: Launch = (command, args) => spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();

/**
 * Shows the project folder in the file manager, or answers why not. Only the stored folder: the post
 * names no path, so a page cannot have Nolzu open anything else.
 */
export function revealProject(db: DatabaseSync, run: Launch = launch, platform: string = process.platform, env: Record<string, string | undefined> = process.env): string | null {
  const path = getSetting(db, 'projectPath');
  if (path === null) return 'There is no project set, so there is no folder to show.';
  const opener = browserCommand(platform, env);
  if (opener === null) return 'This machine has no file manager Nolzu can open. The path is in the Location box.';
  if (!existsSync(path)) return `The folder ${path} is not there any more.`;
  run(opener.command, [...opener.args, path]);
  return null;
}

/** The single row the page draws. */
export async function projectRow(db: DatabaseSync): Promise<ProjectRow> {
  const path = getSetting(db, 'projectPath');
  const records = commitsRecords(db);
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: path });
  const off = getSetting(db, 'offBoards');
  const prefix = getSetting(db, 'localKeyPrefix');
  const nextKey = peekLocalKey(db, 1, prefix).key;
  const clash = getSetting(db, 'jiraKeyClash');
  return {
    name: projectName(db),
    path: path === null ? null : homePath(path, homedir()),
    opener: openerWords(),
    ticketSystem: getSetting(db, 'ticketSystem'),
    jira: { site: getSetting(db, 'jiraSite'), email: getSetting(db, 'jiraEmail') },
    keyClash: clash !== null && clash.prefix === prefix && clash.site === getSetting(db, 'jiraSite') ? clash : null,
    baseBranch: getSetting(db, 'baseBranch'),
    repos: getSetting(db, 'repos') === null ? null : listedRepos(db),
    ...manifestState(db),
    rootRecords: records,
    workspace: getSetting(db, 'workspace') === true,
    branchTemplate: getSetting(db, 'branchTemplate'),
    branchExample: exampleBranch(getSetting(db, 'branchTemplate'), nextKey),
    boards: choicesOf(BOARD_KINDS.filter((kind) => kind !== 'delivery')).map((kind) => ({ kind, label: choiceLabel(kind), on: choicesOf(BOARD_KINDS.filter((one) => !off.includes(one))).includes(kind) })),
    deliveryFlow: getSetting(db, 'deliveryFlow'),
    localKeyPrefix: prefix,
    nextKey,
    apps: appRows(db),
    browser: {
      servers: qaServers(getSetting(db, 'projectPath')),
      on: qaHasBrowser(db),
      problem: null,
      chrome: chromeFound(process.platform, existsSync),
    },
    knowledgeDir: getSetting(db, 'knowledgeDir'),
    knowledgeFolder: folder === null ? null : homePath(folder, homedir()),
    allowedCommands: getSetting(db, 'allowedCommands') ?? [],
    commandsConfirmed: getSetting(db, 'setupSteps')?.commands === 'done',
    walls: { lists: getSetting(db, 'wallLists') },
    closedCheckouts: closedCheckouts(db, path),
    convert:
      path === null || getSetting(db, 'repos') !== null
        ? null
        : { folder: basename(path), commands: Object.values(getSetting(db, 'qaApp') ?? {}).flatMap((app) => (app.mode === 'own' ? [app.start, app.stop, app.status].filter((one) => one !== null) : [])) },
  };
}

/**
 * What the manifest asks for that the disk has not got, read on each page load, because a teammate's
 * pull can bring new entries at any time.
 */
export function manifestState(db: DatabaseSync): { missing: string[]; manifestProblems: string[] } {
  const path = getSetting(db, 'projectPath');
  if (path === null || getSetting(db, 'repos') === null) return { missing: [], manifestProblems: [] };
  const read = readManifest(path);
  return { missing: read.repos.filter((repo) => !existsSync(join(path, repo.folder))).map((repo) => repo.folder), manifestProblems: read.problems };
}

/**
 * One field of the project form, or the sentence it was refused with.
 *
 * Empty means the default knowledge folder: a person clearing a box is taking the answer back. Every field is checked by the rule its setting has, in
 * the same words.
 */
export async function saveProjectField(db: DatabaseSync, field: string, value: string): Promise<string | null> {
  const typed = value.trim();
  if (field === 'localKeyPrefix') return storeTickets(db, typed);
  if (field === 'branchTemplate') {
    try {
      // branchName is what names a card's branch, so a template it refuses is refused here in its words.
      branchName(typed, 'APP-1', 'Add a search box');
    } catch (error) {
      return (error as Error).message;
    }
    return storeSetting(db, 'branchTemplate', typed);
  }
  if (field === 'baseBranch') {
    // Every repository of the list has its own base, so a value stored here would reach no card.
    if (getSetting(db, 'repos') !== null) return 'This project has a base branch for each repository. Change them in the repository table.';
    if (typed === '') return storeSetting(db, 'baseBranch', typed);
    const project = getSetting(db, 'projectPath');
    if (project === null) return 'There is no project set, so there is no branch to check.';
    return (await trackBaseBranch(project, typed)) ?? storeSetting(db, 'baseBranch', typed);
  }
  if (field.startsWith(REPO_BASE)) return saveRepoBase(db, field.slice(REPO_BASE.length), typed);
  if (field.startsWith(BOARD)) return switchBoard(db, field.slice(BOARD.length), typed);
  if (field === 'knowledgeDir') {
    if (typed === '') return storeSetting(db, 'knowledgeDir', null);
    const run: RunGit = (args) => git(args, { cwd: typed, env: gitEnv(process.env) });
    const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path);
    const check = await checkKnowledgeDir(typed, { projectPath: getSetting(db, 'projectPath'), run, repos });
    return check.ok ? storeSetting(db, 'knowledgeDir', typed) : (check.reason ?? `The knowledge folder ${typed} cannot be used.`);
  }
  if (field === 'allowedCommands') {
    const parsed = parseAllowedCommands(value);
    return parsed.ok ? storeSetting(db, 'allowedCommands', parsed.value) : parsed.message;
  }
  // One chip at a time, against the list as stored now, so a page loaded before another change does
  // not write its old list back.
  const commands = getSetting(db, 'allowedCommands') ?? [];
  if (field === 'addCommand') {
    if (typed === '') return 'Type the command to add, such as npm test.';
    if (commands.includes(typed)) return `${typed} is in the list already.`;
    return allowedCommandProblem(typed) ?? storeSetting(db, 'allowedCommands', [...commands, typed]);
  }
  if (field === 'removeCommand') return storeSetting(db, 'allowedCommands', commands.filter((command) => command !== value));
  if (field.startsWith(ADD_WALL) || field.startsWith(REMOVE_WALL)) return saveWallEntry(db, field, typed);
  return `There is no setting ${field} on this screen.`;
}

/**
 * The commands picked from Propose again, added after the person's own, or the sentence the first
 * refused one gets. It only adds: a command already in the list stays where it is, and none is taken out.
 */
export function addCommands(db: DatabaseSync, picked: readonly string[]): string | null {
  const commands = getSetting(db, 'allowedCommands') ?? [];
  const typed = [...new Set(picked.map((command) => command.trim()))].filter((command) => command !== '' && !commands.includes(command));
  if (picked.length === 0) return 'Tick the commands to add first.';
  for (const command of typed) {
    const problem = allowedCommandProblem(command);
    if (problem !== null) return problem;
  }
  return storeSetting(db, 'allowedCommands', [...commands, ...typed]);
}

// The field names of the Walls lists, followed by the list: `hidden`, `exceptions` or `writable`.
export const ADD_WALL = 'addWall:';
export const REMOVE_WALL = 'removeWall:';
const WALL_LISTS: readonly WallListName[] = ['hidden', 'exceptions', 'writable'];

/**
 * The places a wall entry is checked against on save. The spawn checks again with the run's own
 * card folder and checkout, so an entry saved here and refused there is left out of that run.
 */
export function wallPlaces(db: DatabaseSync, project: string): WallPlaces {
  const knowledge = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: project });
  const dataDir = resolveDataDir(process.env);
  return {
    home: homedir(),
    project,
    gitDir: gitCommonDir(project) ?? join(project, '.git'),
    dataDir,
    needed: [join(project, '.tasks'), worktreesFolder(project), qaCopyRoot(dataDir, project), tmpdir(), ...(knowledge === null ? [] : [knowledge])],
    real: resolvedPath,
  };
}

// One entry added to or removed from one list, against the lists as stored now, so a page loaded
// before another change does not write its old list back.
function saveWallEntry(db: DatabaseSync, field: string, typed: string): string | null {
  const adding = field.startsWith(ADD_WALL);
  const list = field.slice((adding ? ADD_WALL : REMOVE_WALL).length) as WallListName;
  if (!WALL_LISTS.includes(list)) return `There is no wall list ${list}.`;
  const lists = getSetting(db, 'wallLists');
  if (!adding) return storeSetting(db, 'wallLists', { ...lists, [list]: lists[list].filter((entry) => entry !== typed) });
  if (lists[list].includes(typed)) return `${typed} is in the list already.`;
  const project = getSetting(db, 'projectPath');
  if (project === null) return 'There is no project set, so there is no folder to check the path against.';
  return wallEntryProblem(list, typed, wallPlaces(db, project)) ?? storeSetting(db, 'wallLists', { ...lists, [list]: [...lists[list], typed] });
}

// The field name of one row of the repository table, followed by the repository's path.
export const REPO_BASE = 'repoBase:';

// The field name of one board's switch, followed by the board's name.
const BOARD = 'board:';

/**
 * Turns one board on or off, or answers why not.
 *
 * The setting is the one write. The board's cards, runs and files stay as they are, so turning it on
 * again shows the board as it was.
 */
function switchBoard(db: DatabaseSync, name: string, value: string): string | null {
  if (value !== 'on' && value !== 'off') return 'A board is on or off.';
  // Research is one switch for its two kinds, which go on and off together.
  const names: string[] = name === 'research' || isResearchKind(name) ? [...RESEARCH_KINDS] : [name];
  // The name first, so turning Delivery or a made-up board on is refused the same way as turning it off.
  const named = validateSetting('offBoards', names);
  if (!named.ok) return named.message;
  const off = getSetting(db, 'offBoards').filter((kind) => !names.includes(kind));
  return storeSetting(db, 'offBoards', value === 'on' ? off : [...off, ...named.value]);
}

// The list with every base filled in. A base left unset follows `baseBranch`, which a write here
// moves, so it is pinned to the branch it means now.
export const listedRepos = (db: DatabaseSync) => projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });

const repoName = (path: string) => (path === '.' ? 'the project folder' : path);

// Screens that still read one base branch read the first repository's, as onboarding left it.
function storeRepos(db: DatabaseSync, repos: { path: string; base: string }[]): string | null {
  return storeSetting(db, 'repos', repos) ?? storeSetting(db, 'baseBranch', repos[0]?.base ?? getSetting(db, 'baseBranch'));
}

// One row of the table, checked against that repository the way the single field is checked.
async function saveRepoBase(db: DatabaseSync, path: string, typed: string): Promise<string | null> {
  const project = getSetting(db, 'projectPath');
  if (getSetting(db, 'repos') === null || project === null) return 'This project has one repository. Its base branch is the Base branch field.';
  const repos = listedRepos(db);
  if (!repos.some((repo) => repo.path === path)) return `There is no repository ${path} in this project.`;
  if (typed === '') return 'The base branch cannot be empty.';
  const problem = await trackBaseBranch(join(project, path), typed, process.env, path);
  // Read again after the check, so a remove made while git ran is not undone.
  const refused = problem ?? storeRepos(db, listedRepos(db).map((repo) => (repo.path === path ? { path, base: typed } : repo)));
  if (refused !== null) return refused;
  // A teammate who opens the workspace clones from the manifest, so its entry takes the new base too.
  const entry = readManifest(project).repos.find((one) => one.folder === path);
  if (entry === undefined || entry.base === typed) return null;
  const recorded = await inTurn(project, () => recordInRoot(project, [{ ...entry, base: typed }], getSetting(db, 'workspace') === true, process.env, `chore: start ${path} from ${typed}`));
  return recorded.problem;
}

// The cards with a checkout of `path` on disk. The project folder's checkout is the card's root, so
// any folder there counts. A child's counts once it has `.git`: an empty submodule folder in the
// root checkout is no checkout.
export function cardsWithCheckout(db: DatabaseSync, project: string, path: string): string[] {
  const keys = (db.prepare('SELECT key FROM cards').all() as { key: string }[]).map((row) => row.key);
  return keys.filter((key) => existsSync(path === '.' ? checkoutPath(project, key) : join(checkoutPath(project, key, path), '.git')));
}

/**
 * Why one repository must stay on the project's list, or null when it may go.
 *
 * The project folder stays when it is a repository, because every card's checkout starts there. The
 * last repository stays, because a project needs one, except in a workspace, which may be empty. A
 * repository a card has a checkout of stays too, because a card drops a repository the project no
 * longer lists, and its work there with it.
 */
export function removeRefusal(db: DatabaseSync, path: string): string | null {
  const listed = listRefusal(db, path);
  if (listed !== null) return listed;
  const project = getSetting(db, 'projectPath');
  const held = project === null ? undefined : cardsWithCheckout(db, project, path)[0];
  if (held !== undefined) return `${held} has a checkout of ${path}, so ${path} stays. The card's work there would be left out of its changes.`;
  return null;
}

// Why the list itself keeps one repository, before any card or folder is looked at. The check pass of
// Remove asks this first and then finds the checkouts on its own, with every card that holds one.
export function listRefusal(db: DatabaseSync, path: string): string | null {
  if (getSetting(db, 'repos') === null) return 'This project has one repository, so there is none to remove.';
  const repos = listedRepos(db);
  if (!repos.some((repo) => repo.path === path)) return `There is no repository ${path} in this project.`;
  if (path === '.') return 'The project folder is a repository, so it stays in the list. Every card starts in its checkout.';
  if (repos.length === 1 && getSetting(db, 'workspace') !== true) return `The repository ${path} is the last one of the project, so it stays.`;
  return null;
}

/** Takes one repository off the project's list, or answers why it stays. The disk is not touched. */
export function removeProjectRepo(db: DatabaseSync, path: string): string | null {
  return removeRefusal(db, path) ?? storeRepos(db, listedRepos(db).filter((repo) => repo.path !== path));
}

/**
 * Scans the project folder again and adds each repository the list does not have yet.
 *
 * A repository is only ever added here, never typed, so it is a folder the scan found with a branch
 * to start from. A repository that is gone from the folder stays until it is removed by hand. Each
 * one added gets its first knowledge file, the way onboarding writes them. A project of one
 * repository has no list to add to: its cards have no list either, so a new one would stop them.
 */
export async function rescanRepos(db: DatabaseSync, env: Record<string, string | undefined> = process.env): Promise<{ said: string } | { problem: string }> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return { problem: 'There is no project set, so there is no folder to scan.' };
  if (getSetting(db, 'repos') === null) return { problem: 'This project has one repository, so there is no list to add to.' };
  // Scan again commits the manifest too, so it waits behind a clone that runs, and then scans the
  // folder as that clone left it.
  return inTurn(project, () => rescan(db, project, env));
}

async function rescan(db: DatabaseSync, project: string, env: Record<string, string | undefined>): Promise<{ said: string } | { problem: string }> {
  const { scan } = await checkProject({ path: project, template: getSetting(db, 'branchTemplate'), env });
  if (!scan.ok) return { problem: scan.reason };
  const listed = listedRepos(db);
  // Lower case, as the list's own check reads names, because the default macOS disk does.
  const known = new Set(listed.map((repo) => repo.path.toLowerCase()));
  const added: { path: string; base: string }[] = [];
  // A workspace folder is a repository too, and never one a card changes.
  const workspace = getSetting(db, 'workspace') === true;
  for (const repo of scan.repos.filter((one) => !known.has(one.path.toLowerCase()) && !(workspace && one.path === '.'))) {
    const found = await scannedBase(project, repo, env, 'scan again');
    if ('reason' in found) return { problem: found.reason };
    // A card's other checkouts already fill the root folder that the project folder's checkout needs.
    const held = repo.path === '.' ? cardsWithCheckout(db, project, '.')[0] : undefined;
    if (held !== undefined) return { problem: `The project folder is a repository now, and its checkout would be each card's root. ${held} has a checkout already, so nothing was added.` };
    added.push({ path: repo.path, base: found.base });
  }
  if (added.length === 0) return { said: 'Every repository the scan found is in the list already.' };

  const refused = addToList(db, added);
  if (refused !== null) return { problem: refused };
  // A clone a person made by hand in a workspace gets what an added one gets: its line in the
  // workspace's .gitignore, and its entry in the manifest when its origin is a URL Nolzu can clone.
  const notes: string[] = [];
  if (workspace) {
    const clones = await Promise.all(added.map(async (repo) => ({ folder: repo.path, url: await cloneableOrigin(join(project, repo.path), repo.path, env), base: repo.base })));
    const unlisted = clones.filter((clone) => clone.url === null).map((clone) => clone.folder);
    if (unlisted.length > 0) notes.push(`${MANIFEST} does not list ${unlisted.join(', ')}, because there is no origin URL Nolzu can clone from.`);
    const recorded = await recordInRoot(project, clones, true, env);
    if (recorded.problem !== null) notes.push(recorded.problem);
    // A manifest Nolzu cannot read keeps no entry, but the clones still need their .gitignore lines,
    // or the workspace repository would take them in.
    if (!recorded.recorded && recorded.problem !== null) {
      const ignored = await recordInRoot(project, clones.map((clone) => ({ ...clone, url: null })), true, env);
      if (ignored.problem !== null && ignored.problem !== recorded.problem) notes.push(ignored.problem);
    }
  }
  const knowledge = await writeRepoKnowledge(db, added, env);
  const files = knowledge.written.length === 0 ? '' : ` Wrote ${knowledge.written.join(', ')} in the knowledge folder.`;
  if (knowledge.problem !== null) notes.push(knowledge.problem);
  return { said: [`Added ${added.map((repo) => repoName(repo.path)).join(', ')}.${files}`, ...notes].join(' ') };
}

/**
 * Puts repositories on the project's list, after the ones there, or answers why the list refused.
 *
 * Read again here, after git ran, so a change made meanwhile is kept. The project folder comes
 * first, because the other checkouts are made inside its own.
 */
export function addToList(db: DatabaseSync, added: readonly { path: string; base: string }[]): string | null {
  const now = listedRepos(db);
  const fresh = added.filter((repo) => !now.some((one) => one.path.toLowerCase() === repo.path.toLowerCase()));
  return storeRepos(db, [...now, ...fresh].sort((a, b) => Number(b.path === '.') - Number(a.path === '.')));
}

// The origin of a clone when it is a URL the manifest may hold and it clones into this folder. A URL
// with a token in it is refused here, so it never reaches a tracked file.
export async function cloneableOrigin(at: string, folder: string, env: Record<string, string | undefined>): Promise<string | null> {
  const found = await git(['remote', 'get-url', 'origin'], { cwd: at, env: gitEnv(env as Record<string, string>) });
  const url = found.code === 0 ? found.stdout.trim() : '';
  const target = cloneTarget(url);
  return target.ok && target.name === folder ? url : null;
}

/**
 * What `/api/projects` answers, the shape the paid projects panel reads.
 *
 * This machine's own project, marked current, and after it every other project of the account once
 * the personal hub has listed them on a `project.list` job. A free machine has no hub socket, so it
 * gets this machine's project alone. Its own row comes from its own database and is found in the list
 * by the id it minted, because the name and the last activity here are newer than the hub's copy.
 * Every other row is only "not current": the client cannot tell which machine holds it, or whether
 * any machine still does.
 */
export function projectList(db: DatabaseSync): { projects: { name: string; lastActivity: string | null; current: boolean }[] } {
  const name = projectName(db);
  if (name === null) return { projects: [] };
  const here = getSetting(db, 'projectId');
  const others = (getSetting(db, 'accountProjects') ?? []).filter((one) => one.id !== here);
  return {
    projects: [
      { name, lastActivity: lastActivity(db), current: true },
      ...others.map((one) => ({ name: one.name, lastActivity: one.lastActivity, current: false })),
    ],
  };
}
