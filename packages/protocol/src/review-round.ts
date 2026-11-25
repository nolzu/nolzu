/**
 * The round of findings a pull request review wrote, read into blocks.
 *
 * The file is `<card folder>/pr-review/round.md` and the `nolzu-pr-review` skill owns its shape. Each
 * block is a conventional comment (conventionalcomments.org) with its place on a line of its own above
 * it:
 *
 *     src/recipes/import.ts:88-92
 *     issue (blocking): An empty recipe file stops the whole import
 *
 *     The discussion, over as many lines and paragraphs as it needs.
 *
 * A block starts where a location line (`path:line` or `path:start-end`) stands right above a label
 * line, so the discussion may hold blank lines. A round written before the location line, whose label
 * line held the place (`issue: src/a.ts:12`), still reads, one block per paragraph.
 *
 * The Review tab, the copy of a whole round and the output check all read through here, so a round the
 * page shows is the round the check counted. Nothing is read or fetched here.
 */

// The nine labels of the published format, in its order.
export const ROUND_LABELS = ['praise', 'nitpick', 'suggestion', 'issue', 'todo', 'question', 'thought', 'chore', 'note'] as const;
export type RoundLabel = (typeof ROUND_LABELS)[number];

// The decorations the skill offers. The reader keeps any word in the brackets, so a legal comment is
// never refused for one more.
export const ROUND_DECORATIONS = ['blocking', 'non-blocking', 'if-minor'] as const;

export interface ReviewBlock {
  label: RoundLabel;
  // `non-blocking` and the like, without its brackets. Null with none, and for empty brackets too, so
  // the head never draws a bare pair of them.
  decoration: string | null;
  // The comment's subject, the words after the label. Null on a block from before the location line.
  subject: string | null;
  // The file and the line the finding is about, and the last line of a range. Null where the block
  // named none, which an older praise block on the whole change can be.
  path: string | null;
  line: number | null;
  end: number | null;
  // The discussion under the subject, or the old block's lines under its label line.
  body: string;
  // The comment as the file holds it, without its location line: what the copy button puts on the
  // clipboard, so the paste into the pull request is the review's own text. An older block is its whole
  // text, whose label line names the place.
  text: string;
}

export type RoundRead = { ok: true; blocks: ReviewBlock[] } | { ok: false; problem: string };

// CRLF and trailing spaces gone, at most one blank line in a row, and no blank line at either end.
export function normaliseRound(text: string): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  return body === '' ? '' : `${body}\n`;
}

const LABEL_LINE = new RegExp(`^(${ROUND_LABELS.join('|')})(?:[ \\t]*\\(([^)\\n]*)\\))?:[ \\t]*(.*)$`);
// Any word written where a label goes, so an unknown label is told from a line of prose.
const LOOKS_LABELLED = /^([A-Za-z][A-Za-z-]*)(?:[ \t]*\([^)\n]*\))?:/;
// The path, then the line or the first and last line of a range. A path holds no space.
const LOCATION = /^(\S+?):(\d+)(?:-(\d+))?$/;

