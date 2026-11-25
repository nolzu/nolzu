import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '@nolzu/protocol';
import { openDatabase } from './db.ts';
import { writeSetting } from './settings-store.ts';
import { cardHolds, cardRuns, markRunning, outputCheckOf, readRun, retryWait, saveOutputCheck, saveRun, sessionInCardFolder, startRun } from './runs.ts';

// A team project's knowledge needs the cloud open (`packages/protocol/src/soon.ts`), so the team cases
// here run with it on. cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-runs-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const start = () =>
  startRun(db, {
    cardKey: 'APP-1',
    phase: 'implement',
    engine: 'claude',
    model: 'sonnet',
    effort: 'medium',
    sessionId: 'caller-chose-this-id',
    logPath: join(dir, 'logs', 'APP-1-implement.ndjson'),
    lane: null,
  });

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  sessionId: 'engine-reported-this-id',
  model: 'claude-sonnet-4-5',
  costUsd: 0.0412,
  durationMs: 18240,
  tokens: { input: 9, output: 412, cacheRead: 14820, cacheCreation: 3310 },
  question: null,
  failureReason: null,
  failureStatus: null,
  state: 'complete',
  cardState: 'ready',
  retry: null,
  ...over,
});

const rows = () => db.prepare('SELECT id FROM runs').all();

it('keeps one row through the start, two updates and the end', () => {
  const id = start();

  saveRun(db, id, record({ state: 'running', costUsd: null, durationMs: null, tokens: null }));
  saveRun(db, id, record({ state: 'running', costUsd: null, durationMs: null }));
  saveRun(db, id, record());

  expect(rows()).toHaveLength(1);
  expect(readRun(db, id)?.state).toBe('complete');
});

it('writes the log path when the run starts, before any event arrives', () => {
  const id = start();

  // A run that dies before its first line still names the file that holds what it did.
  expect(readRun(db, id)?.logPath).toBe(join(dir, 'logs', 'APP-1-implement.ndjson'));

  // And still names it once events arrive. A save carries no log path, so it must not clear one.
  saveRun(db, id, record());
  expect(readRun(db, id)?.logPath).toBe(join(dir, 'logs', 'APP-1-implement.ndjson'));
});

it('reads a finished run back as the reducer described it', () => {
  const id = start();
  const finished = record();

  saveRun(db, id, finished);

  const read = readRun(db, id);
  expect(read?.sessionId).toBe(finished.sessionId);
  expect(read?.model).toBe(finished.model);
  expect(read?.costUsd).toBe(finished.costUsd);
  expect(read?.durationMs).toBe(finished.durationMs);
  expect(read?.tokens).toEqual(finished.tokens);
  expect(read?.state).toBe(finished.state);
});

it('writes a run that belongs to a pseudo-ticket with no card of its own', () => {
  const id = startRun(db, {
    cardKey: 'APP-1',
    phase: 'extract-summary',
    engine: 'claude',
    model: 'haiku',
    effort: 'low',
    sessionId: null,
    logPath: join(dir, 'logs', 'extract.ndjson'),
    lane: null,
  });

  // The released schema puts no foreign key on card_key for exactly this.
  expect(readRun(db, id)?.phase).toBe('extract-summary');
});

it('keeps the question a blocked run asked', () => {
  const id = start();

  saveRun(db, id, record({ state: 'complete', question: 'which index name?' }));

  expect(readRun(db, id)?.question).toBe('which index name?');
  // Read raw, not through readRun: a swap of two columns that the reader mirrors is invisible to
  // every assertion that goes back through it. The smoke run reads `error` straight from the table.
  const raw = db.prepare('SELECT question, error FROM runs WHERE id = ?').get(id) as {
    question: string | null;
    error: string | null;
  };
  expect(raw.question).toBe('which index name?');
  expect(raw.error).toBe(null);
});

it('stores a stopped run with no cost and no tokens', () => {
  const id = start();

  saveRun(db, id, record({ state: 'stopped', costUsd: null, durationMs: null, tokens: null }));

  const read = readRun(db, id);
  expect(read?.state).toBe('stopped');
  expect(read?.costUsd).toBe(null);
  expect(read?.tokens).toBe(null);
  // Stopped is an end, so the drawer can stop counting. Only complete was pinned before.
  expect(read?.endedAt).not.toBe(null);
});

