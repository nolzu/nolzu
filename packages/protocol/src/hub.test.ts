import { describe, expect, it } from 'vitest';
import {
  capSummary,
  CLOUD_DATA_DELETED,
  CLOUD_DATA_DELETED_REASON,
  HUB_PATH,
  HUB_PROTOCOL,
  hubEnvelope,
  isCloudDataDeleted,
  isHubRefusal,
  JOB_ACK,
  parseHubFrame,
  PING,
  PLAN_REFUSED,
  PONG,
  MAX_SCOUT_INTERVAL_MINUTES,
  MIN_SCOUT_INTERVAL_MINUTES,
  NEVER_SENT,
  PROTOCOL_REFUSED,
  PULL_STATES,
  readFindingResults,
  readKnowledgeProposal,
  readProjectList,
  readProjectSync,
  readPullState,
  readRunCosts,
  readScoutSchedule,
  RUNNER_MESSAGES,
  SERVER_MESSAGES,
  serializeHubFrame,
  SUMMARY_CAP,
  SYNCED_DATA,
  TEAM_HUB_PATH,
  TOKEN_REFUSED,
  type HubMessageType,
  type KnowledgeProposal,
  type ProjectSync,
  type RunCost,
  type RunCosts,
  type ScoutSchedule,
} from './hub.ts';

const ALL: readonly HubMessageType[] = [...SERVER_MESSAGES, ...RUNNER_MESSAGES, JOB_ACK];

// Pinned whole, not counted. These strings are the contract with the hub, whose router is
// written from these literals. A test that only counts the names stays green
// through a rename, and the router would then never match the renamed message.
it('names the nine server messages and the eight runner messages, as the hub router matches them', () => {
  expect([...SERVER_MESSAGES]).toEqual([
    'run.start',
    'question.answer',
    'card.move',
    'scout.assess',
    'report.write',
    'knowledge.commit',
    'claim.answer',
    'project.join',
    'project.list',
  ]);
  expect([...RUNNER_MESSAGES]).toEqual([
    'card.state',
    'evidence.blocks',
    'finding.results',
    'knowledge.proposals',
    'project.sync',
    'scout.schedule',
    'report.weekly',
    'run.cost',
  ]);
  expect(JOB_ACK).toBe('job.ack');
});

// The guard the settings screen stands on. Written out by hand, never mapped over `SYNCED_DATA`: a
// test that read its answer from the constant under test would pass whatever that constant held.
const SENDS_DATA = [
  'card.state',
  'evidence.blocks',
  'finding.results',
  'knowledge.proposals',
  'project.sync',
  'scout.schedule',
  'report.weekly',
  'run.cost',
];

it('says in words what every message the runner sends carries away from the machine', () => {
  // Off the wire, not off the list under test. A ninth runner message with no line fails here, and
  // the person reading the Data section would otherwise never learn it exists.
  expect(RUNNER_MESSAGES.filter((type) => !(type in SYNCED_DATA))).toEqual([]);
  expect(Object.keys(SYNCED_DATA).sort()).toEqual([...SENDS_DATA].sort());
  // A line is a sentence a person reads, so an empty one is as bad as a missing key.
  for (const type of SENDS_DATA) expect(SYNCED_DATA[type as (typeof RUNNER_MESSAGES)[number]]).toMatch(/^\S.*\.$/);
});

// The never list is the other half of the screen, and it is a promise. Pinned whole. Plan steps,
// paths, tool activity, logs, discussion and the usage window are on it too.
it('names the twelve things that never leave the machine', () => {
  expect([...NEVER_SENT]).toEqual([
    'Code',
    'Diffs of your code',
    'Transcripts',
    'Engine logins',
    'Engine limit state and the usage window',
    'Scout source tokens · in your keychain',
    'The lines a Scout source read',
    'Run logs',
    'Plan steps',
    'Paths on this machine',
    'Tool activity',
    'Discussion messages',
  ]);
});

// The three things `card.state` carries beyond the basics are named where a person reads what it sends.
it('names the plain summary, the answers a question offers and the next start on the card.state line', () => {
  const line = SYNCED_DATA['card.state'];
  expect(line).toContain('plain summary, cut to 600 characters');
  expect(line).toContain('the answers it offers');
  expect(line).toContain('engine, model and effort');
});

describe('capSummary', () => {
  it('keeps a summary at or under the cap as it is, trimmed', () => {
    expect(capSummary('  Added the recipe search.  ')).toBe('Added the recipe search.');
    expect(capSummary('a'.repeat(SUMMARY_CAP))).toBe('a'.repeat(SUMMARY_CAP));
  });

  it('cuts a long summary on a word, with an ellipsis, within 600 characters', () => {
    const long = 'word '.repeat(200);
    const cut = capSummary(long);
    expect(SUMMARY_CAP).toBe(600);
    expect(cut.length).toBeLessThanOrEqual(600);
    expect(cut.endsWith('word…')).toBe(true);
    expect(cut.length).toBeGreaterThan(590);
  });

  // One word longer than the cap has no space to cut on, so it is cut where the cap falls.
  it('cuts inside a word only when the first 600 characters hold no space', () => {
    const cut = capSummary('x'.repeat(700));
    expect(cut).toBe(`${'x'.repeat(599)}…`);
  });
});

// The registration carries the time of the sync and the job types this build runs, so the line
// that says what it carries names both.
it('names the sync time and the job types on the project.sync line', () => {
  expect(SYNCED_DATA['project.sync']).toContain('the time of this sync');
  expect(SYNCED_DATA['project.sync']).toContain('the job types this build can run');
});

