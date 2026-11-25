import { isDeliveryPhase, type ScoutGroup } from '@nolzu/core';
import { getSetting, knowledgeChangesOfRun, saveScoutFindings, scoutFindingOf, scoutSource, writeSetting } from '@nolzu/core/node';
import { type HubEnvelope, isDay, readProjectList, type RunnerMessageType, SCOUT_AND_EVIDENCE, type ServerMessageType, weekOf } from '@nolzu/protocol';
import { moveBackWithNote, moveTo } from '../routes/api/board/writes.ts';
import { knowledgeLane } from './knowledge-page.ts';
import { approveKnowledge } from './knowledge-review.ts';
import type { Loop } from './loop.ts';
import { weeklyReportFor } from './weekly-report.ts';

// The nine jobs the hub sends. Four map onto the writer a click already reaches: `run.start` onto
// `Loop.start`, `question.answer` onto `Loop.answer`, `card.move` onto `moveTo` behind the board route
// (with a note, `moveBackWithNote`), and `scout.assess` onto `saveScoutFindings` and then `Loop.assess`.
// No branch writes SQL of its own, so a rule the board or a local check enforces holds for a job from a
// phone too.
//
// `report.write` is the one job no click reaches. A tick on the hub queues it once a week, this machine
// reads its own rows and answers with a `report.weekly` frame, so the text is written where the rows
// are and the hub stores what comes back. It is also the one job that answers with a project id, and
// the id is the one the hub that asked minted: `projectKey` below picks it off the mark.
//
// The last three are the team jobs. `project.join` stores the id the team hub minted, because that id
// is what makes this machine dial the team hub at all. `knowledge.commit` maps onto `approveKnowledge`,
// the writer the Approve button reaches. `claim.answer` is taken and not run yet, which the branch at
// the end of `run` says in one line.
//
// `project.list` is the personal hub's list of every project of the account. It is stored and runs
// nothing, so `/api/projects` can answer the paid panel with the projects other machines registered.
//
// A job can arrive twice. The hub keeps a job until the runner acks it, so a crash between the two
// sends it again on the next connect. The client keeps the highest job id it has finished per hub, and
// a job at or below that hub's mark is dropped here and acked by the socket.

// How a job answers the hub. It is handed in rather than imported, because `hub-link.ts` imports this
// file and a job reaching back into it would close the circle.
type Send = (type: RunnerMessageType, payload: unknown) => boolean;

// Which hub's high-water mark a job is measured against. One setting per socket, because each hub
// numbers its jobs from 1: `hubJobDone` on the machine, and `teamHubJobDone` in each team project, which
// has a team socket of its own. It also says which hub sent the job, which is the only thing a job has to
// tell the two apart: the frame carries no hub name.
export type HubJobMark = 'hubJobDone' | 'teamHubJobDone';

// The project id the hub that sent a job keys its rows on. The team hub minted the team project id and
// has never seen the id this machine minted for itself, so a report answered with the wrong one of the
// two is filed under a project that hub does not have.
const projectKey = (mark: HubJobMark): 'projectId' | 'teamProjectId' => (mark === 'teamHubJobDone' ? 'teamProjectId' : 'projectId');

const fields = (payload: unknown): Record<string, unknown> =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};

// Nothing from the payload is repeated in the sentence. These reach a log, and a frame off the wire is
// not ours to trust.
const textOf = (payload: unknown, name: string, type: string): string => {
  const value = fields(payload)[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`A ${type} job from the hub carries no ${name}.`);
  return value;
};

