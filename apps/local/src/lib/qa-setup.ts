import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appAddress, EVERY_REPO, isFolderName, projectRepos, proposeStart, type QaApp, type QaApps, scriptPort, type StartProposal, usesPlaywright } from '@nolzu/core';
import { getSetting, reposOfCard, writeSetting } from '@nolzu/core/node';
import { checkoutPath, checkoutRoot, isPlainName, wallHere, type WallReady } from '@nolzu/runner';
import { projectName } from './app-header.ts';
import { BROWSER_NAME, browserEntry, qaHasBrowser, readMcpList, writeMcpList } from './mcp-store.ts';

/**
 * The question QA asks the first time a card that changed a repository enters it: how to get the app
 * of that repository it checks.
 *
 * The board asks it in a dialog before the move (`QaAskDialog.svelte`). The answer is the consent to
 * start QA, and it is saved for the repository, so the next card of the repository goes straight in. A
 * project of one repository asks once, as before.
 */

// What the question at the first QA read from the repositories. The Now snapshot carries it, so it
// holds plain values only.
export interface QaSetup {
  // The project's name, which the question calls the app. In a project of several repositories, the
  // repository's.
  project: string;
  // The repository the question is about, in a project of several. Null in a project of one.
  repo: string | null;
  // The start command a package.json proposes, the repository it runs in, and the folder one level down
  // in it when the repository's own package.json names none (`startIn`). Null when none does.
  dev: { command: string; repo: string; folder?: string } | null;
  // The package.json scripts of the folder the start command runs in, one `name: text` line each, so the
  // person sees what `npm run` will run. Empty with no start command.
  scripts: string;
  // Why the wall cannot start on this machine, so the app would start with no wall. Null when it can.
  unwalled: string | null;
  // The address the start script names a port for, such as localhost:5174, to start the box with.
  // Empty when it names none, because a usual port would be a guess.
  address: string;
  // The test command the agent may run, which checking the code only runs. Null when none is allowed.
  test: string | null;
  // A repository depends on Playwright or holds its config.
  playwright: boolean;
  // Google Chrome is installed, which the browser config starts. The switch shows with it or Playwright.
  chrome: boolean;
  // QA has a browser config already, so the switch starts on.
  browser: boolean;
}

// The answer for one repository: its own, or the one a project gave for every repository before answers
// were per repository.
export const answerFor = (apps: QaApps | null, repo: string): QaApp | null => apps?.[repo] ?? apps?.[EVERY_REPO] ?? null;

export type OwnApp = Extract<QaApp, { mode: 'own' }>;

/**
 * The own commands of a card, in the order they start: an answer under `*` first and once, in the card's
 * checkout root (`repo` null), as the project-wide stack hook ran, so a script written for `$PWD/api`
 * keeps working. Then each repository with an answer of its own, which wins over `*` for it.
 */
export function ownStarts(apps: QaApps | null, repos: readonly string[]): { repo: string | null; answer: OwnApp }[] {
  const shared = apps?.[EVERY_REPO];
  const once = shared?.mode === 'own' && repos.some((repo) => apps?.[repo] === undefined) ? [{ repo: null, answer: shared }] : [];
  return [
    ...once,
    ...repos.flatMap((repo) => {
      const own = apps?.[repo];
      return own?.mode === 'own' ? [{ repo, answer: own }] : [];
    }),
  ];
}

// Where own commands run: the card's copy of the repository, or its checkout root for an answer under `*`.
export const ownFolder = (project: string, key: string, repo: string | null): string => (repo === null ? checkoutRoot(project, key) : checkoutPath(project, key, repo));

// The repositories QA starts apps for: the ones the card works in. None for a card of a workspace that
// picked no repository yet.
export const qaReposOf = (db: DatabaseSync, key: string): string[] => reposOfCard(db, key) ?? [];

// The repositories still to answer for: the card's, or the project's with no card.
function unanswered(db: DatabaseSync, key: string | null): string[] {
  const apps = getSetting(db, 'qaApp');
  const repos = key !== null ? qaReposOf(db, key) : projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path);
  return repos.filter((repo) => answerFor(apps, repo) === null);
}

// The card, or with no card the whole project, has its answer for every repository it changes.
export function stackAnswered(db: DatabaseSync, key: string | null = null): boolean {
  return unanswered(db, key).length === 0;
}

// Saves or clears the answer of one repository, and keeps the others.
function saveAnswer(db: DatabaseSync, repo: string, app: QaApp | null): void {
  const apps: Record<string, QaApp> = { ...getSetting(db, 'qaApp') };
  if (app === null) delete apps[repo];
  else apps[repo] = app;
  writeSetting(db, 'qaApp', Object.keys(apps).length === 0 ? null : apps);
}

