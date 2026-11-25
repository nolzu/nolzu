import { fail } from '@sveltejs/kit';
import { database } from './db.ts';
import { loop } from './loop.ts';
import { answerAssess } from './scout-assess.ts';
import { answerStart, muteScoutFinding, type ScoutMuteAnswer } from './scout-findings.ts';

/**
 * The four writers the Scout screens post to, in one place.
 *
 * The findings list and one finding's own page offer the same buttons on the same finding, so they
 * post to one set of actions. Two copies would let the answer a person reads depend on which screen
 * the button was on.
 */

// The refused answer carries its own field, so a screen can print a refusal where a saved line would
// not read as one. Every answer names the button it came from, so the sentence prints at the foot of
// the panel that holds it.
//
// Not exported: `summary.ts` exports a said() of its own, and two of that name in $lib is an import
// an editor picks wrong.
const said = (answer: ScoutMuteAnswer, did: 'dismiss' | 'unmute' | 'assess' | 'start') =>
  answer.ok ? { did, said: answer.message } : fail(400, { did, problem: answer.message });

// Only the request, because every one of the four reads the posted finding id, and Start one more
// field. A
// route hands its own event in, which carries more than this.
interface Posted {
  request: Request;
}

// Dismiss, Unmute, Assess and Start are the status words these screens write. The rest of the board
// columns arrive with the screen that drags a finding through them.
//
// Assess is the one that starts a run. It answers as soon as the job is queued, and what the run
// found shows on the next load, because the run has no card for a board to carry it on.
//
// Start makes a card and starts nothing. It goes through the loop for its connection and its change
// notice, because a new card is a change the open boards have to hear and no run announces it.
//
// A mute and an unmute tell the loop too, so the finding goes to the hub with its new status.
const toldLoop = (answer: ScoutMuteAnswer): ScoutMuteAnswer => {
  if (answer.ok) loop().changed();
  return answer;
};

export const scoutActions = {
  dismiss: async ({ request }: Posted) => said(toldLoop(muteScoutFinding(database(), await request.formData(), true)), 'dismiss'),
  unmute: async ({ request }: Posted) => said(toldLoop(muteScoutFinding(database(), await request.formData(), false)), 'unmute'),
  assess: async ({ request }: Posted) => said(answerAssess(loop(), await request.formData()), 'assess'),
  start: async ({ request }: Posted) => said(answerStart(loop(), await request.formData()), 'start'),
};
