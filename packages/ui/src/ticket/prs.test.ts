import { describe, expect, it } from 'vitest';
import { discussionLink, feedbackLine, firstLine, fixAllView, fixView, type PrDiscussion, qaFixesView, readWords, reviewerOf, splitRows, triageView, unread } from './prs.ts';

const message = (extra: Partial<PrDiscussion['messages'][number]> = {}): PrDiscussion['messages'][number] => ({
  id: 1,
  author: 'dana',
  body: 'Rename this.',
  createdAt: '2026-10-01T00:00:00Z',
  url: null,
  mine: false,
  unread: false,
  ...extra,
});

const row = (extra: Partial<PrDiscussion> = {}): PrDiscussion => ({
  ref: 'T1',
  pull: 1,
  kind: 'thread',
  path: 'src/list.ts',
  line: 4,
  resolved: false,
  outdated: false,
  status: 'new',
  verdict: null,
  summary: null,
  reason: null,
  reply: null,
  needsAction: null,
  messages: [message()],
  ...extra,
});

it.each([
  ['Rename this.', 'Rename this.'],
  // A quoted reply, a hidden note, a fence and a heading mark say nothing of their own.
  ['> earlier words\n\nThis breaks the list.', 'This breaks the list.'],
  ['<!-- bot: id 4 -->\n## **Summary**\nTwo findings.', 'Summary'],
  ['```suggestion\nconst a = 1;\n```', 'const a = 1;'],
  ['- [ ] add a test', '[ ] add a test'],
  // Inline marks come off too, or the row shows the asterisks.
  ['**Nit:** this filter runs on every key press.', 'Nit: this filter runs on every key press.'],
  ['Use *one* `Map` here, see [the docs](https://example.com) and ~~old~~ __new__ _notes_.', 'Use one Map here, see the docs and old new notes.'],
  ['keep snake_case_names and 2 * 3 * 4 as they are', 'keep snake_case_names and 2 * 3 * 4 as they are'],
  ['<details>\n<summary>Long</summary>\nMore', 'More'],
  ['', ''],
  ['   \n> only a quote', '> only a quote'],
])('takes the first meaningful line of %j', (body, line) => {
  expect(firstLine(body)).toBe(line);
});

it('names the reviewer by the first message, and a gone account in words', () => {
  expect(reviewerOf(row())).toBe('dana');
  expect(reviewerOf(row({ messages: [message({ author: null })] }))).toBe('Deleted account');
});

it('marks a row unread while any message is', () => {
  expect(unread(row())).toBe(false);
  expect(unread(row({ messages: [message(), message({ id: 2, unread: true })] }))).toBe(true);
});

// Verdict none or done goes to the footer, and the person's Needs action keeps it out.
it('puts done rows and rows with verdict none in the footer, unless the person pulled one back', () => {
  const rows = [
    row({ ref: 'T1' }),
    row({ ref: 'T2', status: 'done' }),
    row({ ref: 'T3', verdict: 'none' }),
    row({ ref: 'T4', verdict: 'none', needsAction: true }),
    row({ ref: 'T5', verdict: 'fix', status: 'fixed' }),
    // Pulled back, then resolved on GitHub: done wins.
    row({ ref: 'T6', status: 'done', needsAction: true }),
  ];

  const { action, quiet } = splitRows(rows);

  expect(action.map((one) => one.ref)).toEqual(['T1', 'T4', 'T5']);
  expect(quiet.map((one) => one.ref)).toEqual(['T2', 'T3', 'T6']);
});

it('links the first message on GitHub, else the pull request', () => {
  const pulls = [{ id: 1, repo: 'cook/recipes', number: 12, url: 'https://github.com/cook/recipes/pull/12' }];

  expect(discussionLink(row({ messages: [message({ url: 'https://github.com/cook/recipes/pull/12#discussion_r9' })] }), pulls)).toBe('https://github.com/cook/recipes/pull/12#discussion_r9');
  expect(discussionLink(row(), pulls)).toBe('https://github.com/cook/recipes/pull/12');
  expect(discussionLink(row({ pull: 2 }), [{ id: 2, repo: 'cook/api', number: 3, url: null }])).toBe('https://github.com/cook/api/pull/3');
});

it('says when the comments were read', () => {
  const now = new Date('2026-10-29T12:00:00Z');

  expect(readWords(null, now)).toBe('Never read');
  expect(readWords('2026-10-29T11:59:30Z', now)).toBe('Read just now');
  expect(readWords('2026-10-29T11:55:00Z', now)).toBe('Read 5 minutes ago');
});

describe('triageView', () => {
  const card = { key: 'APP-1', stage: 'pr', state: 'ready' as const };

  it('offers Run triage, and Triage again once a row has a verdict', () => {
    expect(triageView([row()], card, null, null)).toEqual({ label: 'Run triage', why: null });
    expect(triageView([row({ verdict: 'fix' }), row({ ref: 'T2' })], card, null, null).label).toBe('Triage again');
  });

  it('holds the button while a run holds the card, with nothing open, on a refusal, and after a press', () => {
    expect(triageView([row()], { ...card, state: 'running' }, null, null).why).toBe('A run holds APP-1 now. Triage once it ends.');
    expect(triageView([row()], { ...card, state: 'blocked' }, null, null).why).toBe('APP-1 waits for an answer. Answer it first.');
    expect(triageView([row({ status: 'done' })], card, null, null).why).toBe('Nothing is open to triage.');
    expect(triageView([row()], card, 'haiku is gone.', null).why).toBe('haiku is gone.');
    expect(triageView([row()], card, null, card).why).toBe('Sent. Waiting for the board to show the run.');
    // Once the board shows the card queued, the press has landed and the run holds it instead.
    expect(triageView([row()], { ...card, state: 'queued' }, null, card).why).toBe('A run holds APP-1 now. Triage once it ends.');
    expect(triageView([row()], null, null, null).why).toBe('The board has not answered yet.');
  });
});

