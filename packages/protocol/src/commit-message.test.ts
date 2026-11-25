import { expect, it } from 'vitest';
import { SUBJECT_WARN_AT, subjectWarning } from './commit-message.ts';

it('says nothing up to 72 characters, and why past it', () => {
  expect(subjectWarning('x'.repeat(SUBJECT_WARN_AT))).toBeNull();
  expect(subjectWarning(`\n\n${'x'.repeat(73)}\n\nbody`)).toContain('73 characters');
  expect(subjectWarning('x'.repeat(73))).toContain('GitHub cuts commit titles after 72 characters');
});

it('reads only the subject, never the body', () => {
  expect(subjectWarning(`fix(ui): short\n\n${'x'.repeat(200)}`)).toBeNull();
});