it.each(ALL)('round-trips a %s message through serialize and parse', (type) => {
  const sent = hubEnvelope(type, 7, { card: 'APP-1' });
  expect(parseHubFrame(serializeHubFrame(sent))).toEqual(sent);
});

it('stamps a message with the version this build speaks', () => {
  expect(hubEnvelope('job.ack', 1, null).version).toBe(HUB_PROTOCOL);
});

it('refuses a message type it does not know rather than dropping it', () => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'run.explode', job: 1, payload: null });
  expect(() => parseHubFrame(frame)).toThrow('message type this build does not know');
});

it.each([{}, { job: '1' }, { job: null }])('refuses a message with no job id, given %o', (job) => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'card.move', payload: null, ...job });
  expect(() => parseHubFrame(frame)).toThrow('carries no job id');
});

// A hub that counts its queue from 0 gets told about the counter. The missing-field sentence would
// point at the wrong thing.
it.each([{ job: 0 }, { job: -1 }, { job: 1.5 }])('refuses a job id out of range, and does not call it missing, given %o', (job) => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'card.move', payload: null, ...job });
  expect(() => parseHubFrame(frame)).toThrow('not a whole number above zero');
});

// The cloud as it is sends no project, and a frame like that means the first project.
it('reads a frame with no project as one with no project, not a refused one', () => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'card.move', job: 1, payload: null });
  expect(parseHubFrame(frame)).toEqual({ version: HUB_PROTOCOL, type: 'card.move', job: 1, payload: null });
  expect('project' in (parseHubFrame(frame) as object)).toBe(false);
  expect('project' in hubEnvelope('card.move', 1, null)).toBe(false);
});

it('carries the project a frame names through serialize and parse', () => {
  const sent = hubEnvelope('card.move', 4, { key: 'APP-1', to: 'implement' }, 2);
  expect(sent.project).toBe(2);
  expect(parseHubFrame(serializeHubFrame(sent))).toEqual(sent);
});

it('reads a project of null as no project', () => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'card.move', job: 1, project: null, payload: null });
  expect('project' in (parseHubFrame(frame) as object)).toBe(false);
});

it.each([{ project: 0 }, { project: -2 }, { project: 1.5 }, { project: '2' }, { project: true }])('refuses a project that is no registry id, given %o', (project) => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'card.move', job: 1, payload: null, ...project });
  expect(() => parseHubFrame(frame)).toThrow('names a project that is not a whole number above zero');
});

it('refuses a message with no payload, so a sender cannot leave the field out', () => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type: 'card.move', job: 1 });
  expect(() => parseHubFrame(frame)).toThrow('carries no payload');
});

it('keeps a payload of null, which is what an ack carries', () => {
  expect(parseHubFrame(serializeHubFrame(hubEnvelope(JOB_ACK, 3, null)))).toEqual({ version: HUB_PROTOCOL, type: JOB_ACK, job: 3, payload: null });
});

it('refuses a message that speaks another protocol version', () => {
  const frame = JSON.stringify({ version: 'nolzu.0', type: 'card.move', job: 1, payload: null });
  expect(() => parseHubFrame(frame)).toThrow(HUB_PROTOCOL);
});

// Each case names the sentence it has to get. A bare toThrow passes while the reader throws for the
// wrong reason, and the reason is the half that reaches a log. An array is the case worth naming: it
// is an object to `typeof`, so without its own guard it would be turned down for a missing version.
it.each([
  ['not json at all', 'is not JSON'],
  ['"a string"', 'is not a message object'],
  ['[1, 2]', 'is not a message object'],
  ['null', 'is not a message object'],
])('refuses the frame %s with its own sentence', (frame, sentence) => {
  expect(() => parseHubFrame(frame)).toThrow(sentence);
});

it.each([PING, PONG] as const)('parses %s as itself and not as a message', (word) => {
  expect(parseHubFrame(word)).toBe(word);
  expect(serializeHubFrame(word)).toBe(word);
});

// The heartbeat words are bare, so a message type that read the same would be taken for a ping.
it('gives every message type a name the heartbeat cannot be mistaken for', () => {
  for (const type of ALL) {
    expect(type).toContain('.');
    expect(type).not.toBe(PING);
    expect(type).not.toBe(PONG);
  }
});

it('closes a dropped version with its own code, not the token code', () => {
  // Pinned to the number. The hub closes with the literal and the client reads the literal, so the
  // value is the contract and a range check would let it drift.
  expect(PROTOCOL_REFUSED).toBe(4426);
  expect(PROTOCOL_REFUSED).not.toBe(TOKEN_REFUSED);
  // Application close codes live in 4000 to 4999. Outside that range the socket refuses to close.
  expect(PROTOCOL_REFUSED).toBeGreaterThanOrEqual(4000);
  expect(PROTOCOL_REFUSED).toBeLessThanOrEqual(4999);
});

// A plan the hub will not serve is the third code, and it is not a token problem: signing in again
// changes nothing, so the client reports it as a state of its own.
it('closes an account whose plan does not open the hub with its own code', () => {
  expect(PLAN_REFUSED).toBe(4402);
  expect(PLAN_REFUSED).not.toBe(TOKEN_REFUSED);
  expect(PLAN_REFUSED).not.toBe(PROTOCOL_REFUSED);
  expect(PLAN_REFUSED).toBeGreaterThanOrEqual(4000);
  expect(PLAN_REFUSED).toBeLessThanOrEqual(4999);
});

