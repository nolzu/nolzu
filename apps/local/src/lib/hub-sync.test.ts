import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScoutSource, allRuns, checkPasteSource, dismissScoutFinding, saveCardPull, saveQuestionOptions, scoutFindings, startRun, storeDiscussions, writeSetting } from '@nolzu/core/node';
import { ENGINE_NAMES, type HubEnvelope, isBoardKind, PULL_STATES, SUMMARY_CAP, readFindingResults, readRunCosts, type RunCosts } from '@nolzu/protocol';
import type { HubSocket, Keychain } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeHubLink, startHubLink } from './hub-link.ts';
import { createHubSync, EVIDENCE_DAYS_ON_OPEN, RUN_FAILED, runCostOf, startOf } from './hub-sync.ts';
import { createLoop, type Loop } from './loop.ts';

// The cloud waits for the paid plans (`packages/protocol/src/soon.ts`). This file pins the code kept for
// then, and cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true, SCOUT_AND_EVIDENCE: true }));

// The board and the evidence going up to the person's own hub. No test opens a socket: the
// hub-link tests drive a stub hub by hand, and the rest records what the sender hands over.

let dir = '';
let live: Loop;
let lines: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-hub-sync-'));
  lines = [];
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
});

afterEach(() => {
  closeHubLink();
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/*
 * The shape the hub reads, kept by hand so a rename on either side turns this red. Board fields
 * for cards, pull requests, events, runs and tokens, and block fields for blocks and spend. `need` is a field the hub
 * refuses the frame without, `text` may be null, `count` is a whole number at or above zero or null,
 * `cost` a number at or above zero or null.
 * `pullState` is a word `readPullState` in the protocol package takes, or nothing at all: the sender
 * leaves it out when the card has no state, and a hub on an older pin does not read it.
 * `start`, `summary` and `options` are the newer fields. Today's hub reads none of
 * them, so each may be left out, and a hub that reads them later finds them of these kinds.
 */
type Rule = 'need' | 'text' | 'string' | 'id' | 'count' | 'needCount' | 'cost' | 'flag' | 'object' | 'pullState' | 'start' | 'summary' | 'options';
const OPTIONAL: readonly Rule[] = ['pullState', 'start', 'summary', 'options'];
const CARD: Record<string, Rule> = { key: 'need', title: 'string', stage: 'need', state: 'need', source: 'need', sourceRef: 'text', pull: 'object', start: 'start' };
const PULL: Record<string, Rule> = { author: 'text', decision: 'need', headCommittedAt: 'text', draft: 'flag', state: 'pullState' };
const EVENT: Record<string, Rule> = { id: 'id', cardKey: 'need', fromStage: 'text', toStage: 'need', who: 'need', at: 'need', startedPhase: 'text' };
const RUN: Record<string, Rule> = {
  id: 'id',
  cardKey: 'need',
  phase: 'need',
  engine: 'need',
  model: 'text',
  effort: 'text',
  state: 'text',
  lane: 'text',
  attempt: 'count',
  startedAt: 'text',
  endedAt: 'text',
  question: 'text',
  error: 'text',
  verdict: 'text',
  verdictReason: 'text',
  costUsd: 'cost',
  durationMs: 'count',
  tokens: 'object',
  summary: 'summary',
  questionOptions: 'options',
};
const TOKENS: Record<string, Rule> = { input: 'count', output: 'count', cacheRead: 'count', cacheCreation: 'count' };
const BLOCK: Record<string, Rule> = {
  start: 'need',
  source: 'need',
  ref: 'need',
  card: 'text',
  cardTitle: 'text',
  description: 'need',
  durationMs: 'count',
  spend: 'object',
  running: 'flag',
};
const SPEND: Record<string, Rule> = {
  runs: 'needCount',
  reported: 'needCount',
  costUsd: 'cost',
  tokensOnly: 'needCount',
  tokens: 'count',
  durationMs: 'needCount',
  partial: 'flag',
};
// `pr_decision` and `evidence.source` carry a check on the hub, so the reader refuses a word
// outside these lists.
const DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'];
const SOURCES = ['run', 'move', 'commit'];

const fits = (value: unknown, rule: Rule): boolean => {
  const absent = value === null || value === undefined;
  const isText = typeof value === 'string';
  const whole = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  switch (rule) {
    case 'need':
      return isText && value.trim() !== '';
    case 'text':
      return absent || isText;
    case 'string':
      return isText;
    case 'id':
      return whole && (value as number) >= 1;
    case 'count':
      return absent || whole;
    case 'needCount':
      return whole;
    case 'cost':
      return absent || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    case 'flag':
      return typeof value === 'boolean';
    case 'object':
      return absent || (typeof value === 'object' && !Array.isArray(value));
    case 'pullState':
      return absent || (PULL_STATES as readonly unknown[]).includes(value);
    case 'summary':
      return value === undefined || (isText && value !== '' && value.length <= SUMMARY_CAP);
    case 'options':
      return value === undefined || (Array.isArray(value) && value.every((one) => typeof one?.label === 'string' && typeof one?.means === 'string'));
    case 'start': {
      if (value === undefined) return true;
      const start = value as Record<string, unknown>;
      return (
        Object.keys(start).every((field) => ['phase', 'engine', 'model', 'effort', 'estimate'].includes(field)) &&
        (ENGINE_NAMES as readonly unknown[]).includes(start.engine) &&
        typeof start.phase === 'string' &&
        typeof start.model === 'string' &&
        typeof start.effort === 'string'
      );
    }
  }
};

// Every field the hub reads is there and of its kind, and nothing travels that the hub does not read.
// A pull request state, `start`, `summary` and `options` are the ones a sender may leave out.
function accepts(row: unknown, shape: Record<string, Rule>): void {
  const raw = row as Record<string, unknown>;
  const sent = Object.keys(shape).filter((field) => !OPTIONAL.includes(shape[field] as Rule) || field in raw);
  expect(Object.keys(raw).sort()).toEqual(sent.sort());
  for (const [field, rule] of Object.entries(shape)) expect(fits(raw[field], rule), `${field} is ${JSON.stringify(raw[field])}`).toBe(true);
}

function hubReadsCardState(payload: unknown): void {
  const raw = payload as { kind: string; cards: unknown[]; events: unknown[]; runs: unknown[] };
  expect(Object.keys(raw).sort()).toEqual(['cards', 'events', 'kind', 'runs']);
  // The hub's own guard on the board name is `isBoardKind` from the protocol package.
  expect(isBoardKind(raw.kind)).toBe(true);
  for (const card of raw.cards) {
    accepts(card, CARD);
    const pull = (card as { pull: { decision: string } | null }).pull;
    if (pull !== null) {
      accepts(pull, PULL);
      expect(DECISIONS).toContain(pull.decision);
    }
  }
  for (const event of raw.events) accepts(event, EVENT);
  for (const run of raw.runs) {
    accepts(run, RUN);
    const tokens = (run as { tokens: unknown }).tokens;
    if (tokens !== null) accepts(tokens, TOKENS);
  }
}

function hubReadsEvidence(payload: unknown): void {
  const raw = payload as { blocks: unknown[] };
  expect(Object.keys(raw)).toEqual(['blocks']);
  for (const block of raw.blocks) {
    accepts(block, BLOCK);
    expect(SOURCES).toContain((block as { source: string }).source);
    expect((block as { start: string }).start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const spend = (block as { spend: unknown }).spend;
    if (spend !== null) accepts(spend, SPEND);
  }
}

// What the sender handed over, in order, and a switch to make the socket refuse.
function recorder() {
  const frames: { type: string; payload: unknown }[] = [];
  const wire = { open: true };
  const send = (type: string, payload: unknown): boolean => {
    if (!wire.open) return false;
    frames.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    return true;
  };
  return { frames, wire, send };
}

const db = () => live.db;
const addCard = (key: string) => db().prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', 'inbox', 'idle', ?)").run(key, `${key} title`);
const move = (key: string, from: string | null, to: string, phase: string | null) => {
  db().prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase) VALUES (?, ?, ?, 'you', ?)").run(key, from, to, phase);
  db().prepare('UPDATE cards SET stage = ? WHERE key = ?').run(to, key);
};
const endRun = (id: number, cost: number) =>
  db()
    .prepare(
      "UPDATE runs SET state = 'complete', started_at = strftime('%Y-%m-%dT%H:%M:%fZ'), ended_at = strftime('%Y-%m-%dT%H:%M:%fZ'), cost_estimate = ?, duration_ms = 1200, tokens_input = 10, tokens_output = 5, tokens_cache_read = 0, tokens_cache_creation = 0, log_path = '/private/run.log', session_id = 'kept-here', result = 'the transcript' WHERE id = ?",
    )
    .run(cost, id);

it('drives one card from inbox to closed in frames the hub reads, and resends nothing that did not change', () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  addCard('APP-1');
  db().prepare("UPDATE cards SET summary = 'the card summary', extra_context = 'the extra context' WHERE key = 'APP-1'").run();
  move('APP-1', null, 'inbox', null);
  sync.board();

  const stages = ['inbox', 'refine', 'plan', 'implement', 'qa', 'review', 'pr-watch', 'wrapup', 'closed'];
  const agent = new Set(['refine', 'plan', 'implement', 'qa', 'wrapup']);
  for (let at = 1; at < stages.length; at += 1) {
    const to = stages[at] as string;
    move('APP-1', stages[at - 1] as string, to, agent.has(to) ? to : null);
    if (agent.has(to)) {
      const id = startRun(db(), { cardKey: 'APP-1', phase: to, engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '/private/run.log', lane: null });
      sync.board();
      endRun(id, 0.25);
      if (to === 'qa') db().prepare("UPDATE runs SET verdict = 'PASS', verdict_reason = 'All checks hold.' WHERE id = ?").run(id);
      // Engine limit state, which NEVER_SENT keeps on the machine.
      if (to === 'plan') db().prepare("UPDATE runs SET error = '5-hour limit, resets 19:00' WHERE id = ?").run(id);
    }
    sync.board();
  }

  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.type === 'card.state')).toBe(true);
  for (const frame of frames) hubReadsCardState(frame.payload);
  const all = frames.map((frame) => frame.payload as { cards: { stage: string }[]; events: unknown[]; runs: { verdict: string | null; error: string | null }[] });
  expect(all.at(-1)?.cards.at(-1)?.stage).toBe('closed');
  expect(all.flatMap((one) => one.events)).toHaveLength(stages.length);
  expect(all.flatMap((one) => one.runs).some((run) => run.verdict === 'PASS')).toBe(true);
  // What stays on the machine: the log path, the session id, the run's result text, the card's own
  // text and the failure reason. The hub learns only that the run failed.
  const wire = JSON.stringify(frames);
  for (const local of ['/private/run.log', 'kept-here', 'the transcript', 'the card summary', 'the extra context', 'limit']) expect(wire).not.toContain(local);
  expect(all.flatMap((one) => one.runs).filter((run) => run.error === RUN_FAILED).length).toBeGreaterThan(0);

  // A commit message pass stays on the machine, so the hub cannot take it for the card's newest run.
  const pass = startRun(db(), { cardKey: 'APP-1', phase: 'commit-message', engine: 'claude', model: 'haiku', effort: null, sessionId: null, logPath: '', lane: null });
  endRun(pass, 0.01);
  sync.board();
  expect(JSON.stringify(frames)).not.toContain('commit-message');
  // So does the pass that names an Ask discussion.
  const title = startRun(db(), { cardKey: 'APP-1', phase: 'thread-title', engine: 'claude', model: 'haiku', effort: null, sessionId: null, logPath: '', lane: null, thread: 'ask' });
  endRun(title, 0.001);
  sync.board();
  expect(JSON.stringify(frames)).not.toContain('thread-title');

  // The same board read again changes nothing, so it sends nothing.
  const before = frames.length;
  expect(sync.board()).toEqual([]);
  expect(frames).toHaveLength(before);
});

