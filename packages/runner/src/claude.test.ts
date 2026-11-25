import type { RunEvent } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { parseClaudeLine } from './claude.ts';

const usage = { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 5600, cache_creation_input_tokens: 800 };

it.each<[string, object, RunEvent[]]>([
  [
    'system init to session',
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'sonnet', cwd: '/workspace/recipe-app', tools: ['Read'] },
    [{ type: 'session', sessionId: 'sess-1', model: 'sonnet', apiKeyMode: false }],
  ],
  [
    'an init that reports no API key source to a session on the subscription login',
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'sonnet', apiKeySource: 'none' },
    [{ type: 'session', sessionId: 'sess-1', model: 'sonnet', apiKeyMode: false }],
  ],
  [
    'an init that names an API key source to a session in API key mode',
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'sonnet', apiKeySource: 'ANTHROPIC_API_KEY' },
    [{ type: 'session', sessionId: 'sess-1', model: 'sonnet', apiKeyMode: true }],
  ],
  [
    'assistant blocks to text and tool, in order',
    {
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the list first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/recipes/list.ts' } },
        ],
      },
      parent_tool_use_id: null,
    },
    [
      { type: 'text', text: 'Reading the list first.' },
      { type: 'tool', name: 'Read', input: { file_path: 'src/recipes/list.ts' } },
    ],
  ],
  [
    'system api_retry to api_retry, with the reason the engine gave',
    { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' },
    [{ type: 'api_retry', attempt: 2, delayMs: 4000, status: 529, maxRetries: 10, reason: 'overloaded' }],
  ],
  [
    'an api_retry that reports neither a cap nor a reason',
    { type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 2000, error_status: null },
    // Null and not zero: another engine may report no cap at all, and zero would read as a
    // cap of none rather than as a number nobody sent.
    [{ type: 'api_retry', attempt: 1, delayMs: 2000, status: null, maxRetries: null, reason: null }],
  ],
  [
    'a success result to complete',
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      duration_ms: 1234,
      num_turns: 3,
      result: 'Done.',
      total_cost_usd: 0.012,
      usage,
      session_id: 'sess-1',
    },
    [{ type: 'complete', costUsd: 0.012, durationMs: 1234, tokens: { input: 12, output: 340, cacheRead: 5600, cacheCreation: 800 }, sessionTotal: true }],
  ],
  [
    'an error result to failed with the API status',
    { type: 'result', subtype: 'success', is_error: true, api_error_status: 529, duration_ms: 9000, result: 'API Error: 529 Overloaded', total_cost_usd: 0, usage, session_id: 'sess-1' },
    // The work before the error was real money, so it rides with the failure.
    [{ type: 'failed', reason: 'API Error: 529 Overloaded', status: 529, costUsd: 0, durationMs: 9000, tokens: { input: 12, output: 340, cacheRead: 5600, cacheCreation: 800 }, sessionTotal: true }],
  ],
  [
    'an error subtype to failed',
    { type: 'result', subtype: 'error_max_turns', is_error: false, api_error_status: null, duration_ms: 9000, total_cost_usd: 0.3, usage, session_id: 'sess-1' },
    [{ type: 'failed', reason: 'error_max_turns', status: null, costUsd: 0.3, durationMs: 9000, tokens: { input: 12, output: 340, cacheRead: 5600, cacheCreation: 800 }, sessionTotal: true }],
  ],
  [
    // The shape a real run wrote, with the share of each window. `status` and the top-level
    // `resetsAt` are the documented fields and belong to the window `rateLimitType` names, so that
    // window carries them and the other one says nothing about its status. The line recorded in
    // `docs/engines/claude-code.md` carries no top-level `resetsAt`, so that field is this
    // fixture's own and the case below is what holds the order the two are read in.
    'a rate limit notice to one event carrying both windows',
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1789551000,
        unifiedWindows: {
          five_hour: { utilization: 0.62, resetsAt: 1789551000 },
          seven_day: { utilization: 0.41, resetsAt: 1789830000 },
        },
      },
      session_id: 'sess-1',
    },
    [
      {
        type: 'rate_limit',
        windows: [
          { name: 'five_hour', used: 0.62, resetsAt: 1789551000, status: 'allowed' },
          { name: 'seven_day', used: 0.41, resetsAt: 1789830000, status: null },
        ],
      },
    ],
  ],
  [
    'a rate limit notice that carries only the five hour window',
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1789551000 } } },
      session_id: 'sess-1',
    },
    [{ type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.08, resetsAt: 1789551000, status: null }] }],
  ],
  [
    // A missing reset time used to be written as 0, which reads as 1 January 1970 on the screen.
    'a window with no reset time to a window whose reset time is nothing',
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.4 } } },
      session_id: 'sess-1',
    },
    [{ type: 'rate_limit', windows: [{ name: 'seven_day', used: 0.4, resetsAt: null, status: null }] }],
  ],
  [
    // Overage takes an account past its window, so the share is kept as the engine gave it.
    'a share above one to the share itself',
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789551000, unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: 1789551000 } } },
      session_id: 'sess-1',
    },
    [{ type: 'rate_limit', windows: [{ name: 'five_hour', used: 1.4, resetsAt: 1789551000, status: 'rejected' }] }],
  ],
  [
    // The documented fields alone. `unifiedWindows` is marked internal by the binary, so a block
    // reported without it still has to reach the screen, with no share invented for it.
    'a block with no unifiedWindows to the window the documented fields name',
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1789830000 },
      session_id: 'sess-1',
    },
    [{ type: 'rate_limit', windows: [{ name: 'seven_day', used: null, resetsAt: 1789830000, status: 'rejected' }] }],
  ],
  [
    // A block whose reset time the engine left out. The screen has a state for it.
    'a block with no reset time at all to a window that says so',
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      session_id: 'sess-1',
    },
    [{ type: 'rate_limit', windows: [{ name: 'five_hour', used: null, resetsAt: null, status: 'rejected' }] }],
  ],
  [
    // The two have agreed in every line recorded here. They are set apart on purpose, because the
    // documented field is the one Nolzu trusts and no test would otherwise say which wins.
    'a reset time the two fields disagree on to the documented one',
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1789551000, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1111111111 } } },
      session_id: 'sess-1',
    },
    [{ type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.3, resetsAt: 1789551000, status: 'allowed' }] }],
  ],
  [
    // The guard that keeps a quiet line from replacing the last real reading with a blank one. The
    // window is named and allowed, and it still carries no share and no reset time.
    'a window that is named and allowed but says nothing else to no event',
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, session_id: 'sess-1' },
    [],
  ],
  [
    // A refusal on a window this version has never seen. Dropping it for its name would leave the
    // screen saying the account is fine at 14% while every run is refused.
    'a refused window this version does not know to a window under the name the engine gave it',
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'opus_seven_day',
        resetsAt: 1789830000,
        unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: 1789551000 }, seven_day: { utilization: 0.14, resetsAt: 1789830000 } },
      },
      session_id: 'sess-1',
    },
    [
      {
        type: 'rate_limit',
        windows: [
          { name: 'five_hour', used: 0.14, resetsAt: 1789551000, status: null },
          { name: 'seven_day', used: 0.14, resetsAt: 1789830000, status: null },
          { name: 'opus_seven_day', used: null, resetsAt: 1789830000, status: 'rejected' },
        ],
      },
    ],
  ],
  [
    'a rate limit notice with no windows at all to no event',
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: 'sess-1' },
    [],
  ],
])('maps %s', (_, line, events) => {
  expect(parseClaudeLine(JSON.stringify(line))).toEqual(events);
});