// Delete my cloud data pauses sync. Today's hub closes with a plain 1000 and its
// sentence; a later hub closes with the code. Either one is the signal, and neither is a refusal.
it('reads the delete close by its code or by the sentence today\'s hub sends', () => {
  expect(CLOUD_DATA_DELETED).toBe(4410);
  expect(isCloudDataDeleted(CLOUD_DATA_DELETED)).toBe(true);
  expect(isCloudDataDeleted(1000, CLOUD_DATA_DELETED_REASON)).toBe(true);
  expect(CLOUD_DATA_DELETED_REASON).toBe('The cloud data of this account was deleted. Send the board again.');
  expect(isCloudDataDeleted(1000, 'A newer connection from this device took over.')).toBe(false);
  expect(isCloudDataDeleted(1006)).toBe(false);
  expect(isHubRefusal(CLOUD_DATA_DELETED)).toBe(false);
});

it('reads all three refusal codes as a refusal, and a lost network as neither', () => {
  expect(isHubRefusal(TOKEN_REFUSED)).toBe(true);
  expect(isHubRefusal(PROTOCOL_REFUSED)).toBe(true);
  expect(isHubRefusal(PLAN_REFUSED)).toBe(true);
  expect(isHubRefusal(1006)).toBe(false);
  expect(isHubRefusal(1000)).toBe(false);
});

it('holds the connect path, so the client and the hub agree on one string', () => {
  expect(HUB_PATH).toBe('/connect');
  expect(`wss://hub.example${HUB_PATH}`).toBe('wss://hub.example/connect');
});

// The second path. It is how a dial says which of the two hubs it wants, because a WebSocket carries no
// header its caller chose, and both strings are pinned because the router that reads them is on the
// server.
// The trap it leaves is that the personal path is the start of this one, so a router matching the start
// of the string would send every team dial to the personal hub, where the same device and the same token
// look like the same request. Nothing in this package routes, so the check that the hub matches a whole
// path belongs beside that router on the server.
it('holds a second connect path for a team hub', () => {
  expect(TEAM_HUB_PATH).toBe('/connect/team');
});

// The two settings messages. Every name and every number below is written out, not read back from the
// module, because a test that reads the value it checks stays green through any change to it.
const SYNC: ProjectSync = {
  id: 'p-1',
  name: 'Recipe app',
  flow: 'pull-request',
  clientName: 'Demo client',
  hourlyRate: 90,
  currency: 'EUR',
  updatedAt: '2026-09-28T12:00:00.000Z',
  team: false,
};

// Without the two opt-ins, so every case built on it reads the way a payload from an older build
// without them reads. The cases that are about them write them out. The `Omit` is what says that on
// purpose: both flags are required on `ScoutSchedule`, so every sender has to name them, and only a
// payload read off the wire may leave them out.
const SCHEDULE: Omit<ScoutSchedule, 'createCards' | 'autoAssess'> = { projectId: 'p-1', sourceId: 3, intervalMinutes: 60, notify: true };

it.each([
  ['project.sync', SYNC],
  ['scout.schedule', SCHEDULE],
] as const)('round-trips a %s frame, with the job id every frame carries', (type, payload) => {
  const sent = hubEnvelope(type, 12, payload);
  expect(sent.type).toBe(type);
  // The decision recorded here: a settings message belongs to no job and still counts, so the
  // envelope keeps one shape and no reader of `job` grows a null branch.
  expect(sent.job).toBe(12);
  expect(parseHubFrame(serializeHubFrame(sent))).toEqual(sent);
});

// `parseHubFrame` stays payload-blind. A settings payload is refused by its own guard, so a later
// field never turns into a parse change for the six job messages beside it.
it.each(['project.sync', 'scout.schedule'] as const)('parses a %s frame with a payload it does not read', (type) => {
  const frame = JSON.stringify({ version: HUB_PROTOCOL, type, job: 1, payload: { nothing: true } });
  expect(parseHubFrame(frame)).toEqual({ version: HUB_PROTOCOL, type, job: 1, payload: { nothing: true } });
});

it('reads a project sync a machine sends, and leaves an empty client and rate as null', () => {
  expect(readProjectSync({ ...SYNC })).toEqual(SYNC);
  expect(readProjectSync({ id: 'p-2', name: 'Recipe app', flow: 'pull-request', updatedAt: '2026-09-28T12:00:00+02:00' })).toEqual({
    id: 'p-2',
    name: 'Recipe app',
    flow: 'pull-request',
    clientName: null,
    hourlyRate: null,
    currency: null,
    updatedAt: '2026-09-28T12:00:00+02:00',
    team: false,
  });
});

// Direct merge is gone. A machine on an older version may still send it, and the hub reads it as the one
// flow left rather than refuse that machine's sync.
it('reads a direct merge flow from an older machine as pull-request', () => {
  expect(readProjectSync({ ...SYNC, flow: 'direct-merge' }).flow).toBe('pull-request');
});

// The marker a team project carries. A machine on an older build sends none, and that machine's project
// is a personal one, so the missing field cannot read as anything else.
it('reads the team marker, and reads a project sync with no marker as a personal project', () => {
  expect(readProjectSync({ ...SYNC, team: true }).team).toBe(true);
  const older: Record<string, unknown> = { ...SYNC };
  delete older.team;
  expect(readProjectSync(older).team).toBe(false);
  expect(readProjectSync({ ...SYNC, team: null }).team).toBe(false);
});

