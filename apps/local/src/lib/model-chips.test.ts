import { expect, it } from 'vitest';
import { stepWord } from './model-chips.ts';

it.each([
  ['Refine', 'ref'],
  ['Plan', 'plan'],
  ['Implement', 'impl'],
  ['QA', 'qa'],
  ['Wrap-up', 'wrap'],
  ['PR review', 'pr'],
])('shortens the step %s to %s', (step, word) => {
  expect(stepWord(step)).toBe(word);
});
