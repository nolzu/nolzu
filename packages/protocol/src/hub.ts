// The WebSocket handshake between the local client and the user's hub, and the messages the two send
// over it. Both sides read this file, so the version string, the close codes, the heartbeat words and
// the message names are written once. The client side of the connection lives in `@nolzu/runner`.

// The delivery flow a project syncs is the one the board already draws from. Two names for one literal
// would drift.
import type { DeliveryFlow } from './board.ts';
import type { EngineName } from './engine.ts';
import type { Estimate } from './estimate.ts';
import type { Effort } from './run.ts';
import type { SpendRun } from './spend.ts';
import { cutOnWord } from './ticket.ts';

// The protocol version this client speaks. The server supports the last two.
export const HUB_PROTOCOL = 'nolzu.1';

// Every character a subprotocol may hold, which is the HTTP token rule.
const TOKEN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;

// The two subprotocols the handshake asks for: the version, and the device token. The token travels
// here because a WebSocket sends no header its caller chose, and a token in the query string would be
// written to every proxy log on the way.
//
// The hub has to issue a token this rule accepts. Base64url with no padding is safe. Plain base64 is
// not, because `/` and the `=` padding are outside the rule, and the client would then refuse every
// token the hub hands out. `+` is inside it: the rule is the HTTP token rule, and that one lists `+`.
export function handshakeProtocols(token: string): string[] {
  if (!TOKEN.test(token)) throw new Error('The device token holds a character the handshake cannot carry. Run npx nolzu@latest login again.');
  return [HUB_PROTOCOL, `bearer.${token}`];
}

// The close code for a token the hub will not accept, for a revoked device or one it has never seen.
//
// The hub has to take the upgrade first and then close with this code. It must never refuse the
// upgrade, because the WebSocket API reports every refused handshake as 1006, which is also what a
// lost network looks like. A client that cannot tell the two apart keeps retrying a dead token for as
// long as the app runs.
export const TOKEN_REFUSED = 4401;

// The heartbeat is two words and not a message type, so no message type below can collide with it. A
// hub hibernates while nothing happens and a dropped link still looks open from the client, so the
// ping is the only thing that finds it.
export const PING = 'ping';
export const PONG = 'pong';

// The connect path on the hub, so the client and the hub agree on one string. It sits here beside the
// version because the version is the other half of the same URL.
export const HUB_PATH = '/connect';

// The connect path for a team's hub. Which of the two a dial wants is carried by the path, because a
// WebSocket sends no header its caller chose, so two sockets from one device with one token would
// otherwise be the same request.
//
// Both sides match the whole path and never a prefix. This one starts with `HUB_PATH`, so a router that
// matches the start of the string would send every team dial to the personal hub.
export const TEAM_HUB_PATH = '/connect/team';

// The close code for a protocol version the hub will not speak. Same shape as TOKEN_REFUSED, and for
// the same reason: `connectHub` reads every other code as a lost network and would dial again for as
// long as the app runs. The number follows HTTP 426, the way 4401 follows 401.
//
// The hub takes the upgrade first and then closes with this code, so the client can tell a version it
// has outgrown from a network that went away.
export const PROTOCOL_REFUSED = 4426;

// The close code for an account whose plan does not open the hub. Same shape again, and the same
// reason: without it the client reads the close as a lost network and dials again for as long as the
// app runs. The number follows HTTP 402, the way 4401 follows 401.
//
// The client has to keep this apart from a refused token, because the two are repaired differently. A
// refused token is fixed by signing in again. A plan is not fixed on this machine at all.
export const PLAN_REFUSED = 4402;

// The codes that mean this client will not be served until something changes, on the machine or on the
// account. The rule lives here so the client tests one thing and not a list.
export const isHubRefusal = (code: number): boolean => code === TOKEN_REFUSED || code === PROTOCOL_REFUSED || code === PLAN_REFUSED;

// The close code for a hub whose cloud data the person deleted. The machine pauses sync until the
// person turns it back on in Settings, Cloud, because a board sent at once would
// put back what the person deleted. The number follows HTTP 410. Not a refusal: nothing is wrong with the
// token or the plan. A hub may close with it on the connect after a delete the machine missed.
export const CLOUD_DATA_DELETED = 4410;

// What a hub from before the code closes with after the delete, as a plain 1000. Read too, so a machine
// pauses whichever hub it talks to.
export const CLOUD_DATA_DELETED_REASON = 'The cloud data of this account was deleted. Send the board again.';

export const isCloudDataDeleted = (code: number, reason = ''): boolean => code === CLOUD_DATA_DELETED || reason === CLOUD_DATA_DELETED_REASON;

// What the hub sends to the runner. Jobs, in the order the hub queued them.
//
// `knowledge.commit`, `claim.answer` and `project.join` belong to a team hub. `knowledge.commit` says a
// proposal was approved and is to be committed, `claim.answer` tells a machine the card it was sent work
// for is held by somebody else, and `project.join` writes the team project id the hub minted onto this
// machine.
//
// `project.list` belongs to the personal hub. It carries every project of the account, so a machine can
// list the projects other machines registered. It is a job because a job is the only frame the runner
// hands on: anything else off the socket is a frame it cannot read.
//
// THE MACHINE NEVER ASKS FOR A CLAIM. The hub takes the card when it queues `run.start`, and refuses a
// second `run.start` for a card somebody else holds, so there is no ask to answer and no release to
// send. `claim.answer` exists for the one case the machine cannot work out for itself: a job it was
// already sent is no longer its to run. The other way, a machine that asks and
// releases, needs two more runner messages and code on the machine that asks, and would still miss a
// refusal from a hub that has not answered yet.
export const SERVER_MESSAGES = [
  'run.start',
  'question.answer',
  'card.move',
  'scout.assess',
  'report.write',
  'knowledge.commit',
  'claim.answer',
  'project.join',
  'project.list',
] as const;

