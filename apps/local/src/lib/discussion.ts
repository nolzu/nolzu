import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { askThreads, boardFor, canSend, isAskThread, isAction, isDeliveryPhase, isFeedbackRef, type ModelsByVendor, resolveModels, resumeCommand, type RunRow, type Thread, threadsFor } from '@nolzu/core';
import { boardOfCard, cardBase, cardModels, cardPreset, cardRuns, getSetting, projectProfiles, sessionFolder, sessionInCardFolder, type StoredRun, startEstimate } from '@nolzu/core/node';
import { ASK_PHASE, type Estimate, phaseLabel, type RunEvent } from '@nolzu/protocol';
import { checkoutRoot, listCardFiles, tailLog, toolSubject } from '@nolzu/runner';
import { cardFolder } from './files.ts';
import { whenSaid } from './when-said.ts';

// One tool call of a run, as its log holds it. The result is its size and whether the engine marked it
// an error, because the log events keep no more: the text stays in the raw log.
export interface ToolCall {
  name: string;
  // The file, command or pattern it acted on, short, or null when its input names none.
  subject: string | null;
  input: string;
  // Null when the log holds no answer to the call.
  result: { bytes: number; error: boolean } | null;
}

// The line above the first message of a run: "Plan run 15:31 ·
// 1m 12s · $0.11 · wrote plan/plan.md". Each figure is null where the run row has none.
export interface RunDivider {
  phase: string;
  started: string | null;
  durationMs: number | null;
  costUsd: number | null;
  // The files of the phase's own folder. Per phase, not per run: the folder keeps no record of which
  // run wrote a file.
  wrote: readonly string[];
}

export interface Message {
  id: number;
  author: 'person' | 'agent';
  body: string;
  at: string;
  runId: number | null;
  // When it was written, in the trail's words: the time today, a short day before it otherwise.
  when?: string | null;
  // On the first message of each run.
  divider?: RunDivider;
  // On an agent message once `withTools` read it: the tool calls of the run that wrote it, or null
  // when that run's log is gone.
  tools?: readonly ToolCall[] | null;
  // On an agent message: what the run that wrote it ran on and spent, each null where not reported.
  run?: { model: string | null; durationMs: number | null; tokens: number | null; costUsd: number | null };
  // On a person's answer from Before you approve: the column whose phase reads it, such as Plan.
  forNext?: string;
}

// A thread with what the list shows of it: how many messages it holds and when its run started.
// `when` is `at` in the trail's words. An ask discussion also carries its subject, written by a small
// pass after the first answer or by a person, and the start of its first message, which the list
// shows until there is a subject. Both are null on every other thread.
export type ThreadRow = Thread & { count: number; at: string | null; when: string | null; subject: string | null; opening: string | null };

export interface DiscussionTab {
  threads: readonly ThreadRow[];
  // The board's phases that have not run yet, which the list shows greyed until they do.
  later: readonly { id: string; label: string }[];
  // The board's phases in the order they run, which the list keeps, threads and greyed ones together.
  order: readonly string[];
  // Which one the page is showing, and what is in it.
  current: string;
  messages: readonly Message[];
  // The models the thread's own profile offers, for the dropdown that picks one for this message.
  models: readonly string[];
  // The model a message runs on when none is picked, or null when nothing runs or nothing knows.
  phaseModel: string | null;
  // The effort it runs at, which a message cannot change, or null as for the model.
  phaseEffort: string | null;
  // What a run of this phase costs, per model, only for the models runs measured.
  estimates: Readonly<Record<string, Estimate>>;
  // The terminal command that continues the open thread's session, or null when there is none.
  resume: string | null;
  // The id a new ask discussion takes.
  next: string;
  // A subject pass of this card still runs, so the page reads the card again until the subject lands.
  titling: boolean;
  // The open thread's run is still going, so its answer has not come yet: the newest Ask run of an ask
  // discussion, or the newest run of a phase thread. Read off the run row, so a reload mid-answer still
  // says so, and because an Ask run never shows on the card the board snapshot draws.
  asking: boolean;
}

const GOING: readonly (string | null)[] = ['queued', 'running'];

