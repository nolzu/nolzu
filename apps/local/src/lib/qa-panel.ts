import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { projectRepos } from '@nolzu/core';
import { cardStack, getSetting, reposOfCard } from '@nolzu/core/node';
import { isStackState, type BoardSnapshot, type RunState, type Verdict } from '@nolzu/protocol';
import { isPlainName, readCardFile, runStackHook, STACK_STATUS_TIMEOUT_MS, stackEnv } from '@nolzu/runner';
import { type QaInput, qaView, type QaView } from '@nolzu/ui/qa';
import { cardFolder, filesFor } from './files.ts';
import { qaHasBrowser } from './mcp-store.ts';
import { type OwnApp, ownFolder, ownStarts } from './qa-setup.ts';

/**
 * What the two QA panels of the ticket page read, from the database, the project and the card folder.
 *
 * The rules are in `@nolzu/ui/qa`; this file only gathers. The Status commands run here, on the page
 * load, because a panel that says what the app reports has to ask it. Their output is carried through
 * untouched: Nolzu never knows what the app is.
 */

// The card the stack lane holds, from the board snapshot. That is the one source of busy state, so
// the panel never guesses it from a run row or a click.
export const stackLane = (snapshot: Pick<BoardSnapshot, 'lanes'>): string | null =>
  snapshot.lanes.find((lane) => lane.name === 'stack')?.heldBy ?? null;

// The caller's environment plus the card's stack variables. A card whose repositories are not
// known yet gets an empty list, because naming the root there could name a folder with no checkout.
export const cardStackEnv = (db: DatabaseSync, key: string, env: Record<string, string | undefined>): Record<string, string | undefined> => ({
  ...env,
  ...stackEnv(key, getSetting(db, 'projectPath') ?? '', reposOfCard(db, key) ?? []),
});

export interface CardOwn {
  // The repository, or null for an answer under `*`, which runs once in the card's checkout root.
  repo: string | null;
  // What the line calls it: the repository in a project of several, else `app`.
  name: string;
  // The folder it runs in, or null with no project folder or a key that is not a plain name.
  at: string | null;
  answer: OwnApp;
}

/** The card's own commands under Start the app, in the order QA and Start run them. */
export function cardOwn(db: DatabaseSync, key: string): CardOwn[] {
  const project = getSetting(db, 'projectPath');
  const several = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).length > 1;
  return ownStarts(getSetting(db, 'qaApp'), reposOfCard(db, key) ?? []).map(({ repo, answer }) => ({
    repo,
    name: repo === null ? (several ? 'every repository' : 'app') : several ? repo : 'app',
    at: project === null || !isPlainName(key) ? null : ownFolder(project, key, repo),
    answer,
  }));
}

/** Why the card's own commands have nowhere to run, or null when every folder is there. */
export function ownProblem(owns: readonly CardOwn[], what: string): string | null {
  if (owns.some((own) => own.at === null)) return `There is no project folder set, so ${what} has nowhere to run.`;
  if (owns.some((own) => own.at !== null && !existsSync(own.at))) {
    return `This card has no checkout, so ${what} has nowhere to run. A run makes one. A closed card has none once its checkouts are removed.`;
  }
  return null;
}

export interface QaPanelOptions {
  busy?: string | null;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  // Injected by the tests that must not wait half a minute for a command that hangs.
  timeoutMs?: number;
}

interface RunRow {
  id: number;
  state: RunState | null;
  verdict: Verdict | null;
  verdict_reason: string | null;
}

export type StackStatus = Pick<QaInput, 'status' | 'statusProblem'>;

/**
 * What the card's Status commands say, or why they did not run. The one slow part of the panels,
 * because each runs a command the person wrote, so the card page streams it. With several, they run
 * at once and their output reads as one block, each part under its name.
 */
