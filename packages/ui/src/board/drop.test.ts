import { ranOn, type StageView } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { chainTarget, dropLabel, dropOutcome, dropTarget, goneSentence, keyStart, nearLimits, profileName, refuseDrop, refusalFromServer, startsCommand, usageLine } from './drop.ts';
import { startDrag } from './drag.ts';
import { stageFixture } from './fixture.ts';

const agentStage = (over: Partial<StageView> = {}): StageView =>
  stageFixture({ id: 'plan', label: 'Plan', role: 'agent', ...over });

it('says what a forward drop starts, with the model and the effort it resolved', () => {
  const label = dropLabel(agentStage({ starts: { phase: 'plan', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } }), true);

  expect(label).toBe('Starts: /plan · opus · high');
});

it('says a stage starts nothing rather than promising a run', () => {
  // A stage with no phase of its own starts nothing, and the column has to say so.
  expect(dropLabel(agentStage({ id: 'qa', label: 'QA', starts: null }), true)).toBe('Move here, starts nothing');
});

it('names the model that is gone, and where to fix it', () => {
  const label = dropLabel(agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), true);

  expect(label).toContain('sonnet');
  expect(label).toContain('Settings, Models');
  // The drop must not read as if it would start a run.
  expect(label).not.toContain('Starts:');
});

it('reads the same for every effort the product offers', () => {
  for (const effort of ['low', 'medium', 'high'] as const) {
    expect(dropLabel(agentStage({ starts: { phase: 'refine', model: 'haiku', effort, engine: 'claude-code', modelState: 'ok', refusal: null } }), true)).toBe(
      `Starts: /refine · haiku · ${effort}`,
    );
  }
});

it('promises no run on a move back, although the column starts a phase going forward', () => {
  const plan = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null } });

  // A move back returns the card for more work and starts no agent, so the old label was a promise
  // the board could not keep.
  expect(dropLabel(plan, false)).toBe('Move here, starts nothing');
});

it('says nothing about a gone model on a move back, because a move back needs none', () => {
  const plan = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } });

  expect(dropLabel(plan, false)).toBe('Move here, starts nothing');
});

// The refusal and the label read the same field, so a column cannot say a model is gone while the
// drop still sends the move.
it('refuses a forward drop onto a model that is gone, and names the fix', () => {
  const refusal = refuseDrop(agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), 'forward');

  // The whole sentence, because a message of just "sonnet" satisfies a contains check.
  expect(refusal?.message).toBe('Plan uses sonnet, which Claude Code no longer offers.');
  expect(refusal?.fix).toContain('Settings, Models');
  // The fix without its place, for a toast whose link names the one place.
  expect(refusal?.act).toBe('Pick another');
  // A model is set in mono inside the sentence of a refused drop.
  expect(refusal?.code).toBe('sonnet');
});

it('refuses nothing when the model the stage would start is there', () => {
  expect(refuseDrop(agentStage({ starts: { phase: 'plan', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } }), 'forward')).toBe(null);
});

it('refuses nothing on a move back, because a move back starts no run', () => {
  expect(refuseDrop(agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), 'back')).toBe(null);
});

it('refuses nothing for a stage that starts no phase at all', () => {
  expect(refuseDrop(agentStage({ id: 'qa', label: 'QA', starts: null }), 'forward')).toBe(null);
});

// One decision for the whole drop, so a column cannot show a refusal and send the move anyway.
it('turns a drop onto a gone model into a refusal and no move', () => {
  const outcome = dropOutcome(startDrag('APP-1'), agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), () => 'forward');

  expect(outcome?.kind).toBe('refused');
  if (outcome?.kind !== 'refused') return;
  expect(outcome.refusal.message).toContain('uses sonnet, which Claude Code no longer offers');
});

it('turns an allowed drop into the move to send', () => {
  const outcome = dropOutcome(startDrag('APP-1'), agentStage(), () => 'forward');

  expect(outcome).toEqual({ kind: 'move', key: 'APP-1', stage: 'plan' });
});

it('turns a drop the column refuses into nothing at all', () => {
  expect(dropOutcome(startDrag('APP-1'), agentStage(), () => false)).toBe(null);
});

