import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScoutSource, allScoutFindings, createProject, getSetting, saveScoutFindings, scoutSource, setScoutSource, writeSetting } from '@nolzu/core/node';
import { CLOUD_DATA_DELETED, CLOUD_DATA_DELETED_REASON, type DisplayEntitlement, type HubEnvelope, hubEnvelope, type HubFrame, JOB_ACK, readProjectSync, readScoutSchedule, SERVER_MESSAGES, serializeHubFrame } from '@nolzu/protocol';
import type { HubSocket, Keychain } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cloudConnection } from './cloud-status.ts';
import { closeHubLink, dialHubAgain, hubLastSent, hubProjectsChanged, hubStatus, redialHub, resumeSync, sendToHub, sendToTeamHub, startHubLink } from './hub-link.ts';
import { createLoop, type Loop } from './loop.ts';

// The cloud waits for the paid plans (`packages/protocol/src/soon.ts`). This file pins the code kept for
// then, and cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true, SCOUT_AND_EVIDENCE: true }));

// The dial at start and the jobs from the hub onto the loop. Every job here reaches the writer a
// click reaches, and no test opens a socket: the stub hub below is driven by hand.

let dir = '';
let live: Loop;
let link: { status: () => string; close: () => void } | null = null;
// Every line the link wrote. A failure is a line and never a crash, so this is where a refusal shows.
let lines: string[] = [];

// One connection of the stub hub. The client sets the handlers, and the test says the frames.
interface Stub extends HubSocket {
  sent: string[];
  closes: number;
  opens(): void;
  says(frame: HubFrame): void;
}

const stub = (): Stub => {
  const socket: Stub = {
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
    },
    opens: () => socket.onopen?.(),
    says: (frame) => socket.onmessage?.({ data: serializeHubFrame(frame) }),
  };
  return socket;
};

// The name spelled out, so a rename of DEVICE_TOKEN_NAME shows up here too.
const keychain = (token: string | null): Keychain => ({
  read: async (name) => (name === 'device-token' ? token : null),
  write: async () => undefined,
  remove: async () => undefined,
});

const locked: Keychain = {
  read: () => Promise.reject(new Error('The keychain was not unlocked.')),
  write: async () => undefined,
  remove: async () => undefined,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-hub-link-'));
  lines = [];
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
});

afterEach(() => {
  link?.close();
  link = null;
  // A dial again starts a link this test has no handle on, so the module is asked to close what it holds.
  closeHubLink();
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage = 'inbox') =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);

// The engine every run in this file is handed. It records the job and ends the run at once, so the
// tests measure what started and never wait on a checkout.
const spawned = (): { job: { cardKey: string; phase: string; engine: string; model: string } }[] => {
  const jobs: { job: { cardKey: string; phase: string; engine: string; model: string } }[] = [];
  live.engine.spawn = async function* (job) {
    jobs.push({ job });
    yield JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'sonnet', apiKeySource: 'none' });
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };
  return jobs;
};

const runRows = () => live.db.prepare('SELECT card_key, phase, engine FROM runs ORDER BY id').all() as { card_key: string; phase: string; engine: string }[];

// The rows of one phase. A finished run is followed by the summary pass, which is a run row of its own,
// so counting every row would count that one too.
const runsOf = (phase: string) => runRows().filter((row) => row.phase === phase);

// Starts the link on a stub hub and answers with the connection the client dialled.
async function dial(token: string | null = 'stored-token'): Promise<Stub> {
  const hub = stub();
  const dialed: { url: string; token: string }[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain(token),
    socket: (url, given) => {
      dialed.push({ url, token: given });
      return () => hub;
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(dialed).toHaveLength(1));
  expect(dialed[0]).toEqual({ url: 'ws://localhost:8787/connect', token: 'stored-token' });
  return hub;
}

const ack = (job: number) => serializeHubFrame(hubEnvelope(JOB_ACK, job, null));

it('dials the hub at the address the environment names, with the token the keychain holds', async () => {
  const hub = await dial();
  hub.opens();

  expect(link?.status()).toBe('open');
  expect(lines).toEqual([]);
});

// The free client. Nothing here may make a machine with no account dial, and the keychain read
// answering null is what stops it, so nothing here adds a second guard.
// A demo run in fake mode is on a machine that may be signed in, and a socket to the real hub while a person
// looks at made-up cards is a call nobody asked for. A test that hands in its own socket still dials,
// which is how every other test here works.
// The send path has its own gate to prove, not only the dial: a run in fake mode must not put a frame on a real
// socket either, and `sendToHub` answering true would tell a screen the cloud has something it never got.
it('sends nothing in fake mode', async () => {
  link = startHubLink(live, { NOLZU_FAKE_AGENT: '1' }, { keychain: keychain('device-token-1'), say: (line) => lines.push(line) });
  await Promise.resolve();

  expect(sendToHub('scout.schedule', { projectId: 'p1', sourceId: 3, intervalMinutes: 15, notify: true })).toBe(false);
  expect(lines).toEqual([]);
});

it('dials nothing in fake mode, and reads no keychain', async () => {
  let reads = 0;
  link = startHubLink(live, { NOLZU_FAKE_AGENT: '1' }, {
    keychain: {
      read: async () => {
        reads += 1;
        return 'device-token-1';
      },
      write: async () => {},
      remove: async () => {},
    },
    say: (line) => lines.push(line),
  });
  await Promise.resolve();

  expect(reads).toBe(0);
  expect(link.status()).toBe('closed');
  expect(lines).toEqual([]);
});

it('dials nothing when the machine has no device token', async () => {
  const hub = stub();
  let dials = 0;
  link = startHubLink(live, {}, {
    keychain: keychain(null),
    socket: () => {
      dials += 1;
      return () => hub;
    },
    say: (line) => lines.push(line),
  });

  // The keychain read is a promise, so the dial would happen a tick later if it happened at all.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(dials).toBe(0);
  expect(link.status()).toBe('closed');
  // A client with no account is the free client, not a fault, so there is nothing to say about it.
  expect(lines).toEqual([]);
  expect(live.snapshot().stages.length).toBeGreaterThan(0);
});

it('starts the run a drag starts, and the socket acks the job', async () => {
  addCard('APP-1');
  addCard('APP-2');
  const jobs = spawned();
  const hub = await dial();

  hub.says(hubEnvelope('run.start', 1, { key: 'APP-1', phase: 'refine' }));
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(1));

  // The same call the drag's callback makes, on the other card, as the thing to compare against.
  live.start('APP-2', 'refine');
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(2));
  // The row is written when the run takes its slot, and the engine starts after the git state is read.
  await vi.waitFor(() => expect(jobs.filter((one) => one.job.phase === 'refine')).toHaveLength(2));

  expect(runsOf('refine')).toEqual([
    { card_key: 'APP-1', phase: 'refine', engine: 'claude-code' },
    { card_key: 'APP-2', phase: 'refine', engine: 'claude-code' },
  ]);
  const [fromHub, fromDrag] = jobs.filter((one) => one.job.phase === 'refine');
  expect(fromHub?.job.phase).toBe(fromDrag?.job.phase);
  expect(fromHub?.job.engine).toBe(fromDrag?.job.engine);
  expect(fromHub?.job.model).toBe(fromDrag?.job.model);

  expect(hub.sent).toEqual([ack(1)]);
  expect(getSetting(live.db, 'hubJobDone')).toBe(1);
  expect(lines).toEqual([]);
});

it('drops a job at or below the mark and acks it all the same', async () => {
  addCard('APP-1');
  spawned();
  writeSetting(live.db, 'hubJobDone', 5);
  const hub = await dial();

  hub.says(hubEnvelope('run.start', 5, { key: 'APP-1', phase: 'refine' }));
  await vi.waitFor(() => expect(hub.sent).toEqual([ack(5)]));

  // Acked, so the hub drops the queue row and stops sending it, and nothing ran.
  expect(runRows()).toEqual([]);
  expect(lines).toEqual([]);
});

// The team job this build takes and does not run yet. `project.join` stores the id the team hub minted,
// and the team socket tests at the end of this file are where it is read. `knowledge.commit` commits, and
// `wrapup-run.test.ts` is where it is read. The ack is the point here. The socket acks before the work starts, so a branch
// that threw would leave the hub with no queue row and the job gone, and every job behind it in the same
// chain would arrive after a line nobody asked for.
it.each(['claim.answer'] as const)('takes a %s job, says one line and acks it', async (type) => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const hub = await dial();

  hub.says(hubEnvelope(type, 1, { teamProjectId: 't-1', cardKey: 'APP-1', runId: 3 }));
  // Waited on the line and not on the ack. The ack is on the wire before the job is taken, so a wait on
  // it would read the mark of a job that has not run yet.
  await vi.waitFor(() => expect(said).toHaveBeenCalledTimes(1));

  expect(hub.sent).toEqual([ack(1)]);
  expect(said.mock.calls[0]?.[0]).toContain(type);
  // `lines` is where a job that did not run is reported, so an empty one is what says this job was taken.
  expect(lines).toEqual([]);
  expect(getSetting(live.db, 'hubJobDone')).toBe(1);
  said.mockRestore();
});

// The case the mark exists for: the ack went missing, so the hub sends the job again on the next
// connect. Without the mark the card would run twice on one drag from a phone.
it('runs a redelivered job once', async () => {
  addCard('APP-1');
  spawned();
  const hub = await dial();
  const job: HubEnvelope = hubEnvelope('run.start', 1, { key: 'APP-1', phase: 'refine' });

  hub.says(job);
  await vi.waitFor(() => expect(getSetting(live.db, 'hubJobDone')).toBe(1));
  hub.says(job);
  await vi.waitFor(() => expect(hub.sent).toEqual([ack(1), ack(1)]));

  expect(runsOf('refine')).toHaveLength(1);
  expect(lines).toEqual([]);
});

// The hub sends its queue oldest first, so the client runs them in that order. A move that ran after the
// run it queues would put the card in the wrong stage, and the mark would end below the job that ran.
it('runs the jobs in the order the hub sent them', async () => {
  addCard('APP-1');
  addCard('APP-2');
  spawned();
  const hub = await dial();

  // The first job waits on the move, the second one starts its run without waiting on anything.
  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'refine' }));
  hub.says(hubEnvelope('run.start', 2, { key: 'APP-2', phase: 'refine' }));
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(2));

  expect(runsOf('refine').map((row) => row.card_key)).toEqual(['APP-1', 'APP-2']);
  await vi.waitFor(() => expect(getSetting(live.db, 'hubJobDone')).toBe(2));
  expect(lines).toEqual([]);
});

