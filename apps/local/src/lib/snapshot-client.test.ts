import type { BoardSnapshot } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectBoard, type BoardState, type StreamSource } from './snapshot-client.ts';

// A stand-in for the browser's EventSource that a test drives by hand.
class Stub implements StreamSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onactivity: ((event: { data: string }) => void) | null = null;
  onlimits: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
}

let sources: Stub[] = [];
let states: BoardState[] = [];
const open = () => {
  const source = new Stub();
  sources.push(source);
  return source;
};
const last = () => states.at(-1);
const board = (version: number, stage = 'inbox'): BoardSnapshot => ({
  version,
  kind: 'delivery',
  flow: 'pull-request',
  stages: [],
  cards: [
    {
      key: 'APP-1', title: 'A card', stage, state: 'idle', queuePosition: null, runId: null, runState: null, runStartedAt: null,
      lane: null, engine: null, model: null, effort: null, costUsd: null, totalUsd: null, question: null, failureReason: null, minimized: false, verdict: null, verdictReason: null, pull: null, starts: null, delivered: null,
    },
  ],
  slots: { busy: 0, total: 3 },
  lanes: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  states = [];
});
afterEach(() => vi.useRealTimers());

it('hands on each board the stream sends, the later one in place of the earlier', () => {
  connectBoard(open, (state) => states.push(state));

  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });
  sources[0]?.onmessage?.({ data: JSON.stringify(board(2, 'refine')) });

  expect(last()?.snapshot?.cards[0]?.stage).toBe('refine');
  expect(last()?.reconnecting).toBe(false);
});

// The named event of a running agent, kept per card beside the board, and kept when the next board comes.
it('keeps the last activity of each card, and keeps it across a new board', () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });
  const activity = { runId: 3, cardKey: 'APP-1', line: 'Reading services/api/src/recipes/list.ts', outputAt: 1_760_000_000_000 };

  sources[0]?.onactivity?.({ data: JSON.stringify({ ...activity, line: null }) });
  sources[0]?.onactivity?.({ data: JSON.stringify(activity) });
  sources[0]?.onmessage?.({ data: JSON.stringify(board(2, 'refine')) });

  expect(last()?.activity).toEqual({ 'APP-1': activity });
  expect(last()?.snapshot?.version).toBe(2);
});

// Two cards running at once. Each event lands under the card it names, and the other card keeps its own.
it('keeps the activity of each card under its own key', () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });
  const first = { runId: 3, cardKey: 'APP-1', line: 'Reading a.ts', outputAt: 1_760_000_000_000 };
  const second = { runId: 4, cardKey: 'APP-2', line: 'Reading b.ts', outputAt: 1_760_000_001_000 };

  sources[0]?.onactivity?.({ data: JSON.stringify(first) });
  sources[0]?.onactivity?.({ data: JSON.stringify(second) });

  expect(last()?.activity).toEqual({ 'APP-1': first, 'APP-2': second });
});

it('drops an activity event that is not one', () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });

  sources[0]?.onactivity?.({ data: 'not json {' });
  sources[0]?.onactivity?.({ data: '{"cardKey": "APP-1", "line": "Reading a.ts"}' });

  expect(last()?.activity).toEqual({});
});

// What each engine last reported about its usage windows, by profile. It comes as its own event, never
// inside the board, and the next one replaces it whole, so a profile whose reading went goes too.
it('keeps the last usage readings beside the board, and replaces them whole', () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });
  const reading = { seenAt: 1_760_000_000_000, windows: [{ name: 'five_hour', used: 0.62, resetsAt: 1_760_010_000, status: 'allowed' }] };

  expect(last()?.limits).toEqual({});
  sources[0]?.onlimits?.({ data: JSON.stringify({ 'claude-code': reading, 'codex#work': reading }) });
  sources[0]?.onmessage?.({ data: JSON.stringify(board(2)) });
  expect(last()?.limits).toEqual({ 'claude-code': reading, 'codex#work': reading });

  sources[0]?.onlimits?.({ data: JSON.stringify({ 'claude-code': reading }) });
  expect(last()?.limits).toEqual({ 'claude-code': reading });
});

it('drops a usage event that is not one', () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });

  sources[0]?.onlimits?.({ data: 'not json {' });
  sources[0]?.onlimits?.({ data: '[]' });
  sources[0]?.onlimits?.({ data: '{"claude-code": {"seenAt": "today", "windows": []}}' });
  sources[0]?.onlimits?.({ data: '{"claude-code": {"seenAt": 1}}' });

  expect(last()?.limits).toEqual({});
});

// A line that is not a board, cut off in transit or from a newer server, must not blank the page.
it('keeps the last board when a message is not one', () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });

  sources[0]?.onmessage?.({ data: 'not json {' });
  sources[0]?.onmessage?.({ data: '{"version": 3}' });

  expect(last()?.snapshot?.version).toBe(1);
});

it('says it is reconnecting after an error, and tries again with a growing wait', async () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onmessage?.({ data: JSON.stringify(board(1)) });

  sources[0]?.onerror?.();
  expect(last()?.reconnecting).toBe(true);
  // The board it had stays on the page while it reconnects.
  expect(last()?.snapshot?.version).toBe(1);
  expect(sources[0]?.closed).toBe(true);

  await vi.advanceTimersByTimeAsync(1000);
  expect(sources).toHaveLength(2);
  sources[1]?.onerror?.();
  await vi.advanceTimersByTimeAsync(1999);
  expect(sources).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sources).toHaveLength(3);
});

it('stops saying reconnecting once the stream opens again, and starts the wait over', async () => {
  connectBoard(open, (state) => states.push(state));
  sources[0]?.onerror?.();
  await vi.advanceTimersByTimeAsync(1000);

  sources[1]?.onopen?.();
  expect(last()?.reconnecting).toBe(false);
  sources[1]?.onerror?.();
  await vi.advanceTimersByTimeAsync(1000);

  expect(sources).toHaveLength(3);
});

it('never waits longer than half a minute between tries', async () => {
  connectBoard(open, (state) => states.push(state));
  for (let tries = 0; tries < 10; tries += 1) {
    sources.at(-1)?.onerror?.();
    await vi.advanceTimersByTimeAsync(30_000);
  }

  expect(sources).toHaveLength(11);
});

it('closes the stream and tries nothing more once closed', async () => {
  const client = connectBoard(open, (state) => states.push(state));
  sources[0]?.onerror?.();

  client.close();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sources).toHaveLength(1);
});

// A browser can report an error on a stream that is already being closed. A page that left must not
// open a new one.
it('opens nothing when an error arrives after the client was closed', async () => {
  const client = connectBoard(open, (state) => states.push(state));

  client.close();
  sources[0]?.onerror?.();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(sources).toHaveLength(1);
  // Nor is the page told it is reconnecting: it is gone.
  expect(states).toEqual([]);
});
