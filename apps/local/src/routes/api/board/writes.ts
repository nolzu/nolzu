import { phaseOnEnter } from '@nolzu/core';
import { ENDED, moveCard, readRun, setMinimized } from '@nolzu/core/node';
import { waitsOn } from '../../../lib/gate.ts';
import { unsentWork } from '../../../lib/checkout.ts';
import type { Loop } from '../../../lib/loop.ts';
import { learnFirst } from '../../../lib/setup.ts';
import { answerAgain, answerFirst, stackAnswered } from '../../../lib/qa-setup.ts';

const said = (message: string, status: number): Response =>
  new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } });

const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

const body = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// Answers as soon as the job is queued. Waiting for the run would make the board follow the click
// for as long as the agent takes, and the stream is what tells the person what happened next.
export async function move(live: Loop, request: Request): Promise<Response> {
  const asked = await body(request);
  const key = asked.key;
  const to = asked.to;
  if (typeof key !== 'string' || typeof to !== 'string') {
    return said('A move needs a card key and a stage to move it to.', 400);
  }
  // Accept anyway on a QA FAIL sends one line of reason for the trail. Sent empty, it would put a move
  // there that says nothing, so it is refused. Kept to one line, as the trail draws it.
  const reason = asked.reason === undefined ? null : typeof asked.reason === 'string' ? asked.reason.replace(/\s+/g, ' ').trim() : '';
  if (reason === '') return said(`Write one line on why ${key} goes on, for the trail. The reviewer reads it there.`, 400);
  if (reason !== null && reason.length > REASON_LIMIT) return said(`The reason is over ${REASON_LIMIT} characters. One line is enough.`, 400);

  // `stop` is Peek's Move back on a running card, which stops the run first.
  const refused = asked.stop === true ? await stopThenMove(live, key, to) : await moveTo(live, key, to, 'you', reason);
  return refused === null ? ok() : said(refused.message, refused.status);
}

// One line in the trail, and room for a sentence or two.
const REASON_LIMIT = 500;

// How long a move back waits for the run it stopped to end. An engine ends soon after its stop, so
// this bounds only one that does not.
const STOP_WAIT_MS = 30_000;

/**
 * A move back of a card whose run is in the queue: stop the run, wait until it has left the queue and
 * its row has ended, then move the card through `moveTo`, as a drop on that column does.
 *
 * The run leaves the queue only after its row is written and the card is let go, so a move sent then
 * meets an idle card. Sent at once it would meet a card that still says running and be refused. A
 * card that runs nothing moves at once. Null when the card moved, and the sentence when it did not.
 */
export async function stopThenMove(live: Loop, key: string, to: string, waitMs = STOP_WAIT_MS): Promise<{ status: number; message: string } | null> {
  const queued = () => {
    const queue = live.scheduler.queue();
    return [...queue.running, ...queue.waiting].find((job) => job.cardKey === key);
  };
  const job = queued();
  const board = live.boardOf(key);
  const at = (id: string) => board.stages.findIndex((stage) => stage.id === id);
  const from = (live.db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string } | undefined)?.stage ?? '';
  const back = at(to) >= 0 && at(to) < at(from);
  if (job === undefined) {
    // A wrap-up waiting for a knowledge review is in no queue, so its row is what is stopped.
    const waiting = live.db.prepare("SELECT id FROM runs WHERE card_key = ? AND state = 'waiting_review' ORDER BY id DESC LIMIT 1").get(key) as { id: number } | undefined;
    if (waiting !== undefined && back) live.stop(waiting.id);
    return moveTo(live, key, to);
  }

  // A stop is the way back and never the way on: a move forward starts a run of its own.
  if (!back) {
    return { status: 409, message: `${key} is running, and only a move back stops its run first. Stop it, or wait for it to end.` };
  }

  const over = () => queued()?.runId !== job.runId && (ENDED as readonly (string | null)[]).includes(readRun(live.db, job.runId)?.state ?? null);
  const ended = await new Promise<boolean>((resolve) => {
    const finish = (done: boolean) => {
      leave();
      clearTimeout(timer);
      resolve(done);
    };
    // Listening before the stop, so an end that comes inside the stop itself is heard. The move goes
    // on after this promise settles, which is after the scheduler finished the step that told it.
    const leave = live.onChange(() => {
      if (over()) finish(true);
    });
    const timer = setTimeout(() => finish(false), waitMs);
    live.stop(job.runId);
    if (over()) finish(true);
  });
  if (!ended) {
    const label = board.stages.find((stage) => stage.id === from)?.label ?? from;
    return { status: 409, message: `${key} did not stop in time, so it stayed in ${label}. Stop it again, then move it back.` };
  }
  return moveTo(live, key, to);
}