// Ask again for one repository, or for every one with `*`, from Settings, Project. The sentence it was
// refused with for a name that is not one of the project's, or null.
export function clearAnswer(db: DatabaseSync, repo: string): string | null {
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((one) => one.path);
  if (repo !== EVERY_REPO && !repos.includes(repo)) return `${repo} is not a repository of this project.`;
  saveAnswer(db, repo, null);
  return null;
}

// One row of Start the app on Settings, Project: the repository, or `*` for every one, its answer in a
// few words, and what the question shows for it, which its Edit draws.
export interface AppRow {
  repo: string;
  answer: QaApp | null;
  words: string;
  setup: QaSetup;
}

// An answer in a few words, so a project of many repositories reads one short line each.
export function appWords(app: QaApp | null): string {
  if (app === null) return 'asked at the first QA';
  if (app.mode === 'dev') return app.folder === undefined ? app.command : `${app.command} in ${app.folder}`;
  if (app.mode === 'running') return `already running at ${app.address.replace(/^https?:\/\//, '')}`;
  if (app.mode === 'own') return `own commands: ${app.start}`;
  return 'code only';
}

/**
 * The rows of Start the app: every repository, after a row for `*` in a project of several or when
 * there is an answer for every one. `*` is never asked by the question, so it is set here.
 */
export function appRows(db: DatabaseSync, chrome = chromeHere(), wall: WallReady = wallHere()): AppRow[] {
  const apps = getSetting(db, 'qaApp');
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((one) => one.path);
  const shared = apps?.[EVERY_REPO] !== undefined || repos.length > 1;
  return [...(shared ? [EVERY_REPO] : []), ...repos].map((repo) => {
    const own = apps?.[repo] ?? null;
    const words =
      own !== null ? appWords(own) : repo === EVERY_REPO ? 'not set' : apps?.[EVERY_REPO] !== undefined ? 'same as every repository' : appWords(null);
    return { repo, answer: own, words, setup: askAbout(db, null, chrome, wall, repo).setup };
  });
}

// What a move into QA is refused with while the question is open. A screen asks the question before it
// sends the move, so this reaches only a move nobody could ask on: the chain, a phone, a stale page.
export const answerFirst = (key: string): string => `QA asks how to run the app the first time a card enters it. Move ${key} to QA on the board to answer.`;
// The same for a retry of QA, such as after the scripts changed on the card's branch.
export const answerAgain = (key: string): string => `QA asks how to run the app before it runs again. Retry ${key} on the board to answer.`;

// The browser the switch sets up: the Playwright MCP server, set up the way its own README sets it
// up, with Chrome's own sandbox off, because Chrome's sandbox cannot start inside a macOS sandbox
// (scripts/measure-walls.mjs, 2026-10-22). Nolzu's wall holds the browser instead. Where the wall
// cannot start, a read-only Claude Code run goes on unwalled, and its browser then has no sandbox
// at all; that gap is accepted with the run's "Not walled" line. It is a server of the project's MCP
// list (`browserEntry`), on for QA.
//
// The wall leaves the temp folder writable and the home folder not, while npx writes its cache in
// ~/.npm and Playwright its profile and lock files under the home folder's cache, so the server gets
// a home folder of its own in the temp folder. The browser itself is the installed Google Chrome,
// which it finds without the home folder. The demo's page and many plain sites open as a file, which
// the server refuses without the file flag. Headless, so no window opens on the person's screen;
// screenshots work the same.
//
// Limit: npx fetches the newest release on the first QA run with a browser. Pin a version here once
// one is measured with QA.
//
// An older Nolzu wrote it into this file in the data folder and kept the path in a setting, which
// `migrateQaBrowser` moves into the list once.
export const PLAYWRIGHT_FILE = 'playwright-mcp.json';

// Where Playwright's `chrome` channel looks for Google Chrome, which the server above starts.
export function chromeFound(platform: string, exists: (path: string) => boolean, home = homedir()): boolean {
  if (platform === 'darwin') {
    const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return exists(app) || exists(join(home, app));
  }
  return platform === 'linux' && exists('/opt/google/chrome/chrome');
}

const chromeHere = (): boolean => chromeFound(process.platform, existsSync);

// Nolzu's own browser in the project's list, on for QA. A server of that name already there keeps
// what the person changed in it and only gets QA turned on. The sentence it was refused with, or null.
export function setUpBrowser(project: string | null): string | null {
  const { servers } = readMcpList(project);
  const found = servers.find((entry) => entry.name === BROWSER_NAME);
  if (found?.phases.includes('qa')) return null;
  const next = found === undefined ? [...servers, browserEntry()] : servers.map((entry) => (entry === found ? { ...entry, phases: [...entry.phases, 'qa'] } : entry));
  return writeMcpList(project, next);
}

