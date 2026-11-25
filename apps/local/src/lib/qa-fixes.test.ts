import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applyTriage, cardDiscussions, createCard, type DiscussionInput, openDatabase, saveCardPull, storeDiscussions } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failedFixes, keepReport, qaFixesMessage } from './qa-fixes.ts';

let dir = '';
let db: DatabaseSync;
let pull = 0;

const thread = (githubId: string, body: string): DiscussionInput => ({
  kind: 'thread',
  githubId,
  path: 'src/search.ts',
  line: 12,
  resolved: false,
  outdated: false,
  messages: [{ githubId: `${githubId}-1`, author: 'dana', body, createdAt: '2026-10-01T00:00:00Z' }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-qa-fixes-'));
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'pr-watch', title: 'Add a search box' });
  pull = saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('qaFixesMessage', () => {
  it('names the fixed comments, the diff since the review, and how to merge the report', () => {
    storeDiscussions(db, pull, 'pat', [thread('R1', 'The search misses capitals.'), thread('R2', 'Name the helper better.')]);
    applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 'Case is ignored.', reason: 'r', reply: null }]);
    db.prepare("UPDATE pr_discussions SET status = 'fixed', fix_note = 'Lower-cased both sides.' WHERE ref = 'T1'").run();
    const rows = cardDiscussions(db, 'APP-1').filter((one) => one.ref === 'T1');

    const text = qaFixesMessage(rows, [{ id: pull, repo: 'cook/recipes', number: 12 }], '2026-11-16T09:30:00.000Z');
    expect(text).toMatch(/^This QA run checks the fixes made for review comments on this card's pull request, not the whole card again\. One comment was fixed since the QA of 2026-11-16:/);
    expect(text).toContain('T1: A review thread on cook/recipes#12, on src/search.ts:12.');
    expect(text).toContain('An earlier fix said: Lower-cased both sides.');
    expect(text).not.toContain('Name the helper better.');
    expect(text).toContain('run `git diff @{upstream}` in each repository of the card');
    expect(text).toContain('Start from `<card folder>/qa/report.md`, the report of the QA of 2026-11-16');
    expect(text).toContain('- Keep every row of section 2 in its place and with its number.');
    expect(text).toContain('its How line becomes `How: from the QA of 2026-11-16, the fixes do not touch it`');
    expect(text).toContain('its step starting with the ref, such as `T1: The search ignores case now`');
    expect(text).toContain('- Section 1 and the verdict are about the whole report.');

    expect(qaFixesMessage([...rows, ...rows], [], null)).toContain('2 comments were fixed since the last QA:');
  });
});

describe('failedFixes', () => {
  const report = (rows: string) => `## 1. Verdict\n\n- FAIL\n\n## 2. What QA checked\n\n${rows}\n\n## 3. What was not checked\n\nNothing.\n`;

  it('sends back the comments whose own row failed, with what QA saw', () => {
    const text = report(
      [
        "1. pass: Run the project's tests, they pass",
        '   How: from the QA of 2026-11-16, the fixes do not touch it',
        '2. fail: T1: The search ignores case now',
        '   Reason: capitals still miss',
        '   Expected: "Bean" finds bean soup',
        '   Actual: no result',
        '3. pass: T2: The helper has a better name',
      ].join('\n'),
    );
    expect(failedFixes(text, ['T1', 'T2'], 'T1 failed')).toEqual([{ ref: 'T1', reason: 'QA says: capitals still miss. Expected: "Bean" finds bean soup. Actual: no result' }]);
  });

  it('sends back every checked comment when only another row failed, naming the first failed check', () => {
    const text = report(["1. fail: Run the project's tests, they pass", '   Reason: 2 tests fail', '2. pass: T1: The search ignores case now'].join('\n'));
    expect(failedFixes(text, ['T1', 'T4'], null)).toEqual([
      { ref: 'T1', reason: "QA failed a check no comment names: Run the project's tests, they pass, 2 tests fail" },
      { ref: 'T4', reason: "QA failed a check no comment names: Run the project's tests, they pass, 2 tests fail" },
    ]);
    // A ref the run did not check never goes back, and no report falls back on the verdict's reason.
    expect(failedFixes(report('1. fail: T9: Something else'), ['T1'], 'r')).toEqual([{ ref: 'T1', reason: 'QA failed a check no comment names: T9: Something else' }]);
    expect(failedFixes(null, ['T1'], 'The app did not load.')).toEqual([{ ref: 'T1', reason: 'QA failed a check no comment names: The app did not load.' }]);
  });
});

describe('keepReport', () => {
  it('keeps each report a run writes over, numbered, and skips one it already kept', () => {
    const qa = join(dir, 'qa');
    expect(keepReport(qa)).toBeNull();
    mkdirSync(qa, { recursive: true });
    writeFileSync(join(qa, 'report.md'), 'first');
    expect(keepReport(qa)).toBe(join('qa', 'history', 'report-1.md'));
    // A run that ended before it wrote a report leaves the same one there.
    expect(keepReport(qa)).toBeNull();
    writeFileSync(join(qa, 'report.md'), 'second');
    expect(keepReport(qa)).toBe(join('qa', 'history', 'report-2.md'));
    expect(readdirSync(join(qa, 'history')).sort()).toEqual(['report-1.md', 'report-2.md']);
    expect(readFileSync(join(qa, 'history', 'report-1.md'), 'utf8')).toBe('first');
  });

  // A run can put a link at the report or at the history folder. The copy never reads the file a link
  // points to, and never writes through one.
  it('keeps nothing through a link at the report or at the history folder', () => {
    const qa = join(dir, 'qa');
    mkdirSync(qa, { recursive: true });
    const secret = join(dir, '..', `${basename(dir)}-secret`);
    writeFileSync(secret, 'not-a-real-key\n');
    try {
      symlinkSync(secret, join(qa, 'report.md'));
      expect(keepReport(qa)).toBeNull();
      expect(existsSync(join(qa, 'history'))).toBe(false);

      rmSync(join(qa, 'report.md'));
      writeFileSync(join(qa, 'report.md'), 'mine');
      const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
      symlinkSync(outside, join(qa, 'history'));
      expect(() => keepReport(qa)).toThrow(/link/);
      expect(readdirSync(outside)).toEqual([]);
      rmSync(outside, { recursive: true });
    } finally {
      rmSync(secret, { force: true });
    }
  });
});
