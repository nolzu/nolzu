import { spawn } from 'node:child_process';
import { findExecutable } from './shell-env.ts';

export interface AwakeDeps {
  platform: string;
  // Whether a tool is on the PATH. Injected with the platform, so the macOS path is tested anywhere.
  has: (name: string) => boolean;
  // This process, which the macOS helper follows.
  pid: number;
  spawn: (command: string, args: readonly string[]) => { kill: () => void };
}

// The helper that holds the machine awake, or nothing where no tool is known. macOS idle sleep stops a
// long run without any sign, which is why every run holds one. macOS gets `caffeinate -i`, which stops
// idle sleep and not a closed lid, tied with `-w` to this process, so a crash that skips the release
// still lets the machine sleep again. Linux gets `systemd-inhibit` when it is installed, holding a shell
// that ends with this process the same way. Any other system gets nothing.
export function keepAwakeCommand(platform: string, has: (name: string) => boolean, pid: number): [string, string[]] | null {
  if (platform === 'darwin') return ['caffeinate', ['-i', '-w', String(pid)]];
  if (platform === 'linux' && has('systemd-inhibit')) {
    return ['systemd-inhibit', ['--what=idle', '--who=Nolzu', '--why=An agent run is going', 'sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 15; done', 'nolzu', String(pid)]];
  }
  return null;
}

// Holds the machine awake until the returned function is called. One helper per run, so ending one run
// never lets the machine sleep under another. A helper that cannot start costs nothing but the hold:
// the run matters more than the machine staying up.
export function holdAwake(deps: AwakeDeps): () => void {
  const command = keepAwakeCommand(deps.platform, deps.has, deps.pid);
  if (command === null) return () => undefined;
  let helper: { kill: () => void } | null = null;
  try {
    helper = deps.spawn(command[0], command[1]);
  } catch {
    return () => undefined;
  }
  return () => {
    helper?.kill();
    helper = null;
  };
}

// The real helpers, started with nothing attached, so their output cannot fill a pipe nobody reads.
export const systemAwake = (env: Record<string, string | undefined>): AwakeDeps => ({
  platform: process.platform,
  has: (name) => findExecutable(name, env.PATH ?? '') !== null,
  pid: process.pid,
  spawn: (command, args) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    // A tool that fails to start reports it here, and an unhandled error would stop the whole app.
    child.on('error', () => undefined);
    return { kill: () => child.kill() };
  },
});
