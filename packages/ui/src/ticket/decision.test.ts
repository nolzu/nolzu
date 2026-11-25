import type { StageView } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import { decisionOf, fixItOf, sendBackOf } from './decision.ts';

const board = boardFixture('pull-request');
const stage = (id: string): StageView => board.stages.find((one) => one.id === id)!;

describe('decisionOf', () => {
  it('starts the next stage from an idle card in Inbox', () => {
    const view = decisionOf(cardFixture({ key: 'APP-1' }), 'Inbox', stage('refine'), null, null);

    expect(view.kind).toBe('start');
    expect(view.go).toEqual({ label: 'Start Refine', stage: stage('refine'), to: 'refine' });
  });

  it('asks a ready card to approve and start the next stage', () => {
    const view = decisionOf(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), 'Plan', stage('implement'), null, null);

    expect(view.go?.label).toBe('Approve and start Implement');
    expect(view.go?.to).toBe('implement');
  });

  // A column with no phase starts nothing, so its button is a plain move and never amber.
  it('offers a plain move to a stage that starts nothing', () => {
    const view = decisionOf(cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'PASS' }), 'QA', stage('review'), null, null);

    expect(view.go).toBeNull();
    expect(view.move).toEqual({ label: 'Move to Review', to: 'review' });
  });

  it('retries a failed card in its own stage, and names the reason', () => {
    const view = decisionOf(cardFixture({ key: 'APP-1', stage: 'plan', state: 'failed', failureReason: 'The engine stopped.' }), 'Plan', stage('implement'), stage('plan'), null);

    expect(view.kind).toBe('retry');
    expect(view.title).toBe('Plan failed');
    expect(view.lead).toBe('The engine stopped.');
    expect(view.go).toEqual({ label: 'Retry Plan', stage: stage('plan'), to: null });
  });

  // A stopped run leaves the card idle in its stage. Start again is the amber button, and the step on
  // stays beside it, plain.
  it('starts a stopped stage again, with the step on beside it', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'implement', state: 'idle', runState: 'stopped' });
    const view = decisionOf(card, 'Implement', stage('qa'), stage('implement'), null);

    expect(view).toMatchObject({ kind: 'retry', title: 'Implement was stopped', lead: 'Nothing runs on this card now.' });
    expect(view.go).toEqual({ label: 'Start Implement again', stage: stage('implement'), to: null });
    expect(view.instead).toEqual({ label: 'Move to QA instead', to: 'qa' });
    // Without the stage from the page, an idle card starts the next stage as before.
    expect(decisionOf(card, 'Implement', stage('qa'), null, null).go?.label).toBe('Start QA');
    // Only an idle card: a ready one goes on to the next stage whatever stage is handed over.
    expect(decisionOf({ ...card, state: 'ready' }, 'Implement', stage('qa'), stage('implement'), null).go?.label).toBe('Approve and start QA');
    // Open diff comments still make Send back the start.
    const back = { label: 'Send back with 2 comments', implement: stage('implement'), count: 2 };
    expect(decisionOf(card, 'Implement', stage('qa'), stage('implement'), null, null, back).kind).toBe('send-back');
  });

  it('offers no start on a running card, and says what the run did last', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'running', runId: 3, runState: 'running' });
    const view = decisionOf(card, 'Plan', stage('implement'), null, { line: 'Reading src/list.ts', quiet: null, since: '2s ago' });

    expect(view).toMatchObject({ kind: 'running', title: 'Plan is running', lead: 'Reading src/list.ts · 2s ago', go: null, move: null });
  });

  it('says a quiet run goes on, and offers no start', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'running', runId: 3, runState: 'running' });
    const view = decisionOf(card, 'Plan', stage('implement'), null, { line: null, quiet: '6m', since: null });

    expect(view).toMatchObject({ kind: 'quiet', title: 'Plan has printed nothing for 6m', go: null });
  });

  it('says why a queued card waits', () => {
    expect(decisionOf(cardFixture({ key: 'APP-1', stage: 'qa', state: 'queued', runState: 'waiting_lane', lane: 'stack' }), 'QA', null, null, null).lead).toBe('It waits for the Stack lane.');
    expect(decisionOf(cardFixture({ key: 'APP-1', stage: 'plan', state: 'queued', runState: 'queued' }), 'Plan', null, null, null).lead).toBe('It starts when a slot is free.');
  });

  // The question is answered on the page, and a move forward would leave it unanswered.
  it('offers no move forward on a card that asks a question', () => {
    const view = decisionOf(cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' }), 'Plan', stage('implement'), null, null);

    expect(view).toMatchObject({ kind: 'asks', title: 'The agent is waiting for you', go: null, move: null });
  });

  // The time the card started to wait, when the page has it.
  it('says when the phase stopped with its question, and leaves the time out when there is none', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' });

    expect(decisionOf(card, 'Plan', stage('implement'), null, null, null, null, '15:02').lead).toBe('Plan stopped at 15:02 with one question. Nothing runs until you answer.');
    expect(decisionOf(card, 'Plan', stage('implement'), null, null).lead).toBe('Plan stopped with one question. Nothing runs until you answer.');
  });

  // With no Fix it to offer, such as a board with no Implement column, no button promises a fix that
  // nothing runs. Review starts nothing.
  // The left column says QA failed and why, so the panel repeats neither.
  it('reads a QA FAIL as failed, with no start and an accept that moves on', () => {
    const view = decisionOf(cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list is empty.' }), 'QA', stage('review'), null, null);

    expect(view).toMatchObject({ kind: 'qa-failed', title: null, lead: null, go: null, move: null });
    expect(view.accept).toEqual({ label: 'Accept anyway, move to Review', to: 'review' });
  });

  // One press is the consent for both runs, so the amber button names both.
  it('offers Fix it on a QA FAIL as the one amber start, naming Implement and QA', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list is empty.' });
    const fix = fixItOf(card, board.stages);
    const view = decisionOf(card, 'QA', stage('review'), null, null, fix);

    expect(view).toMatchObject({ kind: 'qa-failed', title: null, lead: null, move: null });
    expect(view.go).toEqual({ label: 'Fix it: run Implement again with this reason, then QA', stage: stage('implement'), to: null, then: stage('qa') });
    expect(view.accept).toEqual({ label: 'Accept anyway, move to Review', to: 'review' });
  });

  // Send back with comments resumes a run, so it is the one amber button, and the step it stands in
  // for stays as a plain move.
  it('offers Send back with comments as the amber start, and the next step as a plain move instead', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'implement', state: 'ready' });
    const view = decisionOf(card, 'Implement', stage('qa'), null, null, null, sendBackOf(card, board.stages, 2));

    expect(view.kind).toBe('send-back');
    expect(view.go).toEqual({ label: 'Send back to Implement with 2 comments', stage: stage('implement'), to: null, back: true });
    expect(view.instead).toEqual({ label: 'Move to QA instead', to: 'qa' });
    expect(view.move).toBeNull();
  });

  // Fix it and a run in progress come first: a comment never hides them.
  it('keeps Fix it and a running card as they are when comments are open', () => {
    const failed = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL' });
    const running = cardFixture({ key: 'APP-1', stage: 'qa', state: 'running', runId: 3, runState: 'running' });
    const back = sendBackOf(cardFixture({ key: 'APP-1', stage: 'review', state: 'idle' }), board.stages, 1);

    expect(decisionOf(failed, 'QA', stage('review'), null, null, fixItOf(failed, board.stages), back).kind).toBe('qa-failed');
    expect(decisionOf(running, 'QA', stage('review'), null, null, null, back).kind).toBe('running');
  });

  it('offers nothing on a closed card', () => {
    expect(decisionOf(cardFixture({ key: 'APP-1', stage: 'closed' }), 'Closed', null, null, null).kind).toBe('closed');
  });
});