/**
 * The move itself, over parsed arguments, with the route above as its wrapper.
 *
 * Null when the move went through, and the sentence with its status when it did not. The hub adapter
 * calls this, so a move asked for from a phone reaches the same writer as a drag and there is no
 * second path to keep in step. The chain a person allowed in advance calls it too, as "auto".
 */
export async function moveTo(live: Loop, key: string, to: string, who: 'you' | 'auto' = 'you', reason: string | null = null): Promise<{ status: number; message: string } | null> {
  // Asks git, so it goes before the reads below, which run with no wait up to `moveCard`.
  const unsent = await unsentRefusal(live, key, to);
  if (unsent !== null) return { status: 409, message: unsent };

  // The card's own board, because a stage id repeats across boards and the Delivery list would
  // answer about another board's columns.
  const board = live.boardOf(key);

  // QA never starts before the project said how QA gets the app, whoever sends the move. Read with no
  // wait before `moveCard`, whose check and write run with no wait either, so no other move comes in
  // between in this process.
  const from = (live.db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string } | undefined)?.stage;
  const starts = from === undefined ? undefined : phaseOnEnter(board, from, to);
  if (starts === 'qa' && !stackAnswered(live.db, key)) return { status: 409, message: answerFirst(key) };
  // A question marked `blocks: yes` makes the next phase a choice first: the default or an answer,
  // given on the Overview. Refused here, so a move from the phone or
  // the chain meets it too. A move that starts nothing passes.
  const waits = starts === undefined ? null : waitsOn(live.db, key, starts);
  if (waits !== null) return { status: 409, message: waits };
  // The first run waits for Learn your repositories or the person's "I will write it myself".
  const learn = starts === undefined ? null : learnFirst(live.db, key);
  if (learn !== null) return { status: 409, message: learn };

  // Set when the failure came from starting the run, which happens after the move has committed.
  let starting = false;
  try {
    await moveCard(live.db, board, key, to, (card, phase) => {
      starting = true;
      live.start(card, phase);
      starting = false;
    }, who, reason);
    // A move into a stage that starts no phase touches the scheduler not at all, and the scheduler
    // is what tells the open boards. Without this every move back, and every move into a stage that
    // starts nothing, changed the database and told nobody watching.
    live.changed();
    return null;
  } catch (error) {
    if (starting) {
      // The move is already committed and core has marked the card failed, so the board has to hear
      // about it. Answering 409 here would tell a person their card stayed where it was.
      live.changed();
      return { status: 500, message: `${key} moved to ${to}, but its run did not start. The card is marked failed.` };
    }
    // Core's own sentence, because core knows the rule that refused it, and a person reads this on
    // the board. A stack trace here would be the board showing somebody our file names.
    return { status: 409, message: (error as Error).message };
  }
}

/**
 * A Delivery card goes on from Review to Pull request, and from there to Wrap-up, only once its work is
 * on a remote or a pull request is linked. Opening the pull request is the person's step on the Changes
 * tab, and without this a drag closed a card whose work was never committed. A move back passes.
 */