// What the runner sends back. Results, the board data a screen on the server draws from, and the two
// settings messages at the end of this file.
//
// The settings names sit in this table and not in the server one because both travel from the machine
// to the hub. The machine mints a project id and owns the row, and a person sets a Scout schedule in
// the client.
//
// The last two are the claim on a card of a team project. The machine asks, and the hub answers on
// `claim.answer`, because only the hub sees every member.
//
// No `run.events` and no `cost.report`. `card.state` carries the stage moves, the runs, the cost and
// the tokens, and the hub reads them from there, so neither exists.
//
// `run.cost` is the team hub's copy of a run's cost, tokens and model. The team socket sends its
// `card.state` without runs, because a run row holds the question, the verdict reason and the failure,
// and those stay with the person's own hub.
export const RUNNER_MESSAGES = [
  'card.state',
  'evidence.blocks',
  'finding.results',
  'knowledge.proposals',
  'project.sync',
  'scout.schedule',
  'report.weekly',
  'run.cost',
] as const;

// Sent by both sides. The runner acks a job it has taken, and the hub acks a report it has stored, so
// neither side has to guess whether the last frame arrived.
export const JOB_ACK = 'job.ack';

export type ServerMessageType = (typeof SERVER_MESSAGES)[number];
export type RunnerMessageType = (typeof RUNNER_MESSAGES)[number];
export type HubMessageType = ServerMessageType | RunnerMessageType | typeof JOB_ACK;

// Every name holds a dot, which is what keeps the heartbeat safe: `ping` and `pong` are bare words, so
// no message type can ever read as one of them.
const MESSAGE_TYPES: ReadonlySet<string> = new Set<string>([...SERVER_MESSAGES, ...RUNNER_MESSAGES, JOB_ACK]);

/**
 * What each message the runner sends carries away from the machine, in the words the client shows a
 * person in What goes to a hub, a box on Settings, Cloud.
 *
 * The sentence sits beside the wire so the two cannot drift. A message type added to
 * `RUNNER_MESSAGES` with no line here fails the typecheck and the test below, which is the only
 * guard there is against a new frame sending something the screen never mentions.
 *
 * Server messages are not here: they come down to the machine. `job.ack` is not here either,
 * because it carries null.
 *
 * The stage moves, the run times and the costs travel inside `card.state`, which is why its line
 * names them too.
 */
export const SYNCED_DATA: Record<RunnerMessageType, string> = {
  'card.state':
    'Card keys, titles, stages and states, and the ticket or pull request each card came from, with its author, review state, draft flag, last commit time and whether it is open, closed or merged. Every stage move, with who made it and when. For each run, its phase, engine, model, effort, lane, attempt, start and end, cost, duration and token counts. Also its QA verdict with the reason, its plain summary, cut to 600 characters, the question a blocked card waits on with the answers it offers, and whether it failed, without the reason. For a card that can start its next step, the engine, model and effort that step runs on, with its estimate of cost and time when runs measured one.',
  'evidence.blocks':
    'The evidence blocks of a day: each stage move and run with its card, time and spend, and each commit in the project folder that day with its short id and message. That includes commits other people made that this machine fetched.',
  'finding.results':
    'Each Scout finding: the source id, its id for the event, its kind and status, how often and when it was first and last seen, where it happens, the ticket it is about and the card it became. The lines the source reported stay on this machine, and so do the source settings and its token.',
  'knowledge.proposals': 'Knowledge proposals on a team project, as diffs of the knowledge files, with the card and run each one came out of.',
  'project.sync':
    'An id this machine mints for the project, its name, the client it is billed to, its hourly rate and currency, its delivery flow, and whether it is a team project. Also the time of this sync, and the job types this build can run.',
  'scout.schedule':
    'The schedule you chose for a Scout source: the project and source, how often you asked Nolzu cloud to check it, whether you asked for a notification, and whether the source may make cards and start an assessment without asking. Nolzu cloud checks no source yet, so a schedule changes nothing today.',
  'report.weekly':
    'The week a report covers, the name of the project folder, and for each card of that week its key, title, pull request reference, minutes and cost.',
  'run.cost':
    "On a team project, to the team's hub: for each run, its card key, phase, model, start time, cost, duration and token counts. The team's hub never gets the run's question, verdict reason, failure reason, log or transcript.",
};

// What never goes to the hub, on any plan. It sits beside the list above because a list of what is
// sent is only worth reading next to the line that says where it stops.
//
// The hub and nothing wider. A person pushing a card's branch sends its code and its diff to their
// own git host, so the screen that draws this list names the hub in its heading and says so.
//
// The two Scout items are what `finding.results` leaves behind: a source's token sits in the OS
// keychain, and the lines a source reported stay in the local database.
//
// Plan steps, paths, tool activity, logs and discussion messages stay here, though the plain summary, a
// question's answers and the next start go up on `card.state`. The usage window is engine limit
// state, so it stays here too.
//
// The first seven are in the words and order the Data screen shows. The site's security page quotes
// this list, so a change here is a change there.
export const NEVER_SENT = [
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
] as const;

