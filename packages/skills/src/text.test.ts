import { NEEDS_INPUT_PREFIX, parseQuestionOptions, QUESTION_FILE, SENTINEL_COMPLETE } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { commitMessagePrompt, threadTitlePrompt, TITLE_TEXT_LIMIT, extractSummaryPrompt, plainSummaryRule, readFinishRules, readVerdictRules, RUN_TEXT_LIMIT } from './text.ts';

const rules = readFinishRules();

it('carries both sentinel lines exactly as the parser looks for them', () => {
  // The prompt and the parser have to agree letter for letter. Reading the constants from
  // protocol here means a change in one place fails this test rather than a run.
  expect(rules).toContain(SENTINEL_COMPLETE);
  expect(rules).toContain(NEEDS_INPUT_PREFIX);
});

// The rules and the loop have to agree on the file and on its shape. The example in the rules,
// filled in, is what the parser has to read, or every skill would write a list nothing shows.
it('asks for the question file in the shape the parser reads', () => {
  expect(rules).toContain(`<card folder>/<phase>/${QUESTION_FILE}`);
  const example = [...rules.matchAll(/^ {4}(- <a short answer>: <what it means for the work>)$/gm)].map((match) => match[1]!);
  expect(example).toHaveLength(2);
  const filled = example.map((line, at) => line.replace('<a short answer>', `Answer ${at + 1}`).replace('<what it means for the work>', 'what it means')).join('\n');
  expect(parseQuestionOptions(filled)).toEqual([
    { label: 'Answer 1', means: 'what it means' },
    { label: 'Answer 2', means: 'what it means' },
  ]);
});

it('names the plain summary heading the ticket page looks for', () => {
  expect(rules).toContain('What changed, in plain words');
});

it('tells the phase to write the summary to its own file as well', () => {
  expect(rules).toContain('summary.md');
});

it('follows the voice rules, because this text ships to a reader', () => {
  expect(rules).not.toMatch(/—|–/);
  expect(rules).not.toMatch(/delve|leverage|robust|seamless|elevate|unlock|comprehensive|ensure that/i);
});

it('reads the same text every time and does not throw on a second call', () => {
  expect(rules.length).toBeGreaterThan(0);
  expect(readFinishRules()).toBe(rules);
});

it('builds the extraction prompt from the same words the skills carry', () => {
  const prompt = extractSummaryPrompt('The recipe list now filters on the title.');

  expect(rules).toContain(plainSummaryRule());
  expect(prompt).toContain(plainSummaryRule());
  expect(prompt).toContain('Two to five sentences, for a reader who does');
  expect(prompt).toContain('The recipe list now filters on the title.');
});

// The pass has only Read and answers in text, so the phase contract around the rule stays out.
it('gives the extraction pass the plain summary rule and none of the phase contract', () => {
  const prompt = extractSummaryPrompt('Some run text.');

  expect(plainSummaryRule()).toMatch(/^## What changed, in plain words\n\nWrite a short section/);
  for (const part of ['Before you approve', 'summary.md', 'With a shell', 'NOLZU: complete', 'discoveries.md']) expect(prompt).not.toContain(part);
});

it('names no skill and carries no slash command', () => {
  // The second pass runs with no skill behind it. That is the whole point: a skill with a
  // strong output format would swallow these instructions, and this prompt has none.
  const prompt = extractSummaryPrompt('Some run text.');

  expect(prompt).not.toMatch(/\/(refine|plan|implement|qa|wrapup)\b/);
  expect(prompt).not.toMatch(/nolzu-(refine|plan|implement|qa|wrapup)/);
});

// A long run says what it did at the end, so the cut drops the start.
it('keeps the end of a long run text and says in the prompt that the start was cut', () => {
  const prompt = extractSummaryPrompt(`START ${'x'.repeat(20_000)} The filter is in place.`);

  expect(prompt).toContain(`last ${RUN_TEXT_LIMIT} characters`);
  expect(prompt).toContain('The filter is in place.');
  expect(prompt).not.toContain('START');
  expect(prompt.length).toBeLessThan(20_000);
});

it('leaves a run text inside the limit alone', () => {
  const short = 'The filter is in place.';
  expect(extractSummaryPrompt(short)).not.toContain('was cut');
});

// The two shared files go through one cache keyed by file name. A cache that keys every read
// under the same name is green in a suite that reads only one of them, and in a real run it hands
// the second pass the wrong rules: the extraction prompt would carry the verdict rules and ask a
// run with no verdict to write one.
it('keeps the two shared rule files apart, whichever is read first', () => {
  const verdict = readVerdictRules();

  expect(readFinishRules()).toBe(rules);
  expect(verdict).not.toBe(rules);
  expect(verdict).toContain('NOLZU: verdict: ');
  expect(readFinishRules()).not.toContain('NOLZU: verdict: ');
});

it('builds the extraction prompt from the finish rules and not the verdict rules', () => {
  const prompt = extractSummaryPrompt('Some run text.');

  expect(prompt).toContain(plainSummaryRule());
  expect(prompt).not.toContain(readVerdictRules());
});

it('asks for a conventional message with a short subject, from the diff it is handed', () => {
  const prompt = commitMessagePrompt('+changed', false).replace(/\s+/g, ' ');

  expect(prompt).toContain('`type(scope): subject`');
  expect(prompt).toContain('72 characters or fewer');
  expect(prompt).toMatch(/short body only when/);
  expect(prompt.endsWith('+changed')).toBe(true);
});

it('asks the short kind for the subject alone', () => {
  const prompt = commitMessagePrompt('+changed', true);

  expect(prompt).toMatch(/one line commit message/);
  expect(prompt).not.toMatch(/body/);
  expect(prompt).not.toMatch(/—|–/);
});

// The subject pass reads the first question and answer, and nothing else.
it('asks for a short subject from the question and the answer, cut to the limit', () => {
  const prompt = threadTitlePrompt('Where does the list come from?', `It comes from one file.${'x'.repeat(TITLE_TEXT_LIMIT)}`);

  expect(prompt).toContain('3 to 6 words');
  expect(prompt).toContain('The question:\n\nWhere does the list come from?');
  expect(prompt).toContain('The answer:\n\nIt comes from one file.');
  expect(prompt).toContain('[cut]');
  expect(prompt.length).toBeLessThan(TITLE_TEXT_LIMIT * 2);
});
