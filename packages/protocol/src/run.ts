import type { CardState } from './board.ts';

export interface RunTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// The effort a run asks for, as the engine spells it. It is a string and not a union, because the
// levels belong to the engine and not to this type: Claude Code takes three words, and a Codex
// model names its own levels, up to six of them. Each adapter checks the value against what its
// engine takes and refuses one it does not know, so a wrong level still stops before the spawn.
// The screens still offer the three words that every engine has.
export type Effort = string;

// What the agents drawer shows about a run. The card keeps its own six states, because a
// card waiting on a lane still reads queued to the person looking at the board.
export type RunState =
  | 'queued'
  | 'waiting_lane'
  // A card's wrap-up that waits for a person to answer the knowledge change waiting on Knowledge.
  | 'waiting_review'
  | 'running'
  | 'retrying'
  | 'stopped'
  | 'failed'
  | 'complete'
  | 'interrupted';

// A usage window the engine reports, as the engine gives it, so nothing here has to be recomputed
// to be shown. Every field but the name can be missing, because an engine reports what it knows and
// a number invented for the rest would read as a measurement.
export interface RateLimitWindow {
  // The engine's own name for the window, such as "five_hour" or "seven_day". A name this version
  // has no label for is passed on and shown as it came, because a window dropped for its name would
  // take a refusal with it and leave the screen saying the account is fine.
  name: string;
  // The share of the window used. Normally 0 to 1, and above 1 when the account is over the window.
  // Null when the engine reported no share for it.
  used: number | null;
  // Unix seconds. Null when the engine reported no reset time, which is a state the screen shows as
  // its own: at the limit, with no known reset.
  resetsAt: number | null;
  // The engine's own word for the window, such as "allowed" or "rejected". Null when the engine
  // reported none. Nolzu passes it on and never translates a word it has not seen.
  status: string | null;
}

// Whether the engine is at the limit of this window: it refused the window, or the share reached the
// whole of it. A share the engine did not report is not read as full, and a status word this version
// has not seen is not read as a refusal, so a quiet engine cannot block an account that is fine. The
// retry path and the Engines screen both ask here, so they cannot disagree about what full means.
export const atLimit = (window: RateLimitWindow): boolean => window.status === 'rejected' || (window.used !== null && window.used >= 1);