// The finding a `scout.assess` job carries, as the group a local check writes.
//
// The job carries the finding and not an id. `assessKey` is built from the id of a row in this
// machine's own database, and a finding the hub met first has no such row here, so the machine writes
// its own row and then runs under its own key.
//
// It becomes a `ScoutGroup` so the finding goes through `saveScoutFindings`, the one writer a local
// check uses. That writer keys on `(source_id, fingerprint)`, so an event met by both routes folds
// onto one row instead of drawing twice on the findings screen.
//
// The fingerprint travels with the job and is not built again here. The error type is not in the
// payload, so a second guess at the id would fold onto nothing.
//
// Two fields the hub sends are dropped. `firstSeen` and `lastSeen` are the hub's clock, and the
// writer stamps both from sqlite's own, so the row says when this machine wrote it. Only `location`
// is optional: the column is empty by default, and a source that names no place sends none.
//
// Limit: no ticket key. `ticketKeyOf` reads the ticket's own id off the item, the hub sends no id,
// and the tail of a fingerprint cannot be told from a hash. So a ticket finding the hub met first
// starts as a local card. Put the key in the payload the day a ticket source is checked in the cloud.
const findingOf = (payload: unknown, sourceKind: string, type: string): ScoutGroup => {
  // `fields` answers an empty record for anything that is not a plain object, and an object with no
  // field in it carries no finding either, so one check covers both.
  const finding = fields(fields(payload).finding);
  if (Object.keys(finding).length === 0) throw new Error(`A ${type} job from the hub carries no finding.`);

  // What the check that queued the job counted, and a count a row can hold. Every later check adds to
  // that column, and node:sqlite hands a whole number over 2^53 back as an error and not as a number:
  // one count that large makes the row unreadable, every read of the findings table throws from then
  // on, and the findings screen stops loading. A billion is far past any real count and leaves the
  // room those additions need.
  const occurrences = finding.occurrences;
  if (typeof occurrences !== 'number' || !Number.isInteger(occurrences) || occurrences < 1 || occurrences > 1_000_000_000) {
    throw new Error(`A ${type} job from the hub names no occurrence count a finding can hold.`);
  }

  const location = typeof finding.location === 'string' ? finding.location : '';
  const occurrence = (message: string) => ({ sourceKind, errorType: '', message, location });
  return {
    fingerprint: textOf(finding, 'fingerprint', type),
    count: occurrences,
    first: occurrence(textOf(finding, 'firstMessage', type)),
    last: occurrence(textOf(finding, 'lastMessage', type)),
  };
};

