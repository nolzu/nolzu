import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { NEW_PROJECT_BRANCH_TEMPLATE, proposePrefix } from '@nolzu/core';
import { createProject, dropProject, getSetting, peekLocalKey, projectOf, projectProfiles, registeredProjects, writeSetting } from '@nolzu/core/node';
import { type BoardKind, presetLabel } from '@nolzu/protocol';
import { cloneRepository, cloneTarget, copyToPush, createPrivateRepo, firstCommit, ghRunner, githubOwners, loginShellPath, repoNameProblem, type RunCommand, type RunGh, runVersion, scanMachine } from '@nolzu/runner';
import { type Clone, cloneEnded, type CloneJob, cloneJobs, startClone } from './add-repo.ts';
import { createCardFrom } from './create-card.ts';
import { forgetProject } from './db.ts';
import { nextKeys } from './first-task.ts';
import { homePath } from './home-path.ts';
import { hubProjectsChanged } from './hub-link.ts';
import { readManifest } from './manifest.ts';
import { createWorkspace, storeTickets } from './onboard.ts';
import { CONTEXT_LIMIT } from './overview.ts';
import { listedRepos } from './projects.ts';

type Env = Record<string, string | undefined>;

// The project New project is making: a workspace it made, whose first run is not finished yet. The
// first run ends with the first card.
// Paths are as a person reads them, with the home folder as ~.
export interface NewProject {
  path: string;
  name: string;
  location: string;
  repos: { name: string; base: string; url: string | null }[];
}

export function projectInProgress(db: DatabaseSync, home: string = homedir()): NewProject | null {
  const path = getSetting(db, 'projectPath');
  if (path === null || getSetting(db, 'workspace') !== true || getSetting(db, 'onboarding').done || !newest(db)) return null;
  const urls = new Map(readManifest(path).repos.map((repo) => [repo.folder, repo.url]));
  return {
    path: homePath(path, home),
    name: basename(path),
    location: homePath(dirname(path), home),
    repos: listedRepos(db).map((repo) => ({ name: repo.path, base: repo.base, url: urls.get(repo.path) ?? null })),
  };
}

// The first run's flag follows the machine, and New project makes one project at a time, each the
// newest in the registry. So only the newest can be the one being made, and an older workspace opened
// while a later one waits never reads as being made.
const newest = (db: DatabaseSync): boolean => {
  const own = projectOf(db);
  return own === undefined || registeredProjects(db).at(-1)?.id === own.project.id;
};

/**
 * Adds a repository to the project being made, by the URL typed or the remote of one found on this
 * machine. The first one makes the workspace in the folder typed, so clones run while the person
 * keeps typing.
 *
 * The URL passes the clone rules before the workspace is made, so a refused one leaves no folder.
 */
export async function addToNewProject(db: DatabaseSync, answer: { name: string; folder: string; url: string }, env: Env = process.env, clone: Clone = cloneRepository): Promise<{ job: CloneJob } | { problem: string }> {
  const target = cloneTarget(answer.url);
  if (!target.ok) return { problem: target.reason };
  const opened = await openNewProject(db, answer, env);
  if ('problem' in opened) return opened;
  return startClone(opened.db, answer.url, env, clone);
}

/**
 * The database of the project being made, with its workspace made by the first add.
 *
 * The project being made goes on, and on a first run the project with no folder yet takes the
 * workspace. Any other time the project is a later one: it gets a database of its own beside the others,
 * and becomes the current project.
 */
async function openNewProject(db: DatabaseSync, answer: { folder: string }, env: Env): Promise<{ db: DatabaseSync } | { problem: string }> {
  if (projectInProgress(db) !== null) return { db };
  const later = getSetting(db, 'projectPath') !== null;
  // Limit: the new connection stays open for the server's life, as the clones it starts write through
  // it after the answer. One per project made; `database()` opens its own for the routes.
  const made = later ? createProject(projectOf(db)!.dataDir) : db;
  // The project files go in with the workspace: they sit in Nolzu's own folder, not in a
  // repository, so nothing is gained by waiting. The folder is the project's own, as typed, and made
  // when it is not there.
  const workspace = await createWorkspace(made, { folder: answer.folder, env });
  // A folder made is a project New project can go on with, also when git refused its first commit.
  if (getSetting(made, 'projectPath') !== null) {
    if (later) {
      writeSetting(made, 'currentProject', projectOf(made)!.project.id);
      // Now that it has a folder, and so a name the hub takes.
      hubProjectsChanged();
    }
    // A later project starts not done, as the first one does.
    writeSetting(made, 'onboarding', { done: false });
    // Stored and not left to the default, so a later change to the default renames nothing here. One
    // that stored a template keeps it.
    if (made.prepare("SELECT 1 FROM settings WHERE key = 'branchTemplate'").get() === undefined) writeSetting(made, 'branchTemplate', NEW_PROJECT_BRANCH_TEMPLATE);
    // Research (Investigations and Questions) and PR reviews start off, so the rail shows the two boards
    // a first card goes on. Add a board turns them on.
    writeSetting(made, 'offBoards', ['investigations', 'questions', 'prreview']);
    // Getting started is shown once per machine, so a later project does not start the list again.
    if (getSetting(made, 'gettingStarted') === null) writeSetting(made, 'gettingStarted', []);
    // Set up the project starts empty, which is what lets Learn your repositories hold the first run back.
    writeSetting(made, 'setupSteps', {});
  } else if (later) {
    // Refused before its folder was made, so the new project holds nothing and goes again.
    forgetProject(projectOf(made)!.project.id);
    dropProject(made);
  }
  return workspace.ok ? { db: made } : { problem: workspace.reason };
}

