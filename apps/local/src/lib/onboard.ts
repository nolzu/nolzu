import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectScan, ScannedRepo } from '@nolzu/protocol';
import { DEEP_FILES, isFolderName, proposeAllowedCommands, needsOnboarding, planKnowledgeMoves, prefixProblem, type ProjectRepo, projectRepos, type RecipeFacts, repoKnowledge, repoKnowledgePath, resolveKnowledgeDir, RUN_RECIPE_FILE, runRecipe, validateSetting } from '@nolzu/core';
import { getSetting, pendingKnowledgeChanges, writeSetting } from '@nolzu/core/node';
import {
  applyPlan,
  checkKnowledgeDir,
  commitKnowledgeFiles,
  detectEngines,
  type EngineStatus,
  git,
  gitEnv,
  GUARD_PATH,
  OLD_WORKSPACE,
  keepForShipped,
  keptMark,
  knowledgeState,
  loginShellPath,
  phaseInstructionsPath,
  planProjectFiles,
  type ProjectPlan,
  type RunCommand,
  type RunGit,
  runVersion,
  scanProject,
  SETTINGS_PATH,
  shippedMark,
  SKILL_FOLDERS,
  SYNC_RECORD,
  syncSkillFolders,
  EXTRA_SKILLS,
  type SyncResult,
  takeShippedSkill,
  writablePath,
} from '@nolzu/runner';
import { AGENTS_MD, pointerFile, skillsFolder } from '@nolzu/skills';
import { knowledgeFiles } from './knowledge-page.ts';
import { manifestSaysWorkspace } from './manifest.ts';
import { unsavedLine } from './project-files-notice.ts';
// The same file the nolzu command reads its version from, in a clone and in an install.
import appPackage from '../../package.json' with { type: 'json' };

// This Nolzu's version, which the skills record keeps, so an older Nolzu knows to leave newer files alone.
export const NOLZU_VERSION: string = appPackage.version;

// Where a page load goes instead, or null to stay. Only a machine with no project yet goes to New project.
export function onboardRedirect(db: DatabaseSync, pathname: string): string | null {
  if (pathname === '/new' || pathname.startsWith('/new/')) return null;
  return needsOnboarding({ projectPath: getSetting(db, 'projectPath'), onboarding: getSetting(db, 'onboarding') }) ? '/new' : null;
}

// Which engines this machine has, found with the login shell's PATH so a tool the person's shell finds is
// found here too. The runner is an argument, so a test starts no CLI.
export function engineCheck(run: RunCommand = runVersion({ ...process.env, PATH: loginShellPath(process.env) })): Promise<EngineStatus[]> {
  return detectEngines(run);
}

export interface ProjectAnswer {
  path: string;
  template: string;
  // The base branch the person typed, which wins over the one the scan found.
  base?: string;
  // Injected by tests; the person's home folder and environment otherwise.
  home?: string;
  env?: Record<string, string | undefined>;
}

// A browser cannot open a folder picker on this machine, so the path is typed. "~" and a relative path
// are read from the home folder, which the person knows, and not from where the server was started.
export function resolveProjectPath(input: string, home: string): string {
  const typed = input.trim();
  if (typed === '~') return home;
  if (typed.startsWith('~/')) return join(home, typed.slice(2));
  return resolve(home, typed);
}

const plainEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export async function checkProject(answer: ProjectAnswer): Promise<{ path: string; scan: ProjectScan }> {
  // An empty field would read as the home folder, and scan every folder in it.
  if (answer.path.trim() === '') return { path: '', scan: { ok: false, reason: 'Type the folder that holds your project.' } };
  const path = resolveProjectPath(answer.path, answer.home ?? homedir());
  const scan = await scanProject(path, { branchTemplate: answer.template, env: plainEnv(answer.env ?? process.env) });
  return { path, scan };
}

// The one branch every repository starts from, when they agree on one.
function foundBase(scan: Extract<ProjectScan, { ok: true }>): string | null {
  const names = new Set(scan.repos.map((repo) => (repo.base.kind === 'branch' ? repo.base.name : null)));
  const [only] = [...names];
  return names.size === 1 && only !== null && only !== undefined ? only : null;
}

/**
 * Stores the project folder, and lets go of the team when the folder is another one.
 *
 * `teamProjectId` is one value for the machine and not one per project, and a `project.join` job is
 * the only thing that writes it. So a machine that joined a team and was then pointed at a folder
 * of its own kept the old id, and the wrap-up run on that folder read it: nothing was committed to
 * the person's own knowledge files, the note was held aside, and a proposal carrying it went up the
 * old team's socket. The id goes with the folder it was joined for.
 *
 * The job mark is not reset here. `project.join` already zeroes it for an id that is not the stored
 * one, and after this there is none stored.
 *
 * A repository list saved before goes too, or a project of one repository would read the old
 * project's repositories. A caller that saves several writes its own list after this. Only a list
 * that is there is cleared, so a single repository writes what it always wrote. The workspace flag
 * goes the same way.
 */
function saveProjectPath(db: DatabaseSync, path: string, keepTeam = false): void {
  // A project of one repository that becomes a workspace is the same project, so it keeps its team.
  if (!keepTeam && getSetting(db, 'projectPath') !== path) {
    writeSetting(db, 'teamProjectId', null);
    // How QA gets the app was answered for the old project, so the new one's first QA asks again.
    writeSetting(db, 'qaApp', null);
  }
  writeSetting(db, 'projectPath', path);
  if (getSetting(db, 'repos') !== null) writeSetting(db, 'repos', null);
  // After the list, because a workspace flag is refused while a list that needs it is stored.
  if (getSetting(db, 'workspace') !== null) writeSetting(db, 'workspace', null);
}

// Scanned again at the moment of saving, so what is stored is a folder that holds a repository now.
export async function saveProject(db: DatabaseSync, answer: ProjectAnswer): Promise<{ ok: true; path: string } | { ok: false; reason: string; path: string }> {
  const { path, scan } = await checkProject(answer);
  if (!scan.ok) return { ok: false, reason: scan.reason, path };
  // The preview is built from the template, so a template git or the setting would refuse is refused here.
  if (!scan.branchPreview.ok) return { ok: false, reason: scan.branchPreview.reason, path };
  // A workspace a teammate shared: its manifest says it is one, and its clones are the repositories.
  // A root that holds code keeps a manifest too, without the mark, and stays in its own list. The
  // ones not cloned yet are cloned from the Projects page.
  if (scan.repos[0]?.path === '.' && manifestSaysWorkspace(path)) return saveRepos(db, answer, path, scan.repos.slice(1), true);
  if (scan.repos.length > 1 || scan.repos[0]?.path !== '.') return saveRepos(db, answer, path, scan.repos);
  const base = answer.base?.trim() || foundBase(scan);
  if (base === null) return { ok: false, reason: 'The repository is on no branch. Type the base branch cards should start from.', path };
  const missing = await baseBranchProblem(path, base, answer.env ?? process.env);
  if (missing !== null) return { ok: false, reason: missing, path };

  saveProjectPath(db, path);
  writeSetting(db, 'branchTemplate', answer.template);
  writeSetting(db, 'baseBranch', base);
  fillAllowedCommands(db);
  return { ok: true, path };
}

