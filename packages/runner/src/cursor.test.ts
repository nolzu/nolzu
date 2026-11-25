import { expect, it } from 'vitest';
import { cursorFailure, parseCursorLine } from './cursor.ts';

// The shapes below are the ones the binary printed on 2026-09-25, with the ids and the paths
// shortened. The whole point of the file is that a recorded line keeps reading the same way after a
// change here, so nothing in it is invented.

const INIT =
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/app/worktrees/APP-1","session_id":"a2e5f188","model":"Auto","permissionMode":"default"}';

it('reads the session out of the first line', () => {
  expect(parseCursorLine(INIT)).toEqual([{ type: 'session', sessionId: 'a2e5f188', model: 'Auto', apiKeyMode: false }]);
});


// The engine says where the run's login came from, and "login" is the subscription. A line without
// the field says nothing about it, and null is how the row shows that, because false would claim the
// run used a subscription nobody reported.
it('claims nothing about a login the line does not name', () => {
  const line = '{"type":"system","subtype":"init","cwd":"/tmp/app/worktrees/APP-1","session_id":"8d2d","model":"Auto","permissionMode":"default"}';
  expect(parseCursorLine(line)).toEqual([{ type: 'session', sessionId: '8d2d', model: 'Auto', apiKeyMode: null }]);
});

it('gives the agent’s answer as text', () => {
  const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Plan mode is on."}]},"model_call_id":"f166"}';
  expect(parseCursorLine(line)).toEqual([{ type: 'text', text: 'Plan mode is on.' }]);
});

// The tool is the object's own key, and the engine's own fields sit beside it. A parser that read a
// `name` field would name every tool the empty string.
it('names a tool by its own key', () => {
  const line =
    '{"type":"tool_call","subtype":"completed","call_id":"call-24","tool_call":{"readToolCall":{"args":{"path":"/tmp/app/a.txt"},"result":{"success":{"content":"hello"}}},"hookAdditionalContexts":[],"toolCallId":"call-24","startedAtMs":"1790342441922"}}';
  expect(parseCursorLine(line)).toEqual([
    { type: 'tool', name: 'readToolCall', input: { args: { path: '/tmp/app/a.txt' }, result: { success: { content: 'hello' } } } },
    { type: 'tool_result', bytes: 5, error: false, lines: 1 },
  ]);
});

// The tool key has come first in every recorded run, and the engine's own fields follow it. Nothing
// promises that order, and a parser that took the first key would name `hookAdditionalContexts` as
// the tool the day it changed.
it('finds the tool wherever the engine put it in the object', () => {
  const line =
    '{"type":"tool_call","subtype":"completed","call_id":"call-9","tool_call":{"hookAdditionalContexts":[],"toolCallId":"call-9","globToolCall":{"args":{"path":"/tmp/app"},"result":{"success":{"files":["a.txt"]}}}}}';
  expect(parseCursorLine(line).flatMap((event) => (event.type === 'tool' ? [event.name] : []))).toEqual(['globToolCall']);
});

// Both lines carry the same object, and the started one has no answer in it yet.
it('reads the completed call and not the started one', () => {
  const started = '{"type":"tool_call","subtype":"started","call_id":"call-24","tool_call":{"readToolCall":{"args":{"path":"/tmp/app/a.txt"}}}}';
  expect(parseCursorLine(started)).toEqual([]);
});

// Plan mode refused the edit and the run carried on with exit 0. The refusal is only here, so a
// parser that missed it would leave the card saying the file was written. The engine names no file:
// the recorded line carries an empty path and no arguments at all, so the event names the tool and
// nothing more.
it('names a write plan mode refused, and keeps the call in the log', () => {
  const line =
    '{"type":"tool_call","subtype":"completed","call_id":"call-65","tool_call":{"editToolCall":{"result":{"error":{"path":"","error":"Cannot edit non markdown files in plan mode","modelVisibleError":"Cannot edit non markdown files in plan mode"}}},"toolCallId":"call-65"}}';
  const events = parseCursorLine(line);
  expect(events.map((event) => event.type)).toEqual(['tool', 'permission_denied']);
  expect(events.at(-1)).toEqual({ type: 'permission_denied', denied: [{ tool: 'editToolCall', id: 'call-65', path: null }] });
});

