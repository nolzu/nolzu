import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type KnowledgeStatus, knowledgeChangesOfRun, openDatabase, recordKnowledgeChanges, revertKnowledgeChange, startRun, writeSetting } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY, learnRepoKey } from '@nolzu/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { answerApprove, answerApproveAll, answerReturn, keepHeld } from './knowledge-review.ts';

// The two answers as the screen posts them. What a whole wrap-up run through the loop proves is in
// wrapup-run.test.ts; this file is about the refusals a person can reach from the form itself.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-review-'));
let db: DatabaseSync;

beforeAll(() => {
  db = openDatabase(dir);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const free = { dataDir: dir, snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: null }] }) };
const post = (body: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.append(name, value);
  return form;
};

// One run with one change row in the state the test needs.
function change(cardKey: string, status: KnowledgeStatus): number {
  const runId = startRun(db, { cardKey, phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, {
    cardKey,
    runId,
    commitSha: status === 'pending' ? null : 'a'.repeat(40),
    status,
    files: [{ path: '.nolzu/knowledge/search.md', summary: 'added' }],
  });
  return runId;
}

// The rule AGENTS names: busy state comes from the board snapshot and from nowhere else. A commit
// in a folder a run is writing would fight that run over the index.
it('refuses an approve while the board snapshot says a card holds the knowledge lane', async () => {
  const runId = change('APP-1', 'pending');
  const busy = { dataDir: dir, snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: 'APP-2' }] }) };

  const answer = await answerApprove(db, busy, post({ run: String(runId) }));

  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('APP-2');
  expect(knowledgeChangesOfRun(db, runId).map((row) => row.status)).toEqual(['pending']);
});

// A post nobody wrote by hand always names a run. This is the other kind, and a sentence about run
// NaN would say nothing to whoever reads it.
// Apply all stops at the first refusal; with nothing applied the answer is that refusal alone.
it('answers Apply all with the first refusal alone when nothing went in, and refuses an empty list', async () => {
  const runId = change('APP-21', 'pending');
  const busy = { dataDir: dir, snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: 'APP-9' }] }) };

  expect(await answerApproveAll(db, busy, post({ run: String(runId) }))).toEqual({ ok: false, message: 'APP-9 is writing the knowledge folder right now. Approve this change once that run has ended.' });
  expect(await answerApproveAll(db, free, new FormData())).toEqual({ ok: false, message: 'Nothing waits for a person, so there is nothing to apply.' });
});

it('answers a form that names no run', async () => {
  const approve = await answerApprove(db, free, post({ run: 'the first one' }));

  expect(approve.ok).toBe(false);
  expect(approve.message).toBe('That form named no run, so there was nothing to answer.');
  expect(answerReturn(db, free, post({ run: '', note: 'again' })).message).toBe(approve.message);
});

it('refuses an approve of a change that was applied and then reverted', async () => {
  const runId = change('APP-3', 'reverted');

  const answer = await answerApprove(db, free, post({ run: String(runId) }));

  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('reverted');
});

// Revert answers one file, so a run that wrote two can have one row back and one still in the
// knowledge files. The sentence names the one that is still there.
it('names the file still applied when only part of a run was reverted', async () => {
  const runId = startRun(db, { cardKey: 'APP-7', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, {
    cardKey: 'APP-7',
    runId,
    commitSha: 'b'.repeat(40),
    status: 'applied',
    files: [{ path: '.nolzu/knowledge/search.md', summary: 'added' }, { path: '.nolzu/knowledge/testing.md', summary: 'added' }],
  });
  revertKnowledgeChange(db, knowledgeChangesOfRun(db, runId)[0]?.id ?? 0);

  const answer = await answerApprove(db, free, post({ run: String(runId) }));

  expect(answer.ok).toBe(false);
  expect(answer.message).toBe(`The knowledge change of run ${runId} was applied already, as commit bbbbbbb. Nothing was applied a second time.`);
});

it('refuses a return of a change that was applied and then reverted', () => {
  const runId = change('APP-4', 'reverted');

  expect(answerReturn(db, free, post({ run: String(runId), note: 'too long' })).ok).toBe(false);
});

// The folder is read fresh at every approve, because the person can change the project between the
// run and their answer.
it('refuses an approve when there is no knowledge folder to commit in', async () => {
  const runId = change('APP-5', 'pending');
  keepHeld(dir, { cardKey: 'APP-5', runId, files: [{ path: '.nolzu/knowledge/search.md', kind: 'added', content: 'Run the list first.\n' }] });

  const answer = await answerApprove(db, free, post({ run: String(runId) }));

  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('Make a project on New project at /new.');
});

// The other half of the same refusal: a project is set and its knowledge folder is not there. The
// sentence names the folder, so the person can see which one the app looked for.
it('names the folder when an approve finds no knowledge folder on disk', async () => {
  const own = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-review-gone-'));
  const ownDb = openDatabase(own);
  writeSetting(ownDb, 'projectPath', join(own, 'recipes'));
  const runId = startRun(ownDb, { cardKey: 'APP-8', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(ownDb, { cardKey: 'APP-8', runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/search.md', summary: 'added' }] });
  keepHeld(own, { cardKey: 'APP-8', runId, files: [{ path: '.nolzu/knowledge/search.md', kind: 'added', content: 'Run the list first.\n' }] });

  const answer = await answerApprove(ownDb, { dataDir: own, snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: null }] }) }, post({ run: String(runId) }));

  expect(answer.ok).toBe(false);
  expect(answer.message).toBe(`There is no knowledge folder ${join(own, 'recipes')}/.nolzu/knowledge to commit in. Make a project on New project at /new.`);
  ownDb.close();
  rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('takes the note off the form and stores it with the returned rows', () => {
  const runId = change('APP-6', 'pending');

  const answer = answerReturn(db, free, post({ run: String(runId), note: 'Name the endpoint, not the file.' }));

  expect(answer.ok).toBe(true);
  expect(knowledgeChangesOfRun(db, runId).map((row) => [row.status, row.note])).toEqual([['returned', 'Name the endpoint, not the file.']]);
  expect(answer.message).toBe('Returned. The next wrap-up of APP-6 reads the note.');
});

// Optimize and Learn this project share the reserved key, and each reads only the notes on its own kind.
// Learn your repositories has a key per repository, so the next run of that repository reads it.
it('names the kind of maintenance run that reads a returned note', () => {
  const returned = (phase: string, cardKey = KB_MAINTENANCE_KEY) => {
    const runId = startRun(db, { cardKey, phase, engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
    recordKnowledgeChanges(db, { cardKey, runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/project-rules.md', summary: 'added' }] });
    return answerReturn(db, free, post({ run: String(runId), note: 'Name the folder by its path.' })).message;
  };

  expect(returned('orient')).toBe('Returned. The next Learn this project run reads the note.');
  expect(returned('optimize')).toBe('Returned. The next Optimize run reads the note.');
  expect(returned('learn-repo', learnRepoKey('api'))).toBe('Returned. The next Learn your repositories run of that repository reads the note.');
});
