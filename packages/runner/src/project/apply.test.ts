import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyPlan } from './apply.ts';
import { planProjectFiles } from './plan.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-apply-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const plan = (existing: Record<string, string> = {}) =>
  planProjectFiles({
    existing,
    agents: 'How an agent works here.',
    pointer: 'Read AGENTS.md first.',
    pointerPath: 'CLAUDE.md',
  });

const read = (path: string) => readFileSync(join(dir, path), 'utf8');

it('writes every file and makes both folders', () => {
  const result = applyPlan(dir, dir, plan());

  expect(result.failed).toBeNull();
  expect(existsSync(join(dir, 'WORKSPACE.md'))).toBe(false);
  expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
  expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
  expect(existsSync(join(dir, '.tasks'))).toBe(true);
  expect(existsSync(join(dir, 'worktrees'))).toBe(true);
  // The guard has to be the real script, or it refuses nothing.
  expect(read('.claude/hooks/nolzu-phase-guard.mjs')).toContain('process.exit(2)');
});

it('changes no byte on a second run', () => {
  applyPlan(dir, dir, plan());
  const before = ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json'].map(read);

  // The second plan is built from what the first run left behind, which is what really happens.
  const existing = Object.fromEntries(
    ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.claude/hooks/nolzu-phase-guard.mjs'].map(
      (path) => [path, read(path)],
    ),
  );
  applyPlan(dir, dir, plan(existing));

  expect(['AGENTS.md', 'CLAUDE.md', '.claude/settings.json'].map(read)).toEqual(before);
});

it('replaces the block and keeps the words around it', () => {
  const theirs = '# AGENTS.md\n\nTheirs.\n\n<!-- nolzu:start -->\nOld words.\n<!-- nolzu:end -->\n\nAfter.\n';
  writeFileSync(join(dir, 'AGENTS.md'), theirs);

  applyPlan(dir, dir, plan({ 'AGENTS.md': theirs }));

  const next = read('AGENTS.md');
  expect(next).toContain('Theirs.');
  expect(next).toContain('After.');
  expect(next).toContain('How an agent works here.');
  expect(next).not.toContain('Old words.');
});

it('leaves a file it planned to keep exactly as it was', () => {
  // Half a block: where the person's own text starts is not known, so the file is kept.
  const theirs = '# AGENTS.md\n\n<!-- nolzu:start -->\nCut off.\n';
  writeFileSync(join(dir, 'AGENTS.md'), theirs);

  const result = applyPlan(dir, dir, plan({ 'AGENTS.md': theirs }));

  expect(read('AGENTS.md')).toBe(theirs);
  expect(result.kept).toContain('AGENTS.md');
});

// An older Nolzu's WORKSPACE.md goes once AGENTS.md holds its text, and the report says so.
it('removes a WORKSPACE.md that holds only the Nolzu section', () => {
  const ours = '<!-- nolzu:start -->\nOld words.\n<!-- nolzu:end -->\n';
  writeFileSync(join(dir, 'WORKSPACE.md'), ours);

  const result = applyPlan(dir, dir, plan({ 'WORKSPACE.md': ours }));

  expect(existsSync(join(dir, 'WORKSPACE.md'))).toBe(false);
  expect(result.removed).toEqual(['WORKSPACE.md']);
  expect(result.written).not.toContain('WORKSPACE.md');
  expect(read('AGENTS.md')).toContain('How an agent works here.');
});

// A folder where a file belongs is the person's arrangement too. The rest of the project is still
// set up, and the report names the one file that was left.
it('leaves a path that is not a plain file, and writes the rest', () => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'settings.json'), { recursive: true });

  const result = applyPlan(dir, dir, plan());

  expect(result.refused.map((one) => one.path)).toEqual(['.claude/settings.json']);
  expect(result.written).toContain('AGENTS.md');
  expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
});

// A run that stops half way has still changed the project. Saying nothing happened would send
// the person looking for files that are already there.
it('keeps the earlier writes when one fails, and reports them', () => {
  mkdirSync(join(dir, 'open'), { recursive: true });
  mkdirSync(join(dir, 'shut'), { recursive: true });
  const writes = [
    { path: 'open/first.md', kind: 'create' as const, content: 'first', note: '' },
    { path: 'shut/second.md', kind: 'create' as const, content: 'second', note: '' },
  ];

  chmodSync(join(dir, 'shut'), 0o500);
  const result = applyPlan(dir, dir, { ...plan(), writes });
  chmodSync(join(dir, 'shut'), 0o700);

  // What was written stays written, and the report names it, or the person goes looking for files
  // that are already there.
  expect(result.written).toEqual(['open/first.md']);
  expect(result.failed?.path).toBe('shut/second.md');
});

