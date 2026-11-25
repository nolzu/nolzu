import { expect, it } from 'vitest';
import { NEEDS_INPUT_PREFIX, needsInputLine, QUESTION_FILE, SENTINEL_COMPLETE, VERDICTS, VERDICT_PREFIX } from './sentinels.ts';

it('spells the complete sentinel the way the parser looks for it', () => {
  expect(SENTINEL_COMPLETE).toBe('NOLZU: complete');
});

it('spells the needs input prefix the way the parser looks for it', () => {
  expect(NEEDS_INPUT_PREFIX).toBe('NOLZU: needs_input: ');
});

it('builds a question line from the prefix', () => {
  expect(needsInputLine('Which index name?')).toBe('NOLZU: needs_input: Which index name?');
});

it('folds a question onto one line, because a sentinel is read line by line', () => {
  expect(needsInputLine('Which index name?\nThe migration needs it.')).toBe(
    'NOLZU: needs_input: Which index name? The migration needs it.',
  );
});

it('trims the question, so trailing space cannot change the text', () => {
  expect(needsInputLine('  Which index name?  ')).toBe('NOLZU: needs_input: Which index name?');
});

// The skills write this name and the loop reads it. A rename on one side alone leaves every question
// plain text, which no other test would see.
it('names the question file the skills write in the phase folder', () => {
  expect(QUESTION_FILE).toBe('question.md');
});

it('spells the verdict prefix the way the parser looks for it', () => {
  expect(VERDICT_PREFIX).toBe('NOLZU: verdict: ');
});

// Pinned whole, not looped over. A test that walks the array and looks each word up in the rule
// text stays green when a word is dropped from the array, and the QA verdict parser built from it would
// then read a failing run as no verdict at all.
it('holds all three verdicts, in the order the rules name them', () => {
  expect(VERDICTS).toEqual(['PASS', 'FAIL', 'BLOCKED']);
});