// The list the hub gates on. A machine that sends nothing is an older build, and the hub falls back to
// the job types every build handles, so a missing list must read as missing and never as empty:
// an empty list would say this machine runs nothing at all.
it('reads the list of job types a build can run, and leaves it out when the machine sent none', () => {
  expect(readProjectSync({ ...SYNC, handles: ['run.start', 'card.move'] }).handles).toEqual(['run.start', 'card.move']);
  expect(readProjectSync({ ...SYNC }).handles).toBeUndefined();
  expect(readProjectSync({ ...SYNC, handles: [] }).handles).toEqual([]);
});

// Refused and not guessed at. A hub that read a number as a message type would hold back every job for
// that machine, and the person would see a queue that never moves with no reason given.
it.each([['not a list'], [42], [{ 0: 'run.start' }], [['run.start', 7]], [[null]]])(
  'refuses a handles list that is not a list of message names, given %o',
  (bad) => {
    expect(() => readProjectSync({ ...SYNC, handles: bad })).toThrow('handles list that is not a list of message names');
  },
);

// The text 'false' is the case worth naming: it is true to a bare `if`, so a marker taken as it arrived
// would put one person's personal cards on a team board.
it.each(['false', 'true', 1, 0])('refuses a team marker that is not a flag, given %o', (bad) => {
  expect(() => readProjectSync({ ...SYNC, team: bad })).toThrow('team marker that is neither true nor false');
});

// Each case names the sentence it has to get. A bare toThrow passes while the guard throws for the
// wrong reason, and the reason is the half a person reads in the log.
it.each([
  ['id', 'carries no project id'],
  ['name', 'carries no project name'],
  ['flow', 'delivery flow that is not pull-request'],
  ['updatedAt', 'carries no write time'],
])('refuses a project sync with no %s, and names the field', (field, sentence) => {
  const payload: Record<string, unknown> = { ...SYNC };
  delete payload[field];
  expect(() => readProjectSync(payload)).toThrow(sentence);
});

it.each([
  [{ flow: 'squash-merge' }, 'delivery flow that is not pull-request'],
  [{ name: 7 }, 'project name that is not text'],
  [{ hourlyRate: -1 }, 'hourly rate that is not a number at or above zero'],
  [{ hourlyRate: 'ninety' }, 'hourly rate that is not a number at or above zero'],
  [{ currency: 'euro' }, 'not a three-letter code'],
  // Date.parse alone reads both of these. The hub converges on this field, so a loose clock would
  // beat every later write.
  [{ updatedAt: '2026' }, 'carries no write time'],
  // A stamp with no zone is read as local time, so two machines an hour apart would converge wrong.
  [{ updatedAt: '2026-09-28T12:00:00' }, 'carries no write time'],
  [{ updatedAt: '28/09/2026' }, 'carries no write time'],
])('refuses the project sync field %o', (bad, sentence) => {
  expect(() => readProjectSync({ ...SYNC, ...bad })).toThrow(sentence);
});

// The hub stores the code uppercase, so this guard has to give the same answer. A lower-case code
// read back as it arrived would leave two machines writing 'eur' and 'EUR' for one currency.
it.each(['eur', 'Eur', 'EUR'])('reads the currency %s back as EUR, the way the hub stores it', (sent) => {
  expect(readProjectSync({ ...SYNC, currency: sent }).currency).toBe('EUR');
});

// A client who is not billed by the hour syncs a rate of 0, so the guard takes 0 and not only above it.
it('keeps an hourly rate of zero, which is a client not billed by the hour', () => {
  expect(readProjectSync({ ...SYNC, hourlyRate: 0 }).hourlyRate).toBe(0);
});

it('reads a Scout schedule a machine sends', () => {
  expect(readScoutSchedule({ ...SCHEDULE, createCards: true, autoAssess: true })).toEqual({ ...SCHEDULE, createCards: true, autoAssess: true });
  expect(readScoutSchedule({ projectId: 'p-1', sourceId: 4, intervalMinutes: 0, notify: false, createCards: false, autoAssess: false })).toEqual({
    projectId: 'p-1',
    sourceId: 4,
    intervalMinutes: 0,
    notify: false,
    createCards: false,
    autoAssess: false,
  });
});

/**
 * THE COMPATIBILITY TEST FOR THE TWO OPT-INS. DO NOT DELETE IT.
 *
 * `createCards` and `autoAssess` were added after this message shipped, so every machine on an older
 * build sends a schedule with neither. Such a payload has to read, and both flags have to come
 * back off. A reader that threw here would drop that person's schedule on every connect, with nothing
 * on their screen saying so, and one that answered true would have the server make cards nobody asked
 * for.
 *
 * Red the moment either flag is read the way `notify` is read, with a `typeof value !== 'boolean'`
 * throw, in `readScoutSchedule`.
 */
it('reads a schedule that carries neither opt-in, and answers off for both', () => {
  expect(readScoutSchedule({ projectId: 'p-1', sourceId: 3, intervalMinutes: 60, notify: true })).toEqual({
    projectId: 'p-1',
    sourceId: 3,
    intervalMinutes: 60,
    notify: true,
    createCards: false,
    autoAssess: false,
  });
});

