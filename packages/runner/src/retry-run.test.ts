import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, RunEvent } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseClaudeLine } from './claude.ts';
import { parseCodexLine } from './codex.ts';
import { withSentinels } from './engine.ts';
import { runWithRetries } from './retry.ts';
import { parseRunLine } from './select.ts';
import { RunHalted, type RunEngine } from './run.ts';

let logs = '';
beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), 'nolzu-retry-'));
  vi.useFakeTimers();
  clock = Date.UTC(2026, 8, 21, 15, 0);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const MINUTE = 60_000;
const WAITS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const SESSION = '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7';

const job = (): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'plan',
  cwd: logs,
  taskDir: join(logs, '.tasks', 'APP-1'),
  prompt: 'Plan the card.',
  model: 'sonnet',
  effort: 'medium',
  sessionId: SESSION,
  resumeFrom: null,
  timeoutMs: 30 * MINUTE,
  logPath: join(logs, 'APP-1-plan-1.ndjson'),
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read'],
});

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, model: 'sonnet', apiKeySource: 'none' });
const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });
const apiError = (status: number) => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: status, result: `API Error: ${status}` });
const limit = (hoursOut: number, at: number) =>
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(at / 1000) + hoursOut * 3600 } } } });

// An engine that plays one attempt per call, and records the jobs it was started with.
function attempts(...plays: string[][]) {
  const started: Job[] = [];
  const engine: RunEngine = {
    parse: (line) => withSentinels(parseClaudeLine(line)),
    async *spawn(spawned) {
      started.push(spawned as Job);
      for (const line of plays[started.length - 1] ?? []) yield line;
    },
  };
  return { engine, started };
}

let clock = 0;
const now = () => clock;

async function drive(engine: RunEngine, signal = new AbortController().signal, waits: readonly number[] = WAITS) {
  const events: RunEvent[] = [];
  const run = (async () => {
    for await (const event of runWithRetries(engine, job(), signal, { waits, now, checkEveryMs: 1000, timeZone: 'UTC' })) events.push(event);
  })();
  return { events, run };
}

