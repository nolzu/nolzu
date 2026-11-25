import { expect, it } from 'vitest';
import { detectSentinel } from './engine.ts';

it('finds needs input with its question', () => {
  expect(detectSentinel('Two index names fit.\n\nNOLZU: needs_input: Which index name should the search use?')).toEqual({
    kind: 'needs_input',
    question: 'Which index name should the search use?',
  });
});

it('finds complete', () => {
  expect(detectSentinel('The plan is in place.\n\nNOLZU: complete\n')).toEqual({ kind: 'complete' });
});

it('lets a question win over complete', () => {
  expect(detectSentinel('NOLZU: complete\nNOLZU: needs_input: Which one?')).toEqual({ kind: 'needs_input', question: 'Which one?' });
});

it('ignores the sentinel words inside other text', () => {
  expect(detectSentinel('I will print NOLZU: complete when the plan is done.')).toBeNull();
  expect(detectSentinel('The contract asks for NOLZU: needs_input: <question> on its own line.')).toBeNull();
});

