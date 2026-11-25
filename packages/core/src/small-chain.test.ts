import { BOARD_KINDS, type CardSize } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { advanceTo, boardFor, deliveryBoard, smallChain } from './board.ts';
import { DEFAULTS, readSetting, validateSetting } from './settings.ts';

// The one chain a person may allow in advance: Implement right after Plan, on a
// Delivery card the person ticked (stored as the size small), once they turned it on for that board.
const delivery = deliveryBoard('pull-request');
const small = (stage: string, size: CardSize | null = 'small') => ({ stage, size });

describe('smallChain', () => {
  it('chains nothing until the person turns it on for the board', () => {
    expect(smallChain(delivery, small('plan'), 'plan', [])).toBeUndefined();
    expect(smallChain(delivery, small('plan'), 'plan', ['epics'])).toBeUndefined();
  });

  it('takes a small Delivery card from Plan to Implement once it is on', () => {
    expect(smallChain(delivery, small('plan'), 'plan', ['delivery'])).toBe('implement');
  });

  // A card with no tick stores no size, and a size from before that is not small chains nothing.
  it.each(['medium', 'large', null] as const)('never chains a card sized %s', (size) => {
    expect(smallChain(delivery, small('plan', size), 'plan', ['delivery'])).toBeUndefined();
  });

  // A discussion message on the refine thread runs refine while the card sits on Plan.
  it("chains only after the run of the stage's own phase", () => {
    expect(smallChain(delivery, small('plan'), 'refine', ['delivery'])).toBeUndefined();
  });

  it('chains from no other Delivery stage, so Implement and QA wait as before', () => {
    for (const stage of delivery.stages.filter((one) => one.id !== 'plan')) {
      expect(smallChain(delivery, small(stage.id), stage.phase ?? '', ['delivery']), stage.id).toBeUndefined();
    }
  });

  it.each(BOARD_KINDS.filter((kind) => kind !== 'delivery'))('chains nothing on %s, even with every board turned on', (kind) => {
    const board = boardFor(kind, 'pull-request');
    for (const stage of board.stages) expect(smallChain(board, small(stage.id), stage.phase ?? '', BOARD_KINDS), stage.id).toBeUndefined();
  });

  // One step forward onto an agent stage, so a chain can never pass Review or Pull request.
  it.each([...BOARD_KINDS])('moves a card on %s one step, onto an agent stage, or not at all', (kind) => {
    const board = boardFor(kind, 'pull-request');
    for (const [at, stage] of board.stages.entries()) {
      const to = smallChain(board, small(stage.id), stage.phase ?? '', BOARD_KINDS);
      if (to === undefined) continue;
      expect(to).toBe(board.stages[at + 1]?.id);
      expect(board.stages[at + 1]?.role).toBe('agent');
    }
  });

  // The rows nothing fires stay as they were: the chain is its own rule, not a widened advanceOn.
  it('leaves advanceTo reading no chain from Plan', () => {
    expect(advanceTo(delivery, 'plan', 'complete')).toBeUndefined();
  });
});

// Off for every board until a person turns it on, and a stored row nobody can read falls back to off.
describe('the chain settings', () => {
  it('starts with no board chained, and takes a list of board names', () => {
    expect(DEFAULTS.chainBoards).toEqual([]);
    expect(validateSetting('chainBoards', ['delivery'])).toEqual({ ok: true, value: ['delivery'] });
    expect(validateSetting('chainBoards', ['recipes'])).toEqual({ ok: false, message: 'There is no recipes board.' });
    expect(validateSetting('chainBoards', ['delivery', 'delivery'])).toEqual({ ok: false, message: 'The Delivery board is in the list twice.' });
    expect(validateSetting('chainBoards', 'delivery')).toMatchObject({ ok: false });
    expect(readSetting('chainBoards', '"delivery"')).toEqual({ value: [], fellBack: true });
  });

  it('starts with no Not now mark, and takes a move id', () => {
    expect(DEFAULTS.chainNotNow).toBe(0);
    expect(validateSetting('chainNotNow', 12)).toEqual({ ok: true, value: 12 });
    expect(validateSetting('chainNotNow', -1)).toMatchObject({ ok: false });
    expect(validateSetting('chainNotNow', 1.5)).toMatchObject({ ok: false });
  });
});
