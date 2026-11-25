import type { DiffComment } from '@nolzu/protocol';
import type { NumberedLine } from './patch.ts';

// How far from its saved number a comment's line is looked for. Far enough for an edit that added a
// block above it, near enough that a closing brace fifty lines on is not read as the same line.
export const NEAR = 50;

/**
 * Where each comment of one file shows in its current diff, by the index of the line it goes under.
 * A comment is matched by the line's text as it was, nearest its saved number, so an edit above it
 * moves it with its line. A comment whose line is gone from the diff is outdated and goes at the end
 * of the file, never dropped. A removed line is no line of the folder, so nothing is pinned to it.
 */
export function placeComments<C extends Pick<DiffComment, 'line' | 'lineText'>>(
  lines: readonly NumberedLine[],
  comments: readonly C[],
): { at: Map<number, C[]>; outdated: C[] } {
  const at = new Map<number, C[]>();
  const outdated: C[] = [];
  for (const comment of comments) {
    let best = -1;
    lines.forEach((line, index) => {
      if (line.new === null || line.code !== comment.lineText) return;
      const far = Math.abs(line.new - comment.line);
      if (far <= NEAR && (best === -1 || far < Math.abs((lines[best]?.new ?? 0) - comment.line))) best = index;
    });
    if (best === -1) outdated.push(comment);
    else at.set(best, [...(at.get(best) ?? []), comment]);
  }
  return { at, outdated };
}