// The longest plain summary `card.state` carries. Enough for the phone's card page,
// and short of the whole write-up, which stays on the machine.
export const SUMMARY_CAP = 600;

/** A plain summary cut to `SUMMARY_CAP`, on a word and with an ellipsis, so the hub never gets half a word. */
export function capSummary(text: string): string {
  return cutOnWord(text, SUMMARY_CAP);
}

/**
 * The next start of a card on `card.state`: what the go button on the card page would run, and what
 * runs measured it at. The engine is the vendor and never the profile id, which holds a label the
 * person typed. Left off a card that offers no start.
 */
export interface CardStart {
  phase: string;
  engine: EngineName;
  model: string;
  effort: Effort;
  estimate?: Estimate;
}

// A `card.move` job. `note` comes only with a move back: Send back from the web or the phone. The
// machine stores it on the move, as the reason the trail shows, and starts nothing.
export interface CardMoveJob {
  key: string;
  to: string;
  note?: string;
}

/**
 * One message on the wire.
 *
 * The payload stays `unknown` here. The hub routes a job and stores it while the machine is offline,
 * and it never reads inside. Typing each payload in this file would copy the run, board, cost,
 * evidence, finding and knowledge shapes into the relay, and every change to one of them would then
 * be a protocol change. The two ends type their own payloads.
 */
export interface HubEnvelope<T extends HubMessageType = HubMessageType> {
  version: string;
  type: T;
  // Which job this belongs to. Job ids inside one hub start at 1 and rise one at a time, and the
  // client keeps the highest id it has finished, so a job redelivered after a crash is safe to drop.
  // A hub that numbers its first job 0 has that frame refused by `parseHubFrame`.
  //
  // A settings message belongs to no job and carries one anyway, from the same counter. The reason is
  // at the settings section below.
  job: number;
  // The project the frame is about, by its id in the machine's project registry. A frame the machine
  // sends names the project its data comes from, and the hub sends a job back with the same id. Left
  // out, the frame is about the first project, which is what every frame meant before a machine could
  // hold several, so a hub that never sends one keeps working.
  project?: number;
  payload: unknown;
}

// Everything a hub socket can carry: the two heartbeat words, and a message.
export type HubFrame = typeof PING | typeof PONG | HubEnvelope;

// Builds a message with the version this build speaks, so no caller writes the version itself.
// No project leaves the key out, so a frame about the first project reads the way it always did.
export const hubEnvelope = <T extends HubMessageType>(type: T, job: number, payload: unknown, project?: number): HubEnvelope<T> => ({
  version: HUB_PROTOCOL,
  type,
  job,
  ...(project === undefined ? {} : { project }),
  payload,
});

export function serializeHubFrame(frame: HubFrame): string {
  return typeof frame === 'string' ? frame : JSON.stringify(frame);
}

/**
 * Reads one frame off the socket, or throws.
 *
 * A frame this build cannot read is refused and never dropped. A dropped job is a card that sits in
 * `queued` for ever with nobody to ask, so the reader says what is wrong, the caller reports that
 * sentence and never acks the frame, and the hub keeps the job. The connection stays open: closing it
 * would cost the heartbeat and every other job on it, and the same frame would arrive again on the
 * next connect.
 *
 * Nothing from the frame is repeated in the message. These sentences reach a log, and the frame is not
 * ours to trust.
 */
export function parseHubFrame(text: string): HubFrame {
  if (text === PING) return PING;
  if (text === PONG) return PONG;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('A hub frame arrived that is not JSON.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('A hub frame arrived that is not a message object.');

  const { version, type, job, project } = raw as Record<string, unknown>;
  // One version exists. When a second one ships this reads a list, and the handshake is where a
  // version is turned down, with PROTOCOL_REFUSED.
  if (version !== HUB_PROTOCOL) throw new Error(`A hub frame speaks another protocol version. This side speaks ${HUB_PROTOCOL}.`);
  if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) throw new Error('A hub frame names a message type this build does not know.');
  if (typeof job !== 'number') throw new Error('A hub frame carries no job id. Every message belongs to a job.');
  // Split from the check above on purpose. A hub whose queue counts from 0 does send a job id, and
  // the missing-field sentence would send whoever reads the log to the sender's job field instead of
  // to the counter.
  if (!Number.isSafeInteger(job) || job < 1) throw new Error('A hub frame carries a job id that is not a whole number above zero. Job ids start at 1.');
  // A message with no payload key is a sender that left the field out, not a sender that meant
  // nothing. An ack says so with null.
  if (!('payload' in raw)) throw new Error('A hub frame carries no payload.');
  // Null reads as left out, like a hub that never heard of the field. Anything else has to be an id the
  // registry could hold, or a job could reach a project nobody meant.
  const named = project === undefined || project === null ? undefined : project;
  if (named !== undefined && (typeof named !== 'number' || !Number.isSafeInteger(named) || named < 1)) {
    throw new Error('A hub frame names a project that is not a whole number above zero.');
  }

  return { version, type: type as HubMessageType, job, ...(named === undefined ? {} : { project: named }), payload: (raw as { payload: unknown }).payload };
}