// An Ask run never speaks for its card, so the team board cannot take it for the
// card's newest run either. The card and its phase run still go.
it('keeps an Ask run on the machine and sends the card and its phase run', () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  addCard('APP-1');
  move('APP-1', null, 'inbox', null);
  const plan = startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });
  endRun(plan, 0.1);
  const asked = startRun(db(), { cardKey: 'APP-1', phase: 'ask', engine: 'claude', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null, thread: 'ask' });
  endRun(asked, 0.01);

  sync.board();

  const runs = frames.flatMap((frame) => (frame.payload as { runs: { id: number; phase: string }[] }).runs);
  expect(runs.map((run) => [run.id, run.phase])).toEqual([[plan, 'plan']]);
});

// A triage reads the pull request's comments, and comment text stays on the machine, so its run goes
// with no summary, question or answers.
it('sends a triage run without its summary or question', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'feedback', engine: 'claude', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  db().prepare("UPDATE runs SET state = 'complete', question = 'Is dana right?', plain_summary = 'dana wants the search lower cased.' WHERE id = ?").run(id);
  saveQuestionOptions(db(), id, [{ label: 'Yes', means: 'Fix it' }]);
  createHubSync(db(), send).board();

  const runs = frames.flatMap((frame) => (frame.payload as { runs: Record<string, unknown>[] }).runs);
  expect(runs.map((run) => [run.phase, run.question, run.summary, run.questionOptions])).toEqual([['feedback', null, undefined, undefined]]);
  expect(JSON.stringify(frames)).not.toContain('dana');
});

