import { lineCount, type RunEvent } from '@nolzu/protocol';

// What one tool call carries. The tool is the object's own key, such as `editToolCall`, so the
// shape below is what sits under that key and not the line itself.
interface ToolBody {
  result?: {
    // What the tool gave back, when it worked: a read's text under `content`, other fields for other
    // tools, measured on 2026-09-25.
    success?: { content?: unknown; [field: string]: unknown };
    // A tool the engine refused. An edit answers under `error`, a shell command under `rejected`,
    // both measured on 2026-09-25.
    error?: { error?: string; path?: string };
    rejected?: { command?: string; reason?: string };
  };
}

// The fields Nolzu reads from `cursor-agent -p --output-format stream-json`. Measured against
// Cursor CLI 2026.09.23-86fc751 and written down in docs/engines/cursor.md. The binary prints types
// this version has never seen, `interaction_query` among them, so an unknown type produces no event
// rather than ending the run.
interface CursorLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  // "login" on a subscription login. The only value seen so far.
  apiKeySource?: string;
  call_id?: string;
  message?: { content?: { type?: string; text?: string }[] };
  // One object, keyed by the tool's own name, beside the engine's own bookkeeping fields.
  tool_call?: Record<string, ToolBody | unknown>;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

function read(line: string): CursorLine | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as CursorLine) : null;
  } catch {
    // A stray line that is not JSON must not end the run. A tool the agent starts writes to the
    // same stdout.
    return null;
  }
}

const firstText = (...values: (string | undefined)[]): string | null => values.find((value) => value !== undefined && value !== '') ?? null;

// The tool a call belongs to. The engine keys the call by the tool's own name and puts its own
// fields, `toolCallId` and the timestamps, beside it. The suffix is the whole rule: the tool key has
// come first in every recorded run, nothing promises that order, and a first-key reader would name
// `hookAdditionalContexts` as the tool the day it changed. An object with no such key is a shape
// this version does not know, and a name guessed from it would be worse than no line in the log.
function toolName(call: Record<string, unknown>): string | null {
  return Object.keys(call).find((key) => key.endsWith('ToolCall')) ?? null;
}

export function parseCursorLine(line: string): RunEvent[] {
  const event = read(line);
  switch (event?.type) {
    case 'system':
      if (event.subtype !== 'init') return [];
      return [
        {
          type: 'session',
          sessionId: event.session_id ?? '',
          // The engine names the model it settled on, such as "Claude Opus 5.5 300K Medium", which
          // is the label and not the id the card asked for. The row shows what the run reports.
          model: event.model ?? null,
          // "login" is the subscription, and it is the one value measured. Nolzu drops
          // CURSOR_API_KEY from the child environment, so anything else is a source this version
          // has not seen and nothing claims to know what it means.
          apiKeyMode: event.apiKeySource === undefined ? null : event.apiKeySource !== 'login',
        },
      ];
    case 'assistant':
      return (event.message?.content ?? []).flatMap((block): RunEvent[] => (block.type === 'text' ? [{ type: 'text', text: block.text ?? '' }] : []));
    // Only the completed call is read. The started one carries the same object without its answer,
    // so reading both would put every tool in the log twice.
    case 'tool_call': {
      if (event.subtype !== 'completed') return [];
      const call = event.tool_call ?? {};
      const name = toolName(call);
      if (name === null) return [];
      const body = (call[name] ?? {}) as ToolBody;
      const tool: RunEvent = { type: 'tool', name, input: body };
      const refusal = body.result?.error ?? body.result?.rejected;
      if (refusal === undefined) {
        const answer = body.result?.success;
        if (answer === undefined) return [tool];
        // The text where the tool gave text, else the answer as the engine wrote it. Only text has
        // lines a person would count.
        const text = typeof answer.content === 'string' ? answer.content : JSON.stringify(answer);
        return [tool, { type: 'tool_result', bytes: Buffer.byteLength(text), error: false, ...(typeof answer.content === 'string' ? { lines: lineCount(text) } : {}) }];
      }
      // A refused tool is named and not failed: the engine refuses a call by design, and the phase
      // carries on. A refused command carries the command, and a refused edit carries an empty path
      // and no arguments at all, measured on 2026-09-25, so such a line names the tool and no file.
      return [
        tool,
        {
          type: 'permission_denied',
          denied: [{ tool: name, id: firstText(event.call_id), path: firstText(body.result?.error?.path, body.result?.rejected?.command) }],
        },
      ];
    }
    case 'result': {
      const usage = event.usage ?? {};
      if (event.subtype === 'success' && event.is_error !== true) {
        return [
          {
            type: 'complete',
            // Nothing in the stream reports a cost. Null and not zero, so a run's cost reads as
            // missing rather than as nothing spent.
            costUsd: null,
            durationMs: event.duration_ms ?? null,
            tokens: {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cacheRead: usage.cacheReadTokens ?? 0,
              cacheCreation: usage.cacheWriteTokens ?? 0,
            },
          },
        ];
      }
      // The stream carries no status number, so a failure reports the text and no status.
      return [{ type: 'failed', reason: firstText(event.result, event.subtype) ?? 'error', status: null }];
    }
    default:
      return [];
  }
}

// What a free Cursor plan says on stderr when a run names a model. Measured on 2026-09-25:
// `ActionRequiredError: Named models unavailable Free plans can only use Auto.`
const FREE_PLAN = /Named models unavailable/;

/**
 * The sentence a failed run gets instead of the engine's own.
 *
 * A free Cursor plan runs the Auto model only, and Nolzu never asks for Auto, because Auto lets the
 * vendor change the model inside the run. So every card on a free login fails the same way, after
 * two stream lines nobody reads. This names that state rather than leaving a person with an error
 * class and a stack.
 */
export function cursorFailure(stderr: string): string | null {
  if (!FREE_PLAN.test(stderr)) return null;
  return 'This Cursor login is on a free plan, which runs the Auto model only. Nolzu names a model for every run, so no card can run on this login. Upgrade the plan, or run this card on another engine.';
}
