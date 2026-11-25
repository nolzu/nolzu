import { cardStarts, type CardView, type StageView } from '@nolzu/protocol';
import type { Live } from '../board/quiet.ts';

export type DecisionKind = 'start' | 'retry' | 'move' | 'running' | 'quiet' | 'queued' | 'asks' | 'qa-failed' | 'send-back' | 'failed' | 'closed';

// What the decision panel offers one card, read off one snapshot.
export interface Decision {
  kind: DecisionKind;
  // The line in place of a button, for a state where the next step is not a press here.
  title: string | null;
  lead: string | null;
  // The one button that starts a run, amber, with the picker and the estimate under it. `to` is the
  // stage a move goes to, and null for a retry in the card's own stage. `then` is set on Fix it alone:
  // the QA run that starts once the Implement run in `stage` ends ready. `back` is set on Send back with
  // comments alone: Implement goes on with every open diff comment.
  go: { label: string; stage: StageView; to: string | null; then?: StageView; back?: true } | null;
  // A move that starts nothing, so it is a plain button.
  move: { label: string; to: string } | null;
  // A QA FAIL accepted anyway: the move on to a stage that starts nothing.
  accept: { label: string; to: string } | null;
  // The next step that Send back with comments stands in for, offered plain beside it.
  instead?: { label: string; to: string } | null;
  // Where the person answers what the card waits for, drawn after the lead.
  link?: { label: string; href: string };
}

const none = { title: null, lead: null, go: null, move: null, accept: null };

// Fix it after a QA FAIL: Implement goes on with QA's reason, then QA runs again. Both stages carry the
// card's own models over the stage's, as the two runs will use them.
export interface FixIt {
  label: string;
  implement: StageView;
  qa: StageView;
}

/**
 * Fix it on a card whose QA failed, read off one snapshot's stages. One press is the consent for both
 * runs, so the label names both. Null on every other card, and on a board with no
 * Implement column to go back to.
 */
export function fixItOf(card: CardView, stages: readonly StageView[]): FixIt | null {
  if (card.state !== 'ready' || card.verdict !== 'FAIL') return null;
  const qa = stages.find((stage) => stage.id === card.stage);
  const implement = stages.find((stage) => stage.starts?.phase === 'implement');
  if (qa?.starts?.phase !== 'qa' || implement === undefined) return null;
  const own = (stage: StageView): StageView => ({ ...stage, starts: cardStarts(stage, card) });
  return { label: `Fix it: run ${implement.label} again with this reason, then ${qa.label}`, implement: own(implement), qa: own(qa) };
}

// Send back with comments: Implement goes on with every open diff comment of the card. The stage
// carries the card's own models over the stage's, as the run will use them.
export interface SendBack {
  label: string;
  implement: StageView;
  count: number;
}

/**
 * Send back with comments, read off one snapshot's stages and the card's open comment count. The
 * server's rule: a ready or idle card in Implement or after it, short of the last column, with at
 * least one open comment. Null on every other card, and on a board with no Implement column.
 */
export function sendBackOf(card: CardView, stages: readonly StageView[], open: number): SendBack | null {
  // Written so a count the page has not loaded yet offers nothing either.
  if (!(open > 0) || (card.state !== 'ready' && card.state !== 'idle')) return null;
  const from = stages.findIndex((stage) => stage.starts?.phase === 'implement');
  const at = stages.findIndex((stage) => stage.id === card.stage);
  const implement = stages[from];
  if (implement === undefined || at < from || at === stages.length - 1) return null;
  return { label: `Send back to ${implement.label} with ${open} ${open === 1 ? 'comment' : 'comments'}`, implement: { ...implement, starts: cardStarts(implement, card) }, count: open };
}

