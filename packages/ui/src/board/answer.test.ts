import { describe, expect, it } from 'vitest';
import { answerHref, askedLine, pickOption, questionParts } from './answer.ts';
import { cardFixture } from './fixture.ts';

it('sends a blocked card with a question to the composer on its card page, with the key encoded', () => {
  expect(answerHref(cardFixture({ key: 'APP 1', state: 'blocked', question: 'Which index name?' }))).toBe('/t/APP%201/overview#asks');
});

// A has nothing to answer on any other card, and the key keeps its own job in the browser.
it.each(['idle', 'queued', 'running', 'ready', 'failed'] as const)('has nowhere to go on a %s card', (state) => {
  expect(answerHref(cardFixture({ key: 'APP-1', state, question: 'Which index name?' }))).toBeNull();
});

it('has nowhere to go on a blocked card that carries no question', () => {
  expect(answerHref(cardFixture({ key: 'APP-1', state: 'blocked' }))).toBeNull();
});

// A press puts the option in front of what the person typed, and a second press swaps the option and
// keeps the text. The composer and Now share it, so the two answer the same way.
describe('pickOption', () => {
  const options = [{ label: '1 to 5 stars' }, { label: 'Thumbs up and down' }];

  it('fills an empty answer with the label', () => {
    expect(pickOption('', options, '1 to 5 stars')).toBe('1 to 5 stars');
    expect(pickOption('  \n', options, '1 to 5 stars')).toBe('1 to 5 stars');
  });

  it('puts the label in front of typed text, after a blank line', () => {
    expect(pickOption('Keep the old likes.', options, '1 to 5 stars')).toBe('1 to 5 stars\n\nKeep the old likes.');
  });

  it('swaps the label a press put there, alone or with the typed text', () => {
    expect(pickOption('1 to 5 stars', options, 'Thumbs up and down')).toBe('Thumbs up and down');
    expect(pickOption('1 to 5 stars\n\nKeep the old likes.', options, 'Thumbs up and down')).toBe('Thumbs up and down\n\nKeep the old likes.');
  });

  // A label the person edited is their text now, so it stays behind the new label.
  it('keeps an edited label as typed text', () => {
    expect(pickOption('1 to 5 stars please', options, 'Thumbs up and down')).toBe('Thumbs up and down\n\n1 to 5 stars please');
  });
});

// A blocked card: the question at size, then the paragraphs the run wrote under it, then the files it named.
describe('questionParts', () => {
  it('splits the first paragraph from the rest, and chips each file named in backticks', () => {
    const question = 'Should a rating be 1 to 5 stars, or thumbs up and down?\n\nStars need a new column in `recipes`.\nThat is one migration.\n\nThumbs reuse `api/src/likes.ts` and `api/db/schema.sql`.';

    expect(questionParts(question)).toEqual({
      lead: 'Should a rating be 1 to 5 stars, or thumbs up and down?',
      body: ['Stars need a new column in `recipes`.\nThat is one migration.', 'Thumbs reuse `api/src/likes.ts` and `api/db/schema.sql`.'],
      files: ['api/src/likes.ts', 'api/db/schema.sql'],
    });
  });

  it('keeps a one paragraph question whole, with no body and no files', () => {
    expect(questionParts('Titles only, or ingredients too?')).toEqual({ lead: 'Titles only, or ingredients too?', body: [], files: [] });
  });
});

describe('askedLine', () => {
  it('says when the card started to wait and for how long', () => {
    expect(askedLine('2026-10-15T15:02:00Z', new Date('2026-10-15T15:14:30Z'), 'UTC')).toBe('asked 15:02 · waiting 12m');
    expect(askedLine('2026-10-15T13:02:00Z', new Date('2026-10-15T15:14:30Z'), 'UTC')).toBe('asked 13:02 · waiting 2h 12m');
  });

  it('says nothing for a time that is no time', () => {
    expect(askedLine('2026-10-15T14:14:00Z', new Date('2026-10-15T15:14:30Z'), 'UTC')).toBe('asked 14:14 · waiting 1h 0m');
    expect(askedLine('2026-10-15T14:15:00Z', new Date('2026-10-15T15:14:30Z'), 'UTC')).toBe('asked 14:15 · waiting 59m');
    expect(askedLine('soon', new Date(), 'UTC')).toBeNull();
  });
});