// Codex reports no time at the end, so its runs had none and the trail summed them as nothing. The
// store counts the time from the start to the end where the engine reports none, and keeps the
// engine's own figure where it reports one.
it('counts the time from the start to the end of a run whose engine reports none', () => {
  const id = start();
  markRunning(db, id);
  db.prepare("UPDATE runs SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds') WHERE id = ?").run(id);

  saveRun(db, id, record({ state: 'running', durationMs: null }));
  expect(readRun(db, id)?.durationMs).toBeNull();
  saveRun(db, id, record({ durationMs: null, costUsd: null }));

  const took = readRun(db, id)?.durationMs ?? 0;
  expect(took).toBeGreaterThanOrEqual(89_000);
  expect(took).toBeLessThan(120_000);

  const other = start();
  markRunning(db, other);
  saveRun(db, other, record({ durationMs: 4200 }));
  expect(readRun(db, other)?.durationMs).toBe(4200);
});

it('keeps the attempt a retrying run is on', () => {
  const id = start();

  saveRun(db, id, record({ state: 'retrying', retry: { attempt: 2, delayMs: 4000, reason: 'overloaded' } }));

  const read = readRun(db, id);
  expect(read?.state).toBe('retrying');
  expect(read?.attempt).toBe(2);
});

it('stores the failure reason, and says nothing it cannot store', () => {
  const id = start();

  saveRun(db, id, record({ state: 'failed', failureReason: 'the engine exited early', failureStatus: 2 }));

  const read = readRun(db, id);
  expect(read?.failureReason).toBe('the engine exited early');
  expect(read?.endedAt).not.toBe(null);
  // The numeric status has no column. The log the row points at carries it, so nothing here
  // invents a place for it.
  expect('failureStatus' in (read ?? {})).toBe(false);
});

it('reads nothing back for a run that was never written', () => {
  expect(readRun(db, 404)).toBe(null);
});

it('starts the row queued, with no start time and no end time', () => {
  const id = start();

  const read = readRun(db, id);
  expect(read?.state).toBe('queued');
  // The start is stamped on the first event the run reports, not when it joins the queue. A job can
  // wait a long time for a slot or a lane, and the board counts elapsed from this, so the wait would
  // otherwise be counted as run time.
  expect(read?.startedAt).toBe(null);
  expect(read?.endedAt).toBe(null);
});

it('stamps the start on the first event, and never moves it after that', () => {
  const id = start();

  saveRun(db, id, record({ state: 'running', cardState: 'running' }));
  const first = readRun(db, id)?.startedAt;
  saveRun(db, id, record({ state: 'complete', cardState: 'ready' }));

  expect(first).not.toBe(null);
  expect(readRun(db, id)?.startedAt).toBe(first);
});

it('keeps two runs of one card apart', () => {
  const first = start();
  const second = startRun(db, {
    cardKey: 'APP-1',
    phase: 'plan',
    engine: 'claude',
    model: 'sonnet',
    effort: 'high',
    sessionId: null,
    logPath: join(dir, 'logs', 'APP-1-plan.ndjson'),
    lane: null,
  });

  expect(second).not.toBe(first);

  saveRun(db, second, record({ state: 'failed', failureReason: 'the engine exited early' }));

  // A card runs several phases, so a write that found its row by card key would rewrite history.
  expect(readRun(db, first)?.state).toBe('queued');
  expect(readRun(db, first)?.failureReason).toBe(null);
  expect(readRun(db, second)?.state).toBe('failed');
});

it('stamps the end time when the run ends, and never moves it after that', () => {
  const id = start();

  saveRun(db, id, record({ state: 'running', costUsd: null, durationMs: null, tokens: null }));
  expect(readRun(db, id)?.endedAt).toBe(null);

  saveRun(db, id, record());
  expect(readRun(db, id)?.endedAt).not.toBe(null);

  // A marker rather than a second timestamp: two writes in the same millisecond would read as
  // unchanged whether the end time moves or not.
  db.prepare("UPDATE runs SET ended_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  saveRun(db, id, record({ costUsd: 0.09 }));

  expect(readRun(db, id)?.endedAt).toBe('2020-01-01T00:00:00.000Z');
});

it('keeps the model and the session id when the run dies before its first line', () => {
  const id = start();

  // The fold learns both from the session line, so a run that printed nothing folds to nulls.
  saveRun(db, id, record({ state: 'failed', model: null, sessionId: null, costUsd: null, durationMs: null, tokens: null }));

  const read = readRun(db, id);
  expect(read?.model).toBe('sonnet');
  expect(read?.sessionId).toBe('caller-chose-this-id');
});

it('takes the model and the session id the engine reported', () => {
  const id = start();

  saveRun(db, id, record());

  const read = readRun(db, id);
  expect(read?.model).toBe('claude-sonnet-4-5');
  expect(read?.sessionId).toBe('engine-reported-this-id');
});

// Stamped when the job gets its slot, so the elapsed time on the card starts with the run and a queue
// wait is not part of it. Called again when a wait ends, and the first stamp stays.
it('marks a run as running and stamps its start once', () => {
  const id = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'fake', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });

  markRunning(db, id);
  const first = readRun(db, id);
  db.prepare("UPDATE runs SET state = 'retrying' WHERE id = ?").run(id);
  markRunning(db, id);

  expect(first?.state).toBe('running');
  expect(first?.startedAt).not.toBeNull();
  expect(readRun(db, id)).toMatchObject({ state: 'running', startedAt: first?.startedAt });
});

