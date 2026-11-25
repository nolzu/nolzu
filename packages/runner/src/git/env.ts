export interface GitEnvOptions {
  // Point git at empty config files. A test repository must not read the developer's own
  // config, or the suite passes or fails depending on whose machine runs it.
  configGlobal?: string;
  configSystem?: string;
}

export function gitEnv(base: Record<string, string | undefined>, options: GitEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // spawn refuses an undefined value, so the copy drops them rather than passing them on.
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  // A missing credential then fails at once instead of waiting for an answer nobody will type.
  env.GIT_TERMINAL_PROMPT = '0';
  // A read never takes the index lock, so a status cannot block the agent running in the
  // same worktree.
  env.GIT_OPTIONAL_LOCKS = '0';

  // Variables that point git at a repository. git exports GIT_DIR into every hook it runs, and
  // into rebase --exec and bisect run, and the login shell environment is captured and passed on,
  // so one can arrive without anybody setting it here. Left in place, git answers about that
  // repository whatever folder it is asked about, and a card would commit into one the person
  // never chose.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;

  // Config set through the environment for one run, which can turn a plain push into a force or
  // send it to another URL. It arrives the same way the variables above do: git exports it into
  // its own hooks and into rebase --exec, and a login shell environment is captured and handed on.
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete env[name];
  }

  if (options.configGlobal !== undefined) env.GIT_CONFIG_GLOBAL = options.configGlobal;
  if (options.configSystem !== undefined) env.GIT_CONFIG_SYSTEM = options.configSystem;
  return env;
}