const repoLabel = (path: string): string => (path === '.' ? 'the repository in the project folder' : `the repository ${path}`);

/**
 * Saves a folder of several repositories, each with the base branch the scan found in it.
 *
 * There is one base field on the page and repositories often differ, so the page hides it for
 * several and a typed base counts only when there is one repository. A repository with no branch to
 * start from is refused by name, before anything is written.
 */
async function saveRepos(db: DatabaseSync, answer: ProjectAnswer, path: string, found: readonly ScannedRepo[], workspace = false): Promise<{ ok: true; path: string } | { ok: false; reason: string; path: string }> {
  const repos: ProjectRepo[] = [];
  const typed = found.length === 1 ? (answer.base?.trim() ?? '') : '';
  for (const repo of found) {
    if (typed !== '') {
      const missing = await baseBranchProblem(join(path, repo.path), typed, answer.env ?? process.env, repo.path);
      if (missing !== null) return { ok: false, reason: missing, path };
      repos.push({ path: repo.path, base: typed });
      continue;
    }
    const scanned = await scannedBase(path, repo, answer.env ?? process.env);
    if ('reason' in scanned) return { ok: false, reason: scanned.reason, path };
    repos.push({ path: repo.path, base: scanned.base });
  }
  // A folder name the list cannot hold, such as two that differ only in case, is refused in the setting's words.
  const checked = validateSetting('repos', repos, workspace);
  if (!checked.ok) return { ok: false, reason: checked.message, path };

  saveProjectPath(db, path);
  writeSetting(db, 'branchTemplate', answer.template);
  // The flag before the list, because an empty list is refused without it.
  if (workspace) writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', checked.value);
  // Screens that still read one base branch read the first repository's, the project folder first.
  writeSetting(db, 'baseBranch', repos[0]?.base ?? getSetting(db, 'baseBranch'));
  fillAllowedCommands(db);
  return { ok: true, path };
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The branch a scanned repository's cards start from, or the sentence that names why it has none.
 *
 * Onboarding and the rescan on the Projects page both ask here, so both say the same sentence. Only
 * the last words differ, because one page has a Save button and the other a Scan again button.
 */
export async function scannedBase(project: string, repo: ScannedRepo, env: Record<string, string | undefined> = process.env, again = 'save again'): Promise<{ base: string } | { reason: string }> {
  const name = repoLabel(repo.path);
  if (repo.base.kind === 'unborn') {
    return { reason: `In ${name}, the branch ${repo.base.name} has no commit yet, so a card has nothing to start from. Make a first commit there, then ${again}.` };
  }
  if (repo.base.kind === 'detached') return { reason: `${capital(name)} is on no branch. Check out the branch cards should start from there, then ${again}.` };
  const base = repo.base.name;
  const missing = await baseBranchProblem(join(project, repo.path), base, env, repo.path);
  // The scan takes origin's default branch, so a clone that never checked it out has no local copy.
  // The page has no field to type another base in here, so the sentence names the git step.
  if (missing !== null) return { reason: `There is no local branch ${base} in ${name}. Make it there with git branch ${base} origin/${base}, then ${again}.` };
  return { base };
}

/**
 * Why cards cannot start from this branch, or null when they can.
 *
 * Checked while the person is here, rather than when the first card fails to start. Every save of a
 * base asks here, so each says the same sentence.
 */
export async function baseBranchProblem(path: string, base: string, env: Record<string, string | undefined> = process.env, repo: string | null = null): Promise<string | null> {
  const run = (ref: string) => git(['rev-parse', '--verify', '--quiet', ref], { cwd: path, env: gitEnv(plainEnv(env)) });
  const where = repo === null ? 'this repository' : repoLabel(repo);
  if (base.startsWith('-')) return `There is no branch ${base} in ${where}. Type a branch it has, such as the one it is on.`;
  if ((await run(`refs/heads/${base}`)).code === 0) return null;
  // A card starts from a local branch. The base branch selects make it themselves (trackBaseBranch),
  // so this sentence is for the other saves, and for a name git refused to make.
  if ((await run(`refs/remotes/origin/${base}`)).code === 0) return `There is no local branch ${base} in ${where}. Make it there with git branch ${base} origin/${base}, then save again.`;
  return `There is no branch ${base} in ${where}. Type a branch it has, such as the one it is on.`;
}

/**
 * baseBranchProblem for a base picked from origin's branches: one only origin has gets its local
 * tracking branch first, so a fresh clone can start cards from any branch origin had.
 *
 * `git branch --track` writes one ref. It changes no file and moves no checkout, and a local branch of
 * that name is used as it is. When git refuses the name, the sentence with the git step stays.
 */
export async function trackBaseBranch(path: string, base: string, env: Record<string, string | undefined> = process.env, repo: string | null = null): Promise<string | null> {
  // No check first: git refuses a name a local branch has (there is no -f) and a branch origin has not
  // got, and baseBranchProblem then answers. A leading dash would read as an option, such as -f.
  if (!base.startsWith('-')) await git(['branch', '--quiet', '--track', base, `refs/remotes/origin/${base}`], { cwd: path, env: gitEnv(plainEnv(env)) });
  return baseBranchProblem(path, base, env, repo);
}

export interface WorkspaceAnswer {
  // The folder the workspace goes in, and the name of the new folder Nolzu makes there.
  parent: string;
  name: string;
  // Injected by tests; the person's home folder and environment otherwise.
  home?: string;
  env?: Record<string, string | undefined>;
}

// New project and the idea page: the project's own folder as typed, made if it is not there.
export interface FolderAnswer extends Omit<WorkspaceAnswer, 'parent' | 'name'> {
  folder: string;
}

export type WorkspaceResult = { ok: true; path: string; report: SetupReport } | { ok: false; reason: string };

// What git never tracks in a workspace: the card checkouts and the card folders. Each clone gets a
// line of its own when it is added.
export const WORKSPACE_GITIGNORE = '/worktrees/\n/.tasks/\n';

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// lstat, so a link that points nowhere still counts as taken.
const taken = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// Where a new workspace goes, or why it cannot go there. Nothing is written.
export function workspaceTarget(answer: WorkspaceAnswer): { ok: true; path: string; parent: string } | { ok: false; reason: string } {
  const name = answer.name.trim();
  if (name === '') return { ok: false, reason: 'Type a name for the workspace. It becomes the name of its folder.' };
  if (!isFolderName(name)) {
    return { ok: false, reason: `The name ${JSON.stringify(name)} cannot name a folder. Use one folder name with no slash that does not start with "-" and is not worktrees, .tasks or .nolzu.` };
  }
  // An empty field would read as the home folder, which is a real folder and not the one meant.
  if (answer.parent.trim() === '') return { ok: false, reason: 'Type the folder the workspace goes in.' };
  const parent = resolveProjectPath(answer.parent, answer.home ?? homedir());
  if (!isFolder(parent)) return { ok: false, reason: `The folder ${parent} is not there. Make it first, or type a folder that is.` };
  const path = join(parent, name);
  if (taken(path)) return { ok: false, reason: `${path} is there already. Pick another name, or another folder to put it in.` };
  return { ok: true, path, parent };
}

type FolderTarget = { ok: true; path: string; parent: string; missing: string[] } | { ok: false; reason: string };

// <parent>/<name> makes the one folder, and its parent must be there.
const withMissing = (target: ReturnType<typeof workspaceTarget>): FolderTarget => (target.ok ? { ...target, missing: [target.path] } : target);

/**
 * Where a project folder typed as the folder itself goes, or why it cannot go there. Nothing is written.
 *
 * `missing` lists the folders a create makes, the top one first, and `parent` is the nearest folder
 * that is there. A folder that is there must be empty, so Nolzu only ever writes into a folder it made
 * or one with nothing in it.
 */
export function folderTarget(answer: FolderAnswer): FolderTarget {
  if (answer.folder.trim() === '') return { ok: false, reason: 'Type the project folder. Nolzu makes it if it is not there.' };
  // resolve drops a trailing slash, which join keeps, so the stored project path has none.
  const path = resolve(resolveProjectPath(answer.folder, answer.home ?? homedir()));
  const name = basename(path);
  if (!isFolderName(name)) {
    return { ok: false, reason: `The folder name ${JSON.stringify(name)} cannot be used. Use a name that does not start with "-" and is not worktrees, .tasks or .nolzu.` };
  }
  const missing: string[] = [];
  let at = path;
  while (!taken(at)) {
    missing.unshift(at);
    at = dirname(at);
  }
  if (!isFolder(at)) return { ok: false, reason: `${at} is a file, not a folder. Type another folder for the project.` };
  if (missing.length === 0 && readdirSync(path).length > 0) return { ok: false, reason: `${path} has files in it already. Type a new folder, or an empty one.` };
  return { ok: true, path, parent: at, missing };
}

// Takes back the folders a create made, the deepest first. One that is not empty any more stops it,
// and the folders above it stay too.
export function removeMade(made: readonly string[]): void {
  for (const folder of [...made].reverse()) {
    try {
      rmdirSync(folder);
    } catch {
      return;
    }
  }
}

/**
 * Makes a new workspace at <parent>/<name>, or at the folder typed: a git repository that holds the
 * Nolzu files and the knowledge folder, ignores the checkouts, and has no repository of its own to
 * change yet.
 *
 * With <parent>/<name> the folder must not be there yet, and a typed folder must be empty or not
 * there, so Nolzu only ever writes into a folder it made or an empty one. Everything
 * that can be asked is asked before that folder is made: the name, the parent, and whether git has
 * a name to commit with. Those refusals leave nothing behind. If git still refuses the commit, the
 * files stay and the reason says so.
 */
async function makeWorkspace(db: DatabaseSync, answer: WorkspaceAnswer | FolderAnswer, keepTeam = false): Promise<WorkspaceResult> {
  const target: FolderTarget = 'folder' in answer ? folderTarget(answer) : withMissing(workspaceTarget(answer));
  if (!target.ok) return target;
  const { path, parent, missing } = target;

  const env = gitEnv(plainEnv(answer.env ?? process.env));
  // No git at all throws, and on a Mac with no Command Line Tools Apple's stand-in answers with
  // xcrun's words, which the name and email question below would then misread.
  const version = await git(['--version'], { cwd: parent, env }).catch((error: Error) => ({ code: 127, stdout: '', stderr: error.message }));
  if (version.code !== 0) {
    const fix = process.platform === 'darwin' ? 'Install the Command Line Tools with xcode-select --install' : 'Install git';
    return { ok: false, reason: `git does not run on this machine, so nothing was written. ${fix}, then try again. ${version.stderr.trim()}`.trim() };
  }
  // Asked before anything is written. A machine with no git name and email is the one failure that
  // really happens, git refuses at the very end of the run, and the author is never invented here.
  const who = await git(['var', 'GIT_AUTHOR_IDENT'], { cwd: parent, env });
  if (who.code !== 0) return { ok: false, reason: `git has no name and email to commit with, so nothing was written. ${who.stderr.trim()}` };

  // One at a time and not recursive, so a race does not leave a tree of new folders, and a later
  // refusal takes back exactly the ones made here.
  const madeHere: string[] = [];
  try {
    for (const folder of missing) {
      mkdirSync(folder);
      madeHere.push(folder);
    }
  } catch {
    removeMade(madeHere);
    return { ok: false, reason: `${path} could not be made. Check that you can write in ${parent}.` };
  }
  // The branch is named, or git takes init.defaultBranch and the stored base branch would be one
  // the repository has not got.
  const started = await git(['init', '-q', '-b', 'main', path], { cwd: path, env });
  if (started.code !== 0) {
    removeMade(madeHere);
    return { ok: false, reason: `git could not start a repository in ${path}. ${started.stderr.trim()}` };
  }
  writeFileSync(join(path, '.gitignore'), WORKSPACE_GITIGNORE, { flag: 'wx' });

  // applySetup reads these. The flag goes before the list, because an empty list is refused without it.
  saveProjectPath(db, path, keepTeam);
  writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', []);
  writeSetting(db, 'baseBranch', 'main');

  const report = await applySetup(db, skillsFolder(), answer.env ?? process.env);
  if (report.failed !== null) return { ok: false, reason: report.failed.message };

  // add -A, not add -u: in a fresh repository every file is untracked. The person's hooks run on this
  // commit, because only Nolzu has written in the folder yet.
  const added = await git(['add', '-A'], { cwd: path, env });
  const made = added.code !== 0 ? added : await git(['commit', '-q', '--cleanup=verbatim', '-m', 'chore: start the workspace'], { cwd: path, env, hooks: true });
  if (made.code !== 0) {
    const said = made.stderr.trim();
    return { ok: false, reason: `The workspace files are written, but git could not commit them in ${path}. ${said === '' ? 'git said nothing about why.' : said}` };
  }
  return { ok: true, path, report };
}

// A new workspace with no repository yet, for New project, which clones into it next. Turning a
// project into a workspace keeps its team.
export async function createWorkspace(db: DatabaseSync, answer: WorkspaceAnswer | FolderAnswer, keepTeam = false): Promise<WorkspaceResult> {
  return makeWorkspace(db, answer, keepTeam);
}

// The counters are named ticket:<project>:<prefix>, and this app is project 1, as createCardFrom has it.
const counters = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM seq WHERE name LIKE 'ticket:%'").all() as { name: string }[]).map((row) => {
    const [, project, prefix] = row.name.split(':');
    return { project, prefix: prefix ?? '' };
  });

