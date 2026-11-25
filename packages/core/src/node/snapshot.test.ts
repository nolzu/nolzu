import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PROFILE, type RunRecord, spendOf } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardFor, deliveryBoard } from '../board.ts';
import { createQueue, enqueue, pick, type QueueState } from '../queue.ts';
import { createCard, createLocalTicket, followPreset, linkCards, moveCard, savePullRound, seenHead, setCardModels } from './cards.ts';
import { writeSetting } from './settings-store.ts';
import { openDatabase } from './db.ts';
import { recordKnowledgeChanges } from './knowledge-changes.ts';
import { applyTriage, saveCardPull, storeDiscussions } from './pr-discussions.ts';
import { cardRuns, saveOutputCheck, saveQuestionOptions, saveRun, saveVerdict, startRun } from './runs.ts';
import { boardSnapshot, newCommitsOf } from './snapshot.ts';

const board = deliveryBoard('pull-request');
const MODELS = { 'claude-code': ['haiku', 'sonnet', 'opus'] };
let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-snapshot-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage: string, state: string) =>
  db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run(key, 'delivery', stage, state, `${key} title`);

const begin = (key: string, lane: string | null = null) =>
  startRun(db, {
    cardKey: key,
    phase: 'implement',
    engine: 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    sessionId: null,
    logPath: join(dir, 'logs', `${key}.ndjson`),
    lane,
  });

// Through the real write path. A raw UPDATE can put a row into a shape no production code can write,
// and then the test proves something about a state that cannot happen.
const report = (id: number, over: Partial<RunRecord> = {}) =>
  saveRun(db, id, {
    sessionId: null,
    model: 'sonnet',
    costUsd: null,
    durationMs: null,
    tokens: null,
    question: null,
    failureReason: null,
    failureStatus: null,
    state: 'running',
    cardState: 'running',
    retry: null,
    ...over,
  });

// Whether the wall starts on this machine, as the loop hands it over from the runner's probe.
const WALL = { ready: true } as const;
const NO_WALL = { ready: false, reason: 'bubblewrap is not installed.' } as const;

// The vendor of the model list, the way the loop hands it over: the board only calls a row gone
// when the row runs on the vendor whose list it was given.
const shot = (queue: QueueState = createQueue(3), models = MODELS) => boardSnapshot(db, { wall: WALL, board, queue, models });
const cardIn = (snap: ReturnType<typeof shot>, key: string) => snap.cards.find((one) => one.key === key);

it('reports a card with no run as idle and carries no job for it', () => {
  addCard('APP-1', 'inbox', 'idle');

  const card = cardIn(shot(), 'APP-1');

  expect(card?.state).toBe('idle');
  expect(card?.runId).toBe(null);
  expect(card?.runState).toBe(null);
  expect(card?.queuePosition).toBe(null);
});

it('reports a queued position from the queue order, not the row id', () => {
  addCard('APP-1', 'implement', 'queued');
  addCard('APP-2', 'implement', 'queued');
  const first = begin('APP-1');
  const second = begin('APP-2');
  // Second in the queue, first by row id, so the two cannot be confused.
  let queue = createQueue(1);
  queue = enqueue(queue, { runId: second, cardKey: 'APP-2', lane: null });
  queue = enqueue(queue, { runId: first, cardKey: 'APP-1', lane: null });

  const snap = shot(queue);

  expect(cardIn(snap, 'APP-2')?.queuePosition).toBe(1);
  expect(cardIn(snap, 'APP-1')?.queuePosition).toBe(2);
});

// A wrap-up the loop holds for Knowledge, in the shape the loop writes it. It is the person's only
// while a change waits for them; held behind a knowledge run alone, it is a wait for the lane.
it('reports a wrap-up held for Knowledge as waiting on the person only while a change waits', () => {
  addCard('APP-1', 'wrapup', 'queued');
  const held = begin('APP-1', 'knowledge');
  db.prepare("UPDATE runs SET state = 'waiting_review' WHERE id = ?").run(held);

  expect(cardIn(shot(), 'APP-1')).toMatchObject({ runState: 'waiting_lane', lane: 'knowledge', state: 'queued' });

  addCard('APP-2', 'wrapup', 'idle');
  recordKnowledgeChanges(db, { cardKey: 'APP-2', runId: begin('APP-2', 'knowledge'), commitSha: null, status: 'pending', files: [{ path: 'notes.md', summary: null }] });

  expect(cardIn(shot(), 'APP-1')).toMatchObject({ runState: 'waiting_review', lane: 'knowledge', state: 'queued' });
});

it('reports a job held by a busy lane as waiting on the lane, while its card still reads queued', () => {
  addCard('APP-1', 'implement', 'running');
  addCard('APP-2', 'implement', 'queued');
  const held = begin('APP-1', 'stack');
  const waiting = begin('APP-2', 'stack');
  let queue = createQueue(3);
  queue = enqueue(queue, { runId: held, cardKey: 'APP-1', lane: 'stack' });
  queue = pick(queue).state;
  queue = enqueue(queue, { runId: waiting, cardKey: 'APP-2', lane: 'stack' });

  const card = cardIn(shot(queue), 'APP-2');

  expect(card?.runState).toBe('waiting_lane');
  expect(card?.lane).toBe('stack');
  // The person sees a queued card on the board. The lane is why, not what.
  expect(card?.state).toBe('queued');
});

// One queue for every project. Another project's APP-1 holds a slot and the stack lane here, and its
// place counts, but it is not this board's APP-1.
it('marks only its own project cards, and counts the other projects in the slots, the lanes and the places', () => {
  addCard('APP-1', 'implement', 'queued');
  const mine = begin('APP-1', 'stack');
  let queue = createQueue(2);
  // Run ids come from each project's own database: project 2's APP-1 is its run 99, and its run with
  // this board's id belongs to another card, ahead in line.
  queue = enqueue(queue, { runId: 99, cardKey: 'APP-1', lane: 'stack', project: 2 });
  queue = pick(queue).state;
  queue = enqueue(queue, { runId: mine, cardKey: 'PROJ-123', lane: 'stack', project: 2 });
  queue = enqueue(queue, { runId: mine, cardKey: 'APP-1', lane: 'stack', project: 1 });

  const snap = boardSnapshot(db, { wall: WALL, board, queue, models: MODELS, project: 1 });

  expect(cardIn(snap, 'APP-1')).toMatchObject({ runState: 'waiting_lane', queuePosition: 2 });
  expect(snap.slots).toEqual({ busy: 1, total: 2 });
  expect(snap.lanes.find((lane) => lane.name === 'stack')?.heldBy).toBe('APP-1');

  // Only the other project's APP-1 waits now, so this one has no place in the queue.
  const other = boardSnapshot(db, { wall: WALL, board, queue: { slots: 0, running: [], waiting: [{ runId: mine, cardKey: 'APP-1', lane: null, project: 2 }] }, models: MODELS, project: 1 });
  expect(cardIn(other, 'APP-1')?.queuePosition).toBeNull();
});

