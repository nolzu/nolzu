import type { EngineProfile } from '@nolzu/protocol';
import { parseClaudeLine } from './claude.ts';
import { type Engine, withSentinels } from './engine.ts';
import { claudeModels } from './models.ts';
import { spawnClaude } from './spawn.ts';

/**
 * The Claude Code engine.
 *
 * `binary` is looked up on the PATH in `env`, which is the login shell's, so the engine and the
 * tools an agent runs are found the way the person's own terminal finds them.
 *
 * `profiles` is every login this machine holds. The run's own profile is looked up from
 * `job.engine` rather than fixed here, because a resume has to land on the profile the run row
 * recorded, whatever the action table says by then. A job naming a profile of another vendor is
 * refused: this adapter spawns one binary, and running a codex login through it would sign the
 * run in as somebody else.
 */
export function claudeEngine(
  binary: string,
  env: Record<string, string | undefined>,
  profiles: readonly EngineProfile[] = [],
): Engine {
  const profileFor = (id: string): EngineProfile | null => {
    const found = profiles.find((one) => one.id === id);
    if (found === undefined) return null;
    if (found.vendor !== 'claude-code') {
      throw new Error(`The run names the engine profile ${id}, which is a ${found.vendor} login, and this engine spawns ${binary}.`);
    }
    return found;
  };
  return {
    name: 'claude-code',
    vendor: 'claude-code',
    spawn: (job, signal) => spawnClaude(binary, job, signal, { env, profile: profileFor(job.engine) }),
    parse: (line) => withSentinels(parseClaudeLine(line)),
    listModels: claudeModels,
  };
}
