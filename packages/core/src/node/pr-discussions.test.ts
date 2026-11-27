import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCard } from './cards.ts';
import { openDatabase } from './db.ts';
import { applyTriage, beginFix, beginFixAll, cardDiscussions, cardPullRows, detachCardPull, type DiscussionInput, endFix, feedbackCounts, fixedSinceQa, lastJudgedQa, markDiscussion, markDiscussionsSeen, mergeBlockersByCard, reopenFixed, saveCardPull, setDiscussionStatus, storeDiscussions } from './pr-discussions.ts';

let dir = '';
let db: DatabaseSync;
let pull = 0;

const say = (githubId: string, author: string | null, createdAt: string) => ({ githubId, author, body: `said ${githubId}`, createdAt });
const thread = (githubId: string, messages: DiscussionInput['messages'], resolved = false): DiscussionInput => ({ kind: 'thread', githubId, path: 'src/a.ts', line: 4, resolved, outdated: false, messages });
const comment = (githubId: string, author: string, createdAt: string): DiscussionInput => ({ kind: 'comment', githubId, path: null, line: null, resolved: false, outdated: false, messages: [say(githubId, author, createdAt)] });
const rows = () => cardDiscussions(db, 'APP-1').map((one) => [one.ref, one.githubId, one.status]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-pr-discussions-'));
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'pr-watch', title: 'Add a search box' });
  pull = saveCardPull(db, 'APP-1', { repo: 'Cook/Recipes', number: 12, url: 'https://github.com/cook/recipes/pull/12', foundBy: 'branch' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('keeps one row per card and pull request, and an attached one stays attached', () => {
  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'attached' });
  expect(cardPullRows(db, 'APP-1')).toEqual([{ id: pull, card: 'APP-1', repo: 'cook/recipes', number: 12, url: 'https://github.com/cook/recipes/pull/12', title: null, state: null, foundBy: 'branch', readAt: null, merge: null, mergeAt: null }]);
  const attached = saveCardPull(db, 'APP-1', { repo: 'cook/api', number: 3, url: null, foundBy: 'attached' });
  expect(saveCardPull(db, 'APP-1', { repo: 'cook/api', number: 3, url: null, foundBy: 'branch' })).toBe(attached);
  expect(cardPullRows(db, 'APP-1').map((one) => one.foundBy)).toEqual(['branch', 'attached']);
});

// Why it cannot merge, as the last read that asked saw it. A read that did not ask, or failed, keeps it.
it('keeps the newest merge read with its time, and a save without one keeps it', () => {
  const draft = { blockers: [{ kind: 'draft' as const }], running: false };
  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch', state: 'open', merge: draft });
  const [first] = cardPullRows(db, 'APP-1');
  expect(first?.merge).toEqual(draft);
  expect(Date.parse(first?.mergeAt ?? '')).not.toBeNaN();

  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch', state: 'open' });
  expect(cardPullRows(db, 'APP-1')[0]).toMatchObject({ merge: draft, mergeAt: first?.mergeAt });

  const clear = { blockers: [], running: false };
  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch', merge: clear });
  expect(cardPullRows(db, 'APP-1')[0]?.merge).toEqual(clear);
});

// The board chip reads every open pull request of a card in one list, in the chip's order.
it('lists the reasons of each card across its open pull requests, in the chip order', () => {
  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch', state: 'open', merge: { blockers: [{ kind: 'draft' }], running: false } });
  saveCardPull(db, 'APP-1', { repo: 'cook/api', number: 3, url: null, foundBy: 'branch', state: 'open', merge: { blockers: [{ kind: 'behind', base: 'main' }], running: false } });
  saveCardPull(db, 'APP-1', { repo: 'cook/web', number: 4, url: null, foundBy: 'branch', state: 'merged', merge: { blockers: [{ kind: 'conflict', base: 'main' }], running: false } });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'review', title: 'Nothing blocks' });
  saveCardPull(db, 'APP-2', { repo: 'cook/recipes', number: 13, url: null, foundBy: 'branch', state: 'open', merge: { blockers: [], running: true } });

  expect([...mergeBlockersByCard(db)]).toEqual([['APP-1', [{ kind: 'behind', base: 'main' }, { kind: 'draft' }]]]);
});