// Each opt-in on its own, so a reader that answered one of them with the other's value is caught.
// Red if either name is dropped from the object `readScoutSchedule` returns.
it.each([
  [true, false],
  [false, true],
  [true, true],
])('carries createCards %s and autoAssess %s up as they were set', (createCards, autoAssess) => {
  expect(readScoutSchedule({ ...SCHEDULE, createCards, autoAssess })).toEqual({ ...SCHEDULE, createCards, autoAssess });
});

// Null is what a sender that fills every field writes for a value it does not have, and that is the
// same as leaving the field out. Red if `settingsFlag` refuses null instead of reading it as off.
it('reads a null opt-in as off, the way a missing one reads', () => {
  expect(readScoutSchedule({ ...SCHEDULE, createCards: null, autoAssess: null })).toEqual({ ...SCHEDULE, createCards: false, autoAssess: false });
});

// The text 'false' is true to a bare `if`, and 0 is false, so a flag read from anything but a flag
// would turn an opt-in nobody gave into a yes. Red if `settingsFlag` coerces instead of throwing.
// The article is part of every sentence here, because a person reads these in the machine's log and
// `settingsFlag` writes `a ${field}` for every field it is given.
it.each([
  [{ createCards: 'true' }, 'carries a create cards flag that is neither true nor false'],
  [{ createCards: 'false' }, 'carries a create cards flag that is neither true nor false'],
  [{ createCards: 1 }, 'carries a create cards flag that is neither true nor false'],
  [{ autoAssess: 'on' }, 'carries a findings assessment flag that is neither true nor false'],
  [{ autoAssess: 0 }, 'carries a findings assessment flag that is neither true nor false'],
  [{ autoAssess: {} }, 'carries a findings assessment flag that is neither true nor false'],
])('refuses the Scout schedule opt-in %o, and names the field', (bad, sentence) => {
  expect(() => readScoutSchedule({ ...SCHEDULE, ...bad })).toThrow(sentence);
});

it.each([
  ['projectId', 'carries no project id'],
  ['sourceId', 'carries no source id'],
  ['intervalMinutes', 'interval that is not a whole number of minutes'],
  ['notify', 'carries no notify flag'],
])('refuses a Scout schedule with no %s, and names the field', (field, sentence) => {
  const payload: Record<string, unknown> = { ...SCHEDULE };
  delete payload[field];
  expect(() => readScoutSchedule(payload)).toThrow(sentence);
});

// Pinned to the numbers the client's own selector offers. A range check here would let both drift.
it('takes the interval the client offers, off included, and refuses one outside it', () => {
  expect(MIN_SCOUT_INTERVAL_MINUTES).toBe(15);
  expect(MAX_SCOUT_INTERVAL_MINUTES).toBe(10080);
  for (const minutes of [0, 15, 10080]) {
    expect(readScoutSchedule({ ...SCHEDULE, intervalMinutes: minutes }).intervalMinutes).toBe(minutes);
  }
  expect(() => readScoutSchedule({ ...SCHEDULE, intervalMinutes: 14 })).toThrow('It is 0 to turn it off, or 15 to 10080 minutes.');
  expect(() => readScoutSchedule({ ...SCHEDULE, intervalMinutes: 10081 })).toThrow('It is 0 to turn it off, or 15 to 10080 minutes.');
  expect(() => readScoutSchedule({ ...SCHEDULE, intervalMinutes: -15 })).toThrow('interval that is not a whole number of minutes');
  expect(() => readScoutSchedule({ ...SCHEDULE, intervalMinutes: 20.5 })).toThrow('interval that is not a whole number of minutes');
});

it.each([
  [{ sourceId: 0 }, 'carries no source id'],
  [{ sourceId: '3' }, 'carries no source id'],
  [{ sourceId: 1.5 }, 'carries no source id'],
  [{ notify: 'yes' }, 'carries no notify flag'],
  [{ projectId: '  ' }, 'carries no project id'],
])('refuses the Scout schedule field %o', (bad, sentence) => {
  expect(() => readScoutSchedule({ ...SCHEDULE, ...bad })).toThrow(sentence);
});

// An array is an object to `typeof`, so without its own guard it would be turned down for a missing
// field instead of for its shape.
it.each([
  ['a string', 'p-1'],
  ['an array', [1, 2]],
  ['null', null],
])('refuses a settings payload that is %s', (_shape, payload) => {
  expect(() => readProjectSync(payload)).toThrow('A project sync arrived that is not a message object.');
  expect(() => readScoutSchedule(payload)).toThrow('A Scout schedule arrived that is not a message object.');
  expect(() => readKnowledgeProposal(payload)).toThrow('A knowledge proposal arrived that is not a message object.');
});

// The proposal a team's knowledge folder gets. Every field is written out here, so a renamed field on
// the wire has to be renamed in this file as well.
const DIFF = '--- a\n+++ b\n@@ -1 +1 @@\n-old line\n+new line\n';

const PROPOSAL: KnowledgeProposal = {
  teamProjectId: 't-1',
  cardKey: 'APP-1',
  runId: 12,
  files: [{ path: 'testing.md', diff: DIFF }],
};

// One list and not one path. The machine holds a run's writing aside as one thing and commits it as
// one thing, so a proposal a reviewer approves has to be the same one thing.
it('carries every file of one run, so approving a proposal cannot commit a file nobody read', () => {
  const both = { ...PROPOSAL, files: [{ path: 'testing.md', diff: DIFF }, { path: 'decisions.md', diff: DIFF }] };
  expect(readKnowledgeProposal(both).files.map((file) => file.path)).toEqual(['testing.md', 'decisions.md']);
});

