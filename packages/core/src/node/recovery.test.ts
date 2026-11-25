import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CardState } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canMove, deliveryBoard } from '../board.ts';
import { moveCard } from './cards.ts';
import { openDatabase, openMachine, openProject, registerProject } from './db.ts';
import { recoverRuns, releaseWriter, startWriting, takeWriter } from './recovery.ts';
import { startRun } from './runs.ts';

const board = deliveryBoard('pull-request');
let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-recovery-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage: string, state: string) =>
  db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run(key, 'delivery', stage, state, 'Add a search box');

const run = (key: string, state: string) => {
  const id = startRun(db, {
    cardKey: key,
    phase: 'implement',
    engine: 'claude',
    model: 'sonnet',
    effort: 'medium',
    sessionId: 'caller-chose-this-id',
    logPath: join(dir, 'logs', `${key}-implement.ndjson`),
    lane: null,
  });
  db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(state, id);
  return id;
};

const card = (key: string) => db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: CardState };
const stored = (id: number) => db.prepare('SELECT state, error, ended_at FROM runs WHERE id = ?').get(id) as { state: string; error: string | null; ended_at: string | null };
const dump = () => JSON.stringify([db.prepare('SELECT * FROM runs ORDER BY id').all(), db.prepare('SELECT * FROM cards ORDER BY key').all()]);

it('returns a card whose run died to a state it can move from, and says why', async () => {
  addCard('APP-1', 'implement', 'running');
  const id = run('APP-1', 'running');

  const found = recoverRuns(db);

  expect(found.runs).toBe(1);
  const after = stored(id);
  expect(after.state).toBe('interrupted');
  expect(after.error).toMatch(/restart/i);
  expect(after.ended_at).not.toBe(null);
  // Failed, not idle. The run was cut off in the middle, and failed carries a reason the board can
  // show, where idle would read as a card nobody had started.
  expect(card('APP-1').state).toBe('failed');
  // Movable is the point. A card stuck queued or running refuses every drag, in both directions,
  // for good. One stage forward and any distance back are what canMove actually allows.
  expect(canMove(board, card('APP-1'), 'qa')).toBe(true);
  expect(canMove(board, card('APP-1'), 'refine')).toBe(true);
  // Back is the move a person makes after a crash, so that is the one driven for real.
  await expect(moveCard(db, board, 'APP-1', 'refine', vi.fn())).resolves.not.toThrow();
  expect(card('APP-1').stage).toBe('refine');
});

it('sets a Fix cut off by the restart back to new with the reason, and its card idle on Pull request', () => {
  addCard('APP-3', 'pr-watch', 'running');
  const id = run('APP-3', 'running');
  db.prepare("UPDATE runs SET thread = 'T2' WHERE id = ?").run(id);
  const pull = (db.prepare("INSERT INTO card_pulls (card_key, repo, number, found_by) VALUES ('APP-3', 'acme/recipes', 4, 'branch') RETURNING id").get() as { id: number }).id;
  db.prepare("INSERT INTO pr_discussions (card_key, pull_id, ref, kind, github_id, status) VALUES ('APP-3', ?, 'T2', 'comment', 'C1', 'fixing')").run(pull);

  const found = recoverRuns(db);

  expect(found.cards).toEqual([]);
  expect(card('APP-3')).toEqual({ stage: 'pr-watch', state: 'idle' });
  expect(db.prepare("SELECT status, fix_failed FROM pr_discussions WHERE ref = 'T2'").get()).toEqual({ status: 'new', fix_failed: expect.stringMatching(/restarted while this fix ran/) });
});

it('returns a queued card with no run row to idle', () => {
  // The crash between the move commit and the enqueue. There is no run to close, only a card that
  // would otherwise refuse every drag.
  addCard('APP-2', 'plan', 'queued');

  recoverRuns(db);

  expect(card('APP-2').state).toBe('idle');
});

it('closes a run left waiting on a lane, which is live but is not queued or running', () => {
  // Queued, running and retrying are the obvious live states. waiting_lane is live too, and a run left in
  // it would lock its card exactly the way the other three do.
  addCard('APP-3', 'implement', 'queued');
  const id = run('APP-3', 'waiting_lane');

  recoverRuns(db);

  expect(stored(id).state).toBe('interrupted');
});

// A wrap-up that waited for a knowledge review when Nolzu crashed: the card is let go, as any queued one.
it('closes a run left waiting for a knowledge review', () => {
  addCard('APP-5', 'wrapup', 'queued');
  const id = run('APP-5', 'waiting_review');

  recoverRuns(db);

  expect(stored(id).state).toBe('interrupted');
  expect(card('APP-5').state).toBe('failed');
});