// Short, because this sentence is shown on the screen and a run can write a very long line.
const quote = (line: string): string => JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}...` : line);

const LABELS = ROUND_LABELS.join(', ');

function refusal(first: string): string {
  if (LABEL_LINE.test(first.trimStart())) {
    return `The block starting ${quote(first)} is indented. A block starts at the left margin, so move it there and write the round again.`;
  }
  // Trimmed, like the test above it, so an indented line with a label is not told it has none.
  const named = LOOKS_LABELLED.exec(first.trimStart());
  if (named !== null) {
    const indented = first !== first.trimStart() ? ' It is indented as well, and a block starts at the left margin.' : '';
    return `The block starting ${quote(first)} carries the label "${named[1] ?? ''}", which this round file may not use. The labels are ${LABELS}.${indented}`;
  }
  return `The block starting ${quote(first)} carries no label, so it cannot be shown as a finding. Every comment starts with one of the labels: ${LABELS}.`;
}

const decorationOf = (found: RegExpExecArray): string | null => found[2]?.trim() || null;

// A round from before the location line: one block per paragraph, the place after the label.
function oldRound(normalised: string): RoundRead {
  const blocks: ReviewBlock[] = [];
  for (const chunk of normalised.slice(0, -1).split('\n\n')) {
    const lines = chunk.split('\n');
    const first = lines[0] ?? '';
    const match = LABEL_LINE.exec(first);
    if (match === null) return { ok: false, problem: refusal(first) };
    const place = match[3] ?? '';
    // The line number is the last `:digits` of the place, because a path can hold a colon of its own.
    const at = /^(.*):(\d+)$/.exec(place);
    blocks.push({
      label: match[1] as RoundLabel,
      decoration: decorationOf(match),
      subject: null,
      path: (at === null ? place : (at[1] ?? '')) || null,
      line: at === null ? null : Number(at[2]),
      end: null,
      body: lines.slice(1).join('\n'),
      text: chunk,
    });
  }
  return { ok: true, blocks };
}

/**
 * The blocks of a round file, or the one sentence saying why it cannot be shown.
 *
 * All the blocks or none of them. A comment with no location above it would read as part of the
 * finding before it, and drawing the blocks beside a broken one would print half a finding as a whole
 * one. The file itself stays readable on the Files tab, so refusing the round loses nothing.
 */
export function parseRound(text: string): RoundRead {
  const normalised = normaliseRound(text);
  if (normalised === '') {
    return {
      ok: false,
      problem: 'The round file is empty, so there is no finding to show. A round holds at least one block, and a review that found nothing to change writes one praise block saying so.',
    };
  }
  const lines = normalised.slice(0, -1).split('\n');
  const first = lines[0] ?? '';
  if (!LOCATION.test(first) && LOOKS_LABELLED.test(first.trimStart())) return oldRound(normalised);

  const starts = lines.flatMap((line, at) => (LOCATION.test(line) && LABEL_LINE.test(lines[at + 1] ?? '') ? [at] : []));
  if (starts[0] !== 0) {
    if (LOCATION.test(first)) return { ok: false, problem: refusal(lines[1] ?? '') };
    return {
      ok: false,
      problem: `The round starts with ${quote(first)}, which is not a location. Every block starts with its file and line on a line of its own, such as src/a.ts:12 or src/a.ts:12-18, and its label line under it.`,
    };
  }
  // A comment with no location above it, or a location over a line that is no label, after a blank line.
  for (const [at, line] of lines.entries()) {
    if (at === 0 || lines[at - 1] !== '' || starts.includes(at)) continue;
    if (LABEL_LINE.test(line)) return { ok: false, problem: `The block starting ${quote(line)} has no location line above it, so it would read as part of the finding before it. Put its file and line on the line above the label.` };
    if (LOCATION.test(line) && LOOKS_LABELLED.test((lines[at + 1] ?? '').trimStart())) return { ok: false, problem: refusal(lines[at + 1] ?? '') };
  }

  const blocks: ReviewBlock[] = [];
  for (const [index, start] of starts.entries()) {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length);
    while (chunk.at(-1) === '') chunk.pop();
    const place = LOCATION.exec(chunk[0] ?? '');
    const label = LABEL_LINE.exec(chunk[1] ?? '');
    if (place === null || label === null) return { ok: false, problem: refusal(chunk[1] ?? '') };
    const subject = (label[3] ?? '').trim();
    if (subject === '') return { ok: false, problem: `The comment at ${chunk[0] ?? ''} has no subject after its label. Write what the finding is about on the label line.` };
    const rest = chunk.slice(2);
    const end = place[3] === undefined ? null : Number(place[3]);
    blocks.push({
      label: label[1] as RoundLabel,
      decoration: decorationOf(label),
      subject,
      path: place[1] ?? null,
      line: Number(place[2]),
      end: end === Number(place[2]) ? null : end,
      body: (rest[0] === '' ? rest.slice(1) : rest).join('\n'),
      text: chunk.slice(1).join('\n'),
    });
  }
  return { ok: true, blocks };
}

// The place as the location line writes it, or null on a block that named none.
export const blockPlace = (block: Pick<ReviewBlock, 'path' | 'line' | 'end'>): string | null =>
  block.path === null ? null : block.line === null ? block.path : `${block.path}:${block.line}${block.end === null ? '' : `-${block.end}`}`;

// Whether a comment stands in the way of the merge: an issue or a todo unless marked non-blocking, and
// any other comment marked blocking. The review summary's verdict follows it.
export function isBlocking(block: Pick<ReviewBlock, 'label' | 'decoration'>): boolean {
  const marks = (block.decoration ?? '').split(',').map((one) => one.trim());
  if (marks.includes('non-blocking')) return false;
  return block.label === 'issue' || block.label === 'todo' || marks.includes('blocking');
}