// QA without the browser: Nolzu's browser server is turned off for QA and stays in the list, and a QA
// browser path of the old setting not moved yet is cleared, so off works before the move too. Every
// other server keeps its QA box, since it is no browser.
export function turnOffBrowser(db: DatabaseSync): string | null {
  writeSetting(db, 'qaMcpConfigPath', null);
  const project = getSetting(db, 'projectPath');
  const { servers } = readMcpList(project);
  const found = servers.find((entry) => entry.name === BROWSER_NAME);
  if (!found?.phases.includes('qa')) return null;
  return writeMcpList(project, servers.map((entry) => (entry === found ? { ...entry, phases: entry.phases.filter((phase) => phase !== 'qa') } : entry)));
}

const manifestIn = (folder: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  } catch {
    // No package.json, or one that does not parse. The question then offers no command.
    return null;
  }
};

// The folder names a start command is looked for in first, one folder down, best first.
const START_FOLDERS = ['frontend', 'web', 'client', 'app'];

/**
 * The start command a folder proposes, from its own package.json, else from the first child folder whose
 * package.json names one: frontend, web, client and app first, then the rest by name. node_modules and
 * dot folders are skipped. `sub` is that child, or null for the folder itself.
 */
export function startIn(folder: string): { proposal: StartProposal; scripts: Record<string, string>; sub: string | null } | null {
  const at = (sub: string | null) => {
    const scripts = scriptsOf(manifestIn(sub === null ? folder : join(folder, sub)));
    const proposal = proposeStart(scripts);
    return proposal === null || scripts === null ? null : { proposal, scripts, sub };
  };
  const top = at(null);
  if (top !== null) return top;
  let children: string[] = [];
  try {
    children = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.') && isFolderName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A folder that is gone proposes nothing.
  }
  const ordered = [...START_FOLDERS.filter((name) => children.includes(name)), ...children.filter((name) => !START_FOLDERS.includes(name))];
  for (const sub of ordered) {
    const found = at(sub);
    if (found !== null) return found;
  }
  return null;
}

const filesIn = (folder: string): string[] => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};

const scriptsOf = (manifest: unknown): Record<string, string> | null => {
  const scripts = typeof manifest === 'object' && manifest !== null ? (manifest as { scripts?: unknown }).scripts : null;
  return typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, string>) : null;
};

// The scripts block as the dialog shows it, one `name: text` line each.
const scriptsText = (folder: string): string =>
  Object.entries(scriptsOf(manifestIn(folder)) ?? {})
    .map(([name, text]) => `${name}: ${typeof text === 'string' ? text : JSON.stringify(text)}`)
    .join('\n');

// The hash of the scripts text the person saw, so a change on the card's branch asks again.
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export function scriptsHash(folder: string): string {
  return hashOf(scriptsText(folder));
}

/**
 * The folder the question reads the scripts in: the card's copy of the repository, or the project's own
 * clone before the card has a copy. QA starts the app in the card's copy only.
 */
export function appFolder(project: string, key: string | null, repo: string): string {
  const copy = key === null ? null : checkoutPath(project, key, repo);
  return copy !== null && existsSync(copy) ? copy : join(project, repo);
}

/**
 * Null when the scripts in `folder` are the ones the person said yes to. Otherwise the answer is cleared,
 * so the next move into QA asks the question again with the new script text, and the sentence the QA
 * run stops with is returned. An answer saved before the hash existed asks again too.
 */
export function scriptsChanged(db: DatabaseSync, app: Extract<QaApp, { mode: 'dev' }>, folder: string, key: string): string | null {
  if (app.scripts === scriptsHash(folder)) return null;
  saveAnswer(db, app.repo, null);
  return `The package.json scripts on ${key}'s branch are not the ones you said yes to, so Nolzu did not run ${app.command}. Retry QA to see the new scripts and answer the question again.`;
}

/**
 * What the question shows, read from the repository it asks about each time it is asked: the card's
 * first repository with no answer, or the project's with no card.
 *
 * With a card, its copy is read as well, because a card can be the one that makes the app: its
 * package.json exists on its branch only. A start command there counts only when the project folder
 * names none; Playwright counts from either. The command runs in the card's copy either way, so a later
 * card runs it once the branch is merged.
 */
export function qaSetupFor(db: DatabaseSync, key: string | null = null, chrome = chromeHere(), wall: WallReady = wallHere()): QaSetup {
  return askAbout(db, key, chrome, wall).setup;
}