it('turns a drop with no card being dragged into nothing at all', () => {
  // The stage's model is gone, so the missing drag is the only thing that can stop the refusal.
  // With the fixture's default stage there is nothing to refuse and the guard is never reached.
  const gone = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } });

  expect(dropOutcome(null, gone, () => 'forward')).toBe(null);
});

it('sends the move on a drop back onto a stage whose model is gone, because nothing starts', () => {
  const outcome = dropOutcome(startDrag('APP-1'), agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), () => 'back');

  expect(outcome).toEqual({ kind: 'move', key: 'APP-1', stage: 'plan' });
});

// The server writes the whole refusal, fix and all, so the board adds no second line. One invented
// here would tell a person to look at the card again when what they have to do is start a run.
it('carries a refusal the server sent back, and adds nothing to it', () => {
  const refusal = refusalFromServer('APP-1 has no checkout. A run makes one. A closed card has none once its checkouts are removed.');

  expect(refusal.message).toBe('APP-1 has no checkout. A run makes one. A closed card has none once its checkouts are removed.');
  expect(refusal.fix).toBeNull();
});

it('says something when the server refused and said nothing', () => {
  // A refusal with no sentence is still a card that did not move, so it cannot render as blank.
  expect(refusalFromServer('   ').message).toBe('The move was refused.');
  expect(refusalFromServer('').fix).toBeNull();
});

// The box the column draws while a card is over it. dropLabel reads the same answer, so the ticket
// page and the board cannot say two different things about one move.
it('draws a starts box with the command, when a forward drop starts a run', () => {
  const plan = agentStage({ starts: { phase: 'plan', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } });

  expect(dropTarget(plan, true)).toEqual({ kind: 'starts', command: 'Claude Code · opus · high' });
});

// The figure rides on the descriptor, and the box and the confirm print what dropTarget made of it.
it('carries the estimate line and where its figure came from, when the start has one', () => {
  const starts = { phase: 'implement', model: 'sonnet', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } as const;
  const measured = agentStage({ starts: { ...starts, estimate: { costUsd: 0.4, lowMs: 6 * 60_000, highMs: 10 * 60_000, from: 'history', runs: 8 } } });
  const tokensOnly = agentStage({ starts: { ...starts, estimate: { costUsd: null, lowMs: 6 * 60_000, highMs: 10 * 60_000, from: 'history', runs: 8 } } });

  expect(dropTarget(measured, true)).toEqual({
    kind: 'starts',
    command: 'Claude Code · sonnet · high',
    estimate: { text: 'about $0.40 · 6 to 10 min', from: 'from 8 runs in this project' },
  });
  expect(dropTarget(tokensOnly, true)).toMatchObject({ estimate: { text: '6 to 10 min' } });
  expect(dropTarget(agentStage({ starts }), true)).not.toHaveProperty('estimate.text');
  // The ticket button keeps its words. The estimate there comes with the decision panel.
  expect(dropLabel(measured, true)).toBe('Starts: /implement · sonnet · high');
});

it('draws a starts-nothing box on a move back and on a stage with no phase', () => {
  const plan = agentStage({ starts: { phase: 'plan', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } });

  expect(dropTarget(plan, false)).toEqual({ kind: 'nothing', says: 'Move here, starts nothing' });
  expect(dropTarget(agentStage({ id: 'qa', label: 'QA', starts: null }), true)).toEqual({ kind: 'nothing', says: 'Move here, starts nothing' });
});

it('draws a refused box with the reason when the model is gone', () => {
  const plan = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } });

  expect(dropTarget(plan, true)).toEqual({ kind: 'refused', reason: 'sonnet is gone. Pick another model in the card settings, or in Settings, Models.' });
});

/**
 * A stage whose row runs on a vendor that cannot run its phase.
 *
 * The sentence comes with the snapshot, because the rule lives in core and this package reads only
 * the protocol. It is the sentence the spawn would have thrown after the click, so the drop target
 * and the run say one thing.
 */
const REFUSED = 'The plan phase may not change the project, and Cursor has no mode that holds a run to reading: a run in plan mode can move itself out of it and write. Run this phase on a Claude Code profile.';

