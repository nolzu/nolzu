import type { QuestionOption } from './sentinels.ts';

// The most answers a question may offer. A longer list is no quick choice, and cutting it short
// would show part of the list as if it were all of it.
export const MAX_QUESTION_OPTIONS = 6;

// A list item, then the label up to the first colon with a space after it, then the meaning.
const OPTION = /^(?:[-*+]|\d+[.)])\s+(.+?):\s+(.+)$/;

const unique = (options: readonly QuestionOption[]): boolean => new Set(options.map((option) => option.label)).size === options.length;

const fits = (options: readonly QuestionOption[]): boolean =>
  options.length >= 2 && options.length <= MAX_QUESTION_OPTIONS && unique(options);

/**
 * The answers a blocked run offered, read from the question file the finish rules ask for.
 *
 * All or nothing. One line that is not an answer with its meaning, a list of one, a list past the
 * cap or the same answer twice, and the whole file reads as no options. The question then shows as
 * plain text, the way it did before the file, and never as half a list.
 */
export function parseQuestionOptions(text: string | null): QuestionOption[] | null {
  if (text === null) return null;
  const options: QuestionOption[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // A heading carries no answer, and an agent often writes one.
    if (line === '' || line.startsWith('#')) continue;
    // Bold around the label is how many agents write a list like this one.
    const found = OPTION.exec(line.replaceAll('**', ''));
    const label = found?.[1]?.trim() ?? '';
    const means = found?.[2]?.trim() ?? '';
    if (label === '' || means === '') return null;
    options.push({ label, means });
  }
  return fits(options) ? options : null;
}

/**
 * The options as a run row stores them, or null for a run that offered none.
 *
 * The row is the loop's own, but a hand edit or a later build may have written it, so a value that
 * is not a list of answers reads as none rather than stopping the board.
 */
export function storedQuestionOptions(json: string | null): QuestionOption[] | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    const options = value
      .filter((one): one is QuestionOption => typeof one?.label === 'string' && one.label !== '' && typeof one.means === 'string')
      .map(({ label, means }) => ({ label, means }));
    return options.length === value.length && fits(options) ? options : null;
  } catch {
    return null;
  }
}
