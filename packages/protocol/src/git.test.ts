import { expect, it } from 'vitest';
import { type Changes, changesView, hasUncommitted, hasWork, type WorktreeRow } from './git.ts';

const row = (over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  repo: 'api', path: '/w/api', branch: 'APP-1-search', base: 'main', ahead: 0, behind: 3, changed: 0, untracked: 0, unpushed: null, stale: false, staleReason: null, ...over,
});
const none = { stat: { files: 0, added: 0, removed: 0 }, tree: [] };
const of = (over: Partial<WorktreeRow> = {}, files = 0): Changes => ({ ok: true, row: row(over), committed: none, uncommitted: none, untracked: [], diff: { stat: { files, added: files, removed: 0 }, tree: [] } });

it('counts a repository as worked in on a change, a loose file, a commit ahead or a stale checkout', () => {
  expect([of({}, 1), of({ changed: 1 }), of({ untracked: 1 }), of({ ahead: 1 }), of({ stale: true })].map(hasWork)).toEqual([true, true, true, true, true]);
});

it('counts nothing for a clean checkout behind its base, or for a repository with no checkout', () => {
  expect(hasWork(of())).toBe(false);
  expect(hasWork({ ok: false, reason: 'APP-1 does not work in api.' })).toBe(false);
});

it('opens Changes on the whole card in Review while the card has no commit, and on Not committed elsewhere', () => {
  expect(changesView(null, 'review', false)).toBe('all');
  expect(changesView(null, 'review', true)).toBe('uncommitted');
  expect(['implement', 'plan', 'qa', 'pr-watch', 'closed'].map((stage) => changesView(null, stage, false))).toEqual(Array(5).fill('uncommitted'));
});

it('takes the view the address names over the default, and ignores a word it does not know', () => {
  expect(changesView('uncommitted', 'review', false)).toBe('uncommitted');
  expect(changesView('all', 'implement', true)).toBe('all');
  expect(changesView('everything', 'review', false)).toBe('all');
  expect(changesView('everything', 'implement', false)).toBe('uncommitted');
});

it('counts a repository as not committed on a file in the folder or a stale checkout, never on a commit alone', () => {
  const loose = (files: number, over: Partial<WorktreeRow> = {}): Changes => ({ ...(of(over, 3) as Extract<Changes, { ok: true }>), uncommitted: { stat: { files, added: files, removed: 0 }, tree: [] } });
  expect([loose(1), loose(0, { stale: true })].map(hasUncommitted)).toEqual([true, true]);
  expect([loose(0, { ahead: 2 }), { ok: false as const, reason: 'none' }].map(hasUncommitted)).toEqual([false, false]);
});
