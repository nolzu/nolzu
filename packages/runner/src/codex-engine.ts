import type { EngineProfile } from '@nolzu/protocol';
import { codexModels } from './codex-models.ts';
import { parseCodexLine } from './codex.ts';
import { type Engine, withSentinels } from './engine.ts';
import { spawnCodex } from './spawn.ts';

/**
 * The Codex CLI engine.
 *
 * The same shape as the Claude one: `binary` is looked up on the PATH in `env`, which is the login
 * shell's, and the run's own profile is looked up from `job.engine` so a resume lands on the login
 * that holds the session. A Codex session lives under `CODEX_HOME`, so a resume under another
 * profile would find nothing to continue.
 *
 * The model list comes from the binary itself and answers offline, so it is read rather than kept
 * by hand.
 */
export function codexEngine(binary: string, env: Record<string, string | undefined>, profiles: readonly EngineProfile[] = []): Engine {
  const profileFor = (id: string): EngineProfile | null => {
    const found = profiles.find((one) => one.id === id);
    if (found === undefined) return null;
    if (found.vendor !== 'codex') {
      throw new Error(`The run names the engine profile ${id}, which is a ${found.vendor} login, and this engine spawns ${binary}.`);
    }
    return found;
  };
  return {
    name: 'codex',
    vendor: 'codex',
    spawn: (job, signal) => spawnCodex(binary, job, signal, { env, profile: profileFor(job.engine) }),
    parse: (line) => withSentinels(parseCodexLine(line)),
    listModels: () => codexModels(binary, env),
  };
}