// The two settings messages, `project.sync` and `scout.schedule`.
//
// Both belong to no job and both carry a job id, from the same counter as every other frame. The
// alternative is a `job` that may be absent, and then every reader of `HubEnvelope` grows a branch for
// it: the runner acks by job id, the client keeps a high-water mark on it, and the hub routes on it.
// One shape on the wire costs the sender one number it already has, so that is the choice.
//
// The field names are the hub's own, so neither side translates a name. The hub reads these payloads again when it stores them, because a frame off a socket is never
// trusted by the side that writes the row. The two guards below are the sender's half: a payload the
// hub would turn down is caught on the machine, where the person can read the sentence.

/** The shortest and the longest Scout schedule. An interval of 0 is the off entry of the same list. */
export const MIN_SCOUT_INTERVAL_MINUTES = 15;
export const MAX_SCOUT_INTERVAL_MINUTES = 7 * 24 * 60;

/**
 * What one machine registers about a project.
 *
 * Only these fields travel. The project path, the git remote and the engine choices stay on the
 * machine, so nothing here needs them.
 */
export interface ProjectSync {
  // Minted on the machine. The hub keeps it, and every row it stores for the project carries it.
  id: string;
  name: string;
  flow: DeliveryFlow;
  clientName: string | null;
  // The two the margin report prices a run with. A rate of 0 is a client who is not billed by the
  // hour, which is why the guard takes 0 and not only a rate above it.
  hourlyRate: number | null;
  // Read back uppercase, the way the hub stores it. ISO 4217 codes are uppercase, and two cases of
  // one currency would read as two currencies in the margin report.
  currency: string | null;
  // When the machine last changed one of these fields. The hub converges on it, last write wins, so
  // the guard checks the shape as well as the parse.
  updatedAt: string;
  // The server message types this build can run, so the hub never queues a job that would sit in a
  // machine's queue and never drain. `HUB_PROTOCOL` cannot carry this: one version is negotiated at
  // the handshake and a version bump would refuse every machine on an older build. A machine that
  // sends nothing here is an older build, and the hub falls back to the five types every build
  // handles. The machine says what it handles rather than which build it is, so the hub needs no
  // table of versions to keep up to date.
  handles?: readonly string[];
  // True when this project belongs to a team. The machine says it and the hub does not guess: the hub
  // mints the team project id, and the machine is the side that knows which folder a person opened and
  // what they asked for. A machine on an older build sends no marker, which reads as a personal
  // project, so nothing a person already registered turns into a team project on its own.
  team: boolean;
}

/** One Scout source's schedule, as a person set it in the client. */
export interface ScoutSchedule {
  projectId: string;
  // The client's own source id, which is a whole number here. The hub stores it as text, because its
  // credential table keeps exporter names in the same column, so the hub keeps a thin wrapper around
  // this guard that writes `String(sourceId)`. This one cannot return the text itself: the machine
  // reads the number back into its own tables.
  sourceId: number;
  // 0 turns the schedule off. The hub drops the row, so nothing has to read a stored zero later.
  intervalMinutes: number;
  notify: boolean;
  // The person's two opt-ins for this source, named as the client's own `ScoutSource` names them, so
  // neither side translates a name. A scheduled check runs on the hub, so the hub is the side that has
  // to know whether it may make a card and start a read-only assessment on its own.
  //
  // Required here and optional on the wire. Every sender is a copy of one source row, so a sender that
  // forgets a flag sends an opt-in as off that the person gave, and the build has to be what catches
  // that. `readScoutSchedule` takes `unknown`, so a payload from a build before these two existed
  // still reads, with both flags off: both opt-ins are off until a person turns them on. A reader that refused such a payload would drop a paying person's
  // schedule on every connect, with nothing on their screen saying so.
  createCards: boolean;
  autoAssess: boolean;
}

