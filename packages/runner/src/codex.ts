import { lineCount, type RunEvent } from '@nolzu/protocol';

// The fields Nolzu reads from `codex exec --json`. Measured against Codex CLI 0.145.0 and written
// down in docs/engines/codex.md. The binary adds event types between minor versions, so a type
// that is not here produces no event rather than ending the run.
interface CodexLine {
  type?: string;
  // The session id, on `thread.started`. A resume takes it back.
  thread_id?: string;
  // The item's own fields differ per type, and a type this version has never seen still shows in
  // the log, so the whole item is kept.
  item?: { type?: string; text?: string; message?: string; [field: string]: unknown };
  // Why a turn failed, on `turn.failed`. The same sentence comes first on a line of type `error`.
  error?: { message?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    // Written down and not read. `RunTokens` has no slot for reasoning, and whether this count sits
    // inside `output_tokens` or beside it was not measured, so adding it could double what a run
    // reports.
    reasoning_output_tokens?: number;
  };
  // Nolzu's own line, written by the spawn from what the process said on stderr.
  tool?: string;
  text?: string;
}

// The type of the line the spawn writes for a tool the sandbox refused. The name carries the
// product, so it cannot collide with an event type the binary starts printing later.
export const CODEX_DENIED = 'nolzu.denied';

function read(line: string): CodexLine | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as CodexLine) : null;
  } catch {
    // A stray line that is not JSON must not end the run. The binary prints its log lines on
    // stderr, but a tool the agent runs can still write to the shared stdout.
    return null;
  }
}

export function parseCodexLine(line: string): RunEvent[] {
  const event = read(line);
  switch (event?.type) {
    case 'thread.started':
      // The stream names neither the model nor the login, so both stay null. The card's own row
      // holds the model it asked for, and nothing here claims to know how the run signed in.
      return [{ type: 'session', sessionId: event.thread_id ?? '', model: null, apiKeyMode: null }];
    // Only the completed item is read. `item.started` carries the same item without its answer, so
    // reading both would put every command in the log twice.
    case 'item.completed': {
      const item = event.item ?? {};
      if (item.type === 'agent_message') return [{ type: 'text', text: item.text ?? '' }];
      // A warning, such as a requirement this version ignores, printed at the start of every run.
      // It is no tool, and as text it would join what the run said, so only the log shows it
      // (`codexWarning`).
      if (item.type === 'error') return [];
      // A command the agent ran, a file it changed, or an item type this version has never seen.
      // Each is shown as the tool it is, named as the engine names it, with the item as its input,
      // so a new item type reaches the log tab instead of disappearing from it.
      if (item.type === undefined) return [];
      const tool: RunEvent = { type: 'tool', name: item.type, input: item };
      // A command's output is the one tool result this stream carries. A file change names its
      // paths and gives nothing back.
      if (item.type !== 'command_execution' || typeof item.aggregated_output !== 'string') return [tool];
      const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
      return [tool, { type: 'tool_result', bytes: Buffer.byteLength(item.aggregated_output), error: exit !== null && exit !== 0, lines: lineCount(item.aggregated_output) }];
    }
    case 'turn.completed': {
      const usage = event.usage ?? {};
      return [
        {
          type: 'complete',
          // Codex reports token counts and no cost. Null and not zero, so a run's cost reads as
          // missing rather than as nothing spent.
          costUsd: null,
          // The stream carries no duration either, so the run reports none. The row still stamps
          // when it started and when it ended, which is where a person reads the time.
          durationMs: null,
          tokens: {
            // The counts are what the engine calls them: `input_tokens` already holds the cached
            // ones, the way Claude Code's do not, so a reader adding the two would count twice.
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cached_input_tokens ?? 0,
            cacheCreation: usage.cache_write_input_tokens ?? 0,
          },
        },
      ];
    }
    // The turn's own failure, such as a model at capacity, and the process exits 1 after it. As the
    // run's result it keeps Codex's sentence, where the exit code alone said nothing, and `retryable`
    // reads that sentence. The `error` line before it says the same and is not read.
    case 'turn.failed':
      return [{ type: 'failed', reason: event.error?.message || 'The turn failed, and Codex gave no reason.', status: null }];
    case CODEX_DENIED:
      return [{ type: 'permission_denied', denied: [{ tool: event.tool ?? '', id: null, path: null }] }];
    default:
      return [];
  }
}

// The text of a warning item, for the Log tab, or null for any other line.
export function codexWarning(line: string): string | null {
  // Most lines are no warning, and the Log tab reads every line, so the parse waits for the word.
  const item = line.includes('"error"') ? read(line)?.item : undefined;
  return item?.type === 'error' && typeof item.message === 'string' ? item.message : null;
}

// Escape sequences the binary colours its log with. They sit inside the words, so a match on the
// sentence has to drop them first.
// eslint-disable-next-line no-control-regex -- the escape character is what has to be matched here
const COLOUR = /\u001B\[[0-9;]*m/g;
// What a refused tool looks like on stderr, measured on 2026-09-25: `patch rejected: writing is
// blocked by read-only sandbox; rejected by user approval settings`. The word before "rejected" is
// the tool. Only a refused write has been seen, so a refused command may read differently.
const REFUSED = /(\w+) rejected: [^\n]*/g;

/**
 * The lines Nolzu adds to the stream for the tools the sandbox refused.
 *
 * A refusal is not in the JSON stream and the process still exits 0, so the adapter reads it off
 * stderr. The sentence goes into the run log as a line of its own, which is why this returns lines
 * and not events: the log keeps the engine's own words, and the parser turns them into the same
 * `permission_denied` event a Claude refusal produces.
 *
 * The same refusal repeated says nothing twice, so each distinct sentence gives one line.
 */
export function codexRefusals(stderr: string): string[] {
  const seen = new Set<string>();
  for (const [sentence, tool] of stderr.replace(COLOUR, '').matchAll(REFUSED)) {
    seen.add(JSON.stringify({ type: CODEX_DENIED, tool, text: sentence }));
  }
  return [...seen];
}