export async function stackStatusFor(db: DatabaseSync, key: string, options: QaPanelOptions = {}): Promise<StackStatus> {
  const env = options.env ?? process.env;
  const owns = cardOwn(db, key).filter((own) => own.answer.status !== null);
  if (owns.length === 0) return { status: null, statusProblem: null };
  const problem = ownProblem(owns, 'the Status command');
  if (problem !== null) return { status: null, statusProblem: problem };
  try {
    const results = await Promise.all(
      owns.map((own) =>
        runStackHook({ load: null, unload: null, status: own.answer.status }, 'status', key, {
          cwd: own.at ?? '',
          env: cardStackEnv(db, key, env),
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? STACK_STATUS_TIMEOUT_MS,
        }),
      ),
    );
    const ran = results.flatMap((result, index) => (result === null ? [] : [{ ...result, name: owns[index]?.name ?? '' }]));
    const one = ran.length === 1 ? ran[0] : undefined;
    return {
      status:
        ran.length === 0
          ? null
          : {
              command: ran.map((result) => result.command).join('\n'),
              code: ran.find((result) => result.code !== 0)?.code ?? 0,
              output: one !== undefined ? `${one.stdout}${one.stderr}` : ran.map((result) => `${result.name}\n${result.stdout}${result.stderr}`.trim()).join('\n\n'),
              timedOut: ran.some((result) => result.timedOut),
            },
      statusProblem: null,
    };
  } catch (error) {
    return { status: null, statusProblem: `The Status command could not run: ${(error as Error).message}` };
  }
}

/**
 * Everything the panels read but the Status commands: the database and the card folder, so the page
 * draws it at once. With no status, the app line says the command has not run yet.
 */
export function qaInputFor(db: DatabaseSync, key: string, options: Pick<QaPanelOptions, 'busy' | 'env'> = {}): QaInput {
  const env = options.env ?? process.env;
  const owns = cardOwn(db, key);
  // The newest QA run of this card. A card checked twice keeps both rows, and the panel is about
  // the last check.
  const run = db
    .prepare("SELECT id, state, verdict, verdict_reason FROM runs WHERE card_key = ? AND phase = 'qa' ORDER BY id DESC LIMIT 1")
    .get(key) as RunRow | undefined;

  // The card folder, where a QA run writes its report and its screenshots.
  const qaFiles = filesFor(db, key, env).find((group) => group.folder === 'qa')?.files ?? [];
  // A word outside the five is a hand edited row. It reads as nothing stored, so the panel says
  // off rather than printing a word nobody wrote.
  const stored = cardStack(db, key);
  const stack = stored !== null && isStackState(stored.state) ? { state: stored.state, reason: stored.reason } : null;
  // The report's text for its checklist, read the way the Files tab reads it, so the cap and the link
  // check hold.
  const report = qaFiles.find((file) => file.path === 'qa/report.md')?.path ?? null;
  const folder = cardFolder(db, key, env);
  const read = folder === null || report === null ? null : readCardFile(folder, report);

  return {
    cardKey: key,
    run: run === undefined ? null : { id: run.id, state: run.state, verdict: run.verdict, verdictReason: run.verdict_reason },
    stack,
    // Stop has something to do for every own start: the process Start left running, and the Stop command.
    hasLoad: owns.length > 0,
    hasUnload: owns.length > 0,
    hasStatus: owns.some((own) => own.answer.status !== null),
    status: null,
    statusProblem: null,
    stackLane: options.busy ?? null,
    report,
    reportText: read?.ok ? read.bytes.toString('utf8') : null,
    screenshots: qaFiles.filter((file) => file.kind === 'image').map((file) => ({ path: file.path, name: file.name })),
    hasBrowser: qaHasBrowser(db),
    loadCommand: owns.length === 1 ? (owns[0]?.answer.start ?? null) : null,
    apps: owns.map((own) => ({ name: own.name, start: own.answer.start })),
  };
}

// The panels with the Status commands' answer, in one wait.
export async function qaPanelFor(db: DatabaseSync, key: string, options: QaPanelOptions = {}): Promise<QaView> {
  return qaView({ ...qaInputFor(db, key, options), ...(await stackStatusFor(db, key, options)) });
}