// Make the project opens the first task, step 2 of 2. A project needs a repository,
// so one whose clones are all still running waits for the first. The card keys come from the project
// name here, so the first task screen shows the keys its cards get; a prefix another project counts
// with is refused, and the stored one stays.
export function finishNewProject(db: DatabaseSync): string | null {
  const made = projectInProgress(db);
  if (made === null) return 'There is no new project to make yet. Add a repository first.';
  if (made.repos.length === 0) return 'A project needs at least one repository. Add one, or wait until its clone is done.';
  storeTickets(db, proposePrefix(made.name));
  return null;
}

// What the first task screen shows: the project being made, its card keys and the engine its cards
// run on. Null when no project waits for its first task.
export interface FirstTask {
  made: NewProject;
  // The key prefix, which the banner changes in place, the key Make card gives, and the three after the counter.
  prefix: string;
  key: string;
  keys: string[];
  // The preset by the name Settings, Models gives it, such as Balanced.
  runsOn: { label: string; preset: string };
}

export function firstTask(db: DatabaseSync, home: string = homedir()): FirstTask | null {
  const made = projectInProgress(db, home);
  if (made === null || made.repos.length === 0) return null;
  const prefix = getSetting(db, 'localKeyPrefix');
  const next = peekLocalKey(db, 1, prefix);
  return {
    made,
    prefix,
    key: next.key,
    keys: nextKeys(prefix, next.n),
    runsOn: { label: projectProfiles(db)[0]?.label ?? 'Claude Code', preset: presetLabel(getSetting(db, 'modelPreset')) },
  };
}

// The read-only Research card the chip under the task box makes. It is a question, whose Research
// column runs the research phase, which only reads.
export const RESEARCH_TASK = 'What does this project do?';

/**
 * Make card on the first task screen: the first card of the project being made, in the inbox of its
 * board. It starts nothing, because a run starts only when the person drags the card. It ends the
 * first run (`endFirstRun`).
 *
 * `board` is delivery for Make card, questions for Ask about the project and epics for "Plan a bigger
 * feature".
 */
export async function makeFirstCard(db: DatabaseSync, answer: { task: string; board: string }): Promise<{ key: string; board: BoardKind } | { problem: string }> {
  const made = projectInProgress(db);
  if (made === null) return { problem: 'No new project is waiting for its first card. Add the next card on the board.' };
  if (made.repos.length === 0) return { problem: 'A project needs at least one repository. Add one on New project first.' };
  const board: BoardKind = answer.board === 'questions' || answer.board === 'epics' ? answer.board : 'delivery';
  const task = board === 'questions' ? RESEARCH_TASK : answer.task.trim();
  if (task === '') return { problem: 'Type the first task. It becomes the first card.' };
  // The person picked a Research card, so its board is on, whatever a new project starts with.
  if (board === 'questions') writeSetting(db, 'offBoards', getSetting(db, 'offBoards').filter((one) => one !== 'questions'));
  // `input` stays empty, as on the idea page: a task of one key-shaped word would be read as a ticket key.
  const [first = '', ...rest] = task.split('\n');
  const card = await createCardFrom(db, {}, { input: '', title: first.trim(), description: rest.join('\n').trim(), board });
  endFirstRun(db);
  return { key: card.key, board };
}

// The first card ends the first run of a project New project made, wherever it is made, and so does
// Skip on the first task screen. The project files are there since the workspace was made.
export function endFirstRun(db: DatabaseSync): void {
  if (projectInProgress(db) !== null) writeSetting(db, 'onboarding', { done: true });
}

