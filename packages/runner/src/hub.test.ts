import {
  CLOUD_DATA_DELETED,
  CLOUD_DATA_DELETED_REASON,
  handshakeProtocols,
  HUB_PROTOCOL,
  type HubEnvelope,
  hubEnvelope,
  JOB_ACK,
  PING,
  PLAN_REFUSED,
  PONG,
  PROTOCOL_REFUSED,
  serializeHubFrame,
  TOKEN_REFUSED,
} from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectHub, connectToHub, HUB_TIMINGS, type HubReader, type HubSocket, type HubStatus } from './hub.ts';
import type { Keychain } from './keychain.ts';

// One connection of the stub hub, driven by the test.
interface Dialed extends HubSocket {
  sent: string[];
  closes: number;
  opens(): void;
  says(data: unknown): void;
  drops(code: number): void;
}

const dialed = (): Dialed => {
  const socket: Dialed = {
    onopen: null,
    onmessage: null,
    onclose: null,
    sent: [],
    closes: 0,
    send: (data) => {
      socket.sent.push(data);
    },
    close: () => {
      socket.closes += 1;
      // A real socket answers a close with a close event, a moment later, which is the case where the
      // client has to know it has already given this connection up.
      setTimeout(() => socket.onclose?.({ code: 1000 }), ANSWER_MS);
    },
    opens: () => socket.onopen?.(),
    says: (data) => socket.onmessage?.({ data }),
    drops: (code) => socket.onclose?.({ code }),
  };
  return socket;
};

// The hub answers a millisecond after the client has set its handlers, as a real one answers a moment
// later. The shortest wait a timer has, so it never hides a wait the client is under test for.
const ANSWER_MS = 1;

// A stub hub. It records every connection the client dials and answers the way the real one will: it
// takes a connection whose version and token it knows, and closes one it does not. Nothing here
// listens on a port and no test starts a server.
function stubHub(knows: string, dropsFirst = 0) {
  const connections: Dialed[] = [];
  const open = (token: string) => (): Dialed => {
    const socket = dialed();
    const index = connections.push(socket);
    const asked = handshakeProtocols(token);
    const welcome = asked.includes(HUB_PROTOCOL) && asked.includes(`bearer.${knows}`);
    const answer = () => {
      if (!welcome) return socket.drops(TOKEN_REFUSED);
      // The first connections go down before they open, which is what a hub being deployed does.
      if (index <= dropsFirst) return socket.drops(1006);
      return socket.opens();
    };
    setTimeout(answer, ANSWER_MS);
    return socket;
  };
  return { connections, open, last: () => last(connections) };
}

// A hub that is not there: every connection is dropped before it opens, which is what a restart, a
// lost network and a refused upgrade all look like.
function deafHub() {
  const connections: Dialed[] = [];
  const dialledAt: number[] = [];
  const droppedAt: number[] = [];
  const open = (): Dialed => {
    const socket = dialed();
    connections.push(socket);
    dialledAt.push(Date.now());
    setTimeout(() => {
      droppedAt.push(Date.now());
      socket.drops(1006);
    }, ANSWER_MS);
    return socket;
  };
  // The wait the client kept: from a connection going down to the next one being dialled.
  const waits = () => dialledAt.slice(1).map((at, index) => at - (droppedAt[index] ?? 0));
  return { connections, open, waits };
}

// A hub that takes the upgrade and then closes with one code. Both terminal codes reach the client this
// way, because a refused upgrade would look like a lost network to the WebSocket API.
function closingHub(code: number) {
  const connections: Dialed[] = [];
  const open = (): Dialed => {
    const socket = dialed();
    connections.push(socket);
    setTimeout(() => socket.drops(code), ANSWER_MS);
    return socket;
  };
  return { connections, open };
}

function last(connections: readonly Dialed[]): Dialed {
  const socket = connections.at(-1);
  if (socket === undefined) throw new Error('The client dialled nothing.');
  return socket;
}