// A lane held by another project's card names that project, so its APP-1 never reads as this board's.
it('names the project of a lane holder that is not this board own', () => {
  const held = (project: number | undefined) => {
    const queue = pick(enqueue(createQueue(2), { runId: 7, cardKey: 'APP-1', lane: 'stack', project: 2 })).state;
    return boardSnapshot(db, { wall: WALL, board, queue, models: MODELS, ...(project === undefined ? {} : { project }) }).lanes.find((lane) => lane.name === 'stack');
  };

  expect(held(1)).toEqual({ name: 'stack', heldBy: 'APP-1', project: 2 });
  expect(held(2)).toEqual({ name: 'stack', heldBy: 'APP-1' });
  expect(held(undefined)).toEqual({ name: 'stack', heldBy: 'APP-1' });
});

it('carries engine, model, run start and run id on a running card, and no elapsed figure', () => {
  addCard('APP-1', 'implement', 'running');
  const id = begin('APP-1');
  report(id);
  let queue = createQueue(3);
  queue = enqueue(queue, { runId: id, cardKey: 'APP-1', lane: null });
  queue = pick(queue).state;

  const card = cardIn(shot(queue), 'APP-1');

  expect(card?.runId).toBe(id);
  expect(card?.engine).toBe('claude-code');
  expect(card?.model).toBe('sonnet');
  expect(card?.runStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // The browser counts. A number here would make every second a new snapshot.
  expect(JSON.stringify(card)).not.toMatch(/elapsed/i);
});

it('carries the question a blocked card is waiting on', () => {
  addCard('APP-1', 'implement', 'blocked');
  const id = begin('APP-1');
  db.prepare("UPDATE runs SET state = 'stopped', question = 'Which index name should it use?' WHERE id = ?").run(id);

  expect(cardIn(shot(), 'APP-1')?.question).toBe('Which index name should it use?');
});

// Now draws the options from the snapshot, so they ride with the question. A plain question carries
// no field at all, which is how a run from before the options reads.
it('carries the answers the agent offered with the question, and none for a plain question', () => {
  addCard('APP-1', 'implement', 'blocked');
  addCard('APP-2', 'implement', 'blocked');
  const asked = begin('APP-1');
  const plain = begin('APP-2');
  db.prepare("UPDATE runs SET state = 'stopped', question = 'Stars or thumbs?' WHERE id IN (?, ?)").run(asked, plain);
  const options = [{ label: '1 to 5 stars', means: 'A new column' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }];
  saveQuestionOptions(db, asked, options);

  expect(cardIn(shot(), 'APP-1')?.questionOptions).toEqual(options);
  expect(cardIn(shot(), 'APP-2')).not.toHaveProperty('questionOptions');
  // A broken value written by hand reads as none rather than breaking the board.
  db.prepare("UPDATE runs SET question_options = 'not json' WHERE id = ?").run(asked);
  expect(cardIn(shot(), 'APP-1')).not.toHaveProperty('questionOptions');
});

it('counts running jobs in the slot meter and nothing else', () => {
  addCard('APP-1', 'implement', 'running');
  addCard('APP-2', 'implement', 'queued');
  let queue = createQueue(3);
  queue = enqueue(queue, { runId: begin('APP-1'), cardKey: 'APP-1', lane: null });
  queue = pick(queue).state;
  queue = enqueue(queue, { runId: begin('APP-2'), cardKey: 'APP-2', lane: null });

  const snap = shot(queue);

  expect(snap.slots).toEqual({ busy: 1, total: 3 });
});

it('names the card holding each lane, and leaves the free ones empty', () => {
  addCard('APP-1', 'implement', 'running');
  addCard('APP-2', 'implement', 'queued');
  let queue = createQueue(3);
  queue = enqueue(queue, { runId: begin('APP-1', 'stack'), cardKey: 'APP-1', lane: 'stack' });
  queue = pick(queue).state;
  // Waiting on the knowledge lane, never started. A job in the queue is not holding a lane, and a
  // meter that counted it would name a card that has not begun.
  queue = enqueue(queue, { runId: begin('APP-2', 'knowledge'), cardKey: 'APP-2', lane: 'knowledge' });

  const snap = shot(queue);

  expect(snap.lanes.find((lane) => lane.name === 'stack')?.heldBy).toBe('APP-1');
  expect(snap.lanes.find((lane) => lane.name === 'knowledge')?.heldBy).toBe(null);
  expect(snap.lanes.map((lane) => lane.name)).toEqual(['stack', 'knowledge', 'scout']);
});

it('gives a stage that starts no phase no starts descriptor', () => {
  const snap = shot();

  expect(snap.stages.find((stage) => stage.id === 'inbox')?.starts).toBe(null);
  // Review is a person's stage, so a drop into it starts nothing and the column says nothing.
  expect(snap.stages.find((stage) => stage.id === 'review')?.starts).toBe(null);
});

// The line a person's column and an auto column draw under their name. An agent column draws what
// a drop starts instead, so it carries no line, and the field is left off rather than set empty.
it('carries the line under the name of a person or auto column, and none on any other', () => {
  const stages = shot().stages;

  expect(stages.find((stage) => stage.id === 'inbox')?.says).toBe('you pick what goes next');
  expect(stages.find((stage) => stage.id === 'pr-watch')?.says).toBe('waits on GitHub');
  expect(stages.find((stage) => stage.id === 'plan')).not.toHaveProperty('says');
  expect(stages.find((stage) => stage.id === 'closed')).not.toHaveProperty('says');
});

it('carries the resolved model and effort on a stage that starts a phase', () => {
  const plan = shot().stages.find((stage) => stage.id === 'plan');

  expect(plan?.starts).toEqual({ phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null });
});

it('says so when the model a stage would start is gone', () => {
  // The engine no longer reports sonnet. The drop must not read as if it would start a run.
  const plan = shot(createQueue(3), { 'claude-code': ['haiku', 'opus'] }).stages.find((stage) => stage.id === 'plan');

  expect(plan?.starts?.modelState).toBe('gone');
  expect(plan?.starts?.model).toBe('sonnet');
});

describe('a second engine profile', () => {
  const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/work/codex' } as const;

  // A screen that resolves against one hard-coded profile while the job builder reads the stored
  // list shows a card naming a second profile as broken on three screens, while it runs fine. This writes the list the way a person would and reads the
  // snapshot back, which is the effect.
  it('reads a row on a stored second profile as ok, not as missing', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'models', { plan: { engine: 'codex#work', model: 'gpt-9' } });

    const plan = shot().stages.find((stage) => stage.id === 'plan');

    expect(plan?.starts?.engine).toBe('codex#work');
    // Not 'gone' either: gpt-9 is not in the Claude model list, and asking that list about another
    // vendor's model is what used to call a working row gone.
    expect(plan?.starts?.modelState).toBe('ok');
  });

  // "Heavy on Codex" on Settings, Models: the drop says the engine the run will use.
  it('starts every row with no engine of its own on the project preset engine', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'presetEngine', 'codex');

    expect(boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: { ...MODELS, codex: ['gpt-5.6-terra'] } }).stages.find((stage) => stage.id === 'plan')?.starts).toMatchObject({ engine: 'codex#work', model: 'gpt-5.6-terra' });
  });

  // The drop box names the profile only when there is more than one to tell apart.
  it('says on each start that more than one profile is set, and says nothing with one', () => {
    expect(shot().stages.find((stage) => stage.id === 'plan')?.starts).not.toHaveProperty('severalProfiles');

    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

    expect(shot().stages.find((stage) => stage.id === 'plan')?.starts?.severalProfiles).toBe(true);
  });

  // Two rows, two vendors, one board. Each is measured against the list of its own profile, so a
  // Codex row naming nothing real reads gone while the Claude row beside it reads ok.
  it('measures each row against its own vendor', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'models', { plan: { engine: 'codex#work', model: 'gpt-9' }, implement: { engine: 'claude-code', model: 'sonnet' } });

    const stages = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: { ...MODELS, codex: ['gpt-5.6-sol'] } }).stages;

    expect(stages.find((stage) => stage.id === 'plan')?.starts?.modelState).toBe('gone');
    expect(stages.find((stage) => stage.id === 'implement')?.starts?.modelState).toBe('ok');
  });

  /**
   * A row whose vendor cannot run that phase at all.
   *
   * No model and no login repairs it, so it is neither gone nor missing a profile. The board says
   * the sentence the spawn would have thrown, which is the same rule read in one place.
   */
  it('refuses a plan row on a Cursor profile where the wall cannot start, with the reason the spawn would give', () => {
    const cursor = { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: '/work/cursor' } as const;
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, cursor]);
    writeSetting(db, 'models', { plan: { engine: 'cursor#work', model: 'composer-2.5' } });
    const plan = (wall: typeof WALL | typeof NO_WALL) =>
      boardSnapshot(db, { wall, board, queue: createQueue(3), models: { ...MODELS, cursor: ['composer-2.5'] } }).stages.find((stage) => stage.id === 'plan');

    expect(plan(NO_WALL)?.starts?.modelState).toBe('vendor');
    expect(plan(NO_WALL)?.starts?.refusal).toContain('bubblewrap is not installed.');
    // Inside the wall the same row starts.
    expect(plan(WALL)?.starts?.modelState).toBe('ok');
  });

  // The other side of the same rule. Codex runs refine from the card folder, so the row is ok and
  // the board offers the drop.
  it('leaves a refine row on a Codex profile alone', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'models', { refine: { engine: 'codex#work', model: 'gpt-5.6-sol' } });

    const refine = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: { ...MODELS, codex: ['gpt-5.6-sol'] } }).stages.find((stage) => stage.id === 'refine');

    expect(refine?.starts?.modelState).toBe('ok');
    expect(refine?.starts?.refusal).toBeNull();
  });

  // A project folder that is not a git repository runs on Claude Code only. The drop says so before
  // the click, and a folder that is a repository gives the same row back.
  it('refuses the refine row on Codex when the project folder is not a git repository', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'models', { refine: { engine: 'codex#work', model: 'gpt-5.6-sol' } });
    writeSetting(db, 'projectPath', '/work/recipes');
    writeSetting(db, 'repos', [{ path: 'api', base: null }]);
    const refine = () =>
      boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: { ...MODELS, codex: ['gpt-5.6-sol'] } }).stages.find((stage) => stage.id === 'refine');

    expect(refine()?.starts?.modelState).toBe('vendor');
    expect(refine()?.starts?.refusal).toContain('not a git repository');

    writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
    expect(refine()?.starts?.modelState).toBe('ok');
  });

  // The same rule on a card that moved its own row to Codex, so its drop says it before the click too.
  it('refuses a card row of its own on Codex when the project folder is not a git repository', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'projectPath', '/work/recipes');
    writeSetting(db, 'repos', [{ path: 'api', base: null }]);
    addCard('APP-1', 'refine', 'idle');
    setCardModels(db, 'APP-1', { refine: { engine: 'codex#work', model: 'gpt-5.6-sol' } });
    const refine = () => cardIn(boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: { ...MODELS, codex: ['gpt-5.6-sol'] } }), 'APP-1')?.starts?.refine;

    expect(refine()?.modelState).toBe('vendor');
    expect(refine()?.refusal).toContain('not a git repository');

    writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
    expect(refine()?.modelState).toBe('ok');
  });

  // Where the wall cannot start, Codex still runs QA under its own sandbox, so the row is not refused.
  it('starts the QA row on a Codex profile where the wall cannot start', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    writeSetting(db, 'models', { refine: { engine: 'codex#work', model: 'gpt-5.6-sol' }, qa: { engine: 'codex#work', model: 'gpt-5.6-sol' } });

    const stages = boardSnapshot(db, { wall: NO_WALL, board, queue: createQueue(3), models: { ...MODELS, codex: ['gpt-5.6-sol'] } }).stages;

    expect(stages.find((stage) => stage.id === 'refine')?.starts?.modelState).toBe('ok');
    expect(stages.find((stage) => stage.id === 'qa')?.starts?.modelState).toBe('ok');
    expect(stages.find((stage) => stage.id === 'qa')?.starts?.refusal).toBeNull();
  });

  // Both are true at once: the vendor cannot run the phase and the model it would run is not on
  // that vendor's list. The vendor rule wins, because no model a person could pick repairs it.
  it('names the vendor rule and not the model when both would refuse the row', () => {
    const cursor = { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: '/work/cursor' } as const;
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, cursor]);
    writeSetting(db, 'models', { plan: { engine: 'cursor#work', model: 'composer-2.5' } });

    // The list holds another model, so this row is gone as well.
    const plan = boardSnapshot(db, { wall: NO_WALL, board, queue: createQueue(3), models: { ...MODELS, cursor: ['gpt-5.3-codex'] } }).stages.find((stage) => stage.id === 'plan');

    expect(plan?.starts?.modelState).toBe('vendor');
    expect(plan?.starts?.refusal).toContain('only Nolzu\'s wall holds Cursor to reading');
  });

  // A missing login comes first: with no profile nothing knows the vendor, so a rule about a vendor
  // nobody can see would be the wrong sentence.
  it('names the missing login and not a vendor rule when the profile is gone', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE]);
    writeSetting(db, 'models', { plan: { engine: 'cursor#work', model: 'composer-2.5' } });

    const plan = shot().stages.find((stage) => stage.id === 'plan');

    expect(plan?.starts?.modelState).toBe('no-profile');
    expect(plan?.starts?.refusal).toBeNull();
  });

  it('names the profile when the row points at a login this machine dropped', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE]);
    writeSetting(db, 'models', { plan: { engine: 'codex#work', model: 'gpt-9' } });

    const plan = shot().stages.find((stage) => stage.id === 'plan');

    expect(plan?.starts?.modelState).toBe('no-profile');
    expect(plan?.starts?.engine).toBe('codex#work');
  });
});

