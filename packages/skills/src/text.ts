import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageFolder } from './project-files.ts';

// How much of a run's output the extraction pass is shown. Long enough to hold the end of a
// real run, short enough that the second pass stays cheap. The pass keeps the end, where a run
// says what it did.
export const RUN_TEXT_LIMIT = 8000;

const cache = new Map<string, string>();

function readShared(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    // Through the package, never through this file's own place: this module is inlined into the
    // app's bundle and the folder is not copied beside it.
    text = readFileSync(join(packageFolder('shared'), name), 'utf8');
    cache.set(name, text);
  }
  return text;
}

// The one copy of the rules every phase ends with. Each skill folder carries a copy of this
// file, and a test keeps the copies identical, so there is no generator and no build step.
export function readFinishRules(): string {
  return readShared('finish.md');
}

// The one copy of the rules a knowledge file follows. Each skill that writes knowledge carries a
// copy, and a test keeps the copies identical. Nothing lints a knowledge file itself, so this
// text is the only thing holding the shape the Knowledge screen reads.
export function readKnowledgeRules(): string {
  return readShared('knowledge.md');
}

// The one copy of the rules QA judges by. The qa skill carries a copy, and a test keeps the two
// identical. A parser is the only reader of the line these rules ask for, so this text is the
// only thing holding its shape.
export function readVerdictRules(): string {
  return readShared('verdict.md');
}

// The plain summary rule alone: the heading and its first paragraph. The rest of the finish rules
// (the review block, the files, the shell, the last line) is for a phase, and would push a pass that
// only answers to write a block or a file it has no tool for.
export function plainSummaryRule(): string {
  const rules = readFinishRules();
  const start = rules.indexOf('## What changed, in plain words');
  if (start === -1) throw new Error('The finish rules have no "What changed, in plain words" section.');
  return rules.slice(start).split('\n\n').slice(0, 2).join('\n\n');
}

// The prompt for the pass that runs when a phase finished without writing its summary file.
// It names no skill and carries no slash command on purpose: a skill with a strong output
// format ignores appended instructions, and this run has no skill behind it, so the rules
// reach the model as the prompt itself.
export function extractSummaryPrompt(runText: string): string {
  const tooLong = runText.length > RUN_TEXT_LIMIT;
  const text = tooLong ? runText.slice(-RUN_TEXT_LIMIT) : runText;

  return [
    'Read the run output below and write the plain summary the run was meant to end with.',
    '',
    'Follow these rules exactly:',
    '',
    plainSummaryRule(),
    '',
    'Answer with the summary section and nothing else. Do not print a sentinel line.',
    '',
    'The run output:',
    '',
    text,
    ...(tooLong ? ['', `[The run output above is its last ${RUN_TEXT_LIMIT} characters. The start was cut.]`] : []),
  ].join('\n');
}

// The prompt for the pass a person starts from the Changes tab with one of the two message buttons.
// Like the summary pass it names no skill: the rules are the prompt. The short kind asks for the
// subject alone, and the caller keeps only the subject whatever comes back.
export function commitMessagePrompt(diff: string, short: boolean): string {
  return [
    short
      ? 'Write a one line commit message for the change below.'
      : 'Write a commit message for the change below.',
    '',
    'Use the conventional format `type(scope): subject`. The type is one of feat, fix, docs, refactor, test, chore, perf, build or ci. The scope is the part of the project the change is in, and can be left out with its brackets. Write the subject in the imperative, in 72 characters or fewer, with no period at the end.',
    ...(short ? [] : ['', 'After a blank line, add a short body only when the reason for the change is not visible in the change itself. Wrap the body at 72 characters.']),
    '',
    'Answer with the message and nothing else: no code fence, no quotes and no sentinel line. Change no file.',
    '',
    'The change:',
    '',
    diff,
  ].join('\n');
}

// Limit: the question and the answer are cut to this many characters each, since a subject needs
// the gist and not a long answer's whole text.
export const TITLE_TEXT_LIMIT = 2000;

// The prompt for the pass that names an Ask discussion after its first answer. Like the other passes
// it names no skill and reads nothing: the question and the answer are the whole input.
export function threadTitlePrompt(question: string, answer: string): string {
  const cut = (text: string) => (text.length > TITLE_TEXT_LIMIT ? `${text.slice(0, TITLE_TEXT_LIMIT)}\n[cut]` : text);
  return [
    'Write a subject of 3 to 6 words for the discussion below, so a person finds it again in a list.',
    '',
    'Name what the question is about, in the language of the question. Use plain words, sentence case and no period at the end.',
    '',
    'Answer with the subject and nothing else: no quotes, no label and no sentinel line. Read no file and change none.',
    '',
    'The question:',
    '',
    cut(question.trim()),
    '',
    'The answer:',
    '',
    cut(answer.trim()),
  ].join('\n');
}
