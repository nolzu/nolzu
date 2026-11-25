import { basename, isAbsolute, join, resolve } from 'node:path';
import type { WallLists } from '@nolzu/protocol';
import { CHECKOUT_WRITE_DENIED, ENGINE_WALLS, HIDDEN_FOR_EVERY_RUN, HIDDEN_HISTORY, HIDDEN_LOGINS, HIDDEN_ON, HIDDEN_SOCKET_FOLDERS, LINUX_SOCKETS } from './engine-walls.ts';

// The three lists a project adds to the fixed wall rules, checked by one function on save in
// Settings and again at spawn, so a hand-edited database can never loosen the wall. Pure: the disk
// is reached only through `real`, which resolves links through the nearest parent that exists,
// because Seatbelt matches real paths.

export type WallListName = keyof WallLists;

export interface WallPlaces {
  home: string;
  // The account's home from the system (`systemHome`), when it is another folder than HOME. A hidden
  // `~/` entry is hidden under it too, since a tool can read `~` from either.
  systemHome?: string;
  // The project folder and the git folder that holds its hooks, absolute.
  project: string;
  gitDir: string;
  // Nolzu's own data folder. A run that could write it could change Nolzu's settings for later runs.
  dataDir: string;
  // Folders a run writes or starts in: the card folder, the knowledge folder, the temp folder, the
  // checkout. A hidden path may not cover one.
  needed: readonly string[];
  real: (path: string) => string;
}

export interface WallGroup {
  id: string;
  name: string;
  // One sentence: what the group protects.
  line: string;
  paths: readonly string[];
}

const rows = Object.values(ENGINE_WALLS);
const LOGINS = rows.flatMap((row) => row.logins);
const CONFIGS = rows.flatMap((row) => row.writeDenied);

/**
 * What Settings, Wall shows, read-only: the fixed rules in groups, one line each with the paths
 * folded inside. Built from the same rows the wall is built from, so the page cannot drift from it.
 * Paths are the ones of this system, since the browser profiles and the Linux sockets differ.
 */
export function wallGroups(system: NodeJS.Platform): WallGroup[] {
  const linux = system === 'linux';
  return [
    { id: 'logins', name: 'Keys and cloud logins', line: 'Your SSH and GPG keys, cloud logins and the passwords tools keep stay out of reach of every run.', paths: HIDDEN_LOGINS },
    { id: 'env', name: '.env files', line: 'The .env files in the project are hidden from every run. Add an exception on Settings, Project for one your tests need.', paths: ['.env', '.env.*'] },
    { id: 'history', name: 'Shell history', line: 'A token or password you typed in a shell stays out of reach.', paths: HIDDEN_HISTORY },
    {
      id: 'docker',
      name: 'Docker and Podman',
      line: linux
        ? 'No run can connect to a running Docker or Podman daemon, which could write anywhere on your machine, nor to the session bus or the X server.'
        : 'No run can connect to a running Docker or Podman daemon, which could write anywhere on your machine.',
      paths: linux ? [...HIDDEN_SOCKET_FOLDERS, ...LINUX_SOCKETS] : HIDDEN_SOCKET_FOLDERS,
    },
    { id: 'browsers', name: 'Browser profiles', line: 'Your browser profiles are hidden, with their cookies and saved passwords.', paths: HIDDEN_ON[linux ? 'linux' : 'darwin'] },
    { id: 'engine-logins', name: 'Engine logins', line: 'Each run sees only the login of the engine that runs it.', paths: LOGINS },
    {
      id: 'engine-config',
      name: 'Engine config and hook files',
      line: 'No run can change them, so no run can plant a hook there. A run can still change your own commands under Start the app through Nolzu, so read them on Settings, Project before a QA run.',
      paths: CONFIGS,
    },
    {
      id: 'checkout',
      name: 'Card checkout rules',
      line: "No run can change these in a card's checkout, Implement included, so no run can plant a hook, skill or server that starts later. Change them yourself.",
      paths: CHECKOUT_WRITE_DENIED,
    },
  ];
}