it('refuses the drop on a stage whose vendor cannot run its phase, in the words the run would use', () => {
  const stage = agentStage({ starts: { phase: 'plan', model: 'composer-2.5', effort: 'medium', engine: 'cursor#work', modelState: 'vendor', refusal: REFUSED } });

  expect(dropTarget(stage, true)).toEqual({ kind: 'refused', reason: REFUSED });
  expect(dropLabel(stage, true)).toBe(REFUSED);
  expect(refuseDrop(stage, 'forward')).toEqual({ message: REFUSED, fix: null });
});

// The board must not send a move it would then refuse, so the drop answers with the refusal and no
// move at all.
it('sends no move when the vendor cannot run the phase', () => {
  const stage = agentStage({ starts: { phase: 'plan', model: 'composer-2.5', effort: 'medium', engine: 'cursor#work', modelState: 'vendor', refusal: REFUSED } });
  const drag = startDrag('APP-1');

  expect(dropOutcome(drag, stage, () => 'forward')).toEqual({ kind: 'refused', refusal: { message: REFUSED, fix: null, stage: 'Plan' } });
});

// A move back starts nothing, so there is nothing to refuse and the card can always come back.
it('lets a card move back off a stage whose vendor cannot run its phase', () => {
  const stage = agentStage({ starts: { phase: 'plan', model: 'composer-2.5', effort: 'medium', engine: 'cursor#work', modelState: 'vendor', refusal: REFUSED } });

  expect(refuseDrop(stage, 'back')).toBeNull();
  expect(dropTarget(stage, false)).toEqual({ kind: 'nothing', says: 'Move here, starts nothing' });
});

// The other path of the same rule: a row whose vendor can run the phase draws the command, not a
// refusal.
it('starts the run when the vendor can run the phase', () => {
  const stage = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null } });

  expect(dropTarget(stage, true)).toEqual({ kind: 'starts', command: 'Claude Code · sonnet · medium' });
});

// The two readers have to answer one way. `dropTarget` draws the box and `refuseDrop` decides
// whether the move is sent, so a snapshot that ever paired `ok` with a refusal would otherwise draw
// a refusal and send the move, which is the contradiction this rule exists to remove.
it('refuses in both readers when the state and the sentence disagree', () => {
  const stage = agentStage({ starts: { phase: 'plan', model: 'composer-2.5', effort: 'medium', engine: 'cursor#work', modelState: 'ok', refusal: REFUSED } });

  expect(dropTarget(stage, true)).toEqual({ kind: 'refused', reason: REFUSED });
  expect(refuseDrop(stage, 'forward')).toEqual({ message: REFUSED, fix: null });
  expect(dropOutcome(startDrag('APP-1'), stage, () => 'forward')).toEqual({ kind: 'refused', refusal: { message: REFUSED, fix: null, stage: 'Plan' } });
});

// A key that starts a run asks first, as a drop shows its box first. It shows the drop's own refusal,
// and a stage that starts nothing has nothing to ask about.
describe('keyStart', () => {
  const starts = (modelState: 'ok' | 'gone' | 'no-profile' | 'vendor', refusal: string | null = null) =>
    agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState, refusal } });

  it('asks before a run that would start', () => {
    expect(keyStart(starts('ok'))).toEqual({ kind: 'ask' });
  });

  it.each([
    ['a gone model', starts('gone')],
    ['a login this machine has not got', starts('no-profile')],
    ['a vendor that cannot run the phase', starts('vendor', REFUSED)],
  ])('gives the drop refusal for %s', (_, stage) => {
    expect(keyStart(stage)).toEqual({ kind: 'refused', refusal: refuseDrop(stage, 'forward') });
  });

  it('sends with no question when the stage starts nothing', () => {
    expect(keyStart(agentStage({ starts: null }))).toEqual({ kind: 'send' });
  });
});

// The box names the engine, the model and the bare effort ("Claude Code · sonnet · high"), which
// fits one line from a column of about 240px, where "/implement · sonnet · medium effort" wrapped.
it('names the engine of the row, then the model and the effort where the id does not carry it', () => {
  const cursor = agentStage({ starts: { phase: 'implement', model: 'composer-2.5', effort: 'medium', engine: 'cursor#work', modelState: 'ok', refusal: null } });

  expect(dropTarget(cursor, true)).toMatchObject({ command: 'Cursor · composer-2.5' });
  // A profile id this version has no vendor for is named as it is, rather than as another vendor.
  expect(dropTarget(agentStage({ starts: { phase: 'plan', model: 'm', effort: 'low', engine: 'other', modelState: 'ok', refusal: null } }), true)).toMatchObject({ command: 'other · m · low' });
});