// The prefixes other projects count with. This project's own, earlier ones included, are its to reuse.
const usedPrefixes = (db: DatabaseSync): string[] => counters(db).filter((row) => row.project !== '1').map((row) => row.prefix);

const storedPrefix = (db: DatabaseSync): string | null =>
  db.prepare("SELECT key FROM settings WHERE key = 'localKeyPrefix'").get() === undefined ? null : getSetting(db, 'localKeyPrefix');

// Whether a prefix could be stored here, for the one Settings, Project offers when Jira has this one.
export const prefixFree = (db: DatabaseSync, prefix: string): boolean => prefixProblem(prefix, usedPrefixes(db), storedPrefix(db)) === null;

// The key prefix the Projects page stores, refused in one place.
export function storeTickets(db: DatabaseSync, prefix: string): string | null {
  const typed = prefix.trim();
  // Only a stored prefix is this project's; the default would hide a clash with another project's APP.
  const problem = prefixProblem(typed, usedPrefixes(db), storedPrefix(db));
  if (problem !== null) return problem;
  // The prefix is for both systems, so a Jira project stays a Jira project when its prefix changes.
  writeSetting(db, 'ticketSystem', getSetting(db, 'ticketSystem'));
  writeSetting(db, 'localKeyPrefix', typed);
  return null;
}

