import { type EngineProfile, isFakeMode, type RunEvent } from '@nolzu/protocol';
import { parseClaudeLine } from './claude.ts';
import { claudeEngine } from './claude-engine.ts';
import { codexWarning, parseCodexLine } from './codex.ts';
import { codexEngine } from './codex-engine.ts';
import { parseCursorLine } from './cursor.ts';
import { cursorEngine } from './cursor-engine.ts';
import { type Engine, withSentinels } from './engine.ts';
import { fakeEngine } from './fake.ts';
import { runLogNote, runLogRetry, runLogTime } from './log.ts';
import { shellPath } from './shell-env.ts';

// The engines this version can run, by the vendor name an engine profile holds.
export const ENGINES = ['claude-code', 'cursor', 'codex'] as const;

// The binary each one is looked up as on the login shell's PATH.
const BINARY: Record<(typeof ENGINES)[number], string> = { 'claude-code': 'claude', cursor: 'cursor-agent', codex: 'codex' };

export interface SelectOptions {
  // The vendor to spawn, which comes off the profile a row names. Fake mode wins over it, so a
  // stored profile never starts a real run inside a test or a demo.
  engine?: string;
  // The PATH the engine is found on and runs with. Injected, so a test starts no login shell.
  path?: () => string;
  // Every login this machine holds. The adapter looks a run's own profile up from `job.engine`.
  profiles?: readonly EngineProfile[];
}

// The login shell's PATH, asked for once per process. The shell can take seconds to answer, and a
// loop that fails to build is built again on the next request.
let loginPath: string | null = null;
// The PATH the person's login shell sets, read once. Detection and the engine both use it, so a tool the
// shell finds is a tool Nolzu finds.
export const loginShellPath = (env: Record<string, string | undefined>): string => (loginPath ??= shellPath(env));
const askLoginShell = loginShellPath;

export function selectEngine(env: Record<string, string | undefined>, options: SelectOptions = {}): Engine {
  if (isFakeMode(env)) {
    // 0 makes tests instant, and a value above 1 slows a demo down. A typo stops here, so it
    // never turns a slow demo into an instant one.
    const scale = env.NOLZU_FAKE_DELAY_SCALE ?? '1';
    if (!/^\d+(\.\d+)?$/.test(scale)) {
      throw new Error(`NOLZU_FAKE_DELAY_SCALE must be a number of 0 or more, got "${scale}".`);
    }
    // Read here alone, so a walk in fake mode can reach a QA FAIL and a question, and nothing outside
    // fake mode ever sees them.
    return fakeEngine(Number(scale), { qaFailsFirst: env.NOLZU_FAKE_QA_FAIL === '1', planAsks: env.NOLZU_FAKE_PLAN_ASKS === '1', triageBroken: env.NOLZU_FAKE_TRIAGE_BROKEN === '1', fixAsks: env.NOLZU_FAKE_FIX_ASKS === '1' });
  }

  const name = options.engine ?? 'claude-code';
  if (!(ENGINES as readonly string[]).includes(name)) {
    throw new Error(`Nolzu cannot run ${JSON.stringify(name)} yet, so no engine profile of it can start a run. The engines it runs are: ${ENGINES.join(', ')}.`);
  }

  // A process started outside a login shell misses the PATH of the person's shell profile, and with it
  // the engine and every tool an agent runs. The spawn looks the binary up on the PATH of the
  // environment it is given, which is this one.
  const path = options.path === undefined ? askLoginShell(env) : options.path();
  const engineEnv = { ...env, PATH: path };
  const binary = BINARY[name as (typeof ENGINES)[number]];
  // A binary that is not found is not an error here. The run fails with the install hint instead,
  // and the app still starts, so the board and the settings stay reachable.
  const profiles = options.profiles ?? [];
  if (name === 'codex') return codexEngine(binary, engineEnv, profiles);
  if (name === 'cursor') return cursorEngine(binary, engineEnv, profiles);
  return claudeEngine(binary, engineEnv, profiles);
}

/**
 * The parser for a stored run log, chosen by the profile the run recorded.
 *
 * Not by the profile the action table names now: a Codex log opened after the row went back to a
 * Claude Code profile would fall through the Claude parser line by line and the log tab would show
 * nothing. A profile id carries its vendor in front of `#`, which is what `profileId` builds, so the
 * vendor is read off the run row. A run of the fake engine replays Claude Code's own lines, so it
 * reads with that parser too.
 */
export function parseRunLine(line: string, profile: string): RunEvent[] {
  const note = runLogNote(line);
  if (note !== null) return [{ type: 'text', text: note }];
  // A wait Nolzu held, which no engine printed.
  const wait = runLogRetry(line);
  if (wait !== null) return [wait];
  // A time the runner noted is no event. The log route reads it apart, for the time column.
  if (runLogTime(line) !== null) return [];
  const vendor = profile.split('#')[0];
  if (vendor === 'codex') {
    const warning = codexWarning(line);
    return warning === null ? withSentinels(parseCodexLine(line)) : [{ type: 'text', text: warning }];
  }
  if (vendor === 'cursor') return withSentinels(parseCursorLine(line));
  return withSentinels(parseClaudeLine(line));
}