const record = () => {
  const seen: HubStatus[] = [];
  return { seen, onStatus: (status: HubStatus) => seen.push(status) };
};

describe('the handshake', () => {
  it('asks for the protocol version and carries the device token', () => {
    expect(handshakeProtocols('abc123')).toEqual(['nolzu.1', 'bearer.abc123']);
  });

  // A subprotocol may hold only HTTP token characters, and a token that broke the rule would make
  // the browser API throw a SyntaxError that says nothing about a login.
  it('refuses a token a subprotocol cannot carry', () => {
    expect(() => handshakeProtocols('abc 123')).toThrow(/npx nolzu@latest login/);
    expect(() => handshakeProtocols('abc/123=')).toThrow(/npx nolzu@latest login/);
  });
});

describe('the connection to the hub', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects with a token the hub knows', async () => {
    const hub = stubHub('good-token');
    const status = record();

    connectHub(hub.open('good-token'), status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);

    expect(status.seen).toEqual(['connecting', 'open']);
    expect(hub.connections).toHaveLength(1);
  });

  it('gives up on a token the hub refuses, and never dials again', async () => {
    const hub = stubHub('good-token');
    const status = record();

    connectHub(hub.open('revoked-token'), status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);

    expect(status.seen).toEqual(['connecting', 'refused']);
    // Well past the longest wait, so a retry would have happened by now.
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.longestWaitMs * 4);
    expect(hub.connections).toHaveLength(1);
  });

  // Same treatment as a refused token, because every other code is read as a lost network and this
  // client would dial again for as long as the app runs.
  it('gives up on a version the hub will not speak, and never dials again', async () => {
    const hub = closingHub(PROTOCOL_REFUSED);
    const status = record();

    connectHub(hub.open, status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);

    expect(status.seen).toEqual(['connecting', 'refused']);
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.longestWaitMs * 4);
    expect(hub.connections).toHaveLength(1);
  });

  // A plan that does not open the hub stops the client the way the other two codes do, and it is
  // reported as `unpaid` and never as `refused`: a person told to run `nolzu login` here would sign in
  // again and be closed again.
  it('gives up on a plan that does not open the hub, and says so in its own word', async () => {
    const hub = closingHub(PLAN_REFUSED);
    const status = record();

    connectHub(hub.open, status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);

    expect(status.seen).toEqual(['connecting', 'unpaid']);
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.longestWaitMs * 4);
    expect(hub.connections).toHaveLength(1);
  });

  // Delete my cloud data pauses sync: the client stops dialling and says so once,
  // whether the hub closes with the code or with the sentence a hub from before the code sends.
  it('stops dialling after the cloud data was deleted, and tells the caller once', async () => {
    for (const close of [{ code: CLOUD_DATA_DELETED }, { code: 1000, reason: CLOUD_DATA_DELETED_REASON }]) {
      const connections: Dialed[] = [];
      const status = record();
      let deleted = 0;
      connectHub(
        () => {
          const socket = dialed();
          connections.push(socket);
          return socket;
        },
        status.onStatus,
        { onDeleted: () => (deleted += 1) },
      );
      last(connections).opens();
      last(connections).onclose?.(close);

      expect(status.seen).toEqual(['connecting', 'open', 'closed']);
      expect(deleted).toBe(1);
      await vi.advanceTimersByTimeAsync(HUB_TIMINGS.longestWaitMs * 4);
      expect(connections).toHaveLength(1);
    }
  });

  it('reconnects after a drop with a wait that doubles and stops at the cap', async () => {
    const hub = deafHub();

    connectHub(hub.open, record().onStatus);
    // Long enough for the eight waits below, which add up to a little over three minutes.
    await vi.advanceTimersByTimeAsync(200_000);

    expect(hub.waits().slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  });

  // A team project opens a second connection beside this one, so every piece of retry state has to be
  // one set per call and not one per process. Nothing proved that before: every other test here drives
  // one loop.
  it('keeps its own wait and its own give-up while a second connection runs beside it', async () => {
    const refusing = closingHub(TOKEN_REFUSED);
    const deaf = deafHub();
    const refused = record();
    const dropping = record();

    const stopped = connectHub(refusing.open, refused.onStatus);
    const retrying = connectHub(deaf.open, dropping.onStatus);
    // Long enough for the eight waits below, which add up to a little over three minutes.
    await vi.advanceTimersByTimeAsync(200_000);

    // One loop gave up for good and the other never learned of it.
    expect(refused.seen).toEqual(['connecting', 'refused']);
    expect(refusing.connections).toHaveLength(1);
    // And the second loop's ladder is its own, counted from its own first wait.
    expect(deaf.waits().slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    expect(dropping.seen).not.toContain('refused');
    // Both loops are stopped here, so neither one's heartbeat or retry timer outlives this test.
    stopped.close();
    retrying.close();
  });

  // Two loops that are both climbing the ladder, which the test above does not have: the refused one
  // gives up on its first connection and never waits. A wait shared by the process would show here as one
  // ladder counted twice.
  it('keeps a wait per connection while two of them back off at once', async () => {
    const first = deafHub();
    const second = deafHub();

    const one = connectHub(first.open, record().onStatus);
    const two = connectHub(second.open, record().onStatus);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(first.waits().slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(second.waits().slice(0, 3)).toEqual([1000, 2000, 4000]);
    one.close();
    two.close();
  });

  it('waits the whole delay before it dials again', async () => {
    const hub = stubHub('good-token');

    connectHub(hub.open('good-token'), record().onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    // By hand, so the wait is counted from a moment the test knows.
    hub.last().drops(1006);

    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.firstWaitMs - 1);
    expect(hub.connections).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(hub.connections).toHaveLength(2);
  });

  it('starts the wait over after a connection that opened', async () => {
    // Two connections go down first, so the wait has grown to four seconds by the time one opens.
    const hub = stubHub('good-token', 2);
    const status = record();

    connectHub(hub.open('good-token'), status.onStatus);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(status.seen.filter((seen) => seen === 'open')).toHaveLength(1);

    hub.last().drops(1006);
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.firstWaitMs - 1);
    expect(hub.connections).toHaveLength(3);

    // The first wait again, and not the grown one, so a hub that restarts is reached at once.
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.connections).toHaveLength(4);
  });

  it('stops for good when the caller closes it', async () => {
    const hub = stubHub('good-token');
    const status = record();

    const connection = connectHub(hub.open('good-token'), status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    connection.close();
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.longestWaitMs * 4);

    expect(status.seen.at(-1)).toBe('closed');
    expect(hub.last().closes).toBe(1);
    expect(hub.connections).toHaveLength(1);
  });

  // An app that shuts down closes the client from wherever it reads the status, and the client is
  // between two connections for most of the time it is down.
  it('stops when the caller closes it while it waits', async () => {
    const hub = stubHub('good-token', 1);
    const seen: HubStatus[] = [];
    let stop = () => {};
    const connection = connectHub(hub.open('good-token'), (status) => {
      seen.push(status);
      if (status === 'waiting') stop();
    });
    stop = () => connection.close();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(seen).toEqual(['connecting', 'waiting', 'closed']);
    expect(hub.connections).toHaveLength(1);
  });

  // A timer left behind would hold a CLI process open for as long as the wait.
  it('leaves no timer behind when it is closed while it waits', async () => {
    const hub = stubHub('good-token', 1);

    const connection = connectHub(hub.open('good-token'), record().onStatus);
    // The drop, and the close event the stub hub sends after it, so only the retry is left pending.
    await vi.advanceTimersByTimeAsync(ANSWER_MS * 2);
    connection.close();

    expect(vi.getTimerCount()).toBe(0);
  });

  // The heartbeat starts right after the status callback is told, so a close from inside that callback
  // would otherwise leave an interval that holds a CLI process open for good.
  it('leaves no timer behind when it is closed while the connection opens', async () => {
    const hub = stubHub('good-token');
    const seen: HubStatus[] = [];
    let stop = () => {};
    const connection = connectHub(hub.open('good-token'), (status) => {
      seen.push(status);
      if (status === 'open') stop();
    });
    stop = () => connection.close();

    // The connection opening, and the close event the stub hub sends after the close.
    await vi.advanceTimersByTimeAsync(ANSWER_MS * 2);

    expect(seen).toEqual(['connecting', 'open', 'closed']);
    expect(vi.getTimerCount()).toBe(0);
    expect(hub.last().sent).toEqual([]);
  });

  it('closes the socket when the caller closes it while it dials', async () => {
    const hub = stubHub('good-token', 1);
    const seen: HubStatus[] = [];
    let stop = () => {};
    const connection = connectHub(hub.open('good-token'), (status) => {
      seen.push(status);
      // The second dial, which is the one the caller has a handle for.
      if (status === 'connecting' && seen.filter((status) => status === 'connecting').length === 2) stop();
    });
    stop = () => connection.close();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(seen).toEqual(['connecting', 'waiting', 'connecting', 'closed']);
    expect(hub.last().closes).toBe(1);
  });
});