// A repository found one level down in ~/code, ~/projects or ~/src, with the URL Add clones from:
// origin first, else the first remote. Null when it has no remote.
export interface MachineRepo {
  path: string;
  url: string | null;
}

export async function machineRepos(home: string = homedir(), env: Env = process.env): Promise<MachineRepo[]> {
  const plain = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const found = await scanMachine(home, { env: plain });
  return found.map((repo) => ({ path: `~/${repo.path}`, url: (repo.remotes.find((remote) => remote.name === 'origin') ?? repo.remotes[0])?.url ?? null }));
}

export interface GhLogin {
  found: boolean;
  signedIn: boolean;
  account: string | null;
}

// Whether `gh` is there and signed in, for the "This machine" column. Its lines name a masked token
// too, so only the account name is read out of them.
export async function ghLogin(run: RunCommand = runVersion({ ...process.env, PATH: loginShellPath(process.env) })): Promise<GhLogin> {
  const answer = await run('gh', ['auth', 'status']);
  if (answer.missing === true) return { found: false, signedIn: false, account: null };
  if (answer.code !== 0) return { found: true, signedIn: false, account: null };
  const account = /Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/.exec(`${answer.stdout}\n${answer.stderr ?? ''}`)?.[1] ?? null;
  return { found: true, signedIn: true, account };
}

// What a test hands in instead of the real gh, git clone, home folder and environment.
export interface GitHubSeams {
  run?: RunGh;
  clone?: Clone;
  home?: string;
  env?: Env;
}

// The name typed, and the project's own folder, which the page fills from the name until it is typed.
type Answer = { name: string; folder: string };