it('turns the card running when its run gets the slot, so the board stops saying queued', () => {
  // The run row said running and the card row still said queued for the whole run, so the board
  // showed Queued with no elapsed time until the card was ready.
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'queued', 'Add a search box')").run();
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'refine', 'queued', 'Sort the list')").run();
  const id = startRun(db, { cardKey: 'APP-1', phase: 'refine', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });

  markRunning(db, id);

  const state = (key: string) => (db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string }).state;
  expect(state('APP-1')).toBe('running');
  expect(state('APP-2')).toBe('queued');
});

it('lists the runs of one card, oldest first, with what readRun reads', () => {
  const first = start();
  saveRun(db, first, record());
  startRun(db, { cardKey: 'APP-2', phase: 'refine', engine: 'claude', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  const second = start();

  const runs = cardRuns(db, 'APP-1');

  expect(runs.map((run) => run.id)).toEqual([first, second]);
  expect(runs[0]).toEqual(readRun(db, first));
});

it('lists nothing for a card with no run', () => {
  expect(cardRuns(db, 'APP-9')).toEqual([]);
});

// The countdown on Now and the card reads the stored wait. A row that went back to work, or that
// ended, has no wait any more, whatever the columns still hold.
it('stores the wait with its reason and the time the next try starts, and reads it only while the run waits', () => {
  const id = start();

  saveRun(db, id, record({ state: 'retrying', retry: { attempt: 2, delayMs: 300_000, reason: 'API Error: 529 Overloaded', until: 1_790_000_300_000, maxRetries: 3 } }));
  expect(retryWait(db, id)).toEqual({ attempt: 2, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: 1_790_000_300_000 });

  markRunning(db, id);
  expect(retryWait(db, id)).toBeNull();

  saveRun(db, id, record({ state: 'complete', retry: null }));
  db.prepare("UPDATE runs SET state = 'retrying' WHERE id = ?").run(id);
  // The end cleared the columns, so a row forced back to retrying has no countdown to show.
  expect(retryWait(db, id)).toBeNull();
});

// Two cards can hold the same session id, so the answer is the one card's own.
it('reads where a session started for its own card only', () => {
  const row = (cardKey: string) => startRun(db, { cardKey, phase: 'refine', engine: 'codex', model: 'gpt-5.6-terra', effort: 'low', sessionId: 'shared', logPath: '', lane: null });
  db.prepare('UPDATE runs SET in_card_folder = 0 WHERE id = ?').run(row('APP-1'));
  db.prepare('UPDATE runs SET in_card_folder = 1 WHERE id = ?').run(row('APP-2'));

  expect(sessionInCardFolder(db, 'APP-2', 'shared', 'codex', 'refine')).toBe(true);
  expect(sessionInCardFolder(db, 'APP-1', 'shared', 'codex', 'refine')).toBe(false);
});

// A wait from before the countdown, or the engine's own, has no time to count down to.
it('reads no wait for a retrying row with no time on it', () => {
  const id = start();

  saveRun(db, id, record({ state: 'retrying', retry: { attempt: 1, delayMs: 2000, reason: 'overloaded' } }));

  expect(retryWait(db, id)).toBeNull();
});

// Where a session's process started, off its first run. A row made before the column started where
// Codex under its own sandbox started then, so the old rule answers for it and old runs still resume.
it('reads where a session started, and answers an old row with the rule of its day', () => {
  const row = (sessionId: string, phase: string, engine: string) =>
    startRun(db, { cardKey: 'APP-1', phase, engine, model: 'gpt-5.6-terra', effort: 'low', sessionId, logPath: '', lane: null });
  row('old-refine', 'refine', 'codex');
  row('old-implement', 'implement', 'codex');
  db.prepare('UPDATE runs SET in_card_folder = 0 WHERE id = ?').run(row('new-refine', 'refine', 'codex'));
  db.prepare('UPDATE runs SET in_card_folder = 1 WHERE id = ?').run(row('own-refine', 'refine', 'codex'));
  // A later resume row of the same session does not change where it started.
  db.prepare('UPDATE runs SET in_card_folder = 0 WHERE id = ?').run(row('own-refine', 'refine', 'codex'));

  expect(sessionInCardFolder(db, 'APP-1', 'old-refine', 'codex', 'refine')).toBe(true);
  expect(sessionInCardFolder(db, 'APP-1', 'old-implement', 'codex', 'implement')).toBe(false);
  expect(sessionInCardFolder(db, 'APP-1', 'old-refine', 'claude-code', 'refine')).toBe(false);
  expect(sessionInCardFolder(db, 'APP-1', 'new-refine', 'codex', 'refine')).toBe(false);
  expect(sessionInCardFolder(db, 'APP-1', 'own-refine', 'codex', 'refine')).toBe(true);
});

// A row made before the wall column reads null, so the card shows no wall rather than a guess. The
// column takes only the walls a run can have.
it('reads the wall a run stored, and null on a row with none', () => {
  const old = start();
  const walled = start();
  db.prepare("UPDATE runs SET wall = 'bubblewrap' WHERE id = ?").run(walled);

  expect(readRun(db, old)?.wall).toBeNull();
  expect(readRun(db, walled)?.wall).toBe('bubblewrap');
  expect(() => db.prepare("UPDATE runs SET wall = 'seatbelt' WHERE id = ?").run(old)).toThrow(/CHECK/);
});

it("keeps a resumed run's own share of a cost the engine reported for the whole session", () => {
  const first = start();
  saveRun(db, first, record({ sessionId: 'qa-session', costUsd: 0.154, costIsSessionTotal: true }));
  const second = start();
  saveRun(db, second, record({ sessionId: 'qa-session', costUsd: 0.191, costIsSessionTotal: true }));
  const third = start();
  saveRun(db, third, record({ sessionId: 'qa-session', costUsd: 0.2, costIsSessionTotal: true }));

  expect(readRun(db, first)?.costUsd).toBeCloseTo(0.154);
  expect(readRun(db, second)?.costUsd).toBeCloseTo(0.037);
  expect(readRun(db, third)?.costUsd).toBeCloseTo(0.009);

  // A cost that is the run's alone, and a run of another session, are kept as they came.
  const other = start();
  saveRun(db, other, record({ sessionId: 'qa-session', costUsd: 0.05 }));
  expect(readRun(db, other)?.costUsd).toBeCloseTo(0.05);
  const fresh = start();
  saveRun(db, fresh, record({ sessionId: 'another', costUsd: 0.07, costIsSessionTotal: true }));
  expect(readRun(db, fresh)?.costUsd).toBeCloseTo(0.07);
});

it('keeps what the output check found, and reads an unchecked or broken row as not checked', () => {
  const id = start();
  expect(outputCheckOf(db, id)).toBeNull();
  const check = { problems: [{ file: 'refine/refined.md', problem: 'The heading "## Scope" is missing.' }], note: null };
  saveOutputCheck(db, id, check);
  expect(outputCheckOf(db, id)).toEqual(check);
  db.prepare('UPDATE runs SET output_check = ? WHERE id = ?').run('{not json', id);
  expect(outputCheckOf(db, id)).toBeNull();
});

// What keeps a wrap-up's card short of Closed. A pending change counts whichever run of the card wrote
// it, so a later run that wrote nothing does not close the card over it. The output check counts on the
// run the card shows, the newest, as the board draws it.
it('holds a card on a pending change of any of its runs, and on the problems of its newest run', () => {
  const wrapup = () => startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'claude-code', model: null, effort: null, sessionId: null, logPath: '', lane: null });
  const first = wrapup();
  db.prepare("INSERT INTO knowledge_changes (card_key, run_id, file_path, status) VALUES ('APP-1', ?, '.nolzu/knowledge/a.md', 'pending')").run(first);
  wrapup();

  expect(cardHolds(db, 'APP-1')).toBe('A knowledge change waits for your review on Knowledge.');
  writeSetting(db, 'teamProjectId', 'team-7');
  expect(cardHolds(db, 'APP-1')).toBe('A knowledge change waits for the team to review it.');
  db.prepare("UPDATE knowledge_changes SET status = 'applied'").run();
  expect(cardHolds(db, 'APP-1')).toBeNull();
  expect(cardHolds(db, 'APP-2')).toBeNull();

  saveOutputCheck(db, first, { problems: [{ file: 'knowledge/a.md', problem: 'No description.' }], note: null });
  expect(cardHolds(db, 'APP-1')).toBeNull();
  const third = wrapup();
  saveOutputCheck(db, third, { problems: [{ file: 'knowledge/a.md', problem: 'No description.' }], note: null });
  expect(cardHolds(db, 'APP-1')).toBe('The output check found problems in what the run wrote. Open the card to read them.');
});
