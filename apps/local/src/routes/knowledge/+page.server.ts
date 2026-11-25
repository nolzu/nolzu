import { fail } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { answerLearnPost, learnAsking, learnReposOffer, startLearnPost } from '$lib/knowledge-learn.ts';
import { answerOptimize } from '$lib/knowledge-optimize.ts';
import { knowledgeLane, knowledgePage } from '$lib/knowledge-page.ts';
import { answerRevert } from '$lib/knowledge-revert.ts';
import { answerApprove, answerApproveAll, answerReturn, readHeldNow, type ReviewAnswer } from '$lib/knowledge-review.ts';
import { loop } from '$lib/loop.ts';
import { knowledgeFor, postKnowledge } from '$lib/settings-page.ts';
import { startLearnRepos } from '$lib/setup.ts';
import type { Actions, PageServerLoad } from './$types';

// The file to open travels in the query, so picking one is a plain request. The busy state comes from the board snapshot, which is the only place it may come from.
// A change that waits is read against its kept copy in the data folder, so the person sees what
// Apply would write. The view is not awaited: the folder's dates and each change's patch come from
// git, so SvelteKit streams it and the page draws a skeleton until it lands. That needs the page's
// script, as the card facts do.
export const load: PageServerLoad = async ({ url }) => {
  const live = loop();
  return {
    knowledge: knowledgePage(database(), {
      file: url.searchParams.get('file'),
      busy: knowledgeLane(live.snapshot()),
      held: (runId) => readHeldNow(database(), live.dataDir, runId),
    }),
    review: knowledgeFor(database()).review,
    // The question Learn this project waits on, which belongs to no card, so it is answered here.
    learn: ((asked) => (asked === null ? null : { question: asked.question, options: asked.options }))(learnAsking(database())),
    // Learn your repositories: the repositories, which ones have only their first lines or a Learn run
    // going, and what each run starts on.
    repos: learnReposOffer(database(), live.models(), undefined, live.scheduler.queue()),
  };
};

// The message is what the screen shows, refused or done.
const said = (answer: ReviewAnswer) => (answer.ok ? answer : fail(400, answer));

// An answer can be the last change a card's wrap-up waited for, and that wrap-up starts now.
const answered = (answer: ReviewAnswer) => {
  loop().reviewAnswered();
  return said(answer);
};

// Approve, Return and Revert are direct git work and not runs, so they answer the post itself. The
// rules live in the review and revert modules, which the loop hands the data directory and the
// board snapshot. Optimize is the one that starts a run: it answers as soon as the job is queued,
// and what the run does shows on the next load. Review is the switch at the foot of the screen, the
// same setting Settings, Runs writes.
export const actions: Actions = {
  approve: async ({ request }) => answered(await answerApprove(database(), loop(), await request.formData())),
  approveAll: async ({ request }) => answered(await answerApproveAll(database(), loop(), await request.formData())),
  return: async ({ request }) => answered(answerReturn(database(), loop(), await request.formData())),
  revert: async ({ request }) => said(await answerRevert(database(), loop(), await request.formData())),
  optimize: async ({ request }) => said(answerOptimize(loop(), await request.formData())),
  // Learn this project starts a run, and its answer resumes one, so both answer once the job is queued.
  learn: async ({ request }) => said(startLearnPost(loop(), await request.formData())),
  answer: async ({ request }) => said(answerLearnPost(loop(), await request.formData())),
  // Learn your repositories queues one run per ticked repository, and answers once they are queued. A
  // start does the step of Set up the project, so the banner goes and the first run is not held back.
  learnRepos: async ({ request }) => said(startLearnRepos(loop(), await request.formData())),
  review: async ({ request }) => {
    const answer = postKnowledge(database(), await request.formData());
    return said({ ok: answer.ok, message: answer.message ?? 'Saved. The next knowledge run follows it.' });
  },
};