it('reads a knowledge proposal a machine sends, and keeps the diff exactly as it arrived', () => {
  expect(readKnowledgeProposal({ ...PROPOSAL })).toEqual(PROPOSAL);
  // Not trimmed, unlike the text fields beside it. Whitespace is part of a patch, and a trimmed diff
  // applies differently or not at all.
  expect(readKnowledgeProposal({ ...PROPOSAL, files: [{ path: 'testing.md', diff: '\n+new line\n' }] }).files[0]?.diff).toBe('\n+new line\n');
  // Trimmed, because a path with a space around it is one nothing on disk answers to.
  expect(readKnowledgeProposal({ ...PROPOSAL, files: [{ path: '  testing.md  ', diff: DIFF }] }).files[0]?.path).toBe('testing.md');
});

it.each([
  ['teamProjectId', 'carries no team project id'],
  ['cardKey', 'carries no card key'],
  ['runId', 'carries no run id'],
  ['files', 'carries no files'],
])('refuses a knowledge proposal with no %s, and names the field', (field, sentence) => {
  const payload: Record<string, unknown> = { ...PROPOSAL };
  delete payload[field];
  expect(() => readKnowledgeProposal(payload)).toThrow(sentence);
});

it.each([
  [{ teamProjectId: '   ' }, 'carries no team project id'],
  [{ cardKey: 7 }, 'card key that is not text'],
  [{ runId: '12' }, 'carries no run id'],
  [{ runId: 0 }, 'carries no run id'],
  [{ runId: 1.5 }, 'carries no run id'],
  // A proposal that proposes nothing is a sender that lost the change on the way, and a reviewer would
  // get an empty screen to approve.
  [{ files: [] }, 'carries no files'],
  [{ files: {} }, 'carries no files'],
  [{ files: [null] }, 'file arrived that is not a message object'],
  [{ files: [{ path: { name: 'testing.md' }, diff: DIFF }] }, 'file path that is not text'],
  [{ files: [{ diff: DIFF }] }, 'carries no file path'],
  [{ files: [{ path: 'testing.md' }] }, 'diff that is not text'],
  [{ files: [{ path: 'testing.md', diff: null }] }, 'diff that is not text'],
  [{ files: [{ path: 'testing.md', diff: '   \n ' }] }, 'carries an empty diff'],
  // Two diffs against one file apply twice or fight each other, and a reviewer sees the file twice with
  // no way to tell which one the folder ends up with.
  [{ files: [{ path: 'testing.md', diff: DIFF }, { path: '  testing.md', diff: DIFF }] }, 'names the same file twice'],
])('refuses the knowledge proposal field %o', (bad, sentence) => {
  expect(() => readKnowledgeProposal({ ...PROPOSAL, ...bad })).toThrow(sentence);
});

// The two dropped names are now unknown words, so a frame that still carries one is refused
// with the sentence every unknown type gets, and never read as something else.
it.each(['run.events', 'cost.report'])('refuses a %s frame as a message type this build does not know', (type) => {
  const text = JSON.stringify({ version: HUB_PROTOCOL, type, job: 3, payload: null });
  expect(() => parseHubFrame(text)).toThrow('A hub frame names a message type this build does not know.');
});

const FINDING = {
  sourceId: 2,
  fingerprint: 'a1b2c3d4e5f60718',
  kind: 'bug',
  status: 'new',
  occurrences: 4,
  firstSeen: '2026-09-30T08:00:00.000Z',
  lastSeen: '2026-10-01T09:30:00.000Z',
  location: 'src/app.ts:12',
  externalKey: null,
  cardKey: null,
};

it('reads a finding.results payload as the client sends it, field by field', () => {
  const second = { ...FINDING, fingerprint: 'ffff', status: 'dismissed', externalKey: 'PROJ-123', cardKey: 'PROJ-123' };
  expect(readFindingResults({ projectId: 'p-1', findings: [FINDING, second] })).toEqual({ projectId: 'p-1', findings: [FINDING, second] });
});

// The project comes from the payload, never from a finding, and a field the type does not name is dropped.
// So is a line a sender reported anyway: the reported lines never reach the hub.
it('reads a finding under the payload project and drops a field it does not name', () => {
  const read = readFindingResults({ projectId: 'p-1', findings: [{ ...FINDING, projectId: 'p-2', id: 7, lastMessage: 'token=abc' }] });
  expect(read).toEqual({ projectId: 'p-1', findings: [FINDING] });
});

// Each is a field the hub keys or sorts on, so a wrong one is refused rather than stored.
it.each([
  [{ projectId: '' }, 'carries no project id'],
  [{ findings: [] }, 'carries no findings'],
  [{ findings: [{ ...FINDING, sourceId: '2' }] }, 'carries no source id'],
  [{ findings: [{ ...FINDING, sourceId: 0 }] }, 'carries no source id'],
  [{ findings: [{ ...FINDING, fingerprint: ' ' }] }, 'carries no fingerprint'],
  [{ findings: [{ ...FINDING, kind: null }] }, 'carries no kind'],
  [{ findings: [{ ...FINDING, status: undefined }] }, 'carries no status'],
  [{ findings: [{ ...FINDING, occurrences: -1 }] }, 'occurrence count'],
  [{ findings: [{ ...FINDING, firstSeen: '2026' }] }, 'no first seen time'],
  [{ findings: [{ ...FINDING, lastSeen: '2026-10-01T09:30:00' }] }, 'no last seen time'],
  [{ findings: [{ ...FINDING, location: 3 }] }, 'a location that is not text'],
])('refuses a finding.results payload with %o', (change, sentence) => {
  expect(() => readFindingResults({ projectId: 'p-1', findings: [FINDING], ...change })).toThrow(sentence);
});

