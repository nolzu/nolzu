import { describe, expect, it } from 'vitest';
import { MAX_QUESTION_OPTIONS, parseQuestionOptions, storedQuestionOptions } from './question-options.ts';

const STARS = { label: '1 to 5 stars', means: 'A new column in recipes, one migration' };
const THUMBS = { label: 'Thumbs up and down', means: 'Reuses the likes table, no migration' };
const GOOD = `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`;

describe('parseQuestionOptions', () => {
  it('reads each answer and what it means, in the order written', () => {
    expect(parseQuestionOptions(GOOD)).toEqual([STARS, THUMBS]);
  });

  // An agent writes lists in more than one way. The answers are the same answers.
  it.each([
    ['star markers', `* ${STARS.label}: ${STARS.means}\n* ${THUMBS.label}: ${THUMBS.means}`],
    ['numbers', `1. ${STARS.label}: ${STARS.means}\n2) ${THUMBS.label}: ${THUMBS.means}`],
    ['bold labels', `- **${STARS.label}**: ${STARS.means}\n- **${THUMBS.label}:** ${THUMBS.means}`],
    ['a heading and blank lines', `# Answers\n\n- ${STARS.label}: ${STARS.means}\n\n- ${THUMBS.label}: ${THUMBS.means}\n\n`],
    ['Windows line ends', `- ${STARS.label}: ${STARS.means}\r\n- ${THUMBS.label}: ${THUMBS.means}\r\n`],
  ])('reads a list written with %s', (_, text) => {
    expect(parseQuestionOptions(text)).toEqual([STARS, THUMBS]);
  });

  // The first colon with a space after it ends the label, so the meaning may hold one, and a time in
  // the label has no space after its colon.
  it('splits at the first colon followed by a space', () => {
    expect(parseQuestionOptions('- At 12:00: the job runs at noon: once a day\n- Never: no job')).toEqual([
      { label: 'At 12:00', means: 'the job runs at noon: once a day' },
      { label: 'Never', means: 'no job' },
    ]);
  });

  // All or nothing. Showing the answers that did parse would show part of the list as if it were all.
  it.each([
    ['an answer with no meaning', `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}`],
    ['an answer cut before its meaning', `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}:`],
    // Two good answers are still a list, so this one fails on the broken third and not on the count.
    ['two good answers and a third with no meaning', `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n- Hearts`],
    ['a sentence between the answers', `- ${STARS.label}: ${STARS.means}\nPick the one you like.\n- ${THUMBS.label}: ${THUMBS.means}`],
    ['a line that is no list item', `${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}`],
    ['an empty label', `- : ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}`],
    ['the same answer twice', `- ${STARS.label}: ${STARS.means}\n- ${STARS.label}: ${THUMBS.means}`],
  ])('reads a partial or broken block with %s as no options', (_, text) => {
    expect(parseQuestionOptions(text)).toBeNull();
  });

  // One answer is no choice, and a long list is no quick one. Cutting it at the cap would hide the rest.
  it('reads a list of one, or one past the cap, as no options', () => {
    const list = (count: number) => Array.from({ length: count }, (_, at) => `- Answer ${at + 1}: what ${at + 1} means`).join('\n');

    expect(parseQuestionOptions(list(1))).toBeNull();
    expect(parseQuestionOptions(list(MAX_QUESTION_OPTIONS))).toHaveLength(MAX_QUESTION_OPTIONS);
    expect(parseQuestionOptions(list(MAX_QUESTION_OPTIONS + 1))).toBeNull();
  });

  it.each([
    ['no file', null],
    ['an empty file', ''],
    ['a heading alone', '# Answers\n'],
  ])('reads %s as no options', (_, text) => {
    expect(parseQuestionOptions(text)).toBeNull();
  });
});

describe('storedQuestionOptions', () => {
  it('reads back what was stored', () => {
    expect(storedQuestionOptions(JSON.stringify([STARS, THUMBS]))).toEqual([STARS, THUMBS]);
  });

  // A run from before the column, or one that offered none.
  it('reads a null column as no options', () => {
    expect(storedQuestionOptions(null)).toBeNull();
  });

  // A hand edit or a later build must not stop the board from drawing.
  it.each([
    ['text that is no JSON', '- 1 to 5 stars: a column'],
    ['an empty list', '[]'],
    ['an answer with no meaning', JSON.stringify([STARS, { label: 'Thumbs' }])],
    ['an object', JSON.stringify({ label: 'Stars', means: 'a column' })],
    ['an empty label', JSON.stringify([STARS, { label: '', means: 'nothing' }])],
    // Two good answers are still a list, so this one fails on the broken third and not on the count.
    ['two good answers and a third with no meaning', JSON.stringify([STARS, THUMBS, { label: 'Hearts' }])],
  ])('reads %s as no options', (_, json) => {
    expect(storedQuestionOptions(json)).toBeNull();
  });

  it('keeps only the two fields, so a stored extra never reaches the page', () => {
    expect(storedQuestionOptions(JSON.stringify([{ ...STARS, path: 'api/db/schema.sql' }, THUMBS]))).toEqual([STARS, THUMBS]);
  });
});
