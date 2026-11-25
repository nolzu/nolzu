import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { notifications, openDatabase } from '@nolzu/core/node';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { noteMaintenanceFailure, noteRunEnd } from './notifications.ts';

// The words of each end the loop keeps, one row per run. The loop test covers the calls themselves.

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-note-run-end-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ready = { cardState: 'ready' as const, failureReason: null, question: null };
const kept = () => notifications(db).map((one) => [one.kind, one.text]);
const failed = (failureReason: string | null) => ({ cardState: 'failed' as const, failureReason });

it('words a QA end as its verdict, and a run with none as finished', () => {
  noteRunEnd(db, { id: 1, key: 'APP-1', phase: 'qa' }, ready, { verdict: 'PASS', reason: null });
  noteRunEnd(db, { id: 2, key: 'APP-1', phase: 'qa' }, ready, { verdict: 'FAIL', reason: 'The login page 500s.\nmore' });
  noteRunEnd(db, { id: 3, key: 'APP-1', phase: 'qa' }, ready, { verdict: 'FAIL', reason: null });
  noteRunEnd(db, { id: 4, key: 'APP-1', phase: 'qa' }, ready, { verdict: null, reason: 'It printed no verdict.' });
  noteRunEnd(db, { id: 5, key: 'APP-1', phase: 'plan' }, ready, null);
  noteRunEnd(db, { id: 6, key: 'APP-1', phase: 'plan' }, { cardState: 'failed', failureReason: null, question: null }, null);
  noteRunEnd(db, { id: 7, key: 'APP-1', phase: 'plan' }, { cardState: 'blocked', failureReason: null, question: null }, null);

  expect(kept().reverse()).toEqual([
    ['success', 'QA passed'],
    ['error', 'QA failed: The login page 500s.'],
    ['error', 'QA failed'],
    ['warning', 'QA gave no verdict: It printed no verdict.'],
    ['success', 'Plan finished'],
    ['error', 'Plan failed. It gave no reason.'],
    ['warning', 'Plan asks you: Read the question on the card.'],
  ]);
});

it('keeps nothing for a run that ended any other way', () => {
  noteRunEnd(db, { id: 1, key: 'APP-1', phase: 'plan' }, { cardState: 'queued', failureReason: null, question: null }, null);
  expect(kept()).toEqual([]);
});

// Learn and Optimize belong to no card and raise no toast, so a failure is kept for the bell, with
// Knowledge as its link. Any other end, or a card's run, keeps nothing here.
it('keeps a failed knowledge run of no card, linked to Knowledge', () => {
  noteMaintenanceFailure(db, { id: 1, key: 'kb-learn-api', phase: 'learn-repo' }, failed('Error: EPERM\nat open'));
  noteMaintenanceFailure(db, { id: 2, key: 'kb-maintenance', phase: 'optimize' }, failed(null));
  noteMaintenanceFailure(db, { id: 3, key: 'kb-learn-api', phase: 'learn-repo' }, { cardState: 'ready', failureReason: null });
  noteMaintenanceFailure(db, { id: 4, key: 'APP-1', phase: 'plan' }, failed('broken'));

  expect(kept().reverse()).toEqual([
    ['error', 'Learning api failed: Error: EPERM'],
    ['error', 'Optimize failed. It gave no reason.'],
  ]);
  expect(notifications(db).map((one) => one.href)).toEqual(['/knowledge', '/knowledge']);
});