describe('the messages the hub sends', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // One open connection to a hub that knows the token, with the reader under test attached.
  const opened = async (reader: HubReader = {}) => {
    const hub = stubHub('good-token');
    const status = record();
    const connection = connectHub(hub.open('good-token'), status.onStatus, reader);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    return { hub, status, connection };
  };

  const reading = () => {
    const taken: HubEnvelope[] = [];
    const refused: string[] = [];
    return { taken, refused, onMessage: (message: HubEnvelope) => taken.push(message), onUnreadable: (why: string) => refused.push(why) };
  };

  it('hands a message to the reader and acks it', async () => {
    const reader = reading();
    const { hub } = await opened(reader);

    hub.last().says(serializeHubFrame(hubEnvelope('run.start', 7, { card: 'APP-1' })));

    expect(reader.taken).toEqual([{ version: HUB_PROTOCOL, type: 'run.start', job: 7, payload: { card: 'APP-1' } }]);
    // The ack carries the job, so the hub knows which queued job to drop.
    expect(hub.last().sent).toEqual([serializeHubFrame(hubEnvelope(JOB_ACK, 7, null))]);
    expect(reader.refused).toEqual([]);
  });

  it('hands on the project a job names and names it back on the ack', async () => {
    const reader = reading();
    const { hub } = await opened(reader);

    hub.last().says(serializeHubFrame(hubEnvelope('run.start', 3, { card: 'APP-1' }, 2)));

    expect(reader.taken).toEqual([{ version: HUB_PROTOCOL, type: 'run.start', job: 3, project: 2, payload: { card: 'APP-1' } }]);
    expect(hub.last().sent).toEqual([serializeHubFrame(hubEnvelope(JOB_ACK, 3, null, 2))]);
  });

  it('keeps the heartbeat words away from the reader', async () => {
    const reader = reading();
    const { hub, status } = await opened(reader);

    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pingEveryMs);
    hub.last().says(PONG);

    expect(reader.taken).toEqual([]);
    expect(reader.refused).toEqual([]);
    // The pong was read as a pong, so nothing gave the connection up.
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pongWithinMs);
    expect(status.seen).toEqual(['connecting', 'open']);
    expect(hub.last().closes).toBe(0);
  });

  // The hub may check whether this client is still there, and a hub that gets no answer has to treat
  // the connection as dead.
  it('answers a ping from the hub with a pong', async () => {
    const reader = reading();
    const { hub } = await opened(reader);

    hub.last().says(PING);

    expect(hub.last().sent).toEqual([PONG]);
    expect(reader.taken).toEqual([]);
  });

  it('hands nothing to the reader from a connection it has given up', async () => {
    const reader = reading();
    const { hub } = await opened(reader);
    const first = hub.last();
    first.drops(1006);

    first.says(serializeHubFrame(hubEnvelope('card.move', 3, { to: 'plan' })));

    expect(reader.taken).toEqual([]);
    expect(reader.refused).toEqual([]);
    // No ack either. The job is still the hub's, and it comes back on the next connection.
    expect(first.sent).toEqual([]);
  });

  // A dropped job is a card that sits in queued with nobody to ask, so a frame this build cannot read
  // is reported and never acked. The hub keeps it.
  it('reports a frame it cannot read, and acks nothing', async () => {
    const reader = reading();
    const { hub, status } = await opened(reader);

    hub.last().says('not json at all');
    hub.last().says(JSON.stringify({ version: HUB_PROTOCOL, type: 'run.explode', job: 1, payload: null }));
    hub.last().says(JSON.stringify({ ...hubEnvelope('run.start', 1, null), job: 0 }));
    hub.last().says(new Uint8Array([1, 2, 3]));

    expect(reader.refused).toEqual([
      'A hub frame arrived that is not JSON.',
      'A hub frame names a message type this build does not know.',
      'A hub frame carries a job id that is not a whole number above zero. Job ids start at 1.',
      'A hub frame arrived that is not text.',
    ]);
    expect(reader.taken).toEqual([]);
    expect(hub.last().sent).toEqual([]);
    // The socket itself is fine, so one bad frame does not cost the connection and the jobs on it.
    expect(hub.last().closes).toBe(0);
    expect(status.seen).toEqual(['connecting', 'open']);
  });

  // The reader throwing means the job was not taken. Acking it would let the hub drop a job nobody
  // runs.
  it('acks nothing when the reader throws', async () => {
    const reader = reading();
    const { hub } = await opened({
      onMessage: () => {
        throw new Error('The loop is not running.');
      },
      onUnreadable: reader.onUnreadable,
    });

    hub.last().says(serializeHubFrame(hubEnvelope('run.start', 4, null)));

    expect(reader.refused).toEqual(['The loop is not running.']);
    expect(hub.last().sent).toEqual([]);
  });

  // The hub sends `job.ack` on the same socket for a report the runner filed. Acking an ack would make
  // the hub delete a queue row for a frame that was never a job, and the app has no branch for one.
  it('reads nothing but a job as a job, and acks nothing else', async () => {
    const reader = reading();
    const { hub } = await opened(reader);

    hub.last().says(serializeHubFrame(hubEnvelope(JOB_ACK, 5, null)));
    hub.last().says(serializeHubFrame(hubEnvelope('card.state', 6, null)));

    expect(reader.taken).toEqual([]);
    expect(reader.refused).toEqual([
      'A hub frame arrived that is not a job for this client.',
      'A hub frame arrived that is not a job for this client.',
    ]);
    expect(hub.last().sent).toEqual([]);
    // The socket is fine, so the jobs behind the frame still arrive.
    expect(hub.last().closes).toBe(0);
  });

  it('reads a message when the caller passes no reader', async () => {
    const { hub } = await opened();

    hub.last().says(serializeHubFrame(hubEnvelope('run.start', 2, null)));

    // Nobody is listening, and the frame is still acked, so a hub with a job for a caller that reads
    // nothing does not queue it for ever.
    expect(hub.last().sent).toEqual([serializeHubFrame(hubEnvelope(JOB_ACK, 2, null))]);
  });
});