async function run(live: Loop, message: HubEnvelope<ServerMessageType>, send: Send, mark: HubJobMark): Promise<void> {
  const payload = message.payload;

  if (message.type === 'run.start') {
    const key = textOf(payload, 'key', message.type);
    const phase = fields(payload).phase;
    // The phase rule is the board's. A phase that starts no run is refused here rather than by a
    // sentence about a missing model further in.
    if (typeof phase !== 'string' || !isDeliveryPhase(phase)) throw new Error('A run.start job from the hub names no delivery phase.');
    // False means the card was marked failed with the reason, which the board shows and the report
    // back to the hub carries. There is nothing to add to it here.
    live.start(key, phase);
    return;
  }

  if (message.type === 'question.answer') {
    live.answer(textOf(payload, 'key', message.type), textOf(payload, 'answer', message.type));
    return;
  }

  if (message.type === 'card.move') {
    // The same writer the drag uses, so a job meets the same checks and starts the same run. A note is
    // Send back from the web or the phone (`CardMoveJob`): a move back that stores it and starts nothing.
    const key = textOf(payload, 'key', message.type);
    const to = textOf(payload, 'to', message.type);
    const note = fields(payload).note;
    if (note !== undefined && note !== null && typeof note !== 'string') throw new Error(`A ${message.type} job from the hub carries a note that is not text.`);
    const refused = typeof note === 'string' ? await moveBackWithNote(live, key, to, note) : await moveTo(live, key, to);
    if (refused !== null) throw new Error(refused.message);
    return;
  }

  if (message.type === 'scout.assess') {
    // A job for another project writes nothing. The hub keys its rows on the id this machine minted
    // and sent, so a payload naming another id is not about this project, and a machine registered
    // nowhere holds null here and refuses every one of these.
    const projectId = textOf(payload, 'projectId', message.type);
    if (projectId !== getSetting(live.db, projectKey(mark))) {
      throw new Error(`A ${message.type} job from the hub names another project, so no finding was stored.`);
    }
    // The hub keys a source by this machine's own `scout_sources.id` and sends it as text. The row is
    // read before the write rather than left to the foreign key, whose own words name nothing a
    // person can act on, and a source that is gone took its findings with it.
    const sourceId = Number(textOf(payload, 'sourceId', message.type));
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new Error(`A ${message.type} job from the hub names no source.`);
    const source = scoutSource(live.db, sourceId);
    if (source === null) throw new Error(`A ${message.type} job from the hub names a source this machine does not have.`);

    const group = findingOf(payload, source.kind, message.type);
    // The row this machine already holds for the same event, read before the write, because what the
    // job may change depends on whether there is one.
    const held = scoutFindingOf(live.db, sourceId, group.fingerprint);
    // Stored before the run starts, and kept when the run below throws. A finding the hub's own check
    // met is on no other screen of this machine, so dropping it would drop the event.
    saveScoutFindings(live.db, sourceId, [
      {
        ...group,
        // The hub's count opens a row and never adds to one. Each check counts against its own cursor,
        // the hub keeps its cursor in its own table and this machine keeps its own, and nothing carries
        // one to the other, so the two windows overlap: the hub's first check of a source this machine
        // has been checking reports the same occurrences again. Adding them would say an event happened
        // twice as often as it did, on the finding detail and on the card a person starts, and the
        // column is only ever added to, so it would never come back down. A row that is already here
        // keeps the number its own cursor owns.
        count: held === null ? group.count : 0,
        // A place the job does not name may not blank one this machine stored. The writer takes the new
        // location as it is, the way it takes the newest line, so only an absent one falls back. This
        // is what `external_key` on the same statement is already coalesced for.
        last: { ...group.last, location: group.last.location === '' && held !== null ? held.location : group.last.location },
      },
    ]);
    // Only a row this job opened. The hub queues a job for a finding that is new in the hub's own
    // table, which says nothing about this machine: the hub's first check of a source opens every
    // finding this machine has been holding, and assessing those would spend the person's engine
    // budget on findings they had left alone. A redelivered job and a finding a person already moved
    // are the same case and are left alone too, which is the rule `assessScoutFinding` holds as well.
    if (held !== null) return;
    const found = scoutFindingOf(live.db, sourceId, group.fingerprint);
    // The save opened the row, so this is unreachable: only a dismissed row is refused, and a row that
    // was not here is not dismissed. It is named rather than ignored, because the id is what the
    // assessment runs under.
    if (found === null) throw new Error(`A ${message.type} job stored its finding and could not read it back.`);
    live.assess(found.id);
    return;
  }

  if (message.type === 'report.write') {
    // The weekly report reads Evidence, which waits for a later version, so the job is taken and
    // answered with nothing.
    if (!SCOUT_AND_EVIDENCE) return;
    // The week travels with the job, so a job that waited in the queue reports the week the hub asked
    // for and not the week this machine woke up in.
    const week = fields(payload).week;
    if (typeof week !== 'string' || !isDay(week)) throw new Error('A report.write job from the hub names no week.');
    // The hub keys the report on the project row `project.sync` wrote, and the report goes back on the
    // socket the job came in on, so the id has to be the one that hub knows. A machine that has
    // registered nothing has no row to key it to, and one report with no project is worse than none.
    const projectId = getSetting(live.db, projectKey(mark));
    if (projectId === null) throw new Error('A report.write job arrived before this machine registered its project with the hub.');
    if (!send('report.weekly', { projectId, week: weekOf(week), text: weeklyReportFor(live.db, week) })) {
      throw new Error('The weekly report could not be sent, because the link to the hub is not open.');
    }
    return;
  }

  if (message.type === 'project.join') {
    // The id the team hub minted, stored rather than only reported. It is the one thing that says this
    // machine works on a shared board, so `hub-link.ts` reads it to decide whether to dial the team hub,
    // and a job that only said a line would leave the machine in a team the runner never reaches.
    //
    // Checked here rather than by the setting's own rule, so the sentence names the job and not a stored
    // value a person never typed.
    const teamProjectId = fields(payload).teamProjectId;
    if (typeof teamProjectId !== 'string' || teamProjectId.trim() === '') throw new Error('A project.join job from the hub names no team project.');
    // A machine that joins another team meets another team hub, and that hub numbers its jobs from 1.
    // The mark this machine holds was counted on the hub it is leaving, so every job the new hub sends
    // at or below it would be dropped and acked, and acked work is gone. The mark goes back to zero
    // with the id.
    //
    // The mark is this project's, because each team project has a socket of its own.
    //
    // Limit: zero and not a mark per hub. Moving between two projects of one team gives up the guard
    // against one redelivered job for the length of one reset. Running a job twice is recoverable and a
    // dropped job is not. Key the mark on the hub the id names when the team hub starts numbering per
    // device.
    if (getSetting(live.db, 'teamProjectId') !== teamProjectId) writeSetting(live.db, 'teamHubJobDone', 0);
    writeSetting(live.db, 'teamProjectId', teamProjectId);
    return;
  }

  if (message.type === 'knowledge.commit') {
    // The team approved a proposal this machine sent, and the commit goes through the same Approve the
    // Knowledge screen uses, so a team commit and a personal one are the same commit with the same
    // message. The hub never sends the diff back: the kept copy on this machine is what gets written.
    //
    // Only the team hub approves proposals. The personal hub was never sent the team id, and this
    // keeps it that way if it ever learns one.
    if (mark !== 'teamHubJobDone') throw new Error(`A ${message.type} job came from the personal hub, and only the team hub sends one. Nothing was committed.`);
    // A run id is a counter in this machine's own database, so a job for another team project names a
    // run of the same number that has nothing to do with it.
    const teamProjectId = textOf(payload, 'teamProjectId', message.type);
    if (teamProjectId !== getSetting(live.db, 'teamProjectId')) {
      throw new Error(`A ${message.type} job from the hub names another team project, so nothing was committed.`);
    }
    const cardKey = textOf(payload, 'cardKey', message.type);
    const runId = fields(payload).runId;
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1) throw new Error(`A ${message.type} job from the hub names no run.`);
    const rows = knowledgeChangesOfRun(live.db, runId);
    // The sentences below name the card and run from this machine's rows, never the payload's.
    if (rows.length > 0 && rows[0]?.cardKey !== cardKey) {
      throw new Error(`A ${message.type} job names run ${runId}, and that run here belongs to another card. Nothing was committed.`);
    }
    // A job that runs twice meets rows already applied. The mark stops a redelivered job at the door,
    // and this is the case it misses: the commit landed and the process stopped before the mark moved.
    if (rows.length > 0 && rows.every((row) => row.status === 'applied')) return;
    // Limit: a throw here loses the job, because the socket acked it already. The change stays
    // pending on the Knowledge screen, so a person can still approve it by hand, and a busy knowledge
    // lane is the likely cause. Retrying needs an ack that means done, which `takeHubJob` names.
    const answer = await approveKnowledge(live.db, { dataDir: live.dataDir, runId, busy: knowledgeLane(live.snapshot()) });
    if (!answer.ok) throw new Error(`The team approved the knowledge change of ${rows[0]?.cardKey ?? 'a card'} run ${runId}, and it was not committed. ${answer.message}`);
    live.reviewAnswered();
    return;
  }

  if (message.type === 'project.list') {
    // The team hub lists the team's projects on screens of its own, and a team list stored here would
    // put another person's projects on this machine's page as if they were the account's.
    if (mark !== 'hubJobDone') throw new Error(`A ${message.type} job came from the team hub, and only your own hub sends one. Nothing was stored.`);
    writeSetting(live.db, 'accountProjects', readProjectList(payload).projects);
    return;
  }

  // `claim.answer` is taken and not run yet. It gets its branch and its work as its feature is built: it
  // carries a `ClaimAnswer` and tells the board whether this machine may run the card and who holds it.
  //
  // It says one line and returns. Neither this nor a throw keeps the job: the socket acks before the
  // work starts, so the hub has dropped its queue row either way and will not send the job again. The
  // line is all this build can give. Returning was picked over throwing because a throw is how this
  // file says a job was wrong, and one from a newer hub is not wrong, only early.
  if (message.type === 'claim.answer') {
    console.error(`A ${message.type} job arrived from the hub. This build takes it and does not run it yet.`);
    return;
  }

  // A tenth job type in the protocol package breaks the build here rather than falling into the branch
  // above it, which is what the assignment is for.
  const unknown: never = message.type;
  throw new Error(`A job of the type ${String(unknown)} is one this build does not run.`);
}

