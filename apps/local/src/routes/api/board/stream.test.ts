import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, readRun, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoop, type Loop } from '../../../lib/loop.ts';
import { HEARTBEAT_MS, stream } from './stream.ts';

let dir = '';
let live: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-stream-'));
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1' });
});

afterEach(() => {
  vi.useRealTimers();
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Through the real path, which moves the board version. A raw insert leaves it at zero, and then an
// id that was hardcoded to zero would satisfy every comparison below.
const addCard = (key: string, stage = 'inbox') =>
  createCard(live.db, { key, board: 'delivery', stage, title: `${key} title` });

const open = (headers: Record<string, string> = {}, board = '') => {
  const controller = new AbortController();
  const address = board === '' ? 'http://localhost/api/board' : `http://localhost/api/board?board=${board}`;
  const response = stream(live, new Request(address, { headers, signal: controller.signal }));
  const body = response.body;
  if (body === null) throw new Error(`the ${board === '' ? 'delivery' : board} stream sent no body`);
  return { response, controller, reader: body.getReader() };
};

const text = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);
const parse = (chunk: string) => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6).trim());
const idOf = (chunk: string) => Number(chunk.slice(chunk.indexOf('id: ') + 4, chunk.indexOf('\n')));

it('answers as an event stream and opens with a whole snapshot', async () => {
  addCard('APP-1');
  // One more change that is not a card, so the version and the number of cards cannot be the same
  // number. With one card and a version of one, an id taken from the card count reads as correct.
  writeSetting(live.db, 'modelPreset', 'heavy');
  const { response, reader } = open();

  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const first = await text(reader);
  const snapshot = parse(first);
  // The id IS the version, not merely something that rises. A stream resumes on this number, so a
  // constant would read as correct in every comparison and be wrong in the one thing it is for.
  expect(snapshot.version).toBeGreaterThan(0);
  expect(idOf(first)).toBe(snapshot.version);
  // Whole, so a client that just connected draws the board without asking for anything else.
  expect(snapshot.cards.map((card: { key: string }) => card.key)).toEqual(['APP-1']);
  await reader.cancel();
});

it('sends the first event before the handler has finished, so nothing buffers it', async () => {
  addCard('APP-1');
  const { reader } = open();

  // Read with no await in between that would let other work run. The first event is put into the
  // stream as it is built, not after the handler returns, which is what adapter-node would buffer.
  const first = await Promise.race([text(reader), new Promise((resolve) => setTimeout(() => resolve('nothing arrived'), 0))]);

  expect(first).toContain('data: ');
  await reader.cancel();
});

it('sends a second event after a change, with a higher id and the new state', async () => {
  addCard('APP-1');
  const { reader } = open();
  const first = await text(reader);
  // The usage readings, which follow the first board.
  await text(reader);

  await live.db.prepare("UPDATE cards SET stage = 'refine' WHERE key = 'APP-1'").run();
  live.changed();

  const second = await text(reader);
  expect(idOf(second)).toBeGreaterThanOrEqual(idOf(first));
  expect(parse(second).cards[0].stage).toBe('refine');
  await reader.cancel();
});

it('answers a reconnect with one whole snapshot, never older than the id it was sent', async () => {
  addCard('APP-1');
  const { reader: first } = open();
  const opening = idOf(await text(first));
  await first.cancel();

  const { reader } = open({ 'Last-Event-ID': String(opening) });
  const resumed = await text(reader);

  // Not a replay of what was missed. The snapshot is whole, so a reconnect is a fresh read, and its
  // id can never be older than the one the client already had.
  expect(idOf(resumed)).toBeGreaterThanOrEqual(opening);
  expect(parse(resumed).cards).toHaveLength(1);
  await reader.cancel();
});

