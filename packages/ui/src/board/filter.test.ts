import type { CardState } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { matchesFilter, waitingOnMe } from './filter.ts';

// Assumption G: a card waits on a person when it has a question, a result to read, or a failure.
it.each<[CardState, boolean]>([
  ['blocked', true],
  ['ready', true],
  ['failed', true],
  ['idle', false],
  ['queued', false],
  ['running', false],
])('a %s card waiting on me is %s', (state, expected) => {
  expect(waitingOnMe({ state })).toBe(expected);
});

// An epic whose every task is done stays in In delivery and waits on the person.
it('counts an idle epic whose every task is done as waiting on me', () => {
  expect(waitingOnMe({ state: 'idle', finished: true })).toBe(true);
  expect(waitingOnMe({ state: 'idle', finished: false })).toBe(false);
});

// A wrap-up that waits for a knowledge review waits on the person, though the card reads queued.
it('counts a card waiting for a knowledge review as waiting on me', () => {
  expect(waitingOnMe({ state: 'queued', runState: 'waiting_review' })).toBe(true);
  expect(waitingOnMe({ state: 'queued', runState: 'waiting_lane' })).toBe(false);
});

// The board's filter box narrows by key or title, in any case, and an empty box keeps every card.
it('matches a card by key or title, in any case', () => {
  const card = { key: 'APP-12', title: 'Add a search box to the recipe list' };

  expect(matchesFilter(card, '')).toBe(true);
  expect(matchesFilter(card, '   ')).toBe(true);
  expect(matchesFilter(card, 'app-1')).toBe(true);
  expect(matchesFilter(card, 'SEARCH box')).toBe(true);
  expect(matchesFilter(card, ' recipe ')).toBe(true);
  expect(matchesFilter(card, 'APP-13')).toBe(false);
  expect(matchesFilter(card, 'ratings')).toBe(false);
});