/**
 * The project's list of allowed commands, filled from its stack the first time.
 *
 * Only while the setting is null: an empty list is the person's own answer and stays empty. A
 * project with no stack to propose from is left unfilled, so the list fills once one appears.
 */
export function fillAllowedCommands(db: DatabaseSync): readonly string[] {
  const stored = getSetting(db, 'allowedCommands');
  if (stored !== null) return stored;
  const proposed = proposedCommands(db);
  if (proposed.length === 0) return [];
  writeSetting(db, 'allowedCommands', proposed);
  return proposed;
}

/**
 * The commands every repository of the project proposes, each once, in repository order.
 *
 * The list is one per project, so a workspace of several stacks gets the commands of each, run
 * in that repository's folder.
 */
export function proposedCommands(db: DatabaseSync): string[] {
  const project = getSetting(db, 'projectPath');
  if (project === null) return [];
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  return [
    ...new Set(
      repos.flatMap(({ path }) => {
        const folder = join(project, path);
        let files: string[] = [];
        try {
          files = readdirSync(folder);
        } catch {
          // A folder that is gone proposes nothing.
        }
        const deep = DEEP_FILES.filter((file) => existsSync(join(folder, file)));
        return proposeAllowedCommands(files.includes('package.json') ? (packageScripts(folder) ?? {}) : null, [...files, ...deep]);
      }),
    ),
  ];
}

