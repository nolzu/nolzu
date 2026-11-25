import { expect, it } from 'vitest';
import { answerOptimize } from './knowledge-optimize.ts';

// What the Optimize form posts, and what the person reads back. The run itself is proved against a
// real repository in optimize-run.test.ts; this is the post alone.
const post = (fields: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
};

const loop = (optimize: (file: string) => boolean) => ({ optimize });

it('starts the run for the file the form names, and says how to see the end of it', () => {
  const asked: string[] = [];

  const answer = answerOptimize(
    loop((file) => {
      asked.push(file);
      return true;
    }),
    post({ file: 'search.md' }),
  );

  expect(asked).toEqual(['search.md']);
  expect(answer.ok).toBe(true);
  expect(answer.message).toContain('search.md');
  // Never "reload": the answer sits on a form post, and reloading one posts it again, which would
  // start a second run on the same file.
  expect(answer.message).toContain('Open the file again');
  expect(answer.message).not.toContain('Reload');
});

// A hand written post can name anything at all, and a run started on an empty name would rewrite
// nothing and still lock the knowledge lane.
it('starts nothing when the form named no file', () => {
  let started = false;

  const answer = answerOptimize(
    loop(() => {
      started = true;
      return true;
    }),
    post({}),
  );

  expect(started).toBe(false);
  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('named no knowledge file');
});

// The loop throws the reason, because a maintenance run has no card for the board to carry it on.
it('reads back the reason the run could not be built', () => {
  const answer = answerOptimize(
    loop(() => {
      throw new Error('There is no knowledge file "gone.md" in /work/recipes/.nolzu/knowledge, so there is nothing to rewrite.');
    }),
    post({ file: 'gone.md' }),
  );

  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('gone.md');
  expect(answer.message).toContain('nothing to rewrite');
});

// The job was built and the run row still failed. No screen shows a run with no card, so the
// sentence says what is true of the folder instead of naming a screen nobody can open.
it('says the folder is unchanged when the run did not start', () => {
  const answer = answerOptimize(loop(() => false), post({ file: 'search.md' }));

  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('nothing was written');
});
