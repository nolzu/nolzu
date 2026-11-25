import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writablePath } from './writable.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-writable-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('gives the full path of a file that is not there yet', () => {
  expect(writablePath(dir, 'CLAUDE.md')).toBe(join(dir, 'CLAUDE.md'));
  expect(writablePath(dir, '.claude/settings.json')).toBe(join(dir, '.claude', 'settings.json'));
});

it('gives the path of a plain file that is already there', () => {
  writeFileSync(join(dir, 'CLAUDE.md'), 'theirs');

  expect(writablePath(dir, 'CLAUDE.md')).toBe(join(dir, 'CLAUDE.md'));
});

// The file the link points at belongs to something else, often every project on the machine.
it('refuses a symlinked file', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
  writeFileSync(join(outside, 'CLAUDE.md'), 'shared');
  symlinkSync(join(outside, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));

  try {
    expect(writablePath(dir, 'CLAUDE.md')).toBeNull();
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('refuses a path through a symlinked folder', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
  mkdirSync(join(outside, 'claude'));
  symlinkSync(join(outside, 'claude'), join(dir, '.claude'));

  try {
    expect(writablePath(dir, '.claude/settings.json')).toBeNull();
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A hard link has no arrow to follow: it is the same bytes under a second name, and a write
// truncates every name at once.
it('refuses a hard link', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
  writeFileSync(join(outside, 'CLAUDE.md'), 'shared');
  linkSync(join(outside, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));

  try {
    expect(writablePath(dir, 'CLAUDE.md')).toBeNull();
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('refuses a folder where a file belongs', () => {
  mkdirSync(join(dir, 'CLAUDE.md'));

  expect(writablePath(dir, 'CLAUDE.md')).toBeNull();
});

it.each(['/etc/passwd', '../outside.md', 'a/../../outside.md', '', 'a//b.md', './a.md', 'a\\b.md'])('refuses the path %j', (path) => {
  expect(writablePath(dir, path)).toBeNull();
});