it('closes a retrying run too', () => {
  addCard('APP-4', 'implement', 'running');
  const id = run('APP-4', 'retrying');

  recoverRuns(db);

  expect(stored(id).state).toBe('interrupted');
});

it('leaves a finished run and a ready card alone', () => {
  addCard('APP-5', 'review', 'ready');
  const id = run('APP-5', 'complete');
  db.prepare("UPDATE runs SET ended_at = '2026-09-17T10:00:00.000Z' WHERE id = ?").run(id);
  const before = dump();

  const found = recoverRuns(db);

  expect(found.runs).toBe(0);
  expect(dump()).toBe(before);
});

it('changes nothing when it runs a second time', () => {
  addCard('APP-6', 'implement', 'running');
  run('APP-6', 'running');
  recoverRuns(db);
  const after = dump();

  const again = recoverRuns(db);

  expect(again.runs).toBe(0);
  expect(dump()).toBe(after);
});

it('takes the writer lock, and the same process taking it again is not a second writer', () => {
  // The holder is claimed to be alive, so the only thing that can let the second call through is the
  // check that it is the same process. Without that, a real liveness check on a made up id would
  // answer false and the test would pass whatever the code did.
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });

  expect(() => takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true })).not.toThrow();
});

it('refuses a second writer and names the process and the folder', () => {
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });

  try {
    takeWriter(db, { dataDir: dir, pid: 7, alive: () => true });
    expect.unreachable('the second writer should have been refused');
  } catch (error) {
    expect((error as Error).message).toContain('4242');
    expect((error as Error).message).toContain(dir);
  }
});

it('lets the next writer in once the lock is released', () => {
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });
  releaseWriter(db, 4242);

  expect(() => takeWriter(db, { dataDir: dir, pid: 7, alive: () => true })).not.toThrow();
});

it('takes over a lock left by a process that is gone', () => {
  // A crash does not release the lock. Without this the person is locked out of their own app.
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });

  expect(() => takeWriter(db, { dataDir: dir, pid: 7, alive: (pid) => pid !== 4242 })).not.toThrow();
});

// After a crash the number can go to another program. One that started after the lock was taken
// never took it.
it('takes over a lock whose process number now belongs to a program started later', () => {
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });

  expect(() => takeWriter(db, { dataDir: dir, pid: 7, alive: () => true, startedAt: () => Date.now() + 60_000 })).not.toThrow();
  expect(() => takeWriter(db, { dataDir: dir, pid: 9, alive: () => true, startedAt: () => Date.now() - 60_000 })).toThrow(/process 7/);
});

it('does not release a lock another process holds', () => {
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });
  releaseWriter(db, 7);

  expect(() => takeWriter(db, { dataDir: dir, pid: 9, alive: () => true })).toThrow(/4242/);
});

it('leaves a run row from before run states existed alone', () => {
  // Migration 2 added the state column, so every row written before it reads null. Sweeping those
  // would rewrite finished history as interrupted and write this sentence over the failure they
  // recorded. Nothing this code makes has a null state: startRun writes queued in the same insert.
  addCard('APP-7', 'review', 'ready');
  const id = run('APP-7', 'complete');
  db.prepare("UPDATE runs SET state = NULL, error = 'the engine ran out of tokens' WHERE id = ?").run(id);

  const found = recoverRuns(db);

  expect(found.runs).toBe(0);
  expect(stored(id).state).toBe(null);
  expect(stored(id).error).toBe('the engine ran out of tokens');
});

it('refuses a second boot that reads the row inside this one', () => {
  // Two boots racing on one data directory. `alive` runs between the read and the write, so calling
  // takeWriter from inside it is exactly that interleave, with no second process and no stopwatch.
  const other = openDatabase(dir);
  other.exec('PRAGMA busy_timeout = 0');
  db.prepare("INSERT INTO writer (id, pid, at) VALUES (1, 4242, '2026-09-17T10:00:00.000Z')").run();

  let second: Error | undefined;
  takeWriter(db, {
    dataDir: dir,
    pid: 111,
    bootedAt: Date.parse('2026-09-17T09:00:00.000Z'),
    alive: () => {
      try {
        takeWriter(other, { dataDir: dir, pid: 222, alive: () => false });
      } catch (error) {
        second = error as Error;
      }
      return false;
    },
  });
  other.close();

  // Without the write lock both boots find 4242 dead, both claim it, and neither is told it lost.
  expect(second).toBeInstanceOf(Error);
  expect((db.prepare('SELECT pid FROM writer WHERE id = 1').get() as { pid: number }).pid).toBe(111);
});

