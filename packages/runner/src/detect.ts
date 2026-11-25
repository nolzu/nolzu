import { execFile } from 'node:child_process';
import { type EngineName, type RunEvent } from '@nolzu/protocol';
import { findExecutable } from './shell-env.ts';

// For the launcher, which imports this light entry and not the whole runner.
export { startPath } from './shell-env.ts';

// Re-exported, because every caller in this package reached for it here before it moved to
// protocol, where core and the UI can read it too.
export type { EngineName };

export interface EngineStatus {
  engine: EngineName;
  binary: string;
  found: boolean;
  // Null when the binary is missing, or printed nothing that reads as a version.
  version: string | null;
  // The vendor's page that says how to install it, for the row of a missing engine.
  install: string;
  // What a binary that is there said when its version check failed, word for word. Null otherwise.
  error: string | null;
}

// What running one binary gave back. `missing` is the binary not being there at all.
export type RunCommand = (
  binary: string,
  args: readonly string[],
) => Promise<{
  code: number | null;
  stdout: string;
  stderr?: string;
  missing?: boolean;
  // Stopped after the wait, rather than exiting on its own.
  killed?: boolean;
  // The system's word for why it could not run, such as EACCES, when there is no exit code.
  reason?: string;
}>;

const WAIT_MS = 5000;

// What a failed check said, or what the system said about it, never "exited with null".
function failure(binary: string, answer: Awaited<ReturnType<RunCommand>>): string {
  if (answer.killed === true) return `${binary} --version did not answer in ${WAIT_MS / 1000} seconds.`;
  const said = (answer.stderr ?? '').trim() || answer.stdout.trim();
  if (said !== '') return said;
  if (answer.code === null) return `${binary} --version could not run: ${answer.reason ?? 'no reason given'}.`;
  return `${binary} --version exited with ${answer.code}.`;
}

export interface EngineInstall {
  engine: EngineName;
  binary: string;
  // The vendor's page that says how to install it.
  install: string;
  // The npm line that page gives, for a row with Copy. Nolzu itself installs with npm, so npm is on the
  // machine. Null where the page installs with its own script, and the row links the page instead.
  command: string | null;
}

// The three engines, in the order the Engines screen lists them. Each install page answered on 2026-09-21.
// The two npm lines were read off those pages on 2026-10-15: "Install with npm" on the Claude Code
// setup page, and the npm line in the Codex README.
export const ENGINE_INSTALLS: readonly EngineInstall[] = [
  { engine: 'claude-code', binary: 'claude', install: 'https://code.claude.com/docs/en/setup', command: 'npm install -g @anthropic-ai/claude-code' },
  { engine: 'cursor', binary: 'cursor-agent', install: 'https://cursor.com/cli', command: null },
  { engine: 'codex', binary: 'codex', install: 'https://github.com/openai/codex', command: 'npm install -g @openai/codex' },
];

// The first dotted number, which is how all three print their version, whatever words surround it.
export function parseVersion(stdout: string): string | null {
  return /\d+\.\d+(?:\.\d+)?/.exec(stdout)?.[0] ?? null;
}

// Which engines are on this machine and in which version. Each binary is run with its version flag and
// nothing else. The login is not asked here: `checkLogin` runs a tool's own status command, and only
// when a person presses Check login. `usedApiKey` says how a run logged in.
// All three at once, so one slow engine does not hold up the others.
export async function detectEngines(run: RunCommand): Promise<EngineStatus[]> {
  return Promise.all(
    ENGINE_INSTALLS.map(async ({ engine, binary, install }) => {
      const answer = await run(binary, ['--version']);
      // A binary that printed a version is there, also when it then exited with a code.
      const there = answer.missing !== true;
      const version = parseVersion(answer.stdout);
      const failed = there && version === null && answer.code !== 0;
      return { engine, binary, found: there, version, install, error: failed ? failure(binary, answer) : null };
    }),
  );
}

// Which engines have their binary in a folder of this PATH. A file check and no run, because the start
// page asks every two seconds while no tool is there, and starting three CLIs that often is heavy.
export function enginesOnPath(path: string): EngineName[] {
  return ENGINE_INSTALLS.filter(({ binary }) => findExecutable(binary, path) !== null).map(({ engine }) => engine);
}

// Whether a run used an API key instead of the subscription login, from the first line it printed.
// Null for a run that never got that far.
export function usedApiKey(events: readonly RunEvent[]): boolean | null {
  const session = events.find((event) => event.type === 'session');
  return session === undefined ? null : session.apiKeyMode;
}

// The real runner: the binary on the PATH it is given, a few seconds at most, and its output only.
export const runVersion =
  (env: Record<string, string | undefined>, wait: number = WAIT_MS): RunCommand =>
  (binary, args) =>
    new Promise((resolve) => {
      execFile(binary, [...args], { env, timeout: wait, encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          missing: error !== null && error.code === 'ENOENT',
          killed: error?.killed === true,
          reason: typeof error?.code === 'string' ? error.code : undefined,
        });
      });
    });