describe('fixItOf', () => {
  const failed = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL' });

  it('names Implement and QA, each with the models of the card over those of the stage', () => {
    const own = { ...stage('implement').starts!, model: 'opus', effort: 'high' as const };
    const fix = fixItOf({ ...failed, starts: { implement: own } }, board.stages);

    expect(fix?.label).toBe('Fix it: run Implement again with this reason, then QA');
    expect(fix?.implement).toEqual({ ...stage('implement'), starts: own });
    expect(fix?.qa).toEqual(stage('qa'));
  });

  it('is there only for a QA FAIL', () => {
    expect(fixItOf({ ...failed, verdict: 'PASS' }, board.stages)).toBeNull();
    expect(fixItOf({ ...failed, verdict: null }, board.stages)).toBeNull();
    // A card that moved back is no longer in QA, whatever its last verdict said.
    expect(fixItOf({ ...failed, stage: 'implement' }, board.stages)).toBeNull();
    expect(fixItOf({ ...failed, state: 'queued' }, board.stages)).toBeNull();
    expect(fixItOf(failed, board.stages.filter((one) => one.id !== 'implement'))).toBeNull();
  });
});

describe('sendBackOf', () => {
  const review = cardFixture({ key: 'APP-1', stage: 'review', state: 'idle' });

  it('names Implement and how many comments go, with the models of the card over those of the stage', () => {
    const own = { ...stage('implement').starts!, model: 'opus', effort: 'high' as const };
    const back = sendBackOf({ ...review, starts: { implement: own } }, board.stages, 1);

    expect(back).toEqual({ label: 'Send back to Implement with 1 comment', implement: { ...stage('implement'), starts: own }, count: 1 });
  });

  it('is there for a ready or idle card in Implement or after it, with an open comment', () => {
    expect(sendBackOf(review, board.stages, 0)).toBeNull();
    expect(sendBackOf({ ...review, state: 'running' }, board.stages, 1)).toBeNull();
    expect(sendBackOf({ ...review, state: 'blocked' }, board.stages, 1)).toBeNull();
    expect(sendBackOf({ ...review, state: 'failed' }, board.stages, 1)).toBeNull();
    expect(sendBackOf({ ...review, stage: 'plan', state: 'ready' }, board.stages, 1)).toBeNull();
    expect(sendBackOf({ ...review, stage: 'closed' }, board.stages, 1)).toBeNull();
    expect(sendBackOf({ ...review, stage: 'implement', state: 'ready' }, board.stages, 1)?.count).toBe(1);
    expect(sendBackOf(review, board.stages.filter((one) => one.id !== 'implement'), 1)).toBeNull();
  });
});
