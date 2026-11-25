import { spawn } from 'node:child_process';
import { type StackState, TAKEN_DOWN } from '@nolzu/protocol';
import { RUN_TOKENS } from './engine-env.ts';

/**
 * Your own commands under Start the app, run one at a time: the Stop after QA and from the app line,
 * and the Status the app line shows. The start runs through `startApp` with `mayExit`.
 *
 * Nolzu never knows what the app is. It expands `{key}` in a template the person wrote and runs it in
 * the card's own checkout. The Status output goes on the app line as the person's own words, and
 * nothing here reads it.
 */
export interface StackHook {
  load: string | null;
  unload: string | null;
  status: string | null;
}

// The three sides of the hook. The panel's own three buttons are a different set, and they live in
// `@nolzu/ui/qa` under the name `StackAction`.
export type StackHookAction = 'load' | 'unload' | 'status';

export interface StackRunOptions {
  // The card's own checkout, which is where the command runs.
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  // How long the command may take before it is killed. A stack that never comes up must not hold
  // the stack lane for ever, because one QA run at a time means every other card waits behind it.
  timeoutMs?: number;
}

export interface StackResult {
  // The command as it ran, for the log and for the panel. It holds no secret Nolzu put there:
  // every character came from the person's own template.
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  // The command was still running when the timeout struck, so the code below is the kill and not
  // the stack's own answer.
  timedOut: boolean;
}

// Fifteen minutes. A first `docker compose up` that pulls images is the slow case, and a stack
// that takes longer than this is one a person has to look at anyway.
export const STACK_TIMEOUT_MS = 15 * 60 * 1000;

// Taking a stack down is not starting one, and the QA lane is held until it returns. Two minutes
// is long for a `docker compose down` and short enough that a hung one does not keep every other
// card waiting. A person with a real stack may have to move this.
export const STACK_UNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

// Reporting is not starting, and the ticket page waits for this one before it draws, so it is the
// longest a person can wait for the overview of a card. A `docker compose ps` answers in under a
// second. One that takes five is one the panel says was stopped, which is true and beats a page
// that stays blank.
export const STACK_STATUS_TIMEOUT_MS = 5 * 1000;

// How long a stack that ignored SIGTERM gets before it is killed outright.
const KILL_GRACE_MS = 5000;

// A failing stack can print a lot. The end is the part that names the problem, the same rule the
// engine spawn follows for its own stderr. Room for a whole load of a stack of containers, whose
// warnings come first and whose addresses come last.
export const OUTPUT_TAIL = 16_000;

const tail = (text: string): string => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text);

/**
 * The command a template makes for one card.
 *
 * A template with no `{key}` is left as it is. Onboarding already warns about that one, because
 * every card would then load the same thing and two cards at once would fight over it.
 */
export function stackCommand(template: string, key: string): string {
  // The command runs in a shell, so a key goes in only when no character of it means anything there.
  // Never a dash or a hash first, so a key never reads as an option or a comment. A dot or an
  // underscore first is a repository such as `.github`, but never a `.` or `..` part, which would
  // step out of a folder the command names.
  if (template.includes('{key}') && (!/^[A-Za-z0-9._][A-Za-z0-9._#/-]*$/.test(key) || key.split(/[/#]/).some((part) => part === '.' || part === '..'))) {
    throw new Error(`The card key ${key} holds a character a shell reads, so Nolzu will not put it into your command. Take {key} out of the command to start this card's app.`);
  }
  return template.trim().replaceAll('{key}', key);
}

/**
 * The variables a hook gets on top of the caller's environment: the card, the project folder and
 * the card's repositories, one per line with the root first. A script finds repository `r` at
 * `$PWD/r`. A list rather than a `{repos}` placeholder, because a shell line cannot split a list
 * safely and a script can read its environment.
 */
export function stackEnv(key: string, project: string, repos: readonly string[]): Record<string, string> {
  const ordered = [...repos.filter((repo) => repo === '.'), ...repos.filter((repo) => repo !== '.')];
  return { NOLZU_CARD_KEY: key, NOLZU_PROJECT: project, NOLZU_REPOS: ordered.join('\n') };
}

/**
 * The `<name> <url>` lines a load printed, for QA to check against. Everything else a load prints
 * is start-up noise and is dropped. Only the last `OUTPUT_TAIL` characters are kept, so a script
 * prints these last.
 */
export function stackAddresses(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  // A full tail most likely starts mid-line, and a line cut inside its name still matches.
  if (stdout.length >= OUTPUT_TAIL) lines.shift();
  return lines.filter((line) => /^\S+\s+https?:\/\/\S+$/.test(line));
}

/**
 * What a load printed besides its addresses, with the blank lines gone. A start that worked is read
 * for its addresses only, so a part of the app it could not point at the card's code is said here
 * or nowhere, and QA then judges code that is not the card's.
 */
export function stackNotes(output: string): string {
  const addresses = new Set(stackAddresses(output));
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !addresses.has(line))
    .join('\n');
}

/**
 * Run one side of the hook, or answer null when there is no command for it.
 *
 * `PWD` is set from `cwd` rather than left to the shell. docker compose reads `PWD` and not the
 * working directory when it resolves a relative path in a compose file, so a run started from a
 * process whose `PWD` points elsewhere loads the wrong folder. The known pitfalls in `ARCHITECTURE.md` name this
 * as a pitfall to design for, and this is the one place that can.
 */
// The environment a command of your own gets: the caller's, with `PWD` set, and without Nolzu's own
// address (`ORIGIN`, `HOST`) or the GitHub and npm tokens, as the app QA starts goes without them.
export function commandEnv(env: Record<string, string | undefined> | undefined, cwd: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, PWD: cwd };
  for (const name of ['ORIGIN', 'HOST', ...RUN_TOKENS]) delete out[name];
  return out;
}

