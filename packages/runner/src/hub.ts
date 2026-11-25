import {
  handshakeProtocols,
  type HubEnvelope,
  hubEnvelope,
  type HubFrame,
  isCloudDataDeleted,
  isHubRefusal,
  JOB_ACK,
  parseHubFrame,
  PING,
  PLAN_REFUSED,
  PONG,
  SERVER_MESSAGES,
  type ServerMessageType,
  serializeHubFrame,
} from '@nolzu/protocol';
import type { Keychain } from './keychain.ts';

// The outbound WebSocket to the user's own hub. The client always dials out, so the machine needs no
// inbound port and no address. This is the socket and nothing else: it holds the connection open,
// reads what the hub sends and acks it. What a job then does lives in the app.

// The one keychain name the device token lives under. `nolzu login` writes it, this reads it, and
// `nolzu logout` removes it.
export const DEVICE_TOKEN_NAME = 'device-token';

export const readDeviceToken = (keychain: Keychain): Promise<string | null> => keychain.read(DEVICE_TOKEN_NAME);

// What the client needs from a WebSocket, so a test drives a stub hub by hand and never opens a
// socket. Same shape as StreamSource in the app, for the same reason.
export interface HubSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

// `refused` is a token the hub will not take and a version it will not speak. `unpaid` is a third
// state and not a kind of `refused`, because the fix is a different one: a refused token sends a person
// to `nolzu login`, and an account whose plan does not open the hub is not repaired on this machine.
export type HubStatus = 'connecting' | 'open' | 'waiting' | 'refused' | 'unpaid' | 'closed';

export interface HubTimings {
  firstWaitMs: number;
  longestWaitMs: number;
  pingEveryMs: number;
  pongWithinMs: number;
}

// The pong window stays shorter than the ping interval, so one ping is outstanding at a time.
export const HUB_TIMINGS: HubTimings = { firstWaitMs: 1000, longestWaitMs: 60_000, pingEveryMs: 30_000, pongWithinMs: 10_000 };

export interface HubReader {
  // Every job the hub sends, in the order it sent them. A job that returns from here is acked, and one
  // this handler throws on is not, so the hub keeps it and sends it again on the next connect.
  onMessage?: (message: HubEnvelope<ServerMessageType>) => void;
  // A frame this build cannot read, or one that is not a job, and the sentence that says what is wrong
  // with it. The caller logs it. The connection stays open, see the comment on `unreadable` below.
  onUnreadable?: (reason: string) => void;
  // The hub closed because the person deleted their cloud data. The client has stopped dialling by
  // then, and the caller pauses sync until the person turns it back on.
  onDeleted?: () => void;
  timings?: HubTimings;
}

// The sentence a thrown value carries. Every throw in the reader is an Error, and the fallback is for
// code that threw something else.
const reason = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);

// A job is one of the messages the hub sends for this client to run. The wire also carries the hub's
// own `job.ack` for a report the runner filed, and the runner-direction types, and acking one of those
// would make the hub drop a queue row for a frame that was never a job.
const isJob = (frame: HubEnvelope): frame is HubEnvelope<ServerMessageType> => (SERVER_MESSAGES as readonly string[]).includes(frame.type);

/** The live connection, as the app holds it. `send` answers whether the frame went. */
export interface HubConnection {
  close(): void;
  send(frame: HubEnvelope): boolean;
}

/**
 * The connection to the hub, held open for as long as the app runs.
 *
 * A dropped connection is dialled again after a wait that doubles up to the cap, and the wait starts
 * over once a connection is open. A close code that means this client will not be served stops it, and
 * `close()` stops it from anywhere, including from inside the status callback.
 */