it('keeps the title and state of the newest read that named them', () => {
  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch', title: 'Add a search box', state: 'open' });
  saveCardPull(db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch', state: 'merged' });
  expect(cardPullRows(db, 'APP-1').map((one) => [one.title, one.state])).toEqual([['Add a search box', 'merged']]);
});

it('detaches an attached pull request with its discussions and messages, and never one the branch found', () => {
  const attached = saveCardPull(db, 'APP-1', { repo: 'cook/api', number: 3, url: null, foundBy: 'attached' });
  storeDiscussions(db, attached, 'pat', [comment('I9', 'dana', '2026-10-01T00:00:00Z')]);
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);

  expect(detachCardPull(db, 'APP-1', 'Cook/Recipes', 12)).toBe('branch');
  expect(detachCardPull(db, 'APP-1', 'Cook/API', 3)).toBe('detached');
  expect(detachCardPull(db, 'APP-1', 'cook/api', 3)).toBe('missing');
  expect(cardPullRows(db, 'APP-1').map((one) => one.repo)).toEqual(['cook/recipes']);
  expect(rows()).toEqual([['T2', 'I1', 'new']]);
  expect(db.prepare('SELECT count(*) AS n FROM pr_messages').get()).toEqual({ n: 1 });
});

it('never hands out a ref again once its pull request is detached, and keeps one a fix runs on', () => {
  const attached = saveCardPull(db, 'APP-1', { repo: 'cook/api', number: 3, url: null, foundBy: 'attached' });
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);
  storeDiscussions(db, attached, 'pat', [comment('I9', 'dana', '2026-10-01T00:00:00Z')]);
  const fixing = cardDiscussions(db, 'APP-1')[1]?.id ?? 0;
  setDiscussionStatus(db, fixing, 'fixing');
  expect(detachCardPull(db, 'APP-1', 'cook/api', 3)).toBe('fixing');
  setDiscussionStatus(db, fixing, 'fixed');

  expect(detachCardPull(db, 'APP-1', 'cook/api', 3)).toBe('detached');
  storeDiscussions(db, pull, 'pat', [comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
  expect(rows()).toEqual([
    ['T1', 'I1', 'new'],
    ['T3', 'I2', 'new'],
  ]);

  // A second detach raises the kept ref again.
  const other = saveCardPull(db, 'APP-1', { repo: 'cook/web', number: 5, url: null, foundBy: 'attached' });
  storeDiscussions(db, other, 'pat', [comment('W1', 'dana', '2026-10-03T00:00:00Z')]);
  expect(detachCardPull(db, 'APP-1', 'cook/web', 5)).toBe('detached');
  storeDiscussions(db, pull, 'pat', [comment('I3', 'dana', '2026-10-04T00:00:00Z')]);
  expect(rows().at(-1)).toEqual(['T5', 'I3', 'new']);
});

it('numbers new discussions oldest first, keeps the refs on a second read, and adds nothing twice', () => {
  const read = [comment('I1', 'dana', '2026-10-03T00:00:00Z'), thread('T-b', [say('c2', 'dana', '2026-10-02T00:00:00Z')]), thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z'), say('c3', 'pat', '2026-10-01T05:00:00Z')])];

  expect(storeDiscussions(db, pull, 'pat', read)).toEqual({ added: 3, messages: 4, reopened: 0, done: 0 });
  expect(rows()).toEqual([
    ['T1', 'T-a', 'new'],
    ['T2', 'T-b', 'new'],
    ['T3', 'I1', 'new'],
  ]);
  expect(storeDiscussions(db, pull, 'pat', read)).toEqual({ added: 0, messages: 0, reopened: 0, done: 0 });
  expect(rows().map((one) => one[0])).toEqual(['T1', 'T2', 'T3']);

  // A later discussion takes the next ref, whatever its time.
  storeDiscussions(db, pull, 'pat', [comment('I0', 'dana', '2026-09-01T00:00:00Z')]);
  expect(rows().at(-1)).toEqual(['T4', 'I0', 'new']);
});

it("marks the viewer's own message as mine and never unread", () => {
  storeDiscussions(db, pull, 'Pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z'), say('c2', 'pat', '2026-10-01T01:00:00Z'), say('c3', null, '2026-10-01T02:00:00Z')])]);
  expect(cardDiscussions(db, 'APP-1')[0]?.messages.map((one) => [one.githubId, one.mine, one.unread])).toEqual([
    ['c1', false, true],
    ['c2', true, false],
    ['c3', false, true],
  ]);
});

