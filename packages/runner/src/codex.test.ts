import { expect, it } from 'vitest';
import { codexRefusals, parseCodexLine } from './codex.ts';
import { parseRunLine } from './select.ts';

// The stream a real Codex run printed on 2026-09-25, recorded when the engine was first measured
// and by a read-only run that day. Nothing here is written by hand: the lines are the binary's own.
const STREAM = [
  '{"type":"thread.started","thread_id":"01a0d87e-8520-7973-a8f2-6237813635d5"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\u2019ll try to create `proof.txt` now."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"sed -n \'1p\' inside.txt\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"sed -n \'1p\' inside.txt\\"","aggregated_output":"world\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"It did not work: the sandbox is read-only."}}',
  '{"type":"turn.completed","usage":{"input_tokens":25709,"cached_input_tokens":14080,"cache_write_input_tokens":0,"output_tokens":130,"reasoning_output_tokens":40}}',
];

const events = (lines: readonly string[]) => lines.flatMap((line) => parseCodexLine(line));

it('reads a whole run out of the stream the binary printed', () => {
  expect(events(STREAM)).toEqual([
    { type: 'session', sessionId: '01a0d87e-8520-7973-a8f2-6237813635d5', model: null, apiKeyMode: null },
    { type: 'text', text: 'I’ll try to create `proof.txt` now.' },
    { type: 'tool', name: 'command_execution', input: expect.objectContaining({ exit_code: 0 }) },
    { type: 'tool_result', bytes: 6, error: false, lines: 1 },
    { type: 'text', text: 'It did not work: the sandbox is read-only.' },
    {
      type: 'complete',
      costUsd: null,
      durationMs: null,
      tokens: { input: 25709, output: 130, cacheRead: 14080, cacheCreation: 0 },
    },
  ]);
});

it('keeps the agent messages in the order they arrived', () => {
  const said = events(STREAM).flatMap((event) => (event.type === 'text' ? [event.text] : []));
  expect(said).toEqual(['I\u2019ll try to create `proof.txt` now.', 'It did not work: the sandbox is read-only.']);
});

// The binary adds event types between minor versions. A run that ends because of one would fail on
// the day the person updates Codex, with nothing on the card that says why.
it('ignores a line it has never seen and reads the rest of the run', () => {
  const surprise = '{"type":"turn.paused","reason":"a type this version has never seen"}';
  expect(parseCodexLine(surprise)).toEqual([]);
  expect(events([STREAM[0] ?? '', surprise, STREAM[6] ?? '']).map((event) => event.type)).toEqual(['session', 'complete']);
});

it('ignores a line that is not JSON at all', () => {
  expect(parseCodexLine('Reading additional input from stdin...')).toEqual([]);
  expect(parseCodexLine('')).toEqual([]);
  // A JSON value that is not an object, which a tool writing to the shared stdout can produce.
  expect(parseCodexLine('42')).toEqual([]);
});

it('counts a started item once, when it completes', () => {
  const started = events([STREAM[3] ?? '']);
  expect(started).toEqual([]);
});

it('reports the session with no model and no login, because the stream names neither', () => {
  // The card's own row holds the model. Claiming one here would put the engine's silence on the
  // page as a fact.
  expect(parseCodexLine(STREAM[0] ?? '')).toEqual([{ type: 'session', sessionId: '01a0d87e-8520-7973-a8f2-6237813635d5', model: null, apiKeyMode: null }]);
});

it('reports no cost, because the engine reports none', () => {
  const [complete] = parseCodexLine(STREAM[6] ?? '');
  // Zero would read as a free run and would be summed into the card's total.
  expect(complete).toMatchObject({ type: 'complete', costUsd: null });
});