// Each of the other three types reaches the writer that already exists. The sentence is the proof for
// the two that refuse: it is the loop's own, and nothing in the adapter could write it.
it('takes a question.answer job to the answer the card screen uses', async () => {
  addCard('APP-1');
  const hub = await dial();

  hub.says(hubEnvelope('question.answer', 1, { key: 'APP-1', answer: 'the index is recipes_by_rating' }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toContain('APP-1 is idle and not blocked');
  // The job did not run, so the mark stays where it was and the run it would have made is not there.
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
  expect(runRows()).toEqual([]);
});

it('takes a card.move job to the move behind the board route', async () => {
  addCard('APP-1');
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'refine' }));
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(1));

  // The card moved and the stage's phase started, which is the whole of what a drag does.
  expect(live.db.prepare('SELECT stage FROM cards WHERE key = ?').get('APP-1')).toEqual({ stage: 'refine' });
  expect(lines).toEqual([]);
});

// Send back from the web and the phone: a move back with a note. The card goes back, the note is the
// move's reason the trail shows, and nothing starts, as a drag back in the client starts nothing.
const lastMove = () => live.db.prepare('SELECT from_stage, to_stage, reason FROM card_events ORDER BY id DESC LIMIT 1').get();
const stageOf = (key: string) => live.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key);

it('takes a card.move back with a note: the card goes back, the note is stored, and nothing starts', async () => {
  addCard('APP-1', 'plan');
  const jobs = spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'refine', note: '  Split the rating\ninto its own card.  ' }));
  await vi.waitFor(() => expect(stageOf('APP-1')).toEqual({ stage: 'refine', state: 'idle' }));

  // Kept to one line, as the trail draws it and as the client's own reason line is stored.
  expect(lastMove()).toEqual({ from_stage: 'plan', to_stage: 'refine', reason: 'Split the rating into its own card.' });
  expect(jobs).toEqual([]);
  expect(runRows()).toEqual([]);
  expect(lines).toEqual([]);
});

// The key the job names is the key that moves, not the first card on the board.
it('moves the card a card.move back with a note names, and leaves the others alone', async () => {
  addCard('APP-1', 'plan');
  addCard('APP-2', 'plan');
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-2', to: 'refine', note: 'Split it.' }));
  await vi.waitFor(() => expect(stageOf('APP-2')).toEqual({ stage: 'refine', state: 'idle' }));

  expect(stageOf('APP-1')).toEqual({ stage: 'plan', state: 'idle' });
  expect(live.db.prepare('SELECT card_key, reason FROM card_events ORDER BY id DESC LIMIT 1').get()).toEqual({ card_key: 'APP-2', reason: 'Split it.' });
});

// Today's cloud sends no note, and a drag back asks for none, so a move back without one goes as before.
it('takes a card.move back with no note as a plain move back', async () => {
  addCard('APP-1', 'plan');
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox', note: '   ' }));
  await vi.waitFor(() => expect(stageOf('APP-1')).toEqual({ stage: 'inbox', state: 'idle' }));

  expect(lastMove()).toEqual({ from_stage: 'plan', to_stage: 'inbox', reason: null });
  expect(runRows()).toEqual([]);
});

// A forward move keeps today's rules, and a note on one is a mistake the machine names rather than drops.
it('refuses a note on a forward card.move, and leaves the card where it was', async () => {
  addCard('APP-1');
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'refine', note: 'Go on.' }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A note goes only with a move back, so APP-1 stayed where it was.');
  expect(stageOf('APP-1')).toEqual({ stage: 'inbox', state: 'idle' });
  expect(runRows()).toEqual([]);
});

// The same column is not a move back, so the note is named as a note on a move that goes nowhere.
it('refuses a note on a card.move to the column the card is already in', async () => {
  addCard('APP-1', 'plan');
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'plan', note: 'Again.' }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A note goes only with a move back, so APP-1 stayed where it was.');
});

it('refuses a note too long for the trail, and leaves the card where it was', async () => {
  addCard('APP-1', 'plan');
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'refine', note: 'word '.repeat(120) }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: The note is over 500 characters, so APP-1 stayed where it was.');
  expect(stageOf('APP-1')).toEqual({ stage: 'plan', state: 'idle' });
});

// The finding a `scout.assess` job carries, as the hub's own check builds it. The fingerprint is
// words, because a real one can be a hash and a hash in a fixture reads like a credential.
const FOUND = {
  fingerprint: 'paste:rating-length',
  occurrences: 3,
  firstSeen: '2026-09-29T08:00:00.000Z',
  lastSeen: '2026-09-30T09:30:00.000Z',
  firstMessage: "TypeError: Cannot read properties of undefined (reading 'length') at rating.ts:31",
  lastMessage: "TypeError: Cannot read properties of undefined (reading 'length') at rating.ts:44",
  location: 'src/recipes/rating.ts',
};

// The two things a `scout.assess` job is measured against: the project id this machine minted and
// sent, and a source of its own, which is what the hub keys the finding on.
const scoutReady = (): number => {
  writeSetting(live.db, 'projectId', 'p1');
  return addScoutSource(live.db, { kind: 'paste', label: 'Pasted logs' });
};

const findingRows = () => live.db.prepare('SELECT * FROM scout_findings').all() as Record<string, unknown>[];

const findingCount = () => live.db.prepare('SELECT count(*) AS rows FROM scout_findings').get();

const assessJob = (payload: unknown) => hubEnvelope('scout.assess', 1, payload);

// The job carries the finding and not an id, because `assess-<id>` is built from
// a row in this machine's own database and a finding the hub met first has no row here yet.
it('takes a scout.assess job that carries the finding, and assesses the row it writes', async () => {
  const source = scoutReady();
  spawned();
  const hub = await dial();

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source), finding: FOUND }));
  await vi.waitFor(() => expect(runsOf('assess')).toHaveLength(1));

  const rows = findingRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: 1,
    source_id: source,
    fingerprint: 'paste:rating-length',
    // Neither word is in the payload, so both come from the column's own default.
    kind: 'bug',
    status: 'assess',
    occurrences: 3,
    first_message: FOUND.firstMessage,
    last_message: FOUND.lastMessage,
    location: 'src/recipes/rating.ts',
    // The hub sends neither, so a card it opened on the cloud board is not linked here.
    card_key: null,
    external_key: null,
  });
  // The hub's own clock is dropped: the writer stamps both times from sqlite's, so the row says when
  // this machine wrote it.
  expect(rows[0]?.first_seen).not.toBe(FOUND.firstSeen);
  // The run is keyed by the id this machine minted, which is the whole reason the job carries the
  // finding.
  expect(runsOf('assess')[0]?.card_key).toBe('assess-1');
  expect(lines).toEqual([]);
});

// The same event can arrive twice by two routes: Check now on this machine and a scheduled check in
// the cloud. Both write through `saveScoutFindings`, which keys on the source and the fingerprint, so
// the second one folds and the screen draws one finding.
//
// The count does not grow and no assessment starts. Each check counts against its own cursor, nothing
// carries one cursor to the other, and the hub's first check of a source this machine has been
// checking reports occurrences this machine has already counted. The finding is also one this machine
// was already holding in New, and a person who left it there asked for no engine run.
it('folds a finding the local check already met onto one row, and starts nothing', async () => {
  const source = scoutReady();
  spawned();
  const line = 'TypeError: Cannot read properties of undefined at rating.ts:31';
  const item = { sourceKind: 'paste', errorType: '', message: line, location: 'src/recipes/rating.ts' };
  saveScoutFindings(live.db, source, [{ fingerprint: 'paste:rating-length', count: 2, first: item, last: item }]);
  const hub = await dial();

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source), finding: FOUND }));
  // The mark moves, so the job finished.
  await vi.waitFor(() => expect(getSetting(live.db, 'hubJobDone')).toBe(1));

  // One row, holding the two occurrences the local check counted and not those two plus the hub's
  // three. The first line stays where the check put it and the newest one moves, which is what a
  // repeat does.
  expect(live.db.prepare('SELECT id, occurrences, first_message, last_message FROM scout_findings').all()).toEqual([
    { id: 1, occurrences: 2, first_message: line, last_message: FOUND.lastMessage },
  ]);
  expect(runRows()).toEqual([]);
  expect(lines).toEqual([]);
});

// A place the job does not name does not blank the place a local check stored, the way a missing
// ticket key does not blank a stored one.
it('keeps the location a local check stored when the job names none', async () => {
  const source = scoutReady();
  const line = 'TypeError: Cannot read properties of undefined at rating.ts:31';
  const item = { sourceKind: 'paste', errorType: '', message: line, location: 'src/recipes/rating.ts' };
  saveScoutFindings(live.db, source, [{ fingerprint: 'paste:rating-length', count: 1, first: item, last: item }]);
  const hub = await dial();
  const finding: Record<string, unknown> = { ...FOUND };
  delete finding.location;

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source), finding }));
  await vi.waitFor(() => expect(getSetting(live.db, 'hubJobDone')).toBe(1));

  expect(live.db.prepare('SELECT location FROM scout_findings').all()).toEqual([{ location: 'src/recipes/rating.ts' }]);
  expect(lines).toEqual([]);
});

// A redelivered job and a finding a person already sent to assessment are the same case: the row is
// not new any more, so the count moves and no second run starts.
it('starts no second assessment for a finding already in the assessment column', async () => {
  const source = scoutReady();
  spawned();
  live.db
    .prepare(
      `INSERT INTO scout_findings (source_id, fingerprint, status, occurrences, first_seen, last_seen, first_message, last_message)
       VALUES (?, 'paste:rating-length', 'assess', 2, '2026-09-20T08:00:00.000Z', '2026-09-26T09:30:00.000Z', 'the first line', 'the newest line')`,
    )
    .run(source);
  const hub = await dial();

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source), finding: FOUND }));
  // The mark moves, so the job finished. It started nothing.
  await vi.waitFor(() => expect(getSetting(live.db, 'hubJobDone')).toBe(1));

  expect(runRows()).toEqual([]);
  expect(live.db.prepare('SELECT occurrences FROM scout_findings').all()).toEqual([{ occurrences: 2 }]);
  expect(lines).toEqual([]);
});