it('sends a heartbeat on a stream where nothing happens', async () => {
  vi.useFakeTimers();
  addCard('APP-1');
  const { reader } = open();
  // The board, then the usage readings.
  await text(reader);
  await text(reader);

  vi.advanceTimersByTime(HEARTBEAT_MS);

  // A comment, so it costs a client nothing to read and keeps the connection from being dropped by
  // whatever sits between the two.
  expect(await text(reader)).toMatch(/^:/);
  await reader.cancel();
});

it('drops the listener when the request is aborted, so a later change writes to nothing', async () => {
  addCard('APP-1');
  const { controller, reader } = open();
  await text(reader);
  const before = live.listeners();

  controller.abort();

  // The board listener and the activity one.
  expect(live.listeners()).toBe(before - 2);
  // The change must not throw, which is what writing into a closed stream would do.
  expect(() => live.changed()).not.toThrow();
});

it('drops the listener when the reader cancels', async () => {
  addCard('APP-1');
  const { reader } = open();
  await text(reader);
  const before = live.listeners();

  await reader.cancel();

  // The board listener and the activity one.
  expect(live.listeners()).toBe(before - 2);
});

/**
 * What each engine last reported about its usage windows reaches the open board as a named event.
 *
 * It never rides inside the board, which may go to the hub one day, and it stays on this machine.
 * It goes after the first board of each connection, then after a board only when it changed.
 */
describe('the usage readings', () => {
  const reading = { seenAt: 1_760_000_000_000, windows: [{ name: 'five_hour', used: 0.62, resetsAt: 1_760_010_000, status: 'allowed' }] };
  const limitsOf = (chunk: string) => (chunk.startsWith('event: limits\n') ? JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6).trim()) : null);

  it('sends what was seen after the first board, with no id', async () => {
    writeSetting(live.db, 'engineLimits', { 'claude-code': reading });
    const { reader } = open();

    expect(parse(await text(reader)).kind).toBe('delivery');
    const next = await text(reader);
    expect(limitsOf(next)).toEqual({ 'claude-code': reading });
    expect(next).not.toContain('id: ');
    await reader.cancel();
  });

  // The page keeps its readings across a reconnect, so a new stream sends an empty set too. Otherwise a
  // reading cleared while the stream was down, such as a removed login's, stays on the drop box.
  it('sends an empty set after the first board, so a reconnected page drops its old readings', async () => {
    const { reader } = open();

    await text(reader);
    const next = await text(reader);
    expect(limitsOf(next)).toEqual({});
    await reader.cancel();
  });

  it('sends the readings again only once an engine reported a change', async () => {
    vi.useFakeTimers();
    const { reader } = open();
    await text(reader);
    expect(limitsOf(await text(reader))).toEqual({});

    writeSetting(live.db, 'engineLimits', { 'claude-code': reading });
    live.changed();
    await text(reader);
    expect(limitsOf(await text(reader))).toEqual({ 'claude-code': reading });

    // A change that leaves the readings as they were sends the board alone.
    live.changed();
    await text(reader);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(await text(reader)).toMatch(/^:/);
    await reader.cancel();
  });
});

/**
 * The board this stream serves comes from its own address.
 *
 * One page opens a second board without a second endpoint, and the snapshot says which board it is,
 * so a page that has moved to another board draws what the server sent and not what the address
 * said a moment ago.
 */
it.each(['epics', 'investigations', 'questions', 'prreview'])('streams the %s board when the address names it', async (board) => {
  addCard('APP-1');
  const { reader } = open({}, board);

  const snapshot = parse(await text(reader));

  expect(snapshot.kind).toBe(board);
  // The Delivery card is on another board, so it is not on this one. A board that showed every
  // card would be five copies of one list.
  expect(snapshot.cards).toEqual([]);
  expect(snapshot.stages.map((stage: { id: string }) => stage.id)).toContain(board === 'prreview' ? 'incoming' : 'inbox');
  await reader.cancel();
});

// The other side. No name is the Delivery board, which is what `/` opens.
it('streams the Delivery board when the address names none', async () => {
  addCard('APP-1');
  const { reader } = open();

  const snapshot = parse(await text(reader));

  expect(snapshot.kind).toBe('delivery');
  expect(snapshot.cards).toHaveLength(1);
  await reader.cancel();
});