// `about` names the repository, or `*`, for the Edit of Settings, Project. It counts only when it is one of
// the project's, so a post cannot point the read at another folder.
function askAbout(db: DatabaseSync, key: string | null, chrome: boolean, wall: WallReady, about: string | null = null): { setup: QaSetup; repo: string } {
  const project = getSetting(db, 'projectPath');
  const repos = project === null ? [] : projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  // Only a card on the board with a plain key, so a key from a post cannot point the read at another folder.
  const card = project !== null && key !== null && isPlainName(key) && db.prepare('SELECT 1 FROM cards WHERE key = ?').get(key) !== undefined ? key : null;
  const named = about !== null && (about === EVERY_REPO || repos.some((one) => one.path === about)) ? about : null;
  const repo = named ?? unanswered(db, card)[0] ?? (card === null ? undefined : qaReposOf(db, card)[0]) ?? repos[0]?.path ?? '.';
  let dev: QaSetup['dev'] = null;
  let address = '';
  let playwright = false;
  // The project folder first, so a command from the card's copy counts only when it names none.
  // The answer for every repository has no folder of its own, so it proposes no start command.
  for (const folder of repo === EVERY_REPO ? [] : [join(project ?? '', repo), ...(card === null ? [] : [checkoutPath(project ?? '', card, repo)])]) {
    const found: ReturnType<typeof startIn> = dev === null ? startIn(folder) : null;
    if (found !== null) {
      dev = { command: found.proposal.command, repo, ...(found.sub === null ? {} : { folder: found.sub }) };
      const port = scriptPort(found.scripts[found.proposal.from]);
      address = port === null ? '' : `localhost:${port}`;
    }
    playwright ||= usesPlaywright(manifestIn(folder), filesIn(folder));
  }
  const several = repos.length > 1;
  const setup = {
    project: several ? repo : (projectName(db) ?? 'the app'),
    repo: several ? repo : null,
    dev,
    scripts: dev === null || project === null ? '' : scriptsText(join(appFolder(project, card, repo), dev.folder ?? '')),
    unwalled: wall.ready ? null : wall.reason,
    address,
    // The test command the agent may run, because that is what QA runs.
    test: (getSetting(db, 'allowedCommands') ?? []).find((command) => / test$/.test(command)) ?? null,
    playwright,
    chrome,
    browser: qaHasBrowser(db),
  };
  return { setup, repo };
}

/**
 * Start QA in the question: the answer saved for the repository, or the sentence it was refused with.
 *
 * The command is read here again and never taken from the page, so a post can only pick what the
 * repositories propose. The browser switch counts only where Chrome or Playwright is found, as the
 * dialog draws it, and it keeps a browser config the person set up before.
 */
export function answerQa(db: DatabaseSync, asked: unknown, chrome = chromeHere()): string | null {
  const body = (typeof asked === 'object' && asked !== null ? asked : {}) as { key?: unknown; repo?: unknown; choice?: unknown; address?: unknown; browser?: unknown; scripts?: unknown; start?: unknown; stop?: unknown; status?: unknown };
  const about = typeof body.repo === 'string' ? body.repo : null;
  const { setup, repo } = askAbout(db, typeof body.key === 'string' ? body.key : null, chrome, wallHere(), about);
  if (about !== null && about !== repo) return `${about} is not a repository of this project.`;
  let app: QaApp;
  if (body.choice === 'dev') {
    if (setup.dev === null) return 'No package.json of this project names a start script, so Nolzu has nothing to start. Pick another way.';
    // Start QA is the yes to the scripts the dialog showed, so a block that changed since it opened is
    // shown first. The hash is of that text, read from the folder the app starts in.
    if ((body.scripts ?? '') !== setup.scripts) return 'The package.json scripts changed since this question opened. Read the new ones and pick again.';
    app = { mode: 'dev', ...setup.dev, scripts: hashOf(setup.scripts) };
  } else if (body.choice === 'running') {
    const address = typeof body.address === 'string' ? appAddress(body.address) : null;
    if (address === null) return 'Type the address the app runs at, such as localhost:5173.';
    app = { mode: 'running', address };
  } else if (body.choice === 'own') {
    const typed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    if (typed(body.start) === '') return 'Type the command that starts the app in the Start box.';
    app = { mode: 'own', start: typed(body.start), stop: typed(body.stop) || null, status: typed(body.status) || null };
  } else if (body.choice === 'code') {
    app = { mode: 'code' };
  } else {
    return 'Pick how QA gets the app: start it, start it with your own commands, use the one already running, or check the code only.';
  }

  if (typeof body.browser === 'boolean' && (setup.chrome || setup.playwright)) {
    const project = getSetting(db, 'projectPath');
    const problem = !body.browser ? turnOffBrowser(db) : setup.browser ? null : setUpBrowser(project);
    if (problem !== null) return problem;
  }
  saveAnswer(db, repo, app);
  return null;
}