// The state a card's pull request is in, on `card.state`. Written out by hand, so a word dropped
// from the list turns this red and not only the reader.
it.each(['open', 'closed', 'merged'])('reads the pull request state %s', (state) => {
  expect(PULL_STATES).toContain(state);
  expect(readPullState(state)).toBe(state);
});

it.each(['Merged', 'draft', 'MERGED', ' merged', '', 1, true, {}])('refuses the pull request state %o with a sentence', (bad) => {
  expect(() => readPullState(bad)).toThrow('A board sync carries a pull request state the hub does not know. It is open, closed or merged.');
});

// A machine on an older build sends the pull request with no state at all. Null is the same answer,
// because a sender with no value may write null. The frame without the key is in hub-sync.test.ts.
it('reads a missing or null pull request state as no state', () => {
  expect(readPullState(undefined)).toBeNull();
  expect(readPullState(null)).toBeNull();
});

// The account's projects, sent down by the personal hub on `project.list`. Only what a list needs: no
// path, no repository, no client and no rate.
const LISTED = {
  projects: [
    { id: 'p-1', name: 'recipes', lastActivity: '2026-10-07T09:15:00.000Z' },
    { id: 'p-2', name: 'recipe-api', lastActivity: null },
  ],
};

it('reads the project list the hub sends, and drops a field it does not name', () => {
  expect(readProjectList(LISTED)).toEqual(LISTED);
  // A path or a client the hub sent anyway is not kept, so the machine never stores more than the list.
  const extra = { projects: [{ ...LISTED.projects[0], path: '/home/dev/recipes', clientName: 'Demo client' }] };
  expect(readProjectList(extra)).toEqual({ projects: [LISTED.projects[0]] });
  // A project nothing happened on yet has no time, and a sender may leave the field out.
  expect(readProjectList({ projects: [{ id: 'p-3', name: 'recipe-web' }] })).toEqual({ projects: [{ id: 'p-3', name: 'recipe-web', lastActivity: null }] });
});

// A time with a zone is read into UTC, because the client draws the time with a UTC label.
it('reads a last activity time with a zone into UTC', () => {
  const read = readProjectList({ projects: [{ id: 'p-2', name: 'recipe-api', lastActivity: '2026-10-07T23:30:00+02:00' }] });
  expect(read.projects[0]?.lastActivity).toBe('2026-10-07T21:30:00.000Z');
});

// The whole list and not a change, so an account whose projects are all gone is an empty list.
it('reads an empty project list', () => {
  expect(readProjectList({ projects: [] })).toEqual({ projects: [] });
});

it.each([
  [null, 'project list arrived that is not a message object'],
  [{}, 'carries no list of projects'],
  [{ projects: {} }, 'carries no list of projects'],
  [{ projects: [null] }, 'project list arrived that is not a message object'],
  [{ projects: [{ name: 'recipes' }] }, 'carries a project with no id'],
  [{ projects: [{ id: ' ', name: 'recipes' }] }, 'carries a project with no id'],
  [{ projects: [{ id: 'p-1' }] }, 'carries a project with no name'],
  [{ projects: [{ id: 'p-1', name: 7 }] }, 'project name that is not text'],
  [{ projects: [{ id: 'p-1', name: 'recipes', lastActivity: '2026' }] }, 'last activity time'],
  [{ projects: [{ id: 'p-1', name: 'recipes', lastActivity: 1_700_000_000_000 }] }, 'last activity time'],
  // One project twice would draw twice, and the second row would hide which name is the current one.
  [{ projects: [{ id: 'p-1', name: 'recipes' }, { id: 'p-1', name: 'recipes-old' }] }, 'names the same project twice'],
])('refuses the project list %o with a sentence', (bad, sentence) => {
  expect(() => readProjectList(bad)).toThrow(sentence);
});

// A team run's cost, tokens and model, up the team socket on `run.cost`. Every field written out, so a
// field added to the frame has to be added here as well.
const COST: RunCost = {
  runId: 12,
  cardKey: 'APP-1',
  phase: 'implement',
  model: 'sonnet',
  startedAt: '2026-10-07T09:00:00.000Z',
  costUsd: 0.42,
  durationMs: 61_000,
  tokens: { input: 1200, output: 300, cacheRead: 9000, cacheCreation: 40 },
};

const COSTS: RunCosts = { teamProjectId: 't-1', runs: [COST] };

// The words that name a run's content. Lowercased first, so `logPath` and `verdictReason` match too.
type Content = 'prompt' | 'transcript' | 'diff' | 'message' | 'title' | 'log' | 'question' | 'reason' | 'error' | 'session' | 'summary' | 'result';
type ContentKeys<T> = Extract<Lowercase<Extract<keyof T, string>>, `${string}${Content}${string}`>;
// Checked by the typecheck, which reads this file: a content field on either type turns `true` into a
// type error here.
const noContentField: [ContentKeys<RunCost> | ContentKeys<RunCosts>] extends [never] ? true : false = true;
const CONTENT = /prompt|transcript|diff|message|title|log|question|reason|error|session|summary|result/i;

