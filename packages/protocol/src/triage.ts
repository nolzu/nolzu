/**
 * The verdicts a triage run wrote, read from `<card folder>/feedback/triage.md`.
 *
 * The `nolzu-feedback` skill owns the shape: one block per discussion, blocks split by a blank line,
 * and four lines in each, `T3: fix`, `Summary:`, `Reason:` and `Reply:`. All the blocks or none, the
 * same rule as a review round: a file with one block that does not parse is refused whole, with the
 * line named, because rows half updated from a broken file read as a finished triage. Here and not in
 * the ui package, because the loop applies the file when the run ends and the PRs tab shows the
 * refusal.
 */

export const TRIAGE_VERDICTS = ['fix', 'reject', 'clarify', 'defer', 'none'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export interface TriageBlock {
  ref: string;
  verdict: TriageVerdict;
  summary: string;
  reason: string;
  // Null when the run left it empty, which a `none` may do.
  reply: string | null;
}

export type TriageRead = { ok: true; blocks: TriageBlock[] } | { ok: false; problem: string };

const FILE = 'triage.md';
const FIELDS = ['Summary', 'Reason', 'Reply'] as const;
const HEAD = /^(T\d+):[ \t]*(\S*)$/;
const VERDICTS = 'fix, reject, clarify, defer and none';

// Short, because the sentence is shown on the screen and a run can write a very long line.
const quote = (line: string): string => JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}...` : line);

export function parseTriage(text: string): TriageRead {
  // CRLF and trailing spaces go, blank lines stay, so a line number matches the file a person opens.
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  const refuse = (problem: string): TriageRead => ({ ok: false, problem });
  const blocks: TriageBlock[] = [];
  let at = 0;
  while (at < lines.length) {
    if (lines[at] === '') {
      at += 1;
      continue;
    }
    const start = at;
    const chunk: string[] = [];
    while (at < lines.length && lines[at] !== '') chunk.push(lines[at++] ?? '');
    for (const [index, line] of chunk.entries()) {
      if (line !== line.trimStart()) return refuse(`Line ${start + index + 1} of ${FILE} is indented. Every line of a block starts at the left margin.`);
    }
    const first = chunk[0] ?? '';
    const head = HEAD.exec(first);
    if (head === null) return refuse(`Line ${start + 1} of ${FILE} is ${quote(first)}, where a block starts with a ref and a verdict, such as "T3: fix".`);
    const ref = head[1] ?? '';
    const verdict = head[2] ?? '';
    if (!(TRIAGE_VERDICTS as readonly string[]).includes(verdict)) return refuse(`Line ${start + 1} of ${FILE} gives ${ref} the verdict ${quote(verdict)}. The verdicts are ${VERDICTS}.`);
    if (blocks.some((one) => one.ref === ref)) return refuse(`Line ${start + 1} of ${FILE} starts a second block for ${ref}. Each ref has one block.`);
    const values: string[] = [];
    for (const [index, field] of FIELDS.entries()) {
      const line = chunk[index + 1];
      const number = start + index + 2;
      if (line === undefined) return refuse(`The block of ${ref} at line ${start + 1} of ${FILE} ends before its ${field}: line. A block holds four lines.`);
      if (!line.startsWith(`${field}:`)) return refuse(`Line ${number} of ${FILE} should start with "${field}:", the ${['second', 'third', 'fourth'][index]} line of the block of ${ref}.`);
      const value = line.slice(field.length + 1).trim();
      if (value === '' && field !== 'Reply') return refuse(`Line ${number} of ${FILE} gives ${ref} no ${field.toLowerCase()}. Summary and Reason each hold one line.`);
      values.push(value);
    }
    if (chunk.length > 4) return refuse(`Line ${start + 5} of ${FILE} is a fifth line in the block of ${ref}. A block holds four lines, and the reply is one paragraph on one line.`);
    blocks.push({ ref, verdict: verdict as TriageVerdict, summary: values[0] ?? '', reason: values[1] ?? '', reply: values[2] || null });
  }
  if (blocks.length === 0) return refuse(`${FILE} is empty, so no verdict was taken from it.`);
  return { ok: true, blocks };
}