// A Fix is an implement run that names the comment's ref, and its summary is about the comment too.
it('sends a Fix run without its summary or question, and a plain implement run with them', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  const fix = startRun(db(), { cardKey: 'APP-1', phase: 'implement', engine: 'claude', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null, thread: 'T2' });
  db().prepare("UPDATE runs SET state = 'complete', plain_summary = 'Lower cased the search, as dana asked.' WHERE id = ?").run(fix);
  const plain = startRun(db(), { cardKey: 'APP-1', phase: 'implement', engine: 'claude', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });
  db().prepare("UPDATE runs SET state = 'complete', plain_summary = 'The search box is there.' WHERE id = ?").run(plain);
  createHubSync(db(), send).board();

  const runs = frames.flatMap((frame) => (frame.payload as { runs: Record<string, unknown>[] }).runs);
  expect(runs.map((run) => [run.id, run.summary])).toEqual([
    [fix, undefined],
    [plain, 'The search box is there.'],
  ]);
  expect(JSON.stringify(frames)).not.toContain('dana');
});

// The board card's review comments line is local: the hub frame is built apart from the snapshot, so
// neither the counts nor a word of a comment reach it.
it('sends no review comment counts or text, though the local board has them', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  const pull = saveCardPull(db(), 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
  storeDiscussions(db(), pull, 'pat', [{ kind: 'comment', githubId: 'I1', path: null, line: null, resolved: false, outdated: false, messages: [{ githubId: 'I1', author: 'dana', body: 'Lower case the search.', createdAt: '2026-10-01T00:00:00Z' }] }]);
  expect(live.snapshot('delivery').cards.find((card) => card.key === 'APP-1')?.feedback).toEqual({ toFix: 0, unread: 1 });
  createHubSync(db(), send, { snapshot: live.snapshot }).board();

  const said = JSON.stringify(frames);
  expect(said).toContain('APP-1');
  expect(said).not.toContain('feedback');
  expect(said).not.toContain('Lower case');
});

it('keeps rows unsent while the socket is down, and sends the whole board after a reset', () => {
  const { frames, wire, send } = recorder();
  const sync = createHubSync(db(), send);
  addCard('APP-1');
  move('APP-1', null, 'inbox', null);
  sync.board();
  expect(frames).toHaveLength(1);

  wire.open = false;
  move('APP-1', 'inbox', 'refine', null);
  sync.board();
  wire.open = true;
  // The move that did not go is still owed, and the card that did go is not sent twice.
  sync.board();
  const owed = frames[1]?.payload as { cards: unknown[]; events: { toStage: string }[] };
  expect(owed.events.map((event) => event.toStage)).toEqual(['refine']);
  expect(owed.cards).toHaveLength(1);

  // A new socket starts from nothing, because the hub has no marks to send yet.
  sync.reset();
  sync.board();
  const whole = frames[2]?.payload as { cards: unknown[]; events: unknown[] };
  expect([whole.cards.length, whole.events.length]).toEqual([1, 2]);
});

// The phone and the web show the plain summary, the answers a blocked question
// offers and the next start, so those three ride on `card.state` to the person's own hub.
it('sends the capped summary, the answers a blocked question offers and the start line', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  addCard('APP-2');
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });
  db().prepare("UPDATE runs SET state = 'complete', question = 'Stars or thumbs?', plain_summary = '  Planned the recipe rating.  ' WHERE id = ?").run(id);
  db().prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
  saveQuestionOptions(db(), id, [{ label: '1 to 5 stars', means: 'A new column in recipes' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }]);
  createHubSync(db(), send, { snapshot: live.snapshot }).board();

  for (const frame of frames) hubReadsCardState(frame.payload);
  const runs = frames.flatMap((frame) => (frame.payload as { runs: Record<string, unknown>[] }).runs);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.question).toBe('Stars or thumbs?');
  expect(runs[0]?.summary).toBe('Planned the recipe rating.');
  expect(runs[0]?.questionOptions).toEqual([
    { label: '1 to 5 stars', means: 'A new column in recipes' },
    { label: 'Thumbs up and down', means: 'Reuses the likes table' },
  ]);

  // The idle card offers its next step, as the board resolved it. The blocked one offers none.
  const cards = frames.flatMap((frame) => (frame.payload as { cards: { key: string; start?: unknown }[] }).cards);
  const refine = live.snapshot('delivery').stages.find((stage) => stage.id === 'refine')?.starts;
  expect(refine?.modelState).toBe('ok');
  expect(cards.find((card) => card.key === 'APP-2')?.start).toEqual({
    phase: 'refine',
    engine: 'claude-code',
    model: refine?.model,
    effort: refine?.effort,
    ...(refine?.estimate === undefined ? {} : { estimate: refine.estimate }),
  });
  expect(cards.find((card) => card.key === 'APP-1')).not.toHaveProperty('start');
});

// The answers ride beside the question they answer. A run that was answered no longer has one.
it('sends no answers for a run that holds no question', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });
  db().prepare("UPDATE runs SET state = 'complete', question = NULL WHERE id = ?").run(id);
  saveQuestionOptions(db(), id, [{ label: '1 to 5 stars', means: 'A new column in recipes' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }]);
  createHubSync(db(), send, { snapshot: live.snapshot }).board();

  const runs = frames.flatMap((frame) => (frame.payload as { runs: Record<string, unknown>[] }).runs);
  expect(runs).toHaveLength(1);
  expect(runs[0]).not.toHaveProperty('questionOptions');
});

// A failed card retries its own stage, an idle one starts the next, and a start the board would refuse
// (a model that is gone, an engine with no known vendor, a card past the last stage) is left off.
it('reads the start of a failed card off its own stage, and none that would be refused', () => {
  addCard('APP-1');
  db().prepare("UPDATE cards SET stage = 'refine', state = 'failed' WHERE key = 'APP-1'").run();
  const board = live.snapshot('delivery');
  const refine = board.stages.find((stage) => stage.id === 'refine')?.starts;
  expect(refine?.modelState).toBe('ok');
  const vendors = new Map([[refine?.engine ?? '', 'claude-code' as const]]);

  expect(startOf(board, 'APP-1', vendors)?.phase).toBe('refine');
  expect(startOf(board, 'APP-1', new Map())).toBeUndefined();
  const gone = { ...board, stages: board.stages.map((stage) => (stage.starts === null ? stage : { ...stage, starts: { ...stage.starts, modelState: 'gone' as const } })), cards: board.cards.map((card) => ({ ...card, starts: {} })) };
  expect(startOf(gone, 'APP-1', vendors)).toBeUndefined();
  const last = board.stages.at(-1)?.id ?? '';
  const done = { ...board, cards: board.cards.map((card) => ({ ...card, stage: last, state: 'idle' as const })) };
  expect(startOf(done, 'APP-1', vendors)).toBeUndefined();
  expect(startOf(board, 'APP-9', vendors)).toBeUndefined();
});

it('cuts a long plain summary to 600 characters on a word', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });
  db().prepare("UPDATE runs SET state = 'complete', plain_summary = ? WHERE id = ?").run('Whisk the eggs. '.repeat(60), id);
  createHubSync(db(), send).board();

  const summary = frames.flatMap((frame) => (frame.payload as { runs: { summary?: string }[] }).runs)[0]?.summary ?? '';
  expect(summary.length).toBeLessThanOrEqual(600);
  expect(summary.length).toBeGreaterThan(580);
  expect(summary).toMatch(/ (Whisk|the|eggs\.)…$/);
});