async function unsentRefusal(live: Loop, key: string, to: string): Promise<string | null> {
  const board = live.boardOf(key);
  const from = (live.db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string } | undefined)?.stage;
  const guarded = (from === 'review' && to === 'pr-watch') || (from === 'pr-watch' && to === 'wrapup');
  if (board.kind !== 'delivery' || !guarded) return null;
  if (live.db.prepare('SELECT 1 AS one FROM card_pulls WHERE card_key = ? LIMIT 1').get(key) !== undefined) return null;
  const { files, commits } = await unsentWork(live.db, key, process.env);
  if (files + commits === 0) return null;
  const count = (n: number, one: string, many: string): string => (n === 0 ? '' : `${n} ${n === 1 ? one : many}`);
  const what = [count(files, 'file not committed', 'files not committed'), count(commits, 'commit not pushed', 'commits not pushed')].filter((part) => part !== '').join(' and ');
  const label = board.stages.find((stage) => stage.id === from)?.label ?? from;
  return `${key} has ${what} and no pull request, so it stays in ${label}. Commit them and push on its Changes tab first.`;
}

/**
 * Send back from the web or the phone, as a `card.move` job with a note: a move to an earlier column, with
 * the note kept to one line and stored as the move's reason, which the trail shows. A move back starts no
 * run. An empty note is a plain move back, as a drag back is, and a note on a forward move is refused, so
 * the note is never dropped without a word. Null when the card moved, and the sentence when it did not.
 */
export async function moveBackWithNote(live: Loop, key: string, to: string, note: string): Promise<{ status: number; message: string } | null> {
  const line = note.replace(/\s+/g, ' ').trim();
  if (line === '') return moveTo(live, key, to);
  if (line.length > REASON_LIMIT) return { status: 400, message: `The note is over ${REASON_LIMIT} characters, so ${key} stayed where it was.` };
  const stages = live.boardOf(key).stages;
  const at = (id: string | undefined) => stages.findIndex((stage) => stage.id === id);
  const from = (live.db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string } | undefined)?.stage;
  // A missing card or column falls through, so `moveTo` refuses it with its own sentence.
  if (from !== undefined && at(to) >= 0 && at(to) >= at(from)) return { status: 409, message: `A note goes only with a move back, so ${key} stayed where it was.` };
  return moveTo(live, key, to, 'you', line);
}

export async function minimize(live: Loop, request: Request): Promise<Response> {
  const asked = await body(request);
  if (typeof asked.key !== 'string' || typeof asked.minimized !== 'boolean') {
    return said('Minimizing needs a card key, and whether the card is to be minimized or restored.', 400);
  }

  // Only a missing card is a 404. Anything that throws is a failed write, and it leaves as one.
  if (!setMinimized(live.db, asked.key, asked.minimized)) {
    return said(`The board has no card ${asked.key}, so there is nothing to minimize.`, 404);
  }
  // The scheduler is not touched, and it is what tells the open boards, so this says it instead.
  live.changed();
  return ok();
}

export async function stop(live: Loop, request: Request): Promise<Response> {
  const asked = await body(request);
  if (typeof asked.runId !== 'number') return said('Stopping a run needs its run id.', 400);

  // A run that already ended is nothing to stop, and the scheduler says so by doing nothing. Pressing
  // stop on a run that finished a moment ago is not a mistake a person should be told about.
  live.stop(asked.runId);
  return ok();
}

export async function promote(live: Loop, request: Request): Promise<Response> {
  const asked = await body(request);
  if (typeof asked.runId !== 'number') return said('Promoting a run needs its run id.', 400);

  live.scheduler.promote(asked.runId);
  return ok();
}

// Answers once the continued run is queued, like a move. The board shows the rest.
export async function answer(live: Loop, key: string, request: Request): Promise<Response> {
  const asked = await body(request);
  if (typeof asked.answer !== 'string') return said('An answer needs its text.', 400);

  return restarted(key, () => live.answer(key, asked.answer as string), 'go on with the answer');
}