// The scripts of the package.json in a folder. Null for no package.json, or one that does not parse:
// there is nothing to read then, and no screen may fail over a file the project owns.
export function packageScripts(folder: string): Record<string, string> | null {
  try {
    return (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? null;
  } catch {
    return null;
  }
}

export interface SetupReport {
  written: string[];
  // Files a write took away: an older Nolzu's WORKSPACE.md, whose text AGENTS.md holds now.
  removed: string[];
  // Files the person wrote, which Nolzu left alone.
  kept: string[];
  // Files Nolzu wrote before and that are still as it wrote them.
  alreadyRight: string[];
  // Files Nolzu was not allowed to write, each with the reason. A symlink is the usual one.
  refused: { path: string; message: string }[];
  // One entry per skills folder that synced. A folder refused is in `refused` instead. Null when the
  // sync never ran, which is not the same as nothing to copy.
  skills: (SyncResult & { folder: string })[] | null;
  // The write that stopped the run. What was written before it stays written, and the report says so.
  failed: { path: string; message: string } | null;
  // The repository files and the run recipe in the knowledge folder. Null when the project files failed
  // first, or when the move below was refused, since a new file at a new place would block that move.
  knowledge: RepoKnowledgeReport | null;
  // The move of an older knowledge folder into the folders of its repositories. Null when the project
  // files failed first. Absent where no write of the project files ran.
  knowledgeMove?: KnowledgeMoveReport | null;
}

// What a write of the project files did, as one answer for the page that asked for it.
export function setupSaid(report: SetupReport): string {
  const said = [report.written.length === 0 && report.removed.length === 0 ? 'Every project file was there already.' : report.written.length === 0 ? null : `Wrote ${report.written.join(', ')}.`].filter((one) => one !== null);
  if (report.removed.length > 0) said.push(`Removed ${report.removed.join(', ')}, as AGENTS.md holds its text now.`);
  if (report.kept.length > 0) said.push(`Kept ${report.kept.join(', ')} as you wrote ${report.kept.length === 1 ? 'it' : 'them'}.`);
  for (const one of report.refused) said.push(one.message);
  const into = (report.skills ?? []).filter((one) => one.copied.length > 0);
  const copied = into.reduce((sum, one) => sum + one.copied.length, 0);
  const folders = into.map((one) => one.folder);
  const named = folders.length > 1 ? `${folders.slice(0, -1).join(', ')} and ${folders.at(-1)}` : folders.join('');
  if ((report.skills?.length ?? 0) > 0) said.push(copied === 0 ? 'The skills were up to date.' : `Copied ${copied === 1 ? '1 skill file' : `${copied} skill files`} into ${named}.`);
  if (report.knowledgeMove?.refused) said.push(report.knowledgeMove.refused);
  if (report.knowledgeMove?.said) said.push(report.knowledgeMove.said);
  if (report.knowledge?.problem) said.push(report.knowledge.problem);
  return said.join(' ');
}

export interface RepoKnowledgeReport {
  // Relative to the knowledge folder.
  written: string[];
  // Why nothing, or nothing more, could be done. Null when every new file is committed.
  problem: string | null;
}

// What the run recipe reads from one repository: its package.json scripts and the file names at its
// top, with the few below it the stack table looks for, as the allowed commands read them.
function recipeFacts(projectPath: string, path: string): RecipeFacts {
  const folder = join(projectPath, path);
  let files: string[] = [];
  try {
    files = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    // A repository that cannot be read gets the section that says nothing was read.
  }
  const deep = DEEP_FILES.filter((file) => existsSync(join(folder, file)));
  return { path, files: [...files, ...deep], scripts: files.includes('package.json') ? (packageScripts(folder) ?? {}) : null };
}

/**
 * Writes the first knowledge file of each repository that has none and the run recipe's section for
 * it, and commits what is new.
 *
 * They are committed because a knowledge run sees its own work through `git status`, and an
 * untracked file it edits would still read as the same new file. A repository file already there
 * is never touched, and the run recipe only gets a section for a repository it has none for. A
 * knowledge folder in no git repository still gets the files, with no commit, because every run's
 * knowledge index reads them.
 */
export async function writeRepoKnowledge(db: DatabaseSync, repos: readonly { path: string; base: string }[], env: Record<string, string | undefined> = process.env): Promise<RepoKnowledgeReport> {
  const projectPath = getSetting(db, 'projectPath');
  const picked = getSetting(db, 'knowledgeDir');
  const folder = resolveKnowledgeDir({ knowledgeDir: picked, projectPath });
  if (projectPath === null || folder === null) return { written: [], problem: 'There is no project set, so no repository file was written.' };

  // The default folder is made, as the loop makes it before a wrap-up. A folder a person typed never is.
  let made: string | undefined;
  try {
    made = picked === null ? mkdirSync(folder, { recursive: true }) : undefined;
  } catch (error) {
    return { written: [], problem: `Could not make the knowledge folder ${folder}. ${(error as Error).message}` };
  }
  const run: RunGit = (args) => git(args, { cwd: folder, env: gitEnv(plainEnv(env)) });
  const check = await checkKnowledgeDir(folder, { projectPath, run, repos: projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path) });
  if (!check.ok && check.problem !== 'no-repository') {
    // The folder was made only to ask, so a refusal leaves nothing behind.
    if (made !== undefined) rmSync(made, { recursive: true, force: true });
    return { written: [], problem: check.reason };
  }

  const written: string[] = [];
  let problem: string | null = null;
  for (const repo of repos) {
    const path = repoKnowledgePath(repo.path);
    // A link anywhere on the way is refused, so a write never leaves the knowledge folder.
    const target = writablePath(resolve(folder), path);
    if (target === null) {
      problem = `Nolzu did not write ${path} in the knowledge folder, because it or a folder on its way is a link or not a plain file.`;
      continue;
    }
    if (existsSync(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, repoKnowledge(repo), { flag: 'wx' });
    } catch (error) {
      // A second setup that got here first wrote it, which is the same as a file already there.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // What was written before still gets its commit below, and the report says what stopped.
      problem = `Could not write ${path} in the knowledge folder. ${(error as Error).message}`;
      break;
    }
    written.push(path);
  }
  const recipe = writablePath(resolve(folder), RUN_RECIPE_FILE);
  if (recipe === null) {
    problem ??= `Nolzu did not write ${RUN_RECIPE_FILE} in the knowledge folder, because it is a link or not a plain file.`;
  } else {
    try {
      // Limit: read then write, so two setups at the same moment could add a section twice. A person deletes one.
      const text = runRecipe(repos.map((repo) => recipeFacts(projectPath, repo.path)), existsSync(recipe) ? readFileSync(recipe, 'utf8') : null);
      if (text !== null) {
        writeFileSync(recipe, text);
        written.push(RUN_RECIPE_FILE);
      }
    } catch (error) {
      problem ??= `Could not write ${RUN_RECIPE_FILE} in the knowledge folder. ${(error as Error).message}`;
    }
  }
  if (written.length === 0) return { written, problem };
  if (!check.ok) return { written, problem: problem ?? 'The knowledge folder is in no git repository, so Nolzu wrote the knowledge files without a commit. A wrap-up needs one to add knowledge.' };

  try {
    // The commit names paths from the repository root, and the knowledge folder can sit anywhere in it.
    const prefix = (await run(['rev-parse', '--show-prefix'])).stdout.trim();
    await commitKnowledgeFiles(run, 'knowledge: repository files', written.map((path) => prefix + path));
  } catch (error) {
    return { written, problem: `The repository files are written, but git could not commit them. ${(error as Error).message}` };
  }
  return { written, problem };
}

// The knowledge folder's files planned for the layout grouped by repository, with the folder. The text
// is read only for a note at the top, the one kind whose place its paths decide.
function knowledgeMovePlan(db: DatabaseSync): { folder: string; plan: ReturnType<typeof planKnowledgeMoves> } | null {
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  if (folder === null || !existsSync(folder)) return null;
  const files = knowledgeFiles(folder).map((path) => {
    let text = '';
    try {
      text = path.includes('/') ? '' : readFileSync(join(folder, path), 'utf8');
    } catch {
      // Gone since the listing: a file with no paths, which stays.
    }
    return { path, text };
  });
  return { folder, plan: planKnowledgeMoves(files, projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path)) };
}

// How many knowledge files wait to move into the folders of their repositories, and how many stay at
// the old place because their new place holds a file already, for the notice.
export function knowledgeMovesPending(db: DatabaseSync): { moves: number; kept: number } {
  const plan = knowledgeMovePlan(db)?.plan;
  return { moves: plan?.moves.length ?? 0, kept: plan?.taken.length ?? 0 };
}

export interface KnowledgeMoveReport {
  // What moved and what stayed, or null when there was nothing to say.
  said: string | null;
  // Why nothing moved. A refusal, or a failure on the way, leaves every file where it was.
  refused: string | null;
}

const KNOWLEDGE_RUN = "SELECT 1 FROM runs WHERE phase IN ('wrapup', 'optimize', 'orient', 'learn-repo') AND state IN ('queued', 'running') LIMIT 1";
const filesWord = (count: number) => (count === 1 ? '1 knowledge file' : `${count} knowledge files`);
const rmdirQuiet = (dir: string): void => {
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or gone: either way it is not this move's to remove.
  }
};
const NOT_MOVED = 'Nolzu moved no knowledge file into the folders of their repositories.';
const AGAIN = 'Then write the project files again.';

// The files at the old place whose new place holds a file already. Nolzu never writes over one.
const takenLine = (taken: readonly string[]): string =>
  `${taken.join(', ')} ${taken.length === 1 ? 'stays' : 'stay'} where ${taken.length === 1 ? 'it is' : 'they are'}, because a file is at ${taken.length === 1 ? 'its' : 'their'} new place already. Merge ${taken.length === 1 ? 'it' : 'them'} by hand.`;

