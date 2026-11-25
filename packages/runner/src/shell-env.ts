import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export interface ShellEnvDeps {
  // Returns the login shell's environment dump, or null when there is nothing to read.
  readDump: () => string | null;
}

// Only PATH is read from the dump, and PATH never holds a newline, so a line parser is enough.
// A value that spans lines leaves its tail on a line with no name, and that line is skipped.
export function parseEnvDump(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    // An equals sign at the start means the name is empty, which is not a variable.
    if (at <= 0) continue;
    found[line.slice(0, at)] = line.slice(at + 1);
  }
  return found;
}

// The process PATH stays in front, so a login shell cannot quietly shadow a binary the caller
// already resolved. Empty segments go, because an empty entry means the working directory.
export function mergePath(current: string, extra: string): string {
  const seen = new Set<string>();
  for (const part of [...current.split(delimiter), ...extra.split(delimiter)]) {
    if (part !== '') seen.add(part);
  }
  return [...seen].join(delimiter);
}

export function findExecutable(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      // The file check comes first: a directory carrying the name would pass the execute
      // check, because a directory is executable when it can be entered.
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveShellPath(env: Record<string, string | undefined>, deps: ShellEnvDeps): string {
  const current = env.PATH ?? '';

  let dump: string | null;
  try {
    dump = deps.readDump();
  } catch {
    // A login shell can print a banner, wait for input or hang. Losing the extra entries is
    // better than losing the run, so the PATH the process already has stands.
    return current;
  }
  if (dump === null) return current;

  const fromShell = parseEnvDump(dump).PATH;
  return fromShell === undefined || fromShell === '' ? current : mergePath(current, fromShell);
}

// A process started outside a login shell on macOS does not get the PATH from the user's shell
// profile, so claude, gh and docker go missing. This asks the login shell once and takes only
// its environment, never running anything the caller chose.
export function readLoginShellEnv(env: Record<string, string | undefined>, timeoutMs = 3000): string | null {
  const shell = env.SHELL;
  if (shell === undefined || shell === '') return null;
  const result = spawnSync(shell, ['-lc', 'env'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    // stdin is closed, so a profile that asks a question fails fast instead of waiting for
    // an answer that never comes.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

// The PATH Nolzu itself runs with, set once when it starts. Started from a LaunchAgent, the Dock or
// anything but a terminal, the process gets the system's bare PATH, so git misses what the person's
// shell finds: gpg for a signed commit, a credential helper, git-lfs. The login shell's entries join
// it, after the ones the process has. Only absolute entries stay: git looks gpg and its helpers up
// on this PATH, and a relative entry would search the folder git runs in, a checkout a run may write.
export function startPath(env: Record<string, string | undefined>, readDump: () => string | null = () => readLoginShellEnv(env)): string {
  return resolveShellPath(env, { readDump })
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .join(delimiter);
}

// Read once at boot and keep the answer. A PATH the user changes during a session is not picked
// up until the app restarts, which is the cheap version and is worth saying out loud.
export function shellPath(env: Record<string, string | undefined>, timeoutMs?: number): string {
  return resolveShellPath(env, { readDump: () => readLoginShellEnv(env, timeoutMs) });
}
