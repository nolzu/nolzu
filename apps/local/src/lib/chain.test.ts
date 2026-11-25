import { describe, expect, it } from 'vitest';
import { CHAIN_SUGGEST_AFTER, planDecisions, type PlanMove, suggestAfter, suggestionText } from './chain.ts';

// The suggestion reads stored events only: the card moves into and out of Plan, and the start time of
// each plan run. A plan the person sent back, answered, wrote to or retried is a changed plan.
const CHAIN = { from: 'plan', to: 'implement' };

let id = 0;
let minute = 0;
const at = () => new Date(Date.UTC(2026, 9, 14, 9, minute++)).toISOString();

interface Fixture {
  moves: PlanMove[];
  runs: { key: string; at: string | null }[];
}

const empty = (): Fixture => ({ moves: [], runs: [] });

function move(fixture: Fixture, key: string, from: string, to: string, who = 'you'): void {
  // A forward move into Plan starts the plan phase, as moveCard records it. A move back starts nothing.
  const startedPhase = to === 'plan' && from !== 'implement' ? 'plan' : to === 'implement' ? 'implement' : null;
  fixture.moves.push({ id: ++id, key, from, to, who, startedPhase, at: at() });
}

const run = (fixture: Fixture, key: string) => fixture.runs.push({ key, at: at() });

// Into Plan, one plan run, then the person's own move out of Plan.
function round(fixture: Fixture, key: string, out = 'implement', runs = 1, who = 'you'): void {
  move(fixture, key, 'refine', 'plan');
  for (let n = 0; n < runs; n++) run(fixture, key);
  move(fixture, key, 'plan', out, who);
}

function approvals(fixture: Fixture, count: number, prefix = 'APP'): void {
  for (let n = 0; n < count; n++) round(fixture, `${prefix}-${id + 1}`);
}

const decided = (fixture: Fixture) => planDecisions(fixture.moves, fixture.runs, CHAIN);

describe('planDecisions', () => {
  it('counts a plan approved after one run with no change', () => {
    const fixture = empty();
    round(fixture, 'APP-1');

    // Named by the move out of Plan, so decisions sort by when they were made.
    expect(decided(fixture)).toEqual([{ id: fixture.moves[1]!.id, unchanged: true }]);
  });

  it('counts a sent-back plan as changed', () => {
    const fixture = empty();
    round(fixture, 'APP-1', 'refine');

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([false]);
  });

  // An answer, a discussion message and a retry each start a second plan run in the same round.
  it('counts a plan that ran twice before the approval as changed', () => {
    const fixture = empty();
    round(fixture, 'APP-1', 'implement', 2);

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([false]);
  });

  // The second round is a new plan, approved as it came.
  it('reads each round of one card on its own', () => {
    const fixture = empty();
    round(fixture, 'APP-1', 'refine');
    round(fixture, 'APP-1');

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([false, true]);
  });

  it('reads no decision from a chain move, which no person made', () => {
    const fixture = empty();
    round(fixture, 'APP-1', 'implement', 1, 'auto');

    expect(decided(fixture)).toEqual([]);
  });

  // Moved back from Implement, Plan holds the plan approved before, and no new one.
  it('reads no decision from a card moved back into Plan and on again', () => {
    const fixture = empty();
    round(fixture, 'APP-1');
    move(fixture, 'APP-1', 'implement', 'plan');
    move(fixture, 'APP-1', 'plan', 'implement');

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([true]);
  });

  // A message on the plan thread after the approval runs plan while the card is on Implement.
  it('leaves out a plan run outside the round', () => {
    const fixture = empty();
    round(fixture, 'APP-1');
    run(fixture, 'APP-1');

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([true]);
  });

  it('keeps the rounds of cards that interleave apart', () => {
    const fixture = empty();
    move(fixture, 'APP-1', 'refine', 'plan');
    move(fixture, 'APP-2', 'refine', 'plan');
    run(fixture, 'APP-1');
    run(fixture, 'APP-2');
    run(fixture, 'APP-2');
    move(fixture, 'APP-2', 'plan', 'implement');
    move(fixture, 'APP-1', 'plan', 'implement');

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([false, true]);
  });

  // A run still in the queue has no start time, and its card cannot have left Plan.
  it('ignores a run with no time', () => {
    const fixture = empty();
    move(fixture, 'APP-1', 'refine', 'plan');
    run(fixture, 'APP-1');
    fixture.runs.push({ key: 'APP-1', at: null });
    move(fixture, 'APP-1', 'plan', 'implement');

    expect(decided(fixture).map((one) => one.unchanged)).toEqual([true]);
  });
});

describe('suggestAfter', () => {
  it(`suggests the chain after ${CHAIN_SUGGEST_AFTER} unchanged approvals in a row, with the real count`, () => {
    const fixture = empty();
    approvals(fixture, 9);

    expect(suggestAfter(decided(fixture), 0)).toBe(9);
    expect(suggestionText(9)).toBe('You approved 9 of the last 9 plans without a change. Let Implement start right after Plan on the cards you tick?');
  });

  it('suggests nothing below the threshold', () => {
    const fixture = empty();
    approvals(fixture, CHAIN_SUGGEST_AFTER - 1);

    expect(suggestAfter(decided(fixture), 0)).toBeNull();
  });

  it('starts counting again after a changed plan', () => {
    const fixture = empty();
    approvals(fixture, 8);
    round(fixture, 'APP-90', 'refine');
    approvals(fixture, CHAIN_SUGGEST_AFTER - 1);

    expect(suggestAfter(decided(fixture), 0)).toBeNull();

    approvals(fixture, 1);
    expect(suggestAfter(decided(fixture), 0)).toBe(CHAIN_SUGGEST_AFTER);
  });

  it('counts an answered plan as a break, not an approval', () => {
    const fixture = empty();
    approvals(fixture, 6);
    round(fixture, 'APP-90', 'implement', 2);

    expect(suggestAfter(decided(fixture), 0)).toBeNull();
  });

  // Not now marks the newest move. The card comes back once enough plans after it were approved as
  // they came, and then it says the whole run of them.
  it('hides after Not now until enough new plans were approved with no change', () => {
    const fixture = empty();
    approvals(fixture, 7);
    const mark = fixture.moves.at(-1)!.id;

    expect(suggestAfter(decided(fixture), mark)).toBeNull();
    approvals(fixture, CHAIN_SUGGEST_AFTER - 1);
    expect(suggestAfter(decided(fixture), mark)).toBeNull();
    approvals(fixture, 1);
    expect(suggestAfter(decided(fixture), mark)).toBe(7 + CHAIN_SUGGEST_AFTER);
  });
});