describe('fixView', () => {
  const card = { key: 'APP-1', stage: 'pr-watch', state: 'idle' as const };

  it('offers Fix, and Fix again on a fixed row', () => {
    expect(fixView([row()], row(), card, null)).toEqual({ label: 'Fix', why: null });
    expect(fixView([row({ status: 'fixed' })], row({ status: 'fixed' }), card, null)).toEqual({ label: 'Fix again', why: null });
  });

  it('holds every row while one fix runs, and says which', () => {
    const rows = [row({ status: 'fixing' }), row({ ref: 'T2' })];
    // The board shows the card running while the fix goes; the fix is still the reason given.
    const running = { ...card, state: 'running' as const };
    expect(fixView(rows, rows[0]!, running, null).why).toBe('Fixing now. The row changes when the run ends.');
    expect(fixView(rows, rows[1]!, running, null).why).toBe('T1 is being fixed now. One fix runs at a time.');
    expect(fixView(rows, rows[1]!, null, null).why).toBe('T1 is being fixed now. One fix runs at a time.');
  });

  it('says where to answer a fix that asks', () => {
    const rows = [row({ status: 'fixing', fixAsks: 'Which side?' }), row({ ref: 'T2' })];
    const blocked = { ...card, state: 'blocked' as const };
    expect(fixView(rows, rows[0]!, blocked, null).why).toBe('Waiting for your answer.');
    expect(fixView(rows, rows[1]!, blocked, null).why).toBe('T1 is being fixed now. One fix runs at a time.');
  });

  it('holds the button while a run or a question holds the card, after a failure and after a press', () => {
    expect(fixView([row()], row(), { ...card, state: 'running' }, null).why).toBe('A run holds APP-1 now. Fix once it ends.');
    expect(fixView([row()], row(), { ...card, state: 'blocked' }, null).why).toBe('APP-1 waits for an answer. Answer it first.');
    expect(fixView([row()], row(), { ...card, state: 'failed' }, null).why).toBe('APP-1 failed. Retry it or move it first.');
    expect(fixView([row()], row(), card, card).why).toBe('Sent. Waiting for the board to show the run.');
    expect(fixView([row()], row(), null, null).why).toBe('The board has not answered yet.');
  });
});

describe('fixAllView', () => {
  const card = { key: 'APP-1', stage: 'pr-watch', state: 'idle' as const };

  it('counts the new rows triage wants fixed, and holds with nothing left or before a triage', () => {
    const rows = [row({ verdict: 'fix' }), row({ ref: 'T2', verdict: 'fix' }), row({ ref: 'T3', verdict: 'fix', status: 'fixed' }), row({ ref: 'T4', verdict: 'reject' })];
    expect(fixAllView(rows, card, null)).toEqual({ label: 'Fix all 2', why: null });
    expect(fixAllView(rows.slice(1), card, null)).toEqual({ label: 'Fix all', why: null });
    expect(fixAllView(rows.slice(2), card, null).why).toBe('No comment triage wants fixed is left to fix.');
    expect(fixAllView([row()], card, null).why).toBe('Run triage first, so Fix all knows which comments to fix.');
  });

  it('holds while a fix runs, a run or a question holds the card, and from the press', () => {
    const rows = [row({ verdict: 'fix' }), row({ ref: 'T2', verdict: 'fix', status: 'fixing' })];
    expect(fixAllView(rows, card, null).why).toBe('T2 is being fixed now. One fix runs at a time.');
    expect(fixAllView([row({ verdict: 'fix' })], { ...card, state: 'running' }, null).why).toBe('A run holds APP-1 now. Fix all once it ends.');
    expect(fixAllView([row({ verdict: 'fix' })], { ...card, state: 'blocked' }, null).why).toBe('APP-1 waits for an answer. Answer it first.');
    expect(fixAllView([row({ verdict: 'fix' })], card, card).why).toBe('Sent. Waiting for the board to show the run.');
  });
});

describe('qaFixesView', () => {
  const card = { key: 'APP-1', stage: 'pr-watch', state: 'idle' as const };

  it('is open once something was fixed since the last QA, and held otherwise', () => {
    const rows = [row({ status: 'fixed' })];
    expect(qaFixesView(['T1'], rows, card, null)).toEqual({ label: 'QA the fixes', why: null });
    expect(qaFixesView([], rows, card, null).why).toBe('Nothing was fixed since the last QA.');
    expect(qaFixesView(['T1'], [...rows, row({ ref: 'T2', status: 'fixing' })], card, null).why).toBe('T2 is being fixed now. Run QA once the fix ends.');
    expect(qaFixesView(['T1'], rows, { ...card, state: 'queued' }, null).why).toBe('A run holds APP-1 now. Run QA once it ends.');
    expect(qaFixesView(['T1'], rows, card, card).why).toBe('Sent. Waiting for the board to show the run.');
  });
});

describe('feedbackLine', () => {
  it('says both parts, leaves a part at nought out, and draws nothing at none', () => {
    expect(feedbackLine({ toFix: 3, unread: 1 })).toEqual({ text: '3 to fix · 1 new', label: 'Review comments: 3 to fix, 1 new' });
    expect(feedbackLine({ toFix: 0, unread: 2 })).toEqual({ text: '2 new', label: 'Review comments: 2 new' });
    expect(feedbackLine({ toFix: 1, unread: 0 })?.text).toBe('1 to fix');
    expect(feedbackLine({ toFix: 0, unread: 0 })).toBeNull();
    expect(feedbackLine(undefined)).toBeNull();
  });
});
