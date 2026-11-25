import { expect, it } from 'vitest';
import { cleanSummary, needsExtraction } from './summary.ts';

it('strips the heading the skill repeats and keeps the line breaks of the body', () => {
  const text = '## What changed, in plain words\n\nThe recipe list has a search box.\nTyping narrows the list.\n';
  expect(cleanSummary(text)).toBe('The recipe list has a search box.\nTyping narrows the list.');
});

it('strips the heading at any level and any case, and nothing else', () => {
  expect(cleanSummary('# what changed, in plain words\nOne line.')).toBe('One line.');
  expect(cleanSummary('What changed, in plain words\nOne line.')).toBe('One line.');
  expect(cleanSummary('One line about what changed, in plain words.')).toBe('One line about what changed, in plain words.');
});

it('turns a file of only whitespace, or only the heading, into nothing', () => {
  expect(cleanSummary('  \n\t\n')).toBe('');
  expect(cleanSummary('## What changed, in plain words\n\n')).toBe('');
});

it.each([null, '', '   \n  '])('needs an extraction pass for %p', (text) => {
  expect(needsExtraction(text)).toBe(true);
});

it('needs no extraction pass for one real sentence', () => {
  expect(needsExtraction('The list has a search box.')).toBe(false);
});