it('counts the cards in each stage', () => {
  addCard('APP-1', 'implement', 'idle');
  addCard('APP-2', 'implement', 'idle');
  addCard('APP-3', 'inbox', 'idle');

  const snap = shot();

  expect(snap.stages.find((stage) => stage.id === 'implement')?.count).toBe(2);
  expect(snap.stages.find((stage) => stage.id === 'inbox')?.count).toBe(1);
  expect(snap.stages.find((stage) => stage.id === 'review')?.count).toBe(0);
});

it('rises the version after a move and after a run event, and never falls', async () => {
  addCard('APP-1', 'inbox', 'idle');
  const first = shot().version;

  await moveCard(db, board, 'APP-1', 'refine', vi.fn());
  const afterMove = shot().version;

  const id = begin('APP-1');
  saveRun(db, id, {
    sessionId: null,
    model: null,
    costUsd: 0.01,
    durationMs: 10,
    tokens: null,
    question: null,
    failureReason: null,
    failureStatus: null,
    state: 'running',
    cardState: 'running',
    retry: null,
  });
  const afterEvent = shot().version;

  expect(afterMove).toBeGreaterThan(first);
  expect(afterEvent).toBeGreaterThan(afterMove);
  // Reading twice changes nothing, so the stream does not send a new id for the same state.
  expect(shot().version).toBe(afterEvent);
});

