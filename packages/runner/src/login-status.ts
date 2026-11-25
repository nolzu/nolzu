import { ENGINE_LABELS, type EngineName } from '@nolzu/protocol';
import { ENGINE_INSTALLS, type RunCommand } from './detect.ts';

// What a tool's own status command said about one login folder. `missing` is no binary on the PATH.
export type LoginState = 'in' | 'out' | 'missing' | 'failed';

export interface LoginAnswer {
  state: LoginState;
  // Every line the tool printed, trimmed, so the screen shows its own words and not a guess at them.
  // Null when it printed nothing or was not there.
  said: string | null;
}

interface LoginCommands {
  // Asks the tool about the login in the folder its variable names. Nolzu reads no credential itself.
  status: readonly string[];
  // What a person types to sign in. Nolzu shows it with Copy and never runs it.
  sign: readonly string[];
}

// Each command was checked against the tool's own docs on 2026-10-15.
export const LOGIN_COMMANDS: Readonly<Record<EngineName, LoginCommands | null>> = {
  // code.claude.com/docs/en/cli-reference: `claude auth status` exits 0 when logged in and 1 when not,
  // and `--text` prints it for a person instead of as JSON. `claude auth login` signs in.
  'claude-code': { status: ['auth', 'status', '--text'], sign: ['auth', 'login'] },
  // The Codex CLI command reference (learn.chatgpt.com/docs/developer-commands): `codex login status`
  // exits 0 when logged in. The page names only that case, so the "Not logged in" line and the exit 1
  // come from `run_login_status` in codex-rs/cli/src/login.rs, which prints both lines to stderr.
  codex: { status: ['login', 'status'], sign: ['login'] },
  // cursor.com/docs/cli/reference/authentication: `agent status` shows whether you are authenticated
  // and `agent login` signs in. `cursor-agent` is the name Nolzu runs the same binary by. The page
  // gives no exit code and no output format, and a signed out folder answered "Not logged in" with
  // exit 0 on 2026-10-15, so the words decide.
  cursor: { status: ['status'], sign: ['login'] },
};

// Longer than the version check, because a status command may ask the vendor over the network.
export const STATUS_WAIT_MS = 15_000;

const binaryOf = (engine: EngineName): string => ENGINE_INSTALLS.find((one) => one.engine === engine)?.binary ?? engine;

const line = (engine: EngineName, args: readonly string[] | undefined): string | null => (args === undefined ? null : [binaryOf(engine), ...args].join(' '));

export const statusCommand = (engine: EngineName): string | null => line(engine, LOGIN_COMMANDS[engine]?.status);

export const signInCommand = (engine: EngineName): string | null => line(engine, LOGIN_COMMANDS[engine]?.sign);

type RunAnswer = Awaited<ReturnType<RunCommand>>;

function wordsOf(answer: RunAnswer): string | null {
  const said = [answer.stdout, answer.stderr ?? '']
    .map((one) => one.trim())
    .filter((one) => one !== '')
    .join('\n');
  return said === '' ? null : said;
}

function stateOf(engine: EngineName, code: number, said: string): LoginState {
  if (engine === 'claude-code') return code === 0 ? 'in' : code === 1 ? 'out' : 'failed';
  // Codex exits 1 on an error too, so only its own line means the folder holds no login.
  if (engine === 'codex') return code === 0 ? 'in' : /^Not logged in$/m.test(said) ? 'out' : 'failed';
  // "Not authenticated" is the error the Cursor page names. The signed out words are read first,
  // because "authenticated" is inside them.
  if (/\bnot (?:logged|signed) in\b|\bnot authenticated\b|\bunauthenticated\b/i.test(said)) return 'out';
  return code === 0 && /\b(?:logged|signed) in\b|\bauthenticated\b/i.test(said) ? 'in' : 'failed';
}

export function readLoginStatus(engine: EngineName, answer: RunAnswer): LoginAnswer {
  if (answer.missing === true) return { state: 'missing', said: null };
  const asked = statusCommand(engine) ?? binaryOf(engine);
  if (answer.killed === true) return { state: 'failed', said: `${asked} did not answer in ${STATUS_WAIT_MS / 1000} seconds.` };
  const said = wordsOf(answer);
  if (answer.code === null) return { state: 'failed', said: said ?? `${asked} could not run: ${answer.reason ?? 'no reason given'}.` };
  return { state: stateOf(engine, answer.code, said ?? ''), said };
}

// Runs the tool's status command once. The caller's runner holds the environment, so the login
// folder a run of that profile would get is the one asked about.
export async function checkLogin(engine: EngineName, run: RunCommand): Promise<LoginAnswer> {
  const commands = LOGIN_COMMANDS[engine];
  if (commands === null) return { state: 'failed', said: `${ENGINE_LABELS[engine]} has no login command. It signs in inside its own app.` };
  return readLoginStatus(engine, await run(binaryOf(engine), commands.status));
}