describe('the connection for the signed in account', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The name spelled out, so a rename of DEVICE_TOKEN_NAME shows up here. `nolzu login` stores the
  // token under this name and this is the only place it is read.
  const keychain = (token: string | null): Keychain => ({
    read: async (name) => (name === 'device-token' ? token : null),
    write: async () => undefined,
    remove: async () => undefined,
  });

  it('connects with the token the keychain holds', async () => {
    const hub = stubHub('stored-token');
    const status = record();
    const taken: HubEnvelope[] = [];

    const connection = await connectToHub({
      keychain: keychain('stored-token'),
      url: 'wss://hub.example/connect',
      onStatus: status.onStatus,
      socket: (_url, token) => hub.open(token),
      onMessage: (message) => taken.push(message),
    });
    await vi.advanceTimersByTimeAsync(ANSWER_MS);

    // The stub hub knows one token, so 'open' rather than 'refused' is what says the stored token is
    // the one that reached the handshake.
    expect(status.seen).toEqual(['connecting', 'open']);
    expect(hub.connections).toHaveLength(1);

    // The dial is the reader too, and this is the entry point the app uses. A dial handed over without
    // its callbacks would drop every job from the hub without a trace, and nothing else pins that.
    hub.last().says(serializeHubFrame(hubEnvelope('run.start', 1, null)));
    expect(taken).toEqual([hubEnvelope('run.start', 1, null)]);
    expect(hub.last().sent).toEqual([serializeHubFrame(hubEnvelope(JOB_ACK, 1, null))]);
    connection?.close();
  });

  it('connects to nothing when the machine has no token', async () => {
    const hub = stubHub('stored-token');

    const connection = await connectToHub({
      keychain: keychain(null),
      url: 'wss://hub.example/connect',
      onStatus: () => undefined,
      socket: (_url, token) => hub.open(token),
    });

    // A client with no account works fully, so there is nothing to report and nothing to dial.
    expect(connection).toBeNull();
    expect(hub.connections).toHaveLength(0);
  });
});

