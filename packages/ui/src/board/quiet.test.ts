import type { RunActivity } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { cardPill, liveOf } from './quiet.ts';
import { cardFixture } from './fixture.ts';

const QUIET_AFTER = 5 * 60_000;
const OUTPUT_AT = Date.parse('2026-10-12T10:00:00.000Z');
const card = { state: 'running' as const, runId: 7, runState: 'running' as const };
const activity: RunActivity = { runId: 7, cardKey: 'APP-1', line: 'Reading services/api/src/recipes/list.ts', outputAt: OUTPUT_AT };
const after = (ms: number) => new Date(OUTPUT_AT + ms);

it('shows the line and no Quiet one millisecond under the set time', () => {
  expect(liveOf(card, activity, after(QUIET_AFTER - 1), QUIET_AFTER)).toEqual({ line: 'Reading services/api/src/recipes/list.ts', quiet: null, since: '4m ago' });
});

// "2s ago": seconds, then minutes, and gone once the pill says Quiet.
it('says how long ago the run last printed while it is live', () => {
  expect(liveOf(card, activity, after(2_000), QUIET_AFTER)?.since).toBe('2s ago');
  expect(liveOf(card, activity, after(59_999), QUIET_AFTER)?.since).toBe('59s ago');
  expect(liveOf(card, activity, after(60_000), QUIET_AFTER)?.since).toBe('1m ago');
  expect(liveOf(card, activity, after(-500), QUIET_AFTER)?.since).toBe('0s ago');
  expect(liveOf(card, activity, after(QUIET_AFTER), QUIET_AFTER)?.since).toBeNull();
  expect(liveOf(card, activity, undefined, QUIET_AFTER)?.since).toBeNull();
});

it('turns Quiet at the set time', () => {
  expect(liveOf(card, activity, after(QUIET_AFTER), QUIET_AFTER)?.quiet).toBe('5m');
});

// The browser counts on with its own clock, so the minutes rise with no new event.
it('keeps counting the minutes over the set time', () => {
  expect(liveOf(card, activity, after(6 * 60_000 + 59_000), QUIET_AFTER)?.quiet).toBe('6m');
});

it('follows the setting, not a fixed five minutes', () => {
  expect(liveOf(card, activity, after(2 * 60_000), 60_000)?.quiet).toBe('2m');
  expect(liveOf(card, activity, after(10 * 60_000), 15 * 60_000)?.quiet).toBeNull();
});

// A line from the card's last run would be a stale claim about this one.
it('shows nothing of another run, or of a card that is not running', () => {
  expect(liveOf({ ...card, runId: 8 }, activity, after(0), QUIET_AFTER)).toBeNull();
  expect(liveOf({ ...card, state: 'ready' }, activity, after(0), QUIET_AFTER)).toBeNull();
  expect(liveOf(card, undefined, after(0), QUIET_AFTER)).toBeNull();
});

// A retry wait has a known end. It is a pause, not a run that went silent.
it('never calls a run quiet while it waits to retry', () => {
  expect(liveOf({ ...card, runState: 'retrying' }, activity, after(QUIET_AFTER * 3), QUIET_AFTER)?.quiet).toBeNull();
});

// A board with no setting, or a card drawn with no clock, counts nothing.
it('claims no Quiet without a setting or a clock', () => {
  expect(liveOf(card, activity, after(QUIET_AFTER * 3), undefined)?.quiet).toBeNull();
  expect(liveOf(card, activity, undefined, QUIET_AFTER)?.quiet).toBeNull();
});