it('ignores unknown types and lines that are not JSON', () => {
  expect(parseClaudeLine(JSON.stringify({ type: 'stream_event', event: {} }))).toEqual([]);
  expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))).toEqual([]);
  expect(parseClaudeLine('not json')).toEqual([]);
  expect(parseClaudeLine('null')).toEqual([]);
});

it('names a refused tool rather than saying nothing at all', () => {
  // An unknown system subtype produces no event, so a run whose writes were all refused used to
  // end complete with nothing on disk and nothing said about it.
  const events = parseClaudeLine('{"type":"system","subtype":"permission_denied","tool_name":"Write"}');

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('permission_denied');
  expect(events[0]?.type === 'permission_denied' && events[0].denied).toEqual([{ tool: 'Write', id: null, path: null }]);
});

it("keeps the engine's reason for a refusal", () => {
  // Lines as Claude Code 2.1.310 wrote them. For a path outside the working folders the message asks
  // for a grant that a run with nobody to ask cannot get, so the plain reason wins where both are there.
  const outside = parseClaudeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Glob',
      tool_use_id: 'toolu_1',
      decision_reason_type: 'workingDir',
      decision_reason: 'Path is outside allowed working directories',
      message: "Claude requested permissions to read from /tmp/demo/.nolzu/knowledge, but you haven't granted it yet.",
    }),
  );
  const chained = parseClaudeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      decision_reason_type: 'subcommandResults',
      message: 'This Bash command contains multiple operations. The following part requires approval: kill %1',
    }),
  );
  const blank = parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', decision_reason: ' ', message: '' }));

  expect(outside[0]?.type === 'permission_denied' && outside[0].denied).toEqual([{ tool: 'Glob', id: 'toolu_1', path: null, reason: 'Path is outside allowed working directories' }]);
  expect(chained[0]?.type === 'permission_denied' && chained[0].denied[0]?.reason).toBe('This Bash command contains multiple operations. The following part requires approval: kill %1');
  expect(blank[0]?.type === 'permission_denied' && blank[0].denied).toEqual([{ tool: 'Bash', id: null, path: null }]);
});