describe('the heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings while the connection is open and keeps it while the pongs arrive', async () => {
    const hub = stubHub('good-token');
    const status = record();

    connectHub(hub.open('good-token'), status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pingEveryMs);
      hub.last().says(PONG);
    }

    expect(hub.last().sent).toEqual([PING, PING, PING]);
    expect(hub.last().closes).toBe(0);
    expect(status.seen).toEqual(['connecting', 'open']);
  });

  it('gives the connection up when no pong arrives, and dials again', async () => {
    const hub = stubHub('good-token');
    const status = record();

    connectHub(hub.open('good-token'), status.onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    const first = hub.last();
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pingEveryMs + HUB_TIMINGS.pongWithinMs);

    expect(first.closes).toBe(1);
    expect(status.seen).toEqual(['connecting', 'open', 'waiting']);

    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.firstWaitMs);
    expect(hub.connections).toHaveLength(2);

    // The heartbeat of a connection that was given up stops with it, and does not go on pinging it.
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pingEveryMs * 2);
    expect(first.sent).toEqual([PING]);
  });

  // The pong timer belongs to whichever connection is live. A pong that arrives late on a connection
  // already given up is the slow network the timeout found, and it must not cover a second dead link.
  it('ignores a pong from a connection it has given up', async () => {
    const hub = stubHub('good-token');

    connectHub(hub.open('good-token'), record().onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    const first = hub.last();
    // The first connection times out, the second is dialled and opens, and then it pings.
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pingEveryMs + HUB_TIMINGS.pongWithinMs + HUB_TIMINGS.firstWaitMs + ANSWER_MS);
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pingEveryMs);
    const second = hub.last();
    expect(second).not.toBe(first);
    expect(second.sent).toEqual([PING]);

    first.says(PONG);
    await vi.advanceTimersByTimeAsync(HUB_TIMINGS.pongWithinMs);

    // Nothing answered the second connection's ping, so it is given up like any other dead link.
    expect(second.closes).toBe(1);
  });

  it('sends nothing but the ping, so no message type is spent on it', async () => {
    const hub = stubHub('good-token');

    connectHub(hub.open('good-token'), record().onStatus);
    await vi.advanceTimersByTimeAsync(ANSWER_MS + HUB_TIMINGS.pingEveryMs);

    expect(hub.last().sent).toEqual(['ping']);
  });
});