/**
 * Take one job from the hub, or throw the sentence that says why it could not be taken.
 *
 * A job at or below the high-water mark has run already and is dropped. The socket acks it all the
 * same, so the hub drops its queue row and stops sending it.
 *
 * The mark moves after the work, not before it, so it holds what this machine has finished. A crash
 * between the work and the mark is the one case a redelivered job runs twice. The case the mark is here
 * for is an ack the hub never got, from a socket that died on the way: the hub keeps the row and sends
 * the job again on the next connect.
 *
 * One mark per hub, named by the caller. A job id counts from 1 inside each hub, so a machine that has
 * finished 57 jobs on one hub would drop the other hub's first 57 without running them and ack every
 * one. The socket a job came in on is what picks the mark, and the same socket is handed `send`, so an
 * ack goes back to the hub that asked and never to the other one. A mark is only safe while the counter
 * it tracks keeps growing, so the `project.join` branch above puts the team mark back to zero when the
 * machine joins another team and meets another counter.
 *
 * The ack is on the wire before the work starts. `connectHub` acks as soon as the reader returns, and
 * the reader in `hub-link.ts` only adds the job to a queue. So a job the hub has already dropped is lost
 * if the process stops before that job's turn comes. Making the ack mean done needs `connectHub` to
 * await the reader, which changes what the hub is allowed to delete a queue row on.
 */
export async function takeHubJob(live: Loop, message: HubEnvelope<ServerMessageType>, send: Send, mark: HubJobMark): Promise<void> {
  if (message.job <= getSetting(live.db, mark)) return;
  await run(live, message, send, mark);
  // The highest id finished, not the last one. `hub-link.ts` runs jobs one at a time, so today the two
  // are the same value. They stop being the same the moment anything calls this without that chain: two
  // jobs finishing out of order would write the lower id last, and the hub would then send the higher
  // one again on the next connect and run it twice.
  writeSetting(live.db, mark, Math.max(message.job, getSetting(live.db, mark)));
}
