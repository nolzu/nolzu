import type { EngineProfile } from '@nolzu/protocol';
import { parseCursorLine } from './cursor.ts';
import { cursorModels } from './cursor-models.ts';
import { type Engine, withSentinels } from './engine.ts';
import { spawnCursor } from './spawn.ts';

/**
 * The Cursor CLI engine.
 *
 * The same shape as the Claude and Codex ones: `binary` is looked up on the PATH in `env`, which is
 * the login shell's, and the run's own profile is looked up from `job.engine` so a resume lands on
 * the login that holds the session. A Cursor session lives under `CURSOR_CONFIG_DIR`, so a resume
 * under another profile would find nothing to continue.
 *
 * The model list comes from the login, so it is a network call, and it is cached per binary and
 * login folder. `listModels` has no job and no profile, so the screens show the list of whatever
 * login the app's own environment points at. With two Cursor logins on one machine, the screens show
 * the first one's models and a run under the second checks its model against its own list.
 */
export function cursorEngine(binary: string, env: Record<string, string | undefined>, profiles: readonly EngineProfile[] = []): Engine {
  const profileFor = (id: string): EngineProfile | null => {
    const found = profiles.find((one) => one.id === id);
    if (found === undefined) return null;
    if (found.vendor !== 'cursor') {
      throw new Error(`The run names the engine profile ${id}, which is a ${found.vendor} login, and this engine spawns ${binary}.`);
    }
    return found;
  };
  return {
    name: 'cursor',
    vendor: 'cursor',
    spawn: (job, signal) => spawnCursor(binary, job, signal, { env, profile: profileFor(job.engine) }),
    parse: (line) => withSentinels(parseCursorLine(line)),
    listModels: () => cursorModels(binary, env),
  };
}