// With more than one engine profile the box names the profile the row runs on, "Claude Code (work) ·
// sonnet · medium", so a drop says which login it spends. With one it names the engine, as before.
describe('the profile in the drop box', () => {
  const on = (engine: string, severalProfiles?: boolean) =>
    agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine, modelState: 'ok', refusal: null, ...(severalProfiles === undefined ? {} : { severalProfiles }) } });

  it('names the engine alone with one profile', () => {
    expect(dropTarget(on('claude-code'), true)).toMatchObject({ command: 'Claude Code · sonnet · medium' });
    expect(dropTarget(on('claude-code#work'), true)).toMatchObject({ command: 'Claude Code · sonnet · medium' });
  });

  it('names the profile with two', () => {
    expect(dropTarget(on('claude-code#work', true), true)).toMatchObject({ command: 'Claude Code (work) · sonnet · medium' });
    // The first profile of a vendor holds the bare id, and is the engine by its name.
    expect(dropTarget(on('claude-code', true), true)).toMatchObject({ command: 'Claude Code · sonnet · medium' });
  });

  it('names a profile from its id', () => {
    expect(profileName('codex#work-2')).toBe('Codex (work-2)');
    expect(profileName('cursor')).toBe('Cursor');
    // An id this version has no vendor for is named as it is.
    expect(profileName('other#work')).toBe('other#work');
  });
});

