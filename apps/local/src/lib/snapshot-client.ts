import type { BoardSnapshot, ProfileLimit, RunActivity } from '@nolzu/protocol';

// What the client needs from the browser's EventSource, so a test can drive it by hand.
export interface StreamSource {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  // The named `activity` event. Optional, so a source that never sends one still fits.
  onactivity?: ((event: { data: string }) => void) | null;
  // The named `limits` event, optional for the same reason.
  onlimits?: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

// `T` is what each unnamed event carries: one board, or Now's view of every board.
export interface BoardState<T = BoardSnapshot> {
  // The last board the stream sent, kept while the stream is down, so the page never goes blank.
  snapshot: T | null;
  reconnecting: boolean;
  // The last activity of each card's run, by card key. A card shows it only while it runs that run,
  // so an entry left from an earlier run draws nothing.
  activity: Readonly<Record<string, RunActivity>>;
  // What each engine profile last reported about its usage windows, by profile id. The drop box reads
  // it. It stays on this machine, so it never rides inside the board.
  limits: Readonly<Record<string, ProfileLimit>>;
}

// The name the board stream gives its usage event.
export const LIMITS_EVENT = 'limits';

// The readings a connection starts with, before its first limits event. Its own object, so a reader can
// tell it from a limits event that held no reading.
export const NO_LIMITS: Readonly<Record<string, ProfileLimit>> = {};

// The name the board stream gives its activity event. One value for the stream and the listener, so
// the two cannot drift apart while every test still passes.
export const ACTIVITY_EVENT = 'activity';

const FIRST_WAIT_MS = 1000;
const LONGEST_WAIT_MS = 30_000;

// A whole board and not a line cut off in transit, or one a newer server writes differently.
export const isBoard = (value: unknown): value is BoardSnapshot =>
  typeof value === 'object' && value !== null && Array.isArray((value as BoardSnapshot).cards) && Array.isArray((value as BoardSnapshot).stages);

// A line cut off in transit reads as nothing, which neither guard takes.
const read = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};

const isActivity = (value: unknown): value is RunActivity => {
  const one = value as RunActivity | null;
  return (
    typeof one === 'object' && one !== null && typeof one.runId === 'number' && typeof one.cardKey === 'string' && typeof one.outputAt === 'number' && (one.line === null || typeof one.line === 'string')
  );
};

// Every reading whole, or the event is dropped: a half-read one would put a figure on a profile it
// does not belong to.
const isLimits = (value: unknown): value is Record<string, ProfileLimit> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((one: ProfileLimit | null) => typeof one === 'object' && one !== null && typeof one.seenAt === 'number' && Array.isArray(one.windows));

// The board as the server streams it. The page holds nothing else: busy state, a card's stage and its
// run all come from here, never from the answer to a request. On an error the stream is closed and
// opened again after a wait that doubles up to half a minute, because the browser's own retry gives up
// for good when the server answers with an error status. `accept` is what a whole event must look
// like, a board unless the stream sends something else, such as Now's view of every board.
export function connectBoard<T = BoardSnapshot>(
  open: () => StreamSource,
  onState: (state: BoardState<T>) => void,
  accept: (value: unknown) => value is T = isBoard as unknown as (value: unknown) => value is T,
): { close(): void } {
  let state: BoardState<T> = { snapshot: null, reconnecting: false, activity: {}, limits: NO_LIMITS };
  let source: StreamSource | null = null;
  let wait = FIRST_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const set = (next: BoardState<T>) => {
    state = next;
    onState(state);
  };

  const connect = () => {
    timer = null;
    if (closed) return;
    const opened = open();
    source = opened;
    const up = () => {
      wait = FIRST_WAIT_MS;
      if (state.reconnecting) set({ ...state, reconnecting: false });
    };
    opened.onopen = up;
    opened.onmessage = (event) => {
      const parsed = read(event.data);
      if (!accept(parsed)) return;
      wait = FIRST_WAIT_MS;
      set({ ...state, snapshot: parsed, reconnecting: false });
    };
    opened.onactivity = (event) => {
      const parsed = read(event.data);
      if (!isActivity(parsed)) return;
      set({ ...state, activity: { ...state.activity, [parsed.cardKey]: parsed } });
    };
    opened.onlimits = (event) => {
      const parsed = read(event.data);
      if (isLimits(parsed)) set({ ...state, limits: parsed });
    };
    opened.onerror = () => {
      opened.close();
      if (closed || timer !== null) return;
      set({ ...state, reconnecting: true });
      timer = setTimeout(connect, wait);
      wait = Math.min(wait * 2, LONGEST_WAIT_MS);
    };
  };

  connect();
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
    },
  };
}

// The browser's EventSource behind the small interface above, so the client never depends on the DOM
// types and a test drives the same interface by hand.
export const browserStream =
  (url: string) =>
  (): StreamSource => {
    const events = new EventSource(url);
    const stream: StreamSource = {
      onopen: null,
      onmessage: null,
      onactivity: null,
      onlimits: null,
      onerror: null,
      close: () => events.close(),
    };
    events.onopen = () => stream.onopen?.();
    events.onmessage = (event: MessageEvent<string>) => stream.onmessage?.({ data: event.data });
    // A named event never reaches onmessage.
    events.addEventListener(ACTIVITY_EVENT, (event: MessageEvent<string>) => stream.onactivity?.({ data: event.data }));
    events.addEventListener(LIMITS_EVENT, (event: MessageEvent<string>) => stream.onlimits?.({ data: event.data }));
    events.onerror = () => stream.onerror?.();
    return stream;
  };
