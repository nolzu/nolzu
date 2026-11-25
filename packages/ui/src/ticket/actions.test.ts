import type { CardState } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { boardFixture } from '../board/fixture.ts';
import { moveView, runOnView, runView, settle } from './actions.ts';

const stages = boardFixture('pull-request').stages;
const stage = (id: string) => stages.find((found) => found.id === id) ?? null;
const card = (at: string, state: CardState = 'idle') => ({ key: 'APP-1', stage: at, state });

describe('settle', () => {
  it('keeps the click while the board still shows the card as it was', () => {
    expect(settle(card('inbox'), card('inbox'))).toEqual(card('inbox'));
  });

  it.each([
    ['the run is queued', card('refine', 'queued')],
    ['the run is going', card('refine', 'running')],
    ['the card moved and nothing started', card('refine', 'idle')],
    ['only the state changed', card('inbox', 'failed')],
  ])('lets the click go once %s', (_, now) => {
    expect(settle(card('inbox'), now)).toBeNull();
  });

  // Two cards in the same stage and state look alike without the key. A click on one would then
  // hold the button of the other for as long as it stays there.
  it('lets the click go when the page shows another card', () => {
    expect(settle(card('inbox'), { ...card('inbox'), key: 'APP-2' })).toBeNull();
  });

  it('has nothing to keep when nothing was clicked', () => {
    expect(settle(null, card('inbox'))).toBeNull();
  });
});

describe('moveView', () => {
  it('reads Move forward and carries the label when the move starts a run', () => {
    const view = moveView(card('inbox'), stage('refine'), 'Starts: /refine · haiku · low', null);

    expect(view).toEqual({ text: 'Move forward', starts: 'Starts: /refine · haiku · low', busy: false, disabled: false, why: null });
  });

  // No label means no run, so the button says where the card goes instead. The label is the
  // stage's own, because lower case would turn QA into a word nobody writes.
  it.each([
    ['review', 'pr-watch', 'Move to Pull request'],
    ['implement', 'qa', 'Move to QA'],
  ])('names the stage when a move from %s to %s starts nothing', (from, to, text) => {
    expect(moveView(card(from), stage(to), undefined, null)?.text).toBe(text);
  });

  it('is no button at all for a card in the last stage', () => {
    expect(moveView(card('closed'), null, undefined, null)).toBeNull();
  });

  // The request can come back long before the board hears of the run. Nothing here takes the
  // answer to the request, so nothing but the snapshot can end the wait.
  it('stays busy after the click while the board still says idle', () => {
    const view = moveView(card('inbox'), stage('refine'), 'Starts: /refine · haiku · low', card('inbox'));

    expect(view?.busy).toBe(true);
    expect(view?.disabled).toBe(true);
    // The card is not queued yet, so the run gives no reason. Without this one the button would
    // go quiet and say nothing until the board answered.
    expect(view?.why).toBe('Sent. Waiting for the board to show the move.');
  });

  it.each<CardState>(['queued', 'running'])('is busy while the card is %s, clicked or not, and says why', (state) => {
    const view = moveView(card('refine', state), stage('plan'), 'Starts: /plan · sonnet · medium', null);

    expect(view?.busy).toBe(true);
    expect(view?.disabled).toBe(true);
    expect(view?.why).toBe(`APP-1 is ${state}. It cannot move until its run ends.`);
  });

  it.each<CardState>(['ready', 'blocked', 'failed', 'idle'])('is free again once the run left the card %s', (state) => {
    const view = moveView(card('refine', state), stage('plan'), 'Starts: /plan · sonnet · medium', card('inbox'));

    expect(view?.busy).toBe(false);
    expect(view?.disabled).toBe(false);
  });

  // The board refuses this drop, and the button sends the same move.
  it('is disabled and not busy when the model is gone, and the label says what to fix', () => {
    const plan = stage('plan');
    const gone = plan === null || plan.starts === null ? null : { ...plan, starts: { ...plan.starts, engine: 'claude-code', modelState: 'gone' as const } };
    const view = moveView(card('refine'), gone, 'sonnet is gone. Pick another model in the card settings, or in Settings, Models.', null);

    expect(view?.busy).toBe(false);
    expect(view?.disabled).toBe(true);
    expect(view?.starts).toBe('sonnet is gone. Pick another model in the card settings, or in Settings, Models.');
    expect(view?.why).toBeNull();
  });

  // The same rule for a row whose vendor cannot run the phase. The board refuses that drop, so the
  // button beside it must not send the move either.
  it('is disabled when the vendor of the row cannot run the phase, and the label says why', () => {
    const said = 'The Plan phase may not change the project, and Cursor has no mode that holds a run to reading. Run this phase on a Claude Code profile.';
    const plan = stage('plan');
    const refused = plan === null || plan.starts === null ? null : { ...plan, starts: { ...plan.starts, engine: 'cursor#work', modelState: 'vendor' as const, refusal: said } };
    const view = moveView(card('refine'), refused, said, null);

    expect(view?.busy).toBe(false);
    expect(view?.disabled).toBe(true);
    expect(view?.starts).toBe(said);
  });
});