// Lets the fake clock and the timers move together, as time does.
async function pass(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

const types = (events: readonly RunEvent[]) => events.map((event) => event.type);

it('resumes the session after a 2 minute wait and ends complete', async () => {
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const { events, run } = await drive(engine);

  await pass(0);
  expect(types(events)).toEqual(['session', 'api_retry']);
  expect(events[1]).toMatchObject({ attempt: 1, delayMs: 2 * MINUTE, status: 529 });
  await pass(2 * MINUTE);
  await run;

  expect(types(events)).toEqual(['session', 'api_retry', 'session', 'complete']);
  expect(started[1]?.resumeFrom).toBe(SESSION);
  expect(started[1]?.sessionId).toBeNull();
});

// The failures in between are not handed on. A fold that saw them would call the card failed although
// the last attempt finished.
it('ends failed after waiting 2, 5 and 15 minutes, and names the last status', async () => {
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, apiError(529)], [INIT, apiError(500)], [INIT, apiError(529)]);
  const { events, run } = await drive(engine);

  for (const wait of WAITS) {
    await pass(0);
    await pass(wait);
  }
  await run;

  expect(started).toHaveLength(4);
  expect(events.filter((event) => event.type === 'api_retry').map((event) => event.type === 'api_retry' && event.delayMs)).toEqual(WAITS);
  expect(types(events).filter((type) => type === 'failed')).toEqual(['failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toBe('API Error: 529. Gave up after 3 retries.');
});

// The no retry policy from the settings screen. Nothing was tried a second time, so the failure is the
// whole story and "gave up after 0 retries" would read as if something had been.
it('starts one attempt and hands on the failure as it is when there are no waits', async () => {
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const { events, run } = await drive(engine, undefined, []);

  await run;

  expect(started).toHaveLength(1);
  expect(types(events)).toEqual(['session', 'failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toBe('API Error: 529');
});

it('starts no resume when the run is stopped during a wait', async () => {
  const controller = new AbortController();
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const { events, run } = await drive(engine, controller.signal);

  await pass(MINUTE);
  controller.abort();
  await pass(5 * MINUTE);
  await run;

  expect(started).toHaveLength(1);
  expect(types(events)).toEqual(['session', 'api_retry']);
});

// A person's stop folds the run as stopped, and a check's halt still reaches the fold.
it('hands on a halt that came with a stop', async () => {
  const controller = new AbortController();
  const engine: RunEngine = {
    parse: (line) => withSentinels(parseClaudeLine(line)),
    async *spawn(_spawned, signal) {
      yield INIT;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new RunHalted('The run created or replaced ~/.cursor/hooks.json.');
    },
  };
  const { events, run } = await drive(engine, controller.signal);
  await pass(1000);
  controller.abort();
  await run;

  expect(events.at(-1)).toMatchObject({ type: 'failed', halted: true });
});

// A laptop that slept through the wait resumes at the next check, not two waking minutes later.
it('resumes at once when the clock jumps past the wait', async () => {
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const { run } = await drive(engine);

  await pass(0);
  clock += 60 * MINUTE;
  await vi.advanceTimersByTimeAsync(1000);
  await run;

  expect(started).toHaveLength(2);
});

it('does not retry a usage limit that resets hours later, and says when it resets', async () => {
  const { engine, started } = attempts([INIT, limit(4, clock), apiError(429)]);
  const { events, run } = await drive(engine);

  await pass(0);
  await run;

  expect(started).toHaveLength(1);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toBe('5-hour limit, resets 19:00');
  expect(failed?.type === 'failed' && failed.status).toBe(429);
});

it('retries a 429 that came with no window', async () => {
  const { engine, started } = attempts([INIT, apiError(429)], [INIT, DONE]);
  const { events, run } = await drive(engine);

  await pass(0);
  await pass(2 * MINUTE);
  await run;

  expect(started).toHaveLength(2);
  expect(events.at(-1)?.type).toBe('complete');
});

// A window seen on another kind of failure changes nothing: only a 429 is a usage limit.
it('keeps the schedule for an overloaded service although a window was reported', async () => {
  const { engine, started } = attempts([INIT, limit(4, clock), apiError(529)], [INIT, DONE]);
  const { run } = await drive(engine);

  await pass(0);
  await pass(2 * MINUTE);
  await run;

  expect(started).toHaveLength(2);
});

it('does not retry a failure a second try cannot change', async () => {
  const { engine, started } = attempts([INIT, apiError(401)]);
  const { events, run } = await drive(engine);

  await pass(0);
  await run;

  expect(started).toHaveLength(1);
  expect(types(events)).toEqual(['session', 'failed']);
});

// A failure after a retry that has nothing to do with retrying reads as itself.
it('says nothing about retries when a resumed attempt fails another way', async () => {
  const quiet = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
  const { engine } = attempts([INIT, apiError(529)], [INIT, quiet]);
  const { events, run } = await drive(engine);

  await pass(0);
  await pass(2 * MINUTE);
  await run;

  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).not.toMatch(/Gave up/);
});

// A resume may name a new session. The next resume continues the newest one, not the first.
it('resumes the newest session the run reported', async () => {
  const later = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1b2c3d4-0000-4000-8000-000000000002', model: 'sonnet', apiKeySource: 'none' });
  const { engine, started } = attempts([INIT, apiError(529)], [later, apiError(529)], [later, DONE]);
  const { run } = await drive(engine);

  await pass(0);
  await pass(2 * MINUTE);
  await pass(0);
  await pass(5 * MINUTE);
  await run;

  expect(started[2]?.resumeFrom).toBe('a1b2c3d4-0000-4000-8000-000000000002');
});

it('tells the caller when a wait starts and when the resumed attempt starts', async () => {
  const { engine } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const calls: string[] = [];
  const run = (async () => {
    for await (const event of runWithRetries(engine, job(), new AbortController().signal, {
      waits: WAITS,
      now,
      checkEveryMs: 1000,
      onWait: (wait) => calls.push(`wait ${wait.delayMs}`),
      onResume: () => calls.push('resume'),
    })) void event;
  })();

  await pass(0);
  await pass(2 * MINUTE);
  await run;

  expect(calls).toEqual([`wait ${2 * MINUTE}`, 'resume']);
});

// A clock set back during a wait would stretch it by as much. The time already waited counts.
it('does not stretch a wait when the clock goes back', async () => {
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const { run } = await drive(engine);

  await pass(0);
  await pass(MINUTE);
  clock -= 24 * 60 * MINUTE;
  await vi.advanceTimersByTimeAsync(1000);
  await pass(MINUTE);
  await run;

  expect(started).toHaveLength(2);
});

// The countdown reads the time the next try starts, so the wait carries it, and the log keeps the wait
// as a line of Nolzu's own between the two attempts, where the engine printed nothing.
it('stamps the wait with the time the next try starts, and writes it into the run log', async () => {
  const { engine } = attempts([INIT, apiError(529)], [INIT, DONE]);
  const { events, run } = await drive(engine);

  await pass(0);
  expect(events[1]).toEqual({ type: 'api_retry', attempt: 1, delayMs: 2 * MINUTE, status: 529, maxRetries: 3, reason: 'API Error: 529', until: clock + 2 * MINUTE });
  await pass(2 * MINUTE);
  await run;

  const lines = readFileSync(job().logPath, 'utf8').trimEnd().split('\n');
  expect(lines.flatMap((line) => parseRunLine(line, 'claude-code')).map((event) => event.type)).toEqual(['session', 'failed', 'api_retry', 'session', 'complete']);
  expect(lines.flatMap((line) => parseRunLine(line, 'claude-code')).find((event) => event.type === 'api_retry')).toEqual(events[1]);
});

it('still waits and resumes when the log takes no line for the wait', async () => {
  const { engine, started } = attempts([INIT, apiError(529)], [INIT, DONE]);
  let opened = 0;
  // The first attempt's log opens; the wait's line finds the disk full.
  const openLog = (path: string) => {
    opened += 1;
    if (opened === 2) throw new Error(`The run log ${path} cannot be written (ENOSPC).`);
    return { write: () => undefined, close: () => undefined };
  };
  const events: RunEvent[] = [];
  const run = (async () => {
    for await (const event of runWithRetries(engine, job(), new AbortController().signal, { waits: WAITS, now, checkEveryMs: 1000, openLog })) events.push(event);
  })();

  await pass(0);
  await pass(2 * MINUTE);
  await run;

  expect(started).toHaveLength(2);
  expect(types(events)).toEqual(['session', 'api_retry', 'session', 'complete']);
});

// The end of a Codex plan run on 2026-10-26: the model at capacity, the failed turn, then exit code 1.
const THREAD = JSON.stringify({ type: 'thread.started', thread_id: SESSION });
const CAPACITY = [
  '{"type":"error","message":"Selected model is at capacity. Please try a different model."}',
  '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}',
];
const TURN_DONE = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });

