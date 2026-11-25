import { type DeniedTool, lineCount, type RunEvent, type RunTokens } from '@nolzu/protocol';

// The fields Nolzu reads from `claude -p --output-format stream-json --verbose`.
interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    // The model call's own id. Claude Code writes one line per content block of a call, each with
    // the same id and the call's whole usage.
    id?: string;
    content?: {
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      // On a tool result, in a `user` line: a string, or blocks of text and images.
      content?: unknown;
      is_error?: boolean;
    }[];
    usage?: ClaudeLine['usage'];
  };
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: string; command?: string; notebook_path?: string };
  // Why a refusal's own line was refused. Its `message` says it too, as a string there.
  decision_reason?: string;
  permission_denials?: { tool_name?: string; tool_use_id?: string; tool_input?: { file_path?: string; command?: string; notebook_path?: string } }[];
  // "none" on a subscription login, and the name of the key source when one is set.
  apiKeySource?: string;
  rate_limit_info?: {
    // The documented three. `status` and `resetsAt` belong to the window `rateLimitType` names.
    status?: string;
    rateLimitType?: string;
    resetsAt?: number;
    // Marked internal by the binary, and the only place a per-window share is written. Read after
    // the documented fields, never over them.
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
  };
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// The counts, or null where the line carried no usage block at all. Null and not four zeros: a run
// that reported nothing is not a run that used nothing, and the roll-ups keep the two apart.
function countsOf(usage: ClaudeLine['usage']): RunTokens | null {
  if (usage === undefined) return null;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
  };
}

// The path is what makes a refusal readable: a file for a write, a command for a shell call, the
// notebook for a notebook edit. A refusal's own line carries no input at all, so its path is null
// and the entry on the result line is the one that names the file. The id matches, so a reader can
// put the two together. Only the refusal's own line says why. The plain reason comes before the
// message, which for a path outside the working folders asks for a grant nobody can give a run.
function denialOf(entry: {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: string; command?: string; notebook_path?: string };
  decision_reason?: string;
  message?: unknown;
}): DeniedTool {
  const reason = [entry.decision_reason, entry.message].find((one): one is string => typeof one === 'string' && one.trim() !== '');
  return {
    tool: entry.tool_name ?? '',
    id: entry.tool_use_id ?? null,
    path: entry.tool_input?.file_path ?? entry.tool_input?.command ?? entry.tool_input?.notebook_path ?? null,
    ...(reason === undefined ? {} : { reason: reason.trim() }),
  };
}

// The size of what a tool gave back. A string is its bytes; blocks count their text and the data of
// an image, which is what the model was sent.
function resultBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce<number>((sum, block: { text?: unknown; source?: { data?: unknown } } | null) => {
    const text = block?.text ?? block?.source?.data;
    return sum + (typeof text === 'string' ? Buffer.byteLength(text) : 0);
  }, 0);
}

// The lines of the text in an answer. A picture has no lines, so an answer with no text names none.
function resultLines(content: unknown): { lines?: number } {
  if (typeof content === 'string') return { lines: lineCount(content) };
  const texts = Array.isArray(content) ? content.flatMap((block: { text?: unknown } | null) => (typeof block?.text === 'string' ? [block.text] : [])) : [];
  return texts.length === 0 ? {} : { lines: texts.reduce((sum, text) => sum + lineCount(text), 0) };
}

function read(line: string): ClaudeLine | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as ClaudeLine) : null;
  } catch {
    // A stray line that is not JSON must not end the run.
    return null;
  }
}

