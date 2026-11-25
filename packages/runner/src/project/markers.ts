// The comment form, so the markers are invisible in rendered markdown. A file Nolzu did not put
// them in is never treated as managed.
const START = '<!-- nolzu:start -->';
const END = '<!-- nolzu:end -->';

export interface Block {
  // The text Nolzu owns, without the marker lines. Null when the file carries no block.
  body: string | null;
  // True when a start marker was found without its end. The file is then left alone, because
  // guessing where someone's own text begins is how a tool eats it.
  broken: boolean;
}

// The whole marker is searched for, never the word inside it, or a line of prose that mentions
// the name would be read as the start of a managed block.
function locate(text: string): { start: number; end: number } | null | 'broken' {
  const start = text.indexOf(START);
  if (start === -1) return null;
  const end = text.indexOf(END, start + START.length);
  return end === -1 ? 'broken' : { start, end };
}

export function readBlock(text: string): Block {
  const at = locate(text);
  if (at === null) return { body: null, broken: false };
  if (at === 'broken') return { body: null, broken: true };
  // One newline on each side belongs to the markers rather than to the text.
  return { body: text.slice(at.start + START.length, at.end).replace(/^\n/, '').replace(/\n$/, ''), broken: false };
}

export function writeBlock(text: string, body: string): string {
  const at = locate(text);
  // Half a block means someone edited the markers or a write was cut off. Replacing to the end of
  // the file would take their words with it, so nothing is touched.
  if (at === 'broken') return text;

  const managed = `${START}\n${body}\n${END}`;
  if (at === null) {
    if (text === '') return `${managed}\n`;
    // Their text keeps every byte it had, and the block goes after it.
    return `${text.endsWith('\n') ? text : `${text}\n`}\n${managed}\n`;
  }
  // Ends at the end marker and not at the end of the file, so a second block, and anything after
  // the first one, stays where it is.
  return text.slice(0, at.start) + managed + text.slice(at.end + END.length);
}

// The text with the block and its marker lines taken out, and the blank line writeBlock put before it.
// A file with no block, or half of one, comes back as it was.
export function withoutBlock(text: string): string {
  const at = locate(text);
  if (at === null || at === 'broken') return text;
  const before = text.slice(0, at.start).replace(/\n\n$/, '\n');
  const after = text.slice(at.end + END.length).replace(/^\n/, '');
  return before + after;
}