// An engine's error can carry the last 4000 characters of its stderr. A toast and a notification keep
// the first line, cut short, and the card holds the whole reason.
const REASON_CHARS = 160;
export function shortReason(reason: string): string {
  const line = reason.trim().split('\n')[0] ?? '';
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1).trimEnd()}…` : line;
}

// A share at or over this is near its limit. The board's warning and the
// server's notification read the same line.
export const NEAR_LIMIT = 0.9;

// One refused tool. The path is the file or the command the tool was refused on, where the engine
// gave one, because a log that says only "Write was refused" does not say which write. The id is the
// engine's own tool_use_id: the same refusal can be reported twice, once as its own line and once on
// the result, and the id is what tells a reader those are one refusal and not two. The reason is the
// engine's own sentence, because "Bash was refused" does not say whether a rule is missing or no rule
// can allow the call. Absent where the engine gave none.
export interface DeniedTool {
  tool: string;
  id: string | null;
  path: string | null;
  reason?: string;
}

// Engine-neutral, so core and the hosted server read one shape whatever CLI ran the job.
// A run that asks a question still ends with complete, so needs_input decides the card state.
export type RunEvent =
  // apiKeyMode says the run used an API key instead of the user's subscription login. The
  // Engines screen reads it, because a login state cannot be read any other way. Both fields are
  // null when the engine's stream does not report them, which is what Codex does: it names neither
  // the model nor the login, so the row keeps the model the card chose and nothing claims to know
  // how the run signed in.
  | { type: 'session'; sessionId: string; model: string | null; apiKeyMode: boolean | null }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  // What a tool gave back, by its size in bytes and not its text: a read can return a whole file,
  // and the log row needs only how much came back. `error` is the engine marking the result as one.
  // `lines` counts the lines of a text answer, for a row that reads "84 lines". Absent for a picture,
  // and in an event from before the field.
  | { type: 'tool_result'; bytes: number; error: boolean; lines?: number }
  // The counts of one model call. One call can arrive on several lines, because Claude Code writes a
  // line per content block and puts the call's whole usage on each, so `id` names the call and a
  // reader counts each id once. Null for an engine that names no call, where each event is its own.
  // `tokensSoFar` is the one reader that adds them up.
  | { type: 'usage'; id: string | null; tokens: RunTokens }
  | { type: 'needs_input'; question: string }
  // maxRetries and reason are null when the engine reported neither. Null and not zero,
  // because another engine may send no cap, and zero would read as a cap of none.
  | {
      type: 'api_retry';
      attempt: number;
      delayMs: number;
      status: number | null;
      maxRetries: number | null;
      reason: string | null;
      // When the next try starts, in Unix milliseconds. Only on a wait Nolzu itself holds, which is
      // the one a countdown can be drawn for. The engine's own retries carry none, and an event from
      // before the field reads the same way.
      until?: number;
    }
  | { type: 'rate_limit'; windows: readonly RateLimitWindow[] }
  // Tools a permission rule refused. Evidence and not a verdict: a hook that keeps a read-only
  // phase inside its own folder refuses stray writes by design, and the phase still does its work.
  // `stateAfterRun` reads no state from this, so the phase's own result decides the card.
  | { type: 'permission_denied'; denied: readonly DeniedTool[] }
  // costUsd is null when the engine reports token counts and no cost. Codex reports none. A
  // missing cost is shown as missing and never summed as zero.
  // `sessionTotal` marks a cost that counts every run of the session, as Claude Code reports it on a
  // resume, so the store keeps this run's share only.
  | { type: 'complete'; costUsd: number | null; durationMs: number | null; tokens: RunTokens | null; sessionTotal?: boolean }
  // A run can fail and still have spent money: an API error that outlasts the retries reports its
  // cost and its counts on the same line as the error. The three are left out where the engine sent
  // none, which is not the same as reporting nothing.
  // `halted`: a check after the run stopped it for what it left on disk, which a retry must never undo.
  | { type: 'failed'; reason: string; status: number | null; costUsd?: number | null; durationMs?: number | null; tokens?: RunTokens | null; sessionTotal?: boolean; halted?: true };

// One finished run, folded from its event stream. Engine neutral, so the same shape is written
// whatever CLI ran the job. Cost and the token counts are null until the engine reports them,
// which is different from zero: a run a person stopped never reported either.
export interface RunRecord {
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  tokens: RunTokens | null;
  question: string | null;
  failureReason: string | null;
  failureStatus: number | null;
  state: RunState;
  // Kept apart from the run state, because a card waiting on a question reads blocked while its
  // run ended complete.
  cardState: CardState;
  // The wait a retry is sitting in, for the agents drawer. Null once the run moves on. `until` and
  // `maxRetries` are there only for a wait Nolzu holds, which is the one with a countdown.
  retry: { attempt: number; delayMs: number; reason: string | null; until?: number; maxRetries?: number | null } | null;
  // The cost counts the earlier runs of the same session too. Left out where it is this run's alone.
  costIsSessionTotal?: boolean;
}

// The lines of a tool's text answer as a person counts them. A closing newline ends the last line and
// starts no new one, and no text is no line.
export const lineCount = (text: string): number => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

/**
 * The tokens a run has used so far, input and output the way the phase strip counts them, read from
 * its usage events in order. Null when no event reported any, which is not a run that used none: an
 * engine that reports its counts only at the end has nothing to say before then.
 *
 * A call named twice counts once, with the counts of its last line. `step` hears the total after
 * each usage event that changed it, by the event's place in the list, so a log can draw the total
 * row by row in one pass.
 */
export function tokensSoFar(events: readonly RunEvent[], step?: (at: number, total: number) => void): number | null {
  const calls = new Map<string, number>();
  let total: number | null = null;
  events.forEach((event, at) => {
    if (event.type !== 'usage') return;
    const counted = event.tokens.input + event.tokens.output;
    const before = event.id === null ? 0 : (calls.get(event.id) ?? 0);
    if (event.id !== null) calls.set(event.id, counted);
    const was = total;
    total = (total ?? 0) + counted - before;
    if (total !== was) step?.(at, total);
  });
  return total;
}

// One MCP server's rules, beside what starts it: the tools a run may call (empty is every tool), which
// env variables and headers hold a secret, and the folder a local server starts in.
export interface McpRule {
  tools: readonly string[];
  secretEnv: readonly string[];
  secretHeaders: readonly string[];
  cwd: string | null;
}

// The servers of one run with their secret values, read from the keychain when the run starts. Held in
// memory only: the runner hands them to Codex and Cursor without a file, and writes Claude Code's
// config for each attempt into `dir`, removed once the engine has read it.
export interface McpRun {
  stdio: Readonly<Record<string, { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>>;
  remote: Readonly<Record<string, { url: string; transport: 'http' | 'sse'; headers: Readonly<Record<string, string>> }>>;
  rules: Readonly<Record<string, McpRule>>;
  // The run's own folder under the project's run files, for Claude Code's config and Cursor's record
  // of the file it merged into, so a crash can put that file back.
  dir: string;
}

// One run, described well enough to spawn it. It lives here and not in the runner, because
// core builds the job and the import boundary keeps core away from runner files.
export interface Job {
  runId: number;
  cardKey: string;
  // The project's id in the machine's registry. Run ids and card keys repeat across projects, and one
  // scheduler holds the runs of all of them, so this is what sends a run back to its own database.
  // The loop sets it when it queues the job.
  project?: number;
  // The engine profile this run belongs to, by its id. A session belongs to one profile, so a
  // resume, an answer to a blocked card and a discussion message all run on the profile the run
  // row recorded, never on what the action table says at that moment.
  engine: string;
  // A string and not DeliveryPhase, because a run can belong to a pseudo-ticket such as
  // extract-summary that never appears on a board.
  phase: string;
  cwd: string;
  // The card folder, absolute: `.tasks/<key>/` in the project, next to the worktrees and not inside
  // the card's checkout, so the artifacts outlive the checkout. Core names it, because core knows
  // the project, and the runner opens it to the engine and holds a read-only phase to it.
  taskDir: string;
  // The project folder, absolute, and null or left out when there is no project. Claude Code loads
  // the project's CLAUDE.md from the parent of a card checkout, and that file says to read
  // AGENTS.md here, so the runner lets the run read that file and no more.
  projectDir?: string | null;
  // The documents of the epic this card is a task of, absolute, the ones that exist. Left out for a
  // card that is no task. The prompt names them, and Claude Code gets a Read rule for each one and no
  // write, so a task's run reads the epic's folder and never changes it.
  epicFiles?: readonly string[] | null;
  // Other files outside the checkout and the card folder the prompt tells the run to read, absolute:
  // the project's own instructions for Implement and QA, which Plan reads. Claude Code gets a Read
  // rule for each one and no write. Left out when there are none.
  readFiles?: readonly string[] | null;
  // The project's knowledge folder, absolute, for a phase whose prompt lists its index and that writes
  // no knowledge. Claude Code gets one Read rule for the whole folder and no write. Left out otherwise.
  knowledgeReadDir?: string | null;
  // The project's knowledge folder, absolute, for a phase that writes knowledge, and left out for
  // every other phase. The runner hands it to the guard as a second folder the run may write in,
  // and commits what the run left there. A phase whose policy writes no knowledge is given none,
  // because it would then be allowed to write there with nobody committing what it wrote.
  knowledgeDir?: string | null;
  // The one knowledge file a maintenance run rewrites, relative to the knowledge folder, and left
  // out for every other run. The prompt names it, because a run that rewrites whatever it likes
  // would leave a person with a diff nobody asked for.
  knowledgeFile?: string | null;
  prompt: string;
  // The phase instructions, written from the skill that owns the phase, on every engine. The runner
  // writes them into the card folder at the start of the run, and the prompt names that file. Null
  // for an Ask, whose prompt holds its whole method.
  instructions?: string | null;
  model: string;
  effort: Effort;
  // Chosen by the caller before the run starts, so the log and the row carry the id even
  // when the engine dies before its first line.
  sessionId: string | null;
  // An earlier session to continue. Setting this and sessionId together is a caller bug,
  // and the argv builder refuses it rather than letting the engine pick one.
  resumeFrom: string | null;
  timeoutMs: number;
  logPath: string;
  lane: string | null;
  // Claude Code's config file for this attempt, which `spawnClaude` writes from `mcp` and removes once
  // the engine has read it. Null for no server.
  mcpConfigPath: string | null;
  // The run's servers, filled when the run starts and left out of the job a queue holds.
  mcp?: McpRun;
  // The project's own settings file, which holds the read-only guard. Measured on Claude Code 2.1.278:
  // a run whose working folder is a card worktree does not read `.claude/settings.json` from the main
  // checkout, and the file is there only if the person committed it, so the guard has to be named.
  // Null when the project has none.
  settingsPath: string | null;
  tools: readonly string[];
  // The project's own list of shell commands the agent may run, for a phase that holds Bash. Left
  // out or empty, no command is allowed. Claude Code reads it; see `claudeArgs`.
  allowedCommands?: readonly string[];
  // The project's repositories by their path in the project, for refine and plan on a project with
  // several, which pick the card's list from them. Left out on a project with one repository. The
  // prompt says the same in words; the fake engine reads it here, because it reads no prompt.
  repositories?: readonly string[];
  // Set when the project folder is not a git repository, so the run's folder is a plain one too.
  // Left out otherwise, so a job in a repository is the one it always was. Codex refuses to start
  // outside a repository without a flag, and the other engines are refused there until measured.
  outsideGit?: true;
  // Where a Codex process starts: true for the card folder, false for the checkout. The job builder
  // sets it, and a resume follows the folder its session started in. Left out, the spawn reads
  // `startsInCardFolder`.
  startsInCardFolder?: boolean;
  // The throwaway copy of `cwd` a QA run works on, absolute, and left out for every other run. The
  // loop makes it right before the run and deletes it after, the process starts in it and may
  // write there, and `cwd` stays read-only. The prompt names its paths from this folder.
  qaCopy?: string | null;
  // The project's own wall lists from Settings, Project, as typed. The runner checks every entry
  // again at spawn and leaves out one that would loosen the wall. Left out, the fixed rules alone.
  walls?: WallLists;
}

// Three lists a project adds to the fixed wall rules. `hidden`: paths no run may read, Implement
// included. `exceptions`: `.env` files of the project that stay readable, relative to the project.
// `writable`: folders outside the project that Implement and QA may write, such as a build cache.
export interface WallLists {
  hidden: readonly string[];
  exceptions: readonly string[];
  writable: readonly string[];
}

// What the git compare after a read-only run found, kept on the run row so the card page shows it
// after a reload. The wall should make this never happen; this is the last check behind it.
// `restored` is true in a checkout Nolzu made for the card, where it puts back what changed, and
// false in the person's own folder, which Nolzu never touches. `undone` and `left` name what was
// put back and what could not be, one line each.
export interface ReadOnlyBreak {
  restored: boolean;
  diff: string;
  undone: string[];
  left: string[];
}