export function connectHub(open: () => HubSocket, onStatus: (status: HubStatus) => void, reader: HubReader = {}): HubConnection {
  const timings = reader.timings ?? HUB_TIMINGS;
  let socket: HubSocket | null = null;
  let wait = timings.firstWaitMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let pong: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // A frame this build cannot read is reported and the connection stays open. The socket itself is
  // fine, the other jobs on it are fine, and the bad frame is never acked, so the hub keeps it. Closing
  // here would instead drop the heartbeat and every queued job, and the same frame would arrive again
  // on the next connect, once a second for as long as the app runs.
  const unreadable = (sentence: string) => reader.onUnreadable?.(sentence);

  const stopHeartbeat = () => {
    if (ping !== null) clearInterval(ping);
    if (pong !== null) clearTimeout(pong);
    ping = null;
    pong = null;
  };

  const retry = () => {
    timer = setTimeout(connect, wait);
    wait = Math.min(wait * 2, timings.longestWaitMs);
    onStatus('waiting');
  };

  // The end of one connection, from its close event or from a heartbeat nothing answered. Guarded on
  // the socket it was called for, so a close event that arrives after the heartbeat gave up does not
  // start a second connection.
  const drop = (dialed: HubSocket, code: number, closeReason?: string) => {
    if (socket !== dialed) return;
    socket = null;
    stopHeartbeat();
    dialed.close();
    // A dial again would send the board back up and undo the delete, so this stops for good too.
    if (isCloudDataDeleted(code, closeReason)) {
      stopped = true;
      onStatus('closed');
      reader.onDeleted?.();
      return;
    }
    // A revoked token, a version the hub will not speak and a plan that does not open the hub all need
    // something to change first, so there is no retry here. Trying again would hammer the hub for as
    // long as the app runs. The plan gets its own status: the caller shows what to do, and the two have
    // different answers.
    if (isHubRefusal(code)) {
      onStatus(code === PLAN_REFUSED ? 'unpaid' : 'refused');
      return;
    }
    retry();
  };

  function connect() {
    timer = null;
    onStatus('connecting');
    const dialed = open();
    // The caller may have closed the client while it was being told, and by then the socket is in
    // the air already.
    if (stopped) {
      dialed.close();
      return;
    }
    socket = dialed;
    dialed.onopen = () => {
      wait = timings.firstWaitMs;
      onStatus('open');
      // The caller may have closed the client while it was being told, and a heartbeat started after
      // that would hold the process open and go on pinging a socket that is gone.
      if (socket !== dialed) return;
      ping = setInterval(() => {
        dialed.send(PING);
        pong = setTimeout(() => {
          pong = null;
          // Nothing answered. close() may itself wait for a peer that is gone, so the connection is
          // given up here and not when its close event arrives.
          drop(dialed, 1006);
        }, timings.pongWithinMs);
      }, timings.pingEveryMs);
    };
    dialed.onmessage = (event) => {
      // A frame that arrives on a connection already given up reaches nobody. `pong` belongs to
      // whichever connection is live, so a late pong would otherwise cancel the next connection's
      // timer and hide a dead link, and a late job would be acked on a socket that is gone.
      if (socket !== dialed) return;

      if (typeof event.data !== 'string') {
        unreadable('A hub frame arrived that is not text.');
        return;
      }
      let frame: HubFrame;
      try {
        frame = parseHubFrame(event.data);
      } catch (error) {
        unreadable(reason(error, 'A hub frame arrived that could not be read.'));
        return;
      }

      if (frame === PONG) {
        if (pong === null) return;
        clearTimeout(pong);
        pong = null;
        return;
      }
      // The hub asking whether this client is still there. Answering costs one frame, and a hub that
      // gets no answer has to treat the connection as dead.
      if (frame === PING) {
        dialed.send(PONG);
        return;
      }

      // Not a job, so there is nothing to run and nothing to ack. It is reported rather than dropped in
      // silence, and the handler for the hub's acks arrives with the reports it acks.
      if (!isJob(frame)) {
        unreadable('A hub frame arrived that is not a job for this client.');
        return;
      }

      try {
        reader.onMessage?.(frame);
      } catch (error) {
        unreadable(reason(error, 'A hub message could not be taken.'));
        return;
      }
      // The ack says the message was taken, not that the work is done. The hub drops a job on this ack
      // and keeps every job it has not seen one for, so a crash between the two redelivers the job.
      // It names the job's project back, so a hub that sent one can tell two projects' acks apart.
      dialed.send(serializeHubFrame(hubEnvelope(JOB_ACK, frame.job, null, frame.project)));
    };
    dialed.onclose = (event) => drop(dialed, event.code, event.reason);
  }

  connect();
  return {
    // A frame the caller wrote, on the socket that is up now. False while there is none, and false
    // when the socket threw on the way out: a machine with no connection loses the frame, and the
    // caller is the one that has to tell the person, so this may not throw.
    send(frame) {
      if (socket === null) return false;
      try {
        socket.send(serializeHubFrame(frame));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stopHeartbeat();
      socket?.close();
      socket = null;
      onStatus('closed');
    },
  };
}

export interface HubDial extends HubReader {
  keychain: Keychain;
  url: string;
  onStatus: (status: HubStatus) => void;
  // How a socket is opened, so a test drives a stub hub instead of the network.
  socket?: (url: string, token: string) => () => HubSocket;
}

/**
 * The connection for the account this machine is signed in as.
 *
 * Null when the keychain holds no device token. That is every client that has not run `nolzu login`,
 * and it is not an error: the local product is whole without an account.
 */
export async function connectToHub(dial: HubDial): Promise<HubConnection | null> {
  const token = await readDeviceToken(dial.keychain);
  if (token === null) return null;
  return connectHub((dial.socket ?? hubSocket)(dial.url, token), dial.onStatus, dial);
}

// A Node WebSocket behind the small interface above. @types/node declares no WebSocket, so the global
// is typed here, with the members the browser API has always had.
type SocketClass = new (url: string, protocols: string[]) => HubSocket;

export const hubSocket =
  (url: string, token: string) =>
  (): HubSocket => {
    const Socket = (globalThis as { WebSocket?: SocketClass }).WebSocket;
    if (Socket === undefined) throw new Error('This Node build has no WebSocket, so Nolzu cannot reach the hub. Node 22.16 or newer, which Nolzu needs, has one.');
    return new Socket(url, handshakeProtocols(token));
  };
