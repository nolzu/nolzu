import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerAssess, ASSESSMENT_HEADINGS, readAssessment } from './scout-assess.ts';

// The file the assess skill asks for. Prose around the headings, because a run writes an opening line
// and the reader has to walk past it.
const WHOLE = `# Assessment

## The evidence

src/recipes/rating.ts:31 divides the sum of the votes by their count.
The collected line: TypeError: Cannot read properties of undefined.

## The likely cause

The average is worked out before the vote list is checked.

## The proposal

Return no rating for a recipe with no vote. One file, src/recipes/rating.ts.

## The effort

Under an hour, with the test that covers it.

## The risks

The list draws the rating, so an empty rating has to read as empty there.
`;

const without = (heading: string): string => {
  const at = WHOLE.indexOf(`## ${heading}`);
  const next = WHOLE.indexOf('\n## ', at + 1);
  return WHOLE.slice(0, at) + (next === -1 ? '' : WHOLE.slice(next + 1));
};

describe('readAssessment', () => {
  it('reads all five parts of an assessment', () => {
    const read = readAssessment(WHOLE);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.parts.evidence).toContain('src/recipes/rating.ts:31');
    expect(read.parts.cause).toBe('The average is worked out before the vote list is checked.');
    expect(read.parts.proposal).toContain('Return no rating');
    expect(read.parts.effort).toBe('Under an hour, with the test that covers it.');
    expect(read.parts.risks).toContain('empty rating');
  });

  // Half an assessment reads as an answer while the part a person decides on is missing, so the whole
  // file is refused and nothing is kept.
  it.each(ASSESSMENT_HEADINGS)('refuses an assessment with no %s section, and names it', (heading) => {
    const read = readAssessment(without(heading));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain(heading);
    expect(read.problem).toContain('Start the assessment again');
  });

  // A heading with nothing under it answers nothing, so it is refused the same way as a missing one,
  // with a sentence that says which section is empty.
  it('refuses an assessment with an empty section', () => {
    const read = readAssessment(WHOLE.replace('Under an hour, with the test that covers it.', ''));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain('The effort');
    expect(read.problem).toContain('is empty');
  });

  // The cause now carries how sure the run is and what would change the call, as two lines of its own.
  it('keeps the confidence and what would change the call in the cause', () => {
    const read = readAssessment(WHOLE.replace('before the vote list is checked.', 'before the vote list is checked.\nConfidence: high, because nothing checks the count.\nWhat would change it: a list that is never empty.'));

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.parts.cause).toBe('The average is worked out before the vote list is checked.\nConfidence: high, because nothing checks the count.\nWhat would change it: a list that is never empty.');
  });

  // A model that writes `###` where the skill asked for `##` still answered the question. Refusing
  // that would waste a run over one character.
  it('reads the sections whatever heading level they are written at', () => {
    expect(readAssessment(WHOLE.replaceAll('\n## ', '\n#### ')).ok).toBe(true);
  });

  // The skill and the reader are one pair. A heading renamed in one of them and not in the other would
  // make every run's output unreadable, and nothing else in the suite would say so.
  it('reads the same five headings the skill asks the run to write', () => {
    const skill = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'skills', 'skills', 'nolzu-assess', 'SKILL.md'), 'utf8');

    for (const heading of ASSESSMENT_HEADINGS) expect(skill, heading).toContain(`\`## ${heading}\``);
    expect(ASSESSMENT_HEADINGS).toEqual(['The evidence', 'The likely cause', 'The proposal', 'The effort', 'The risks']);
  });
});

describe('answerAssess', () => {
  const post = (id: number | string): FormData => {
    const form = new FormData();
    form.set('id', String(id));
    return form;
  };

  it('says the assessment is running, and that it changes nothing', () => {
    expect(answerAssess({ assess: () => true }, post(7))).toEqual({ ok: true, message: expect.stringContaining('finding 7') });
    expect(answerAssess({ assess: () => true }, post(7)).message).toContain('changes nothing');
  });

  // A post with no id is a broken form, not finding 0, which is what Number() would look up.
  it('refuses a post with no finding id', () => {
    expect(answerAssess({ assess: () => true }, new FormData())).toEqual({ ok: false, message: expect.stringContaining('posted no finding id') });
    expect(answerAssess({ assess: () => true }, post(''))).toEqual({ ok: false, message: expect.stringContaining('posted no finding id') });
  });

  // The loop throws the reason a run cannot start, because a finding has no card for a board to carry
  // a failure on. The sentence it throws is the one the person reads.
  it('prints the reason the run could not start', () => {
    const refused = answerAssess(
      {
        assess: () => {
          throw new Error('This project has no run guard at .claude/hooks/nolzu-phase-guard.mjs.');
        },
      },
      post(7),
    );

    expect(refused).toEqual({ ok: false, message: 'This project has no run guard at .claude/hooks/nolzu-phase-guard.mjs.' });
  });

  // False means the job was built and the run row then failed, and that reason sits on a row no screen
  // shows. So the sentence says what is true: nothing was read.
  it('says nothing was read when the run did not start', () => {
    expect(answerAssess({ assess: () => false }, post(7))).toEqual({ ok: false, message: expect.stringContaining('did not start') });
  });
});