// A refused shell call answers under another key, and it carries the command. Two shapes, one
// event, so the log reads a refusal the same way whichever tool was refused.
it('names a command the engine refused, with the command', () => {
  const line =
    '{"type":"tool_call","subtype":"completed","call_id":"call-57","tool_call":{"shellToolCall":{"result":{"rejected":{"command":"ls -1","workingDirectory":"/tmp/app","reason":"","isReadonly":false}}},"toolCallId":"call-57"}}';
  expect(parseCursorLine(line).at(-1)).toEqual({ type: 'permission_denied', denied: [{ tool: 'shellToolCall', id: 'call-57', path: 'ls -1' }] });
});

// A tool that did its work is not a refusal, and a run of clean tools must report none.
it('leaves a tool that worked alone', () => {
  const line = '{"type":"tool_call","subtype":"completed","call_id":"call-1","tool_call":{"editToolCall":{"args":{"path":"/tmp/app/n.md"},"result":{"success":{"linesAdded":1}}}}}';
  expect(parseCursorLine(line).map((event) => event.type)).toEqual(['tool', 'tool_result']);
});

it('ends the run with the tokens and no cost', () => {
  const line =
    '{"type":"result","subtype":"success","duration_ms":9476,"duration_api_ms":9476,"is_error":false,"result":"Done.","session_id":"a2e5","request_id":"8ad4","usage":{"inputTokens":15931,"outputTokens":435,"cacheReadTokens":27264,"cacheWriteTokens":12}}';
  expect(parseCursorLine(line)).toEqual([
    {
      type: 'complete',
      // Nothing in the stream reports a cost, and a missing cost is shown as missing.
      costUsd: null,
      durationMs: 9476,
      tokens: { input: 15931, output: 435, cacheRead: 27264, cacheCreation: 12 },
    },
  ]);
});

it('fails a run whose result says it failed', () => {
  const line = '{"type":"result","subtype":"success","is_error":true,"result":"the model refused"}';
  expect(parseCursorLine(line)).toEqual([{ type: 'failed', reason: 'the model refused', status: null }]);
});

// The binary prints types this version has never seen. `interaction_query` is one it printed
// while a plan was made. A line like it must cost nothing, not end the run.
it.each([
  '{"type":"interaction_query","subtype":"response","query_type":"createPlanRequestQuery","response":{"id":0}}',
  '{"type":"thinking","subtype":"delta","text":"…","timestamp_ms":1790338076360}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Refine the ticket."}]}}',
  'a tool wrote this to the shared stdout',
  '{"type":"tool_call","subtype":"completed","call_id":"c","tool_call":{}}',
  // A call whose keys are all the engine's own bookkeeping. This version cannot name the tool, and a
  // guess would put `hookAdditionalContexts` in the log as if it were one.
  '{"type":"tool_call","subtype":"completed","call_id":"c","tool_call":{"hookAdditionalContexts":[],"toolCallId":"c"}}',
])('ignores the line %j', (line) => {
  expect(parseCursorLine(line)).toEqual([]);
});

it('names the free plan as the reason a run failed', () => {
  const said = 'ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.';
  expect(cursorFailure(said)).toMatch(/free plan/);
});

// Every other failure keeps the engine's own words, which is what says what went wrong.
it('leaves another failure to the engine', () => {
  expect(cursorFailure('stream error: unexpected status 500')).toBeNull();
});

// What a tool gave back sits under `result.success`: the text of a read under `content`, and other
// fields for other tools. The size is the text where there is one, else the answer as the engine
// wrote it. A refusal has its own row and gets no result. The counts come only on the result line,
// at the end, so a Cursor run has no tokens to show while it runs.
it('reads what a tool gave back as a tool result with its size', () => {
  const glob =
    '{"type":"tool_call","subtype":"completed","call_id":"call-9","tool_call":{"hookAdditionalContexts":[],"toolCallId":"call-9","globToolCall":{"args":{"path":"/tmp/app"},"result":{"success":{"files":["a.txt"]}}}}}';
  expect(parseCursorLine(glob).at(-1)).toEqual({ type: 'tool_result', bytes: 19, error: false });
  const refused =
    '{"type":"tool_call","subtype":"completed","call_id":"call-57","tool_call":{"shellToolCall":{"result":{"rejected":{"command":"ls -1","workingDirectory":"/tmp/app","reason":"","isReadonly":false}}},"toolCallId":"call-57"}}';
  expect(parseCursorLine(refused).map((event) => event.type)).toEqual(['tool', 'permission_denied']);
});

it('gives a Cursor run no usage before its end', () => {
  const said = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Plan mode is on."}]},"model_call_id":"f166"}';
  expect(parseCursorLine(said).filter((event) => event.type === 'usage')).toEqual([]);
});
