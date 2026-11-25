import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { describe, expect, it } from 'vitest';
import { COACH_NOTE, coachAt, firstRunOf, LOGIN_NOTE, type FirstRunFacts } from './getting-started.ts';

const facts = (over: Partial<FirstRunFacts> = {}): FirstRunFacts => ({ card: false, dragTo: 'Refine', dragged: false, recorded: [], seen: [], canStartAtLogin: true, ...over });
const done = (over: Partial<FirstRunFacts>) => firstRunOf(facts(over)).steps?.filter((step) => step.done).map((step) => step.id) ?? null;

describe('Getting started', () => {
  it('lists the four steps, none done before the first card', () => {
    expect(firstRunOf(facts()).steps).toEqual([
      { id: 'card', label: 'Make the first card', done: false },
      { id: 'drag', label: 'Drag it to Refine', done: false },
      { id: 'summary', label: 'Read what changed', done: false },
      { id: 'push', label: 'Push your first branch', done: false },
    ]);
  });

  // Each step from its own fact, and from nothing else: no step turns done because another did.
  it('turns each step done from its own event', () => {
    expect(done({ card: true })).toEqual(['card']);
    expect(done({ dragged: true })).toEqual(['drag']);
    expect(done({ recorded: ['summary'] })).toEqual(['summary']);
    expect(done({ recorded: ['push'] })).toEqual(['push']);
  });

  it('names the first agent column of the board the first card is on', () => {
    expect(firstRunOf(facts({ card: true, dragTo: 'Research' })).steps?.[1]?.label).toBe('Drag it to Research');
  });

  it('shows no list on a project New project did not make, and none once all four are done', () => {
    expect(firstRunOf(facts({ recorded: null })).steps).toBeNull();
    expect(firstRunOf(facts({ card: true, dragged: true, recorded: ['summary'] })).steps).not.toBeNull();
    expect(firstRunOf(facts({ card: true, dragged: true, recorded: ['push', 'summary'] })).steps).toBeNull();
  });
});

describe('the coach note of the first drag', () => {
  it('shows until Got it, and not once a card was dragged', () => {
    expect(firstRunOf(facts()).coach).toBe(COACH_NOTE);
    expect(firstRunOf(facts({ seen: [COACH_NOTE] })).coach).toBeNull();
    expect(firstRunOf(facts({ dragged: true })).coach).toBeNull();
    // A project New project did not make never dragged either, so it gets the note too.
    expect(firstRunOf(facts({ recorded: null })).coach).toBe(COACH_NOTE);
  });

  const board = (cards = [cardFixture({ key: 'RECI-1', stage: 'inbox' })]) => boardFixture('pull-request', cards);
  const profiles = [{ id: 'claude-code', label: 'Claude Code' }];

  it('sits on the first agent column and names the first card of the column before it', () => {
    expect(coachAt(board(), COACH_NOTE, profiles)).toEqual({ stage: 'refine', label: 'Refine', phase: 'refine', key: 'RECI-1', engine: 'Claude Code' });
    // A profile the Now stream has not named yet reads by its id.
    expect(coachAt(board(), COACH_NOTE, [])?.engine).toBe('claude-code');
  });

  it('shows nowhere when closed, with no card waiting, or where the start is refused', () => {
    expect(coachAt(board(), null, profiles)).toBeNull();
    expect(coachAt(null, COACH_NOTE, profiles)).toBeNull();
    expect(coachAt(board([]), COACH_NOTE, profiles)).toBeNull();
    expect(coachAt(board([cardFixture({ key: 'RECI-1', stage: 'inbox', minimized: true })]), COACH_NOTE, profiles)).toBeNull();
    const refused = board();
    const gone = { ...refused, stages: refused.stages.map((stage) => (stage.id === 'refine' && stage.starts !== null ? { ...stage, starts: { ...stage.starts, modelState: 'gone' as const } } : stage)) };
    expect(coachAt(gone, COACH_NOTE, profiles)).toBeNull();
  });
});

describe('the start-at-login offer', () => {
  // A press is the consent, so this only says whether to ask.
  it('is offered after the first card, until it is answered, and only where Turn on works', () => {
    expect(firstRunOf(facts()).loginOffer).toBeNull();
    expect(firstRunOf(facts({ card: true })).loginOffer).toBe(LOGIN_NOTE);
    expect(firstRunOf(facts({ card: true, seen: [LOGIN_NOTE] })).loginOffer).toBeNull();
    expect(firstRunOf(facts({ card: true, canStartAtLogin: false })).loginOffer).toBeNull();
  });
});
