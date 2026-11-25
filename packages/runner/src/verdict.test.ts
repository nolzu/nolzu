import { describe, expect, it } from 'vitest';
import { extractVerdict } from './verdict.ts';

// What a run really prints: a few sentences of report, then the verdict line, then the line that
// closes the run. The text below is shaped like that and not like one line handed to a parser.
const run = (...lines: string[]): string => lines.join('\n');

describe('extractVerdict', () => {
  it('reads a passing run', () => {
    const text = run(
      'Ran the project checks and all three acceptance checks held.',
      '',
      'NOLZU: verdict: PASS',
      '',
      'NOLZU: complete',
    );

    expect(extractVerdict(text)).toEqual({ verdict: 'PASS', reason: null });
  });

  it('reads a failing run and keeps its one line', () => {
    const text = run(
      'The search box filters the list, but an empty search shows nothing.',
      'NOLZU: verdict: FAIL An empty search shows no recipes, and the brief asks for all of them.',
      'NOLZU: complete',
    );

    expect(extractVerdict(text)).toEqual({
      verdict: 'FAIL',
      reason: 'An empty search shows no recipes, and the brief asks for all of them.',
    });
  });

  it('reads a blocked run and keeps what it needs', () => {
    const text = run('NOLZU: verdict: BLOCKED The API service is not reachable on port 3001.', 'NOLZU: complete');

    expect(extractVerdict(text)).toEqual({ verdict: 'BLOCKED', reason: 'The API service is not reachable on port 3001.' });
  });

  // Losing a failure because its sentence was left off would be the worse mistake, so both failing
  // verdicts still count with no reason behind them.
  it('counts a failing verdict with no reason, and says the reason is missing', () => {
    expect(extractVerdict('NOLZU: verdict: FAIL')).toEqual({ verdict: 'FAIL', reason: null });
    expect(extractVerdict('NOLZU: verdict: BLOCKED   ')).toEqual({ verdict: 'BLOCKED', reason: null });
  });

  it('answers nothing for a run that printed no verdict at all', () => {
    const text = run(
      'I read the brief and looked at the diff, then ran out of things I could check.',
      'NOLZU: complete',
    );

    expect(extractVerdict(text)).toBeNull();
  });

  // The word inside a sentence is the case that decides the whole parser. A run that talks about
  // its verdict must not be read as giving one.
  it('counts no verdict word that sits inside a sentence', () => {
    const text = run(
      'The list check was a PASS and the search check was a FAIL.',
      'I will print NOLZU: verdict: PASS when every check holds.',
      'Nothing is decided yet.',
    );

    expect(extractVerdict(text)).toBeNull();
  });

  // The rules ask for the line as the constants spell it. Reading a lower case prefix would let a
  // run that only talks about the format decide the card.
  it('counts no line whose prefix is not spelled as the rules spell it', () => {
    expect(extractVerdict('nolzu: verdict: PASS')).toBeNull();
    expect(extractVerdict('NOLZU: Verdict: PASS')).toBeNull();
  });

  it('counts no word outside the three', () => {
    expect(extractVerdict('NOLZU: verdict: PASSED with one note')).toBeNull();
    expect(extractVerdict('NOLZU: verdict: pass')).toBeNull();
    expect(extractVerdict('NOLZU: verdict:')).toBeNull();
  });

  // A run that echoes its own report prints the line twice. The last one is the one meant for the
  // card, which is what the verdict rules tell the skill.
  it('takes the last verdict line when a run printed more than one', () => {
    const text = run(
      'Here is the report I wrote to the card folder.',
      'NOLZU: verdict: PASS',
      'Then I ran the project checks once more, and one of them failed.',
      'NOLZU: verdict: FAIL The API tests fail on the card branch.',
      'NOLZU: complete',
    );

    expect(extractVerdict(text)).toEqual({ verdict: 'FAIL', reason: 'The API tests fail on the card branch.' });
  });

  it('reads a line the run indented', () => {
    expect(extractVerdict('    NOLZU: verdict: PASS')).toEqual({ verdict: 'PASS', reason: null });
  });
});
