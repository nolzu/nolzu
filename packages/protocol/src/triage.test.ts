import { describe, expect, it } from 'vitest';
import { parseTriage } from './triage.ts';

const GOOD = `T1: fix
Summary: The search ignores case.
Reason: The match compares raw strings.
Reply: Good catch, I will lower case both sides.

T3: none
Summary: Praise for the tests.
Reason: Nothing to act on.
Reply:
`;

describe('parseTriage', () => {
  it('reads every block of a good file', () => {
    expect(parseTriage(GOOD)).toEqual({
      ok: true,
      blocks: [
        { ref: 'T1', verdict: 'fix', summary: 'The search ignores case.', reason: 'The match compares raw strings.', reply: 'Good catch, I will lower case both sides.' },
        { ref: 'T3', verdict: 'none', summary: 'Praise for the tests.', reason: 'Nothing to act on.', reply: null },
      ],
    });
  });

  it('takes CRLF, trailing spaces and extra blank lines', () => {
    const read = parseTriage(`\r\n${GOOD.replaceAll('\n', '  \r\n').replace('\r\n\r\n', '\r\n\r\n\r\n')}`);
    expect(read.ok && read.blocks.map((one) => one.ref)).toEqual(['T1', 'T3']);
  });

  const refused = (text: string): string => {
    const read = parseTriage(text);
    if (read.ok) throw new Error('the file was taken');
    return read.problem;
  };

  it('refuses an empty file', () => {
    expect(refused('\n \n')).toBe('triage.md is empty, so no verdict was taken from it.');
  });

  it('refuses a first line with no ref, naming the line', () => {
    expect(refused(GOOD.replace('T3: none', 'Third: none'))).toMatch(/^Line 6 of triage\.md is "Third: none", where a block starts with a ref and a verdict, such as "T3: fix"\./);
  });

  it('refuses a verdict outside the five', () => {
    expect(refused(GOOD.replace('T1: fix', 'T1: maybe'))).toBe('Line 1 of triage.md gives T1 the verdict "maybe". The verdicts are fix, reject, clarify, defer and none.');
  });

  it('refuses an indented line', () => {
    expect(refused(GOOD.replace('Reason: The match', '  Reason: The match'))).toMatch(/^Line 3 of triage\.md is indented\./);
  });

  it('refuses a field out of order or missing', () => {
    expect(refused(GOOD.replace('Summary: The search ignores case.\n', ''))).toMatch(/^Line 2 of triage\.md should start with "Summary:"/);
  });

  it('refuses an empty summary or reason', () => {
    expect(refused(GOOD.replace('Summary: Praise for the tests.', 'Summary:'))).toBe('Line 7 of triage.md gives T3 no summary. Summary and Reason each hold one line.');
    expect(refused(GOOD.replace('Reason: Nothing to act on.', 'Reason:'))).toBe('Line 8 of triage.md gives T3 no reason. Summary and Reason each hold one line.');
  });

  it('refuses a block that ends early', () => {
    expect(refused('T1: fix\nSummary: a\nReason: b\n')).toBe('The block of T1 at line 1 of triage.md ends before its Reply: line. A block holds four lines.');
  });

  it('refuses a fifth line, which is also what a reply on two lines looks like', () => {
    expect(refused(GOOD.replace('both sides.', 'both sides.\nAnd add a test.'))).toBe(
      'Line 5 of triage.md is a fifth line in the block of T1. A block holds four lines, and the reply is one paragraph on one line.',
    );
  });

  it('refuses a ref with two blocks', () => {
    expect(refused(GOOD.replace('T3: none', 'T1: none'))).toBe('Line 6 of triage.md starts a second block for T1. Each ref has one block.');
  });
});
