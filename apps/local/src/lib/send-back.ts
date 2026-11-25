import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { DiffComment } from '@nolzu/protocol';
import { placeComments } from '@nolzu/ui/comments';

export interface SendBackLine {
  repo: string;
  file: string;
  // The line it was made on, and its text then.
  line: number;
  lineText: string;
  text: string;
  // Where that line is in the folder now, or null when it is gone.
  now: number | null;
}

/**
 * Where a comment's line is in the card's folder now, matched by its text as the Changes tab matches
 * it, so the message points at the line the agent will find. Null when the line or the file is gone.
 * A file link that leads out of the checkout is never read.
 */
export function lineNow(checkout: string, comment: Pick<DiffComment, 'file' | 'line' | 'lineText'>): number | null {
  try {
    const real = realpathSync(join(checkout, comment.file));
    if (!real.startsWith(`${realpathSync(checkout)}${sep}`)) return null;
    const lines = readFileSync(real, 'utf8')
      .split('\n')
      .map((code, at) => ({ kind: 'same' as const, text: code, old: null, new: at + 1, sign: ' ', code }));
    const [index] = placeComments(lines, [comment]).at.keys();
    return index === undefined ? null : index + 1;
  } catch {
    return null;
  }
}

const plural = (count: number) => `${count} ${count === 1 ? 'comment' : 'comments'}`;
const shown = (text: string) => (text.trim() === '' ? '(an empty line)' : text.trim());

/**
 * What Send back with comments tells the Implement run, as the message of its resumed session or after
 * the card in a fresh prompt: every comment once, in file and line order, each with its repository,
 * file, line and that line's text. Paths are from the repository, which both already know.
 */
export function sendBackMessage(comments: readonly SendBackLine[]): string {
  const sorted = [...comments].sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);
  const items = sorted.map((one, at) => {
    const where = one.repo === '.' ? 'In the project folder' : `In the ${one.repo} repository`;
    const head =
      one.now === null
        ? `${where}, ${one.file}, made on line ${one.line}. That line has changed since, so the comment is outdated.`
        : `${where}, ${one.file}, line ${one.now}${one.now === one.line ? '' : ` (made on line ${one.line})`}.`;
    return [
      `${at + 1}. ${head}`,
      `   ${one.now === null ? 'The line it was made on' : 'The line'}: ${shown(one.lineText)}`,
      `   Comment: ${one.text.replaceAll('\n', '\n   ')}`,
    ].join('\n');
  });
  return [
    `The person read your change and left ${plural(comments.length)} on its lines. Do what each comment asks, then finish the way the implement skill says.`,
    ...items,
  ].join('\n\n');
}
