import type { RepoState, WorkspaceFile } from '@nolzu/runner';
import { expect, it } from 'vitest';
import { allClean, changedLine, defaultMessage, defaultTicks, folderTree, isClean, NOLZU_MESSAGE, syncLine } from './workspace-page.ts';

const file = (path: string, owner: 'nolzu' | 'yours', status: WorkspaceFile['status'] = 'changed'): WorkspaceFile => ({ path, oldPath: null, status, staged: false, owner });
const repo = (over: Partial<Extract<RepoState, { ok: true }>> = {}): RepoState => ({ ok: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, files: [], confirmation: null, ...over });

it('words the sync state without fetching anything', () => {
  expect(syncLine(repo())).toBe('Up to date');
  expect(syncLine(repo({ ahead: 1 }))).toBe('1 to push');
  expect(syncLine(repo({ behind: 2 }))).toBe('2 behind');
  expect(syncLine(repo({ ahead: 1, behind: 2 }))).toBe('1 to push, 2 behind');
  expect(syncLine(repo({ upstream: null }))).toBe('No upstream');
  expect(syncLine(repo({ branch: null, upstream: null }))).toBe('Detached');
  expect(syncLine({ ok: false, reason: 'The folder is not there.' })).toBe('Missing');
  expect(syncLine({ ok: false, reason: 'The folder is not a git repository.' })).toBe('Cannot read');
});

it('counts the changed files in words', () => {
  expect(changedLine(repo())).toBe('Clean');
  expect(changedLine(repo({ files: [file('a', 'yours')] }))).toBe('1 changed');
  expect(changedLine({ ok: false, reason: 'x' })).toBe('');
});

it('ticks the Nolzu files and never the files of the person', () => {
  expect([...defaultTicks(repo({ files: [file('AGENTS.md', 'nolzu'), file('src/app.ts', 'yours')] }))]).toEqual(['AGENTS.md']);
});

it('fills the message only for a commit of Nolzu files alone', () => {
  const files = [file('AGENTS.md', 'nolzu'), file('src/app.ts', 'yours')];
  expect(defaultMessage(files, new Set(['AGENTS.md']))).toBe(NOLZU_MESSAGE);
  expect(defaultMessage(files, new Set(['AGENTS.md', 'src/app.ts']))).toBe('');
  expect(defaultMessage(files, new Set())).toBe('');
});

it('is all clean only with no change and nothing to push anywhere', () => {
  const status = (state: RepoState) => ({ ok: true as const, changed: 0, checkedAt: 0, repos: [{ id: '.', name: 'recipes', state }] });
  expect(allClean(status(repo()))).toBe(true);
  expect(allClean(status(repo({ behind: 3 })))).toBe(true);
  expect(allClean(status(repo({ ahead: 1 })))).toBe(false);
  expect(allClean(status(repo({ files: [file('a', 'yours')] })))).toBe(false);
  expect(allClean(status({ ok: false, reason: 'x' }))).toBe(false);
});

it('folds the clean folders and keeps the ones that need a hand', () => {
  expect(isClean(repo())).toBe(true);
  expect(isClean(repo({ behind: 2 }))).toBe(true);
  expect(isClean(repo({ ahead: 1 }))).toBe(false);
  expect(isClean(repo({ files: [file('a', 'yours')] }))).toBe(false);
  expect(isClean({ ok: false, reason: 'The folder is not there.' })).toBe(false);
});

it('groups the files by folder, two levels deep, with the top files apart', () => {
  const tree = folderTree([file('AGENTS.md', 'nolzu'), file('.claude/skills/plan/SKILL.md', 'nolzu'), file('src/app.ts', 'yours'), file('.claude/skills/qa/SKILL.md', 'nolzu'), file('.nolzu/phases/plan.md', 'nolzu')]);
  expect(tree.top.map((one) => one.path)).toEqual(['AGENTS.md']);
  expect(tree.folders.map((folder) => [folder.path, folder.files.map((one) => one.path)])).toEqual([
    ['.claude/skills', ['.claude/skills/plan/SKILL.md', '.claude/skills/qa/SKILL.md']],
    ['src', ['src/app.ts']],
    ['.nolzu/phases', ['.nolzu/phases/plan.md']],
  ]);
});

it('lists the files of a folder in number order', () => {
  const tree = folderTree(['s1', 's10', 's2', 'S3'].map((name) => file(`steps/${name}.md`, 'yours')));
  expect(tree.folders[0]?.files.map((one) => one.path)).toEqual(['steps/s1.md', 'steps/s2.md', 'steps/S3.md', 'steps/s10.md']);
});
