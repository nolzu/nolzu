import { ENGINE_LABELS, type EngineName } from '@nolzu/protocol';

// What the engine check found, as the runner reports it. Spelled out here, because this package reads
// only the protocol.
export interface Detected {
  engine: string;
  binary: string;
  found: boolean;
  version: string | null;
  install: string;
  error: string | null;
}

export interface EngineRow extends Detected {
  label: string;
  // The state in a word, next to its dot, so it is never a colour alone.
  word: 'found' | 'not found' | 'check failed';
  tone: 'ok' | 'off' | 'bad';
  // Whether this engine runs every phase on this machine. Onboarding goes on with one of these.
  runsHere: boolean;
  note: string | null;
}

const ORDER = ['claude-code', 'cursor', 'codex'];

/**
 * The server's answer for this machine: the engines that run every phase here (`everyPhaseEngines` in
 * core, from the wall state), and why Nolzu's wall cannot start, or null where it starts. This package
 * reads only the protocol, so the rule itself stays in core and only its answer comes here.
 */
export interface EveryPhaseHere {
  engines: readonly string[];
  wallProblem: string | null;
}

// For a caller with no wall state: Claude Code and Codex run every phase with or without the wall.
const WITHOUT_WALL: EveryPhaseHere = { engines: ['claude-code', 'codex'], wallProblem: null };

export function engineRows(found: readonly Detected[], here: EveryPhaseHere = WITHOUT_WALL): EngineRow[] {
  return [...found]
    .sort((a, b) => ORDER.indexOf(a.engine) - ORDER.indexOf(b.engine))
    .map((one) => {
      const failed = one.error !== null;
      const word = !one.found ? 'not found' : failed ? 'check failed' : 'found';
      const runsHere = here.engines.includes(one.engine);
      // No command says whether an engine is logged in without touching a credential, so the first run tells.
      // Says what is true today and promises no date: a roadmap line on a screen is read as one.
      const note = word === 'found' ? 'The login is seen on the first run.' : null;
      return { ...one, label: ENGINE_LABELS[one.engine as EngineName] ?? one.engine, word, tone: word === 'found' ? 'ok' : word === 'not found' ? 'off' : 'bad', runsHere, note };
    });
}

const label = (engine: string): string => ENGINE_LABELS[engine as EngineName] ?? engine;
// "Claude Code, Cursor or Codex".
const listed = (words: readonly string[], last: string): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`);

/**
 * Why onboarding cannot go on with the engines found on the PATH, or null when one of them runs every
 * phase here. It names a found engine that cannot, what to install, and where the wall cannot start,
 * the check that failed, because making the wall start lets any engine do.
 */
export function missingEngine(found: readonly string[], here: EveryPhaseHere = WITHOUT_WALL): string | null {
  if (found.some((engine) => here.engines.includes(engine))) return null;
  const lead = found.length === 0 ? '' : `${listed(found.map(label), 'and')} cannot run every phase on this machine. `;
  const install = `Install ${listed(here.engines.map(label), 'or')} to go on`;
  return here.wallProblem === null ? `${lead}${install}.` : `${lead}${install}, or make Nolzu's wall start so any engine can: ${here.wallProblem}`;
}

// The wizard goes on once one engine that runs every phase here is there and answers. Fake mode needs none.
export function canContinue(rows: readonly EngineRow[], fake: boolean, here: EveryPhaseHere = WITHOUT_WALL): { ok: boolean; why: string | null } {
  if (fake) return { ok: true, why: null };
  const usable = rows.filter((row) => here.engines.includes(row.engine));
  if (usable.some((row) => row.word === 'found')) return { ok: true, why: null };
  const failed = usable.find((row) => row.word === 'check failed');
  if (failed !== undefined) return { ok: false, why: `${failed.label} is on this machine, but its check failed. The error is above; fix it to go on.` };
  return { ok: false, why: missingEngine(rows.filter((row) => row.word !== 'not found').map((row) => row.engine), here) };
}

// The commands the check runs, shown while it is on its way. The same binaries the runner calls.
export const CHECKS = [
  { label: 'Claude Code', command: 'claude --version' },
  { label: 'Cursor', command: 'cursor-agent --version' },
  { label: 'Codex', command: 'codex --version' },
];
