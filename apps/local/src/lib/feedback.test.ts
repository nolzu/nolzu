import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applyTriage, cardDiscussions, createCard, type DiscussionInput, markDiscussion, openDatabase, saveCardPull, storeDiscussions, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTriageFile, discussMessage, DISCUSSIONS_FILE, fixAllMessage, FIXES_FILE, fixFeedbackMessage, keptMessages, readFixNotes, TRIAGE_FILE, triageOfferFor, triageProblem, writeFeedbackFile } from './feedback.ts';

let dir = '';
let taskDir = '';
let db: DatabaseSync;
let pull = 0;

const say = (githubId: string, author: string, createdAt: string, body = `said ${githubId}`) => ({ githubId, author, body, createdAt });
const thread = (githubId: string, messages: DiscussionInput['messages']): DiscussionInput => ({ kind: 'thread', githubId, path: 'src/search.ts', line: 12, resolved: false, outdated: false, messages });
const comment = (githubId: string, author: string, createdAt: string): DiscussionInput => ({ kind: 'comment', githubId, path: null, line: null, resolved: false, outdated: false, messages: [say(githubId, author, createdAt)] });
const written = () => readFileSync(join(taskDir, DISCUSSIONS_FILE), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-feedback-'));
  taskDir = join(dir, 'task');
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'pr-watch', title: 'Add a search box' });
  pull = saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('keptMessages', () => {
  it('cuts the oldest first and always keeps the newest', () => {
    const messages = [{ body: 'a'.repeat(5) }, { body: 'b'.repeat(5) }, { body: 'c'.repeat(5) }];
    expect(keptMessages(messages, 10)).toEqual({ kept: messages.slice(1), cut: 1 });
    expect(keptMessages([{ body: 'x'.repeat(50) }], 10)).toEqual({ kept: [{ body: 'x'.repeat(50) }], cut: 0 });
  });
});

describe('writeFeedbackFile', () => {
  it('writes every open discussion with its facts, marks the person own messages and gives the plan', () => {
    mkdirSync(join(taskDir, 'plan'), { recursive: true });
    writeFileSync(join(taskDir, 'plan', 'plan.md'), '# Plan\n\nFilter the list in the browser.\n');
    storeDiscussions(db, pull, 'pat', [thread('R1', [say('C1', 'dana', '2026-10-01T00:00:00Z', 'Lower case it.\nPlease.'), say('C2', 'pat', '2026-10-02T00:00:00Z')]), comment('I1', 'dana', '2026-10-03T00:00:00Z')]);

    expect(writeFeedbackFile(db, 'APP-1', 'Add a search box', taskDir)).toBe(2);
    const text = written();
    expect(text).toContain('# Open discussions on APP-1: Add a search box');
    expect(text).toContain('From plan/plan.md:\n\n> # Plan\n>\n> Filter the list in the browser.');
    expect(text).toContain('## T1\n\nKind: review thread on src/search.ts:12\nPull request: cook/recipes#12\nStatus: new');
    expect(text).toContain('dana, 2026-10-01T00:00:00Z:\n> Lower case it.\n> Please.');
    expect(text).toContain("pat (the person's own), 2026-10-02T00:00:00Z:\n> said C2");
    expect(text).toContain('## T2\n\nKind: comment\n');
  });

  it('includes the earlier verdict and fix note, and leaves out a done discussion', () => {
    storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
    applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 'Case', reason: 'Right', reply: 'Will do.' }]);
    db.prepare("UPDATE pr_discussions SET fix_note = 'Lower cased both sides.' WHERE ref = 'T1'").run();
    markDiscussion(db, 'APP-1', 'T2', 'done');

    writeFeedbackFile(db, 'APP-1', 'Add a search box', taskDir);
    const text = written();
    expect(text).toContain('Earlier verdict: fix\nEarlier summary: Case\nEarlier reason: Right\nFix note: Lower cased both sides.');
    expect(text).not.toContain('## T2');
    expect(text).toContain('The card has no plan or brief in its folder');
  });

  it('cuts the oldest messages of a long thread and says how many', () => {
    const long = 'x'.repeat(3000);
    storeDiscussions(db, pull, 'pat', [thread('R1', ['1', '2', '3', '4'].map((n) => say(`C${n}`, 'bot', `2026-10-0${n}T00:00:00Z`, `${n}${long}`)))]);
    writeFeedbackFile(db, 'APP-1', 'Add a search box', taskDir);
    const text = written();
    expect(text).toContain('2 older messages were cut to keep this file short. The newest 2 follow.');
    expect(text).not.toContain('> 1x');
    expect(text).toContain('> 4x');
  });

  it('refuses a card with nothing open and drops an old triage file', () => {
    expect(() => writeFeedbackFile(db, 'APP-1', 'Add a search box', taskDir)).toThrow('APP-1 has no open discussion to triage.');
    storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);
    mkdirSync(join(taskDir, 'feedback'), { recursive: true });
    writeFileSync(join(taskDir, TRIAGE_FILE), 'old');
    writeFeedbackFile(db, 'APP-1', 'Add a search box', taskDir);
    expect(triageProblem(taskDir)).toBeNull();
  });
});