// A Codex engine: the process exits with a code after a failed turn, which the spawn throws.
function codexAttempts(...plays: string[][]) {
  const started: Job[] = [];
  const engine: RunEngine = {
    parse: (line) => withSentinels(parseCodexLine(line)),
    async *spawn(spawned) {
      started.push(spawned as Job);
      const play = plays[started.length - 1] ?? [];
      for (const line of play) yield line;
      if (play.some((line) => line.includes('turn.failed'))) throw new Error('The Codex CLI engine stopped with exit code 1.');
    },
  };
  return { engine, started };
}

it('waits and resumes a Codex run whose model was at capacity, with the reason Codex gave', async () => {
  const { engine, started } = codexAttempts([THREAD, ...CAPACITY], [THREAD, TURN_DONE]);
  const { events, run } = await drive(engine);

  await pass(0);
  expect(events.at(-1)).toMatchObject({ type: 'api_retry', attempt: 1, status: null, reason: 'Selected model is at capacity. Please try a different model.' });
  await pass(2 * MINUTE);
  await run;

  expect(types(events)).toEqual(['session', 'api_retry', 'session', 'complete']);
  expect(started[1]?.resumeFrom).toBe(SESSION);
});

it('fails a Codex run once, on its own reason, when the failure is not worth a retry', async () => {
  const refused = '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer authentication"}}';
  const { engine, started } = codexAttempts([THREAD, refused], [THREAD, TURN_DONE]);
  const { events, run } = await drive(engine);

  await run;

  expect(started).toHaveLength(1);
  expect(types(events)).toEqual(['session', 'failed']);
  // Codex reports no time, so the run is timed from its start to the failure line, here on a clock that stands still.
  expect(events.at(-1)).toEqual({ type: 'failed', reason: 'unexpected status 401 Unauthorized: Missing bearer authentication', status: null, durationMs: 0 });
});
