import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnv } from './env.ts';
import { exitCode, git, GIT_FLAGS, gitBinary, NO_HOOKS } from './exec.ts';
import { cloneProgress, type CloneProgress } from './porcelain.ts';

// Long enough for a large repository on a slow line. A clone past it is stopped and removed.
export const CLONE_TIMEOUT_MS = 10 * 60_000;

export interface CloneIntoOptions {
  workspace: string;
  url: string;
  // The folder inside the workspace, already checked by `cloneTarget`.
  name: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  // The transports git may use. The app always passes https and ssh through `cloneRepository`. This
  // module is not exported from the runner's index, and the package exports nothing else, so only a
  // test that imports this file by its path can pass another list, such as file for a local bare repository.
  protocols: string;
  // Called each time git's progress moves. Without it the clone runs as it always did, with no
  // progress asked of git.
  onProgress?: (progress: CloneProgress) => void;
}

export type Cloned = { ok: true; name: string; path: string } | { ok: false; reason: string };

// Git's last line, with any user and password a URL in it carries taken out, so a reason never shows one.
// A progress update ends in a carriage return, so that counts as the end of a line too.
// git's reason: its first `fatal:` line and the line before it, where ssh says why. The lines after
// it are advice, the same for every failure.
const lastLine = (stderr: string): string => {
  const lines = stderr.split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line !== '' && !/^(Cloning into|remote: (Enumerating|Counting|Compressing|Total)|Receiving|Resolving)/.test(line));
  const fatal = lines.findIndex((line) => line.startsWith('fatal:'));
  const said = fatal === -1 ? lines.slice(-1) : lines.slice(Math.max(0, fatal - 1), fatal + 1);
  return said.join(' ').replace(/\/\/[^/@\s]*@/g, '//').trim();
};

// Git leads a process group of its own, so a stop also kills git-remote-https, index-pack and ssh.
// The answer comes only once git has closed, so nothing still writes into the folder that is then
// removed. Killing git alone left its helpers running.
function runClone(args: readonly string[], cwd: string, env: Record<string, string>, stop: AbortSignal, onProgress?: (progress: CloneProgress) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // By its full path, as `git()` starts it (`gitBinary`).
    const binary = gitBinary(env.PATH ?? process.env.PATH);
    if (binary === null) {
      reject(new Error('git was not found on the PATH. Install git, or check the PATH resolved from the login shell.'));
      return;
    }
    // The flags and the hooks off of every other git call: a template folder in the person's config
    // can put a post-checkout hook in the new repository, and git would run it at the end of the clone.
    const child = spawn(binary, [...GIT_FLAGS, ...NO_HOOKS, ...args], { cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const { pid } = child;
    const kill = (): void => {
      try {
        if (pid === undefined) throw new Error('no pid');
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The platform has no groups, or the group is gone already.
        child.kill('SIGKILL');
      }
    };
    let stderr = '';
    let told: CloneProgress | null = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (onProgress === undefined) return;
      // Limit: reads the whole stderr per chunk. A ten minute clone writes some tens of kilobytes.
      const now = cloneProgress(stderr);
      if (now === null || (now.step === told?.step && now.percent === told.percent)) return;
      told = now;
      onProgress(now);
    });
    if (stop.aborted) kill();
    else stop.addEventListener('abort', kill, { once: true });
    child.on('error', (error) => {
      stop.removeEventListener('abort', kill);
      reject(error);
    });
    child.on('close', (code, signal) => {
      stop.removeEventListener('abort', kill);
      // A helper that outlived git after a stop goes too, before the folder is removed.
      if (stop.aborted) kill();
      resolve({ code: exitCode(code, signal), stderr });
    });
  });
}

/**
 * Clones into a new folder of the workspace, or says why it did not.
 *
 * Nolzu makes the folder itself before git runs, so a folder that was there already is refused and
 * never touched, and every folder this removes after a failure is one it made a moment before.
 */
export async function cloneInto({ workspace, url, name, env, signal, protocols, onProgress }: CloneIntoOptions): Promise<Cloned> {
  const path = join(workspace, name);
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: `There is a folder ${JSON.stringify(name)} in the workspace already, so nothing was cloned.` };
    return { ok: false, reason: `The folder ${JSON.stringify(name)} could not be made in the workspace: ${(error as Error).message}` };
  }
  const drop = (reason: string): Cloned => {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return { ok: false, reason };
  };

  const base = gitEnv(env);
  // The person's own ssh command wins, as it does for a push. Without one, ssh never stops to ask.
  const own = env.GIT_SSH_COMMAND ?? env.GIT_SSH ?? (await git(['config', 'core.sshCommand'], { cwd: workspace, env: base }).catch(() => ({ stdout: '' }))).stdout.trim();
  const forClone: Record<string, string> = {
    ...base,
    ...(own === '' ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}),
    // Set after the copy, so an allow list from the login shell cannot widen it.
    GIT_ALLOW_PROTOCOL: protocols,
    // Empty and not unset: an unset one makes git fall back to core.askPass and then SSH_ASKPASS.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    // The progress words are read, so they must be git's own English ones and not a translation.
    ...(onProgress === undefined ? {} : { LC_ALL: 'C' }),
  };
  const stop = AbortSignal.any([AbortSignal.timeout(CLONE_TIMEOUT_MS), ...(signal === undefined ? [] : [signal])]);
  try {
    // "--" so a URL that starts with "-" is never read as an option.
    // Git prints progress only to a terminal unless asked.
    const progress = onProgress === undefined ? [] : ['--progress'];
    const cloned = await runClone(['clone', '--no-recurse-submodules', ...progress, '--', url, name], workspace, forClone, stop, onProgress);
    if (stop.aborted) {
      return drop(signal?.aborted === true ? 'The clone was stopped, so nothing was added.' : `The clone took longer than ${CLONE_TIMEOUT_MS / 60_000} minutes and was stopped, so nothing was added.`);
    }
    if (cloned.code !== 0) return drop(`Git could not clone ${name}. ${lastLine(cloned.stderr)}`.trim());
  } catch (error) {
    return drop(`Git could not run for the clone: ${(error as Error).message}`);
  }
  // An empty remote clones with no commit, and a card needs a base branch to start from.
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: path, env: base }).catch(() => ({ code: 1 }));
  if (head.code !== 0) return drop('The repository at that URL is empty, so there is no branch to start from. Push a first commit to it, then add it again.');
  return { ok: true, name, path };
}