// The pill words of a card, the same on the board card and on the card page head.
describe('cardPill', () => {
  const clock = new Date('2026-10-12T10:00:40.000Z');
  const live = (quiet: string | null) => ({ line: null, quiet, since: null });

  it('reads Quiet with the minutes once the run went silent, and the run time while it is live', () => {
    const running = cardFixture({ key: 'APP-1', state: 'running', runId: 7, runState: 'running', runStartedAt: '2026-10-12T10:00:00.000Z' });

    expect(cardPill(running, live('6m'), clock)).toEqual({ state: 'quiet', word: null, detail: '6m' });
    expect(cardPill(running, live(null), clock)).toEqual({ state: 'running', word: null, detail: '0m 40s' });
    expect(cardPill(running, null, undefined)).toEqual({ state: 'running', word: null, detail: null });
  });

  it('says Asks you and Ready for you, and reads a QA FAIL as QA failed', () => {
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'blocked', question: 'Stars or thumbs?' }), null, clock)).toEqual({ state: 'blocked', word: 'Asks you', detail: null });
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'ready' }), null, clock)).toEqual({ state: 'ready', word: 'Ready for you', detail: null });
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'ready', verdict: 'FAIL', verdictReason: 'The list is empty.' }), null, clock)).toEqual({ state: 'failed', word: 'QA failed', detail: null });
  });

  // A card ready after an agent's phase names the phase, and
  // Implement reads done. A person's column has no phase, so it keeps Ready for you.
  it('names the phase a ready card finished, when the page knows its stage', () => {
    const ready = cardFixture({ key: 'APP-1', state: 'ready' });

    expect(cardPill(ready, null, clock, { id: 'plan', label: 'Plan', role: 'agent' })).toEqual({ state: 'ready', word: 'Plan ready', detail: null });
    expect(cardPill(ready, null, clock, { id: 'implement', label: 'Implement', role: 'agent' })).toEqual({ state: 'ready', word: 'Implement done', detail: null });
    expect(cardPill(ready, null, clock, { id: 'review', label: 'Review', role: 'you' })).toEqual({ state: 'ready', word: 'Ready for you', detail: null });
  });

  // A closed card reads Closed with a check, not Idle.
  it('reads an idle card in the archive column as Closed with a check', () => {
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'idle' }), null, clock, { id: 'closed', label: 'Closed', role: 'archive' })).toEqual({ state: 'idle', word: 'Closed', detail: null, check: true });
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'idle' }), null, clock, { id: 'inbox', label: 'Inbox', role: 'you' })).toEqual({ state: 'idle', word: null, detail: null });
  });

  // Learn and then start holds it: it starts by itself once Learn ends, counted from the press.
  it('says a card Learn and then start holds starts its column after Learn', () => {
    const afterLearn = { column: 'Refine', repo: 'api', since: '2026-10-12T11:58:55.000Z' };
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'idle', afterLearn }), null, new Date('2026-10-12T12:00:00.000Z'))).toEqual({ state: 'queued', word: 'Starts Refine after Learn', detail: '1m 05s' });
  });

  // Held until a knowledge change is applied or returned: the person's turn, not the queue's.
  it('says a card waiting for a knowledge review waits for the person', () => {
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'queued', queuePosition: null, runState: 'waiting_review' }), null, clock)).toEqual({ state: 'ready', word: 'Waits for your review', detail: null });
  });

  it('gives a queued card its place, and an idle or failed card its plain word', () => {
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'queued', queuePosition: 1 }), null, clock)).toEqual({ state: 'queued', word: null, detail: '1st' });
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'idle' }), null, clock)).toEqual({ state: 'idle', word: null, detail: null });
    expect(cardPill(cardFixture({ key: 'APP-1', state: 'failed' }), null, clock)).toEqual({ state: 'failed', word: null, detail: null });
  });
});

// The epic stays idle in In delivery, and the pill says why it waits on the person.
it('says Tasks done on an epic whose every task is done', () => {
  expect(cardPill(cardFixture({ key: 'APP-1', state: 'idle', finished: true }), null, undefined)).toEqual({ state: 'ready', word: 'Tasks done', detail: null });
});

// A card waiting on its author says the author pushed since its last round, in
// the blue of something new to look at. Not amber: nothing starts until a person drags or presses.
describe('a push since the last review round', () => {
  const pull = { author: 'ben', decision: 'CHANGES_REQUESTED' as const, headCommittedAt: null, draft: false, round: 2 };

  it('says 1 new commit, or how many, on an idle card', () => {
    expect(cardPill(cardFixture({ key: 'api#57', state: 'idle', pull: { ...pull, newCommits: 1 } }), null, undefined)).toEqual({ state: 'new', word: '1 new commit', detail: null });
    expect(cardPill(cardFixture({ key: 'api#57', state: 'idle', pull: { ...pull, newCommits: 3 } }), null, undefined)).toEqual({ state: 'new', word: '3 new commits', detail: null });
  });

  // A run, a question or a failure is what the person reads first. A closed pull request needs no
  // review, and its card says Closed beside the author already.
  it('keeps the state of a card that is not idle, and says nothing once the pull request ended', () => {
    expect(cardPill(cardFixture({ key: 'api#57', state: 'queued', queuePosition: 1, pull: { ...pull, newCommits: 1 } }), null, undefined)).toEqual({ state: 'queued', word: null, detail: '1st' });
    expect(cardPill(cardFixture({ key: 'api#57', state: 'ready', pull: { ...pull, newCommits: 1 } }), null, undefined)).toEqual({ state: 'ready', word: 'Ready for you', detail: null });
    expect(cardPill(cardFixture({ key: 'api#57', state: 'idle', pull: { ...pull, newCommits: 1, ended: 'merged' } }), null, undefined)).toEqual({ state: 'idle', word: null, detail: null });
    expect(cardPill(cardFixture({ key: 'api#57', state: 'idle', pull }), null, undefined)).toEqual({ state: 'idle', word: null, detail: null });
  });
});