const EXAMPLE: Readonly<Record<WallListName, string>> = { hidden: '~/secrets', exceptions: '.env.test', writable: '~/.gradle' };
const ENV_FILE = /^\.env(\..+)?$/;

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`);
const SECRETS = [...HIDDEN_FOR_EVERY_RUN, ...HIDDEN_ON.darwin, ...HIDDEN_ON.linux, ...LOGINS];
const SESSIONS = rows.flatMap((row) => [...row.writable, ...row.sessionFolders, ...row.sessionFiles]);

// A typed entry as an absolute real path: `~` is the home folder, a relative path is read from the project.
function placed(entry: string, places: WallPlaces): string {
  const home = places.home;
  const path = entry === '~' ? home : entry.startsWith('~/') ? join(home, entry.slice(2)) : resolve(places.project, entry);
  return places.real(path);
}

/** The sentence that refuses one entry of one list, or null when the wall can take it. */
export function wallEntryProblem(list: WallListName, typed: string, places: WallPlaces): string | null {
  const entry = typed.trim();
  if (entry === '') return `Type a path, such as ${EXAMPLE[list]}.`;
  const home = places.real(places.home);
  const shown = (path: string) => (path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  const at = (path: string) => (path.startsWith('~/') ? places.real(join(places.home, path.slice(2))) : path);
  const project = places.real(places.project);

  if (list === 'exceptions') {
    if (entry.startsWith('~') || isAbsolute(entry)) return `Type the path from the project folder, such as .env.test. ${entry} is not one.`;
    const path = placed(entry, places);
    if (path === project || !inside(path, project)) return `${entry} is outside the project. An exception can only name a file in the project.`;
    if (!ENV_FILE.test(basename(path))) return `${entry} is not a .env file. Only .env files are hidden in the project, so only they can be exceptions.`;
    const secret = SECRETS.find((one) => inside(path, at(one)));
    return secret === undefined ? null : `${entry} is inside ${secret}, which stays hidden from every run.`;
  }

  const path = placed(entry, places);
  if (list === 'writable') {
    if (inside(home, path)) return `${entry} would open your whole home folder. Pick one cache folder, such as ~/.gradle.`;
    const git = places.real(places.gitDir);
    const touches = (folder: string) => inside(path, folder) || inside(folder, path);
    if (touches(project) || touches(git)) return `${entry} would open the project to a phase that only reads it. Pick a folder outside the project.`;
    if (touches(places.real(places.dataDir))) return `${entry} would open Nolzu's own data folder. A run could change Nolzu's settings there.`;
    // The checkout's own hook folders, such as .claude, sit inside the project, refused above.
    const config = CONFIGS.find((one) => touches(at(one)));
    if (config !== undefined) return `${entry} would open ${shown(at(config))}, an engine's config or hook file. A run could plant a hook there.`;
    const secret = SECRETS.find((one) => touches(at(one)));
    return secret === undefined ? null : `${entry} would open ${secret}, which stays hidden from every run.`;
  }

  const needed = [...places.needed.map(places.real), ...SESSIONS.map(at)].find((folder) => inside(folder, path));
  return needed === undefined ? null : `${entry} would hide ${shown(needed)}, which the run needs.`;
}

/**
 * The lists as the wall takes them: each kept entry as its real absolute path, and the sentence
 * for each entry left out, for the run log.
 */
export function checkedWallLists(lists: WallLists, places: WallPlaces): WallLists & { dropped: string[] } {
  const dropped: string[] = [];
  const keep = (list: WallListName) =>
    lists[list].flatMap((entry) => {
      const problem = wallEntryProblem(list, entry, places);
      if (problem !== null) dropped.push(problem);
      return problem === null ? [placed(entry.trim(), places)] : [];
    });
  const hidden = keep('hidden');
  // A hidden `~/` entry under the account's home as well, held to the same check there, so it never
  // hides a folder the run needs. Only the hidden list: a writable one opens no more than it names.
  const account = places.systemHome === undefined || places.systemHome === places.home ? null : { ...places, home: places.systemHome };
  const alsoHidden =
    account === null
      ? []
      : lists.hidden.flatMap((entry) => {
          if (!entry.trim().startsWith('~')) return [];
          const problem = wallEntryProblem('hidden', entry, account);
          if (problem !== null) dropped.push(problem);
          return problem === null ? [placed(entry.trim(), account)] : [];
        });
  return { hidden: [...new Set([...hidden, ...alsoHidden])], exceptions: keep('exceptions'), writable: keep('writable'), dropped };
}