// A text field, trimmed, or null when it was left out. A number or an object in a name field is a
// sender that meant something else, so it is refused and never stored.
function settingsText(value: unknown, subject: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${subject} carries a ${field} that is not text.`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// An optional flag: left out reads as off, and anything that is not a flag is refused. Null reads as
// absent too, because a sender that writes every field writes null for one it has no value for, and
// that is the same as leaving it out. The text 'false' is true to a bare `if`, so a flag read from
// text would turn an opt-in nobody gave into a yes.
function settingsFlag(value: unknown, subject: string, field: string): boolean {
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw new Error(`${subject} carries a ${field} flag that is neither true nor false.`);
  }
  return value === true;
}

function settingsObject(payload: unknown, subject: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error(`${subject} arrived that is not a message object.`);
  return payload as Record<string, unknown>;
}

/** Reads a `project.sync` payload, or throws a sentence naming the field that is wrong. */
export function readProjectSync(payload: unknown): ProjectSync {
  const subject = 'A project sync';
  const raw = settingsObject(payload, subject);

  const id = settingsText(raw.id, subject, 'project id');
  if (id === null) throw new Error(`${subject} carries no project id. The machine mints it and the hub keeps it.`);
  const name = settingsText(raw.name, subject, 'project name');
  if (name === null) throw new Error(`${subject} carries no project name.`);

  // A machine on an older version may still send direct-merge. That flow is gone, so it reads as a
  // pull request and the hub does not refuse the machine.
  if (raw.flow !== 'pull-request' && raw.flow !== 'direct-merge') throw new Error(`${subject} names a delivery flow that is not pull-request.`);
  const flow: DeliveryFlow = 'pull-request';

  let hourlyRate: number | null = null;
  const rate = raw.hourlyRate;
  if (rate !== undefined && rate !== null) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new Error(`${subject} carries an hourly rate that is not a number at or above zero.`);
    hourlyRate = rate;
  }

  // Uppercased here as well as on the hub, so the two guards really do give one answer. A machine
  // that sends 'eur' and one that sends 'EUR' have to land on the same code, or the margin report
  // counts one currency twice.
  const code = settingsText(raw.currency, subject, 'currency');
  if (code !== null && !/^[A-Za-z]{3}$/.test(code)) throw new Error(`${subject} carries a currency that is not a three-letter code, such as EUR.`);
  const currency = code === null ? null : code.toUpperCase();

  // `Date.parse` alone is too loose: it reads '2026' as the first of January. A clock that wide would
  // beat every later write on the hub. A zone is required, a Z or an offset, because a stamp without
  // one is read as local time and two machines an hour apart would then converge on the wrong write.
  const updatedAt = settingsText(raw.updatedAt, subject, 'write time');
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  if (updatedAt === null || !ISO.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error(`${subject} carries no write time. It is an ISO timestamp, such as 2026-09-28T12:00:00.000Z.`);
  }

  // Left out reads as a personal project, because a machine on an older build sends no marker at all. A
  // marker that is there and is not a flag is refused: the text 'false' is true to a bare `if`, and a
  // personal project read as a team one would put one person's cards on a team board.
  const team = raw.team;
  if (team !== undefined && team !== null && typeof team !== 'boolean') throw new Error(`${subject} carries a team marker that is neither true nor false.`);

  // Left out reads as an older build, so the hub falls back to the job types every build
  // handles. A list that is there and holds anything but text is refused rather than guessed at:
  // a hub that read a number as a message type would hold back every job for that machine and the
  // person would see a queue that never moves and no reason for it.
  const handles = raw.handles;
  if (handles !== undefined) {
    if (!Array.isArray(handles) || handles.some((one) => typeof one !== 'string')) {
      throw new Error(`${subject} carries a handles list that is not a list of message names.`);
    }
  }

  return {
    id,
    name,
    flow,
    clientName: settingsText(raw.clientName, subject, 'client name'),
    hourlyRate,
    currency,
    updatedAt,
    ...(handles === undefined ? {} : { handles: handles as readonly string[] }),
    team: team === true,
  };
}

/** Reads a `scout.schedule` payload, or throws a sentence naming the field that is wrong. */
export function readScoutSchedule(payload: unknown): ScoutSchedule {
  const subject = 'A Scout schedule';
  const raw = settingsObject(payload, subject);

  const projectId = settingsText(raw.projectId, subject, 'project id');
  if (projectId === null) throw new Error(`${subject} carries no project id. A schedule belongs to one project.`);

  const sourceId = raw.sourceId;
  if (typeof sourceId !== 'number' || !Number.isSafeInteger(sourceId) || sourceId < 1) {
    throw new Error(`${subject} carries no source id. It is the whole number the client keeps for the source.`);
  }

  const interval = raw.intervalMinutes;
  if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 0) throw new Error(`${subject} carries an interval that is not a whole number of minutes.`);
  if (interval !== 0 && (interval < MIN_SCOUT_INTERVAL_MINUTES || interval > MAX_SCOUT_INTERVAL_MINUTES)) {
    throw new Error(`${subject} asks for every ${interval} minutes. It is 0 to turn it off, or ${MIN_SCOUT_INTERVAL_MINUTES} to ${MAX_SCOUT_INTERVAL_MINUTES} minutes.`);
  }

  // Required, on both sides. The hub does not soften it: its own schedule check wraps this very
  // function, so a payload without this flag is refused there too and the schedule is dropped.
  // It stays required because a machine that leaves it out has forgotten it, and the person would
  // then get a schedule that never notifies anyone. The two flags below are optional for the opposite
  // reason: they did not exist in an older build, so refusing them would drop that machine's schedule.
  const notify = raw.notify;
  if (typeof notify !== 'boolean') throw new Error(`${subject} carries no notify flag. It is true or false.`);

  // Both optional on the wire, both off when they are not there. See the two fields on `ScoutSchedule`
  // for why they are not read the way the flag above is. This answer cannot tell a flag that was left
  // out from one that was sent as false, and off is the safe way round: an opt-in is lost that way and
  // never gained. A hub half that has to tell the two apart reads the raw payload beside this reader,
  // the way it reads the fields this guard drops.
  const createCards = settingsFlag(raw.createCards, subject, 'create cards');
  const autoAssess = settingsFlag(raw.autoAssess, subject, 'findings assessment');

  return { projectId, sourceId, intervalMinutes: interval, notify, createCards, autoAssess };
}

// The same shape `readProjectSync` holds a write time to, for the same reason.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// The account's projects, on `project.list`, from the personal hub to every machine of the account.
//
// The hub sends the whole list after a machine registers a project, so a machine learns about a project
// another machine added without asking. Only what a list draws travels: the id `project.sync` sent, the
// name, and when something last happened there. The hub works the time out from the board rows it
// holds, so nothing new leaves a machine for this.

/** One project of the account, as the hub lists it. */
export interface AccountProject {
  // The id the machine that registered the project minted. A machine finds its own project by it.
  id: string;
  name: string;
  // The newest card move or run of the project, or null where nothing has happened yet. Read into UTC
  // with a trailing Z, so it compares as text and draws with the UTC label the client puts on it.
  lastActivity: string | null;
}

/** One `project.list` payload: every project the account has, newest activity first. */
export interface ProjectList {
  projects: readonly AccountProject[];
}

/** Reads a `project.list` payload, or throws a sentence naming the field that is wrong. */
export function readProjectList(payload: unknown): ProjectList {
  const subject = 'A project list';
  const raw = settingsObject(payload, subject);
  // Empty is a real answer here and not a lost change: the list is the whole account every time.
  if (!Array.isArray(raw.projects)) throw new Error(`${subject} carries no list of projects.`);

  const projects = raw.projects.map((entry): AccountProject => {
    const one = settingsObject(entry, subject);
    const id = settingsText(one.id, subject, 'project id');
    if (id === null) throw new Error(`${subject} carries a project with no id.`);
    const name = settingsText(one.name, subject, 'project name');
    if (name === null) throw new Error(`${subject} carries a project with no name.`);
    const at = one.lastActivity ?? null;
    if (at !== null && (typeof at !== 'string' || !STAMP.test(at) || Number.isNaN(Date.parse(at)))) {
      throw new Error(`${subject} carries a last activity time that is not an ISO timestamp, such as 2026-09-28T12:00:00.000Z.`);
    }
    return { id, name, lastActivity: at === null ? null : new Date(at).toISOString() };
  });

  // A machine finds its own row by the id, so one id twice would leave it two rows to pick from.
  if (new Set(projects.map((one) => one.id)).size !== projects.length) throw new Error(`${subject} names the same project twice.`);
  return { projects };
}

// The Scout findings a check on this machine made, on `finding.results`.
//
// A check runs on the machine because the source's token stays in its keychain,
// and its findings go up to the personal hub so the cloud board and the phone can show them. The
// payload is the client's own `scout_findings` row, minus its local row id, so neither side translates
// a name.

/**
 * One finding, field by field, as it leaves the machine.
 *
 * - `sourceId`: the client's own `scout_sources.id`, a whole number, the same id `scout.schedule`
 *   sends. The hub stores it as text, the way it does there.
 * - `fingerprint`: the id one event keeps across its occurrences. With the project and the source it
 *   is the key, so the same finding sent twice is one row.
 * - `kind`: bug, regression, improvement or insight.
 * - `status`: one of the seven words of the client's column: new, assess, decide, started, done,
 *   parked or dismissed. A muted finding goes up as dismissed and is not left out, so the hub hides
 *   it as well. Any word is read, because the hub column has no check.
 * - `occurrences`: how often the event was met, over every check, a whole number at or above zero.
 * - `firstSeen`, `lastSeen`: ISO timestamps with a zone. The hub keeps epoch milliseconds.
 * - `location`: a file and a line, a route or a service. Empty where the source names none.
 * - `externalKey`: the ticket a ticket query found this finding in, or null.
 * - `cardKey`: the card a person started from it, or null.
 *
 * Never on the wire: the lines the source reported, the source's settings, its token and its cursor.
 * A pasted log line can hold a token, and no token goes to the cloud, so the hub shows a finding by
 * its kind and location.
 */
export interface FindingResult {
  sourceId: number;
  fingerprint: string;
  kind: string;
  status: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  location: string;
  externalKey: string | null;
  cardKey: string | null;
}

/**
 * One `finding.results` payload: the project the findings belong to, and the findings that changed
 * since this socket last sent them. At most 200 a frame. The first frames after a connect carry every
 * finding the machine holds, because the hub sends no marks to start from.
 */
export interface FindingResults {
  projectId: string;
  findings: readonly FindingResult[];
}

/** Reads a `finding.results` payload, or throws a sentence naming the field that is wrong. */
export function readFindingResults(payload: unknown): FindingResults {
  const subject = 'A finding result';
  const raw = settingsObject(payload, subject);

  const projectId = settingsText(raw.projectId, subject, 'project id');
  if (projectId === null) throw new Error(`${subject} carries no project id. Findings belong to one project.`);

  // An empty list is a sender that lost its rows on the way: nothing sends a frame with no change.
  const list = raw.findings;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${subject} carries no findings.`);

  const findings = list.map((entry): FindingResult => {
    const one = settingsObject(entry, subject);

    const sourceId = one.sourceId;
    if (typeof sourceId !== 'number' || !Number.isSafeInteger(sourceId) || sourceId < 1) {
      throw new Error(`${subject} carries no source id. It is the whole number the client keeps for the source.`);
    }
    const fingerprint = settingsText(one.fingerprint, subject, 'fingerprint');
    if (fingerprint === null) throw new Error(`${subject} carries no fingerprint. It is what makes one event one row.`);
    const kind = settingsText(one.kind, subject, 'kind');
    if (kind === null) throw new Error(`${subject} carries no kind.`);
    const status = settingsText(one.status, subject, 'status');
    if (status === null) throw new Error(`${subject} carries no status.`);

    const occurrences = one.occurrences;
    if (typeof occurrences !== 'number' || !Number.isSafeInteger(occurrences) || occurrences < 0) {
      throw new Error(`${subject} carries an occurrence count that is not a whole number at or above zero.`);
    }
    for (const field of ['firstSeen', 'lastSeen'] as const) {
      const at = one[field];
      if (typeof at !== 'string' || !STAMP.test(at) || Number.isNaN(Date.parse(at))) {
        throw new Error(`${subject} carries no ${field === 'firstSeen' ? 'first' : 'last'} seen time. It is an ISO timestamp, such as 2026-09-28T12:00:00.000Z.`);
      }
    }
    if (typeof one.location !== 'string') throw new Error(`${subject} carries a location that is not text.`);

    return {
      sourceId,
      fingerprint,
      kind,
      status,
      occurrences,
      firstSeen: one.firstSeen as string,
      lastSeen: one.lastSeen as string,
      location: one.location as string,
      externalKey: settingsText(one.externalKey, subject, 'ticket key'),
      cardKey: settingsText(one.cardKey, subject, 'card key'),
    };
  });

  return { projectId, findings };
}