it('carries no path and nothing naming the data directory, so the shape can go to the cloud', () => {
  addCard('APP-1', 'implement', 'running');
  const id = begin('APP-1');
  db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(id);

  const text = JSON.stringify(shot());

  expect(text).not.toContain(dir);
  expect(text).not.toContain('.ndjson');
  expect(text).not.toMatch(/log_path|logPath/);
});

it('shows the newest run of a card and not the one before it', () => {
  // A card runs a phase, then runs another. The board shows the one it is on now, or the one that
  // just ended, never an older one whose model and cost belong to different work.
  addCard('APP-1', 'implement', 'running');
  const first = begin('APP-1');
  db.prepare("UPDATE runs SET state = 'complete', engine = 'fake', cost_estimate = 0.5 WHERE id = ?").run(first);
  const second = begin('APP-1');
  db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(second);

  const card = cardIn(shot(), 'APP-1');

  expect(card?.runId).toBe(second);
  expect(card?.runState).toBe('running');
  // The phase, so a stopped run is offered again only in the stage that ran it.
  expect(card?.runPhase).toBe('implement');
  expect(card?.engine).toBe('claude-code');
  expect(card?.costUsd).toBe(null);
});

it('carries whether a card is minimized', () => {
  addCard('APP-1', 'inbox', 'idle');
  addCard('APP-2', 'inbox', 'idle');
  db.prepare("UPDATE cards SET minimized = 1 WHERE key = 'APP-2'").run();

  const snap = shot();

  expect(cardIn(snap, 'APP-1')?.minimized).toBe(false);
  expect(cardIn(snap, 'APP-2')?.minimized).toBe(true);
});

it('draws each card in the stage it is on', () => {
  addCard('APP-1', 'inbox', 'idle');
  addCard('APP-2', 'review', 'ready');

  const snap = shot();

  // Without this every card could be handed to the wrong column and nothing would say so.
  expect(cardIn(snap, 'APP-1')?.stage).toBe('inbox');
  expect(cardIn(snap, 'APP-2')?.stage).toBe('review');
});

it('follows the stored model preset, so the drop label is the one the run would use', () => {
  writeSetting(db, 'modelPreset', 'heavy');

  const plan = shot().stages.find((stage) => stage.id === 'plan');

  expect(plan?.starts).toEqual({ phase: 'plan', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null });
});

it('carries only the cards of the board it was asked for', () => {
  addCard('APP-1', 'inbox', 'idle');
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-1', 'epics', 'inbox', 'idle', 'Another board')").run();

  const snap = shot();

  expect(snap.cards.map((card) => card.key)).toEqual(['APP-1']);
  expect(snap.stages.find((stage) => stage.id === 'inbox')?.count).toBe(1);
});

it('says which board and which flow it is', () => {
  const snap = shot();

  expect(snap.kind).toBe('delivery');
  expect(snap.flow).toBe('pull-request');
});

// A project an older version set to the merging flow still opens, on the one flow left.
it('reads a flow an older version stored as pull requests', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('deliveryFlow', '\"direct-merge\"')").run();
  expect(shot().flow).toBe('pull-request');
  expect(shot().stages.map((stage) => stage.id)).toContain('pr-watch');
});

it('reads a job waiting for a free slot as queued, with its position', () => {
  // The lane variant is covered above. This is the other half of waitFor, and the two report
  // different run states from the same branch.
  addCard('APP-1', 'implement', 'queued');
  let queue = createQueue(0);
  queue = enqueue(queue, { runId: begin('APP-1'), cardKey: 'APP-1', lane: null });

  const card = cardIn(shot(queue), 'APP-1');

  expect(card?.runState).toBe('queued');
  expect(card?.queuePosition).toBe(1);
});

