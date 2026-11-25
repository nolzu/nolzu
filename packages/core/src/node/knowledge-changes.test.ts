import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.ts';
import {
  allKnowledgeChanges,
  applyKnowledgeChanges,
  knowledgeChange,
  knowledgeChangesOfRun,
  markKnowledgeMoved,
  pendingKnowledgeChanges,
  recordKnowledgeChanges,
  returnedKnowledgeNote,
  returnKnowledgeChanges,
  revertKnowledgeChange,
} from './knowledge-changes.ts';
import { startRun } from './runs.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-rows-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const run = (cardKey = 'APP-1'): number =>
  startRun(db, { cardKey, phase: 'wrapup', engine: 'claude-code', model: 'sonnet', effort: 'low', sessionId: null, logPath: '', lane: 'knowledge' });

it('writes one row per file, all naming the run its one commit', () => {
  const runId = run();

  recordKnowledgeChanges(db, {
    cardKey: 'APP-1',
    runId,
    commitSha: 'a'.repeat(40),
    status: 'applied',
    files: [
      { path: 'knowledge/importer.md', summary: 'added' },
      { path: 'knowledge/stack.md', summary: 'corrected' },
    ],
  });

  expect(knowledgeChangesOfRun(db, runId).map((row) => [row.filePath, row.summary, row.commitSha, row.status])).toEqual([
    ['knowledge/importer.md', 'added', 'a'.repeat(40), 'applied'],
    ['knowledge/stack.md', 'corrected', 'a'.repeat(40), 'applied'],
  ]);
});

// The rows of one run are one answer. Half of them would describe a commit the screen could revert
// only in part, and the file with no row would look like somebody's own edit.
it('writes no row at all when one of the files cannot be written', () => {
  const runId = run();
  db.exec("CREATE TRIGGER no_second BEFORE INSERT ON knowledge_changes WHEN new.file_path = 'knowledge/stack.md' BEGIN SELECT RAISE(ABORT, 'no'); END");

  expect(() =>
    recordKnowledgeChanges(db, {
      cardKey: 'APP-1',
      runId,
      commitSha: 'a'.repeat(40),
      status: 'applied',
      files: [
        { path: 'knowledge/importer.md', summary: 'added' },
        { path: 'knowledge/stack.md', summary: 'corrected' },
      ],
    }),
  ).toThrow();

  expect(knowledgeChangesOfRun(db, runId)).toEqual([]);
});

// A maintenance run belongs to no card, so the table takes a key no card row has.
it('takes the reserved key of a run that belongs to no card', () => {
  const runId = run('kb-maintenance');

  recordKnowledgeChanges(db, {
    cardKey: 'kb-maintenance',
    runId,
    commitSha: 'b'.repeat(40),
    status: 'applied',
    files: [{ path: 'knowledge/stack.md', summary: 'corrected' }],
  });

  expect(knowledgeChangesOfRun(db, runId).map((row) => row.cardKey)).toEqual(['kb-maintenance']);
});

it('lists the changes waiting for a person, and leaves the applied ones out', () => {
  const applied = run('APP-1');
  const waiting = run('APP-2');
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: applied, commitSha: 'c'.repeat(40), status: 'applied', files: [{ path: 'knowledge/a.md', summary: 'added' }] });
  // A pending change has no commit yet, which is why the column takes none.
  recordKnowledgeChanges(db, { cardKey: 'APP-2', runId: waiting, commitSha: null, status: 'pending', files: [{ path: 'knowledge/b.md', summary: 'added' }] });

  expect(pendingKnowledgeChanges(db).map((row) => [row.filePath, row.commitSha])).toEqual([['knowledge/b.md', null]]);
});

// The screen draws four states. A fifth word would arrive as a row it cannot show.
it('refuses a status that is not one of the four', () => {
  const runId = run();

  expect(() =>
    recordKnowledgeChanges(db, {
      cardKey: 'APP-1',
      runId,
      commitSha: 'd'.repeat(40),
      // The type refuses this, and the table is what holds when a row comes from somewhere else.
      status: 'approved' as 'applied',
      files: [{ path: 'knowledge/a.md', summary: 'added' }],
    }),
  ).toThrow(/CHECK/);
});

// The Knowledge screen reads every row, whatever run or status it came from.
it('reads every change ever recorded, oldest first', () => {
  const first = run();
  const second = run('APP-2');

  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: first, commitSha: 'a'.repeat(40), status: 'applied', files: [{ path: 'knowledge/a.md', summary: 'added' }] });
  recordKnowledgeChanges(db, { cardKey: 'APP-2', runId: second, commitSha: null, status: 'pending', files: [{ path: 'knowledge/b.md', summary: 'corrected' }] });

  expect(allKnowledgeChanges(db).map((row) => [row.cardKey, row.filePath, row.status])).toEqual([
    ['APP-1', 'knowledge/a.md', 'applied'],
    ['APP-2', 'knowledge/b.md', 'pending'],
  ]);
});