it('says nothing when a refusal names no tool', () => {
  // A line naming no tool tells a reader nothing, so it produces nothing, and a result entry with
  // no name behaves the same way rather than differently.
  expect(parseClaudeLine('{"type":"system","subtype":"permission_denied"}')).toEqual([]);
  const onResult = parseClaudeLine(
    '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":10,"usage":{},"permission_denials":[{}]}',
  );
  expect(onResult.map((event) => event.type)).toEqual(['complete']);
});

it('carries a refusal on the result line without losing the cost', () => {
  // A hook's refusal is reported only on the result line, and that line still says success. The
  // refusal must not replace the result: the run did its work and the cost is real.
  const line =
    '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.04,"duration_ms":1200,' +
    '"usage":{"input_tokens":9,"output_tokens":412},"permission_denials":[' +
    '{"tool_name":"Write","tool_use_id":"toolu_1","tool_input":{"file_path":"/tmp/demo/worktrees/APP-1/stray.txt"}},' +
    '{"tool_name":"Bash","tool_use_id":"toolu_2","tool_input":{"command":"rm -rf src"}}]}';
  const events = parseClaudeLine(line);

  expect(events.map((event) => event.type)).toEqual(['permission_denied', 'complete']);
  // The path is what makes the log readable: which write was refused, not just that one was.
  expect(events[0]?.type === 'permission_denied' && events[0].denied).toEqual([
    { tool: 'Write', id: 'toolu_1', path: '/tmp/demo/worktrees/APP-1/stray.txt' },
    { tool: 'Bash', id: 'toolu_2', path: 'rm -rf src' },
  ]);
  expect(events[1]?.type === 'complete' && events[1].costUsd).toBe(0.04);
});

it('keeps the refusal when the run itself ended badly', () => {
  // A run that hit its turn limit still reports what it was refused, and that is the run somebody
  // is most likely to be looking into.
  const line =
    '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"max turns",' +
    '"permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_9","tool_input":{"file_path":"/tmp/x"}}]}';
  const events = parseClaudeLine(line);

  expect(events.map((event) => event.type)).toEqual(['permission_denied', 'failed']);
  expect(events[0]?.type === 'permission_denied' && events[0].denied[0]?.tool).toBe('Write');
});

// A result line with no cost field at all. Nought would be a figure the engine never gave, and the
// spend roll-ups would then add it and call the total complete.
it('reports no cost when the result line carries none', () => {
  const events = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"usage":{}}');

  expect(events[0]?.type === 'complete' && events[0].costUsd).toBeNull();
});