it('carries no prompt, transcript, diff, message, title or log field in a run cost frame', () => {
  expect(noContentField).toBe(true);
  const read = readRunCosts(COSTS);
  expect(Object.keys(read).sort()).toEqual(['runs', 'teamProjectId']);
  for (const run of read.runs) {
    expect(Object.keys(run).sort()).toEqual(['cardKey', 'costUsd', 'durationMs', 'model', 'phase', 'runId', 'startedAt', 'tokens']);
    for (const field of Object.keys(run)) expect(field).not.toMatch(CONTENT);
  }
});

// The Data screen promises what leaves the machine, so every field of the frame has its words in the
// line. Keyed on the types, so a field added to the frame fails the typecheck until it is named here.
const NAMED: Record<keyof RunCost | keyof RunCosts, string> = {
  teamProjectId: 'team project',
  runs: 'each run',
  runId: 'each run',
  cardKey: 'card key',
  phase: 'phase',
  model: 'model',
  startedAt: 'start time',
  costUsd: 'cost',
  durationMs: 'duration',
  tokens: 'token counts',
};

it('names every field of the run cost frame in its Data line', () => {
  for (const words of Object.values(NAMED)) expect(SYNCED_DATA['run.cost']).toContain(words);
});

// The same for a schedule. Nothing checks a source on a schedule yet, so the line names what the person
// asked for and says that it changes nothing today, and never that Scout checks or notifies.
const SCHEDULE_NAMED: Record<keyof ScoutSchedule, string> = {
  projectId: 'project',
  sourceId: 'source',
  intervalMinutes: 'how often you asked Nolzu cloud to check it',
  notify: 'whether you asked for a notification',
  createCards: 'make cards',
  autoAssess: 'start an assessment',
};

it('names every field of the schedule frame in its Data line, and says nothing checks on it yet', () => {
  const line = SYNCED_DATA['scout.schedule'];
  for (const words of Object.values(SCHEDULE_NAMED)) expect(line).toContain(words);
  expect(line).toContain('Nolzu cloud checks no source yet, so a schedule changes nothing today.');
  for (const running of ['Scout checks it', 'notifies you', 'scheduled check']) expect(line).not.toContain(running);
});

it('reads a run cost frame, and drops a content field a sender put on it anyway', () => {
  expect(readRunCosts(COSTS)).toEqual(COSTS);
  // The engine profile id is made from a label the person typed, so it is dropped with the rest.
  const leaky = { ...COSTS, runs: [{ ...COST, engine: 'claude', question: 'which index name?', verdictReason: 'All checks hold.', logPath: '/private/run.log', result: 'the transcript' }] };
  expect(readRunCosts(leaky)).toEqual(COSTS);
  // An engine that reports no cost, no count and no model still reports a run, and the report counts it as short.
  const quiet = { ...COST, model: null, costUsd: null, durationMs: null, tokens: null };
  expect(readRunCosts({ ...COSTS, runs: [quiet] }).runs).toEqual([quiet]);
});

// The report cuts the month out of the text in UTC. A run at half past midnight in a zone east of UTC
// belongs to the month before.
it('reads a run start time with a zone into UTC', () => {
  const read = readRunCosts({ ...COSTS, runs: [{ ...COST, startedAt: '2026-10-01T00:30:00+02:00' }] });
  expect(read.runs[0]?.startedAt).toBe('2026-09-30T22:30:00.000Z');
});

it.each([
  [{ teamProjectId: '' }, 'carries no team project id'],
  [{ runs: [] }, 'carries no runs'],
  [{ runs: [{ ...COST, runId: 0 }] }, 'carries no run id'],
  [{ runs: [{ ...COST, runId: '12' }] }, 'carries no run id'],
  [{ runs: [{ ...COST, cardKey: ' ' }] }, 'carries no card key'],
  [{ runs: [{ ...COST, phase: null }] }, 'carries no phase'],
  [{ runs: [{ ...COST, model: 4 }] }, 'model that is not text'],
  [{ runs: [{ ...COST, startedAt: null }] }, 'carries no start time'],
  [{ runs: [{ ...COST, startedAt: undefined }] }, 'carries no start time'],
  [{ runs: [{ ...COST, startedAt: '2026-10-07 09:00:00' }] }, 'start time that is not an ISO timestamp'],
  // A cost below zero would take money off the team's month.
  [{ runs: [{ ...COST, costUsd: -0.1 }] }, 'cost that is not a number at or above zero'],
  [{ runs: [{ ...COST, costUsd: Number.NaN }] }, 'cost that is not a number at or above zero'],
  [{ runs: [{ ...COST, durationMs: 1.5 }] }, 'duration that is not a whole number'],
  [{ runs: [{ ...COST, tokens: { input: 1, output: 1, cacheRead: 1 } }] }, 'token counts that are not whole numbers'],
  [{ runs: [{ ...COST, tokens: { input: -1, output: 1, cacheRead: 1, cacheCreation: 0 } }] }, 'token counts that are not whole numbers'],
  // One count missing inside the counts. Read as a number, it would add as zero to the team's month.
  [{ runs: [{ ...COST, tokens: { input: null, output: 1, cacheRead: 1, cacheCreation: 0 } }] }, 'token counts that are not whole numbers'],
])('refuses the run cost frame %o with a sentence', (change, sentence) => {
  expect(() => readRunCosts({ ...COSTS, ...change })).toThrow(sentence);
});
