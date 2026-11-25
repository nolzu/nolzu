// The first run, as pure functions, so the Svelte files stay thin and every rule has a test. The
// answers themselves are ordinary settings; only whether the first run ended lives here.

import { BOARD_LABELS, RESEARCH_KINDS, RESEARCH_PREFIXES } from '@nolzu/protocol';

export interface Progress {
  // The project New project made has its first card, so its first run is over.
  done: boolean;
}

export const START: Progress = { done: false };

// A machine with no project yet goes to New project, whatever an earlier first run left behind,
// because no other screen has anything to show. A project set by hand, or by the demo setup, stays.
export function needsOnboarding(settings: { projectPath: string | null; onboarding: Progress }): boolean {
  return settings.projectPath === null;
}

// The old wizard stored its step and skipped steps beside the flag. Only the flag is read, so a
// machine that ran it keeps its answer.
export function validateProgress(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'The first run progress is whether New project is done.';
  if (typeof (value as Record<string, unknown>).done !== 'boolean') return 'Whether New project is done is yes or no.';
  return null;
}

// A prefix from the folder name: its last word, cut to four letters when it is longer than six, else a
// neutral PROJ. The person can change it; this only saves typing the obvious one.
export function proposePrefix(folder: string): string {
  const last = folder.split(/[^A-Za-z]+/).filter((word) => word.length >= 2).at(-1)?.toUpperCase();
  if (last === undefined) return 'PROJ';
  const proposed = last.length <= 6 ? last : last.slice(0, 4);
  return researchKindOf(proposed) === undefined ? proposed : 'PROJ';
}

// The Research kind that numbers its cards under this prefix, if one does.
const researchKindOf = (prefix: string) => RESEARCH_KINDS.find((kind) => RESEARCH_PREFIXES[kind] === prefix);

// The key the next card gets, after the numbers the counter has already given.
export function nextKey(prefix: string, given: number): string {
  return `${prefix}-${given + 1}`;
}

// Why a prefix cannot be used, or null. One another project counts with would hand out keys that are
// taken; the prefix this project has already is fine.
export function prefixProblem(prefix: string, used: readonly string[], current: string | null): string | null {
  if (!/^[A-Z]{2,6}$/.test(prefix)) return 'The key prefix is two to six capital letters, such as APP.';
  // Before the current prefix is let through: one stored before Research had prefixes may be one now.
  const kind = researchKindOf(prefix);
  if (kind !== undefined) return `${prefix} is the key prefix of ${BOARD_LABELS[kind]} on Research. Pick another prefix.`;
  if (prefix !== current && used.includes(prefix)) return `${prefix} is in use by another project's tickets. Pick another prefix.`;
  return null;
}

/**
 * The start command proposed from a repository's own `package.json` scripts, for the question at the
 * first QA.
 *
 * Nolzu never knows how an app starts, so this only saves typing the obvious one: a script whose name
 * says it starts something. A repository whose scripts say nothing is offered nothing rather than a
 * guess that would run the wrong thing.
 */
export interface StartProposal {
  command: string;
  // Which script it came from, so the question can read the port that script names.
  from: string;
}

// The script names that start an app, best first. `dev` beats `start` because a project that has
// both means `dev` for local work, which is what a card's checkout is.
export const START_SCRIPTS: readonly string[] = ['dev', 'start', 'serve', 'up'];

export function proposeStart(scripts: Readonly<Record<string, string>> | null | undefined): StartProposal | null {
  if (scripts === null || scripts === undefined) return null;
  const names = Object.keys(scripts);
  const start = START_SCRIPTS.find((name) => names.includes(name));
  return start === undefined ? null : { command: `npm run ${start}`, from: start };
}

/**
 * The address of an app a person started, as QA checks against it, or null for anything that is not
 * one http or https address. A bare `localhost:5173` gets `http://` in front, because that is how
 * people write the address of their own dev server.
 */
export function appAddress(typed: string): string | null {
  const text = typed.trim();
  if (text === '' || /\s/.test(text)) return null;
  // Without `://`, `localhost:5173` would parse as a scheme named localhost.
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(full);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? full : null;
  } catch {
    return null;
  }
}

// The packages that mean a project runs Playwright, so a browser for QA has something to build on.
const PLAYWRIGHT_PACKAGES = ['playwright', '@playwright/test', '@playwright/mcp'];

/**
 * Whether one repository uses Playwright: a dependency in its `package.json`, or a Playwright config
 * file at its top. A script that only names it proves nothing, because the package may not be there.
 */
export function usesPlaywright(manifest: unknown, files: readonly string[]): boolean {
  if (files.some((file) => /^playwright\.config\.[cm]?[jt]s$/.test(file))) return true;
  if (typeof manifest !== 'object' || manifest === null) return false;
  return ['dependencies', 'devDependencies'].some((field) => {
    const listed = (manifest as Record<string, unknown>)[field];
    return typeof listed === 'object' && listed !== null && PLAYWRIGHT_PACKAGES.some((name) => Object.hasOwn(listed, name));
  });
}

// The port a start script names with `--port` or `-p`, or null. Only what the script says: a
// framework's usual port would be a guess.
export function scriptPort(script: string | undefined): number | null {
  const found = /(?:^|\s)(?:--port[=\s]|-p\s)\s*(\d{2,5})\b/.exec(script ?? '');
  return found === null ? null : Number(found[1]);
}