// Retry with no body, and "Run on" with the profile to start this phase on. Both start a fresh run
// of the card's phase, so they answer the same way.
export async function retry(live: Loop, key: string, request?: Request): Promise<Response> {
  const asked = request === undefined ? {} : await body(request);
  if (asked.engine !== undefined && typeof asked.engine !== 'string') {
    return said('Running this card on another engine profile needs the id of that profile.', 400);
  }
  const on = asked.engine ?? null;
  // A QA run starts again only with an answer, as a move does. The answer is gone after the scripts
  // changed on the card's branch, and the board asks the question before it sends this retry.
  const stage = (live.db.prepare('SELECT stage FROM cards WHERE key = ?').get(key) as { stage: string } | undefined)?.stage;
  if (live.boardOf(key).stages.find((one) => one.id === stage)?.phase === 'qa' && !stackAnswered(live.db, key)) return said(answerAgain(key), 409);
  return restarted(key, () => live.retry(key, on), on === null ? 'start again' : `start on ${on}`);
}

// Fix it after a QA FAIL: the card goes back to Implement, and QA runs again once Implement ends ready.
// Answers once the Implement run is queued, like a move.
export async function fix(live: Loop, key: string): Promise<Response> {
  return restarted(key, () => live.fix(key), 'start Implement again');
}

// Send back with comments: the card goes back to Implement with every open diff comment. Answers once
// the Implement run is queued, like Fix it.
export async function sendBack(live: Loop, key: string): Promise<Response> {
  return restarted(key, () => live.sendBack(key), 'start Implement again');
}

// Fix CI on a card whose pull request has failed checks: the logs go into the card folder, and the card
// goes back to Implement with them. The same answers as Send back.
export async function fixCi(live: Loop, key: string): Promise<Response> {
  return restarted(key, () => live.fixCi(key), 'start Implement again');
}

// Run triage on the PRs tab, the same answers as Send back.
export async function triage(live: Loop, key: string): Promise<Response> {
  return restarted(key, () => live.triage(key), 'start triage');
}

// Fix on a row of the PRs tab. A refusal wrote nothing; a start that failed already says why on the row.
export function fixFeedback(live: Loop, key: string, body: unknown): Response {
  const ref = (body as { ref?: unknown } | null)?.ref;
  if (typeof ref !== 'string' || ref === '') return said('Send the ref of the comment to fix, as in T1.', 400);
  let started: boolean;
  try {
    started = live.fixFeedback(key, ref);
  } catch (error) {
    return said((error as Error).message, 409);
  }
  if (!started) return said(`The fix of ${ref} could not start. Its row on the PRs tab says why.`, 500);
  return ok();
}

// Fix all on the PRs tab. A refusal wrote nothing; a start that failed already says why on the rows.
export function fixAll(live: Loop, key: string): Response {
  let started: boolean;
  try {
    started = live.fixAll(key);
  } catch (error) {
    return said((error as Error).message, 409);
  }
  if (!started) return said('Fix all could not start. The rows on the PRs tab say why.', 500);
  return ok();
}

// QA the fixes on the PRs tab. A refusal wrote nothing; a start that failed left its reason on the run.
export function qaFixes(live: Loop, key: string): Response {
  let started: boolean;
  try {
    started = live.qaFixes(key);
  } catch (error) {
    return said((error as Error).message, 409);
  }
  if (!started) return said('QA of the fixes could not start. Its run on the Log tab says why.', 500);
  return ok();
}

// A throw is a refusal that wrote nothing, and the loop's sentence names the state the card is in.
// False means the card was marked failed with the reason, which the board already shows.
async function restarted(key: string, restart: () => boolean | Promise<boolean>, what: string): Promise<Response> {
  let started: boolean;
  try {
    started = await restart();
  } catch (error) {
    return said((error as Error).message, 409);
  }
  if (!started) return said(`${key} could not ${what}. The card is marked failed with the reason.`, 500);
  return ok();
}
