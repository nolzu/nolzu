import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteInRunLog, openRunLog, retryInRunLog, runLogNote, runLogRetry, runLogTime, tailLog, timeInRunLog } from './log.ts';
import { parseRunLine } from './select.ts';

// Lets a test make the system take fewer bytes than asked, which a full disk or a file size limit does
// without an error. Every other call goes to the real function.
const short = vi.hoisted(() => ({ max: Number.POSITIVE_INFINITY }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    writeSync: (fd: number, data: Buffer, offset = 0, length = data.length - offset) =>
      fs.writeSync(fd, data, offset, Math.min(length, short.max)),
  };
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-log-'));
});

afterEach(() => {
  short.max = Number.POSITIVE_INFINITY;
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const LINES = ['{"type":"system","subtype":"init"}', '{"type":"assistant","text":"a line with a \\u00e9 and a \\n inside"}', '{"type":"result"}'];

it('writes each line word for word and in order, one per line', () => {
  const log = openRunLog(join(dir, 'logs', 'APP-1-refine-1.ndjson'));
  for (const line of LINES) log.write(line);
  log.close();

  const text = readFileSync(join(dir, 'logs', 'APP-1-refine-1.ndjson'), 'utf8');
  expect(text).toBe(`${LINES.join('\n')}\n`);
  // Read back, the file gives the same objects the engine printed.
  expect(text.trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual(LINES.map((line) => JSON.parse(line)));
});

it('makes the folder when it is missing', () => {
  const log = openRunLog(join(dir, 'a', 'b', 'logs', '1.ndjson'));
  log.write('{}');
  log.close();

  expect(readFileSync(join(dir, 'a', 'b', 'logs', '1.ndjson'), 'utf8')).toBe('{}\n');
});

// A retry of the same run writes into the same file, and what the first attempt printed stays.
it('adds to a file that is already there rather than starting it again', () => {
  const path = join(dir, '1.ndjson');
  writeFileSync(path, '{"first":true}\n');

  const log = openRunLog(path);
  log.write('{"second":true}');
  log.close();

  expect(readFileSync(path, 'utf8')).toBe('{"first":true}\n{"second":true}\n');
});

// Each line is on disk before the next one is read, so a run killed in the middle leaves a file
// whose last line is whole.
it('has every line on disk the moment write returns', () => {
  const path = join(dir, '1.ndjson');
  const log = openRunLog(path);

  log.write('{"a":1}');
  expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  log.write('{"b":2}');
  expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  log.close();
});

// The system may take part of a write and report how much, with no error. Taken at its word, the
// rest of the line is lost, and the next line is glued onto the half that is there.
it('writes the whole line when the system takes it a few bytes at a time', () => {
  const path = join(dir, '1.ndjson');
  const long = JSON.stringify({ text: 'x'.repeat(5000) });
  short.max = 7;
  const log = openRunLog(path);
  log.write(long);
  log.write('{"next":true}');
  log.close();

  expect(readFileSync(path, 'utf8')).toBe(`${long}\n{"next":true}\n`);
});

// The log holds the agent's whole transcript, with whatever it printed, secrets included.
it('keeps the log readable by its owner only', () => {
  const path = join(dir, 'logs', '1.ndjson');
  const log = openRunLog(path);
  log.close();

  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('names the path when the folder cannot be written', () => {
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  const path = join(locked, 'logs', '1.ndjson');

  expect(() => openRunLog(path)).toThrow(path);
});

it('can be closed twice, because a run closes it on every way out', () => {
  const log = openRunLog(join(dir, '1.ndjson'));
  log.close();

  expect(() => log.close()).not.toThrow();
});

// The descriptors this process holds open, read from the system. A promise based file handle does
// not show up among Node's active resources, so that list cannot tell a handle that was kept.
const fileHandles = () => readdirSync('/dev/fd').length;

async function take(lines: AsyncIterator<string>, count: number): Promise<string[]> {
  const got: string[] = [];
  while (got.length < count) {
    const next = await lines.next();
    if (next.done === true) break;
    got.push(next.value);
  }
  return got;
}

it('replays the lines already there, then delivers what is added, and lets go of the file on abort', async () => {
  const path = join(dir, '1.ndjson');
  writeFileSync(path, '{"a":1}\n{"b":2}\n');
  const before = fileHandles();
  const controller = new AbortController();
  const lines = tailLog(path, controller.signal, { pollMs: 10 })[Symbol.asyncIterator]();

  expect(await take(lines, 2)).toEqual(['{"a":1}', '{"b":2}']);
  appendFileSync(path, '{"c":3}\n');
  expect(await take(lines, 1)).toEqual(['{"c":3}']);
  appendFileSync(path, '{"d":4}\n');
  expect(await take(lines, 1)).toEqual(['{"d":4}']);

  controller.abort();
  expect((await lines.next()).done).toBe(true);
  expect(fileHandles()).toBe(before);
});

// A writer can be caught halfway through a line. The half is held until its end arrives, so the
// reader never hands on a fragment that does not parse.
it('holds back a line until its end has been written', async () => {
  const path = join(dir, '1.ndjson');
  writeFileSync(path, '{"a":');
  const controller = new AbortController();
  const lines = tailLog(path, controller.signal, { pollMs: 10 })[Symbol.asyncIterator]();

  const first = lines.next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  appendFileSync(path, '1}\n');

  expect((await first).value).toBe('{"a":1}');
  controller.abort();
  await lines.return?.(undefined);
});

// The log tab can open before the engine printed anything, when the file does not exist yet.
it('waits for a file that is not there yet', async () => {
  const path = join(dir, 'later.ndjson');
  const controller = new AbortController();
  const lines = tailLog(path, controller.signal, { pollMs: 10 })[Symbol.asyncIterator]();

  const first = lines.next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeFileSync(path, '{"late":true}\n');

  expect((await first).value).toBe('{"late":true}');
  controller.abort();
  await lines.return?.(undefined);
});

// Aborted while the file is still missing. Waiting for the file again after the abort would poll
// for as long as the process lives.
it('stops waiting for a missing file when the signal is aborted', async () => {
  const controller = new AbortController();
  const lines = tailLog(join(dir, 'never.ndjson'), controller.signal, { pollMs: 10 })[Symbol.asyncIterator]();

  const first = lines.next();
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();

  expect((await first).done).toBe(true);
});

it('ends at once for a signal that is already aborted', async () => {
  const path = join(dir, '1.ndjson');
  writeFileSync(path, '{"a":1}\n');
  const controller = new AbortController();
  controller.abort();

  const got: string[] = [];
  for await (const line of tailLog(path, controller.signal, { pollMs: 10 })) got.push(line);

  expect(got).toEqual([]);
});

// A download wants the file as it is now, not a stream that waits for more.
it('stops at the end of the file when asked not to follow it', async () => {
  const path = join(dir, 'run.ndjson');
  writeFileSync(path, 'one\ntwo\n');
  const lines: string[] = [];

  for await (const line of tailLog(path, new AbortController().signal, { pollMs: 10, follow: false })) lines.push(line);

  expect(lines).toEqual(['one', 'two']);
});

it('ends at once without following when the file is not there', async () => {
  const lines: string[] = [];
  for await (const line of tailLog(join(dir, 'missing.ndjson'), new AbortController().signal, { pollMs: 10, follow: false })) lines.push(line);

  expect(lines).toEqual([]);
});

// Nolzu's own line after the run: appended to what the engine wrote, and shown on the Log tab
// whatever engine that was.
it('adds a note of its own after the engine lines, which every parser reads as text', () => {
  const path = join(dir, 'logs', 'APP-1-plan-1.ndjson');
  const log = openRunLog(path);
  log.write(LINES[0] ?? '');
  log.close();
  noteInRunLog(path, 'The plan named billing, which the project does not list.');

  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  expect(lines[0]).toBe(LINES[0]);
  expect(runLogNote(lines[1] ?? '')).toBe('The plan named billing, which the project does not list.');
  for (const profile of ['claude-code#work', 'codex#work', 'cursor#work']) {
    expect(parseRunLine(lines[1] ?? '', profile)).toEqual([{ type: 'text', text: 'The plan named billing, which the project does not list.' }]);
  }
  expect(runLogNote(LINES[1] ?? '')).toBeNull();
  expect(runLogNote('{"type":"nolzu"')).toBeNull();
});

// An engine line that only holds the word in some other field is the engine's, not a note.
it('reads no note from an engine line that names nolzu outside its type', () => {
  expect(runLogNote(JSON.stringify({ type: 'assistant', text: 'Plan written.', tool: 'nolzu' }))).toBeNull();
});

// The wait Nolzu holds after an API error: no engine printed it, so it goes into the log as a line of
// Nolzu's own, and every parser reads it back as the wait with the time the next try starts.
it('writes a retry wait into the log, which every parser reads back with its countdown', () => {
  const path = join(dir, 'logs', 'APP-1-plan-1.ndjson');
  const wait = { type: 'api_retry', attempt: 2, delayMs: 300_000, status: 529, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: 1_790_000_300_000 } as const;
  retryInRunLog(path, wait);

  const [line] = readFileSync(path, 'utf8').trimEnd().split('\n');
  for (const profile of ['claude-code#work', 'codex#work', 'cursor#work']) {
    expect(parseRunLine(line ?? '', profile)).toEqual([wait]);
  }
  expect(runLogNote(line ?? '')).toBeNull();
});

it('reads no wait from a line of another kind, or one with its numbers missing', () => {
  expect(runLogRetry(LINES[0] ?? '')).toBeNull();
  expect(runLogRetry('{"type":"nolzu.retry","retry":{"attempt":"2"}}')).toBeNull();
  expect(runLogRetry('{"type":"nolzu.retry"')).toBeNull();
  // A wait from before the countdown, with no time on it, still reads as a wait.
  expect(runLogRetry('{"type":"nolzu.retry","retry":{"attempt":1,"delayMs":2000}}')).toEqual({ type: 'api_retry', attempt: 1, delayMs: 2000, status: null, maxRetries: null, reason: null });
});

// The time the runner notes in front of a line is no event. Every parser skips it, and the log route
// reads it apart for the Log tab's time column.
it('reads back the time noted in front of a line, which no parser reads as an event', () => {
  const line = timeInRunLog(1_790_000_004_000);

  expect(runLogTime(line)).toBe(1_790_000_004_000);
  for (const profile of ['claude-code#work', 'codex#work', 'cursor#work']) {
    expect(parseRunLine(line, profile)).toEqual([]);
  }
  expect(runLogNote(line)).toBeNull();
  expect(runLogRetry(line)).toBeNull();
});

it('reads no time from an engine line, or from a mark with no number', () => {
  expect(runLogTime(LINES[0] ?? '')).toBeNull();
  expect(runLogTime(JSON.stringify({ type: 'assistant', text: 'The type is "nolzu.at".' }))).toBeNull();
  expect(runLogTime('{"type":"nolzu.at","at":"soon"}')).toBeNull();
  expect(runLogTime('{"type":"nolzu.at"')).toBeNull();
});