// What the read-only run of 2026-09-25 wrote on stderr, colour codes and all, with the noise line
// the binary prints about its own models cache. Two of the four recorded runs printed it.
const STDERR = `\u001B[2m2026-09-25T12:16:05.073171Z\u001B[0m \u001B[31mERROR\u001B[0m \u001B[2mcodex_models_manager::cache\u001B[0m\u001B[2m:\u001B[0m failed to load models cache: missing field \`base_instructions\` at line 140 column 5
\u001B[2m2026-09-25T12:16:09.888456Z\u001B[0m \u001B[31mERROR\u001B[0m \u001B[2mcodex_core::tools::router\u001B[0m\u001B[2m:\u001B[0m \u001B[3merror\u001B[0m\u001B[2m=\u001B[0mpatch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`;

it('turns the refusal the sandbox wrote on stderr into a refused tool', () => {
  const lines = codexRefusals(STDERR);
  expect(lines).toHaveLength(1);
  // The sentence itself goes into the run log, so a person reads the engine's own words.
  expect(lines[0]).toContain('writing is blocked by read-only sandbox');
  expect(events(lines)).toEqual([{ type: 'permission_denied', denied: [{ tool: 'patch', id: null, path: null }] }]);
});

it('takes the noise line for what it is, and not for a failure', () => {
  const noise = STDERR.split('\n')[0] ?? '';
  // An adapter that read any stderr ERROR as a refusal or a failure would report one on every run
  // that prints this line.
  expect(codexRefusals(noise)).toEqual([]);
});

it('says nothing twice when the same write was refused again', () => {
  expect(codexRefusals(`${STDERR}\n${STDERR}`)).toHaveLength(1);
});

it('names each different refusal once', () => {
  const two = `${STDERR}\npatch rejected: writing is blocked by read-only sandbox; another folder`;
  expect(codexRefusals(two)).toHaveLength(2);
});

// A command's output is the one tool result the stream carries: `aggregated_output` on the completed
// item. A file change carries the paths and no output, and the counts come only on `turn.completed`,
// at the end, so a Codex run has no tokens to show while it runs.
it('reads the output of a command as a tool result with its size, and a failed command as an error', () => {
  expect(parseCodexLine(STREAM[4] ?? '').at(-1)).toEqual({ type: 'tool_result', bytes: 6, error: false, lines: 1 });
  const failed = (STREAM[4] ?? '').replace('"aggregated_output":"world\\n","exit_code":0', '"aggregated_output":"sed: inside.txt: No such file or directory\\n","exit_code":1');
  expect(parseCodexLine(failed).at(-1)).toEqual({ type: 'tool_result', bytes: 43, error: true, lines: 1 });
});

it('gives a file change no tool result and the run no usage before its end', () => {
  const change = '{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"/tmp/app/a.txt","kind":"update"}],"status":"completed"}}';
  expect(parseCodexLine(change).map((event) => event.type)).toEqual(['tool']);
  expect(events(STREAM).filter((event) => event.type === 'usage')).toEqual([]);
});

// The end of a plan run that failed on 2026-10-26: Codex prints the error twice, once on its own and
// once as the failed turn, then exits 1.
const AT_CAPACITY = [
  '{"type":"error","message":"Selected model is at capacity. Please try a different model."}',
  '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}',
];

it('fails the run on a failed turn, with the reason Codex gave', () => {
  expect(events(AT_CAPACITY)).toEqual([{ type: 'failed', reason: 'Selected model is at capacity. Please try a different model.', status: null }]);
  expect(parseCodexLine('{"type":"turn.failed"}')).toEqual([{ type: 'failed', reason: 'The turn failed, and Codex gave no reason.', status: null }]);
});

// A warning Codex printed at the start of every run on 2026-10-26, cut to its first line.
const WARNING = '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Ignoring unknown `features` requirement `ultrafast_mode` from requirements layers"}}';

it('reads an error item as a warning in the log and never as a tool', () => {
  // The board shows a run's last tool, which read "Using error" at the start of every run.
  expect(parseCodexLine(WARNING)).toEqual([]);
  expect(parseRunLine(WARNING, 'codex#default')).toEqual([{ type: 'text', text: 'Ignoring unknown `features` requirement `ultrafast_mode` from requirements layers' }]);
  expect(parseRunLine(STREAM[2] ?? '', 'codex#default')).toEqual([{ type: 'text', text: 'I’ll try to create `proof.txt` now.' }]);
});