// The sentence of a repository GitHub has now with no clone of it in the workspace: what is there, and
// the URL that makes the clone again.
export const madeNotCloned = (slug: string, url: string, reason: string): string =>
  // Git's own reasons often end with no full stop, and the next sentence would run on.
  `The private repository github.com/${slug} is on GitHub now, but it is not in the workspace yet. ${/[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`} Paste ${url} into the Git URL field and press Add to clone it again.`;

/**
 * Makes `owner/name` a private repository on GitHub from a repository `prepare` puts in a temp folder,
 * then clones it fresh into the workspace as a background clone.
 *
 * The checks go first and the workspace before GitHub, so a name that is taken or a workspace that
 * cannot be made leaves nothing on GitHub. Once the repository is made, every failure names it.
 */
async function toGitHub(db: DatabaseSync, answer: Answer, repo: { owner: string; name: string }, prepare: (folder: string) => Promise<string | null>, seams: GitHubSeams): Promise<{ job: CloneJob; db: DatabaseSync } | { problem: string }> {
  const { run = ghRunner(), clone = cloneRepository, env = process.env } = seams;
  const slug = `${repo.owner}/${repo.name}`;
  const project = projectInProgress(db) === null ? null : getSetting(db, 'projectPath');
  // A clone still running into the folder counts as taken too, or GitHub would get a repository
  // whose clone is then refused.
  const running = project === null ? [] : cloneJobs(project).filter((job) => job.state === 'waiting' || job.state === 'cloning');
  const taken = project === null ? [] : [...listedRepos(db).map((one) => one.path), ...running.map((job) => job.name)];
  const target = cloneTarget(`https://github.com/${slug}.git`, taken);
  const temp = await mkdtemp(join(tmpdir(), 'nolzu-github-'));
  try {
    // The name check first: a name typed with a space is a bad repository name, not a bad URL.
    const problem = (await repoNameProblem(repo.owner, repo.name, run)) ?? (target.ok ? null : target.reason) ?? (await prepare(join(temp, repo.name)));
    if (problem !== null) return { problem };
    const opened = await openNewProject(db, answer, env);
    if ('problem' in opened) return opened;
    const created = await createPrivateRepo(join(temp, repo.name), repo.owner, repo.name, env, run);
    if (!created.ok) return { problem: created.reason };
    const named = (reason: string): string => madeNotCloned(slug, created.url, reason);
    const started = startClone(opened.db, created.url, env, clone, named);
    return 'job' in started ? { ...started, db: opened.db } : { problem: named(started.problem) };
  } catch (error) {
    // A gh that is missing, signed out or too slow throws its own sentence.
    return { problem: (error as Error).message };
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/**
 * Put on GitHub: a repository found on this machine with no remote becomes a private repository of
 * the person's GitHub account, cloned fresh into the workspace.
 *
 * The push goes from a copy, because `gh repo create --source` adds `origin` to its source. The
 * person's folder is only read: no remote, no branch and no file of it changes. Only the branch it is
 * on goes up, and the others stay there alone.
 */
export async function putOnGitHub(db: DatabaseSync, answer: Answer & { path: string }, seams: GitHubSeams = {}): Promise<{ job: CloneJob; db: DatabaseSync } | { problem: string }> {
  const { run = ghRunner(), home = homedir(), env = process.env } = seams;
  // Only a folder the scan found, so a posted path cannot reach any other folder.
  const found = (await machineRepos(home, env)).find((repo) => repo.path === answer.path);
  if (found === undefined) return { problem: `${answer.path} is not a git repository found on this machine.` };
  if (found.url !== null) return { problem: `${answer.path} has a remote already. Press Add to clone it from there.` };
  let owners: Awaited<ReturnType<typeof githubOwners>>;
  try {
    owners = await githubOwners(run);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  if ('problem' in owners) return owners;
  const from = join(home, found.path.slice(2));
  return toGitHub(db, answer, { owner: owners.owners[0]!, name: basename(from) }, async (folder) => {
    const copied = await copyToPush(from, folder, env);
    return copied.ok ? null : copied.reason;
  }, { ...seams, run });
}

/**
 * A new private repository with a first commit that holds `readme`, cloned into the workspace. The
 * idea page makes its repository this way, under the owner picked in its menu.
 */
export async function newPrivateRepository(db: DatabaseSync, answer: Answer, repo: { owner: string; name: string; readme: string }, seams: GitHubSeams = {}): Promise<{ job: CloneJob; db: DatabaseSync } | { problem: string }> {
  return toGitHub(db, answer, repo, (folder) => firstCommit(folder, repo.readme, seams.env ?? process.env), seams);
}

// What the idea page sends. `decided` is "Anything already decided?", and may be empty.
export interface IdeaAnswer extends Answer {
  idea: string;
  decided: string;
  owner: string;
  repo: string;
}

/**
 * Start from an idea: a new workspace, a private repository with a first commit cloned into it, and
 * the idea as the first card in the Epics inbox, with what is decided as its extra context.
 *
 * Everything that can refuse goes before GitHub hears of it, so a refused name leaves no folder and no
 * repository. The answer waits for the clone, so the board opens on a project that has its repository.
 * Once the repository is made the card is made too, and a clone that fails says how to add it again.
 */
export async function startFromIdea(db: DatabaseSync, answer: IdeaAnswer, seams: GitHubSeams = {}): Promise<{ key: string } | { problem: string }> {
  const idea = answer.idea.trim();
  if (idea === '') return { problem: 'Type the idea first. It becomes the first card on the Epics board.' };
  if (Buffer.byteLength(answer.decided, 'utf8') > CONTEXT_LIMIT) {
    return { problem: `What is already decided is over ${CONTEXT_LIMIT / 1000} kB, which is the limit. Shorten it and press the button again.` };
  }
  const { run = ghRunner() } = seams;
  let owners: Awaited<ReturnType<typeof githubOwners>>;
  try {
    owners = await githubOwners(run);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  if ('problem' in owners) return owners;
  // The menu offers only these, so another owner came from a hand-made post.
  if (!owners.owners.includes(answer.owner)) return { problem: `${answer.owner} is not your GitHub account or one of its organisations. Pick an owner from the list.` };

  const repo = answer.repo.trim();
  const made = await newPrivateRepository(db, answer, { owner: answer.owner, name: repo, readme: `# ${repo}\n\n${idea}\n` }, { ...seams, run });
  if ('problem' in made) return made;
  // A later project has a database of its own, which is where its card goes.
  const project = made.db;

  // The card reads these for its key. `input` stays empty: an idea of one key-shaped word would
  // otherwise be read as a ticket key and refused. The board draws the title, so the rest of a
  // pasted paragraph goes on as the summary rather than being cut short.
  writeSetting(project, 'ticketSystem', 'local');
  writeSetting(project, 'localKeyPrefix', proposePrefix(basename(getSetting(project, 'projectPath') ?? answer.name)));
  const [first = '', ...rest] = idea.split('\n');
  const card = await createCardFrom(project, {}, { input: '', title: first.trim(), description: rest.join('\n').trim(), extra: answer.decided, board: 'epics' });

  const ended = await cloneEnded(made.job);
  // The idea page has no Git URL field, so the sentence says where it is.
  if (ended.state === 'failed') return { problem: `${ended.said ?? ''} Your idea is ${card.key} on the Epics board. The Git URL field is on New project, where the project waits.`.trim() };
  // The epic is the first card, so the first run ends now that its repository is there.
  const refused = finishNewProject(project);
  if (refused !== null) return { problem: refused };
  endFirstRun(project);
  return { key: card.key };
}