/**
 * Moves a knowledge folder of the older layout into the one grouped by repository, in one commit.
 *
 * Code does it, not a run, so nothing is guessed: a note moves only to the folder its paths name. It
 * is refused while a knowledge run or a change that waits for review could write the same files, while
 * the folder has changes git has not committed, so the commit holds the move and nothing else, and
 * while git ignores a folder the files would move into. A file already at the new place is never
 * overwritten. A rename or the commit that fails puts every moved file back, so the folder is never
 * left half moved, which the next write would not see as a move.
 */
export async function moveOldKnowledge(db: DatabaseSync, env: Record<string, string | undefined> = process.env): Promise<KnowledgeMoveReport> {
  const found = knowledgeMovePlan(db);
  if (found === null || (found.plan.moves.length === 0 && found.plan.taken.length === 0)) return { said: null, refused: null };
  const { folder, plan } = found;
  if (plan.moves.length === 0) return { said: takenLine(plan.taken), refused: null };
  const refuse = (why: string): KnowledgeMoveReport => ({ said: null, refused: `${NOT_MOVED} ${why} ${AGAIN}` });

  const run: RunGit = (args) => git(args, { cwd: folder, env: gitEnv(plainEnv(env)) });
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path);
  // The same check every knowledge run makes, so a folder git ignores, or a repository folder in it
  // that a .gitignore line without a leading slash matches, gets the same sentence.
  const check = await checkKnowledgeDir(folder, { projectPath: getSetting(db, 'projectPath'), run, repos });
  if (!check.ok && check.problem !== 'no-repository') return refuse(check.reason ?? '');
  const inGit = check.ok;
  try {
    if (inGit && (await knowledgeState(run)).length > 0) return refuse('The knowledge folder has changes git has not committed. Commit or drop them.');
  } catch (error) {
    return refuse(`git could not read the knowledge folder. ${(error as Error).message}`);
  }
  // Read last, right before the renames, so a run or a review that started while git was asked is seen.
  if (pendingKnowledgeChanges(db).length > 0) return refuse('A knowledge change waits for review. Apply or return it on Knowledge.');
  if (db.prepare(KNOWLEDGE_RUN).get() !== undefined) return refuse('A knowledge run is queued or running. Wait until it ends.');

  // A link on either side is refused before anything moves, so a move never reads or writes outside
  // the knowledge folder.
  const root = resolve(folder);
  const linked = plan.moves.find((move) => writablePath(root, move.from) === null || writablePath(root, move.to) === null);
  if (linked !== undefined) return refuse(`${linked.from} or its new place ${linked.to} is a link, or a folder on the way is.`);

  const moved: { from: string; to: string }[] = [];
  const made: string[] = [];
  const taken = [...plan.taken];
  const back = () => {
    for (const move of [...moved].reverse()) renameSync(join(root, move.to), join(root, move.from));
    // Only a folder this move made, and only once it is empty again.
    for (const dir of [...made].reverse()) rmdirQuiet(dir);
  };
  try {
    for (const move of plan.moves) {
      const to = join(root, move.to);
      if (existsSync(to)) {
        taken.push(move.from);
        continue;
      }
      const first = mkdirSync(dirname(to), { recursive: true });
      if (first !== undefined) made.push(first);
      renameSync(join(root, move.from), to);
      moved.push(move);
    }
  } catch (error) {
    back();
    return refuse(`A file could not be moved, so every file went back. ${(error as Error).message}`);
  }
  if (moved.length > 0 && inGit) {
    const prefix = (await run(['rev-parse', '--show-prefix'])).stdout.trim();
    const paths = moved.flatMap((move) => [prefix + move.from, prefix + move.to]);
    try {
      await commitKnowledgeFiles(run, 'knowledge: group the files by repository', paths);
    } catch (error) {
      back();
      // A failed add can leave part of the move staged. The paths had no change before, so their
      // index entries go back to the last commit.
      await run(['reset', '-q', '--', ...paths.map((path) => `:(top,literal)${path}`)]);
      return refuse(`git could not commit the move, so every file went back. ${(error as Error).message}`);
    }
  }
  // The old folder goes once it is empty, as git mv leaves no folder behind.
  try {
    rmdirSync(join(root, 'repositories'));
  } catch {
    // Not there, or a file stayed in it.
  }

  const said = moved.length === 0 ? [] : [`Moved ${filesWord(moved.length)} into the folders of their repositories${inGit ? ' and committed the move' : ''}.`];
  if (moved.length > 0 && !inGit) said.push('The knowledge folder is in no git repository, so nothing was committed.');
  if (plan.left.length > 0) said.push(`${plan.left.join(', ')} ${plan.left.length === 1 ? 'stays' : 'stay'} at the top of the knowledge folder, because ${plan.left.length === 1 ? 'its' : 'their'} paths name no repository. Move ${plan.left.length === 1 ? 'it' : 'them'} by hand.`);
  if (taken.length > 0) said.push(takenLine(taken));
  return { said: said.join(' '), refused: null };
}

// The files Nolzu owns in a project, read as they are now, so the planner can keep what a person wrote.
function existingFiles(projectPath: string): Record<string, string> {
  // WORKSPACE.md too, which an older Nolzu wrote and a write now folds into AGENTS.md.
  const wanted = [OLD_WORKSPACE, 'AGENTS.md', POINTER, GUARD_PATH, SETTINGS_PATH];
  const found: Record<string, string> = {};
  for (const path of wanted) {
    try {
      found[path] = readFileSync(join(projectPath, path), 'utf8');
    } catch {
      // Not there, which is what the planner reads as a file to write.
    }
  }
  return found;
}

const POINTER = 'CLAUDE.md';

// The files Nolzu writes in the project folder, for the Workspace page, which ticks them by default. A
// path that ends in a slash is a folder: the skill folders with their records, and the phase instructions.
export const NOLZU_FILES: readonly string[] = [
  ...planProjectFiles({ existing: {}, agents: '', pointer: '', pointerPath: POINTER }).writes.map((write) => write.path),
  ...SKILL_FOLDERS.map((folder) => `${folder}/`),
  `${dirname(phaseInstructionsPath('plan'))}/`,
];

// What a write of the project files would do now, for applySetup.
export const projectFilesPlan = (projectPath: string): ProjectPlan =>
  planProjectFiles({ existing: existingFiles(projectPath), agents: AGENTS_MD, pointer: pointerFile(POINTER), pointerPath: POINTER });