// The same rule for the other two numbers on that line. A nought duration is printed as "0s" on the
// phase trail, and four nought counts make the total say a run "reports tokens only" when it
// reported nothing at all.
it('reports no duration and no counts where the result line carries neither', () => {
  const [event] = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.02}');

  expect(event?.type === 'complete' && event.durationMs).toBeNull();
  expect(event?.type === 'complete' && event.tokens).toBeNull();
});

// An empty usage block is the engine answering nought, which is not the same as not answering.
it('reports nought counts where the usage block is there and empty', () => {
  const [event] = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.02,"usage":{}}');

  expect(event?.type === 'complete' && event.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
});

it('reports nothing about permissions when nothing was refused', () => {
  const events = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":10,"usage":{}}');

  expect(events.map((event) => event.type)).toEqual(['complete']);
});

// The shape of two lines Claude Code 2.1.296 printed, with the ids, the path and the text replaced by
// the demo's own. Every field the parser reads is where the binary put it.
const CALL =
  '{"type":"assistant","message":{"id":"msg_01Rcp7ListA","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"toolu_01RcpRead","name":"Read","input":{"file_path":"services/api/src/recipes/list.ts"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":39324,"cache_read_input_tokens":26274,"output_tokens":113,"output_tokens_details":{"thinking_tokens":58},"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"sess-1"}';
const RESULT =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01RcpRead","content":"export function listRecipes(recipes) {\\n  return recipes;\\n}\\n"}]},"parent_tool_use_id":null,"session_id":"sess-1"}';

it('reads the counts of a model call off its assistant line, after what the call said', () => {
  expect(parseClaudeLine(CALL)).toEqual([
    { type: 'tool', name: 'Read', input: { file_path: 'services/api/src/recipes/list.ts' } },
    { type: 'usage', id: 'msg_01Rcp7ListA', tokens: { input: 2, output: 113, cacheRead: 26274, cacheCreation: 39324 } },
  ]);
});

// A call with text and a tool arrives as two lines with the same id and the same counts. The id is
// what lets the reader count it once.
it('names the call on every line of it, so a reader counts it once', () => {
  const text = CALL.replace('[{"type":"tool_use","id":"toolu_01RcpRead","name":"Read","input":{"file_path":"services/api/src/recipes/list.ts"}}]', '[{"type":"text","text":"Reading the list."}]');
  const ids = [CALL, text].flatMap((line) => parseClaudeLine(line)).flatMap((event) => (event.type === 'usage' ? [event.id] : []));

  expect(ids).toEqual(['msg_01Rcp7ListA', 'msg_01Rcp7ListA']);
});

it('makes no usage event for an assistant line with no usage on it', () => {
  const line = { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the list first.' }] } };
  expect(parseClaudeLine(JSON.stringify(line))).toEqual([{ type: 'text', text: 'Reading the list first.' }]);
});

it('reads a tool result as its size in bytes and its lines, never its text', () => {
  expect(parseClaudeLine(RESULT)).toEqual([{ type: 'tool_result', bytes: 59, error: false, lines: 3 }]);
});

// A screenshot comes back as a picture, which has a size and no lines.
it('names no lines for a result that is only a picture', () => {
  const line = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'image', source: { type: 'base64', data: 'iVBORw0K' } }] }] } };
  expect(parseClaudeLine(JSON.stringify(line))).toEqual([{ type: 'tool_result', bytes: 8, error: false }]);
});

it('counts a result given as blocks, and says when the engine marked it an error', () => {
  const line = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [{ type: 'text', text: 'File not found.' }, { type: 'text', text: 'é' }] },
        { type: 'text', text: 'A line the person typed is no tool result.' },
      ],
    },
  };
  // "é" is two bytes, so the size is the bytes and not the characters.
  expect(parseClaudeLine(JSON.stringify(line))).toEqual([{ type: 'tool_result', bytes: 17, error: true, lines: 2 }]);
});
