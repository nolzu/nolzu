import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, RunEvent } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubBinary, type StubBinary } from '../test/stub-binary.ts';
import { parseClaudeLine } from './claude.ts';
import { withSentinels } from './engine.ts';
import type { RunLog } from './log.ts';
import { resumeJob, RunHalted, runJob, type RunEngine } from './run.ts';
import { POINTER_CHANGED, spawnClaude } from './spawn.ts';

// The wall needs bubblewrap on Linux, which CI lacks, so the engine starts as it came here.
// spawn-wall.test.ts runs the real wall and the doubles.
vi.mock('./wall-detect.ts', async (actual) => ({
  ...(await actual<typeof import('./wall-detect.ts')>()),
  walledCommand: (_spec: unknown, command: string, args: readonly string[]) => ({ command, args: [...args] }),
  // The probe answers ready, so the run takes the walled path on every machine.
  wallHere: () => ({ ready: true, binary: '/usr/bin/sandbox-exec' }),
}));

let stub: StubBinary | null = null;
let cwd = '';
// Every run writes its log, so every test gets a folder of its own for it.
let logs = '';

beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), 'nolzu-run-logs-'));
});

afterEach(() => {
  vi.useRealTimers();
  stub?.remove();
  stub = null;
  if (cwd !== '') rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cwd = '';
  chmodSync(logs, 0o755);
  rmSync(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const job = (over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'refine',
  cwd,
  prompt: 'Refine the ticket.',
  model: 'sonnet',
  effort: 'low',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: join(logs, 'APP-1-refine-1.ndjson'),
  // Inside the test's own folder, because a run makes its card folder.
  taskDir: join(cwd, '.tasks', 'APP-1'),
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep'],
  ...over,
});

// Lines the way the engine prints them, so the wrapper is tested through the parser it ships with.
const TEXT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the ticket.' }] } });
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.04,
  duration_ms: 1200,
  usage: { input_tokens: 9, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const API_ERROR = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429' });

const parse = (line: string): RunEvent[] => withSentinels(parseClaudeLine(line));

// An engine that prints the given lines, then does what `then` says. It stops when it is told to,
// the way the real one does.
function scripted(lines: readonly string[], then: 'end' | 'hang' | Error = 'end'): RunEngine {
  return {
    parse,
    async *spawn(_job, signal) {
      for (const line of lines) yield line;
      if (then === 'end') return;
      if (then instanceof Error) throw then;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
}

// The real spawn, against a stub binary.
function real(body: string): RunEngine {
  stub = stubBinary(body);
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-run-'));
  const binary = stub.path;
  return { parse, spawn: (spawned, signal) => spawnClaude(binary, spawned as Job, signal, { killGraceMs: 200 }) };
}

async function collect(engine: RunEngine, over: Partial<Job> = {}, signal = new AbortController().signal, options = {}): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of runJob(engine, { ...job(), ...over, cwd }, signal, options)) events.push(event);
  return events;
}

const types = (events: readonly RunEvent[]) => events.map((event) => event.type);

it('hands over what the engine printed, parsed and in order, and adds nothing to a run that ended', async () => {
  const events = await collect(scripted([TEXT, RESULT]));

  expect(types(events)).toEqual(['text', 'complete']);
});

// Codex reports no time of its own. Timed from the start of the engine to its result
// line, the run does not take in what Nolzu does before and after it, such as starting QA's app.
it('times a run whose engine reports no time from its start to its result line, and keeps a time it reports', async () => {
  let clock = 0;
  const now = () => (clock += 1000);
  const ends = (said: number | null): RunEngine => ({
    parse: (line) => (line === 'end' ? [{ type: 'complete', costUsd: null, durationMs: said, tokens: null }] : line === 'fail' ? [{ type: 'failed', reason: 'refused', status: null }] : []),
    async *spawn() {
      yield 'working';
      yield 'working';
      yield said === -1 ? 'fail' : 'end';
    },
  });

  expect((await collect(ends(null), {}, undefined, { now })).at(-1)).toMatchObject({ type: 'complete', durationMs: 3000 });
  expect((await collect(ends(-1), {}, undefined, { now })).at(-1)).toMatchObject({ type: 'failed', durationMs: 3000 });
  expect((await collect(ends(18_240), {}, undefined, { now })).at(-1)).toMatchObject({ type: 'complete', durationMs: 18_240 });
});

it('turns a question into its own event, through the engine it was given', async () => {
  const asks = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'NOLZU: needs_input: Which index name?' }] } });

  expect(types(await collect(scripted([asks, RESULT])))).toEqual(['text', 'needs_input', 'complete']);
});

