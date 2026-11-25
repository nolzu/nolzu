import { describe, expect, it } from 'vitest';
import { fixMessage } from './fix-it.ts';

// What Fix it tells the Implement run: QA's reason, the checks that failed, and the screenshot of
// each failed check, named from the card folder that the session and a fresh prompt both know.
const REPORT = `## 1. Verdict

FAIL

## 2. What QA checked

1. pass: Run the project's tests, they pass
2. fail: Type a word in the search box, only recipes with that word in the title show
   Reason: every recipe stayed in the list
   Expected: only recipes with that word in the title show
   Actual: every recipe stayed in the list
3. not reached: Clear the box, every recipe shows

## 3. What was not checked

Check 3, because check 2 failed.
`;

describe('fixMessage', () => {
  it('carries the reason, the failed check with its reason, expected and actual, and the screenshot of that check', () => {
    const message = fixMessage({ reason: 'Typing a word leaves every recipe in the list', report: REPORT, shots: ['qa/evidence/1-tests.png', 'qa/evidence/2-search-box.png'] });

    expect(message).toContain('QA said: Typing a word leaves every recipe in the list');
    expect(message).toContain(
      '2. Type a word in the search box, only recipes with that word in the title show\n   Reason: every recipe stayed in the list\n   Expected: only recipes with that word in the title show\n   Actual: every recipe stayed in the list',
    );
    expect(message).not.toContain('Run the project');
    // A check QA never reached is not a failure to fix.
    expect(message).not.toContain('Clear the box');
    expect(message).toContain('`qa/evidence/2-search-box.png`');
    expect(message).not.toContain('1-tests.png');
    expect(message).toContain('`qa/report.md`');
  });

  // Implement reads the brief too, so the id of the failed check points it at the acceptance check.
  it('keeps the acceptance check id of a failed check', () => {
    const message = fixMessage({ reason: null, report: REPORT.replace('2. fail: Type', '2. fail: AC1: Type'), shots: [] });

    expect(message).toContain('2. AC1: Type a word in the search box, only recipes with that word in the title show\n   Reason: every recipe stayed in the list');
  });

  // A failed row's evidence can be output QA saved as a file, which the screenshot list leaves out.
  it('carries the evidence line of a failed check', () => {
    const report = REPORT.replace('   Actual: every recipe stayed in the list\n', '   Actual: every recipe stayed in the list\n   How: npm test\n   Evidence: qa/evidence/2-search-test.txt, "12 of 12 rows"\n');
    const message = fixMessage({ reason: null, report, shots: [] });

    expect(message).toContain('   Actual: every recipe stayed in the list\n   Evidence: qa/evidence/2-search-test.txt, "12 of 12 rows"');
  });

  // A report from before the evidence folder keeps its screenshots in qa/, and a fail row with no
  // Expected or Actual line says only its reason.
  it('reads a report and screenshots from before the evidence folder', () => {
    const old = REPORT.replace('   Expected: only recipes with that word in the title show\n   Actual: every recipe stayed in the list\n', '');
    const message = fixMessage({ reason: null, report: old, shots: ['qa/2-search-box.png'] });

    expect(message).toContain('show\n   Reason: every recipe stayed in the list\n\n');
    expect(message).not.toContain('Expected:');
    expect(message).toContain('`qa/2-search-box.png`');
  });

  // A screenshot named after its check, but not by its number, still reaches the run.
  it('names every screenshot when none starts with the number of a failed check', () => {
    const message = fixMessage({ reason: 'The list stays empty', report: REPORT, shots: ['qa/search-box.png', 'qa/evidence/empty-list.png'] });

    expect(message).toContain('`qa/search-box.png`');
    expect(message).toContain('`qa/evidence/empty-list.png`');
  });

  it('says only the reason when QA wrote no report and took no screenshot', () => {
    const message = fixMessage({ reason: 'The list stays empty', report: null, shots: [] });

    expect(message).toContain('QA said: The list stays empty');
    expect(message).not.toContain('checks that failed');
    expect(message).not.toContain('screenshot');
    expect(message).not.toContain('qa/report.md');
  });

  // A section the parser cannot read is still in the report, so the run is pointed at it.
  it('points at the report when its checks drifted from the form', () => {
    const message = fixMessage({ reason: null, report: '## 2. What QA checked\n\n| step | result |\n| --- | --- |\n', shots: [] });

    expect(message).toContain('QA gave no reason.');
    expect(message).not.toContain('checks that failed');
    expect(message).toContain('`qa/report.md`');
  });
});