// Writes the project files and syncs the pipeline skills. Run again, it writes no byte: the planner
// keeps what a person changed and the sync only replaces what it wrote itself.
export async function applySetup(db: DatabaseSync, skills: string = skillsFolder(), env: Record<string, string | undefined> = process.env): Promise<SetupReport> {
  const nothing = (message: string): SetupReport => ({ written: [], removed: [], kept: [], alreadyRight: [], refused: [], skills: null, failed: { path: '', message }, knowledge: null });
  const projectPath = getSetting(db, 'projectPath');
  if (projectPath === null) return nothing('There is no project set, so nothing was written.');
  // Checked here, or a folder deleted since the project was set is reported as the wrong folder.
  if (!existsSync(projectPath)) return nothing(`The folder ${projectPath} is not there any more, so nothing was written.`);
  // A newer Nolzu wrote this project, so its agent rules and run guard are newer too. Nothing is written,
  // or this older one would put back text the newer one replaced.
  const newer = syncSkillFolders(skills, projectPath, { version: NOLZU_VERSION, dryRun: true }).find((one) => one.synced?.newer !== undefined)?.synced?.newer;
  if (newer !== undefined) return nothing(newerLine(newer));

  const plan = projectFilesPlan(projectPath);
  const applied = applyPlan(projectPath, projectPath, plan);
  // applyPlan counts a file it left alone and one that is already right as the same thing; the person
  // reads them differently, so the plan's own word for each is used here.
  const yours = new Set(plan.writes.filter((write) => write.kind === 'keep').map((write) => write.path));
  // The skills go to every folder an engine reads them from. A folder that is a link is refused alone,
  // and the others still get their copy.
  const refused = [...applied.refused];
  const folders = applied.failed === null ? syncSkillFolders(skills, projectPath, { version: NOLZU_VERSION }) : null;
  // The notice reads the status again, since this write changed it.
  filesStatus = null;
  // An extra skill named after a Nolzu skill is refused in every folder alike, so it is said once.
  for (const message of new Set(folders?.flatMap((one) => one.synced?.refused ?? []) ?? [])) refused.push({ path: EXTRA_SKILLS, message });
  for (const { folder } of folders?.filter((one) => one.synced === null) ?? []) {
    refused.push({ path: folder, message: `${folder.split('/')[0]} or ${folder} is a link, or something other than a folder, so the skills were not copied there. Move it away, or copy the skills by hand.` });
  }
  const synced = folders?.flatMap(({ folder, synced }) => (synced === null ? [] : [{ folder, ...synced }])) ?? null;
  const repos = getSetting(db, 'repos');
  // The move first: a repository file written at its new place would block the move of the old one.
  const knowledgeMove = applied.failed === null ? await moveOldKnowledge(db, env) : null;
  const knowledge = applied.failed === null && knowledgeMove?.refused === null ? await writeRepoKnowledge(db, projectRepos({ repos, baseBranch: getSetting(db, 'baseBranch') }), env) : null;
  return {
    written: [...applied.written],
    removed: [...applied.removed],
    kept: applied.kept.filter((path) => yours.has(path)),
    alreadyRight: applied.kept.filter((path) => !yours.has(path)),
    refused,
    skills: synced,
    failed: applied.failed,
    knowledge,
    knowledgeMove,
  };
}

const newerLine = (wrote: string, version: string = NOLZU_VERSION): string => `These project files come from Nolzu ${wrote}, newer than this Nolzu ${version}. Update Nolzu.`;

export interface ProjectFilesStatus {
  // What a write of the project files would change, from the project folder. Skill files are under their folder.
  updates: string[];
  // Files changed by hand, which a write keeps.
  yours: string[];
  // The line for a skills folder a newer Nolzu wrote. A write leaves that folder alone.
  newer: string | null;
  // Knowledge files of the older layout that a write moves into the folders of their repositories.
  // Absent where the status was read without the project's settings.
  moves?: number;
  // Knowledge files of the older layout that stay, because their new place holds a file already.
  kept?: number;
}

// What a write of the project files would do, with no write: the planner for the markdown files and the
// run guard, and a dry run of the sync for the skills. Null for a project Nolzu never wrote skills into, whose files the person left
// out on purpose or a first card still has to write.
export function projectFilesStatus(projectPath: string, skills: string = skillsFolder(), version: string = NOLZU_VERSION): ProjectFilesStatus | null {
  if (!SKILL_FOLDERS.some((folder) => isFileAt(join(projectPath, folder, SYNC_RECORD)))) return null;
  const writes = projectFilesPlan(projectPath).writes;
  const root = resolve(projectPath);
  // A link is refused by the write, so it is no update, or Update would never clear the notice.
  const updates = writes.filter((write) => (write.kind === 'create' || write.kind === 'replace' || write.kind === 'append' || write.kind === 'remove') && writablePath(root, write.path) !== null).map((write) => write.path);
  // A project file the person kept for the text this Nolzu ships is no longer pending.
  const keptFor = join(projectPath, SKILL_FOLDERS[0]);
  const yours = writes
    .filter((write) => write.kind === 'keep' && keptMark(keptFor, write.path) !== shippedMark(freshProjectFile(write.path)))
    .map((write) => write.path);
  let newer: string | null = null;
  for (const { folder, synced } of syncSkillFolders(skills, projectPath, { version, dryRun: true })) {
    if (synced === null) continue;
    if (synced.newer !== undefined) {
      newer ??= newerLine(synced.newer, version);
      continue;
    }
    updates.push(...[...synced.copied, ...synced.removed].map((path) => `${folder}/${path}`));
    yours.push(...synced.conflicts.map((path) => `${folder}/${path}`));
  }
  return { updates, yours, newer };
}

const isFileAt = (at: string): boolean => {
  try {
    return statSync(at).isFile();
  } catch {
    return false;
  }
};

// Limit: one project's status, kept until the project changes or a write clears it. The shipped files
// change only with a new Nolzu, so a page load never walks the skills folders.
let filesStatus: { path: string; status: ProjectFilesStatus | null } | null = null;

// The status for the notice in the app and Settings, Project. A status that fails to read is no notice.
export function projectFilesNotice(db: DatabaseSync): ProjectFilesStatus | null {
  const path = getSetting(db, 'projectPath');
  if (path === null) return null;
  if (filesStatus?.path !== path) {
    let status: ProjectFilesStatus | null = null;
    try {
      const read = existsSync(path) ? projectFilesStatus(path) : null;
      status = read === null ? null : { ...read, ...knowledgeMovesPending(db) };
    } catch {
      // A folder that cannot be read gets no notice, and Write the project files says what is wrong.
    }
    filesStatus = { path, status };
  }
  return filesStatus.status;
}

// The whole file a write of the project files makes where there is none: what "Take the new one" writes
// for a project file the person changed. Null for a file the planner does not make.
const freshProjectFile = (path: string): string | null =>
  planProjectFiles({ existing: {}, agents: AGENTS_MD, pointer: pointerFile(POINTER), pointerPath: POINTER }).writes.find((write) => write.path === path)?.content ?? null;

// What Nolzu ships for one file the status calls the person's: a skill file of one of the three folders,
// or a project file. `shipped` is null for a skill file Nolzu no longer ships.
interface Shipped {
  // The skills folder and the path in it, or null for a project file.
  folder: string | null;
  inFolder: string;
  shipped: Buffer | null;
}