it('reads nothing from a database no run has taught yet', () => {
  expect(allKnowledgeChanges(db)).toEqual([]);
});

const pending = (cardKey: string, runId: number, ...files: string[]) =>
  recordKnowledgeChanges(db, { cardKey, runId, commitSha: null, status: 'pending', files: files.map((path) => ({ path, summary: 'added' })) });

it('applies the whole run at once, with the commit it was applied as', () => {
  const runId = run();
  pending('APP-1', runId, 'knowledge/a.md', 'knowledge/b.md');

  expect(applyKnowledgeChanges(db, runId, 'e'.repeat(40))).toBe(2);

  expect(knowledgeChangesOfRun(db, runId).map((row) => [row.status, row.commitSha])).toEqual([
    ['applied', 'e'.repeat(40)],
    ['applied', 'e'.repeat(40)],
  ]);
});

// A second approve of the same run moves nothing, which is how the screen knows to say the change
// was already applied rather than committing the same files twice.
it('changes no row when the run has nothing pending left', () => {
  const runId = run();
  pending('APP-1', runId, 'knowledge/a.md');
  applyKnowledgeChanges(db, runId, 'e'.repeat(40));

  expect(applyKnowledgeChanges(db, runId, 'f'.repeat(40))).toBe(0);
  expect(knowledgeChangesOfRun(db, runId).map((row) => row.commitSha)).toEqual(['e'.repeat(40)]);
});

it('returns the whole run with the note on every row, and no commit', () => {
  const runId = run();
  pending('APP-1', runId, 'knowledge/a.md', 'knowledge/b.md');

  expect(returnKnowledgeChanges(db, runId, 'Name the endpoint, not the file.')).toBe(2);

  expect(knowledgeChangesOfRun(db, runId).map((row) => [row.status, row.note, row.commitSha])).toEqual([
    ['returned', 'Name the endpoint, not the file.', null],
    ['returned', 'Name the endpoint, not the file.', null],
  ]);
});

// The same guard the apply has. Without it a second return would write a new note over the first
// one, and over the note of a change that was already applied.
it('changes no row when the run has nothing pending left to return', () => {
  const runId = run();
  pending('APP-1', runId, 'knowledge/a.md');
  applyKnowledgeChanges(db, runId, 'e'.repeat(40));

  expect(returnKnowledgeChanges(db, runId, 'Too long.')).toBe(0);
  expect(knowledgeChangesOfRun(db, runId).map((row) => [row.status, row.note])).toEqual([['applied', null]]);
});

it('leaves a returned change out of what waits for a person', () => {
  const runId = run();
  pending('APP-1', runId, 'knowledge/a.md');
  returnKnowledgeChanges(db, runId, 'Too long.');

  expect(pendingKnowledgeChanges(db)).toEqual([]);
});

describe('the note the next run of a card reads', () => {
  it('is the note of the return, because a return nobody reads is a silent delete', () => {
    const runId = run();
    pending('APP-1', runId, 'knowledge/a.md');
    returnKnowledgeChanges(db, runId, 'Name the endpoint, not the file.');

    expect(returnedKnowledgeNote(db, 'APP-1')).toBe('Name the endpoint, not the file.');
  });

  // Once a later run of the card wrote knowledge, the note has been answered. Handing it to every
  // run of that card forever would put an old complaint in the prompt of work it is not about.
  it('is gone once a later run of the card taught something', () => {
    const first = run();
    pending('APP-1', first, 'knowledge/a.md');
    returnKnowledgeChanges(db, first, 'Name the endpoint, not the file.');
    const second = run();
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: second, commitSha: 'a'.repeat(40), status: 'applied', files: [{ path: 'knowledge/a.md', summary: 'corrected' }] });

    expect(returnedKnowledgeNote(db, 'APP-1')).toBeNull();
  });

  it('belongs to the card it was written for, and to no other', () => {
    const runId = run('APP-1');
    pending('APP-1', runId, 'knowledge/a.md');
    returnKnowledgeChanges(db, runId, 'Too long.');

    expect(returnedKnowledgeNote(db, 'APP-2')).toBeNull();
  });

  it('is nothing for a card that never taught anything', () => {
    expect(returnedKnowledgeNote(db, 'APP-7')).toBeNull();
  });

  // Optimize and Learn this project share the reserved key, and a note written for one is no
  // instruction for the other.
  it('keeps to the phase it is asked for, under a key two kinds of run share', () => {
    const maintenance = (phase: string) => startRun(db, { cardKey: 'kb-maintenance', phase, engine: 'claude-code', model: 'sonnet', effort: 'low', sessionId: null, logPath: '', lane: 'knowledge' });
    const optimized = maintenance('optimize');
    pending('kb-maintenance', optimized, 'knowledge/a.md');
    returnKnowledgeChanges(db, optimized, 'Keep the part about the list.');
    const learned = maintenance('orient');
    pending('kb-maintenance', learned, 'knowledge/project-rules.md');
    returnKnowledgeChanges(db, learned, 'Drop the rule about the tickets folder.');

    expect(returnedKnowledgeNote(db, 'kb-maintenance', 'orient')).toBe('Drop the rule about the tickets folder.');
    expect(returnedKnowledgeNote(db, 'kb-maintenance', 'optimize')).toBe('Keep the part about the list.');
    expect(returnedKnowledgeNote(db, 'kb-maintenance')).toBe('Drop the rule about the tickets folder.');
  });

  // The other side of the same branch. A note on a row of any other status is not a return, and a
  // hand edited database is the way one gets there.
  it('is nothing when the newest row carries a note but was not returned', () => {
    const runId = run();
    pending('APP-1', runId, 'knowledge/a.md');
    db.prepare("UPDATE knowledge_changes SET status = 'applied', commit_sha = ?, note = 'an old note' WHERE run_id = ?").run('a'.repeat(40), runId);

    expect(returnedKnowledgeNote(db, 'APP-1')).toBeNull();
  });
});