it('sets a thread resolved on GitHub done, but never one a fix runs on, and leaves a reopened one to the person', () => {
  storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z')], true), thread('T-b', [say('c2', 'dana', '2026-10-02T00:00:00Z')]), thread('T-c', [say('c3', 'dana', '2026-10-03T00:00:00Z')])]);
  expect(rows().map((one) => one[2])).toEqual(['done', 'new', 'new']);
  const [first, , third] = cardDiscussions(db, 'APP-1');
  setDiscussionStatus(db, first?.id ?? 0, 'new');
  setDiscussionStatus(db, third?.id ?? 0, 'fixing');

  const done = storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z')], true), thread('T-b', [say('c2', 'dana', '2026-10-02T00:00:00Z')], true), thread('T-c', [say('c3', 'dana', '2026-10-03T00:00:00Z')], true)]);

  expect(done.done).toBe(1);
  expect(rows().map((one) => one[2])).toEqual(['new', 'done', 'fixing']);

  // Once the fix is over, the first read sets the thread GitHub resolved meanwhile done.
  setDiscussionStatus(db, third?.id ?? 0, 'fixed');
  storeDiscussions(db, pull, 'pat', [thread('T-c', [say('c3', 'dana', '2026-10-03T00:00:00Z')], true)]);
  expect(rows().map((one) => one[2])).toEqual(['new', 'done', 'done']);
});

it('keeps the messages of one pull request on every card that holds it', () => {
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Sort recipes' });
  const other = saveCardPull(db, 'APP-2', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'attached' });
  const read = [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z')])];
  storeDiscussions(db, pull, 'pat', read);
  expect(storeDiscussions(db, other, 'pat', read)).toEqual({ added: 1, messages: 1, reopened: 0, done: 0 });
  expect(cardDiscussions(db, 'APP-2')[0]?.messages.map((one) => one.githubId)).toEqual(['c1']);
});

it('reopens a fixed discussion on a reviewer message after the fix, and not on an older one or the viewer\'s own', () => {
  storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z')])]);
  const id = cardDiscussions(db, 'APP-1')[0]?.id ?? 0;
  setDiscussionStatus(db, id, 'fixed');
  expect(cardDiscussions(db, 'APP-1')[0]?.fixedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

  storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z'), say('c2', 'dana', '2026-10-01T03:00:00Z'), say('c3', 'pat', '2099-01-01T00:00:00Z')])]);
  expect(rows()).toEqual([['T1', 'T-a', 'fixed']]);

  const done = storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c4', 'dana', '2099-01-02T00:00:00Z')])]);
  expect(done.reopened).toBe(1);
  expect(rows()).toEqual([['T1', 'T-a', 'new']]);
});

it("keeps a person's done and a discussion that is gone on GitHub as they were", () => {
  storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z')]), comment('I1', 'dana', '2026-10-02T00:00:00Z')]);
  setDiscussionStatus(db, cardDiscussions(db, 'APP-1')[0]?.id ?? 0, 'done');

  storeDiscussions(db, pull, 'pat', [thread('T-a', [say('c1', 'dana', '2026-10-01T00:00:00Z'), say('c2', 'dana', '2099-01-01T00:00:00Z')])]);

  expect(rows()).toEqual([
    ['T1', 'T-a', 'done'],
    ['T2', 'I1', 'new'],
  ]);
  expect(cardDiscussions(db, 'APP-1')[1]?.messages).toHaveLength(1);
});

it('stamps the read time of the pull request and keeps each message link', () => {
  storeDiscussions(db, pull, 'pat', [{ ...comment('I1', 'dana', '2026-10-01T00:00:00Z'), messages: [{ ...say('I1', 'dana', '2026-10-01T00:00:00Z'), url: 'https://github.com/cook/recipes/pull/12#issuecomment-1' }] }]);

  expect(Date.parse(cardPullRows(db, 'APP-1')[0]?.readAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
  expect(cardDiscussions(db, 'APP-1')[0]?.messages[0]?.url).toBe('https://github.com/cook/recipes/pull/12#issuecomment-1');
});

// Opening the PRs tab marks the card's messages seen, and only that card's.
it('marks every message of the card seen', () => {
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'pr-watch', title: 'Other' });
  const other = saveCardPull(db, 'APP-2', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'sam', '2026-10-02T00:00:00Z')]);
  storeDiscussions(db, other, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);

  expect(markDiscussionsSeen(db, 'APP-1')).toBe(2);
  expect(markDiscussionsSeen(db, 'APP-1')).toBe(0);
  expect(cardDiscussions(db, 'APP-2')[0]?.messages[0]?.unread).toBe(true);
});