// The settings file names the guard script. Written on its own, every tool call of every run would
// call a file that is not there.
it('leaves the settings alone when the guard script could not be written', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-dotfiles-'));
  mkdirSync(join(outside, 'hooks'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  symlinkSync(join(outside, 'hooks'), join(dir, '.claude', 'hooks'));

  const result = applyPlan(dir, dir, plan());

  try {
    expect(result.refused.map((one) => one.path)).toEqual(['.claude/hooks/nolzu-phase-guard.mjs', '.claude/settings.json']);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
    expect(result.written).toContain('AGENTS.md');
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A second name for the same bytes. A write truncates the file every other name points at too.
it('refuses to write through a hard link', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-dotfiles-'));
  const shared = join(outside, 'CLAUDE.md');
  writeFileSync(shared, 'Mine.\n');
  linkSync(shared, join(dir, 'CLAUDE.md'));

  const result = applyPlan(dir, dir, plan());

  try {
    expect(result.refused.map((one) => one.path)).toEqual(['CLAUDE.md']);
    expect(readFileSync(shared, 'utf8')).toBe('Mine.\n');
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The project side of the rule that protects the database: nothing is written into a folder the
// person did not choose.
it('refuses a folder that is not the configured project', () => {
  const other = mkdtempSync(join(tmpdir(), 'nolzu-other-'));
  try {
    const result = applyPlan(other, dir, plan());

    expect(result.failed?.message).toContain(other);
    expect(result.written).toEqual([]);
    expect(existsSync(join(other, 'AGENTS.md'))).toBe(false);
  } finally {
    rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The same folder reached by two different strings. On macOS /tmp is a symlink to /private/tmp,
// so a stored project path and the folder handed in really do differ as text while naming one
// place. Comparing them as written refuses the folder the person actually chose.
it('accepts the project folder reached through a symlink', () => {
  const other = mkdtempSync(join(tmpdir(), 'nolzu-link-'));
  const link = join(other, 'project');
  symlinkSync(dir, link);
  try {
    expect(link).not.toBe(dir);

    const result = applyPlan(link, dir, plan());

    expect(result.failed).toBeNull();
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
  } finally {
    rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A symlinked CLAUDE.md is a normal dotfiles setup, and the file it points at is shared with
// everything else that links to it. The skill sync has always refused such a path; this is the
// same rule for the project files.
it('refuses to write through a symlinked file, and leaves the file it points at alone', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-dotfiles-'));
  const shared = join(outside, 'CLAUDE.md');
  writeFileSync(shared, 'Mine, shared by every project.\n');
  symlinkSync(shared, join(dir, 'CLAUDE.md'));

  const result = applyPlan(dir, dir, plan());

  try {
    expect(result.refused.map((one) => one.path)).toEqual(['CLAUDE.md']);
    expect(result.refused[0]?.message).toMatch(/link/);
    expect(readFileSync(shared, 'utf8')).toBe('Mine, shared by every project.\n');
    expect(result.written).not.toContain('CLAUDE.md');
    // The rest is still written: a link on one file is no reason to leave the project half set up.
    expect(result.written).toContain('AGENTS.md');
    expect(result.failed).toBeNull();
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('refuses a file under a symlinked folder, such as a shared .claude', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-dotfiles-'));
  mkdirSync(join(outside, 'claude'));
  writeFileSync(join(outside, 'claude', 'settings.json'), '{ "mine": true }\n');
  symlinkSync(join(outside, 'claude'), join(dir, '.claude'));

  const result = applyPlan(dir, dir, plan());

  try {
    expect(result.refused.map((one) => one.path)).toEqual(['.claude/hooks/nolzu-phase-guard.mjs', '.claude/settings.json']);
    expect(readFileSync(join(outside, 'claude', 'settings.json'), 'utf8')).toBe('{ "mine": true }\n');
    expect(result.written).toContain('AGENTS.md');
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
