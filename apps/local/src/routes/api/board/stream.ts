import { getSetting } from '@nolzu/core/node';
import { isBoardKind, type RunActivity } from '@nolzu/protocol';
import type { Loop } from '../../../lib/loop.ts';
import { ACTIVITY_EVENT, LIMITS_EVENT } from '../../../lib/snapshot-client.ts';

// Long enough that an idle board stays quiet, short enough that whatever sits between the browser
// and this process does not drop a connection it thinks died.
export const HEARTBEAT_MS = 15_000;

// The board as an event stream. Every unnamed event is a whole snapshot, which is what makes a
// reconnect cheap: there is nothing to replay, because nothing is ever partial.
//
// The one partial thing is the named `activity` event: a running agent's last tool action and the
// time of its last output, sent on every engine event. It carries no id, so the last event id stays
// the board's version, and it is never replayed either: a new connection gets the current ones
// after its first board.
//
// The named `limits` event is what each engine profile last reported about its usage windows, for the
// drop box. It goes after the first board of each connection, and after a later board when it changed
// since the last one this stream sent. It rides apart from the board because the board's shape may go to the hub
// one day, and limit state never leaves this machine.
//
// `Last-Event-ID` is deliberately not read. A client sends it to ask for what it missed, and the
// answer here is the board as it stands, whose version can only have risen, so it is never older
// than the id the client already had. The one way that promise breaks is a database restored from a
// backup, where the counter goes back. That case is known and not worked around here.
export function stream(live: Loop, request: Request): Response {
  // The board this stream serves, from its own address, so one page can open a second board
  // without a second endpoint. A name that is no board is a page that is not there.
  const asked = new URL(request.url).searchParams.get('board');
  const kind = asked === null ? 'delivery' : isBoardKind(asked) ? asked : null;
  if (kind === null) return new Response(`There is no ${asked} board.`, { status: 404 });
  return events(live, request, () => live.snapshot(kind));
}

// The stream itself, for anything whole that carries the board version: one board, or Now's view of
// every board. Everything said above holds for both.
export function events(live: Loop, request: Request, read: () => { version: number }): Response {
  const encode = new TextEncoder();
  let leave: (() => void) | null = null;
  let leaveActivity: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    leave?.();
    leave = null;
    leaveActivity?.();
    leaveActivity = null;
    if (beat !== null) {
      clearInterval(beat);
      beat = null;
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Null, so each new stream sends the readings once, an empty set too. The page keeps its readings
      // across a reconnect, and a set cleared while the stream was down would leave the old figure up.
      let limits: string | null = null;
      const send = (): void => {
        const snapshot = read();
        controller.enqueue(encode.encode(`id: ${snapshot.version}\ndata: ${JSON.stringify(snapshot)}\n\n`));
        const seen = JSON.stringify(getSetting(live.db, 'engineLimits'));
        if (seen === limits) return;
        limits = seen;
        controller.enqueue(encode.encode(`event: ${LIMITS_EVENT}\ndata: ${seen}\n\n`));
      };

      // Named, so a client that knows no activity never reads it as a board.
      const tell = (activity: RunActivity): void => {
        controller.enqueue(encode.encode(`event: ${ACTIVITY_EVENT}\ndata: ${JSON.stringify(activity)}\n\n`));
      };

      // Sent while the stream is being built, not after the handler returns. Left until afterwards,
      // adapter-node holds it and the client waits for a board it has already asked for.
      send();
      for (const activity of live.activity()) tell(activity);
      leave = live.onChange(send);
      leaveActivity = live.onActivity(tell);
      // A comment line. It costs the client nothing to read and keeps the connection alive.
      beat = setInterval(() => controller.enqueue(encode.encode(': keep alive\n\n')), HEARTBEAT_MS);
    },
    cancel() {
      stop();
    },
  });

  // Both ways out. A reader that cancels reaches `cancel`, and a request the browser drops reaches
  // the signal, and either one leaves a listener writing into nothing if it is not handled.
  request.signal.addEventListener('abort', stop, { once: true });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      // No store and no transform, or a proxy buffers the stream and the board arrives in bursts.
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