describe('runView', () => {
  const running = (state: CardState, runId: number | null = 7) => ({ ...card('plan', state), runId });

  it('offers Retry on a failed card', () => {
    expect(runView(running('failed'), null)).toMatchObject({ kind: 'retry', text: 'Retry', busy: false });
  });

  it.each(['queued', 'running'] as const)('offers Stop on a %s card, for its run', (state) => {
    expect(runView(running(state), null)).toMatchObject({ kind: 'stop', text: 'Stop', runId: 7, busy: false });
  });

  it.each(['idle', 'ready', 'blocked'] as const)('offers neither on a %s card', (state) => {
    expect(runView(running(state), null)).toBeNull();
  });

  // The snapshot names the run. Without it there is nothing a stop could be sent for.
  it('offers no Stop while the board has not named the run yet', () => {
    expect(runView(running('queued', null), null)).toBeNull();
  });

  it('stays busy after the press until the board shows the card in another state', () => {
    const pressed = running('failed');

    expect(runView(running('failed'), pressed)?.busy).toBe(true);
    expect(runView(running('queued'), pressed)).toMatchObject({ kind: 'stop', busy: false });
  });
});

describe('runOnView', () => {
  const offer = { profiles: [{ id: 'codex#work', label: 'Codex work' }], note: null };

  it('offers the other profiles on a failed card, and says the run is fresh', () => {
    const view = runOnView(card('implement', 'failed'), offer, null);

    expect(view?.profiles).toEqual([{ id: 'codex#work', label: 'Codex work' }]);
    expect(view?.fresh).toBe('A fresh run, because a session belongs to one profile. The checkout is not touched, so it goes on from the plan, the progress file and the changes already there.');
    expect(view?.note).toBeNull();
  });

  // Every other state has its own run to wait for or its own result to read. Only a card that
  // stopped has something to move to another login.
  it.each(['idle', 'queued', 'running', 'ready', 'blocked'] as const)('offers nothing while the card is %s', (state) => {
    expect(runOnView(card('implement', state), offer, null)).toBeNull();
  });

  // The named ceiling: every read-only phase is refused on Codex and on Cursor, so a card whose
  // only other login is one of those gets the reason where the buttons would be.
  it('says why there is nothing to offer, in place of the buttons', () => {
    const none = { profiles: [], note: 'The plan phase may not change the project, and Cursor has no mode that holds a run to reading.' };

    const view = runOnView(card('plan', 'failed'), none, null);

    expect(view?.profiles).toEqual([]);
    expect(view?.note).toBe(none.note);
    expect(view?.fresh).toBeNull();
  });

  it('holds the buttons from the press until the board shows the card in another state', () => {
    expect(runOnView(card('implement', 'failed'), offer, card('implement', 'failed'))?.busy).toBe(true);
    expect(runOnView(card('implement', 'failed'), offer, card('implement', 'idle'))?.busy).toBe(false);
  });

  it('offers nothing when the page read no offer', () => {
    expect(runOnView(card('implement', 'failed'), null, null)).toBeNull();
  });
});