// The pass that writes an Ask discussion's subject. Its run row carries the card, so its cost shows on
// the Log tab and in the card's spend.
export const THREAD_TITLE = 'thread-title';
// Limit: a subject and a list row's opening are cut here, so a long one does not stretch the row.
// The list draws one line and ellipsizes past its width anyway.
export const SUBJECT_LIMIT = 80;

// The first line that holds something, its spaces folded, cut to the limit. Null when there is none.
export function oneLine(text: string, limit = SUBJECT_LIMIT): string | null {
  const line = text.split('\n').map((one) => one.replace(/\s+/g, ' ').trim()).find((one) => one !== '') ?? '';
  if (line === '') return null;
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/**
 * The subject a pass answered, as the list shows it: one line, without the quotes, heading marks or
 * end stop a model adds, or null when nothing is left. A pass that wrote a sentence past the limit is
 * cut, not refused, because a cut subject still names the discussion.
 */
export function cleanSubject(answer: string): string | null {
  const line = oneLine(answer.replace(/^\s*(?:subject|title)\s*:\s*/i, ''), Number.POSITIVE_INFINITY);
  if (line === null) return null;
  const bare = line.replace(/^#+\s*/, '').replace(/^["'`*\u201c\u2018]+|["'`*\u201d\u2019]+$/g, '').replace(/[.。]+$/, '').trim();
  return bare === '' ? null : oneLine(bare);
}

/**
 * Store an Ask discussion's subject. A person's name replaces whatever is there and is marked theirs.
 * The pass writes only where there is no subject yet, so it never replaces a person's name, and a pass
 * that ran twice keeps its first answer.
 */
export function saveSubject(db: DatabaseSync, key: string, thread: string, subject: string, byPerson: boolean): void {
  if (byPerson) {
    db.prepare('INSERT INTO thread_subjects (card_key, thread, subject, by_person) VALUES (?, ?, ?, 1) ON CONFLICT (card_key, thread) DO UPDATE SET subject = excluded.subject, by_person = 1').run(key, thread, subject);
  } else {
    db.prepare('INSERT INTO thread_subjects (card_key, thread, subject, by_person) VALUES (?, ?, ?, 0) ON CONFLICT (card_key, thread) DO NOTHING').run(key, thread, subject);
  }
}

/**
 * Whether an Ask discussion should get a subject now, which the caller asks only after a run that
 * answered. It has none, and no subject pass ran for it yet. An agent message is no sign: a run that
 * failed or was cut off writes one too, and the thread would then never get a subject. The pass row is,
 * and it also caps the passes at one per discussion, a failed one included.
 */
export function wantsSubject(db: DatabaseSync, key: string, thread: string): boolean {
  if (!isAskThread(thread)) return false;
  if (db.prepare('SELECT 1 FROM thread_subjects WHERE card_key = ? AND thread = ?').get(key, thread) !== undefined) return false;
  return db.prepare('SELECT 1 FROM runs WHERE card_key = ? AND phase = ? AND thread = ? LIMIT 1').get(key, THREAD_TITLE, thread) === undefined;
}

/**
 * Rename an Ask discussion: { thread, subject }. The name is the person's from then on, and the pass
 * never writes over it. Only an ask discussion has a subject, and only one that holds a message, since
 * an empty one is not listed.
 */
export async function renameThread(db: DatabaseSync, key: string, request: Request): Promise<Response> {
  let body: { thread?: unknown; subject?: unknown };
  try {
    body = (await request.json()) as { thread?: unknown; subject?: unknown };
  } catch {
    return answer(400, { message: 'The new name did not arrive as JSON.' });
  }
  const thread = typeof body.thread === 'string' ? body.thread : '';
  const subject = typeof body.subject === 'string' ? body.subject.replace(/\s+/g, ' ').trim() : '';
  if (!isAskThread(thread)) return answer(400, { message: `${thread || 'That thread'} is not an Ask discussion, so it has no name to change.` });
  if (subject === '') return answer(400, { message: 'The name is empty. Write a few words that say what the discussion is about.' });
  if (subject.length > SUBJECT_LIMIT) return answer(400, { message: `The name is over ${SUBJECT_LIMIT} characters. Shorten it and save again.` });
  if (db.prepare('SELECT 1 FROM messages WHERE card_key = ? AND thread = ? LIMIT 1').get(key, thread) === undefined) {
    return answer(404, { message: `${key} has no ${thread} discussion with a message in it, so there is nothing to rename.` });
  }
  saveSubject(db, key, thread, subject, true);
  return answer(200, { ok: true, subject });
}

/**
 * A card's discussion.
 *
 * The threads come from the card's runs, the newest run of each phase, so a phase that ran twice
 * shows the conversation a person is looking at. The list keeps the board's phase order. The
 * messages come from the table.
 */
export function discussionFor(
  db: DatabaseSync,
  key: string,
  wanted: string | null,
  models: ModelsByVendor,
  now = new Date(),
): DiscussionTab {
  // Newest first, which is the order `threadsFor` reads: the first row of a phase wins.
  const all = cardRuns(db, key);
  const runs = [...all]
    .reverse()
    .map((run) => ({ id: run.id, phase: run.phase, sessionId: run.sessionId, engine: run.engine }));
  const counts = new Map(
    (db.prepare('SELECT thread, COUNT(*) AS n FROM messages WHERE card_key = ? GROUP BY thread').all(key) as { thread: string; n: number }[]).map((row) => [row.thread, row.n]),
  );
  const asks = askThreads([...counts.keys()], wanted);
  const startedAt = new Map(all.map((run) => [run.id, run.startedAt]));
  // Each ask discussion goes on in the session of its newest Ask run that kept one, and is busy while
  // its newest Ask run goes.
  const askRuns: Record<string, RunRow> = {};
  const askState = new Map<string, string | null>();
  const asked = db
    .prepare('SELECT id, phase, session_id AS sessionId, engine, thread, state FROM runs WHERE card_key = ? AND phase = ? AND thread IS NOT NULL ORDER BY id')
    .all(key, ASK_PHASE) as unknown as (RunRow & { thread: string; state: string | null })[];
  for (const row of asked) {
    if (row.sessionId !== null) askRuns[row.thread] = row;
    askState.set(row.thread, row.state);
  }
  // A pull request comment has a thread once Discuss wrote its first message.
  const feedback = [...counts.keys()].filter(isFeedbackRef).sort((one, other) => Number(one.slice(1)) - Number(other.slice(1)));
  const subjects = new Map(
    (db.prepare('SELECT thread, subject FROM thread_subjects WHERE card_key = ?').all(key) as { thread: string; subject: string }[]).map((row) => [row.thread, row.subject]),
  );
  const openings = new Map(
    (db.prepare('SELECT thread, body FROM messages WHERE id IN (SELECT min(id) FROM messages WHERE card_key = ? GROUP BY thread)').all(key) as { thread: string; body: string }[]).map((row) => [row.thread, row.body]),
  );
  const listed = threadsFor(runs, [], asks.ids, askRuns, feedback).map((thread) => ({
    ...thread,
    count: counts.get(thread.id) ?? 0,
    at: thread.runId === null ? null : (startedAt.get(thread.runId) ?? null),
    subject: thread.kind === 'ask' ? (subjects.get(thread.id) ?? null) : null,
    opening: thread.kind === 'ask' ? oneLine(openings.get(thread.id) ?? '') : null,
  })).map((thread) => ({ ...thread, when: thread.at === null ? null : whenSaid(thread.at, now) }));
  // A phase has a thread once it ran, so the board's other phases are listed greyed,
  // rather than left out with no word.
  const kind = boardOfCard(db, key);
  const phases = kind === null ? [] : boardFor(kind, getSetting(db, 'deliveryFlow')).stages.flatMap((stage) => (stage.phase === undefined ? [] : [stage.phase]));
  const later = [...new Set(phases)].filter((phase) => !listed.some((thread) => thread.id === phase)).map((phase) => ({ id: phase, label: phaseLabel(phase) }));
  // A thread the URL names and the card does not have falls back to the first, the same way an
  // unknown tab falls back to the overview.
  const current = listed.find((thread) => thread.id === wanted)?.id ?? listed[0]?.id ?? '';
  // The message continues the thread's own session, which lives inside one login, so the list is
  // that profile's and never another vendor's. A profile this machine no longer holds offers none,
  // and the composer then sends the model the action table resolves.
  const open = listed.find((thread) => thread.id === current) ?? null;
  const profiles = projectProfiles(db);
  // Every ask discussion and every pull request comment thread runs the ask row, and a phase thread its phase's.
  const readOnly = open?.kind === 'ask' || open?.kind === 'feedback';
  const action = readOnly ? ASK_PHASE : (open?.id ?? '');

  // What `buildJob` runs when the composer sends no model: the table, pinned to the thread's profile.
  // An ask discussion with no session yet starts one on the ask row, wherever that row runs.
  const row =
    open !== null && isAction(action) && (open.engine != null || readOnly)
      ? resolveModels(cardModels(db, key), cardBase(db, key), cardPreset(db, key), models, profiles, open.engine ?? null)[action]
      : null;
  const engine = open?.engine ?? row?.engine ?? null;
  const profile = engine === null ? undefined : profiles.find((one) => one.id === engine);
  const vendor = profile?.vendor;
  // A new ask session names the profile it will start on, so the composer shows its engine.
  const threads = listed.map((thread) => (thread === open && thread.engine === null && row !== null ? { ...thread, engine: row.engine } : thread));
  const offered = (vendor === undefined ? undefined : models[vendor]) ?? [];
  // The figure of a run of this phase on each model the picker can send, at the effort the message
  // keeps. Only what runs measured: `startEstimate` gives nothing for the rest.
  const estimates: Record<string, Estimate> = {};
  if (row !== null && open !== null) {
    for (const model of new Set([row.model, ...offered])) {
      const found = startEstimate(db, { phase: action, model, effort: row.effort, vendor });
      if (found !== undefined) estimates[model] = found;
    }
  }

  // The folder is the one the session's first run started in, because Claude Code files a session under it.
  // With no project set, the run started in the fake engine's data folder, and no person resumes that by hand.
  const project = getSetting(db, 'projectPath');
  const resume =
    open?.sessionId != null && profile !== undefined && project !== null
      ? resumeCommand({
          vendor: profile.vendor,
          sessionId: open.sessionId,
          folder: sessionInCardFolder(db, key, open.sessionId, profile.vendor, action) ? join(project, '.tasks', key) : (sessionFolder(db, key, open.sessionId) ?? checkoutRoot(project, key)),
          configDir: profile.configDir,
        })
      : null;

  // The column after the one that runs this thread's phase, which reads its answers from Before you approve.
  const stages = kind === null ? [] : boardFor(kind, getSetting(db, 'deliveryFlow')).stages;
  const at = stages.findIndex((stage) => stage.phase === current);
  const after = at === -1 ? undefined : stages[at + 1];
  const forNext = (message: Message): Message => (after !== undefined && message.author === 'person' && isGateAnswer(message.body) ? { ...message, forNext: after.label } : message);

  return {
    threads,
    later,
    order: [...new Set(phases)],
    current,
    messages: withDividers(db, key, messagesIn(db, key, current).map(forNext), all, now),
    models: offered,
    phaseModel: row?.model ?? null,
    phaseEffort: row?.effort ?? null,
    estimates,
    resume,
    next: asks.next,
    titling: db.prepare("SELECT 1 FROM runs WHERE card_key = ? AND phase = ? AND state IN ('queued', 'running') LIMIT 1").get(key, THREAD_TITLE) !== undefined,
    asking: GOING.includes((readOnly ? askState.get(open?.id ?? '') : all.find((run) => run.id === open?.runId)?.state) ?? ''),
  };
}

/**
 * Each message with its time in the trail's words, and a divider on the first message of each run.
 * A message names the run it belongs to, so a new run starts where the run id changes.
 */
function withDividers(db: DatabaseSync, key: string, messages: readonly Message[], runs: readonly StoredRun[], now: Date): Message[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  let files: { path: string; phase: string | null }[] | null = null;
  const wrote = (phase: string) => {
    if (files === null) {
      const dir = cardFolder(db, key);
      files = dir === null ? [] : listCardFiles(dir).flatMap((group) => group.files);
    }
    return files.filter((file) => file.phase === phase).map((file) => file.path);
  };
  let last: number | null = null;
  return messages.map((message) => {
    const said = { ...message, when: whenSaid(message.at, now) };
    const run = message.runId === null || message.runId === last ? undefined : byId.get(message.runId);
    if (message.runId !== null) last = message.runId;
    if (run === undefined) return said;
    return {
      ...said,
      divider: {
        phase: phaseLabel(run.phase),
        started: run.startedAt === null ? null : whenSaid(run.startedAt, now),
        durationMs: run.durationMs,
        costUsd: run.costUsd,
        wrote: wrote(run.phase),
      },
    };
  });
}

/**
 * What an Ask run answers: the text it wrote after its last tool call, which is its last message.
 * The lines before a call are the agent saying what it reads next, and the tool rows show those reads.
 */
export function answerOf(events: readonly RunEvent[]): string {
  let parts: string[] = [];
  for (const event of events) {
    if (event.type === 'tool') parts = [];
    else if (event.type === 'text') parts.push(event.text);
  }
  return parts.join('\n').trim();
}

// Limit: a long input is cut here, at a size that keeps the page light. The whole one is in the
// raw log on the Log tab.
const INPUT_SHOWN = 4000;

/**
 * The tool calls in a run's log lines, in the order the run made them.
 *
 * Codex and Cursor give a call and its answer on one line, so an answer goes to a call of its own
 * line first. Claude Code answers on later lines, in the order it called, so an answer with no call
 * on its line goes to the oldest call still waiting. A call refused or cut off keeps no result.
 */
export function toolCalls(lines: readonly string[], parse: (line: string) => RunEvent[], cwd: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const waiting: ToolCall[] = [];
  for (const line of lines) {
    const fresh: ToolCall[] = [];
    for (const event of parse(line)) {
      if (event.type === 'tool') {
        const input = JSON.stringify(event.input, null, 2) ?? '';
        const call: ToolCall = {
          name: event.name.replace(/ToolCall$/, ''),
          subject: toolSubject(event.input, cwd),
          input: input.length > INPUT_SHOWN ? `${input.slice(0, INPUT_SHOWN)}\n…` : input,
          result: null,
        };
        calls.push(call);
        fresh.push(call);
      } else if (event.type === 'tool_result') {
        const call = fresh.shift() ?? waiting.shift();
        if (call !== undefined) call.result = { bytes: event.bytes, error: event.error };
      }
    }
    waiting.push(...fresh);
  }
  return calls;
}

/**
 * The thread with the tool calls of each agent message, read from the log of the run that wrote it.
 *
 * Never made up: a run whose log file is gone gets null, and the tab says so. Only the open thread's
 * runs are read, once each.
 * Limit: each log is read whole on every page load, as peek does. Read from the end if a log ever
 * grows past what that costs.
 */
export async function withTools(db: DatabaseSync, tab: DiscussionTab, parse: (line: string, engine: string) => RunEvent[]): Promise<DiscussionTab> {
  const read = db.prepare('SELECT engine, log_path, cwd, model, cost_estimate, duration_ms, tokens_input, tokens_output FROM runs WHERE id = ?');
  const messages = await Promise.all(
    tab.messages.map(async (message): Promise<Message> => {
      if (message.author !== 'agent' || message.runId === null) return message;
      const row = read.get(message.runId) as
        | { engine: string; log_path: string | null; cwd: string | null; model: string | null; cost_estimate: number | null; duration_ms: number | null; tokens_input: number | null; tokens_output: number | null }
        | undefined;
      if (row === undefined) return { ...message, tools: null };
      const tokens = row.tokens_input === null && row.tokens_output === null ? null : (row.tokens_input ?? 0) + (row.tokens_output ?? 0);
      const run = { model: row.model, durationMs: row.duration_ms, tokens, costUsd: row.cost_estimate };
      const path = row.log_path ?? '';
      if (path === '' || !existsSync(path)) return { ...message, tools: null, run };
      const lines: string[] = [];
      for await (const line of tailLog(path, new AbortController().signal, { follow: false })) lines.push(line);
      return { ...message, tools: toolCalls(lines, (line) => parse(line, row.engine), row.cwd ?? ''), run };
    }),
  );
  return { ...tab, messages };
}

export function messagesIn(db: DatabaseSync, key: string, thread: string): Message[] {
  return db
    // Aliased, because the column is run_id and every reader of this shape asks for runId.
    .prepare('SELECT id, author, body, at, run_id AS runId FROM messages WHERE card_key = ? AND thread = ? ORDER BY id')
    .all(key, thread) as unknown as Message[];
}

// A choice from Before you approve, in the words `settleQuestion` stores on the phase's thread. It goes
// to no agent of that phase: the next phase reads it when the card moves.
export const isGateAnswer = (body: string): boolean => /^[A-Z]+\d+: [\s\S]*? (?:I take the default|My answer): /.test(body);

export function addMessage(
  db: DatabaseSync,
  key: string,
  thread: string,
  author: 'person' | 'agent',
  body: string,
  runId: number | null,
): void {
  db.prepare('INSERT INTO messages (card_key, thread, author, body, at, run_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    key,
    thread,
    author,
    body,
    new Date().toISOString(),
    runId,
  );
}

/**
 * The phase's own words, into its thread, once its run has finished.
 *
 * The plain summary, because it is the one thing every phase writes for a reader and it is stored
 * by the time this runs. The full stream stays in the log, which is where a person goes for tool
 * calls and cost. Without this the discussion is a notebook a person writes into and nobody
 * answers.
 *
 * `extract-summary` has no stage and no thread, and a run that wrote no summary leaves the thread
 * as it was rather than showing an empty message.
 */
export function recordPhaseSummary(db: DatabaseSync, job: { runId: number; cardKey: string; phase: string }): void {
  if (!isDeliveryPhase(job.phase)) return;
  const row = db.prepare('SELECT plain_summary FROM runs WHERE id = ?').get(job.runId) as
    | { plain_summary: string | null }
    | undefined;
  const said = row?.plain_summary?.trim() ?? '';
  if (said === '') return;
  addMessage(db, job.cardKey, job.phase, 'agent', said, job.runId);
}

const answer = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Send a message to a thread.
 *
 * The message is stored first and the run is asked for second, so a person's words are never lost
 * to a run that would not start. A refused send leaves the message behind on purpose: it is what
 * they wrote, and the thread shows it with the reason.
 */
export async function sendMessage(
  db: DatabaseSync,
  key: string,
  request: Request,
  resume: (key: string, thread: Thread, text: string, model?: string) => boolean,
  models: ModelsByVendor,
): Promise<Response> {
  let body: { thread?: unknown; text?: unknown; model?: unknown };
  try {
    body = (await request.json()) as { thread?: unknown; text?: unknown; model?: unknown };
  } catch {
    return answer(400, { message: 'The message did not arrive as JSON.' });
  }
  const thread = typeof body.thread === 'string' ? body.thread : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const model = typeof body.model === 'string' ? body.model : '';

  const found = discussionFor(db, key, thread, models);
  const allowed = canSend(found.threads, thread, text);
  if (!allowed.ok) return answer(400, { message: allowed.reason });
  // A model the thread's profile does not offer would fail at the spawn, after the message was
  // stored and the card queued. Refused here instead, with the list. A thread whose profile this
  // machine no longer holds has no list at all, and saying it offers nothing would be a guess.
  if (model !== '' && !found.models.includes(model)) {
    const why =
      found.models.length === 0
        ? `This thread runs on ${allowed.thread.engine ?? 'no engine profile'}, so nothing here knows whether ${model} is one of its models. Send the message without a model.`
        : `${model} is not a model this engine offers. It offers ${found.models.join(', ')}.`;
    return answer(400, { message: why });
  }

  addMessage(db, key, thread, 'person', text.trim(), allowed.thread.runId);

  // The run is asked for after the message is stored, so a run that will not start still leaves
  // the person's own words in the thread. The loop throws for a card nothing may start on, and
  // that sentence names the state, so it goes back as it is rather than as a 500.
  try {
    if (!resume(key, allowed.thread, text.trim(), model)) {
      return answer(500, { message: `${key} could not go on with the message. The card is marked failed with the reason.` });
    }
  } catch (error) {
    return answer(409, { message: (error as Error).message });
  }
  return answer(200, { ok: true });
}