it('marks a discussion done and reopens it as needing action, and a later read keeps both', () => {
  storeDiscussions(db, pull, 'pat', [thread('P1', [say('c1', 'dana', '2026-10-01T00:00:00Z')])]);
  const one = () => cardDiscussions(db, 'APP-1')[0]!;

  expect(markDiscussion(db, 'APP-1', 'T1', 'done')).toBe('marked');
  storeDiscussions(db, pull, 'pat', [thread('P1', [say('c1', 'dana', '2026-10-01T00:00:00Z')])]);
  expect([one().status, one().needsAction]).toEqual(['done', null]);

  expect(markDiscussion(db, 'APP-1', 'T1', 'reopen')).toBe('marked');
  storeDiscussions(db, pull, 'pat', [thread('P1', [say('c1', 'dana', '2026-10-01T00:00:00Z')])]);
  expect([one().status, one().needsAction]).toEqual(['new', true]);

  // Done takes the override back off, so the row goes to the footer.
  markDiscussion(db, 'APP-1', 'T1', 'done');
  expect([one().status, one().needsAction]).toEqual(['done', null]);
});

it('leaves a fixing discussion alone and says a ref it does not have', () => {
  storeDiscussions(db, pull, 'pat', [thread('P1', [say('c1', 'dana', '2026-10-01T00:00:00Z')])]);
  setDiscussionStatus(db, cardDiscussions(db, 'APP-1')[0]!.id, 'fixing');

  expect(markDiscussion(db, 'APP-1', 'T1', 'done')).toBe('fixing');
  expect(markDiscussion(db, 'APP-1', 'T9', 'done')).toBe('missing');
  expect(markDiscussion(db, 'APP-2', 'T1', 'done')).toBe('missing');
  expect(cardDiscussions(db, 'APP-1')[0]?.status).toBe('fixing');
});

it('applies a triage to open rows only and never changes a status', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z'), comment('I3', 'dana', '2026-10-03T00:00:00Z')]);
  const [, two] = cardDiscussions(db, 'APP-1');
  setDiscussionStatus(db, two?.id ?? 0, 'fixing');
  markDiscussion(db, 'APP-1', 'T3', 'done');
  const block = (ref: string) => ({ ref, verdict: 'fix' as const, summary: `about ${ref}`, reason: 'right', reply: null });

  expect(applyTriage(db, 'APP-1', [block('T1'), block('T2'), block('T3'), block('T9')])).toEqual({ applied: 2, ignored: 2 });
  expect(cardDiscussions(db, 'APP-1').map((one) => [one.ref, one.status, one.verdict, one.summary, one.reply])).toEqual([
    ['T1', 'new', 'fix', 'about T1', null],
    ['T2', 'fixing', 'fix', 'about T2', null],
    ['T3', 'done', null, null, null],
  ]);
  // A second triage writes over the first.
  applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'none', summary: 'settled', reason: 'answered', reply: 'Thanks.' }]);
  expect(cardDiscussions(db, 'APP-1')[0]).toMatchObject({ verdict: 'none', summary: 'settled', reason: 'answered', reply: 'Thanks.' });
});