it('lets a run that keeps printing run to its end, however long it takes', async () => {
  // Six lines, each well inside the timeout, and together longer than it. The timeout counts the
  // quiet, not the run: an implement run can honestly take an hour while printing all the way.
  // The timeout also covers the start of the process before its first line, which a busy CI runner
  // can stretch, so it is wide. 1500 was not wide enough: with several test workers busy, node's
  // start alone passed it and the run was reported as gone quiet. The gaps under test are 300ms.
  const engine = real(`
    const lines = [${Array(5).fill(JSON.stringify(TEXT)).join(', ')}, ${JSON.stringify(RESULT)}];
    let i = 0;
    const next = () => {
      if (i >= lines.length) return process.exit(0);
      process.stdout.write(lines[i++] + String.fromCharCode(10), () => setTimeout(next, 300));
    };
    next();
  `);

  const events = await collect(engine, { timeoutMs: 5000 }, undefined, { checkEveryMs: 25 });

  expect(types(events)).toEqual(['text', 'text', 'text', 'text', 'text', 'complete']);
}, 15000);

it('stops a run that went quiet, and says that it timed out and after how long', async () => {
  const engine = real(`
    process.stdout.write(${JSON.stringify(TEXT)} + String.fromCharCode(10));
    process.stdout.write(JSON.stringify({ pid: process.pid }) + String.fromCharCode(10));
    setInterval(() => {}, 1000);
  `);
  const pids: number[] = [];
  const watching: RunEngine = {
    spawn: engine.spawn,
    parse: (line) => {
      const pid = (JSON.parse(line) as { pid?: number }).pid;
      if (pid !== undefined) pids.push(pid);
      return engine.parse(line);
    },
  };

  const started = Date.now();
  // The quiet window also covers the start of the stand-in process, so it has to be wider than that
  // start ever takes. Three seconds was not: with several suites running at once the window closed
  // before the process printed its first line, and the run failed with no text event at all. Eight
  // seconds costs this test a few seconds and stops it from lying about a timeout that was really a
  // slow machine.
  const events = await collect(watching, { timeoutMs: 8000 }, undefined, { checkEveryMs: 25 });

  expect(types(events)).toEqual(['text', 'failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/printed nothing for 8 seconds/);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/timeout/i);
  expect(Date.now() - started).toBeLessThan(25_000);
  // Reporting the timeout is half of it. The engine has to be gone as well.
  expect(pids).toHaveLength(1);
  expect(() => process.kill(pids[0] ?? -1, 0)).toThrow();
}, 40000);

it('stops a quiet run at the next check after a sleep, although the timer never ran that long', async () => {
  // Node timers stand still while the machine sleeps, so a timer set for thirty minutes fires
  // thirty waking minutes later. The wall clock is what knows an hour went by.
  vi.useFakeTimers();
  let now = 1_000_000;
  const run = collect(scripted([TEXT], 'hang'), { timeoutMs: 30 * 60 * 1000 }, undefined, { checkEveryMs: 5000, now: () => now });

  await vi.advanceTimersByTimeAsync(5000);
  now += 60 * 60 * 1000;
  await vi.advanceTimersByTimeAsync(5000);
  const events = await run;

  expect(types(events)).toEqual(['text', 'failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/printed nothing for 60 minutes/);
});

it('leaves a quiet run alone while it is inside the timeout', async () => {
  vi.useFakeTimers();
  let now = 1_000_000;
  const controller = new AbortController();
  const run = collect(scripted([TEXT], 'hang'), { timeoutMs: 30 * 60 * 1000 }, controller.signal, { checkEveryMs: 5000, now: () => now });

  now += 29 * 60 * 1000;
  await vi.advanceTimersByTimeAsync(5000);
  controller.abort();

  // Ended by the caller here, so no timeout was reported on the way.
  expect(types(await run)).toEqual(['text']);
});

it('counts the quiet from the last line, not from the start of the run', async () => {
  vi.useFakeTimers();
  let now = 1_000_000;
  let release: () => void = () => undefined;
  const engine: RunEngine = {
    parse,
    async *spawn(_job, signal) {
      yield TEXT;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield TEXT;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  const controller = new AbortController();
  const run = collect(engine, { timeoutMs: 30 * 60 * 1000 }, controller.signal, { checkEveryMs: 5000, now: () => now });

  await vi.advanceTimersByTimeAsync(0);
  now += 20 * 60 * 1000;
  release();
  await vi.advanceTimersByTimeAsync(5000);
  now += 20 * 60 * 1000;
  await vi.advanceTimersByTimeAsync(5000);
  controller.abort();

  // Forty minutes since the start, twenty since the last line.
  expect(types(await run)).toEqual(['text', 'text']);
});

it('does not call a stop the caller asked for a timeout, even when the timeout came first', async () => {
  vi.useFakeTimers();
  let now = 1_000_000;
  const controller = new AbortController();
  let release: () => void = () => undefined;
  // An engine that is slow to go, so the caller's stop arrives while the timeout is shutting it down.
  const engine: RunEngine = {
    parse,
    async *spawn() {
      yield TEXT;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  const run = collect(engine, { timeoutMs: 60_000 }, controller.signal, { checkEveryMs: 1000, now: () => now });

  await vi.advanceTimersByTimeAsync(0);
  now += 61_000;
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  release();

  // No failed event. The caller knows it stopped the run, and folds it as stopped.
  expect(types(await run)).toEqual(['text']);
});

it('adds nothing when the caller stopped the run before it began', async () => {
  const controller = new AbortController();
  controller.abort();
  const engine: RunEngine = {
    parse,
    async *spawn(_job, signal) {
      // The engine's side of the contract: a signal that is already aborted starts nothing.
      if (signal.aborted) return;
      yield TEXT;
    },
  };

  expect(await collect(engine, {}, controller.signal)).toEqual([]);
});

it('reports the quiet as it was when the run was stopped, not as it grew while the engine shut down', async () => {
  vi.useFakeTimers();
  let now = 1_000_000;
  let release: () => void = () => undefined;
  const engine: RunEngine = {
    parse,
    async *spawn(_job, signal) {
      yield TEXT;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      // Slow to go after the stop, the way a process with a grace period is.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  const run = collect(engine, { timeoutMs: 60_000 }, undefined, { checkEveryMs: 1000, now: () => now });

  await vi.advanceTimersByTimeAsync(0);
  now += 60_000;
  await vi.advanceTimersByTimeAsync(1000);
  now += 10 * 60_000;
  await vi.advanceTimersByTimeAsync(10 * 1000);
  release();
  const events = await run;

  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/printed nothing for 1 minute,/);
});

// A clock set back, by a person or by a large time correction, makes the quiet negative. Read as it
// is, the run would then be allowed that much longer, and a hung run could hold its card for a day.
it('starts the count again when the clock goes back, rather than waiting for the old time to return', async () => {
  vi.useFakeTimers();
  let now = 1_000_000_000;
  const run = collect(scripted([TEXT], 'hang'), { timeoutMs: 60_000 }, undefined, { checkEveryMs: 1000, now: () => now });

  await vi.advanceTimersByTimeAsync(0);
  now -= 24 * 60 * 60_000;
  await vi.advanceTimersByTimeAsync(1000);
  now += 2 * 60_000;
  await vi.advanceTimersByTimeAsync(1000);
  const events = await run;

  expect(types(events)).toEqual(['text', 'failed']);
});

it('reports a stream that ended with no result line as failed, so a card never looks done by accident', async () => {
  const events = await collect(scripted([TEXT]));

  expect(types(events)).toEqual(['text', 'failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/no result/);
});

it('reports what the engine said when it stopped with an error and no result', async () => {
  const events = await collect(scripted([TEXT], new Error('The claude engine stopped with exit code 1. It said: not logged in')));

  expect(types(events)).toEqual(['text', 'failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toBe('The claude engine stopped with exit code 1. It said: not logged in');
});

// A failed card has to say something a person can act on, also when an adapter throws with no text.
it('names the missing result when the engine throws with an empty message', async () => {
  const events = await collect(scripted([TEXT], new Error('')));

  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/no result/);
});

// The engine reports an API error on its result line and then exits with a code. The result line
// carries the status a retry is decided on, so the exit code must not write over it.
it('keeps the result the engine gave when the process then exits with an error', async () => {
  const events = await collect(scripted([API_ERROR], new Error('The claude engine stopped with exit code 1.')));

  expect(types(events)).toEqual(['failed']);
  expect(events[0]?.type === 'failed' && events[0].status).toBe(429);
});

// Claude Code stays up after its result while a server it started in the background runs on. The result
// is final, so the engine is stopped and the run ends as it reported, not left running for good.
it('stops an engine that stays up after its result, and keeps the result', async () => {
  const started = Date.now();
  const events = await collect(scripted([TEXT, RESULT], 'hang'), {}, undefined, { afterResultMs: 50 });

  expect(types(events)).toEqual(['text', 'complete']);
  expect(Date.now() - started).toBeLessThan(5000);
});

// Through the real spawn: the process prints its result, then a child it started keeps it up.
it('ends a real engine that prints its result and stays up with a child of its own', async () => {
  const engine = real(`
    require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(${JSON.stringify(RESULT)} + String.fromCharCode(10));
    setInterval(() => {}, 1000);
  `);

  const events = await collect(engine, { timeoutMs: 60_000 }, undefined, { afterResultMs: 100 });

  expect(types(events)).toEqual(['complete']);
}, 15000);

// An engine that goes on printing after its result is working, so only quiet past the result stops it.
it('waits while an engine goes on printing after its result, and stops it once it is quiet', async () => {
  const engine: RunEngine = {
    parse,
    async *spawn(_job, signal) {
      yield RESULT;
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (signal.aborted) return;
        yield TEXT;
      }
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };

  const events = await collect(engine, {}, undefined, { afterResultMs: 100 });

  expect(types(events)).toEqual(['complete', 'text', 'text', 'text', 'text']);
});

// The same for a failed result: it is the engine's answer, and no timeout sentence goes over it.
it('stops an engine that stays up after a failed result, and keeps that result', async () => {
  const events = await collect(scripted([API_ERROR], 'hang'), {}, undefined, { afterResultMs: 50 });

  expect(types(events)).toEqual(['failed']);
  expect(events[0]?.type === 'failed' && events[0].status).toBe(429);
});

it('stops the engine when the reader walks away in the middle', async () => {
  let stopped = false;
  const engine: RunEngine = {
    parse,
    async *spawn(_job, signal) {
      signal.addEventListener('abort', () => {
        stopped = true;
      });
      yield TEXT;
      yield TEXT;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };

  for await (const event of runJob(engine, job(), new AbortController().signal)) {
    void event;
    break;
  }

  expect(stopped).toBe(true);
});

const logged = () => readFileSync(join(logs, 'APP-1-refine-1.ndjson'), 'utf8');

it('writes every line the engine printed to the run log, word for word and in order', async () => {
  await collect(scripted([TEXT, 'not json at all', RESULT]), {}, undefined, { now: () => 5000 });

  // The log is the raw stream, so a line the parser drops is still in it. The lines came in the same
  // second, so one time goes in front of them.
  expect(logged()).toBe(`{"type":"nolzu.at","at":5000}\n${TEXT}\nnot json at all\n${RESULT}\n`);
});

// The engines stamp no time on their lines, and the Log tab's time column needs one. A burst of lines
// costs one mark, and a line a second or more after the last mark gets its own.
it('notes the time in front of a line, at most once a second', async () => {
  let now = 10_000;
  const engine: RunEngine = {
    parse,
    async *spawn() {
      yield TEXT;
      now += 400;
      yield TEXT;
      now += 600;
      yield RESULT;
    },
  };

  await collect(engine, {}, undefined, { now: () => now });

  expect(logged()).toBe(`{"type":"nolzu.at","at":10000}\n${TEXT}\n${TEXT}\n{"type":"nolzu.at","at":11000}\n${RESULT}\n`);
});

it('keeps what a run printed before it went quiet', async () => {
  vi.useFakeTimers();
  let now = 1_000_000;
  const run = collect(scripted([TEXT], 'hang'), { timeoutMs: 60_000 }, undefined, { checkEveryMs: 1000, now: () => now });

  await vi.advanceTimersByTimeAsync(0);
  now += 61_000;
  await vi.advanceTimersByTimeAsync(1000);
  await run;

  expect(logged()).toBe(`{"type":"nolzu.at","at":1000000}\n${TEXT}\n`);
});

it('fails the run and starts no engine when the log cannot be opened, and names the path', async () => {
  const locked = join(logs, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  const logPath = join(locked, 'logs', '1.ndjson');
  const spawn = vi.fn(scripted([TEXT, RESULT]).spawn);

  const events = await collect({ parse, spawn }, { logPath });

  expect(spawn).not.toHaveBeenCalled();
  expect(types(events)).toEqual(['failed']);
  expect(events[0]?.type === 'failed' && events[0].reason).toContain(logPath);
});

// A disk that fills up in the middle of a run. What was parsed already is handed on, the engine is
// stopped rather than left to work with nothing recording it, and the card says why.
it('stops the engine and fails naming the path when a line cannot be written, and keeps what was parsed', async () => {
  let stopped = false;
  const engine: RunEngine = {
    parse,
    async *spawn(_job, signal) {
      signal.addEventListener('abort', () => {
        stopped = true;
      });
      yield TEXT;
      yield TEXT;
      yield RESULT;
    },
  };
  let written = 0;
  const openLog = (path: string): RunLog => ({
    write: () => {
      written += 1;
      if (written === 2) throw new Error(`The run log ${path} could not take another line (ENOSPC).`);
    },
    close: () => undefined,
  });

  const events = await collect(engine, {}, undefined, { openLog });

  expect(stopped).toBe(true);
  expect(types(events)).toEqual(['text', 'text', 'failed']);
  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toContain('APP-1-refine-1.ndjson');
  expect(failed?.type === 'failed' && failed.reason).toContain('ENOSPC');
});

it('closes the log on every way out', async () => {
  const closes: string[] = [];
  const openLog = (path: string): RunLog => ({ write: () => undefined, close: () => closes.push(path) });
  const controller = new AbortController();

  await collect(scripted([TEXT, RESULT]), {}, undefined, { openLog });
  await collect(scripted([TEXT], new Error('boom')), {}, undefined, { openLog });
  const stopping = collect(scripted([TEXT], 'hang'), {}, controller.signal, { openLog });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await stopping;

  expect(closes).toHaveLength(3);
});

// The result line carries the cost and the status a retry is decided on. A log that fails on that
// very line changes nothing about how the run ended.
it('keeps the result when the write of the result line fails', async () => {
  let written = 0;
  const openLog = (path: string): RunLog => ({
    write: () => {
      written += 1;
      if (written === 2) throw new Error(`The run log ${path} could not take another line (ENOSPC).`);
    },
    close: () => undefined,
  });

  expect(types(await collect(scripted([TEXT, RESULT]), {}, undefined, { openLog }))).toEqual(['text', 'complete']);
});

// A close can fail late, on a network folder, after every line was written and the run ended. The
// run is over by then, and a failure here would turn a finished card into a failed one.
it('keeps the result when closing the log fails', async () => {
  const openLog = (): RunLog => ({
    write: () => undefined,
    close: () => {
      throw new Error('EIO');
    },
  });

  expect(types(await collect(scripted([TEXT, RESULT]), {}, undefined, { openLog }))).toEqual(['text', 'complete']);
});

it('adds nothing when the caller stopped the run while a write failed', async () => {
  const controller = new AbortController();
  const openLog = (): RunLog => ({
    write: () => {
      controller.abort();
      throw new Error('ENOSPC');
    },
    close: () => undefined,
  });

  expect(types(await collect(scripted([TEXT], 'hang'), {}, controller.signal, { openLog }))).toEqual(['text']);
});

// A blocked card's answer and a retry both continue the session, and both take this one path.
it('continues a session with the given message as the prompt, and names no new session', () => {
  const resumed = resumeJob(job({ sessionId: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7' }), 'a1b2c3d4-0000-4000-8000-000000000001', 'Use the name recipes_title_idx.');

  expect(resumed.resumeFrom).toBe('a1b2c3d4-0000-4000-8000-000000000001');
  expect(resumed.sessionId).toBeNull();
  expect(resumed.prompt).toBe('Use the name recipes_title_idx.');
  expect(resumed.phase).toBe('refine');
});

// A session lives inside one engine profile: the engine keeps it under that profile's config
// folder. Resuming under another login would find nothing to continue, so the profile the earlier
// run recorded wins over whatever the action table says by the time somebody answers.
it('resumes on the profile the earlier run recorded, not the one the table names now', () => {
  const resumed = resumeJob(job({ engine: 'claude-code' }), 'a1b2c3d4-0000-4000-8000-000000000001', 'the answer', { engine: 'codex#work' });

  expect(resumed.engine).toBe('codex#work');
  expect(resumed.resumeFrom).toBe('a1b2c3d4-0000-4000-8000-000000000001');
});

// A model for this one message, which the discussion composer offers. Without it the job keeps
// the model the action table resolved for the phase.
it('takes a model for this message alone', () => {
  const resumed = resumeJob(job({ model: 'sonnet' }), 'a1b2c3d4-0000-4000-8000-000000000001', 'try it', { model: 'haiku' });

  expect(resumed.model).toBe('haiku');
  expect(resumeJob(job({ model: 'sonnet' }), 'a1b2c3d4-0000-4000-8000-000000000001', 'go on').model).toBe('sonnet');
});

// The other side of the same branch. A caller that knows no profile leaves the job's own alone
// rather than clearing it, which would resume with no profile at all.
it('keeps the job profile when the caller names none', () => {
  const resumed = resumeJob(job({ engine: 'codex#work' }), 'a1b2c3d4-0000-4000-8000-000000000001', 'the answer');

  expect(resumed.engine).toBe('codex#work');
});

// The argument builder refuses these too, but only inside the spawn, after the card folder was made.
// Refused here, a bad id never gets that far.
it.each(['', '   ', '-rf', 'a1b2 c3d4'])('refuses to resume the session %j, before anything is started', (sessionId) => {
  expect(() => resumeJob(job(), sessionId, 'an answer')).toThrow(/session/);
});

// An empty prompt on stdin gives the engine nothing to continue with, and the run would fail with a
// reason nobody can act on.
it.each(['', '  \n'])('refuses the empty message %j, before anything is started', (message) => {
  expect(() => resumeJob(job(), 'a1b2c3d4-0000-4000-8000-000000000001', message)).toThrow(/message/);
});

it('resumes through the real process: the flag names the session and the message goes on stdin', async () => {
  const engine = real(`
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ stdin: input, argv: process.argv.slice(2) }) + String.fromCharCode(10));
    });
  `);
  const seen: string[] = [];
  const watching: RunEngine = { spawn: engine.spawn, parse: (line) => (seen.push(line), []) };

  await collect(watching, resumeJob({ ...job(), cwd }, 'a1b2c3d4-0000-4000-8000-000000000001', 'Use the name recipes_title_idx.'));
  const got = JSON.parse(seen[0] ?? '{}') as { stdin: string; argv: string[] };

  expect(got.stdin).toBe('Use the name recipes_title_idx.');
  expect(got.argv[got.argv.indexOf('--resume') + 1]).toBe('a1b2c3d4-0000-4000-8000-000000000001');
  expect(got.argv).not.toContain('--session-id');
});

// A tool result the agent read, the way the stream carries npm's answer inside it.
const NPM_404 = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'npm error 404 Not Found - GET https://registry.npmjs.org/@recipes%2fui - Not found' }] },
});

it('adds the npm login line to the reason when the run showed a 404 on a scoped package', async () => {
  const events = await collect(scripted([NPM_404, TEXT]));

  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).toMatch(/no result line.*The package registry refused @recipes.*npm login --scope=@recipes/);
});

it('adds the npm login line to a question the run asks after the 404', async () => {
  const asks = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'NOLZU: needs_input: The package @recipes/ui is missing. What now?' }] } });
  const events = await collect(scripted([NPM_404, asks, RESULT]));

  const question = events.find((event) => event.type === 'needs_input');
  expect(question?.type === 'needs_input' && question.question).toMatch(/^The package @recipes\/ui is missing\. What now\?\n\nThe package registry refused @recipes/);
});

it('leaves the reason alone when no npm 404 showed', async () => {
  const events = await collect(scripted([TEXT]));

  const failed = events.at(-1);
  expect(failed?.type === 'failed' && failed.reason).not.toMatch(/registry/);
});

it('adds the npm login line to the quiet-run failure after a 404', async () => {
  vi.useFakeTimers();
  let now = 1_000_000;
  const run = collect(scripted([NPM_404], 'hang'), { timeoutMs: 60_000 }, undefined, { checkEveryMs: 1000, now: () => now });

  await vi.advanceTimersByTimeAsync(0);
  now += 61_000;
  await vi.advanceTimersByTimeAsync(1000);
  const failed = (await run).at(-1);

  expect(failed?.type === 'failed' && failed.reason).toMatch(/printed nothing for.*The package registry refused @recipes/);
});

it('adds the npm login line to the log-failure reason after a 404', async () => {
  let written = 0;
  const openLog = (): RunLog => ({
    write: () => {
      written += 1;
      if (written === 2) throw new Error('The run log could not take another line (ENOSPC).');
    },
    close: () => undefined,
  });

  const failed = (await collect(scripted([NPM_404, TEXT, RESULT]), {}, undefined, { openLog })).at(-1);

  expect(failed?.type === 'failed' && failed.reason).toMatch(/ENOSPC.*The package registry refused @recipes/);
});

it("fails an implement run that changed the checkout's git pointer, even after its result line", async () => {
  const engine = real(`
    process.stdout.write(${JSON.stringify(RESULT)} + String.fromCharCode(10));
    require('node:fs').writeFileSync('.git', 'gitdir: /elsewhere' + String.fromCharCode(10));
    process.exit(0);
  `);
  writeFileSync(join(cwd, '.git'), 'gitdir: /work/app/.git/worktrees/APP-1\n');

  const events = await collect(engine, { phase: 'implement' });

  expect(types(events)).toEqual(['complete', 'failed']);
  // A check's stop is never retried: the next attempt would read what the run left as the state before.
  expect(events.at(-1)).toMatchObject({ type: 'failed', reason: POINTER_CHANGED, halted: true });
});

// A reader that stops early never takes another event, so a halt that comes as the engine closes goes
// to it as an error, and the run does not hang with its log open.
it('hands a halt to a reader that left, and does not hang', async () => {
  const engine: RunEngine = {
    parse,
    async *spawn() {
      try {
        yield TEXT;
        yield RESULT;
      } finally {
        // eslint-disable-next-line no-unsafe-finally -- the engine's check after the run, as runProcess throws it
        throw new RunHalted('left a hook');
      }
    },
  };
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-run-'));
  const read = async () => {
    for await (const event of runJob(engine, { ...job(), cwd }, new AbortController().signal)) if (event.type === 'text') break;
  };

  await expect(read()).rejects.toThrow('left a hook');
});