// The state a card's pull request is in, as `pull.state` on `card.state`. The hub guards the rest of
// that payload itself, beside the row it writes. This one word lives here because the hub writes its
// merge record from it, so both sides have to spell `merged` the same way.
//
// Optional on the wire. A machine on an older build sends no state, and so does a card that does not
// know it yet, such as one added by number and not read from its repository since. Both read as null.
export const PULL_STATES = ['open', 'closed', 'merged'] as const;

export type PullState = (typeof PULL_STATES)[number];

/** Reads `pull.state` on a `card.state` card, or throws a sentence when it is a word the hub does not know. */
export function readPullState(value: unknown): PullState | null {
  if (value === undefined || value === null) return null;
  // Refused and not kept as it came. A misspelt `merged` kept as text would never write the merge
  // record, and nothing would say why.
  if (!(PULL_STATES as readonly unknown[]).includes(value)) {
    throw new Error('A board sync carries a pull request state the hub does not know. It is open, closed or merged.');
  }
  return value as PullState;
}

// The team messages, in both directions.
//
// A team hub holds every project of one team, so every frame here names the team project it belongs to.
// The author of a proposal and the holder of a claim are not fields: the hub reads the member off the
// connection, which is the one side a frame cannot lie about.
//
// Only the proposal and the run cost have a reader. The hub guards the other payloads beside the row
// it writes, the way it guards a card. These interfaces are here because this package is published and
// both sides build against it, so a field renamed later costs a release on both sides.