// What the engine last reported about its five-hour window, for the profile the row runs on. It stays
// on this machine, and a share nobody measured is never shown.
describe('the usage window', () => {
  const now = Date.parse('2026-10-12T17:00:00Z');
  const at = (iso: string) => Date.parse(iso) / 1000;
  const reading = (over: Partial<{ used: number | null; resetsAt: number | null }> = {}, seenAt = now - 60_000) => ({
    seenAt,
    windows: [
      { name: 'seven_day', used: 0.2, resetsAt: at('2026-10-15T00:00:00Z'), status: 'allowed' },
      { name: 'five_hour', used: 0.62, resetsAt: at('2026-10-12T19:00:00Z'), status: 'allowed', ...over },
    ],
  });
  const plan = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } });

  it('writes the share of the five-hour window and the time it resets', () => {
    expect(usageLine(reading(), now, 'UTC')).toBe('5h window 62% · resets 19:00');
    expect(dropTarget(plan, true, { limits: { 'claude-code': reading() }, now, timeZone: 'UTC' })).toMatchObject({ usage: '5h window 62% · resets 19:00' });
  });

  it('writes the share alone when the engine gave no reset time', () => {
    expect(usageLine(reading({ resetsAt: null }), now, 'UTC')).toBe('5h window 62%');
  });

  it('reads the profile the row runs on, never another login', () => {
    const target = dropTarget(plan, true, { limits: { 'claude-code#work': reading() }, now, timeZone: 'UTC' });

    expect(target).toMatchObject({ kind: 'starts' });
    expect(target).not.toHaveProperty('usage', expect.anything());
  });

  // The window has reset since, so the share says nothing about it now.
  it('writes nothing once the window has reset, or the reading is older than the window', () => {
    expect(usageLine(reading({ resetsAt: at('2026-10-12T16:59:00Z') }), now, 'UTC')).toBeNull();
    expect(usageLine(reading({ resetsAt: null }, now - 5 * 60 * 60 * 1000 - 1), now, 'UTC')).toBeNull();
    expect(usageLine(reading({ resetsAt: null }, now - 5 * 60 * 60 * 1000), now, 'UTC')).toBe('5h window 62%');
  });

  it('writes nothing when the engine reported no share, no five-hour window or nothing at all', () => {
    expect(usageLine(reading({ used: null }), now, 'UTC')).toBeNull();
    expect(usageLine({ seenAt: now, windows: [{ name: 'seven_day', used: 0.5, resetsAt: null, status: null }] }, now, 'UTC')).toBeNull();
    expect(usageLine(undefined, now, 'UTC')).toBeNull();
    // A board or a card page that hands no reading.
    expect(dropTarget(plan, true)).not.toHaveProperty('usage', expect.anything());
  });

  // Near its limit the line says so in full, with the share the engine measured.
  it('says a five-hour or weekly window at 90% or more is near its limit', () => {
    expect(usageLine(reading({ used: 0.99 }), now, 'UTC')).toBe('5-hour window 99% used, resets 19:00');
    expect(usageLine(reading({ used: 0.9 }), now, 'UTC')).toBe('5-hour window 90% used, resets 19:00');
    expect(usageLine(reading({ used: 0.89 }), now, 'UTC')).toBe('5h window 89% · resets 19:00');
    const weekly = {
      seenAt: now - 60_000,
      windows: [
        { name: 'seven_day', used: 0.93, resetsAt: at('2026-10-15T00:00:00Z'), status: 'allowed' },
        { name: 'five_hour', used: 0.4, resetsAt: at('2026-10-12T19:00:00Z'), status: 'allowed' },
      ],
    };
    expect(usageLine(weekly, now, 'UTC')).toBe('weekly window 93% used, resets 15 Oct, 00:00');
    expect(dropTarget(plan, true, { limits: { 'claude-code': reading({ used: 0.99 }) }, now, timeZone: 'UTC' })).toMatchObject({ usage: '5-hour window 99% used, resets 19:00' });
  });

  it('warns only from a reading at 90% or more of a window that has not reset since', () => {
    expect(nearLimits(reading({ used: 0.95 }), now, 'UTC')).toEqual([{ window: 'five_hour', name: '5-hour window', resetsAt: at('2026-10-12T19:00:00Z'), text: '5-hour window 95% used, resets 19:00' }]);
    expect(nearLimits(reading({ used: 0.95, resetsAt: null }), now, 'UTC')).toEqual([{ window: 'five_hour', name: '5-hour window', resetsAt: null, text: '5-hour window 95% used' }]);
    expect(nearLimits(reading({ used: 0.89 }), now)).toEqual([]);
    expect(nearLimits(reading({ used: null }), now)).toEqual([]);
    expect(nearLimits(undefined, now)).toEqual([]);
    expect(nearLimits(reading({ used: 0.95, resetsAt: at('2026-10-12T16:59:00Z') }), now)).toEqual([]);
    expect(nearLimits(reading({ used: 0.95, resetsAt: null }, now - 5 * 60 * 60 * 1000 - 1), now)).toEqual([]);
    // A window this version knows no length for could have reset at any time since.
    expect(nearLimits({ seenAt: now, windows: [{ name: 'opus_week', used: 0.99, resetsAt: null, status: null }] }, now)).toEqual([]);
  });

  it('carries no window on a box that starts nothing or refuses', () => {
    const limits = { 'claude-code': reading() };
    const gone = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'high', engine: 'claude-code', modelState: 'gone', refusal: null } });

    expect(dropTarget(plan, false, { limits, now })).toEqual({ kind: 'nothing', says: 'Move here, starts nothing' });
    expect(dropTarget(gone, true, { limits, now })).toMatchObject({ kind: 'refused' });
  });
});

// The toast of a refused drop says which column the card did not reach, so the refusal of a move
// carries it. A refusal of a retry moves nothing and names no column.
it('names the column a refused drop did not reach, and none on a refusal that moved nothing', () => {
  const gone = agentStage({ starts: { phase: 'plan', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } });

  expect(dropOutcome(startDrag('APP-1'), gone, () => 'forward')).toMatchObject({ kind: 'refused', refusal: { stage: 'Plan' } });
  expect(refuseDrop(gone, 'forward')).not.toHaveProperty('stage');
  expect(keyStart(gone)).toEqual({ kind: 'refused', refusal: refuseDrop(gone, 'forward') });
});