it('carries no run start while a job is still waiting, and one once it reports', () => {
  // The queue wait is not the run. A start stamped here would make the board count from before the
  // engine was spawned, and the number would disagree with the run's own duration.
  addCard('APP-1', 'implement', 'queued');
  const id = begin('APP-1');
  let queue = createQueue(0);
  queue = enqueue(queue, { runId: id, cardKey: 'APP-1', lane: null });

  expect(cardIn(shot(queue), 'APP-1')?.runStartedAt).toBe(null);

  report(id);

  expect(cardIn(shot(queue), 'APP-1')?.runStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

it('carries the cost and the failure reason a finished run recorded', () => {
  addCard('APP-1', 'implement', 'failed');
  const id = begin('APP-1');
  report(id, { state: 'failed', cardState: 'failed', costUsd: 0.42, failureReason: 'the engine stopped answering' });

  const card = cardIn(shot(), 'APP-1');

  expect(card?.costUsd).toBe(0.42);
  expect(card?.failureReason).toBe('the engine stopped answering');
});

it('returns the cards in a settled order', () => {
  // Three, inserted out of sequence, so key order differs from the order they were written and from
  // the reverse of it. With two the reverse of the insert order happens to be the key order, and a
  // sort that had been removed or reversed would read as correct.
  addCard('APP-2', 'inbox', 'idle');
  addCard('APP-3', 'inbox', 'idle');
  addCard('APP-1', 'inbox', 'idle');

  expect(shot().cards.map((card) => card.key)).toEqual(['APP-1', 'APP-2', 'APP-3']);
});

it('moves the version when a card is created', () => {
  const first = shot().version;

  createCard(db, { key: 'APP-9', board: 'delivery', stage: 'inbox', title: 'Typed by hand' });

  // A new card is the commonest change there is. A board told nothing would never show it.
  expect(shot().version).toBeGreaterThan(first);
});

it('moves the version when a local ticket is created', () => {
  const first = shot().version;

  createLocalTicket(db, { projectId: 1, prefix: 'WEB', title: 'From a ticket', description: '' });

  expect(shot().version).toBeGreaterThan(first);
});

it('moves the version when a setting the board draws is written', () => {
  const first = shot().version;

  writeSetting(db, 'modelPreset', 'light');

  // Every stage's model and effort just changed. A board that kept the old id would keep drawing a
  // label that no longer matches the run it promises.
  expect(shot().version).toBeGreaterThan(first);
});

it('carries the effort of the newest run, so the card can show it next to the model', () => {
  addCard('APP-1', 'implement', 'running');
  report(begin('APP-1'));

  expect(cardIn(shot(), 'APP-1')?.effort).toBe('medium');
  addCard('APP-2', 'inbox', 'idle');
  expect(cardIn(shot(), 'APP-2')?.effort).toBe(null);
});

it('shows the phase run on the card, not the extraction pass that followed it', () => {
  // The pass has its own row so its cost is visible there. On the card it would replace the cost of
  // the phase itself with the few cents of a summary.
  addCard('APP-1', 'implement', 'ready');
  const phase = begin('APP-1');
  report(phase, { state: 'complete', cardState: 'ready', costUsd: 1.2 });
  const extraction = startRun(db, { cardKey: 'APP-1', phase: 'extract-summary', engine: 'claude', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  report(extraction, { state: 'complete', cardState: 'ready', costUsd: 0.01 });

  const card = cardIn(shot(), 'APP-1');

  expect(card?.runId).toBe(phase);
  expect(card?.costUsd).toBe(1.2);
});

it('adds every run of the card into its total, passes and Ask included, as the card page does', () => {
  addCard('APP-1', 'implement', 'running');
  report(begin('APP-1'), { state: 'complete', cardState: 'ready', costUsd: 0.5 });
  const pass = startRun(db, { cardKey: 'APP-1', phase: 'extract-summary', engine: 'claude', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  report(pass, { state: 'complete', cardState: 'ready', costUsd: 0.01 });
  const ask = startRun(db, { cardKey: 'APP-1', phase: 'ask', engine: 'claude', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  report(ask, { state: 'complete', cardState: 'ready', costUsd: 0.02 });
  report(begin('APP-1'), { state: 'complete', cardState: 'ready', costUsd: 0.25 });
  // Still running, so no cost yet, and a missing cost is never added as nought.
  begin('APP-1');
  addCard('APP-2', 'inbox', 'idle');

  const card = cardIn(shot(), 'APP-1');

  expect(card?.totalUsd).toBeCloseTo(0.78);
  expect(card?.totalUsd).toBe(spendOf(cardRuns(db, 'APP-1')).costUsd);
  expect(card?.costUsd).toBe(null);
  expect(cardIn(shot(), 'APP-2')?.totalUsd).toBe(null);
});

describe('what a stage and a card start on', () => {
  it('takes the project models over the preset for the stage', () => {
    writeSetting(db, 'models', { plan: { model: 'opus', effort: 'high' } });

    const plan = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).stages.find((stage) => stage.id === 'plan');

    expect(plan?.starts).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('carries the starts of a card that stores its own models, and none for a card that does not', () => {
    addCard('APP-1', 'inbox', 'idle');
    addCard('APP-2', 'inbox', 'idle');
    setCardModels(db, 'APP-1', { implement: { engine: 'claude-code', model: 'opus' } });

    const cards = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).cards;

    expect(cards.find((card) => card.key === 'APP-1')?.starts?.implement).toEqual({ phase: 'implement', model: 'opus', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null });
    expect(cards.find((card) => card.key === 'APP-2')?.starts).toBeNull();
  });

  // A card on another preset than the project runs that preset's rows, with nothing of its own.
  it('carries the starts of a card that follows another preset', () => {
    addCard('APP-1', 'inbox', 'idle');
    followPreset(db, 'APP-1', 'heavy');

    expect(boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).cards[0]?.starts?.plan).toMatchObject({ model: 'opus', effort: 'high', modelState: 'ok' });
  });

  // Each card is asked its own preset: a card on the project's preset carries none, the other carries Heavy's.
  it('reads the preset of each card and not of the first', () => {
    addCard('APP-1', 'inbox', 'idle');
    addCard('APP-2', 'inbox', 'idle');
    followPreset(db, 'APP-2', 'heavy');

    const cards = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).cards;

    expect(cards.find((card) => card.key === 'APP-1')?.starts).toBeNull();
    expect(cards.find((card) => card.key === 'APP-2')?.starts?.plan).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('marks a card model the engine does not offer as gone', () => {
    addCard('APP-1', 'inbox', 'idle');
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'sonnet-3' } });

    expect(boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).cards[0]?.starts?.plan?.modelState).toBe('gone');
  });
});

// The card chip. It travels on the snapshot, so the board reads it from
// the same place as every other state.
it('carries the verdict of the newest run onto the card', () => {
  addCard('APP-1', 'qa', 'ready');
  const run = begin('APP-1');
  saveVerdict(db, run, { verdict: 'FAIL', reason: 'An empty search shows no recipes.' });

  const card = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).cards[0];

  expect(card?.verdict).toBe('FAIL');
  expect(card?.verdictReason).toBe('An empty search shows no recipes.');
});

// The output check badge holds the newest run's problems only, so a run that wrote its files well
// takes it down again.
it('carries the output check problems of the newest run, and leaves them out at none', () => {
  addCard('APP-1', 'refine', 'ready');
  const problem = { file: 'refine/refined.md', problem: 'The file is missing.' };
  saveOutputCheck(db, begin('APP-1'), { problems: [problem, problem], note: null });
  expect(cardIn(shot(), 'APP-1')?.outputProblems).toEqual([problem, problem]);
  saveOutputCheck(db, begin('APP-1'), { problems: [], note: null });
  expect(cardIn(shot(), 'APP-1')).not.toHaveProperty('outputProblems');
  begin('APP-1');
  expect(cardIn(shot(), 'APP-1')).not.toHaveProperty('outputProblems');
  // A closed card's page lists no problems, so its card carries no badge.
  addCard('APP-2', 'closed', 'idle');
  saveOutputCheck(db, begin('APP-2'), { problems: [problem], note: null });
  expect(cardIn(shot(), 'APP-2')).not.toHaveProperty('outputProblems');
});

// The review comments line on a Delivery card: counts from the database, never a word of a comment.
it('carries the review comment counts of a Delivery card, and none on a closed one', () => {
  addCard('APP-1', 'pr-watch', 'idle');
  addCard('APP-2', 'closed', 'idle');
  const say = (githubId: string, createdAt: string) => ({ kind: 'comment' as const, githubId, path: null, line: null, resolved: false, outdated: false, messages: [{ githubId, author: 'dana', body: 'Lower case the search, please.', createdAt }] });
  storeDiscussions(db, saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' }), 'pat', [say('I1', '2026-10-01T00:00:00Z'), say('I2', '2026-10-02T00:00:00Z')]);
  storeDiscussions(db, saveCardPull(db, 'APP-2', { repo: 'cook/recipes', number: 9, url: null, foundBy: 'branch' }), 'pat', [say('I3', '2026-10-01T00:00:00Z')]);
  applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 's', reason: 'r', reply: null }]);

  const snap = shot();
  expect(cardIn(snap, 'APP-1')?.feedback).toEqual({ toFix: 1, unread: 2 });
  expect(cardIn(snap, 'APP-2')).not.toHaveProperty('feedback');
  expect(JSON.stringify(snap)).not.toContain('Lower case');
});

// A phase that is not QA leaves the two columns empty, so the chip goes as soon as the card runs
// something else. The verdict was about the work as it stood then.
it('carries no verdict when the newest run decided none', () => {
  addCard('APP-1', 'qa', 'ready');
  saveVerdict(db, begin('APP-1'), { verdict: 'PASS', reason: null });
  begin('APP-1');

  const card = boardSnapshot(db, { wall: WALL, board, queue: createQueue(3), models: MODELS }).cards[0];

  expect(card?.verdict).toBeNull();
});

describe('a pull request card', () => {
  const prBoard = boardFor('prreview', 'pull-request');
  const pulls = () => boardSnapshot(db, { wall: WALL, board: prBoard, queue: createQueue(3), models: MODELS });

  it('carries the author, the decision and the head commit time to the board', () => {
    createCard(db, {
      key: 'recipes#42',
      board: 'prreview',
      stage: 'incoming',
      title: 'Cache the recipe list',
      source: 'github-pr',
      sourceRef: 'cook/recipes#42',
      pull: { author: 'dana', decision: 'CHANGES_REQUESTED', headCommittedAt: '2026-09-25T09:00:00.000Z', draft: true },
    });

    expect(cardIn(pulls(), 'recipes#42')?.pull).toEqual({
      author: 'dana',
      decision: 'CHANGES_REQUESTED',
      headCommittedAt: '2026-09-25T09:00:00.000Z',
      draft: true,
      // No round on a new card: only a review run writes one (`savePullRound`), and none ran here.
      round: null,
    });
  });

  // A card whose pull request closed stays on the board and says so. An open one carries no
  // word at all, which is what a board built from the hub draws as well.
  it.each(['closed', 'merged'] as const)('carries a pull request that %s', (ended) => {
    createCard(db, {
      key: 'recipes#43',
      board: 'prreview',
      stage: 'my-review',
      title: 'Show the cooking time',
      source: 'github-pr',
      sourceRef: 'cook/recipes#43',
      pull: { author: 'dana', decision: 'APPROVED', headCommittedAt: null, draft: false },
    });
    expect(cardIn(pulls(), 'recipes#43')?.pull).not.toHaveProperty('ended');

    db.prepare('UPDATE cards SET pr_state = ? WHERE key = ?').run(ended, 'recipes#43');

    expect(cardIn(pulls(), 'recipes#43')?.pull?.ended).toBe(ended);
  });

  it('carries no pull request for a card that was not made from one', () => {
    createCard(db, { key: 'APP-9', board: 'prreview', stage: 'incoming', title: 'Look at the queue' });

    expect(cardIn(pulls(), 'APP-9')?.pull).toBeNull();
  });

  // The round a review wrote and the head it read, then a read that saw the author push twice.
  it('carries the round, and the commits pushed since that round read the head', () => {
    createCard(db, {
      key: 'recipes#44',
      board: 'prreview',
      stage: 'awaiting-author',
      title: 'Add pagination to the recipe list',
      source: 'github-pr',
      sourceRef: 'cook/recipes#44',
      pull: { author: 'ben', decision: 'CHANGES_REQUESTED', headCommittedAt: null, draft: false, headSha: 'a1', commits: 3 },
    });
    expect(seenHead(db, 'recipes#44')).toEqual({ sha: 'a1', commits: 3 });

    savePullRound(db, 'recipes#44', 2, seenHead(db, 'recipes#44'));
    expect(cardIn(pulls(), 'recipes#44')?.pull).toMatchObject({ round: 2 });
    expect(cardIn(pulls(), 'recipes#44')?.pull).not.toHaveProperty('newCommits');

    db.prepare("UPDATE cards SET pr_seen_sha = 'c3', pr_seen_commits = 5 WHERE key = 'recipes#44'").run();
    expect(cardIn(pulls(), 'recipes#44')?.pull).toMatchObject({ round: 2, newCommits: 2 });
    expect(cardIn(pulls(), 'recipes#44')?.stage).toBe('awaiting-author');
  });
});

describe('newCommitsOf', () => {
  const row = (seen: string | null, seenCount: number | null, head: string | null, headCount: number | null) => ({
    pr_seen_sha: seen,
    pr_seen_commits: seenCount,
    pr_head_sha: head,
    pr_head_commits: headCount,
  });

  it('counts the commits on top of the head the round read', () => {
    expect(newCommitsOf(row('b2', 4, 'a1', 3))).toBe(1);
    expect(newCommitsOf(row('c3', 7, 'a1', 3))).toBe(4);
  });

  // A head that moved is a push, whatever the count says.
  it('says 1 for a moved head whose count did not grow or is not known', () => {
    expect(newCommitsOf(row('b2', 3, 'a1', 3))).toBe(1);
    expect(newCommitsOf(row('b2', 2, 'a1', 3))).toBe(1);
    expect(newCommitsOf(row('b2', null, 'a1', null))).toBe(1);
  });

  it('says nothing for the head the round read, before any round, and before any read', () => {
    expect(newCommitsOf(row('a1', 3, 'a1', 3))).toBeNull();
    expect(newCommitsOf(row('a1', 3, null, null))).toBeNull();
    expect(newCommitsOf(row(null, null, 'a1', 3))).toBeNull();
  });
});

// An epic delivers its tasks, and the epic card says how many are done. A task is a Delivery
// card linked to the epic, because `card_links` is what the epic writes and it stores no direction.
describe('an epic and its tasks', () => {
  const epics = boardFor('epics', 'pull-request');
  const epicShot = () => boardSnapshot(db, { wall: WALL, board: epics, queue: createQueue(3), models: MODELS });
  const delivered = (key: string) => cardIn(epicShot(), key)?.delivered;

  const addEpic = (key: string) =>
    db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'epics', 'inbox', 'idle', ?)").run(key, `${key} title`);
  // Wrap-up, so one real move closes the card. Every task of a fresh epic starts in the inbox.
  const addTask = (epic: string, key: string, stage = 'inbox') => {
    db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);
    linkCards(db, epic, key);
  };

  it('counts the Delivery cards linked to it', () => {
    addEpic('APP-1');
    addTask('APP-1', 'APP-2');
    addTask('APP-1', 'APP-3');
    addTask('APP-1', 'APP-4');

    expect(delivered('APP-1')).toEqual({ done: 0, total: 3 });
  });

  it('follows the count as each task closes', async () => {
    addEpic('APP-1');
    for (const key of ['APP-2', 'APP-3', 'APP-4']) addTask('APP-1', key, 'wrapup');

    expect(delivered('APP-1')).toEqual({ done: 0, total: 3 });
    // Through moveCard, which is the only writer of a stage in the product.
    await moveCard(db, board, 'APP-2', 'closed', vi.fn());
    expect(delivered('APP-1')).toEqual({ done: 1, total: 3 });
    await moveCard(db, board, 'APP-3', 'closed', vi.fn());
    await moveCard(db, board, 'APP-4', 'closed', vi.fn());
    expect(delivered('APP-1')).toEqual({ done: 3, total: 3 });
  });

  // The link row goes with the card, because card_links cascades from both sides. So the total
  // drops to what is still there: 1 of 2 is the honest answer once the third card is gone.
  it('stays honest after a Delivery card is deleted', () => {
    addEpic('APP-1');
    addTask('APP-1', 'APP-2', 'closed');
    addTask('APP-1', 'APP-3');
    addTask('APP-1', 'APP-4');

    db.prepare('DELETE FROM cards WHERE key = ?').run('APP-4');

    expect(delivered('APP-1')).toEqual({ done: 1, total: 2 });
    expect(db.prepare('SELECT count(*) AS n FROM card_links').get()).toEqual({ n: 2 });
  });

  it('says nothing at all about an epic with no tasks', () => {
    addEpic('APP-1');

    // Not 0 of 0, which reads as an epic that is finished.
    expect(delivered('APP-1')).toBeNull();
  });

  // The two filters of `epicTasks` hide each other, so this is the case that needs both: a Delivery
  // card linked to another Delivery card, read on the DELIVERY board. With the epic-side filter gone
  // the query answers for a Delivery key, and with the call-site guard gone that answer is looked up,
  // and the card draws a task count it has no business having.
  it('puts no task count on a Delivery card linked to another Delivery card', () => {
    const delivery = boardFor('delivery', 'pull-request');
    db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-8', 'delivery', 'inbox', 'idle', 'one')").run();
    db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-9', 'delivery', 'inbox', 'idle', 'two')").run();
    linkCards(db, 'APP-8', 'APP-9');

    const shot = boardSnapshot(db, { wall: WALL, board: delivery, queue: createQueue(3), models: MODELS });

    expect(cardIn(shot, 'APP-8')?.delivered).toBeNull();
    expect(cardIn(shot, 'APP-9')?.delivered).toBeNull();
  });

  it('leaves out a linked card that is not on the Delivery board', () => {
    addEpic('APP-1');
    addEpic('APP-2');
    linkCards(db, 'APP-1', 'APP-2');

    expect(delivered('APP-1')).toBeNull();
  });

  it('keeps two epics apart', () => {
    addEpic('APP-1');
    addEpic('APP-2');
    addTask('APP-1', 'APP-3', 'closed');
    addTask('APP-2', 'APP-4');
    addTask('APP-2', 'APP-5');

    expect(delivered('APP-1')).toEqual({ done: 1, total: 1 });
    expect(delivered('APP-2')).toEqual({ done: 0, total: 2 });
  });

  it('carries no count on a Delivery card', () => {
    addEpic('APP-1');
    addTask('APP-1', 'APP-2');

    expect(cardIn(shot(), 'APP-2')?.delivered).toBeNull();
  });

  // The epic card's chips: each task key with its state, joined from the links.
  describe('the In delivery card', () => {
    const toInDelivery = (key: string) => db.prepare("UPDATE cards SET stage = 'in-delivery' WHERE key = ?").run(key);
    const withPlan = (steps: Record<string, readonly string[]>) =>
      boardSnapshot(db, { wall: WALL, board: epics, queue: createQueue(3), models: MODELS, planned: (key) => steps[key] ?? null });

    it('carries each task key and its Delivery state, from the links, oldest first', () => {
      addEpic('APP-1');
      addTask('APP-1', 'APP-3', 'closed');
      addTask('APP-1', 'APP-2', 'plan');
      db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-2'").run();
      // A card whose title names an epic's task is not one of its tasks. Only a link makes it one.
      db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-9', 'delivery', 'inbox', 'idle', 'APP-1 task')").run();

      expect(cardIn(epicShot(), 'APP-1')?.tasks).toEqual([
        { key: 'APP-3', title: 'APP-3 title', state: 'idle', done: true },
        { key: 'APP-2', title: 'APP-2 title', state: 'blocked', done: false },
      ]);
      expect(delivered('APP-1')).toEqual({ done: 1, total: 2 });
    });

    it('gives each epic only its own links, and not a link between two Delivery cards', () => {
      addEpic('APP-1');
      addEpic('APP-5');
      addTask('APP-1', 'APP-2', 'closed');
      addTask('APP-5', 'APP-6');
      addTask('APP-5', 'APP-7');
      // Two Delivery cards linked to each other belong to no epic.
      linkCards(db, 'APP-2', 'APP-6');

      const snap = epicShot();

      expect(cardIn(snap, 'APP-1')?.tasks?.map((task) => task.key)).toEqual(['APP-2']);
      expect(cardIn(snap, 'APP-5')?.tasks?.map((task) => task.key)).toEqual(['APP-6', 'APP-7']);
      expect(cardIn(snap, 'APP-1')?.delivered).toEqual({ done: 1, total: 1 });
    });

    it('carries no tasks on an epic with no links', () => {
      addEpic('APP-1');

      expect(cardIn(epicShot(), 'APP-1')).not.toHaveProperty('tasks');
    });

    // A step of the plan not added to Delivery yet is a task the epic still has to deliver.
    it('counts a step of the plan not added yet, and gives it no chip', () => {
      addEpic('APP-1');
      toInDelivery('APP-1');
      addTask('APP-1', 'APP-2', 'closed');

      const card = cardIn(withPlan({ 'APP-1': ['APP-2 title', 'Print a shopping list'] }), 'APP-1');

      expect(card?.delivered).toEqual({ done: 1, total: 2 });
      expect(card?.tasks?.map((task) => task.key)).toEqual(['APP-2']);
      expect(card).not.toHaveProperty('finished');
    });

    // The person retitled the task before adding it, and the link kept the step it was made from.
    it('counts a retitled task as the step its link kept, and not that step a second time', () => {
      addEpic('APP-1');
      toInDelivery('APP-1');
      addTask('APP-1', 'APP-2');
      db.prepare("UPDATE card_links SET step = 'Add a recipe' WHERE a = 'APP-1' AND b = 'APP-2'").run();

      const card = cardIn(withPlan({ 'APP-1': ['Add a recipe', 'Print a shopping list'] }), 'APP-1');

      expect(card?.delivered).toEqual({ done: 0, total: 2 });
      expect(card?.tasks?.[0]).toMatchObject({ key: 'APP-2', step: 'Add a recipe' });
    });

    it('counts an epic in In delivery with a plan and no task added yet', () => {
      addEpic('APP-1');
      toInDelivery('APP-1');

      expect(cardIn(withPlan({ 'APP-1': ['Add a recipe', 'Print a shopping list'] }), 'APP-1')?.delivered).toEqual({ done: 0, total: 2 });
    });

    it('reads no plan for an epic outside In delivery', () => {
      addEpic('APP-1');
      addTask('APP-1', 'APP-2');
      const planned = vi.fn(() => ['APP-2 title', 'Print a shopping list']);

      const card = cardIn(boardSnapshot(db, { wall: WALL, board: epics, queue: createQueue(3), models: MODELS, planned }), 'APP-1');

      expect(planned).not.toHaveBeenCalled();
      expect(card?.delivered).toEqual({ done: 0, total: 1 });
    });

    // Wrap-up starts an agent, so the epic does not move there by itself.
    it('stays in In delivery when its last task closes, and waits on the person', async () => {
      addEpic('APP-1');
      toInDelivery('APP-1');
      for (const key of ['APP-2', 'APP-3']) addTask('APP-1', key, 'wrapup');
      await moveCard(db, board, 'APP-2', 'closed', vi.fn());
      expect(cardIn(epicShot(), 'APP-1')).not.toHaveProperty('finished');

      const startRun = vi.fn();
      await moveCard(db, board, 'APP-3', 'closed', startRun);

      const card = cardIn(epicShot(), 'APP-1');
      expect(card).toMatchObject({ stage: 'in-delivery', state: 'idle', delivered: { done: 2, total: 2 }, finished: true });
      expect(startRun).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS n FROM card_events WHERE card_key = 'APP-1'").get()).toEqual({ n: 0 });
    });

    it('is not finished outside In delivery, even with every task closed', () => {
      addEpic('APP-1');
      addTask('APP-1', 'APP-2', 'closed');
      db.prepare("UPDATE cards SET stage = 'done' WHERE key = 'APP-1'").run();

      expect(cardIn(epicShot(), 'APP-1')).not.toHaveProperty('finished');
    });
  });
});