/** One knowledge file a run changed, as a diff against the file the folder holds. */
export interface KnowledgeProposalFile {
  // The knowledge file the diff is against, as a path inside the knowledge folder.
  path: string;
  diff: string;
}

/**
 * What a machine proposes to a team's knowledge folder, on `knowledge.proposals`.
 *
 * One proposal is one run and not one file, because one run is one commit. The machine keeps a run's
 * writing aside as a whole, `HeldKnowledge` in `@nolzu/runner`, and the approval path applies the
 * whole run under one run id, `approveKnowledge` in the client. A proposal per file would let a
 * reviewer approve one file of a run and get every other file of that run committed with it, which
 * is the one thing knowledge review exists to stop. So the files travel together and are approved
 * together, and `ApprovedProposal` names the run alone.
 */
export interface KnowledgeProposal {
  teamProjectId: string;
  // The card and the run the change came out of. The run is what the machine applies the change under
  // when the proposal comes back approved, so a proposal without one cannot be committed later.
  cardKey: string;
  runId: number;
  files: readonly KnowledgeProposalFile[];
}

/** What the hub tells a machine about a card it does not hold, on `claim.answer`. */
export interface ClaimAnswer {
  teamProjectId: string;
  cardKey: string;
  granted: boolean;
  // Who holds the card when the claim was refused, and null when it was granted.
  holder: string | null;
}

/**
 * An approved proposal, sent back to the machine that wrote it on `knowledge.commit`.
 *
 * The run and no file path. A proposal carries a whole run's files and is approved as one, and the
 * machine commits a run as one, so there is no half of a run for this frame to name.
 */
export interface ApprovedProposal {
  teamProjectId: string;
  cardKey: string;
  runId: number;
}

/** The team project id the hub minted, written onto a machine on `project.join`. */
export interface ProjectJoin {
  teamProjectId: string;
}