it('runs one fix at a time per card, and refuses a done row and a ref the card does not have', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z'), comment('I3', 'dana', '2026-10-03T00:00:00Z')]);
  markDiscussion(db, 'APP-1', 'T3', 'done');

  const first = beginFix(db, 'APP-1', 'T1');
  expect(first).toMatchObject({ ok: true, row: { ref: 'T1', status: 'fixing' } });
  expect(beginFix(db, 'APP-1', 'T2')).toEqual({ ok: false, reason: 'T1 is being fixed now. One fix runs at a time, so wait for it to end.' });
  expect(beginFix(db, 'APP-1', 'T1')).toEqual({ ok: false, reason: 'T1 is being fixed now. Wait for that fix to end.' });
  expect(beginFix(db, 'APP-1', 'T9')).toEqual({ ok: false, reason: 'APP-1 has no discussion T9. Read comments on its PRs tab first.' });
  expect(rows()).toEqual([
    ['T1', 'I1', 'fixing'],
    ['T2', 'I2', 'new'],
    ['T3', 'I3', 'done'],
  ]);

  endFix(db, cardDiscussions(db, 'APP-1')[0]!.id, { ok: true, note: 'The search ignores case now.' });
  expect(beginFix(db, 'APP-1', 'T3')).toEqual({ ok: false, reason: 'T3 is done. Reopen it first if it still needs a fix.' });
  expect(beginFix(db, 'APP-1', 'T2').ok).toBe(true);
});

it('ends a fix as fixed with its note, or as new with the reason, and a new fix clears the reason', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);
  const one = () => cardDiscussions(db, 'APP-1')[0]!;

  beginFix(db, 'APP-1', 'T1');
  endFix(db, one().id, { ok: false, reason: 'The fix was stopped.' });
  expect([one().status, one().fixFailed, one().fixNote, one().fixedAt]).toEqual(['new', 'The fix was stopped.', null, null]);

  beginFix(db, 'APP-1', 'T1');
  expect([one().status, one().fixFailed]).toEqual(['fixing', null]);
  endFix(db, one().id, { ok: true, note: 'The search ignores case now.' });
  expect([one().status, one().fixNote, one().fixFailed]).toEqual(['fixed', 'The search ignores case now.', null]);
  expect(one().fixedAt).not.toBeNull();

  // Fix again on a fixed row, and an end that finds the row no longer fixing changes nothing.
  expect(beginFix(db, 'APP-1', 'T1').ok).toBe(true);
  setDiscussionStatus(db, one().id, 'new');
  endFix(db, one().id, { ok: true, note: 'late' });
  expect([one().status, one().fixNote]).toEqual(['new', 'The search ignores case now.']);
});

it('reads the question of a fixing row only once its card waits blocked on it', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
  // An earlier fix of T2 asked too, and its row went back to new.
  db.prepare("INSERT INTO runs (card_key, phase, engine, state, thread, question) VALUES ('APP-1', 'implement', 'claude-code', 'blocked', 'T2', 'Rename it?')").run();
  beginFix(db, 'APP-1', 'T1');
  db.prepare("INSERT INTO runs (card_key, phase, engine, state, thread, question) VALUES ('APP-1', 'implement', 'claude-code', 'blocked', 'T1', 'Which side?')").run();
  const asks = () => cardDiscussions(db, 'APP-1').map((one) => one.fixAsks);
  // The run has ended, but the commit and push check has not landed the card yet.
  db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
  expect(asks()).toEqual([null, null]);
  db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
  expect(asks()).toEqual(['Which side?', null]);
});

it('keeps why the last fix did not hold on the row a new fix hands its run', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z')]);
  beginFix(db, 'APP-1', 'T1');
  endFix(db, cardDiscussions(db, 'APP-1')[0]!.id, { ok: false, reason: 'QA says: the list is empty.' });

  expect(beginFix(db, 'APP-1', 'T1')).toMatchObject({ ok: true, row: { status: 'fixing', fixFailed: 'QA says: the list is empty.' } });
  // The stored row clears it, as before.
  expect(cardDiscussions(db, 'APP-1')[0]!.fixFailed).toBeNull();
});