it('takes over a lock written before the machine last started', () => {
  // A process id is reused after a restart, so the number alone can point at a stranger. Only the
  // age of the row can tell that apart, and alive is held true here so nothing else can let it pass.
  db.prepare("INSERT INTO writer (id, pid, at) VALUES (1, 4242, '2020-01-01T00:00:00.000Z')").run();

  expect(() =>
    takeWriter(db, { dataDir: dir, pid: 7, alive: () => true, bootedAt: Date.parse('2026-09-17T08:00:00.000Z') }),
  ).not.toThrow();
});

it('uses this process and a real liveness check when it is given neither', () => {
  // Every other test hands in both, so without this one the defaults that decide it in production
  // are never executed.
  takeWriter(db, { dataDir: dir });

  expect((db.prepare('SELECT pid FROM writer WHERE id = 1').get() as { pid: number }).pid).toBe(process.pid);
  // The real check says this process is alive, and the same process is not a second writer.
  expect(() => takeWriter(db, { dataDir: dir })).not.toThrow();
  releaseWriter(db);
  expect(db.prepare('SELECT pid FROM writer WHERE id = 1').get()).toBe(undefined);
});

it('takes the lock before it sweeps, so a refused boot changes nothing', () => {
  addCard('APP-8', 'implement', 'running');
  const id = run('APP-8', 'running');
  db.prepare('INSERT INTO writer (id, pid, at) VALUES (1, 4242, ?)').run(new Date().toISOString());

  expect(() => startWriting(db, { dataDir: dir, pid: 7, alive: () => true })).toThrow(/4242/);

  // The sweep never ran. A second Nolzu that swept first would close the runs the first is doing.
  expect(stored(id).state).toBe('running');
  expect(card('APP-8').state).toBe('running');
});

it('still refuses a lock taken in the first moments after the machine started', () => {
  // uptime has one second of resolution, so a lock taken right after a boot can read as very
  // slightly older than the boot itself. Without the slack that live holder would be taken over and
  // two Nolzus would run at once, which is the one thing this lock is for.
  const bootedAt = Date.parse('2026-09-17T08:00:00.000Z');
  db.prepare('INSERT INTO writer (id, pid, at) VALUES (1, 4242, ?)').run(new Date(bootedAt - 10_000).toISOString());

  expect(() => takeWriter(db, { dataDir: dir, pid: 7, alive: () => true, bootedAt })).toThrow(/4242/);
});

// One Nolzu per machine, whatever project each start opens. The lock lives in
// machine.db, which every project connection has attached, so the second start reads the first one's row.
it('refuses a second server that opens another project, through the lock in machine.db', () => {
  takeWriter(db, { dataDir: dir, pid: 4242, alive: () => true });
  const two = openProject(dir, registerProject(db, 'two.db'));

  try {
    expect(() => takeWriter(two, { dataDir: dir, pid: 7, alive: () => true })).toThrow(`Nolzu is already running on ${dir} as process 4242.`);
  } finally {
    two.close();
  }
  const machine = openMachine(dir);
  expect(machine.prepare('SELECT pid FROM writer').all()).toEqual([{ pid: 4242 }]);
  machine.close();
  // No project database keeps a lock of its own, or two projects could each hold one.
  expect(db.prepare("SELECT name FROM main.sqlite_schema WHERE name = 'writer'").get()).toBe(undefined);
});

it('refuses a boot of another project that reads the row inside this one', () => {
  // The race above, across two projects. BEGIN IMMEDIATE on a project connection takes machine.db's
  // write lock too, so the second boot cannot read the row until the first has written it.
  const other = openProject(dir, registerProject(db, 'two.db'));
  other.exec('PRAGMA busy_timeout = 0');
  db.prepare("INSERT INTO writer (id, pid, at) VALUES (1, 4242, '2026-09-17T10:00:00.000Z')").run();

  let second: Error | undefined;
  takeWriter(db, {
    dataDir: dir,
    pid: 111,
    bootedAt: Date.parse('2026-09-17T09:00:00.000Z'),
    alive: () => {
      try {
        takeWriter(other, { dataDir: dir, pid: 222, alive: () => false });
      } catch (error) {
        second = error as Error;
      }
      return false;
    },
  });
  other.close();

  expect(second).toBeInstanceOf(Error);
  expect((db.prepare('SELECT pid FROM writer WHERE id = 1').get() as { pid: number }).pid).toBe(111);
});