/** Reads a `knowledge.proposals` payload, or throws a sentence naming the field that is wrong. */
export function readKnowledgeProposal(payload: unknown): KnowledgeProposal {
  const subject = 'A knowledge proposal';
  const raw = settingsObject(payload, subject);

  const teamProjectId = settingsText(raw.teamProjectId, subject, 'team project id');
  if (teamProjectId === null) throw new Error(`${subject} carries no team project id. A proposal belongs to one team project.`);
  const cardKey = settingsText(raw.cardKey, subject, 'card key');
  if (cardKey === null) throw new Error(`${subject} carries no card key. A proposal is read beside the card it came out of.`);

  const runId = raw.runId;
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1) {
    throw new Error(`${subject} carries no run id. It is the whole number the machine keeps for the run.`);
  }

  // A run that wrote nothing is held aside by nothing, so it has no proposal to send. An empty list
  // here is a sender that lost the change on the way, and a reviewer would get an empty screen.
  const list = raw.files;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${subject} carries no files. One proposal is one run, and every file that run wrote travels in it.`);
  }

  const files = list.map((entry): KnowledgeProposalFile => {
    const file = settingsObject(entry, `${subject} file`);

    const path = settingsText(file.path, subject, 'file path');
    if (path === null) throw new Error(`${subject} carries no file path. It names the knowledge file the diff is against.`);

    // Not trimmed, unlike every text field above. Leading and trailing whitespace is part of a patch,
    // and a trimmed diff applies differently or not at all. Blank is still refused: a file that
    // proposes nothing is a sender that lost the change on the way.
    const diff = file.diff;
    if (typeof diff !== 'string') throw new Error(`${subject} carries a diff that is not text.`);
    if (diff.trim() === '') throw new Error(`${subject} carries an empty diff. There is nothing to review.`);

    return { path, diff };
  });

  // Two diffs against one path would apply twice or fight each other, and the reviewer would see the
  // same file listed twice with no way to tell which one the folder ends up with.
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) throw new Error(`${subject} names the same file twice. One run writes one diff per file.`);

  return { teamProjectId, cardKey, runId, files };
}

/**
 * One team run's cost, as it leaves the machine on `run.cost`.
 *
 * Built field by field from the run row and nothing else. A run row also holds the question a card
 * waits on, the QA verdict reason, the failure reason, the log path and the session id, and none of
 * them may reach the team, so none of them has a field here. The engine profile stays too: its id is
 * made from a label the person typed. Only cost, tokens and model go. The cost, the
 * duration and the token counts are `SpendRun`, so the team report adds them up with `spendOf`, the
 * way the personal one does.
 *
 * - `runId`: the machine's own run id. Two machines count from 1 each, so the hub keys a row on the
 *   device as well.
 * - `startedAt`: an ISO timestamp, read into UTC with a trailing Z, because the report cuts its UTC
 *   month out of the text. A run that never started is not sent.
 */
export interface RunCost extends SpendRun {
  runId: number;
  cardKey: string;
  phase: string;
  model: string | null;
  startedAt: string;
}

/**
 * One `run.cost` payload: the team project, and the runs whose cost changed since this socket last
 * sent them. At most 200 a frame. The first frames after a connect carry every run the machine holds.
 */
export interface RunCosts {
  teamProjectId: string;
  runs: readonly RunCost[];
}

// Null, or a whole number at or above zero.
const count = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/** Reads a `run.cost` payload, or throws a sentence naming the field that is wrong. */
export function readRunCosts(payload: unknown): RunCosts {
  const subject = 'A run cost';
  const raw = settingsObject(payload, subject);

  const teamProjectId = settingsText(raw.teamProjectId, subject, 'team project id');
  if (teamProjectId === null) throw new Error(`${subject} carries no team project id. A run belongs to one team project.`);

  // Sent only when a run changed, so an empty list is a sender that lost its rows on the way.
  const list = raw.runs;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${subject} carries no runs.`);

  const runs = list.map((entry): RunCost => {
    const one = settingsObject(entry, subject);

    const runId = one.runId;
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1) {
      throw new Error(`${subject} carries no run id. It is the whole number the machine keeps for the run.`);
    }
    const cardKey = settingsText(one.cardKey, subject, 'card key');
    if (cardKey === null) throw new Error(`${subject} carries no card key.`);
    const phase = settingsText(one.phase, subject, 'phase');
    if (phase === null) throw new Error(`${subject} carries no phase.`);

    const startedAt = one.startedAt;
    if (startedAt === undefined || startedAt === null) throw new Error(`${subject} carries no start time.`);
    if (typeof startedAt !== 'string' || !STAMP.test(startedAt) || Number.isNaN(Date.parse(startedAt))) {
      throw new Error(`${subject} carries a start time that is not an ISO timestamp, such as 2026-09-28T12:00:00.000Z.`);
    }

    const costUsd = one.costUsd ?? null;
    if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) {
      throw new Error(`${subject} carries a cost that is not a number at or above zero.`);
    }
    const durationMs = one.durationMs ?? null;
    if (!count(durationMs)) throw new Error(`${subject} carries a duration that is not a whole number of milliseconds.`);

    let tokens: RunCost['tokens'] = null;
    if (one.tokens !== undefined && one.tokens !== null) {
      const { input, output, cacheRead, cacheCreation } = settingsObject(one.tokens, subject);
      if (![input, output, cacheRead, cacheCreation].every((value) => value !== null && count(value))) {
        throw new Error(`${subject} carries token counts that are not whole numbers at or above zero.`);
      }
      tokens = { input, output, cacheRead, cacheCreation } as NonNullable<RunCost['tokens']>;
    }

    return {
      runId,
      cardKey,
      phase,
      model: settingsText(one.model, subject, 'model'),
      startedAt: new Date(startedAt).toISOString(),
      costUsd: costUsd as number | null,
      durationMs: durationMs as number | null,
      tokens,
    };
  });

  return { teamProjectId, runs };
}