it('starts Fix all on every new row triage wants fixed, and refuses while a fix runs or when none is left', () => {
  storeDiscussions(db, pull, 'pat', [1, 2, 3, 4, 5].map((n) => comment(`I${n}`, 'dana', `2026-10-0${n}T00:00:00Z`)));
  const fix = (ref: string) => ({ ref, verdict: 'fix' as const, summary: 's', reason: 'r', reply: null });
  applyTriage(db, 'APP-1', [fix('T1'), fix('T2'), fix('T3'), { ...fix('T4'), verdict: 'reject' }, fix('T5')]);
  // T2 is fixed already and T5 is done: neither is in the run.
  const id = (ref: string) => cardDiscussions(db, 'APP-1').find((one) => one.ref === ref)!.id;
  beginFix(db, 'APP-1', 'T2');
  endFix(db, id('T2'), { ok: true, note: 'done' });
  markDiscussion(db, 'APP-1', 'T5', 'done');

  expect(beginFix(db, 'APP-1', 'T4').ok).toBe(true);
  expect(beginFixAll(db, 'APP-1')).toEqual({ ok: false, reason: 'T4 is being fixed now. One fix runs at a time, so wait for it to end.' });
  endFix(db, id('T4'), { ok: false, reason: 'stopped' });

  const begun = beginFixAll(db, 'APP-1');
  expect(begun.ok && begun.rows.map((one) => [one.ref, one.status])).toEqual([
    ['T1', 'fixing'],
    ['T3', 'fixing'],
  ]);
  expect(rows().map(([ref, , status]) => `${ref} ${status}`)).toEqual(['T1 fixing', 'T2 fixed', 'T3 fixing', 'T4 new', 'T5 done']);

  for (const ref of ['T1', 'T3']) endFix(db, id(ref), { ok: true, note: 'done' });
  expect(beginFixAll(db, 'APP-1')).toEqual({ ok: false, reason: 'APP-1 has no comment left that triage wants fixed. Run triage first, or use Fix on a row.' });
});

it('counts a row as due for QA when it was fixed after the newest QA with PASS or FAIL, and sends failed rows back', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z')]);
  const id = (ref: string) => cardDiscussions(db, 'APP-1').find((one) => one.ref === ref)!.id;
  const fixedAt = (ref: string, at: string) => db.prepare('UPDATE pr_discussions SET status = ?, fixed_at = ? WHERE id = ?').run('fixed', at, id(ref));
  const qa = (startedAt: string, verdict: string | null) =>
    db.prepare("INSERT INTO runs (card_key, phase, engine, state, started_at, verdict) VALUES ('APP-1', 'qa', 'claude-code', 'complete', ?, ?)").run(startedAt, verdict);
  const due = () => fixedSinceQa(db, 'APP-1').map((one) => one.ref);

  // No QA yet: every fixed row is due.
  fixedAt('T1', '2026-11-10T10:00:00.000Z');
  expect(lastJudgedQa(db, 'APP-1')).toBeNull();
  expect(due()).toEqual(['T1']);

  qa('2026-11-10T09:00:00.000Z', 'PASS');
  fixedAt('T2', '2026-11-10T11:00:00.000Z');
  qa('2026-11-10T10:30:00.000Z', 'PASS');
  expect(due()).toEqual(['T2']);
  // A BLOCKED QA and one with no verdict checked nothing.
  qa('2026-11-10T12:00:00.000Z', 'BLOCKED');
  qa('2026-11-10T12:30:00.000Z', null);
  expect(lastJudgedQa(db, 'APP-1')).toBe('2026-11-10T10:30:00.000Z');
  expect(due()).toEqual(['T2']);
  qa('2026-11-10T13:00:00.000Z', 'FAIL');
  expect(due()).toEqual([]);

  // Only a row still fixed goes back, with QA's reason.
  setDiscussionStatus(db, id('T1'), 'done');
  reopenFixed(db, 'APP-1', [
    { ref: 'T1', reason: 'QA says: one' },
    { ref: 'T2', reason: 'QA says: two' },
  ]);
  expect(cardDiscussions(db, 'APP-1').map((one) => [one.ref, one.status, one.fixFailed])).toEqual([
    ['T1', 'done', null],
    ['T2', 'new', 'QA says: two'],
  ]);
});