// What stays on the machine: plan steps, paths, logs and the usage window. Each is put where
// the client keeps it, with words of its own, and none reaches the frame. Tool activity has its own
// test below, with a run that prints a line.
it('sends no plan step, path or usage window', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  mkdirSync(join(dir, '.tasks', 'APP-1', 'plan'), { recursive: true });
  writeFileSync(join(dir, '.tasks', 'APP-1', 'plan', 'plan.md'), '1. Fold in the plan-step-flour.\n');
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '/private/path-on-machine/run.log', lane: null });
  db().prepare("UPDATE runs SET state = 'running', cwd = '/private/path-on-machine/checkout' WHERE id = ?").run(id);
  writeSetting(db(), 'engineLimits', { 'claude-code': { seenAt: 1_760_000_000_000, windows: [{ name: 'usage-window-five-hour', used: 0.62, resetsAt: 1_760_018_000, status: 'allowed' }], card: 'APP-1' } });
  createHubSync(db(), send, { snapshot: live.snapshot }).board();

  expect(frames.length).toBeGreaterThan(0);
  const wire = JSON.stringify(frames);
  for (const local of ['plan-step-flour', 'path-on-machine', 'usage-window', '0.62']) expect(wire).not.toContain(local);
});

// The team socket gets no run rows, so no question, and the answers offered with it stay home too.
it('sends the team socket neither the question nor the answers offered with it', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });
  db().prepare("UPDATE runs SET state = 'complete', question = 'Stars or thumbs?' WHERE id = ?").run(id);
  saveQuestionOptions(db(), id, [{ label: '1 to 5 stars', means: 'A new column in recipes' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }]);
  createHubSync(db(), send, { runs: false }).board();

  expect(frames.length).toBeGreaterThan(0);
  const wire = JSON.stringify(frames);
  for (const local of ['Stars or thumbs?', '1 to 5 stars', 'A new column', 'Thumbs up and down', 'likes table']) expect(wire).not.toContain(local);
});

it('splits a long history over frames the socket can carry', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  for (let at = 0; at < 450; at += 1) move('APP-1', null, 'inbox', null);
  createHubSync(db(), send).board();

  const sizes = frames.map((frame) => {
    const payload = frame.payload as { cards: unknown[]; events: unknown[] };
    return payload.cards.length + payload.events.length;
  });
  expect(sizes).toEqual([200, 200, 51]);
});

it('sends the evidence of a day in blocks the hub reads, and a resend of the same day sends nothing', async () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  addCard('APP-1');
  move('APP-1', null, 'inbox', null);
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'refine', engine: 'claude', model: null, effort: null, sessionId: null, logPath: '', lane: null });
  endRun(id, 0.4);

  const days = sync.board();
  const started = (db().prepare('SELECT started_at FROM runs WHERE id = ?').get(id) as { started_at: string }).started_at;
  expect(days).toEqual([started.slice(0, 10)]);
  frames.length = 0;
  await sync.evidence(days);

  expect(frames.map((frame) => frame.type)).toEqual(['evidence.blocks']);
  hubReadsEvidence(frames[0]?.payload);
  const blocks = (frames[0]?.payload as { blocks: { source: string }[] }).blocks;
  expect(blocks.map((block) => block.source).sort()).toEqual(['move', 'run']);

  await sync.evidence(days);
  expect(frames).toHaveLength(1);
});

it('keeps evidence unsent while the socket is down', async () => {
  const { frames, wire, send } = recorder();
  const sync = createHubSync(db(), send);
  addCard('APP-1');
  move('APP-1', null, 'inbox', null);
  const days = sync.board();
  frames.length = 0;

  wire.open = false;
  await sync.evidence(days);
  wire.open = true;
  await sync.evidence(days);
  expect(frames.map((frame) => frame.type)).toEqual(['evidence.blocks']);
});

// The hub files a card under the board the frame names, and refuses a whole frame with a board it
// does not know.
it('sends a card under its own board with its pull request, and keeps a card of an unknown board here', () => {
  const { frames, send } = recorder();
  addCard('APP-1');
  db().prepare("UPDATE cards SET board = 'epics', pr_author = 'ana', pr_decision = 'APPROVED', pr_draft = 1 WHERE key = 'APP-1'").run();
  db().prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('ODD-1', 'someday', 'inbox', 'idle', 'odd')").run();
  createHubSync(db(), send).board();

  expect(frames).toHaveLength(1);
  hubReadsCardState(frames[0]?.payload);
  const payload = frames[0]?.payload as { kind: string; cards: { key: string; pull: unknown }[] };
  expect(payload.kind).toBe('epics');
  expect(payload.cards.map((card) => card.key)).toEqual(['APP-1']);
  expect(payload.cards[0]?.pull).toEqual({ author: 'ana', decision: 'APPROVED', headCommittedAt: null, draft: true });
});

// Two lines of two events, as one paste check leaves them.
const TWO = 'TypeError: cart is undefined at line 12\nTimeout after 5000ms calling /api/recipes';
const pasted = (): number => {
  const source = addScoutSource(db(), { kind: 'paste', label: 'Kitchen logs only-here' });
  expect(checkPasteSource(db(), source, TWO).added).toBe(2);
  return source;
};
// Every field `FindingResult` names, and nothing else.
const FINDING_FIELDS = ['cardKey', 'externalKey', 'fingerprint', 'firstSeen', 'kind', 'lastSeen', 'location', 'occurrences', 'sourceId', 'status'];

it('sends a check that found two issues as one frame the protocol reader accepts, and resends nothing that did not change', () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  writeSetting(db(), 'projectId', 'p-1');
  const source = pasted();
  sync.findings();

  expect(frames.map((frame) => frame.type)).toEqual(['finding.results']);
  const read = readFindingResults(frames[0]?.payload);
  expect(read.projectId).toBe('p-1');
  expect(read.findings).toHaveLength(2);
  // The lines the source reported stay on this machine: a pasted line can hold a token.
  for (const line of TWO.split('\n')) expect(JSON.stringify(frames)).not.toContain(line);
  expect(read.findings.every((one) => one.sourceId === source && one.status === 'new' && one.occurrences === 1)).toBe(true);
  // What the Data sync line names and no more: no local row id, and nothing of the source itself.
  for (const one of (frames[0]?.payload as { findings: object[] }).findings) expect(Object.keys(one).sort()).toEqual(FINDING_FIELDS);
  expect(Object.keys(frames[0]?.payload as object).sort()).toEqual(['findings', 'projectId']);
  expect(JSON.stringify(frames)).not.toContain('only-here');

  sync.findings();
  expect(frames).toHaveLength(1);
});

it('sends a muted finding as dismissed, alone', () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  writeSetting(db(), 'projectId', 'p-1');
  const source = pasted();
  sync.findings();
  const muted = scoutFindings(db(), source)[0];
  expect(dismissScoutFinding(db(), muted?.id ?? 0)).toBe(true);
  sync.findings();

  const sent = readFindingResults(frames[1]?.payload).findings;
  expect(sent.map((one) => [one.fingerprint, one.status])).toEqual([[muted?.fingerprint, 'dismissed']]);
});