// Types Nolzu does not know yet produce no event.
export function parseClaudeLine(line: string): RunEvent[] {
  const event = read(line);
  switch (event?.type) {
    case 'system':
      if (event.subtype === 'init') {
        return [
          {
            type: 'session',
            sessionId: event.session_id ?? '',
            model: event.model ?? '',
            // The engine reports "none" when it used the subscription login, so only a named
            // source counts as API-key mode.
            apiKeyMode: event.apiKeySource !== undefined && event.apiKeySource !== 'none',
          },
        ];
      }
      if (event.subtype === 'api_retry') {
        return [
          {
            type: 'api_retry',
            attempt: event.attempt ?? 0,
            delayMs: event.retry_delay_ms ?? 0,
            status: event.error_status ?? null,
            maxRetries: event.max_retries ?? null,
            reason: event.error ?? null,
          },
        ];
      }
      // A refusal the engine reports here is named, not failed. A correct hook refuses a stray
      // write and the phase carries on, so failing the run would fail a healthy one. The refusals
      // also arrive on the result line, which is where a hook's are reported.
      if (event.subtype === 'permission_denied') {
        // A line naming no tool says nothing a reader can use, so it produces nothing, the same as
        // a result entry with no name.
        if (event.tool_name === undefined) return [];
        return [{ type: 'permission_denied', denied: [denialOf(event)] }];
      }
      return [];
    case 'rate_limit_event': {
      const info = event.rate_limit_info;
      const reported = info?.unifiedWindows ?? {};
      // The two known windows first, in a fixed order, so the log row reads the same way every time
      // whatever order the engine wrote the keys in. Any other window the line names comes after
      // them: a refusal on a window this version has never seen has to reach the screen, or the
      // screen would say the account is fine on the two it does know.
      const mentioned = [...Object.keys(reported), ...(info?.rateLimitType === undefined ? [] : [info.rateLimitType])];
      const windows = [...new Set(['five_hour', 'seven_day', ...mentioned])].flatMap((name) => {
        const window = reported[name];
        // The documented fields describe the window `rateLimitType` names, so only that window
        // takes them. The other one carries no status rather than the status of its neighbour.
        const named = info?.rateLimitType === name;
        const status = named ? (info?.status ?? null) : null;
        const resetsAt = (named ? info?.resetsAt : undefined) ?? window?.resetsAt ?? null;
        const used = window?.utilization ?? null;
        // A window with no share, no reset time and nothing said against it carries no reading, and
        // storing it would replace the last real one with a blank. A status that is not "allowed" is
        // a reading on its own: the account is at its limit, whatever else is missing.
        if (used === null && resetsAt === null && (status === null || status === 'allowed')) return [];
        return [{ name, used, resetsAt, status }];
      });
      // A notice with no window says nothing, and an empty event would put a blank row in
      // the log tab.
      return windows.length === 0 ? [] : [{ type: 'rate_limit', windows }];
    }
    case 'assistant': {
      const said = (event.message?.content ?? []).flatMap((block): RunEvent[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text ?? '' }];
        if (block.type === 'tool_use') return [{ type: 'tool', name: block.name ?? '', input: block.input }];
        return [];
      });
      // The counts of the call, after what it said. No cost rides here: Claude Code names its cost on
      // the result line alone, so a running cost would be a figure worked out from a price list.
      const counts = countsOf(event.message?.usage);
      return counts === null ? said : [...said, { type: 'usage', id: event.message?.id ?? null, tokens: counts }];
    }
    // What the tools gave back. The text is the project's and stays in the log file; the event says
    // how much came back.
    case 'user':
      return (event.message?.content ?? []).flatMap((block): RunEvent[] =>
        block.type === 'tool_result' ? [{ type: 'tool_result', bytes: resultBytes(block.content), error: block.is_error === true, ...resultLines(block.content) }] : [],
      );
    case 'result': {
      // A hook's refusal is reported only here, and the run still says success, so the refusals
      // ride with the result rather than replacing it: a run refused one stray write has still
      // done its work and still has a cost and tokens worth keeping.
      const refused = (event.permission_denials ?? []).flatMap((entry) => (entry.tool_name === undefined ? [] : [denialOf(entry)]));
      const denied: RunEvent[] = refused.length === 0 ? [] : [{ type: 'permission_denied', denied: refused }];
      // An API error that outlasts the retries still reports subtype success, with is_error set.
      if (event.subtype === 'success' && !event.is_error) {
        return [
          ...denied,
          {
            type: 'complete',
            // Null and not nought, the way Codex reports it. A nought here would be a
            // cost this engine never named, and every roll-up above would add it as a real figure.
            costUsd: event.total_cost_usd ?? null,
            durationMs: event.duration_ms ?? null,
            tokens: countsOf(event.usage),
            // A resumed session reports what the whole session cost, while `usage` is this run's.
            // Measured on 2.1.3xx: a QA run resumed with an answer reported $0.19, its first run's
            // $0.15 included.
            sessionTotal: true,
          },
        ];
      }
      // The error line carries the cost and the counts of the work that was done before it failed,
      // so they ride with the failure. Without them that money leaves every roll-up.
      return [
        ...denied,
        {
          type: 'failed',
          reason: event.result || event.subtype || 'error',
          status: event.api_error_status ?? null,
          costUsd: event.total_cost_usd ?? null,
          durationMs: event.duration_ms ?? null,
          tokens: countsOf(event.usage),
          sessionTotal: true,
        },
      ];
    }
    default:
      return [];
  }
}