it('counts the rows to fix and the unread rows per card for the board, and leaves a card at none out', () => {
  storeDiscussions(db, pull, 'pat', [comment('I1', 'dana', '2026-10-01T00:00:00Z'), comment('I2', 'dana', '2026-10-02T00:00:00Z'), comment('I3', 'pat', '2026-10-03T00:00:00Z'), comment('I4', 'dana', '2026-10-04T00:00:00Z')]);
  expect(feedbackCounts(db).get('APP-1')).toEqual({ toFix: 0, unread: 3 });

  // A row triage rejected is open, but there is nothing in it to fix.
  const fix = (ref: string) => ({ ref, verdict: 'fix' as const, summary: 's', reason: 'r', reply: null });
  applyTriage(db, 'APP-1', [fix('T1'), fix('T2'), fix('T3'), { ...fix('T4'), verdict: 'reject' }]);
  markDiscussionsSeen(db, 'APP-1');
  expect(feedbackCounts(db).get('APP-1')).toEqual({ toFix: 3, unread: 0 });

  // A fix that runs is not fixed yet. One that ended well, and a row marked done, no longer count.
  beginFix(db, 'APP-1', 'T1');
  expect(feedbackCounts(db).get('APP-1')?.toFix).toBe(3);
  endFix(db, cardDiscussions(db, 'APP-1')[0]!.id, { ok: true, note: 'done' });
  markDiscussion(db, 'APP-1', 'T3', 'done');
  expect(feedbackCounts(db).get('APP-1')).toEqual({ toFix: 1, unread: 0 });

  markDiscussion(db, 'APP-1', 'T2', 'done');
  expect(feedbackCounts(db).has('APP-1')).toBe(false);
});

it("keeps an edited message current: a reviewer edit is unread, an unchanged one and the person's own edit are not", () => {
  const read = (dana: string, pat: string) =>
    storeDiscussions(db, pull, 'pat', [
      thread('R1', [
        { ...say('C1', 'dana', '2026-10-01T00:00:00Z'), body: dana },
        { ...say('C2', 'Pat', '2026-10-01T01:00:00Z'), body: pat },
      ]),
    ]);
  const messages = () => cardDiscussions(db, 'APP-1')[0]?.messages.map((one) => [one.githubId, one.body, one.unread]);
  read('Rename this.', 'Will do.');
  const row = cardDiscussions(db, 'APP-1')[0]?.id ?? 0;
  setDiscussionStatus(db, row, 'fixed');
  applyTriage(db, 'APP-1', [{ ref: 'T1', verdict: 'fix', summary: 'Rename', reason: 'Clearer', reply: null }]);
  markDiscussionsSeen(db, 'APP-1');

  // The same text again touches nothing.
  expect(read('Rename this.', 'Will do.')).toEqual({ added: 0, messages: 0, reopened: 0, done: 0 });
  expect(messages()).toEqual([
    ['C1', 'Rename this.', false],
    ['C2', 'Will do.', false],
  ]);

  read('Rename this to findRecipe.', 'Will do, renamed.');
  expect(messages()).toEqual([
    ['C1', 'Rename this to findRecipe.', true],
    ['C2', 'Will do, renamed.', false],
  ]);
  const after = cardDiscussions(db, 'APP-1')[0];
  expect([after?.ref, after?.status, after?.verdict]).toEqual(['T1', 'fixed', 'fix']);

  markDiscussion(db, 'APP-1', 'T1', 'done');
  read('Rename this to findRecipes.', 'Will do, renamed.');
  expect(rows()).toEqual([['T1', 'R1', 'done']]);
});