describe('applyTriageFile', () => {
  const triage = (text: string) => {
    mkdirSync(join(taskDir, 'feedback'), { recursive: true });
    writeFileSync(join(taskDir, TRIAGE_FILE), text);
  };

  it('applies a good file and skips a ref that is not open', () => {
    storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
    markDiscussion(db, 'APP-1', 'T2', 'done');
    triage('T1: clarify\nSummary: Which case?\nReason: Unclear.\nReply: Do you mean titles only?\n\nT2: fix\nSummary: s\nReason: r\nReply: x\n');

    expect(applyTriageFile(db, 'APP-1', taskDir)).toEqual({ ok: true, applied: 1, ignored: 1 });
    expect(cardDiscussions(db, 'APP-1').map((one) => [one.ref, one.status, one.verdict, one.reply])).toEqual([
      ['T1', 'new', 'clarify', 'Do you mean titles only?'],
      ['T2', 'done', null, null],
    ]);
  });

  it('refuses a broken file whole, names the line, and the tab says so', () => {
    storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
    triage('T1: fix\nSummary: s\nReason: r\nReply: x\n\nT2: perhaps\nSummary: s\nReason: r\nReply: x\n');

    expect(applyTriageFile(db, 'APP-1', taskDir)).toEqual({ ok: false, problem: 'Line 6 of triage.md gives T2 the verdict "perhaps". The verdicts are fix, reject, clarify, defer and none.' });
    expect(cardDiscussions(db, 'APP-1').map((one) => one.verdict)).toEqual([null, null]);
    expect(triageProblem(taskDir)).toBe('Line 6 of triage.md gives T2 the verdict "perhaps". The verdicts are fix, reject, clarify, defer and none. Each row keeps the verdict it had before.');
  });

  it('says a hand edit after a good triage left the rows as they were', () => {
    storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);
    triage('T1: fix\nSummary: s\nReason: r\nReply: x\n');
    expect(applyTriageFile(db, 'APP-1', taskDir)).toMatchObject({ ok: true });
    triage('T1: fix\nSummary: s\n');

    expect(cardDiscussions(db, 'APP-1')[0]?.verdict).toBe('fix');
    expect(triageProblem(taskDir)).toMatch(/Each row keeps the verdict it had before\.$/);
    expect(triageProblem(taskDir)).not.toContain('No row took');
  });

  it('says so when the run wrote no file', () => {
    expect(applyTriageFile(db, 'APP-1', taskDir)).toEqual({ ok: false, problem: 'The triage run wrote no triage.md, so no row has a verdict from it.' });
    expect(triageProblem(taskDir)).toBeNull();
  });
});

describe('triageOfferFor', () => {
  it('shows the refusal only once no run can still be writing the file', () => {
    writeSetting(db, 'projectPath', dir);
    const folder = join(dir, '.tasks', 'APP-1', 'feedback');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'triage.md'), 'T1: fix\nSummary: half');
    for (const state of ['running', 'blocked', 'ready']) {
      db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, 'APP-1');
      expect([state, triageOfferFor(db, 'APP-1', {}).problem === null]).toEqual([state, state !== 'ready']);
    }
  });

  it('names the engine, model and effort the way every other start does', () => {
    expect(triageOfferFor(db, 'APP-1', {}).starts).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(triageOfferFor(db, 'APP-1', {}).starts.engine).toBeTruthy();
  });
});