// A name that is no board is a page that is not there. Answering with Delivery instead would show
// the wrong board's cards under the address the person typed.
it('answers 404 for a board name that is not one', () => {
  const response = stream(live, new Request('http://localhost/api/board?board=epic', { signal: new AbortController().signal }));

  expect(response.status).toBe(404);
});

/**
 * A running agent's tool reaches the open board as a small named event, not as a whole board.
 *
 * Through the real loop and the fake engine, whose refine reads one file. The event has no id, so the
 * browser's last event id stays the board version, and a page opened later still gets the line.
 */
describe('the activity of a running agent', () => {
  let quick = '';
  let fast: Loop;

  beforeEach(() => {
    quick = mkdtempSync(join(tmpdir(), 'nolzu-stream-activity-'));
    // Delay scale zero, so the run ends in microtasks and the test waits on no clock.
    fast = createLoop(quick, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
    createCard(fast.db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Add a search box' });
  });

  afterEach(() => {
    fast.close();
    rmSync(quick, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const reading = 'Reading services/api/src/recipes/list.ts';
  const activityOf = (chunk: string) => chunk.split('\n\n').filter((frame) => frame.startsWith('event: activity\n'));

  it('sends the tool the agent used as an activity event with no id', async () => {
    const response = stream(fast, new Request('http://localhost/api/board', { signal: new AbortController().signal }));
    const reader = response.body!.getReader();
    await text(reader);

    fast.start('APP-1', 'refine');
    let frames = '';
    while (!frames.includes(reading)) frames += await text(reader);

    const frame = activityOf(frames).find((one) => one.includes(reading)) ?? '';
    expect(frame).not.toMatch(/^id:/m);
    expect(JSON.parse(frame.slice(frame.indexOf('data: ') + 6))).toEqual({ runId: expect.any(Number), cardKey: 'APP-1', line: reading, outputAt: expect.any(Number) });
    await reader.cancel();
  });

  it('sends the current activity after the first board to a stream that opens mid-run', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const fake = fast.engine.spawn.bind(fast.engine);
    // The fake refine, held after its lines until the test has opened the stream.
    fast.engine.spawn = async function* (job, signal) {
      yield* fake(job, signal);
      if (job.phase === 'refine') await held;
    };
    fast.start('APP-1', 'refine');
    await vi.waitFor(() => expect(fast.activity()[0]?.line).toBe(reading));

    const response = stream(fast, new Request('http://localhost/api/board', { signal: new AbortController().signal }));
    const reader = response.body!.getReader();
    let frames = '';
    while (!frames.includes(reading)) frames += await text(reader);

    // The board first, then the activity, so the line lands on a card the page already draws.
    const [board, ...rest] = frames.split('\n\n');
    expect(parse(board ?? '').cards[0].state).toBe('running');
    // Built while the run has its line, which a board must never carry.
    expect(board).not.toContain('recipes/list.ts');
    expect(activityOf(rest.join('\n\n'))).toHaveLength(1);
    release();
    await reader.cancel();
  });

  // A stream that closed and kept listening would write into a response nobody reads. The loop drops a
  // listener that throws, so the run goes on either way, but the stream leaves first.
  it('stops telling a stream that closed', async () => {
    const before = fast.listeners();
    const response = stream(fast, new Request('http://localhost/api/board', { signal: new AbortController().signal }));
    const reader = response.body!.getReader();
    await text(reader);
    await reader.cancel();
    expect(fast.listeners()).toBe(before);

    fast.start('APP-1', 'refine');

    await vi.waitFor(() => expect(fast.snapshot().cards[0]?.state).toBe('ready'));
    const runId = fast.snapshot().cards[0]?.runId ?? 0;
    expect(readRun(fast.db, runId)?.state).toBe('complete');
    expect(fast.activity()).toEqual([]);
  });
});
