import type { ReviewAnswer } from './knowledge-review.ts';

/**
 * Optimize, the one button on the Knowledge screen that starts a run.
 *
 * It sits beside the open file. The run rewrites that one file, belongs to
 * no card, and takes the knowledge lane, so a wrap-up queued at the same time waits for it.
 *
 * Nothing here is busy state. The button is drawn from the board snapshot the page load read, and
 * this answers the post alone, which is why the sentence it gives back says to open the file again.
 * It says that and not "reload": the answer sits on a form post, and reloading one posts it twice.
 */

// What the Optimize form posts. The loop throws the reason a run cannot start, because a
// maintenance run has no card for the board to carry a failure on.
export interface OptimizePost {
  optimize: (file: string) => boolean;
}

export function answerOptimize(live: OptimizePost, form: FormData): ReviewAnswer {
  const file = form.get('file')?.toString().trim() ?? '';
  if (file === '') return { ok: false, message: 'That form named no knowledge file, so there was nothing to rewrite.' };

  try {
    // False means the job was built and the run row then failed, which leaves its reason on a row
    // no screen shows: the board carries runs by card, and this run has no card. So the sentence
    // says what is true of the folder, which is what the person came here for.
    if (!live.optimize(file)) {
      return { ok: false, message: `The run that would rewrite ${file} did not start, so nothing was written. Try it again.` };
    }
    return { ok: true, message: `A maintenance run is rewriting ${file}. Open the file again to see how it ended.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