// Revert answers one row, because the button sits in the change history of one file.
describe('revert', () => {
  const applied = (path: string): number => {
    const runId = run('APP-1');
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: 'e'.repeat(40), status: 'applied', files: [{ path, summary: 'corrected' }] });
    return allKnowledgeChanges(db).at(-1)?.id ?? 0;
  };

  it('reads one change by its id, and answers nothing for an id no row has', () => {
    const id = applied('knowledge/a.md');

    expect(knowledgeChange(db, id)?.filePath).toBe('knowledge/a.md');
    expect(knowledgeChange(db, id + 1000)).toBeNull();
  });

  it('marks one row reverted and leaves the commit on it, so the screen still shows the change', () => {
    const id = applied('knowledge/a.md');

    expect(revertKnowledgeChange(db, id)).toBe(1);
    expect(knowledgeChange(db, id)?.status).toBe('reverted');
    expect(knowledgeChange(db, id)?.commitSha).toBe('e'.repeat(40));
  });

  // The caller reads the count: no row moved means somebody answered this change in the meantime,
  // and the revert commit is taken back.
  it('moves no row on a second revert of the same change', () => {
    const id = applied('knowledge/a.md');
    revertKnowledgeChange(db, id);

    expect(revertKnowledgeChange(db, id)).toBe(0);
  });

  it('moves no row for a change that waits for review, because it was never applied', () => {
    const runId = run('APP-2');
    pending('APP-2', runId, 'knowledge/b.md');
    const id = allKnowledgeChanges(db).at(-1)?.id ?? 0;

    expect(revertKnowledgeChange(db, id)).toBe(0);
    expect(knowledgeChange(db, id)?.status).toBe('pending');
  });

  // One run can have written two files, and the history offers each one its own Revert.
  it('leaves the other file of the same run applied', () => {
    const runId = run('APP-3');
    recordKnowledgeChanges(db, {
      cardKey: 'APP-3',
      runId,
      commitSha: 'f'.repeat(40),
      status: 'applied',
      files: [{ path: 'knowledge/a.md', summary: 'added' }, { path: 'knowledge/b.md', summary: 'added' }],
    });
    const rows = knowledgeChangesOfRun(db, runId);

    revertKnowledgeChange(db, rows[0]?.id ?? 0);

    expect(knowledgeChangesOfRun(db, runId).map((one) => one.status)).toEqual(['reverted', 'applied']);
  });
});

// A project that became a workspace keeps its old history rows, marked with the folder their
// commits are in, so Revert can say it cannot act on them.
describe('marking the changes of a knowledge folder that moved', () => {
  it('marks every row not marked yet, and leaves a row from an earlier move as it was', () => {
    const first = run();
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: first, commitSha: 'a'.repeat(40), status: 'applied', files: [{ path: '.nolzu/knowledge/stack.md', summary: null }] });
    expect(knowledgeChange(db, 1)?.movedFrom).toBeNull();

    expect(markKnowledgeMoved(db, '/work/one/.nolzu/knowledge')).toBe(1);
    const second = run('APP-2');
    recordKnowledgeChanges(db, { cardKey: 'APP-2', runId: second, commitSha: 'b'.repeat(40), status: 'applied', files: [{ path: '.nolzu/knowledge/api.md', summary: null }] });
    expect(markKnowledgeMoved(db, '/work/two/.nolzu/knowledge')).toBe(1);

    expect(allKnowledgeChanges(db).map((row) => row.movedFrom)).toEqual(['/work/one/.nolzu/knowledge', '/work/two/.nolzu/knowledge']);
  });
});
