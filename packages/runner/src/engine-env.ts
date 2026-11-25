import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CONFIG_DIR_VAR, type EngineProfile } from '@nolzu/protocol';

export interface EngineEnvOptions {
  // The card folder a read-only phase is held to, or null for a phase that may write anywhere in
  // the checkout. One field, so a read-only run with no folder cannot be written down: the guard
  // lets every write through when the folder is missing.
  readOnlyTaskDir: string | null;
  // The knowledge folder a knowledge-writing phase may also write in, or null for every other
  // phase. The guard allows a write inside either folder and refuses the project's source, which
  // is what lets a wrap-up write knowledge without being handed the whole checkout.
  knowledgeDir?: string | null;
  // Whether a guarded phase may run a command. QA is the one that may: running the project's own
  // checks is its whole job. Every other guarded phase edits files and runs nothing.
  commands?: boolean;
  // The profile this run belongs to, or null to leave the vendor's own config folder alone. Nolzu
  // sets the variable and never opens the folder: the person runs the vendor's login command in it.
  profile?: EngineProfile | null;
}

// The GitHub and npm tokens a person's shell may hold, which no run gets. The app QA starts from
// the card's branch loses them too.
export const RUN_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'] as const;

/**
 * The package managers' caches for a walled run, in Nolzu's data folder. The wall keeps the home folder
 * read-only, so `~/.npm` and its kin refuse every write, and an install would then put its cache in the
 * card folder. These variables send the caches to `<data folder>/caches`, which the wall opens. The
 * folders are made here, because bwrap opens only a path that is there. pnpm 11 reads `pnpm_config_*`;
 * `npm_config_store_dir` would make npm warn on every command.
 */
export function packageCaches(dataDir: string): { dir: string; env: Record<string, string> } {
  const dir = join(dataDir, 'caches');
  const env = {
    npm_config_cache: join(dir, 'npm'),
    YARN_CACHE_FOLDER: join(dir, 'yarn'),
    YARN_GLOBAL_FOLDER: join(dir, 'yarn-global'),
    pnpm_config_store_dir: join(dir, 'pnpm-store'),
    pnpm_config_cache_dir: join(dir, 'pnpm'),
  };
  for (const folder of Object.values(env)) mkdirSync(folder, { recursive: true });
  return { dir, env };
}

export function engineEnv(base: Record<string, string | undefined>, options: EngineEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  // spawn refuses an undefined value, so the copy drops them rather than passing them on.
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  // Each of these outranks the flag the run passes, so a value left in the person's shell would
  // silently run the card on another model or effort than the one it shows. The names were read
  // off Claude Code 2.1.278. The pattern covers the per-family defaults, which grow with the engine,
  // and a family whose name holds an underscore. It ends at MODEL, so the display names that end in
  // _NAME or _DESCRIPTION stay.
  delete env.ANTHROPIC_MODEL;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  for (const name of Object.keys(env)) {
    if (/^ANTHROPIC_DEFAULT_(?:[A-Z0-9_]+_)?MODEL$/.test(name)) delete env[name];
  }

  // CURSOR_API_KEY replaces the login and CURSOR_API_ENDPOINT sends the run somewhere else, and
  // both outrank the flags, so a value left in the person's shell would make the run something
  // other than the card describes. Dropped for every engine: the pair means nothing to the others.
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_API_ENDPOINT;

  // With any of these a run could push, open a pull request or publish a package as the person.
  // Nolzu runs gh itself, in its own process and outside the run, so reading pull requests and
  // publishing keep them. A run that installs from a private registry still has the person's
  // ~/.npmrc, which the wall leaves readable, and loses only a token that came through the shell.
  for (const name of RUN_TOKENS) delete env[name];

  // The launcher sets these for Nolzu's own server, so a run would get the local API's address for
  // free. Dropping them does not close that gap: the API has no token yet, and a run can still find
  // the port. It only stops handing the address over.
  delete env.ORIGIN;
  delete env.PORT;
  delete env.HOST;

  // What the PreToolUse guard reads. Removed first, because Nolzu can itself run inside a
  // read-only run, and an inherited pair would hold an implement run to somebody else's folder.
  delete env.NOLZU_READ_ONLY;
  delete env.NOLZU_TASK_DIR;
  delete env.NOLZU_KNOWLEDGE_DIR;
  delete env.NOLZU_ALLOW_COMMANDS;
  if (options.readOnlyTaskDir !== null) {
    // The guard resolves a relative folder against its own working directory, and treats an empty
    // one as no limit at all.
    if (!isAbsolute(options.readOnlyTaskDir)) {
      throw new Error(`The card folder ${JSON.stringify(options.readOnlyTaskDir)} is not an absolute path, so the read-only guard cannot hold the run to it.`);
    }
    env.NOLZU_READ_ONLY = '1';
    env.NOLZU_TASK_DIR = options.readOnlyTaskDir;
    const knowledgeDir = options.knowledgeDir ?? null;
    if (knowledgeDir !== null) {
      // The guard resolves a relative folder against its own working directory, which is the
      // card's checkout, so a relative one would open a folder inside the project's source.
      if (!isAbsolute(knowledgeDir)) {
        throw new Error(`The knowledge folder ${JSON.stringify(knowledgeDir)} is not an absolute path, so the guard cannot hold the run to it.`);
      }
      env.NOLZU_KNOWLEDGE_DIR = knowledgeDir;
    }
    if (options.commands === true) env.NOLZU_ALLOW_COMMANDS = '1';
  }

  // A profile with no folder of its own leaves the variable exactly as it came, and that is on
  // purpose. Such a profile means "wherever the vendor looks by default", and for somebody who
  // sets the variable in their shell, the vendor's default place is the one it names. Dropping it
  // would leave the run with no login at all. A profile that names a folder overrides it below,
  // which is the case where the card's choice has to win.
  const profile = options.profile ?? null;
  if (profile !== null && profile.configDir !== null) {
    const variable = CONFIG_DIR_VAR[profile.vendor];
    // The vendor resolves a relative folder against the working directory, which is the card's
    // checkout, so a relative one would make a new login folder inside somebody's repository.
    if (!isAbsolute(profile.configDir)) {
      throw new Error(`The config folder of the engine profile ${profile.id} is not an absolute path, so the vendor would make it inside the card's checkout.`);
    }
    env[variable] = profile.configDir;
  }
  return env;
}
