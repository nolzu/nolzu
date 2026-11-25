import { describe, expect, it } from 'vitest';
import { bannerSteps, learnGates, type SetupFacts, setupSteps } from './setup.ts';

const FRESH: SetupFacts = { marks: {}, learned: false, browser: false, tickets: false };
const states = (facts: SetupFacts) => Object.fromEntries(setupSteps(facts).map((step) => [step.id, step.state]));

describe('the setup steps', () => {
  it('lists the four steps in order, each with its need, and all open on a fresh project', () => {
    expect(setupSteps(FRESH).map((step) => [step.id, step.need, step.state])).toEqual([
      ['learn', 'required', 'open'],
      ['commands', 'recommended', 'open'],
      ['qa', 'recommended', 'open'],
      ['tickets', 'optional', 'open'],
    ]);
  });

  it('counts a step done from its fact or its mark, and "I will write it myself" as done', () => {
    expect(states({ ...FRESH, learned: true, browser: true, tickets: true })).toEqual({ learn: 'done', commands: 'open', qa: 'done', tickets: 'done' });
    expect(states({ ...FRESH, marks: { learn: 'self', commands: 'done' } })).toMatchObject({ learn: 'done', commands: 'done' });
  });

  it('puts a recommended or optional step away, and never the required one', () => {
    expect(states({ ...FRESH, marks: { learn: 'dismissed', qa: 'dismissed', tickets: 'dismissed' } })).toEqual({ learn: 'open', commands: 'open', qa: 'dismissed', tickets: 'dismissed' });
  });
});

describe('the banner', () => {
  it('lists the open required and recommended steps, and no optional one', () => {
    expect(bannerSteps(setupSteps(FRESH)).map((step) => step.id)).toEqual(['learn', 'commands', 'qa']);
    expect(bannerSteps(setupSteps({ ...FRESH, marks: { qa: 'dismissed' } })).map((step) => step.id)).toEqual(['learn', 'commands']);
  });

  // The QA browser stays on the board until it is set up or put away.
  it('keeps the open recommended steps once every required step is done, and goes with the last', () => {
    expect(bannerSteps(setupSteps({ ...FRESH, learned: true })).map((step) => step.id)).toEqual(['commands', 'qa']);
    expect(bannerSteps(setupSteps({ ...FRESH, marks: { learn: 'self', commands: 'done' } })).map((step) => step.id)).toEqual(['qa']);
    expect(bannerSteps(setupSteps({ ...FRESH, browser: true, marks: { learn: 'self', commands: 'done' } }))).toEqual([]);
  });
});

describe('the Learn gate', () => {
  it('holds the first run back while Learn is open, and no later one', () => {
    expect(learnGates(setupSteps(FRESH), false)).toBe(true);
    expect(learnGates(setupSteps(FRESH), true)).toBe(false);
    expect(learnGates(setupSteps({ ...FRESH, marks: { learn: 'self' } }), false)).toBe(false);
    expect(learnGates(setupSteps({ ...FRESH, learned: true }), false)).toBe(false);
  });
});