// Two runs one press starts, the second once the first ends well: Fix it's Implement, then QA.
describe('chainTarget', () => {
  const minute = 60_000;
  const implement = stageFixture({ id: 'implement', label: 'Implement', role: 'agent', starts: { phase: 'implement', model: 'sonnet', effort: 'high', modelState: 'ok', refusal: null, engine: 'claude-code' } });
  const qa = stageFixture({ id: 'qa', label: 'QA', role: 'agent', starts: { phase: 'qa', model: 'sonnet', effort: 'medium', modelState: 'ok', refusal: null, engine: 'claude-code' } });
  const measured = (stage: StageView, costUsd: number | null, lowMs: number, highMs: number): StageView => ({ ...stage, starts: { ...stage.starts!, estimate: { costUsd, lowMs, highMs, from: 'history', runs: 6 } } });

  it('names both runs, and adds both estimates', () => {
    const target = chainTarget(measured(implement, 0.3, 3 * minute, 6 * minute), measured(qa, 0.1, 1 * minute, 2 * minute));

    expect(target).toEqual({ kind: 'starts', command: 'Claude Code · sonnet · high, then Claude Code · sonnet · medium', estimate: { text: 'about $0.40 · 4 to 8 min', from: 'Implement and QA together' } });
  });

  // No sum when one half was never measured.
  it('shows no estimate when only one run was measured', () => {
    const target = chainTarget(measured(implement, 0.3, 3 * minute, 6 * minute), qa);

    expect(target.kind === 'starts' && target.estimate).toBeUndefined();
  });

  it('is refused when either run is', () => {
    const gone = { ...qa, starts: { ...qa.starts!, modelState: 'gone' as const, model: 'claude-retired-1' } };

    expect(chainTarget(implement, gone)).toEqual({ kind: 'refused', reason: 'claude-retired-1 is gone. Pick another model in the card settings, or in Settings, Models.' });
    expect(chainTarget({ ...implement, starts: { ...implement.starts!, modelState: 'gone', model: 'claude-retired-1' } }, qa).kind).toBe('refused');
  });
});

// The card's Settings tab says a gone model with this one function, so the row and the refused drop
// cannot drift apart.
it('refuses a gone model with the one sentence the card settings row says too', () => {
  const refusal = refuseDrop(agentStage({ starts: { phase: 'plan', model: 'sonnet-4-5', effort: 'medium', engine: 'codex#work', modelState: 'gone', refusal: null } }), 'forward');

  expect(goneSentence('Plan', 'sonnet-4-5', 'codex#work')).toBe('Plan uses sonnet-4-5, which Codex no longer offers.');
  expect(refusal?.message).toBe(goneSentence('Plan', 'sonnet-4-5', 'codex#work'));
});

// Every screen that shows a run's model shows its engine first, because one model name can run on
// two engines once Cursor runs Claude and GPT models.
describe('ranOn', () => {
  it('names the engine by its vendor, then the model and the effort', () => {
    expect(ranOn('claude-code', 'sonnet', 'high')).toBe('Claude Code · sonnet · high');
    expect(ranOn('cursor#work', 'gpt-5.6', null)).toBe('Cursor · gpt-5.6');
  });

  it('leaves out what the run has not got', () => {
    expect(ranOn(null, 'sonnet', 'high')).toBe('sonnet · high');
    expect(ranOn(undefined, null, null)).toBe('');
    expect(ranOn('old-engine', null, 'low')).toBe('old-engine · low');
  });

  // Settings, Models says the effort is in the model name there, so no line names one beside it.
  it('leaves the effort out where the model id carries it, in a run and in a start alike', () => {
    expect(ranOn('cursor', 'gpt-5.3-codex', 'medium')).toBe('Cursor · gpt-5.3-codex');
    expect(startsCommand({ engine: 'cursor#work', model: 'gpt-5.3-codex', effort: 'medium', severalProfiles: true })).toBe('Cursor (work) · gpt-5.3-codex');
    expect(startsCommand({ engine: 'codex', model: 'gpt-5.6', effort: 'medium' })).toBe('Codex · gpt-5.6 · medium');
  });

  // A run from before 0.1.0 may have run on Antigravity, which is no engine now. History keeps its
  // words as they were stored.
  it('names a run on an engine this version does not know by its stored id', () => {
    expect(ranOn('antigravity', 'gemini-3.1-pro-high', 'high')).toBe('antigravity · gemini-3.1-pro-high · high');
  });
});
