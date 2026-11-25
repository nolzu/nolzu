// GitHub cuts a commit title past this length, and one-line logs get hard to read beyond it.
export const SUBJECT_WARN_AT = 72;

// A warning for a long subject line, or null. Git takes a subject of any length, so this never stops
// a commit, it only says why a shorter one reads better.
export function subjectWarning(message: string): string | null {
  const subject = (message.replace(/\r\n/g, '\n').split('\n').find((line) => line.trim() !== '') ?? '').trim();
  if (subject.length <= SUBJECT_WARN_AT) return null;
  return `The subject line is ${subject.length} characters. Git takes it, but GitHub cuts commit titles after ${SUBJECT_WARN_AT} characters, and one-line logs such as git log --oneline get hard to read. If you can, keep the subject short and put the detail in the body, under a blank line.`;
}