// A skill Nolzu does not ship comes from the project's own extra skills, so "Take the new one" puts
// back that text and never takes the file away.
function shippedFor(path: string, skills: string, projectPath: string): Shipped {
  const folder = SKILL_FOLDERS.find((one) => path.startsWith(`${one}/`)) ?? null;
  if (folder === null) {
    const fresh = freshProjectFile(path);
    return { folder, inFolder: path, shipped: fresh === null ? null : Buffer.from(fresh) };
  }
  const inFolder = path.slice(folder.length + 1);
  const at = [join(skills, inFolder), join(projectPath, EXTRA_SKILLS, inFolder)].find(isFileAt);
  return { folder, inFolder, shipped: at === undefined ? null : readFileSync(at) };
}

export interface HandEdit {
  // From the project folder, as the status names it.
  path: string;
  // git's patch from Nolzu's text to the person's. Null for a file reached through a link, which Nolzu
  // does not read.
  patch: string | null;
  // Nolzu no longer ships this file, so "Take the new one" removes it.
  gone: boolean;
  // git does not hold the person's text: the file has changes git has not committed, is untracked or
  // ignored, or the folder is in no repository. "Take the new one" asks once more for such a file.
  unsaved: boolean;
}

// Anything git prints, or git failing, means the person's text is only on the disk.
async function unsavedIn(projectPath: string, path: string): Promise<boolean> {
  const status = await git(['status', '--porcelain', '--ignored', '--', path], { cwd: projectPath, env: gitEnv(plainEnv(process.env)) });
  return status.code !== 0 || status.stdout.trim() !== '';
}

// git's own diff of two texts, from a copy of the shipped one in a temp folder, so the page draws it the
// way the Changes tab draws a card's. The person's diff tool and text filters are left out, so the patch
// is always git's. The header names the temp folder, so the patch starts at its first hunk.
async function patchOf(projectPath: string, at: string, shipped: Buffer | null): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'nolzu-shipped-'));
  try {
    const from = join(scratch, 'shipped');
    if (shipped !== null) writeFileSync(from, shipped);
    const diff = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', shipped === null ? '/dev/null' : from, at], { cwd: projectPath, env: gitEnv(plainEnv(process.env)) });
    const hunk = diff.stdout.search(/^@@/m);
    return hunk === -1 ? '' : diff.stdout.slice(hunk);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The files the person changed, each with its diff, for Settings, Project. The status is read fresh
// here, and the notice takes it, so opening the page also brings the notice up to date.
export async function handEditedFiles(db: DatabaseSync, skills: string = skillsFolder()): Promise<HandEdit[]> {
  const projectPath = getSetting(db, 'projectPath');
  if (projectPath === null || !existsSync(projectPath)) return [];
  let status: ProjectFilesStatus | null;
  try {
    status = projectFilesStatus(projectPath, skills);
  } catch {
    return [];
  }
  filesStatus = { path: projectPath, status: status === null ? null : { ...status, ...knowledgeMovesPending(db) } };
  const root = resolve(projectPath);
  return Promise.all(
    (status?.yours ?? []).map(async (path): Promise<HandEdit> => {
      const { shipped } = shippedFor(path, skills, projectPath);
      const at = writablePath(root, path);
      const [patch, unsaved] = await Promise.all([at === null ? null : patchOf(projectPath, at, shipped), unsavedIn(projectPath, path)]);
      return { path, patch, gone: shipped === null, unsaved };
    }),
  );
}

export type HandEditAnswer = { said: string } | { problem: string; ask?: boolean };

// Only a file the status calls the person's, so a post cannot name any other path in the project.
function handEdit(db: DatabaseSync, path: string, skills: string): { projectPath: string; file: Shipped } | { problem: string } {
  const projectPath = getSetting(db, 'projectPath');
  if (projectPath === null || !existsSync(projectPath)) return { problem: 'The project folder is not there any more, so nothing was written.' };
  const status = projectFilesStatus(projectPath, skills);
  // A newer Nolzu wrote this project, so its files are newer than the text this one ships.
  if (status !== null && status.newer !== null) return { problem: status.newer };
  if (!(status?.yours.includes(path) ?? false)) return { problem: `${path} is not a file you changed, so nothing was written.` };
  const file = shippedFor(path, skills, projectPath);
  // The record of the folder the answer goes in. A linked folder is refused, as the sync refuses it.
  const record = `${file.folder ?? SKILL_FOLDERS[0]}/${SYNC_RECORD}`;
  if (writablePath(resolve(projectPath), record) === null) return { problem: `${record.split('/')[0]} is a link, or something other than a folder, so Nolzu did not write there.` };
  return { projectPath, file };
}

// "Take the new one": Nolzu's text in place of the person's. A file whose text git does not hold is
// written only with `sure`, the answer to the ask.
export async function takeShipped(db: DatabaseSync, path: string, sure: boolean, skills: string = skillsFolder()): Promise<HandEditAnswer> {
  const found = handEdit(db, path, skills);
  if ('problem' in found) return found;
  const { projectPath, file } = found;
  if (!sure && (await unsavedIn(projectPath, path))) return { problem: unsavedLine(path), ask: true };
  const link = `${path} is a link, or something other than a plain file, so Nolzu did not write through it.`;
  if (file.folder !== null) {
    if (!takeShippedSkill(join(projectPath, file.folder), file.inFolder, file.shipped)) return { problem: link };
  } else {
    // The same write as Write the project files, which refuses a link at the moment of the write.
    const applied = applyPlan(projectPath, projectPath, { writes: [{ path, kind: 'replace', content: file.shipped?.toString('utf8') ?? '', note: '' }], dirs: [], refused: [] });
    if (applied.failed !== null) return { problem: applied.failed.message };
    if (applied.refused.length > 0) return { problem: link };
    keepForShipped(join(projectPath, SKILL_FOLDERS[0]), path, null);
  }
  filesStatus = null;
  return { said: file.shipped === null ? `Removed ${path}, which Nolzu no longer ships. Commit it.` : `Wrote Nolzu's text to ${path}. Commit it.` };
}

// "Keep mine": the record keeps the file as the person's for the text Nolzu ships now, so the notice
// stops counting it until a newer Nolzu ships another text for it.
export function keepMine(db: DatabaseSync, path: string, skills: string = skillsFolder()): HandEditAnswer {
  const found = handEdit(db, path, skills);
  if ('problem' in found) return found;
  const { projectPath, file } = found;
  keepForShipped(join(projectPath, file.folder ?? SKILL_FOLDERS[0]), file.inFolder, shippedMark(file.shipped));
  filesStatus = null;
  return { said: `Kept your ${path}. Nolzu asks again when it ships a new text for it.` };
}
