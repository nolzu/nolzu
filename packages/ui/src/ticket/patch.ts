export interface PatchLine {
  kind: 'hunk' | 'add' | 'del' | 'same';
  text: string;
}

// A file's patch as the viewer draws it. git's header lines come off, because the tab already names
// the file, so the patch starts at its first hunk. A patch with no hunk, such as a mode change, is
// shown whole, because the header is then all it says.
export function patchLines(text: string): PatchLine[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first === -1) return lines.map((line) => ({ kind: 'same', text: line }));

  return lines.slice(first).map((line) => ({
    kind: line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'same',
    text: line,
  }));
}

export interface NumberedLine extends PatchLine {
  // The line's number before and after the change. Null on the side it is not on, and on a line that is
  // no line of the file: a hunk header, git's "No newline" marker, a patch with no hunk.
  old: number | null;
  new: number | null;
  // The sign and the line of the file without it. A line with no number keeps its whole text.
  sign: string;
  code: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// The lines the diff draws with both line numbers. A comment is pinned to `new`, the line in the folder.
export function numberedLines(text: string): NumberedLine[] {
  let old = 0;
  let now = 0;
  let inHunk = false;
  return patchLines(text).map((line) => {
    const whole = { ...line, old: null, new: null, sign: '', code: line.text };
    if (line.kind === 'hunk') {
      const found = HUNK.exec(line.text);
      inHunk = found !== null;
      old = Number(found?.[1] ?? 0);
      now = Number(found?.[2] ?? 0);
      return whole;
    }
    if (!inHunk || line.text.startsWith('\\')) return whole;
    const parts = { sign: line.text.slice(0, 1).trim(), code: line.text.slice(1) };
    if (line.kind === 'add') return { ...line, ...parts, old: null, new: now++ };
    if (line.kind === 'del') return { ...line, ...parts, old: old++, new: null };
    return { ...line, ...parts, old: old++, new: now++ };
  });
}