// One event in two sources has one fingerprint, and each is its own row up there.
it('sends the same event of two sources once each, and not again', () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  writeSetting(db(), 'projectId', 'p-1');
  pasted();
  pasted();
  sync.findings();
  sync.findings();

  expect(frames).toHaveLength(1);
  expect(readFindingResults(frames[0]?.payload).findings).toHaveLength(4);
});

it('splits many findings over frames of at most 200, each finding in one frame', () => {
  const { frames, send } = recorder();
  writeSetting(db(), 'projectId', 'p-1');
  const source = addScoutSource(db(), { kind: 'paste', label: 'Many' });
  const add = db().prepare("INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message) VALUES (?, ?, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z', 'x', 'x')");
  for (let at = 0; at < 451; at += 1) add.run(source, `f${at}`);
  createHubSync(db(), send).findings();

  expect(frames.map((frame) => readFindingResults(frame.payload).findings.length)).toEqual([200, 200, 51]);
});

// The personal hub keys a finding on this machine's own project, never on the team's id.
it('names its own project id on a machine that has joined a team', () => {
  const { frames, send } = recorder();
  const sync = createHubSync(db(), send);
  writeSetting(db(), 'projectId', 'p-1');
  writeSetting(db(), 'teamProjectId', 't-1');
  pasted();
  sync.findings();

  expect(readFindingResults(frames[0]?.payload).projectId).toBe('p-1');
});

it('keeps findings unsent while the socket is down, and sends none for a machine with no project id', () => {
  const { frames, wire, send } = recorder();
  const sync = createHubSync(db(), send);
  pasted();
  sync.findings();
  expect(frames).toEqual([]);

  writeSetting(db(), 'projectId', 'p-1');
  wire.open = false;
  sync.findings();
  wire.open = true;
  sync.findings();
  expect(readFindingResults(frames[0]?.payload).findings).toHaveLength(2);
});

/* Through the link itself, on a stub hub. */

interface Stub extends HubSocket {
  sent: string[];
}

const stub = (): Stub => {
  const socket: Stub = {
    onopen: null,
    onmessage: null,
    onclose: null,
    sent: [],
    send: (data) => {
      socket.sent.push(data);
    },
    close: () => {},
  };
  return socket;
};

const keychain = (token: string | null): Keychain => ({
  read: async (name) => (name === 'device-token' ? token : null),
  write: async () => undefined,
  remove: async () => undefined,
});

async function dial(token: string | null = 'stored-token'): Promise<Stub[]> {
  const made: Stub[] = [];
  startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain(token),
    socket: () => () => {
      const hub = stub();
      made.push(hub);
      return hub;
    },
    say: (line) => lines.push(line),
  });
  if (token !== null) await vi.waitFor(() => expect(made).toHaveLength(1));
  else await new Promise((resolve) => setTimeout(resolve, 0));
  return made;
}