/**
 * The next decision on a card. `next` is the stage one column on and `retry` the card's own stage,
 * both with the card's own models over the stage's. A start is amber, and only a
 * card that waits on nobody gets one: a run in progress and a question offer none. A QA FAIL offers
 * `fix`, Fix it, when the board has one. Open diff comments (`back`) make Send back with comments the
 * start, with the next step plain beside it. `since` is when a blocked card started to wait, as the
 * page says a time ("15:02"), or null when the page has none.
 */
export function decisionOf(
  card: CardView,
  stage: string,
  next: StageView | null,
  retry: StageView | null,
  live: Live | null,
  fix: FixIt | null = null,
  back: SendBack | null = null,
  since: string | null = null,
): Decision {
  if (card.state === 'queued' && card.runState === 'waiting_review') {
    return {
      ...none,
      kind: 'queued',
      title: 'Waits for Knowledge',
      lead: `${stage} writes knowledge, so it starts by itself once no change waits on Knowledge and no other knowledge run is going. Apply or return what waits there.`,
      link: { label: 'Open Knowledge', href: '/knowledge' },
    };
  }
  if (card.state === 'queued') {
    const lane = card.runState === 'waiting_lane' && card.lane !== null ? card.lane : null;
    return { ...none, kind: 'queued', title: `${stage} waits to start`, lead: lane === null ? 'It starts when a slot is free.' : `It waits for the ${lane.charAt(0).toUpperCase()}${lane.slice(1)} lane.` };
  }
  if (card.state === 'running') {
    if (live !== null && live.quiet !== null) return { ...none, kind: 'quiet', title: `${stage} has printed nothing for ${live.quiet}`, lead: 'The run goes on. Stop it if it looks stuck.' };
    const said = card.runState === 'retrying' ? 'It waits to try again after an API error.' : live?.line == null ? null : live.since === null ? live.line : `${live.line} · ${live.since}`;
    return { ...none, kind: 'running', title: `${stage} is running`, lead: said };
  }
  if (card.state === 'blocked') return { ...none, kind: 'asks', title: 'The agent is waiting for you', lead: `${stage} stopped${since === null ? '' : ` at ${since}`} with one question. Nothing runs until you answer.` };
  if (card.state === 'failed') {
    const failed = { ...none, title: `${stage} failed`, lead: card.failureReason };
    return retry === null ? { ...failed, kind: 'failed' } : { ...failed, kind: 'retry', go: { label: `Retry ${retry.label}`, stage: retry, to: null } };
  }
  if (card.state === 'ready' && card.verdict === 'FAIL') {
    const accept = next !== null && next.starts === null ? { label: `Accept anyway, move to ${next.label}`, to: next.id } : null;
    const go = fix === null ? null : { label: fix.label, stage: fix.implement, to: null, then: fix.qa };
    // The left column says QA failed and why, so the panel opens on what to do.
    return { ...none, kind: 'qa-failed', go, accept };
  }
  if (back !== null) {
    return { ...none, kind: 'send-back', go: { label: back.label, stage: back.implement, to: null, back: true }, instead: next === null ? null : { label: `Move to ${next.label} instead`, to: next.id } };
  }
  // A stopped run leaves the card idle in its stage, and the page hands over the stage only then. The
  // step on stays beside it, plain as Send back's is, since a person may have stopped a run that was done.
  if (card.state === 'idle' && retry !== null) {
    return {
      ...none,
      kind: 'retry',
      title: `${stage} was stopped`,
      lead: 'Nothing runs on this card now.',
      go: { label: `Start ${retry.label} again`, stage: retry, to: null },
      instead: next === null ? null : { label: `Move to ${next.label} instead`, to: next.id },
    };
  }
  if (next === null) return { ...none, kind: 'closed' };
  if (next.starts === null) return { ...none, kind: 'move', move: { label: `Move to ${next.label}`, to: next.id } };
  return { ...none, kind: 'start', go: { label: card.state === 'ready' ? `Approve and start ${next.label}` : `Start ${next.label}`, stage: next, to: next.id } };
}