describe('fixFeedbackMessage', () => {
  it('hands on every message whole, the file and line, the triage, and the three things a fix never does', () => {
    const long = `${'x'.repeat(9000)} end of the long one`;
    storeDiscussions(db, pull, 'pat', [thread('R1', [say('C1', 'dana', '2026-10-01T00:00:00Z', long), say('C2', 'pat', '2026-10-02T00:00:00Z', 'Which file?'), say('C3', 'dana', '2026-10-03T00:00:00Z', 'Lower case it.\nBoth sides.')])]);
    applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 'The search misses capitals.', reason: 'The compare is case sensitive.', reply: 'Fixed.' }]);
    const [row] = cardDiscussions(db, 'APP-1');

    const text = fixFeedbackMessage(row!, { repo: 'cook/recipes', number: 12 });
    expect(text).toContain('T1: A review thread on cook/recipes#12, on src/search.ts:12.');
    // Every message, the long one too: a fix answers the whole thread.
    expect(text).toContain('end of the long one');
    expect(text).toContain("pat (the person's own), 2026-10-02T00:00:00Z:\n> Which file?");
    expect(text).toContain('dana, 2026-10-03T00:00:00Z:\n> Lower case it.\n> Both sides.');
    expect(text).toContain('Triage verdict: fix\nTriage summary: The search misses capitals.\nTriage reason: The compare is case sensitive.');
    expect(text).toContain('Do not commit, do not push and do not reply on GitHub.');
    expect(text).not.toContain('Fixed.');
  });

  it('says a comment with no line and no triage plainly, and an earlier fix note', () => {
    storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);
    db.prepare("UPDATE pr_discussions SET fix_note = 'Lower cased both sides.', outdated = 1 WHERE ref = 'T1'").run();
    const [row] = cardDiscussions(db, 'APP-1');

    const text = fixFeedbackMessage(row!, undefined);
    expect(text).toContain('T1: A comment.\nThe line has changed since the comment');
    expect(text).toContain('An earlier fix said: Lower cased both sides.');
    expect(text).not.toContain('Triage');
  });
});

describe('fixAllMessage', () => {
  it('hands on every discussion, why a last fix did not hold, the notes file and the three things a fix never does', () => {
    storeDiscussions(db, pull, 'pat', [thread('R1', [say('C1', 'dana', '2026-10-01T00:00:00Z', 'Lower case it.')]), comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
    db.prepare("UPDATE pr_discussions SET fix_failed = 'QA says: the list is empty.' WHERE ref = 'T2'").run();
    const rows = cardDiscussions(db, 'APP-1');

    const text = fixAllMessage(rows, [{ id: pull, repo: 'cook/recipes', number: 12 }]);
    expect(text).toMatch(/^Reviewers left these 2 comments on the pull request of your change\./);
    expect(text).toContain('T1: A review thread on cook/recipes#12, on src/search.ts:12.');
    expect(text).toContain('dana, 2026-10-01T00:00:00Z:\n> Lower case it.');
    expect(text).toContain('T2: A comment on cook/recipes#12.');
    expect(text).toContain('Why the last fix did not hold: QA says: the list is empty.');
    expect(text).toContain('write `<card folder>/feedback/fixes.md` with one line per comment');
    expect(text).toContain('such as `T1: The search lower-cases both sides now.`');
    expect(text).toContain('Do not commit, do not push and do not reply on GitHub.');
  });
});

describe('readFixNotes', () => {
  it('reads one note per ref, the first one winning, and skips lines in another shape', () => {
    expect(readFixNotes(taskDir)).toBeNull();
    mkdirSync(join(taskDir, 'feedback'), { recursive: true });
    writeFileSync(join(taskDir, FIXES_FILE), '# Fixes\n\nT1: Lower-cased both sides.\n- `T3`: Changed nothing, the name is the team rule.  \nT1: a second line\nT2:\nsome prose\n');
    expect([...readFixNotes(taskDir)!]).toEqual([
      ['T1', 'Lower-cased both sides.'],
      ['T3', 'Changed nothing, the name is the team rule.'],
    ]);
  });
});

describe('discussMessage', () => {
  it('opens with the discussion and its triage, and asks for no change', () => {
    storeDiscussions(db, pull, 'pat', [thread('R1', [say('C1', 'dana', '2026-10-01T00:00:00Z', 'Lower case it.')])]);
    applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'clarify', summary: 'Which side?', reason: 'Unclear.', reply: null }]);
    const text = discussMessage(cardDiscussions(db, 'APP-1')[0]!, { repo: 'cook/recipes', number: 12 });

    expect(text).toMatch(/^I want to talk about this comment on the pull request\. Read the code it is about\. Change nothing\./);
    expect(text).toContain('T1: A review thread on cook/recipes#12, on src/search.ts:12.');
    expect(text).toContain('Triage verdict: clarify\nTriage summary: Which side?\nTriage reason: Unclear.');
    expect(text).toContain('dana, 2026-10-01T00:00:00Z:\n> Lower case it.');
  });
});