it('refuses a scout.assess job that carries no finding, and writes nothing', async () => {
  const source = scoutReady();
  const hub = await dial();

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source) }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A scout.assess job from the hub carries no finding.');
  expect(findingCount()).toEqual({ rows: 0 });
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
});

it('refuses a finding with no first message, and writes nothing', async () => {
  const source = scoutReady();
  const hub = await dial();
  const finding: Record<string, unknown> = { ...FOUND };
  delete finding.firstMessage;

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source), finding }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A scout.assess job from the hub carries no firstMessage.');
  expect(findingCount()).toEqual({ rows: 0 });
});

// The hub keys its finding rows on the project id this machine sent. Another id is another project,
// and a machine that has registered nowhere holds null, so it refuses every one of these.
it('writes no finding for a scout.assess job that names another project', async () => {
  const source = scoutReady();
  const hub = await dial();

  hub.says(assessJob({ projectId: 'another-project', sourceId: String(source), finding: FOUND }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe(
    'A job from the hub did not run: A scout.assess job from the hub names another project, so no finding was stored.',
  );
  expect(findingCount()).toEqual({ rows: 0 });
  expect(runRows()).toEqual([]);
});

it('writes no finding for a source this machine does not have', async () => {
  scoutReady();
  const hub = await dial();

  hub.says(assessJob({ projectId: 'p1', sourceId: '404', finding: FOUND }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe(
    'A job from the hub did not run: A scout.assess job from the hub names a source this machine does not have.',
  );
  expect(findingCount()).toEqual({ rows: 0 });
});

// A count no check can reach. Asking only for a whole number let this one through to the writer,
// which added it to the count the row already held and then could not read the sum back: a whole
// number over 2^53 is not a JavaScript number, and every later read of the table threw the same
// words for good, the findings screen with them.
it('refuses a finding whose count is too large to store, and leaves the table readable', async () => {
  const source = scoutReady();
  const line = 'TypeError: Cannot read properties of undefined at rating.ts:31';
  const item = { sourceKind: 'paste', errorType: '', message: line, location: 'src/recipes/rating.ts' };
  saveScoutFindings(live.db, source, [{ fingerprint: 'paste:rating-length', count: 1, first: item, last: item }]);
  const hub = await dial();

  hub.says(assessJob({ projectId: 'p1', sourceId: String(source), finding: { ...FOUND, occurrences: Number.MAX_SAFE_INTEGER } }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A scout.assess job from the hub names no occurrence count a finding can hold.');
  // The row is as the local check left it, and the screen that reads every finding still reads.
  expect(allScoutFindings(live.db).map((one) => one.occurrences)).toEqual([1]);
  expect(runRows()).toEqual([]);
});

// The `{ findingId }` shape this client used to read is not accepted, and no queue row of it can
// arrive: no hub ever queued the old shape.
it('refuses the findingId shape no hub ever sent', async () => {
  scoutReady();
  const hub = await dial();

  hub.says(assessJob({ findingId: 1 }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A scout.assess job from the hub carries no projectId.');
  expect(runRows()).toEqual([]);
});

it('says one line for a job it cannot read, and starts nothing', async () => {
  spawned();
  const hub = await dial();

  hub.says(hubEnvelope('run.start', 1, { phase: 'refine' }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A run.start job from the hub carries no key.');
  expect(runRows()).toEqual([]);
  // Not finished, so the mark does not move and the hub may send it again.
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
});

// The keychain read can raise an OS password dialog, and a refusal there throws. The app has to be
// serving pages by then, so the dial is never awaited and the failure is one line.
it('keeps serving pages when the keychain read throws', async () => {
  let dials = 0;
  link = startHubLink(live, {}, {
    keychain: locked,
    socket: () => {
      dials += 1;
      return stub;
    },
    say: (line) => lines.push(line),
  });

  await vi.waitFor(() => expect(lines).toHaveLength(1));
  expect(lines[0]).toBe('Nolzu could not reach its hub: The keychain was not unlocked.');
  expect(dials).toBe(0);
  expect(link.status()).toBe('closed');
  expect(live.snapshot().stages.length).toBeGreaterThan(0);
});

// The hub's own ack for a report is not a job for this client, and the runner refuses it without a
// word of its own, so this is where the line is read.
it('says one line for a frame that is not a job, and one for a frame it cannot parse', async () => {
  const hub = await dial();

  hub.says(hubEnvelope(JOB_ACK, 1, null));
  await vi.waitFor(() => expect(lines).toHaveLength(1));
  hub.onmessage?.({ data: 'not json' });
  await vi.waitFor(() => expect(lines).toHaveLength(2));

  expect(lines).toEqual(['A hub frame arrived that is not a job for this client.', 'A hub frame arrived that is not JSON.']);
  // Neither frame is acked, so the hub keeps whatever it was trying to send.
  expect(hub.sent).toEqual([]);
  expect(runRows()).toEqual([]);
});

// The quit path. The heartbeat is an interval, so a socket left open holds the process open after the
// HTTP server has closed.
it('closes the socket when the app quits', async () => {
  const hub = await dial();
  hub.opens();

  link?.close();

  expect(hub.closes).toBe(1);
  expect(link?.status()).toBe('closed');
});

// Quitting during the keychain read. The dial is not awaited, so the socket is opened after close()
// has already returned.
it('closes a socket that opened after the app quit', async () => {
  const hub = stub();
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: () => () => hub,
    say: (line) => lines.push(line),
  });

  link.close();

  await vi.waitFor(() => expect(hub.closes).toBe(1));
  expect(lines).toEqual([]);
});

// The entry point the product uses. The reader was once pinned everywhere but here, so the dial
// itself is read off the file that starts it.
it('starts the dial from the server hooks, at server start', () => {
  const source = readFileSync(new URL('../hooks.server.ts', import.meta.url), 'utf8');

  expect(source).toContain('export const init: ServerInit');
  expect(source).toContain('startHubLink(loop(), process.env)');
  // The close at quit, which nothing else reaches: adapter-node emits this once the HTTP server is down.
  // It closes whatever the module holds, because a dial again leaves the link this hook started dead.
  expect(source).toContain("process.on('sveltekit:shutdown', () => closeHubLink())");
  // Not from bin/nolzu.js: a second dial there would build a second loop over the same database.
  expect(readFileSync(new URL('../../bin/start.js', import.meta.url), 'utf8')).not.toContain('Hub');
});

// The status a screen reads. The dial lives in the server bundle and the init hook has nowhere to
// hand its link, so the module holds the one that was started, the way loop.ts holds its open map.
it('lets a screen read the live status, and holds no link after the app quits', async () => {
  expect(hubStatus()).toBe('closed');

  const hub = await dial();
  hub.opens();
  expect(hubStatus()).toBe('open');

  hub.onclose?.({ code: 1006 });
  expect(hubStatus()).toBe('waiting');

  link?.close();
  expect(hubStatus()).toBe('closed');
});

// The one state the screen has to tell apart from a lost network. The client stops here, so the sentence
// on the settings screen is the only way out.
it('reads refused after the hub turns the token down', async () => {
  const hub = await dial();
  hub.opens();

  hub.onclose?.({ code: 4401 });

  expect(hubStatus()).toBe('refused');
  expect(cloudConnection(hubStatus()).fix).toContain('npx nolzu@latest login');
});

// A plan bought in the browser reaching this machine without a restart. `connectHub` gives up for
// good on a refusal code, so the document a page load fetches is what dials again.

// Every connection the client opened, oldest first, so a test counts the dials and drives each one.
function dials(): Stub[] {
  const made: Stub[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: () => () => {
      const hub = stub();
      made.push(hub);
      return hub;
    },
    say: (line) => lines.push(line),
  });
  return made;
}

const doc = (over: Partial<DisplayEntitlement> = {}): DisplayEntitlement => ({
  id: 'account-1',
  plan: 'free',
  features: [],
  seats: 0,
  expiresAt: 0,
  ...over,
});

// The document of an account that may open the cloud board, which is what `unpaid` waits for.
const solo = doc({ plan: 'solo', features: ['cloud-board'], seats: 1, expiresAt: 900 });

// Closed with 4402, then the person buys the plan and comes back. The load that draws the screen carries
// the new document, and that is the dial.
it('dials again when a document that opens the board arrives after a 4402 close', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.opens();
  made[0]?.onclose?.({ code: 4402 });
  expect(hubStatus()).toBe('unpaid');

  expect(dialHubAgain(solo)).toBe(true);

  await vi.waitFor(() => expect(made).toHaveLength(2));
  await vi.waitFor(() => expect(hubStatus()).toBe('connecting'));
  made[1]?.opens();
  expect(hubStatus()).toBe('open');
  expect(lines).toEqual([]);
});

// The Free machine, which is most of the machines that read `Local only`. Its document says the plan
// still does not open the board, so there is nothing to dial for.
it('dials nothing on a document that changes nothing, after a 4402 close', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.onclose?.({ code: 4402 });

  expect(dialHubAgain(doc())).toBe(false);
  expect(dialHubAgain(doc({ plan: 'solo', features: ['evidence-history'] }))).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(made).toHaveLength(1);
  expect(hubStatus()).toBe('unpaid');
});

// The bound. A hub that goes on refusing must not be dialled on every navigation, and the document is
// the honest clock for it: it changes when the account changed.
it('dials once per document change and not once per page load', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.onclose?.({ code: 4402 });

  expect(dialHubAgain(solo)).toBe(true);
  await vi.waitFor(() => expect(made).toHaveLength(2));

  // The hub refuses the plan again, and the next two page loads carry the same account. The second one
  // is the document `currentDisplay` refreshed at half its life, which is a new expiry and no new
  // account.
  made[1]?.onclose?.({ code: 4402 });
  expect(hubStatus()).toBe('unpaid');
  expect(dialHubAgain(solo)).toBe(false);
  expect(dialHubAgain({ ...solo, expiresAt: solo.expiresAt + 900 })).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(made).toHaveLength(2);

  // A seat added on the account is a change, so this one is dialled for.
  expect(dialHubAgain({ ...solo, plan: 'team', seats: 5 })).toBe(true);
  await vi.waitFor(() => expect(made).toHaveLength(3));
});

// 4401 is a token the hub will not take, and no document shows a token. So any document is the signal
// there, and the first one after the refusal is the page load that follows `nolzu login`.
it('dials again after a 4401 close when any document arrives', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.onclose?.({ code: 4401 });
  expect(hubStatus()).toBe('refused');

  expect(dialHubAgain(doc())).toBe(true);
  await vi.waitFor(() => expect(made).toHaveLength(2));

  // And bounded the same way: the same account on the next load does not dial.
  made[1]?.onclose?.({ code: 4401 });
  expect(dialHubAgain(doc())).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(made).toHaveLength(2);
});

// Nothing here may reach a working connection. `waiting` dials itself after a wait, and a second dial on
// top of it would open two sockets for one machine.
it('leaves a connection alone that is open or dialling', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.opens();

  expect(dialHubAgain(solo)).toBe(false);

  made[0]?.onclose?.({ code: 1006 });
  expect(hubStatus()).toBe('waiting');
  expect(dialHubAgain({ ...solo, plan: 'team' })).toBe(false);
  expect(made).toHaveLength(1);
});

// Fake mode. It dials nothing, so it has no stopped link to report, and the trigger finds no link to
// drop. A demo must never become the way a socket to the real hub is opened.
it('dials nothing in fake mode, whatever document arrives', async () => {
  link = startHubLink(live, { NOLZU_FAKE_AGENT: '1' }, { keychain: keychain('stored-token'), say: (line) => lines.push(line) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(hubStatus()).toBe('closed');
  expect(dialHubAgain(solo)).toBe(false);
  expect(dialHubAgain(doc())).toBe(false);
  expect(lines).toEqual([]);
});

// The wire. The trigger is worth nothing unless the layout load runs it, and it has to run on the
// document that load already read, without waiting for the dial.
it('runs the dial again from the layout load, on the document it just read', () => {
  const source = readFileSync(new URL('../routes/+layout.server.ts', import.meta.url), 'utf8');

  expect(source).toContain('const display = await currentDisplay(cloud);');
  expect(source).toContain('dialHubAgain(display)');
  expect(source).not.toContain('await dialHubAgain');
});

// The quit path after a dial again. By then the link the init hook started is the dead one, so a close
// that reads a captured handle leaves the live socket and its heartbeat holding the process open.
it('closes the socket the dial again opened when the app quits', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.opens();
  made[0]?.onclose?.({ code: 4402 });

  expect(dialHubAgain(solo)).toBe(true);
  await vi.waitFor(() => expect(made).toHaveLength(2));
  made[1]?.opens();
  expect(hubStatus()).toBe('open');

  closeHubLink();

  expect(made[1]?.closes).toBe(1);
  expect(hubStatus()).toBe('closed');
});

// Connect again on Settings, Cloud. A keychain that would not open leaves the link `closed`, and nothing
// dials it again by itself, so the press is the way back.
it('dials again on Connect again after the keychain read failed, and not before the press', async () => {
  let reads = 0;
  const made: Stub[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: {
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error('The keychain did not open.');
        return 'stored-token';
      },
      write: async () => undefined,
      remove: async () => undefined,
    },
    socket: () => () => {
      const hub = stub();
      made.push(hub);
      return hub;
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(lines).toHaveLength(1));
  // Time passes and nothing dials: no timer and no poll stands behind the press.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(hubStatus()).toBe('closed');
  expect(made).toHaveLength(0);

  expect(await redialHub()).toBe(true);

  // The press answered after the keychain read, so the load that follows it already says Connecting.
  expect(hubStatus()).toBe('connecting');
  expect(made).toHaveLength(1);
  made[0]?.opens();
  expect(hubStatus()).toBe('open');
});

// The press waits for a keychain read that takes a while, such as one behind an OS dialog.
it('answers Connect again only after a slow keychain read, so the next load says Connecting', async () => {
  let reads = 0;
  const made: Stub[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: {
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error('The keychain did not open.');
        await new Promise((resolve) => setTimeout(resolve, 40));
        return 'stored-token';
      },
      write: async () => undefined,
      remove: async () => undefined,
    },
    socket: () => () => {
      const hub = stub();
      made.push(hub);
      return hub;
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(await redialHub()).toBe(true);

  expect(hubStatus()).toBe('connecting');
  expect(made).toHaveLength(1);
});

// A link reads `closed` until its keychain read settles. A press at start, or a second press while the
// first one's read goes, must not drop that read and start another, which can be a second OS dialog.
it('dials nothing on Connect again while a keychain read is still going', async () => {
  const answers: ((token: string | null) => void)[] = [];
  const made: Stub[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: {
      read: () => new Promise((resolve) => answers.push(resolve)),
      write: async () => undefined,
      remove: async () => undefined,
    },
    socket: () => () => {
      const hub = stub();
      made.push(hub);
      return hub;
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  expect(hubStatus()).toBe('closed');

  // The read at start is still going.
  expect(await redialHub()).toBe(false);
  expect(answers).toHaveLength(1);

  // It found no token, so the link stopped, and a press dials.
  answers[0]?.(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const press = redialHub();
  await vi.waitFor(() => expect(answers).toHaveLength(2));

  // A second press while the first one's read goes.
  expect(await redialHub()).toBe(false);
  expect(answers).toHaveLength(2);

  answers[1]?.('stored-token');
  expect(await press).toBe(true);
  expect(made).toHaveLength(1);
  expect(hubStatus()).toBe('connecting');
});

// A press on a link that is dialling, open or waiting for the account to change adds no second socket.
it.each([
  ['open', null],
  ['waiting', 1006],
  ['refused', 4401],
  ['unpaid', 4402],
] as const)('dials nothing on Connect again while the link is %s', async (status, code) => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.opens();
  if (code !== null) made[0]?.onclose?.({ code });
  expect(hubStatus()).toBe(status);

  expect(await redialHub()).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(made).toHaveLength(1);
  expect(hubStatus()).toBe(status);
});

it('dials nothing on Connect again once the app has quit', async () => {
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  closeHubLink();

  expect(await redialHub()).toBe(false);
  expect(made).toHaveLength(1);
});

// Last sync on Settings, Cloud: the time a frame went out, and nothing while none could.
it('remembers when a frame last went to the hub', async () => {
  const schedule = { projectId: 'p-1', sourceId: 1, intervalMinutes: 60, notify: true };
  expect(hubLastSent()).toBeNull();

  const hub = await dial();
  expect(sendToHub('scout.schedule', schedule)).toBe(false);
  expect(hubLastSent()).toBeNull();

  hub.opens();
  const before = Date.now();
  expect(sendToHub('scout.schedule', schedule)).toBe(true);
  expect(hubLastSent()).toBeGreaterThanOrEqual(before);
});

it('does not count a frame the socket threw on as sent', async () => {
  const hub = await dial();
  hub.send = () => {
    throw new Error('The socket was closing.');
  };
  hub.opens();

  expect(sendToHub('scout.schedule', { projectId: 'p-1', sourceId: 1, intervalMinutes: 60, notify: true })).toBe(false);
  expect(hubLastSent()).toBeNull();
});

// The other direction. Nothing in `apps/local` sent a frame before the Scout schedule, so this is the
// whole of what a screen can put on the socket.
it('sends a settings frame on the open socket, and answers false while there is none', async () => {
  const schedule = { projectId: 'p-1', sourceId: 1, intervalMinutes: 60, notify: true };

  // No link at all. The module holds nothing, so the frame is lost and the caller is told.
  expect(sendToHub('scout.schedule', schedule)).toBe(false);

  const hub = await dial();
  // Dialled and not open yet. A frame written now would be dropped by the socket itself.
  expect(sendToHub('scout.schedule', schedule)).toBe(false);
  expect(hub.sent).toEqual([]);

  hub.opens();
  expect(sendToHub('scout.schedule', schedule)).toBe(true);

  const frame = JSON.parse(hub.sent[0] ?? '') as HubEnvelope;
  expect(frame).toMatchObject({ type: 'scout.schedule', payload: schedule });
  // Every frame carries a job id at or above one, which is what `parseHubFrame` takes.
  expect(frame.job).toBeGreaterThanOrEqual(1);
  // The payload goes on the socket as it was handed in, and the reader fills the two opt-ins this one
  // leaves out with off, the way it does for a machine on the pin before they existed.
  expect(readScoutSchedule(frame.payload)).toEqual({ ...schedule, createCards: false, autoAssess: false });

  link?.close();
  expect(sendToHub('scout.schedule', schedule)).toBe(false);
  expect(hub.sent).toHaveLength(1);
});

// The registration this machine owes the hub on every connect. Every test above dials on a machine
// with no project path, so nothing there registers anything and `hub.sent` holds acks only.

// The project a person set up, in the test's own temporary folder. The name the hub gets is the folder's
// last part, which is what the rail shows.
const projectHere = () => writeSetting(live.db, 'projectPath', join(dir, 'recipes'));

const framesOf = (hub: Stub): HubEnvelope[] => hub.sent.map((text) => JSON.parse(text) as HubEnvelope);

it('registers the project when the link opens, with the settings the person typed', async () => {
  projectHere();
  writeSetting(live.db, 'clientName', 'Bakery');
  writeSetting(live.db, 'hourlyRate', 80);
  writeSetting(live.db, 'currency', 'EUR');

  const hub = await dial();
  // Dialled and not open. A frame now would be dropped by the socket itself.
  expect(hub.sent).toEqual([]);

  hub.opens();

  expect(framesOf(hub).map((frame) => frame.type)).toEqual(['project.sync']);
  const id = getSetting(live.db, 'projectId');
  expect(id).not.toBeNull();
  const sync = readProjectSync(framesOf(hub)[0]?.payload);
  expect(sync).toMatchObject({
    id,
    name: 'recipes',
    flow: 'pull-request',
    clientName: 'Bakery',
    hourlyRate: 80,
    currency: 'EUR',
  });
  // The one thing on this frame the typecheck cannot hold to a value. Nothing here asks a person to make
  // a team project yet, so a marker that read true would turn every personal project in existence into a
  // team project on its next connect.
  expect(sync.team).toBe(false);
  // Read off the protocol package's own list and not written out here: the hub holds back a job type
  // this list does not name, so a type missing from it is a job that would sit in the queue for ever,
  // and a type named here that this build cannot run is a job it takes and drops.
  expect(sync.handles).toEqual(SERVER_MESSAGES);
  // The hub keeps the last write, so the stamp has to be this sync and not a fixed string.
  expect(Date.parse(sync.updatedAt)).toBeGreaterThan(Date.now() - 60_000);
  expect(lines).toEqual([]);
});

// Every machine in existence is here on its next start: it may have a project, and it has no id. The one
// with no project registers nothing, because an id minted now would belong to whatever folder the person
// picks later.
it('sends nothing and mints no id on a machine with no project', async () => {
  const source = addScoutSource(live.db, { kind: 'sentry', label: 'Errors' });
  setScoutSource(live.db, source, { scheduleMinutes: 60, notify: true });

  const hub = await dial();
  hub.opens();

  expect(hub.sent).toEqual([]);
  expect(getSetting(live.db, 'projectId')).toBeNull();
  expect(lines).toEqual([]);
});

// The id is minted once and kept. A second id for one project would leave the hub holding two rows, and
// the schedules of this machine split over both.
it('stores the project id and registers the same project on the next connect', async () => {
  projectHere();

  const first = await dial();
  first.opens();
  const id = getSetting(live.db, 'projectId');

  // In the settings table a restart reads, and not only in this process.
  expect(live.db.prepare('SELECT value FROM settings WHERE key = ?').get('projectId')).toEqual({ value: JSON.stringify(id) });

  link?.close();
  const second = await dial();
  second.opens();

  expect(readProjectSync(framesOf(second)[0]?.payload).id).toBe(id);
  expect(getSetting(live.db, 'projectId')).toBe(id);
  expect(lines).toEqual([]);
});

// The resend `saveScoutSchedule` leaves to this side. A schedule saved while the link was down reaches the
// hub on the next connect, and a source whose schedule is off has nothing to send.
it('resends every stored schedule after the registration, and nothing for a source that is off', async () => {
  projectHere();
  const fast = addScoutSource(live.db, { kind: 'sentry', label: 'Errors' });
  const off = addScoutSource(live.db, { kind: 'paste', label: 'Pasted notes' });
  const hourly = addScoutSource(live.db, { kind: 'tickets', label: 'Open tickets' });
  // The two opt-ins crossed over on purpose, so a sender that swapped the names sends one row's
  // create-cards flag as its assess flag and this test reads the difference.
  setScoutSource(live.db, fast, { scheduleMinutes: 15, notify: false, createCards: true, autoAssess: false });
  setScoutSource(live.db, hourly, { scheduleMinutes: 60, notify: true, createCards: false, autoAssess: true });

  const hub = await dial();
  hub.opens();

  const frames = framesOf(hub);
  expect(frames.map((frame) => frame.type)).toEqual(['project.sync', 'scout.schedule', 'scout.schedule']);
  const id = getSetting(live.db, 'projectId');
  // Read off the rows, so what is pinned is that the frame copies the columns and not that it holds
  // the numbers this test typed. Red if `registerProject` leaves either flag out of the frame or
  // sends the other column's value.
  const row = (source: number) => scoutSource(live.db, source);
  expect([row(fast)?.createCards, row(fast)?.autoAssess, row(hourly)?.createCards, row(hourly)?.autoAssess]).toEqual([true, false, false, true]);
  // One frame per source that has a schedule, and none for the source in the middle.
  expect(frames.slice(1).map((frame) => readScoutSchedule(frame.payload))).toEqual([
    { projectId: id, sourceId: fast, intervalMinutes: 15, notify: false, createCards: row(fast)?.createCards, autoAssess: row(fast)?.autoAssess },
    { projectId: id, sourceId: hourly, intervalMinutes: 60, notify: true, createCards: row(hourly)?.createCards, autoAssess: row(hourly)?.autoAssess },
  ]);
  expect(frames.slice(1).map((frame) => readScoutSchedule(frame.payload).sourceId)).not.toContain(off);
  // Three frames, three job ids, so a hub log tells them apart.
  expect(new Set(frames.map((frame) => frame.job)).size).toBe(3);
  expect(frames.every((frame) => frame.job >= 1)).toBe(true);
  expect(lines).toEqual([]);
});

// A demo run in fake mode is on a machine that may be signed in. It sends nothing, and it may not mint an id either:
// the first real connect is what registers the project.
it('registers nothing in fake mode', async () => {
  projectHere();
  link = startHubLink(live, { NOLZU_FAKE_AGENT: '1' }, { keychain: keychain('device-token-1'), say: (line) => lines.push(line) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(getSetting(live.db, 'projectId')).toBeNull();
  expect(hubStatus()).toBe('closed');
  expect(lines).toEqual([]);
});

// The untick nothing else tells the hub about. `saveScoutSource` writes `enabled = 0` and leaves the
// interval in the row, so the connect is the only place that can take the cloud schedule down.
// The hub keys a schedule on the project row, so a schedule that arrives without one is refused and the
// person's setting silently stays local. A socket that cannot take the registration must therefore not be
// sent the schedules either, and nothing pinned that before: the stub hub always accepts.
it('sends no schedule when the registration itself did not go out', async () => {
  projectHere();
  const source = addScoutSource(live.db, { kind: 'sentry', label: 'Errors' });
  setScoutSource(live.db, source, { scheduleMinutes: 60, notify: true, enabled: true });

  const hub = await dial();
  // Only the first write fails. A socket that refuses every write cannot tell the two apart, because the
  // schedules would be dropped by the socket as well. This one takes them, so a schedule on the wire means
  // the registration's answer was ignored.
  let first = true;
  const write = hub.send.bind(hub);
  hub.send = (data: string) => {
    if (first) {
      first = false;
      throw new Error('the socket is not writable');
    }
    write(data);
  };
  hub.opens();

  // Nothing on the wire: the registration did not go, so the schedules behind it do not either.
  expect(hub.sent).toEqual([]);
});

it('sends a 0 for a source that holds a schedule and has its checks turned off', async () => {
  projectHere();
  const off = addScoutSource(live.db, { kind: 'sentry', label: 'Errors' });
  setScoutSource(live.db, off, { scheduleMinutes: 60, notify: true, enabled: false });

  const hub = await dial();
  hub.opens();

  const frames = framesOf(hub);
  expect(frames.map((frame) => frame.type)).toEqual(['project.sync', 'scout.schedule']);
  expect(readScoutSchedule(frames[1]?.payload)).toEqual({
    projectId: getSetting(live.db, 'projectId'),
    sourceId: off,
    intervalMinutes: 0,
    notify: false,
    // Both off because a new source starts with both columns off, and this one was never ticked.
    createCards: false,
    autoAssess: false,
  });
  // The row keeps the interval, so the screen still shows it and a source turned on again is armed again.
  expect(scoutSource(live.db, off)?.scheduleMinutes).toBe(60);
  expect(lines).toEqual([]);
});

// The one job no click reaches. A tick on the hub queues it, this machine writes the text from its
// own rows and answers with a frame of its own.
it('takes a report.write job and answers with the Monday of the week the hub asked for', async () => {
  projectHere();
  addCard('APP-1');

  const hub = await dial();
  hub.opens();
  // A Thursday, because the hub queues the job on the day its tick fires. The frame answers with the
  // Monday all the same: the hub keys its row on that day, so a job named on any day of the week has
  // to come back as one key. A Monday in here would pass whether this machine folds the day or not.
  hub.says(hubEnvelope('report.write', 1, { week: '2026-03-05' }));
  await vi.waitFor(() => expect(framesOf(hub).some((frame) => frame.type === 'report.weekly')).toBe(true));

  // The board sync that follows the registration has its tests in `hub-sync.test.ts`.
  const frames = framesOf(hub).filter((frame) => frame.type !== 'card.state');
  // The ack is on the wire before the report, because the socket acks as soon as the job is queued.
  expect(frames.map((frame) => frame.type)).toEqual(['project.sync', 'job.ack', 'report.weekly']);
  const report = frames[2]?.payload as { projectId: string; week: string; text: string };
  expect(report.projectId).toBe(getSetting(live.db, 'projectId'));
  expect(report.week).toBe('2026-03-02');
  expect(report.text.split('\n')[0]).toBe('What I shipped, week of 2026-03-02, the UTC week');
  expect(lines).toEqual([]);
});

it('says one line for a report job that names no week, and sends no report', async () => {
  projectHere();

  const hub = await dial();
  hub.opens();
  hub.says(hubEnvelope('report.write', 1, { week: '2026-02-30' }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A report.write job from the hub names no week.');
  expect(framesOf(hub).map((frame) => frame.type)).toEqual(['project.sync', 'job.ack']);
});


// The second socket. A project that has joined a team dials the team hub beside the personal one,
// on a path of its own, and the two sockets share neither their job mark nor their retry loop. Nothing
// answers the team path yet: the hub class and the route that serves it are the cloud half of this
// feature, so every test here drives a stub the way every other test in this file does.

const TEAM_ID = 'team-project-1';

// The two connections a team project dials, told apart by the path the client asked for. The paths are
// written out here and never read back from the protocol package, so a path that moved under the client
// fails as a path and not as a missing socket.
async function dialTeam(): Promise<{ own: Stub; team: Stub; urls: string[] }> {
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  const own = stub();
  const team = stub();
  const urls: string[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => {
      urls.push(url);
      return () => (url === 'ws://localhost:8787/connect/team' ? team : own);
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(urls).toHaveLength(2));
  return { own, team, urls };
}

// Every connection this machine dialled, with the path it asked for and a socket of its own. The helper
// above hands the same socket back for the same path, so a test that dials one hub twice needs this one
// to tell the two connections apart.
function dialsTeam(): { url: string; hub: Stub }[] {
  const made: { url: string; hub: Stub }[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => {
      const hub = stub();
      made.push({ url, hub });
      return () => hub;
    },
    say: (line) => lines.push(line),
  });
  return made;
}

// One connection out of that list, read without a cast. A missing one is a fault in the test and not in
// the product, so it throws here rather than three lines further on.
function dialled(made: { url: string; hub: Stub }[], index: number): Stub {
  const one = made[index];
  if (one === undefined) throw new Error(`The client dialled no connection number ${index}.`);
  return one.hub;
}

it('dials the team hub beside its own on a team project', async () => {
  const { urls } = await dialTeam();

  // The personal path is the start of the team one, so a client that dialled the personal path twice
  // would look right to a router that matches a prefix and wrong here.
  expect(urls).toEqual(['ws://localhost:8787/connect', 'ws://localhost:8787/connect/team']);
  expect(lines).toEqual([]);
});

// Most machines. A second socket opened for a personal project would be a connection the hub has no
// object for and this machine has no work on.
it('dials one socket on a project that has joined no team', async () => {
  const urls: string[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => {
      urls.push(url);
      return () => stub();
    },
    say: (line) => lines.push(line),
  });

  await vi.waitFor(() => expect(urls).toHaveLength(1));
  // A tick past the first dial, so a second one would be in the list by now.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(urls).toEqual(['ws://localhost:8787/connect']);
  expect(getSetting(live.db, 'teamProjectId')).toBeNull();
  expect(lines).toEqual([]);
});

// The mark, written out in both directions. A job id counts from 1 inside each hub, so one mark for both
// sockets would drop the other hub's first jobs and ack every one of them, and an acked job is gone for
// good.
it('takes job 1 from the team hub after the personal hub has finished job 5', async () => {
  addCard('APP-1');
  spawned();
  writeSetting(live.db, 'hubJobDone', 5);
  const { own, team } = await dialTeam();

  team.says(hubEnvelope('run.start', 1, { key: 'APP-1', phase: 'refine' }));
  // Waited on the work and not on the ack, because the ack is on the wire before the job is taken.
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(1));

  expect(team.sent).toEqual([ack(1)]);
  // The ack went out on the socket the job came in on, so no frame of the team hub reaches the personal
  // one.
  expect(own.sent).toEqual([]);
  expect(getSetting(live.db, 'teamHubJobDone')).toBe(1);
  // Untouched. Each mark holds what its own hub has finished.
  expect(getSetting(live.db, 'hubJobDone')).toBe(5);
  expect(lines).toEqual([]);
});

it('takes job 1 from the personal hub after the team hub has finished job 5', async () => {
  addCard('APP-1');
  spawned();
  writeSetting(live.db, 'teamHubJobDone', 5);
  const { own, team } = await dialTeam();

  own.says(hubEnvelope('run.start', 1, { key: 'APP-1', phase: 'refine' }));
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(1));

  expect(own.sent).toEqual([ack(1)]);
  expect(team.sent).toEqual([]);
  expect(getSetting(live.db, 'hubJobDone')).toBe(1);
  expect(getSetting(live.db, 'teamHubJobDone')).toBe(5);
  expect(lines).toEqual([]);
});

// The give-up is one socket's and not the process's. A team hub that will not take this machine leaves
// the personal link serving, which is the file's own rule: one line per failure, never a crash.
it('goes on serving the personal hub when the team hub turns the token down', async () => {
  addCard('APP-1');
  spawned();
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();

  team.onclose?.({ code: 4401 });

  expect(hubStatus()).toBe('open');
  own.says(hubEnvelope('run.start', 1, { key: 'APP-1', phase: 'refine' }));
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(1));
  expect(own.sent).toEqual([ack(1)]);
  expect(live.snapshot().stages.length).toBeGreaterThan(0);
  // The one line the person gets. The status a screen reads is the personal socket's, so a team hub that
  // is down is told here and nowhere else.
  expect(lines).toEqual(['The team hub turned this machine down, so nothing from the team board reaches it. Run `npx nolzu@latest login` again, and update Nolzu if that does not help.']);
});

// A plan that does not open the team hub. It is its own code and its own sentence, because the way out is
// a plan and not a sign-in.
it('says what a plan that does not open the team hub costs, and keeps the personal hub', async () => {
  const { own, team } = await dialTeam();
  own.opens();

  team.onclose?.({ code: 4402 });

  // The personal socket, untouched. A plan that closed the team hub is told in the line and not in the
  // status a screen reads.
  expect(hubStatus()).toBe('open');
  expect(lines).toEqual(['This plan does not open the team hub, so nothing from the team board reaches this machine. The rest of Nolzu goes on working.']);
});

// The other direction of the same rule: a frame a screen sends goes to the hub that holds this machine's
// own project, and never to the team hub.
it('sends a frame from a screen on the personal socket only', async () => {
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();

  expect(sendToHub('scout.schedule', { projectId: 'p-1', sourceId: 1, intervalMinutes: 60, notify: true })).toBe(true);

  expect(framesOf(own).map((frame) => frame.type)).toEqual(['scout.schedule']);
  expect(team.sent).toEqual([]);
  expect(lines).toEqual([]);
});

// Where the id comes from. The hub mints it and sends it on a `project.join` job, and this is the only
// thing in the product that can say a project belongs to a team.
it('stores the team project id a project.join job carries', async () => {
  const hub = await dial();

  hub.says(hubEnvelope('project.join', 1, { teamProjectId: TEAM_ID }));
  await vi.waitFor(() => expect(getSetting(live.db, 'teamProjectId')).toBe(TEAM_ID));

  // In the settings table a restart reads, and not only in this process.
  expect(live.db.prepare('SELECT value FROM settings WHERE key = ?').get('teamProjectId')).toEqual({ value: JSON.stringify(TEAM_ID) });
  expect(hub.sent).toEqual([ack(1)]);
  expect(getSetting(live.db, 'hubJobDone')).toBe(1);
  expect(lines).toEqual([]);
});

it('says one line for a project.join job that names no team project', async () => {
  const hub = await dial();

  hub.says(hubEnvelope('project.join', 1, {}));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A project.join job from the hub names no team project.');
  expect(getSetting(live.db, 'teamProjectId')).toBeNull();
  // Not finished, so the mark does not move. The job is gone all the same: the socket acked it before
  // the work started, which is the trade the `takeHubJob` docstring names.
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
});

// The account's projects, from the personal hub. Stored as they came, so the paid panel can list the
// projects other machines of the account registered.
const LISTED = [
  { id: 'p-1', name: 'recipes', lastActivity: '2026-10-07T09:15:00.000Z' },
  { id: 'p-2', name: 'recipe-api', lastActivity: null },
];

it('stores the account project list a project.list job carries', async () => {
  const hub = await dial();
  hub.opens();

  hub.says(hubEnvelope('project.list', 1, { projects: LISTED }));
  await vi.waitFor(() => expect(getSetting(live.db, 'accountProjects')).toEqual(LISTED));

  expect(hub.sent).toEqual([ack(1)]);
  expect(getSetting(live.db, 'hubJobDone')).toBe(1);
  expect(lines).toEqual([]);
});

it('says one line for a project.list job it cannot read, and keeps the list it had', async () => {
  writeSetting(live.db, 'accountProjects', LISTED);
  const hub = await dial();
  hub.opens();

  hub.says(hubEnvelope('project.list', 1, { projects: [{ id: 'p-3' }] }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A project list carries a project with no name.');
  expect(getSetting(live.db, 'accountProjects')).toEqual(LISTED);
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
});

// The protocol's reader runs on the job, so a null payload gets its sentence and not a TypeError.
it('says the reader\'s sentence for a project.list job with a null payload', async () => {
  const hub = await dial();
  hub.opens();

  hub.says(hubEnvelope('project.list', 1, null));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A project list arrived that is not a message object.');
  expect(getSetting(live.db, 'accountProjects')).toBeNull();
});

// A team hub holds the projects of a team, and those are not the account's own.
it('stores nothing from a project.list job that came up the team socket', async () => {
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();

  team.says(hubEnvelope('project.list', 1, { projects: LISTED }));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: A project.list job came from the team hub, and only your own hub sends one. Nothing was stored.');
  expect(getSetting(live.db, 'accountProjects')).toBeNull();
  expect(getSetting(live.db, 'teamHubJobDone')).toBe(0);
});

// A plan that lapsed. The list goes with it, so the machine answers what a machine that never paid does.
// A lost network keeps it, because the plan did not change.
it.each([
  [4402, null],
  [1006, LISTED],
])('keeps the account project list after a close with %i only while the plan holds', async (code, kept) => {
  const hub = await dial();
  hub.opens();
  hub.says(hubEnvelope('project.list', 1, { projects: LISTED }));
  await vi.waitFor(() => expect(getSetting(live.db, 'accountProjects')).toEqual(LISTED));

  hub.onclose?.({ code });
  expect(getSetting(live.db, 'accountProjects')).toEqual(kept);
});

// Without a restart. The job that stores the id is what opens the socket, so a person who joined a team
// gets their team cards on the connection they already have.
it('dials the team hub as soon as a project.join job has stored the id', async () => {
  const urls: string[] = [];
  const made: Stub[] = [];
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => {
      urls.push(url);
      const hub = stub();
      made.push(hub);
      return () => hub;
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(made).toHaveLength(1));

  made[0]?.says(hubEnvelope('project.join', 1, { teamProjectId: TEAM_ID }));

  await vi.waitFor(() => expect(urls).toEqual(['ws://localhost:8787/connect', 'ws://localhost:8787/connect/team']));
  expect(lines).toEqual([]);
});

// The marker on the registration. The machine says it and the hub does not guess, so a machine that
// dials the team hub has to tell its own hub the same thing.
it('tells its own hub the project belongs to a team, once it has joined one', async () => {
  projectHere();
  const { own } = await dialTeam();
  own.opens();

  expect(readProjectSync(framesOf(own)[0]?.payload).team).toBe(true);
  expect(lines).toEqual([]);
});

// The writer a job answers on, held to the socket the job came in on. `report.write` is the one job that
// answers with a frame, and the id in that frame is the one the asking hub minted: the team hub has never
// seen the id this machine minted for itself.
it('answers a team hub report on the team socket, with the team project id', async () => {
  projectHere();
  addCard('APP-1');
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();

  // The open sends the board up first, on the team socket too. The job's frames come after it.
  const board = team.sent.length;
  expect(framesOf(team).map((frame) => frame.type)).toEqual(['card.state']);
  team.says(hubEnvelope('report.write', 1, { week: '2026-03-05' }));
  await vi.waitFor(() => expect(team.sent).toHaveLength(board + 2));

  const frames = framesOf(team).slice(board);
  expect(frames.map((frame) => frame.type)).toEqual(['job.ack', 'report.weekly']);
  expect((frames[1]?.payload as { projectId: string }).projectId).toBe(TEAM_ID);
  // The personal socket carries its own registration and board, and nothing of the team hub's.
  expect(framesOf(own).map((frame) => frame.type)).toEqual(['project.sync', 'card.state']);
  expect(lines).toEqual([]);
});

// The frame counter is one per process and shared by both sockets. A hub reads a job id per socket, so
// the ids may not clash inside one hub, and one counter for the machine is the cheapest way to be sure.
it('numbers the frames of both sockets from one counter', async () => {
  projectHere();
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();

  team.says(hubEnvelope('report.write', 1, { week: '2026-03-05' }));
  await vi.waitFor(() => expect(team.sent).toHaveLength(2));
  expect(sendToHub('scout.schedule', { projectId: 'p-1', sourceId: 1, intervalMinutes: 60, notify: true })).toBe(true);

  // The ack is numbered by the job it acks, so only the frames this machine wrote are counted here.
  const report = framesOf(team).find((frame) => frame.type === 'report.weekly')?.job;
  const mine = framesOf(own).map((frame) => frame.job);
  expect(report).toBeGreaterThan(0);
  expect(mine).not.toContain(report);
  expect(new Set(mine).size).toBe(mine.length);
});

// Another team is another hub, and that hub numbers its jobs from 1. A mark counted on the old hub would
// drop the new hub's first jobs and ack every one of them, and an acked job is gone for good.
it('dials the new team hub and puts the team mark back when a join names another team', async () => {
  addCard('APP-1');
  spawned();
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  writeSetting(live.db, 'teamHubJobDone', 12);
  const made = dialsTeam();
  await vi.waitFor(() => expect(made).toHaveLength(2));
  dialled(made, 0).opens();
  dialled(made, 1).opens();

  dialled(made, 0).says(hubEnvelope('project.join', 1, { teamProjectId: 'team-project-2' }));

  await vi.waitFor(() => expect(made).toHaveLength(3));
  expect(made[2]?.url).toBe('ws://localhost:8787/connect/team');
  // The wire on the old team's hub is closed, so it takes and acks nothing more.
  expect(dialled(made, 1).closes).toBe(1);
  expect(getSetting(live.db, 'teamHubJobDone')).toBe(0);

  // And the new hub's first job runs, which is the whole point of the reset.
  dialled(made, 2).opens();
  dialled(made, 2).says(hubEnvelope('run.start', 1, { key: 'APP-1', phase: 'refine' }));
  await vi.waitFor(() => expect(runsOf('refine')).toHaveLength(1));
  expect(getSetting(live.db, 'teamHubJobDone')).toBe(1);
  expect(lines).toEqual([]);
});

// The join path, which is the one the product uses. The personal socket is held open by the heartbeat, so
// its next open may be days away, and until then the hub would read a personal project on a machine that
// is serving a team board.
it('tells its own hub about the team on the join and not at the next reconnect', async () => {
  projectHere();
  const made = dialsTeam();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  const own = dialled(made, 0);
  own.opens();
  expect(readProjectSync(framesOf(own)[0]?.payload).team).toBe(false);

  own.says(hubEnvelope('project.join', 1, { teamProjectId: TEAM_ID }));

  await vi.waitFor(() => expect(framesOf(own).filter((frame) => frame.type === 'project.sync')).toHaveLength(2));
  const syncs = framesOf(own).filter((frame) => frame.type === 'project.sync');
  expect(readProjectSync(syncs[1]?.payload).team).toBe(true);
  expect(lines).toEqual([]);
});

// A Team plan bought in the browser, on a machine whose team socket was closed for the plan it had.
// `connectHub` gives up per socket for the life of the process, so without this the team board stays dark
// until Nolzu is restarted, while the screen says the machine is connected.
it('dials again when the team socket was turned down and a changed document arrives', async () => {
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  const made = dialsTeam();
  await vi.waitFor(() => expect(made).toHaveLength(2));
  dialled(made, 0).opens();
  dialled(made, 1).onclose?.({ code: 4402 });
  // The personal socket is open and serving, so nothing in the status a screen reads says to dial.
  expect(hubStatus()).toBe('open');

  const bought = doc({ plan: 'team', features: ['cloud-board', 'team-costs'], seats: 3 });
  expect(dialHubAgain(bought)).toBe(true);

  await vi.waitFor(() => expect(made).toHaveLength(4));
  expect(made.slice(2).map((one) => one.url)).toEqual(['ws://localhost:8787/connect', 'ws://localhost:8787/connect/team']);
  // One dial per document change, the same bound the personal socket is under.
  expect(dialHubAgain(bought)).toBe(false);
  expect(lines).toEqual(['This plan does not open the team hub, so nothing from the team board reaches this machine. The rest of Nolzu goes on working.']);
});

// The quit path with two sockets. The heartbeat is an interval, so a team socket left open holds the
// process open after the HTTP server has closed, the same way the personal one does.
it('closes both sockets when the app quits', async () => {
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();

  closeHubLink();

  expect(own.closes).toBe(1);
  expect(team.closes).toBe(1);
  expect(hubStatus()).toBe('closed');
});

// Several projects. A frame names its project by its registry id, and a job that names one goes to
// that project's loop. Card keys repeat across projects, so each test holds APP-1 in both.
let other: Loop | null = null;

afterEach(() => {
  other?.close();
  other = null;
});

const ENV = { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' };

// A second project beside the first, with its own APP-1 in Refine, and the first project's APP-1 there too.
function secondProject(): Loop {
  createProject(dir).close();
  other = createLoop(dir, ENV, { project: live.project + 1 });
  addCard('APP-1', 'refine');
  other.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'idle', 'APP-1 of shop')").run();
  return other;
}

async function dialProjects(): Promise<Stub> {
  const hub = stub();
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: () => () => hub,
    say: (line) => lines.push(line),
    projectLoop: (id) => createLoop(dir, ENV, { project: id }),
  });
  await vi.waitFor(() => expect(hub.onopen).not.toBeNull());
  hub.opens();
  return hub;
}

const stageIn = (loop: Loop) => (loop.db.prepare("SELECT stage FROM cards WHERE key = 'APP-1'").get() as { stage: string }).stage;

it('takes a job with no project to the first project, as the cloud sends it today', async () => {
  const second = secondProject();
  const hub = await dialProjects();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox' }));
  await vi.waitFor(() => expect(stageIn(live)).toBe('inbox'));

  expect(stageIn(second)).toBe('refine');
  expect(hub.sent).toContain(ack(1));
  expect(lines).toEqual([]);
});

it('moves the card of the project a job names, and not the card with the same key in the first', async () => {
  const second = secondProject();
  const hub = await dialProjects();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox' }, second.project));
  await vi.waitFor(() => expect(stageIn(second)).toBe('inbox'));

  expect(stageIn(live)).toBe('refine');
  // The ack names the project back, and the mark is the machine's, so the next job of either counts on.
  expect(hub.sent).toContain(serializeHubFrame(hubEnvelope(JOB_ACK, 1, null, second.project)));
  expect(getSetting(live.db, 'hubJobDone')).toBe(1);
  expect(lines).toEqual([]);
});

it('refuses a job for a project this machine does not have, and runs it on no other', async () => {
  secondProject();
  const hub = await dialProjects();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox' }, 9));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe('A job from the hub did not run: It names project 9, and this machine has no such project, so no project ran it.');
  expect(stageIn(live)).toBe('refine');
  expect(stageIn(other!)).toBe('refine');
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
});

it('names its project on every frame it sends, and answers a job on the project the job named', async () => {
  projectHere();
  const second = secondProject();
  writeSetting(second.db, 'projectPath', join(dir, 'shop'));
  writeSetting(second.db, 'projectId', 'p-shop');
  const hub = await dialProjects();

  hub.says(hubEnvelope('report.write', 1, { week: '2026-03-05' }, second.project));
  await vi.waitFor(() => expect(framesOf(hub).some((frame) => frame.type === 'report.weekly')).toBe(true));

  const frames = framesOf(hub);
  for (const frame of frames.filter((one) => one.type !== 'report.weekly' && one.type !== 'job.ack')) expect(frame.project).toBe(live.project);
  const report = frames.find((frame) => frame.type === 'report.weekly');
  expect(report?.project).toBe(second.project);
  expect((report?.payload as { projectId: string }).projectId).toBe('p-shop');
  expect(lines).toEqual([]);
});

// One `project.sync` per project and one team socket per team project. A plan with several
// projects is a document holding the `projects` feature, on a hub that reads `project` (`hub-projects`);
// Free holds neither.
const several = doc({ plan: 'solo', features: ['cloud-board', 'projects', 'hub-projects'], seats: 1, expiresAt: 9_999_999_999 });

// Every connection the link dialled, with a socket of its own, on a machine whose document is `document`.
function dialsProjects(document: DisplayEntitlement, start: Loop = live): { url: string; hub: Stub }[] {
  const made: { url: string; hub: Stub }[] = [];
  link = startHubLink(start, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => {
      const hub = stub();
      made.push({ url, hub });
      return () => hub;
    },
    say: (line) => lines.push(line),
    projectLoop: (id) => createLoop(dir, ENV, { project: id }),
    display: () => document,
  });
  return made;
}

// A second project with a folder, so the hub takes its registration.
function namedSecond(): Loop {
  const second = secondProject();
  writeSetting(second.db, 'projectPath', join(dir, 'shop'));
  writeSetting(second.db, 'projectId', 'p-shop');
  return second;
}

const syncsOf = (hub: Stub) => framesOf(hub).filter((frame) => frame.type === 'project.sync');
const teamUrls = (made: { url: string }[]) => made.filter((one) => one.url === 'ws://localhost:8787/connect/team');

it('sends one project.sync per project, each naming its own project', async () => {
  projectHere();
  writeSetting(live.db, 'projectId', 'p-recipes');
  const second = namedSecond();
  const made = dialsProjects(several);
  await vi.waitFor(() => expect(made).toHaveLength(1));
  // Past the queue that serves the second project, so its sync goes on the open below.
  await new Promise((resolve) => setTimeout(resolve, 10));
  dialled(made, 0).opens();

  await vi.waitFor(() => expect(syncsOf(dialled(made, 0))).toHaveLength(2));
  const syncs = syncsOf(dialled(made, 0));
  expect(syncs.map((frame) => [frame.project, readProjectSync(frame.payload).id])).toEqual([
    [live.project, 'p-recipes'],
    [second.project, 'p-shop'],
  ]);
  // Each board goes up under its own project.
  const boards = framesOf(dialled(made, 0)).filter((frame) => frame.type === 'card.state');
  expect(new Set(boards.map((frame) => frame.project))).toEqual(new Set([live.project, second.project]));
  expect(lines).toEqual([]);
});

// The hub as it is files every frame under the project synced last and runs a job with no project on
// the first, so it gets the first project alone, also when the server started on the second.
it('sends the first project alone to a hub that does not read the project, and runs its jobs there', async () => {
  projectHere();
  writeSetting(live.db, 'projectId', 'p-recipes');
  const second = namedSecond();
  const made = dialsProjects(doc({ plan: 'solo', features: ['cloud-board', 'projects'], seats: 1, expiresAt: 9_999_999_999 }), second);
  await vi.waitFor(() => expect(made).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  dialled(made, 0).opens();

  await vi.waitFor(() => expect(syncsOf(dialled(made, 0))).toHaveLength(1));
  dialled(made, 0).says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox' }));
  await vi.waitFor(() => expect(stageIn(live)).toBe('inbox'));

  expect(syncsOf(dialled(made, 0)).map((frame) => [frame.project, readProjectSync(frame.payload).id])).toEqual([[live.project, 'p-recipes']]);
  expect(stageIn(second)).toBe('refine');
  // Nothing of the second project went up, so no row of it can land under the first. The ack of a job
  // with no project names none back.
  expect(framesOf(dialled(made, 0)).every((frame) => frame.project === (frame.type === 'job.ack' ? undefined : live.project))).toBe(true);
  expect(lines).toEqual([]);
});

it('syncs a project made after the link started, once it is registered', async () => {
  projectHere();
  const made = dialsProjects(several);
  await vi.waitFor(() => expect(made).toHaveLength(1));
  dialled(made, 0).opens();
  await vi.waitFor(() => expect(syncsOf(dialled(made, 0))).toHaveLength(1));

  const second = namedSecond();
  hubProjectsChanged();

  await vi.waitFor(() => expect(syncsOf(dialled(made, 0))).toHaveLength(2));
  expect(syncsOf(dialled(made, 0))[1]?.project).toBe(second.project);
  expect(lines).toEqual([]);
});

it('opens one team socket per team project, and none for a project on no team', async () => {
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  const second = secondProject();
  writeSetting(second.db, 'teamProjectId', 'team-project-2');
  createProject(dir).close();
  const made = dialsProjects(several);

  await vi.waitFor(() => expect(teamUrls(made)).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The personal socket and two team sockets. The third project is solo and dials nothing.
  expect(made).toHaveLength(3);
  expect(lines).toEqual([]);
});

it('marks a team job done in project 2 on project 2 only, and answers on its socket', async () => {
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  const second = secondProject();
  writeSetting(second.db, 'teamProjectId', 'team-project-2');
  const made = dialsProjects(several);
  await vi.waitFor(() => expect(teamUrls(made)).toHaveLength(2));
  for (const one of made) one.hub.opens();
  const [firstTeam, secondTeam] = [dialled(made, 1), dialled(made, 2)];

  // The team hub sends no project: the socket says which project the job is for.
  secondTeam.says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox' }));
  await vi.waitFor(() => expect(stageIn(second)).toBe('inbox'));

  expect(stageIn(live)).toBe('refine');
  expect(getSetting(second.db, 'teamHubJobDone')).toBe(1);
  expect(getSetting(live.db, 'teamHubJobDone')).toBe(0);
  expect(getSetting(live.db, 'hubJobDone')).toBe(0);
  expect(secondTeam.sent).toContain(ack(1));
  expect(firstTeam.sent).not.toContain(ack(1));
  expect(lines).toEqual([]);
});

it('refuses a job on a team socket that names another project', async () => {
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  const second = secondProject();
  const made = dialsProjects(several);
  await vi.waitFor(() => expect(teamUrls(made)).toHaveLength(1));

  dialled(made, 1).says(hubEnvelope('card.move', 1, { key: 'APP-1', to: 'inbox' }, second.project));
  await vi.waitFor(() => expect(lines).toHaveLength(1));

  expect(lines[0]).toBe(`A job from the hub did not run: It names project ${second.project} on the team socket of project ${live.project}, so no project ran it.`);
  expect(stageIn(live)).toBe('refine');
  expect(stageIn(second)).toBe('refine');
});

// A hub that does not read `project` files every frame under the project synced last, so it gets the
// first project alone, whichever one is open.
it('sends one project.sync, for the first project, to a hub that reads no project', async () => {
  projectHere();
  const second = namedSecond();
  writeSetting(live.db, 'currentProject', second.project);
  const made = dialsProjects(doc(), second);
  await vi.waitFor(() => expect(made).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  dialled(made, 0).opens();

  await vi.waitFor(() => expect(syncsOf(dialled(made, 0))).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(syncsOf(dialled(made, 0)).map((frame) => frame.project)).toEqual([live.project]);
  expect(lines).toEqual([]);
});

it('sends a team frame with no project on the team socket of the project the link started on', async () => {
  writeSetting(live.db, 'teamProjectId', TEAM_ID);
  const second = secondProject();
  writeSetting(second.db, 'teamProjectId', 'team-project-2');
  const made = dialsProjects(several, second);
  await vi.waitFor(() => expect(teamUrls(made)).toHaveLength(2));
  for (const one of made) one.hub.opens();

  expect(sendToTeamHub('report.weekly', {})).toBe(true);

  const carriers = made.filter((one) => framesOf(one.hub).some((frame) => frame.type === 'report.weekly'));
  expect(carriers).toHaveLength(1);
  expect(framesOf(carriers[0]!.hub).find((frame) => frame.type === 'report.weekly')?.project).toBe(second.project);
});

it('moves the card a job names by its own key in the project it names, not the key APP-1', async () => {
  const second = secondProject();
  second.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'refine', 'idle', 'APP-2 of shop')").run();
  const hub = await dialProjects();

  hub.says(hubEnvelope('card.move', 1, { key: 'APP-2', to: 'inbox' }, second.project));
  await vi.waitFor(() => expect((second.db.prepare("SELECT stage FROM cards WHERE key = 'APP-2'").get() as { stage: string }).stage).toBe('inbox'));

  expect(stageIn(second)).toBe('refine');
  expect(stageIn(live)).toBe('refine');
  expect(lines).toEqual([]);
});

// Delete my cloud data pauses sync until the person turns it back on in Settings, Cloud. The hub
// says so as it closes: a hub from before the code with its sentence, a later one with the
// code, on the delete or on the connect after one this machine missed.
it('sends no frame after the hub says the cloud data was deleted, and dials nothing at the next start', async () => {
  projectHere();
  addCard('APP-1');
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  const hub = made[0] as Stub;
  hub.opens();
  const before = hub.sent.length;
  expect(before).toBeGreaterThan(0);

  hub.onclose?.({ code: 1000, reason: CLOUD_DATA_DELETED_REASON });

  expect(getSetting(live.db, 'syncPaused')).toBe(true);
  expect(hubStatus()).toBe('closed');
  expect(lines).toEqual(['Your cloud data was deleted, so Nolzu paused sync. Turn it back on in Settings, Cloud.']);
  // A change on the board and a frame from a screen both find no socket.
  live.db.prepare("UPDATE cards SET title = 'Rate a recipe' WHERE key = 'APP-1'").run();
  live.changed();
  expect(sendToHub('scout.schedule', { projectId: 'p-1', sourceId: 1, intervalMinutes: 60, notify: true })).toBe(false);
  expect(hub.sent).toHaveLength(before);

  // The pause outlives the process: a start with the setting on dials nothing.
  link?.close();
  closeHubLink();
  const again = dials();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(again).toHaveLength(0);
  expect(hubStatus()).toBe('closed');
});

// A team project holds a second socket. The pause takes the whole link down, so that socket is closed and
// a change on the board sends it nothing.
it('closes the team socket too when the hub says the cloud data was deleted', async () => {
  projectHere();
  addCard('APP-1');
  const { own, team } = await dialTeam();
  own.opens();
  team.opens();
  const before = team.sent.length;
  const closed = team.closes;

  own.onclose?.({ code: CLOUD_DATA_DELETED });
  live.db.prepare("UPDATE cards SET title = 'Rate a recipe' WHERE key = 'APP-1'").run();
  live.changed();

  expect(team.closes).toBeGreaterThan(closed);
  expect(team.sent).toHaveLength(before);
});

it('pauses on the close code a later hub sends, and resumes when the person turns sync back on', async () => {
  projectHere();
  const made = dials();
  await vi.waitFor(() => expect(made).toHaveLength(1));
  made[0]?.opens();
  made[0]?.onclose?.({ code: CLOUD_DATA_DELETED });
  expect(getSetting(live.db, 'syncPaused')).toBe(true);

  expect(await resumeSync()).toBe(true);

  expect(getSetting(live.db, 'syncPaused')).toBe(false);
  // The press dialled once more with the same stubs, and the open sends the whole board again.
  await vi.waitFor(() => expect(made).toHaveLength(2));
  made[1]?.opens();
  expect(framesOf(made[1] as Stub).map((frame) => frame.type)).toContain('project.sync');
  expect(hubStatus()).toBe('open');
});

// The keychain read after Turn sync back on can sit behind an OS dialog. The press answers after the
// same wait Connect again has, and a second press while that read goes starts no second read.
it('answers Turn sync back on while its keychain read waits, and a second press reads nothing more', async () => {
  projectHere();
  writeSetting(live.db, 'syncPaused', true);
  let reads = 0;
  link = startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: {
      read: () => {
        reads += 1;
        return new Promise<string | null>(() => {});
      },
      write: async () => undefined,
      remove: async () => undefined,
    },
    socket: () => () => stub(),
    say: (line) => lines.push(line),
  });
  expect(reads).toBe(0);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let answered = false;
    const press = resumeSync().then((dialled) => {
      answered = true;
      return dialled;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await press).toBe(true);
    expect(reads).toBe(1);

    expect(await resumeSync()).toBe(false);
    expect(reads).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