// The estimate rides on the descriptor, so the drop box, the confirm and the card's own starts
// read one figure.
describe('the estimate a start carries', () => {
  // Five completed first runs of implement on what the default preset starts it on.
  const implementHistory = () => {
    [4, 6, 8, 10, 12].forEach((minutes, at) => {
      const id = begin(`APP-${at + 1}`);
      report(id, { state: 'complete', cardState: 'ready', costUsd: 0.2 + at / 10 });
      const ended = new Date(Date.parse('2026-10-01T10:00:00.000Z') + minutes * 60_000).toISOString();
      db.prepare("UPDATE runs SET started_at = '2026-10-01T10:00:00.000Z', ended_at = ? WHERE id = ?").run(ended, id);
    });
  };

  it('carries the preset range on refine with no history, and nothing where nothing measured it', () => {
    const stages = shot().stages;

    expect(stages.find((stage) => stage.id === 'refine')?.starts?.estimate).toEqual({ costUsd: 0.048, lowMs: 21_000, highMs: 21_000, from: 'preset', runs: 0 });
    expect(stages.find((stage) => stage.id === 'plan')?.starts?.estimate).toBeUndefined();
  });

  it('carries the history of this project once it has enough runs', () => {
    implementHistory();

    expect(shot().stages.find((stage) => stage.id === 'implement')?.starts?.estimate).toEqual({
      costUsd: 0.4,
      lowMs: 6 * 60_000,
      highMs: 10 * 60_000,
      from: 'history',
      runs: 5,
    });
  });

  it('carries none on a start that is refused', () => {
    implementHistory();

    // sonnet is gone, so the stage refuses the drop and has nothing to cost.
    const snap = shot(createQueue(3), { 'claude-code': ['haiku', 'opus'] });

    expect(snap.stages.find((stage) => stage.id === 'implement')?.starts?.estimate).toBeUndefined();
  });

  it('reads the figure of what the card itself starts on', () => {
    implementHistory();
    writeSetting(db, 'models', { implement: { model: 'opus', effort: 'high' } });
    addCard('APP-9', 'plan', 'ready');
    setCardModels(db, 'APP-9', { implement: { engine: 'claude-code', model: 'sonnet', effort: 'medium' } });

    const snap = shot();

    // The project runs opus, which nothing measured here. The card runs sonnet, which has five runs.
    expect(snap.stages.find((stage) => stage.id === 'implement')?.starts?.estimate).toBeUndefined();
    expect(cardIn(snap, 'APP-9')?.starts?.implement?.estimate).toMatchObject({ from: 'history', runs: 5 });
  });
});

// The browser counts Quiet from the setting, so it travels with the board.
it('carries the quiet time from the settings', () => {
  expect(shot().quietAfterMs).toBe(5 * 60_000);

  writeSetting(db, 'quietAfterMs', 10 * 60_000);

  expect(shot().quietAfterMs).toBe(10 * 60_000);
});