const framesOf = (hub: Stub): HubEnvelope[] => hub.sent.map((text) => JSON.parse(text) as HubEnvelope);
const projectHere = () => writeSetting(db(), 'projectPath', join(dir, 'recipes'));
const fakeSpawn = (events: number) => {
  live.engine.spawn = async function* () {
    yield JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'sonnet', apiKeySource: 'none' });
    for (let at = 0; at < events; at += 1) yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${at}` }] } });
    yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
  };
};

it('registers the project first and sends the board after it, on the open of the socket', async () => {
  projectHere();
  addCard('APP-1');
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();

  const types = framesOf(hub).map((frame) => frame.type);
  expect(types.slice(0, 2)).toEqual(['project.sync', 'card.state']);
  hubReadsCardState(framesOf(hub)[1]?.payload);
  expect(lines).toEqual([]);
});

// A run reports a handful of state changes, and only those reach the hub. Two hundred streamed
// events cost exactly what two do.
it('sends a run on its state changes and not once per streamed event', async () => {
  projectHere();
  addCard('APP-1');
  addCard('APP-2');
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();

  const framesCarrying = (key: string) =>
    framesOf(hub).filter((frame) => frame.type === 'card.state' && (frame.payload as { runs: { cardKey: string; phase: string }[] }).runs.some((run) => run.cardKey === key && run.phase === 'refine')).length;
  const runEnded = (key: string) => () =>
    expect((db().prepare("SELECT ended_at FROM runs WHERE card_key = ? AND phase = 'refine'").get(key) as { ended_at: string | null } | undefined)?.ended_at).toBeTruthy();

  fakeSpawn(2);
  live.start('APP-1', 'refine');
  await vi.waitFor(runEnded('APP-1'));
  await vi.waitFor(() => expect(live.scheduler.queue().running).toHaveLength(0));

  fakeSpawn(200);
  live.start('APP-2', 'refine');
  await vi.waitFor(runEnded('APP-2'));
  await vi.waitFor(() => expect(live.scheduler.queue().running).toHaveLength(0));

  expect(framesCarrying('APP-1')).toBeGreaterThan(0);
  expect(framesCarrying('APP-2')).toBe(framesCarrying('APP-1'));
  for (const frame of framesOf(hub).filter((one) => one.type === 'card.state')) hubReadsCardState(frame.payload);
});

/**
 * The activity line names files and commands, so it stays on this machine.
 *
 * The fake refine reads `services/api/src/recipes/list.ts`, and the line the board stream gets is
 * made from that path. It reaches no frame the hub is sent, no snapshot (the shape meant for the
 * cloud) and no row of the database.
 */
it('sends the hub no activity line, and keeps it out of the snapshot and the database', async () => {
  // A real repository, so the card gets its checkout and the engine runs. The hub sends the board of
  // a machine with a project only.
  const project = join(dir, 'recipes');
  mkdirSync(project);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  projectHere();
  addCard('APP-1');
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();
  const heard: string[] = [];
  live.onActivity((activity) => {
    if (activity.line !== null) heard.push(activity.line);
  });
  const snapshots: string[] = [];
  live.onChange(() => snapshots.push(JSON.stringify(live.snapshot())));
  // The fake refine, held after its lines. No change fires while a run has a line, so the test makes
  // one, and the snapshot and the hub frames it brings are built while the line exists.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const fake = live.engine.spawn.bind(live.engine);
  live.engine.spawn = async function* (job, signal) {
    yield* fake(job, signal);
    if (job.phase === 'refine') await held;
  };

  live.start('APP-1', 'refine');
  const line = 'Reading services/api/src/recipes/list.ts';
  await vi.waitFor(() => expect(live.activity()[0]?.line).toBe(line));
  live.changed();
  release();
  await vi.waitFor(() => expect(live.snapshot().cards[0]?.state).toBe('ready'));

  // The line was made, so the checks below are about a line that exists.
  expect(heard).toContain(line);
  const cardStates = framesOf(hub).filter((frame) => frame.type === 'card.state');
  expect(cardStates.length).toBeGreaterThan(0);
  for (const frame of cardStates) hubReadsCardState(frame.payload);
  for (const text of hub.sent) expect(text).not.toContain('recipes/list.ts');
  expect(snapshots.length).toBeGreaterThan(0);
  for (const text of snapshots) expect(text).not.toContain('recipes/list.ts');
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  for (const { name } of tables) expect(JSON.stringify(db().prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain(line);
});

// The hub gets a frame only when a row changes, so the test above can pass with no frame sent while the
// line exists. Here a card row changes during the run, so a card.state frame goes out while it does.
it('sends no activity line in a card.state frame made while the run has one', async () => {
  const project = join(dir, 'recipes');
  mkdirSync(project);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  projectHere();
  addCard('APP-1');
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const fake = live.engine.spawn.bind(live.engine);
  live.engine.spawn = async function* (job, signal) {
    yield* fake(job, signal);
    if (job.phase === 'refine') await held;
  };

  live.start('APP-1', 'refine');
  // The run makes a real worktree first, which takes seconds on a busy machine.
  await vi.waitFor(() => expect(live.activity()[0]?.line).toBe('Reading services/api/src/recipes/list.ts'), { timeout: 10_000 });
  const before = hub.sent.length;
  db().prepare('UPDATE cards SET title = ? WHERE key = ?').run('Add a search box', 'APP-1');
  live.changed();
  await vi.waitFor(() => expect(framesOf(hub).slice(before).some((frame) => frame.type === 'card.state')).toBe(true));
  const during = hub.sent.slice(before);
  release();
  await vi.waitFor(() => expect(live.snapshot().cards[0]?.state).toBe('ready'), { timeout: 10_000 });

  expect(during.join('\n')).toContain('Add a search box');
  for (const text of during) expect(text).not.toContain('recipes/list.ts');
});

it('sends nothing and throws nothing on a machine with no account', async () => {
  projectHere();
  addCard('APP-1');
  const made = await dial(null);

  move('APP-1', null, 'inbox', null);
  expect(() => live.changed()).not.toThrow();
  expect(made).toEqual([]);
  expect(lines).toEqual([]);
});

// The plan gate is the hub's own: it closes a Free account's socket with the plan code. The socket is
// opened first here, so the close is the only thing that can stop the change below from going out.
it('sends nothing on a socket the plan closed', async () => {
  projectHere();
  addCard('APP-1');
  const made = await dial();
  const hub = made[0] as Stub;
  hub.onopen?.();
  const before = hub.sent.length;
  expect(before).toBeGreaterThan(0);
  hub.onclose?.({ code: 4402 });

  move('APP-1', null, 'inbox', null);
  live.changed();
  expect(hub.sent).toHaveLength(before);
  expect(made).toHaveLength(1);
});

it('sends no board on a socket that has not named its project', async () => {
  addCard('APP-1');
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();
  move('APP-1', null, 'inbox', null);
  live.changed();

  expect(hub.sent).toEqual([]);
});

// A stored project id is not enough: the hub refuses a finding from a socket that has not named its
// project, and a machine with no project folder names none.
it('sends no findings on a socket that has not named its project, even with a project id', async () => {
  writeSetting(db(), 'projectId', 'p-1');
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();
  pasted();
  live.changed();

  expect(hub.sent).toEqual([]);
});

// The settings actions tell the loop after a check, and the loop's change report is what sends.
it('sends the findings of a check on the next change report of an open socket', async () => {
  projectHere();
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();
  expect(framesOf(hub).some((frame) => frame.type === 'finding.results')).toBe(false);

  pasted();
  live.changed();
  const found = framesOf(hub).filter((frame) => frame.type === 'finding.results');
  expect(found).toHaveLength(1);
  expect(readFindingResults(found[0]?.payload).findings).toHaveLength(2);
});

it('sends the board again on a reconnect, and only the change after it', async () => {
  projectHere();
  addCard('APP-1');
  const made = await dial();
  const first = made[0] as Stub;
  first.onopen?.();
  first.onclose?.({ code: 1006 });
  await vi.waitFor(() => expect(made).toHaveLength(2), { timeout: 10_000 });
  const second = made[1] as Stub;
  second.onopen?.();

  const boards = (hub: Stub) => framesOf(hub).filter((frame) => frame.type === 'card.state');
  expect(boards(second).map((frame) => frame.payload)).toEqual(boards(first).map((frame) => frame.payload));

  move('APP-1', null, 'inbox', null);
  live.changed();
  const last = boards(second).at(-1)?.payload as { cards: unknown[]; events: unknown[] };
  expect([last.cards.length, last.events.length]).toEqual([0, 1]);
});

// A connect sends the last week of evidence and no older day, and a change after it sends the day it
// touched.
it('sends the evidence of the last week on open, and of the touched day on a change', async () => {
  projectHere();
  addCard('APP-1');
  const old = new Date(Date.now() - (EVIDENCE_DAYS_ON_OPEN + 3) * 86_400_000).toISOString();
  db().prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES ('APP-1', NULL, 'inbox', 'you', ?)").run(old);
  move('APP-1', 'inbox', 'refine', null);
  const [hub] = (await dial()) as [Stub];
  hub.onopen?.();

  const evidence = () => framesOf(hub).filter((frame) => frame.type === 'evidence.blocks');
  const days = () => evidence().flatMap((frame) => (frame.payload as { blocks: { start: string }[] }).blocks.map((block) => block.start.slice(0, 10)));
  await vi.waitFor(() => expect(evidence().length).toBeGreaterThan(0));
  for (const frame of evidence()) hubReadsEvidence(frame.payload);
  const today = (db().prepare("SELECT at FROM card_events WHERE to_stage = 'refine'").get() as { at: string }).at.slice(0, 10);
  expect(days()).toContain(today);
  expect(days()).not.toContain(old.slice(0, 10));

  const sent = evidence().length;
  move('APP-1', 'refine', 'plan', null);
  live.changed();
  await vi.waitFor(() => expect(evidence().length).toBeGreaterThan(sent));
  const added = evidence().slice(sent).flatMap((frame) => (frame.payload as { blocks: { source: string }[] }).blocks);
  expect(added.length).toBeGreaterThan(0);
  expect(added.every((block) => block.source === 'move')).toBe(true);
});

/* The same board up the team socket on a team project. */

// Both connections a machine dials, told apart by the path, the way the team socket tests in
// `hub-link.test.ts` tell them apart.
async function dialBoth(): Promise<{ own: Stub; team: Stub | undefined; urls: string[] }> {
  const own = stub();
  const team = stub();
  const urls: string[] = [];
  startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => {
      urls.push(url);
      return () => (url.endsWith('/connect/team') ? team : own);
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
  // A tick past the first dial, so a second one would be in the list by now.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { own, team: urls.some((url) => url.endsWith('/connect/team')) ? team : undefined, urls };
}

const boardsOn = (hub: Stub) => framesOf(hub).filter((frame) => frame.type === 'card.state');

it('sends a card move on a team project to the team socket and to the personal one', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  endRun(startRun(db(), { cardKey: 'APP-1', phase: 'refine', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null }), 0.25);
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();
  team.onopen?.();
  const ownBefore = boardsOn(own).length;
  const teamBefore = boardsOn(team).length;
  // The open sends the whole board, which the team hub needs as much as the personal one does.
  expect(teamBefore).toBe(1);

  move('APP-1', 'inbox', 'refine', null);
  live.changed();

  expect(boardsOn(own)).toHaveLength(ownBefore + 1);
  expect(boardsOn(team)).toHaveLength(teamBefore + 1);
  // The same move, and the personal frame alone names the card's next start.
  const ownLast = boardsOn(own).at(-1)?.payload as { cards: { start?: unknown }[] };
  expect(ownLast.cards[0]?.start).toBeDefined();
  const withoutStart = ownLast.cards.map((card) => Object.fromEntries(Object.entries(card).filter(([field]) => field !== 'start')));
  expect(boardsOn(team).at(-1)?.payload).toEqual({ ...ownLast, cards: withoutStart });
  // The team hub runs the same `readCardState` as the personal one.
  for (const frame of boardsOn(team)) hubReadsCardState(frame.payload);
  // The board and the run costs. No registration, because the team hub reads the project off the
  // device, and no evidence, which stays with the person's own hub.
  expect(new Set(framesOf(team).map((frame) => frame.type))).toEqual(new Set(['card.state', 'run.cost']));
  // A run's question, verdict reason and failure stay with the person's own hub, so the team board
  // carries no run rows. The cost goes on a frame of its own.
  expect(boardsOn(own).some((frame) => (frame.payload as { runs: unknown[] }).runs.length > 0)).toBe(true);
  for (const frame of boardsOn(team)) expect((frame.payload as { runs: unknown[] }).runs).toEqual([]);
  expect(lines).toEqual([]);
});

/* A team run's cost, tokens and model, up the team socket on `run.cost`. */

const costsOn = (hub: Stub) => framesOf(hub).filter((frame) => frame.type === 'run.cost');

// The run row holds the question, the verdict reason, the failure, the log path, the session id and the
// result text. The builder reads none of them, so a field the row grows later does not reach the team.
it('builds a run cost from the run row alone, and copies no content of the run', () => {
  const id = startRun(db(), { cardKey: 'APP-1', phase: 'qa', engine: 'claude', model: 'sonnet', effort: 'high', sessionId: null, logPath: '/private/run.log', lane: null });
  expect(runCostOf(allRuns(db())[0]!)).toBeNull();

  endRun(id, 0.25);
  db()
    .prepare("UPDATE runs SET question = 'which index name?', error = '5-hour limit, resets 19:00', verdict = 'FAIL', verdict_reason = 'The search box drops the last letter.' WHERE id = ?")
    .run(id);
  const run = allRuns(db())[0]!;
  const cost = runCostOf(run);

  expect(cost).toEqual({
    runId: id,
    cardKey: 'APP-1',
    phase: 'qa',
    model: 'sonnet',
    startedAt: run.startedAt,
    costUsd: 0.25,
    durationMs: 1200,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
  });
  // The hub reads exactly what the machine built.
  expect(readRunCosts({ teamProjectId: 'team-project-1', runs: [cost] }).runs).toEqual([cost]);
  const wire = JSON.stringify(cost);
  for (const local of ['which index name', 'limit', 'drops the last letter', '/private/run.log', 'kept-here', 'the transcript', 'high']) expect(wire).not.toContain(local);
});

it('sends each team run cost once, and again only when it changed', () => {
  addCard('APP-1');
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  const { frames, wire, send } = recorder();
  const sync = createHubSync(db(), send, { runs: false });
  const queued = startRun(db(), { cardKey: 'APP-1', phase: 'refine', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });

  // A run that has not started has no month to land in and costs nothing yet.
  sync.runCosts();
  expect(frames).toEqual([]);

  endRun(queued, 0.25);
  // A frame that did not go leaves the run owed, so the next push sends it.
  wire.open = false;
  sync.runCosts();
  wire.open = true;
  sync.runCosts();
  sync.runCosts();
  expect(frames.map((frame) => frame.type)).toEqual(['run.cost']);
  const first = readRunCosts(frames[0]?.payload);
  expect(first.teamProjectId).toBe('team-project-1');
  expect(first.runs.map((run) => [run.runId, run.costUsd])).toEqual([[queued, 0.25]]);

  db().prepare('UPDATE runs SET cost_estimate = 0.5 WHERE id = ?').run(queued);
  sync.runCosts();
  expect(frames).toHaveLength(2);
  expect((frames[1]?.payload as RunCosts).runs.map((run) => run.costUsd)).toEqual([0.5]);
});

// A folder whose team project id was cleared is a personal project again, and its runs stay home.
it('sends no run cost on a project that is not a team project', () => {
  addCard('APP-1');
  endRun(startRun(db(), { cardKey: 'APP-1', phase: 'refine', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null }), 0.25);
  const { frames, send } = recorder();

  createHubSync(db(), send, { runs: false }).runCosts();

  expect(frames).toEqual([]);
});

// Two cards, so a card key read from anywhere but the run's own row puts a run under the wrong card.
it('sends each team run cost under the card the run belongs to', () => {
  addCard('APP-1');
  addCard('APP-2');
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  const ran = (cardKey: string) => {
    const id = startRun(db(), { cardKey, phase: 'refine', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null });
    endRun(id, 0.25);
    return id;
  };
  const first = ran('APP-1');
  const second = ran('APP-2');
  const { frames, send } = recorder();

  createHubSync(db(), send, { runs: false }).runCosts();

  expect(readRunCosts(frames[0]?.payload).runs.map((run) => [run.runId, run.cardKey])).toEqual([
    [first, 'APP-1'],
    [second, 'APP-2'],
  ]);
});

// The whole path, from the run row to the team socket. The personal socket never gets this frame: the
// personal hub reads the cost off its own `card.state`.
it('sends a team run\'s cost and model up the team socket on open and on a change, and never up the personal one', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  endRun(startRun(db(), { cardKey: 'APP-1', phase: 'refine', engine: 'claude', model: 'sonnet', effort: null, sessionId: null, logPath: '', lane: null }), 0.25);
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();
  team.onopen?.();

  expect(costsOn(team)).toHaveLength(1);
  expect(readRunCosts(costsOn(team)[0]?.payload).runs.map((run) => [run.phase, run.model, run.costUsd])).toEqual([['refine', 'sonnet', 0.25]]);

  endRun(startRun(db(), { cardKey: 'APP-1', phase: 'plan', engine: 'claude', model: 'opus', effort: null, sessionId: null, logPath: '', lane: null }), 1.5);
  live.changed();

  expect(costsOn(team)).toHaveLength(2);
  expect(readRunCosts(costsOn(team)[1]?.payload).runs.map((run) => [run.phase, run.model, run.costUsd])).toEqual([['plan', 'opus', 1.5]]);
  expect(costsOn(own)).toEqual([]);
  // The frame as it went out, and not through the hub's reader, which would drop a field it does not
  // name. Exactly these keys, so a run's content cannot ride along unseen.
  for (const frame of costsOn(team)) {
    expect(Object.keys(frame.payload as object).sort()).toEqual(['runs', 'teamProjectId']);
    for (const run of (frame.payload as RunCosts).runs) {
      expect(Object.keys(run).sort()).toEqual(['cardKey', 'costUsd', 'durationMs', 'model', 'phase', 'runId', 'startedAt', 'tokens']);
    }
  }
  expect(lines).toEqual([]);
});

// A folder change clears the team project id and leaves the old team socket open until the link
// restarts. The new project's cards must not land on the old team's board.
it('sends nothing on an open team socket once the team project id is cleared', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();
  team.onopen?.();
  const teamBefore = boardsOn(team).length;
  writeSetting(db(), 'teamProjectId', null);

  move('APP-1', 'inbox', 'refine', null);
  live.changed();

  expect(boardsOn(team)).toHaveLength(teamBefore);
  expect(lines).toEqual([]);
});

it('opens no team socket for a card on a personal project, and the move goes to the personal hub', async () => {
  projectHere();
  addCard('APP-1');
  const { own, team, urls } = await dialBoth();
  own.onopen?.();
  const before = boardsOn(own).length;

  move('APP-1', 'inbox', 'refine', null);
  live.changed();

  expect(urls).toEqual(['ws://localhost:8787/connect']);
  expect(team).toBeUndefined();
  expect(boardsOn(own)).toHaveLength(before + 1);
  expect(lines).toEqual([]);
});

// A team project whose team hub never opened or turned this machine down. The board waits for the
// next open of that socket, and the personal hub is not held up by it.
it('sends nothing and throws nothing on a team project with no open team socket', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();
  team.onclose?.({ code: 4402 });
  lines = [];

  move('APP-1', 'inbox', 'refine', null);
  expect(() => live.changed()).not.toThrow();

  expect(team.sent).toEqual([]);
  expect(boardsOn(own).length).toBeGreaterThan(0);
  expect(lines).toEqual([]);
});

// A team socket still dialling when a card moves. Nothing goes out, and nothing is marked as sent, so
// its first open carries the whole board, that move included.
it('sends the whole board on the first open of a team socket that was down when a card moved', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();

  move('APP-1', 'inbox', 'refine', null);
  live.changed();
  expect(team.sent).toEqual([]);

  team.onopen?.();
  const payloads = boardsOn(team).map((frame) => frame.payload as { cards: { key: string; stage: string }[]; events: unknown[] });
  expect(payloads.flatMap((payload) => payload.cards)).toEqual([expect.objectContaining({ key: 'APP-1', stage: 'refine' })]);
  expect(payloads.flatMap((payload) => payload.events)).toHaveLength(1);
});

// A team socket that dropped and came back. The new one has sent nothing yet, so its open carries the
// whole board again, and not only what changed while it was down.
it('sends the whole board again when the team socket reconnects', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  const own = stub();
  const teams: Stub[] = [];
  startHubLink(live, { NOLZU_HUB_URL: 'ws://localhost:8787' }, {
    keychain: keychain('stored-token'),
    socket: (url) => () => {
      if (!url.endsWith('/connect/team')) return own;
      teams.push(stub());
      return teams.at(-1) as Stub;
    },
    say: (line) => lines.push(line),
  });
  await vi.waitFor(() => expect(teams).toHaveLength(1));
  const first = teams[0] as Stub;
  first.onopen?.();
  first.onclose?.({ code: 1006 });
  await vi.waitFor(() => expect(teams).toHaveLength(2), { timeout: 10_000 });
  const second = teams[1] as Stub;
  second.onopen?.();

  expect(boardsOn(second).map((frame) => frame.payload)).toEqual(boardsOn(first).map((frame) => frame.payload));
  expect(boardsOn(second)).toHaveLength(1);
});

// A board that cannot be read, here a table gone from under the link. The personal hub and the team
// hub each get their own line, and the change report that called them does not throw.
it('says one line for each hub when the board cannot be read on a team project', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();
  team.onopen?.();
  lines = [];
  db().exec('ALTER TABLE card_events RENAME TO card_events_gone');

  expect(() => live.changed()).not.toThrow();

  expect(lines).toHaveLength(2);
  expect(lines).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^Nolzu could not send its board to the hub: /),
      expect.stringMatching(/^Nolzu could not send its board to the team hub: /),
    ]),
  );
});

/* The state of a card's pull request on both sockets. */

it('sends a merged pull request with its state to the team hub and the personal one, and no state for a card with no pull request', async () => {
  projectHere();
  writeSetting(db(), 'teamProjectId', 'team-project-1');
  addCard('APP-1');
  addCard('APP-2');
  db()
    .prepare("UPDATE cards SET board = 'prreview', stage = 'incoming', source = 'github-pr', pr_author = 'ana', pr_decision = 'APPROVED', pr_state = 'open' WHERE key = 'APP-1'")
    .run();
  const { own, team } = await dialBoth();
  if (team === undefined) throw new Error('The client dialled no team hub on a team project.');
  own.onopen?.();
  team.onopen?.();

  // The PR reviews board reads its repository again and finds the pull request merged.
  db().prepare("UPDATE cards SET pr_state = 'merged' WHERE key = 'APP-1'").run();
  live.changed();

  for (const hub of [own, team]) {
    for (const frame of boardsOn(hub)) hubReadsCardState(frame.payload);
    const cards = boardsOn(hub).flatMap((frame) => (frame.payload as { cards: { key: string; pull: { state?: string } | null }[] }).cards);
    const pullsOf = (key: string) => cards.filter((card) => card.key === key).map((card) => card.pull);
    expect(pullsOf('APP-1').map((pull) => pull?.state)).toEqual(['open', 'merged']);
    expect(pullsOf('APP-2')).toEqual([null]);
  }
  expect(lines).toEqual([]);
});

// Three pull request cards in three states. With one card, a state read off the wrong row still passes.
it('sends each pull request card with its own state, on the personal and the team sender', () => {
  for (const key of ['APP-1', 'APP-2', 'APP-3']) addCard(key);
  const pull = db().prepare("UPDATE cards SET pr_decision = 'REVIEW_REQUIRED', pr_state = ? WHERE key = ?");
  pull.run('closed', 'APP-1');
  pull.run(null, 'APP-2');
  pull.run('merged', 'APP-3');

  for (const runs of [true, false]) {
    const { frames, send } = recorder();
    createHubSync(db(), send, { runs }).board();
    for (const frame of frames) hubReadsCardState(frame.payload);
    const cards = frames.flatMap((frame) => (frame.payload as { cards: { key: string; pull: { state?: string } | null }[] }).cards);
    expect(cards.map((card) => [card.key, card.pull?.state])).toEqual([
      ['APP-1', 'closed'],
      ['APP-2', undefined],
      ['APP-3', 'merged'],
    ]);
  }
});