export async function runStackHook(
  hook: StackHook,
  action: StackHookAction,
  key: string,
  options: StackRunOptions,
): Promise<StackResult | null> {
  const template = hook[action];
  if (template === null || template.trim() === '') return null;
  const command = stackCommand(template, key);

  return new Promise<StackResult>((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('The command was stopped.'));
      return;
    }
    // Through a shell, because the template is a command line with flags and redirection, which is
    // what the person typed into the settings. It is their own machine and their own words; Nolzu
    // adds nothing to the line but the card key.
    //
    // detached, so the shell leads its own process group and one kill reaches what it started.
    // Without it, killing the shell leaves the real command running and holding the pipes, and the
    // close event never arrives: `docker compose up` would go on while the stack lane counted the
    // run as over. macOS hides this, because its `sh` execs a single command in place and the one
    // process is the shell, and Linux does not.
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: true,
      env: commandEnv(options.env, options.cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });
    const { pid } = child;

    // The group, falling back to the child alone when the platform has no groups.
    const stop = (which: NodeJS.Signals): void => {
      try {
        if (pid === undefined) throw new Error('no pid');
        process.kill(-pid, which);
      } catch {
        try {
          child.kill(which);
        } catch {
          // Nothing left to stop.
        }
      }
    };

    let out = '';
    let err = '';
    let timedOut = false;
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      // A stack that ignores the polite signal still has to let the lane go.
      hardKill = setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS);
    }, options.timeoutMs ?? STACK_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      out = tail(out + chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = tail(err + chunk.toString());
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      // A child killed by a signal carries no exit code. Reporting that as zero would read as a
      // stack that came up, and QA would then check a stack that is not there.
      resolve({ command, code: code ?? (signal !== null ? 128 : 0), stdout: out, stderr: err, timedOut });
    });
  });
}

// What the card shows about its stack. The five words live in `@nolzu/protocol`, because the
// ticket page draws them and may not import the runner.
export type { StackState } from '@nolzu/protocol';

export interface StackStatus {
  state: StackState;
  // The one line a person reads. Null while nothing has happened yet.
  reason: string | null;
}

/**
 * What a finished stack run leaves on the card.
 *
 * A timeout is a failure with its own sentence, because "exit 128" tells nobody that the stack
 * was still starting when the clock ran out.
 *
 * An unload that fails is not read as failed. The QA run it followed is over and its verdict
 * stands, so what is left to say is that the stack the load started is still running and somebody
 * has to take it down.
 */
export function stackStatusAfter(action: 'load' | 'unload', result: StackResult | null): StackStatus {
  if (result === null) return { state: 'off', reason: null };
  if (!result.timedOut && result.code === 0) {
    // The sentence is what tells a stack that ran and went down from a project that has none.
    // Both are off, and the card would otherwise read the same for either.
    return action === 'load' ? { state: 'up', reason: null } : { state: 'off', reason: TAKEN_DOWN };
  }

  const said = result.stderr.trim() || result.stdout.trim();
  const name = action === 'load' ? 'start' : 'Stop';
  const why = result.timedOut
    ? `The ${name} command was still running after the timeout, so it was stopped.`
    : `The ${name} command exited ${result.code}.${said === '' ? '' : ` ${said.split('\n').at(-1)}`}`;

  return action === 'unload' ? { state: 'up', reason: `${why} The app is still up.` } : { state: 'failed', reason: why };
}
