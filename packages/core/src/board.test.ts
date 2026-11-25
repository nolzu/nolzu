import { type Board, BOARD_KINDS, type BoardKind, type CardState, type Stage, type StageView, type StartsDescriptor, type Ticket } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { advanceTo, boardFor, canMove, chainTo, deliveryBoard, nextStage, phaseOnEnter, relatedByParent, stageSays, startsLabel } from './board.ts';

const board = deliveryBoard('pull-request');
const card = (stage: string, state: CardState = 'idle') => ({ stage, state });

describe('canMove', () => {
  it('allows one step forward and refuses two', () => {
    expect(canMove(board, card('plan'), 'implement')).toBe(true);
    expect(canMove(board, card('plan'), 'qa')).toBe(false);
  });

  it.each(['review', 'implement', 'inbox'])('allows a move back from wrap-up to %s', (to) => {
    expect(canMove(board, card('wrapup'), to)).toBe(true);
  });

  it('refuses a move to the same stage and to an unknown stage', () => {
    expect(canMove(board, card('plan'), 'plan')).toBe(false);
    expect(canMove(board, card('plan'), 'deploy')).toBe(false);
  });

  it.each<CardState>(['queued', 'running'])('locks a %s card in both directions', (state) => {
    expect(canMove(board, card('plan', state), 'implement')).toBe(false);
    expect(canMove(board, card('plan', state), 'refine')).toBe(false);
  });

  it.each<CardState>(['blocked', 'failed'])('lets a %s card move', (state) => {
    expect(canMove(board, card('plan', state), 'implement')).toBe(true);
    expect(canMove(board, card('plan', state), 'refine')).toBe(true);
  });
});

describe('phaseOnEnter', () => {
  it('starts no phase on a move back', () => {
    expect(phaseOnEnter(board, 'qa', 'implement')).toBeUndefined();
  });

  it('starts the phase of an agent stage on a forward move', () => {
    expect(phaseOnEnter(board, 'inbox', 'refine')).toBe('refine');
    expect(phaseOnEnter(board, 'plan', 'implement')).toBe('implement');
  });

  it('starts nothing on a forward move into a person or auto stage', () => {
    expect(phaseOnEnter(board, 'qa', 'review')).toBeUndefined();
    expect(phaseOnEnter(board, 'review', 'pr-watch')).toBeUndefined();
  });

  // Dragging a finished card into QA is what checks it, so the move starts the phase.
  it('starts the qa phase on a forward move into qa', () => {
    expect(phaseOnEnter(board, 'implement', 'qa')).toBe('qa');
  });

  // The wrap-up is the fourth phase a drag starts. It writes the project's knowledge, so the move
  // into the stage is what begins it.
  it('starts the wrap-up phase on a forward move into wrap-up', () => {
    expect(phaseOnEnter(board, 'pr-watch', 'wrapup')).toBe('wrapup');
  });

  // Moving back never starts it again, because the knowledge of the card is already written.
  it('starts nothing when a card moves back into wrap-up', () => {
    expect(phaseOnEnter(board, 'closed', 'wrapup')).toBeUndefined();
  });
});

describe('advanceTo', () => {
  // QA chains onto Review and Wrap-up onto Closed. Every other stage leaves the card ready for a person
  // to drag, because the next column starts a run or waits on GitHub.
  it.each(['refine', 'plan', 'implement', 'review'])('chains nothing from %s', (from) => {
    expect(advanceTo(board, from, 'complete')).toBeUndefined();
  });

  it('chains from wrap-up to closed', () => {
    expect(advanceTo(board, 'wrapup', 'complete')).toBe('closed');
  });

  it('chains from qa to review', () => {
    expect(advanceTo(board, 'qa', 'complete')).toBe('review');
    // A question or a failure waits for a person, whatever the stage says.
    expect(advanceTo(board, 'qa', 'needs_input')).toBeUndefined();
    expect(advanceTo(board, 'qa', 'failed')).toBeUndefined();
  });

  // The rule is data, so a later stage that chains needs a row and not code.
  it('still follows advanceOn when a stage carries one', () => {
    const chained: Board = {
      kind: 'delivery',
      stages: [
        { id: 'a', label: 'A', role: 'agent', phase: 'implement', advanceOn: 'b' },
        { id: 'b', label: 'B', role: 'agent' },
      ],
    };
    expect(advanceTo(chained, 'a', 'complete')).toBe('b');
    expect(advanceTo(chained, 'a', 'failed')).toBeUndefined();
    expect(advanceTo(chained, 'a', 'needs_input')).toBeUndefined();
  });
});

/**
 * The chains a finished run makes by itself, per board. Each one lands on a
 * person's column or the archive, and the agent columns between them stay manual, because a chain there
 * would start a paid run.
 */
describe('chainTo', () => {
  const ready = (phase: string, verdict: string | null = null) => ({ phase, state: 'ready', verdict, waits: false });

  it.each([
    ['delivery', 'qa', 'qa', 'review'],
    ['delivery', 'wrapup', 'wrapup', 'closed'],
    ['epics', 'plan', 'plan', 'review'],
    ['epics', 'wrapup', 'wrapup', 'done'],
    ['investigations', 'research', 'investigate', 'review'],
    ['investigations', 'wrapup', 'wrapup', 'done'],
    ['questions', 'research', 'research', 'review'],
    ['questions', 'wrapup', 'wrapup', 'done'],
    ['prreview', 'pre-review', 'pr-review', 'my-review'],
    ['prreview', 'wrapup', 'wrapup', 'closed'],
  ])('moves a %s card from %s after its own %s run to %s', (kind, stage, phase, to) => {
    expect(chainTo(boardFor(kind as BoardKind, 'pull-request'), stage, ready(phase, 'PASS'))).toBe(to);
  });

  // Exactly the list above: every other stage of every board keeps its card after a ready run.
  it.each([...BOARD_KINDS])('chains nothing else on %s', (kind) => {
    const made = boardFor(kind, 'pull-request');
    const chained = made.stages.filter((stage) => chainTo(made, stage.id, ready(stage.phase ?? '', 'PASS')) !== undefined).map((stage) => stage.id);
    const listed: Record<string, string[]> = { delivery: ['qa', 'wrapup'], epics: ['plan', 'wrapup'], investigations: ['research', 'wrapup'], questions: ['research', 'wrapup'], prreview: ['pre-review', 'wrapup'] };
    expect(chained).toEqual(listed[kind]);
  });

  // A message on the refine thread runs refine while the card sits on Plan, and that is no plan result.
  it('moves nothing for a run of another phase on the stage', () => {
    const epics = boardFor('epics', 'pull-request');
    expect(chainTo(epics, 'plan', ready('refine'))).toBeUndefined();
    expect(chainTo(epics, 'wrapup', ready('feedback'))).toBeUndefined();
    expect(chainTo(epics, 'wrapup', ready('ask'))).toBeUndefined();
  });

  it.each(['blocked', 'failed', 'idle'])('moves nothing for a run that ended %s', (state) => {
    expect(chainTo(board, 'wrapup', { phase: 'wrapup', state, verdict: null, waits: false })).toBeUndefined();
  });

  it('moves QA on with a PASS alone', () => {
    expect(chainTo(board, 'qa', ready('qa'))).toBeUndefined();
    expect(chainTo(board, 'qa', ready('qa', 'FAIL'))).toBeUndefined();
    expect(chainTo(board, 'qa', ready('qa', 'PASS'))).toBe('review');
  });

  // The rule itself, over a row that names an agent or an auto column: nothing starts the run there.
  it('never chains onto an agent or an auto column', () => {
    const chained: Board = {
      kind: 'delivery',
      stages: [
        { id: 'a', label: 'A', role: 'agent', phase: 'refine', advanceOn: 'b' },
        { id: 'b', label: 'B', role: 'agent', phase: 'plan', advanceOn: 'c' },
        { id: 'c', label: 'C', role: 'auto' },
      ],
    };
    expect(chainTo(chained, 'a', ready('refine'))).toBeUndefined();
    expect(chainTo(chained, 'b', ready('plan'))).toBeUndefined();
  });

  // A wrap-up that left a knowledge change waiting for review stays, so the person still finds it.
  // A chain onto a person's column takes the work along, so it goes on all the same.
  it('keeps a card off the archive when the run left something waiting', () => {
    expect(chainTo(board, 'wrapup', { ...ready('wrapup'), waits: true })).toBeUndefined();
    expect(chainTo(board, 'qa', { ...ready('qa', 'PASS'), waits: true })).toBe('review');
  });
});

describe('deliveryBoard', () => {
  const stage = (id: string) => deliveryBoard('pull-request').stages.find((s) => s.id === id);

  // Nolzu merges nothing: a finished card leaves review for PR watch, and no Merge column exists.
  it('has pr watch after review, and no merge', () => {
    const ids = deliveryBoard('pull-request').stages.map((s) => s.id);
    expect(ids).toEqual(['inbox', 'refine', 'plan', 'implement', 'qa', 'review', 'pr-watch', 'wrapup', 'closed']);
    expect(ids).not.toContain('merge');
  });

  // The label changed and the id stays, so stored cards keep their column.
  it('gives pr watch the auto role, no phase and the label Pull request', () => {
    expect(stage('pr-watch')).toEqual({ id: 'pr-watch', label: 'Pull request', role: 'auto' });
  });

  // A card reaches PR watch only by a person's drag, after they read the review.
  it('moves no card into pr watch on its own', () => {
    expect(deliveryBoard('pull-request').stages.filter((s) => s.advanceOn === 'pr-watch')).toEqual([]);
  });

  it('starts the qa phase on qa and chains it to review', () => {
    expect(stage('qa')).toMatchObject({ role: 'agent', phase: 'qa', advanceOn: 'review' });
  });

  it('starts the wrap-up phase on the wrap-up stage and chains it to closed', () => {
    expect(stage('wrapup')).toMatchObject({ role: 'agent', phase: 'wrapup', advanceOn: 'closed' });
  });

  it('gives implement no advanceOn, so a finished run waits for a person', () => {
    expect(stage('implement')?.advanceOn).toBeUndefined();
  });
});

describe('relatedByParent', () => {
  // A person making a card from one ticket is offered its siblings, so the work that belongs
  // together lands on the board together.
  const ticket = (key: string, parentKey: string | null): Ticket => ({
    key,
    title: `${key} title`,
    body: '',
    state: 'open',
    url: null,
    parentKey,
  });

  it('offers the tickets that share a parent', () => {
    const offered = relatedByParent(ticket('PROJ-1', 'PROJ-100'), [ticket('PROJ-2', 'PROJ-100'), ticket('PROJ-3', 'PROJ-100')], []);

    expect(offered.map((found) => found.key)).toEqual(['PROJ-2', 'PROJ-3']);
  });

  it('offers nothing for a ticket with no parent', () => {
    expect(relatedByParent(ticket('PROJ-1', null), [ticket('PROJ-2', null), ticket('PROJ-3', 'PROJ-100')], [])).toEqual([]);
  });

  it('leaves out a ticket that is already on the board', () => {
    const offered = relatedByParent(ticket('PROJ-1', 'PROJ-100'), [ticket('PROJ-2', 'PROJ-100'), ticket('PROJ-3', 'PROJ-100')], ['PROJ-2']);

    expect(offered.map((found) => found.key)).toEqual(['PROJ-3']);
  });

  it('never offers the ticket the card is being made from', () => {
    const from = ticket('PROJ-1', 'PROJ-100');

    // A second object carrying the same key, not the same object. The ticket and its siblings come
    // from two source reads, so a comparison by identity would pass here and fail in the product.
    expect(
      relatedByParent(from, [ticket('PROJ-1', 'PROJ-100'), ticket('PROJ-2', 'PROJ-100')], []).map((found) => found.key),
    ).toEqual(['PROJ-2']);
  });

  it('leaves out a sibling under a different parent', () => {
    const offered = relatedByParent(ticket('PROJ-1', 'PROJ-100'), [ticket('PROJ-2', 'PROJ-200'), ticket('PROJ-3', 'PROJ-100')], []);

    expect(offered.map((found) => found.key)).toEqual(['PROJ-3']);
  });
});

// The stages as the snapshot carries them: the board's own list, with what a forward drop would
// start where the test names one.
const views = (of: Board, starts: Record<string, StartsDescriptor> = {}): readonly StageView[] =>
  of.stages.map((stage) => ({ id: stage.id, label: stage.label, role: stage.role, count: 0, cadence: null, starts: starts[stage.id] ?? null }));

const refine: StartsDescriptor = { phase: 'refine', model: 'haiku', effort: 'low', engine: 'claude-code', modelState: 'ok', refusal: null };
const plan: StartsDescriptor = { phase: 'plan', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null };

describe('startsLabel', () => {
  it('names the phase, the model and the effort a forward move starts', () => {
    expect(startsLabel(board, 'inbox', 'refine', views(board, { refine }))).toBe('Starts: /refine · haiku · low');
    expect(startsLabel(board, 'refine', 'plan', views(board, { refine, plan }))).toBe('Starts: /plan · opus · high');
  });

  it('says nothing for a forward move into a stage that starts no phase', () => {
    expect(startsLabel(board, 'review', 'pr-watch', views(board))).toBeUndefined();
  });

  // The column still carries what a forward drop would start. A move back starts nothing, so a
  // label read off the column alone would promise a run that never happens.
  it.each([
    ['plan', 'refine'],
    ['implement', 'refine'],
    ['refine', 'refine'],
  ])('says nothing for a move from %s to %s, although the column starts a phase on the way forward', (from, to) => {
    expect(startsLabel(board, from, to, views(board, { refine }))).toBeUndefined();
  });

  it('names the model that is gone and the setting to fix', () => {
    const gone = views(board, { refine: { ...refine, engine: 'claude-code', modelState: 'gone', refusal: null } });

    expect(startsLabel(board, 'inbox', 'refine', gone)).toBe('haiku is gone. Pick another model in the card settings, or in Settings, Models.');
  });

  // A snapshot from a moment ago can miss what the board says starts. Nothing resolved means
  // nothing to promise.
  it('says nothing when the snapshot carries no model for the stage', () => {
    expect(startsLabel(board, 'inbox', 'refine', views(board))).toBeUndefined();
    expect(startsLabel(board, 'inbox', 'refine', [])).toBeUndefined();
  });

  it('says nothing for a stage the board does not have', () => {
    expect(startsLabel(board, 'inbox', 'deploy', views(board, { refine }))).toBeUndefined();
  });
});

describe('nextStage', () => {
  it('is the stage one step forward, which is the only forward move a card may make', () => {
    expect(nextStage(board, 'inbox')?.id).toBe('refine');
    expect(nextStage(board, 'review')?.id).toBe('pr-watch');
  });

  it('is nothing after the last stage, and nothing for a stage the board does not have', () => {
    expect(nextStage(board, 'closed')).toBeUndefined();
    expect(nextStage(board, 'deploy')).toBeUndefined();
  });

  it('always names a stage canMove allows', () => {
    const of = deliveryBoard('pull-request');
    for (const stage of of.stages) {
      const next = nextStage(of, stage.id);
      if (next !== undefined) expect(canMove(of, card(stage.id), next.id)).toBe(true);
    }
  });
});

/**
 * The four boards that are not Delivery.
 *
 * Their stage lists are fixed, so they are written out here by
 * hand rather than read off the table. A table that drifts from this list turns this red, which is
 * the only thing holding the two together. The role is part of it: it decides what the column draws
 * and who the card waits on, so a wrong one is as wrong as a missing stage.
 *
 * Every agent stage has its phase, and the phase is part of the row here: a stage whose phase
 * is wrong starts the wrong method, which no other test would catch. Two of the names are not the
 * stage id, and one phase is named by two stages, so reading the id would be reading nothing.
 */
const EXPECTED: Record<string, readonly Stage[]> = {
  epics: [
    { id: 'inbox', label: 'Inbox', role: 'you' },
    { id: 'refine', label: 'Refine', role: 'agent', phase: 'refine' },
    { id: 'architecture', label: 'Architecture', role: 'agent', phase: 'architecture' },
    { id: 'design', label: 'Design', role: 'agent', phase: 'design' },
    { id: 'plan', label: 'Plan', role: 'agent', phase: 'plan', advanceOn: 'review' },
    { id: 'review', label: 'Review', role: 'you' },
    { id: 'in-delivery', label: 'In delivery', role: 'auto' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'done' },
    { id: 'done', label: 'Done', role: 'archive' },
  ],
  investigations: [
    { id: 'inbox', label: 'Inbox', role: 'you' },
    { id: 'research', label: 'Research', role: 'agent', phase: 'investigate', advanceOn: 'review' },
    { id: 'review', label: 'Review', role: 'you' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'done' },
    { id: 'done', label: 'Done', role: 'archive' },
  ],
  questions: [
    { id: 'inbox', label: 'Inbox', role: 'you' },
    { id: 'research', label: 'Research', role: 'agent', phase: 'research', advanceOn: 'review' },
    { id: 'review', label: 'Review', role: 'you' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'done' },
    { id: 'done', label: 'Done', role: 'archive' },
  ],
  prreview: [
    { id: 'incoming', label: 'Incoming', role: 'you' },
    { id: 'pre-review', label: 'Agent pre-review', role: 'agent', phase: 'pr-review', advanceOn: 'my-review' },
    { id: 'my-review', label: 'My review', role: 'you' },
    { id: 'awaiting-author', label: 'Awaiting author', role: 'auto' },
    { id: 'approved', label: 'Approved', role: 'you' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'closed' },
    { id: 'closed', label: 'Closed', role: 'archive' },
  ],
};

// One Research board draws the cards of both kinds in the same columns, so a card of either kind must
// sit on a column the other kind has too. Only the phase the Research column starts may differ.
it('gives questions and investigations the same columns', () => {
  const columns = (kind: BoardKind) => boardFor(kind, 'pull-request').stages.map(({ phase, ...rest }) => (rest.id === 'research' ? rest : { ...rest, phase }));
  expect(columns('questions')).toEqual(columns('investigations'));
});

// The whole stage, not its id alone. A role or a label held by nothing is a column that draws the
// wrong thing and no test to say so.
it.each(Object.keys(EXPECTED))('lays %s out as listed', (kind) => {
  const made = boardFor(kind as BoardKind, 'pull-request');

  expect(made.kind).toBe(kind);
  expect(made.stages).toEqual(EXPECTED[kind]);
});

// Delivery's own roles, for the reason the table above gives. The stage ids of this board are
// pinned in `deliveryBoard` above and its roles were held one stage at a time, so Inbox and Closed
// could be drawn with the wrong glyph and nothing here would say so.
it('gives every Delivery column its own role', () => {
  expect(deliveryBoard('pull-request').stages.map((stage) => [stage.id, stage.role])).toEqual([
    ['inbox', 'you'],
    ['refine', 'agent'],
    ['plan', 'agent'],
    ['implement', 'agent'],
    ['qa', 'agent'],
    ['review', 'you'],
    ['pr-watch', 'auto'],
    ['wrapup', 'agent'],
    ['closed', 'archive'],
  ]);
});

// The one function answers for Delivery as well, so no caller has to know which board needs a flow.
it('answers for Delivery', () => {
  expect(boardFor('delivery', 'pull-request')).toEqual(deliveryBoard('pull-request'));
});

// Every chain lands on a stage of the same board. A name that is not one is a card that finishes a
// run and stays where it is, with nothing saying why.
it.each(Object.keys(EXPECTED))('chains %s onto its own stages', (kind) => {
  const made = boardFor(kind as BoardKind, 'pull-request');
  const ids = made.stages.map((stage) => stage.id);

  for (const stage of made.stages) {
    if (stage.advanceOn !== undefined) expect(ids).toContain(stage.advanceOn);
  }
});

// Two stages of one board may not share an id, or the index lookups that `canMove` and
// `phaseOnEnter` do would answer about the wrong column.
it.each(Object.keys(EXPECTED))('gives %s no repeated id', (kind) => {
  const ids = boardFor(kind as BoardKind, 'pull-request').stages.map((stage) => stage.id);

  expect(new Set(ids).size).toBe(ids.length);
});

// The one move rule, over every board rather than over Delivery alone. One step forward, any number
// back, and nothing while the card belongs to a run.
it.each(Object.keys(EXPECTED))('moves a card one step forward and any number back on %s', (kind) => {
  const made = boardFor(kind as BoardKind, 'pull-request');
  const ids = made.stages.map((stage) => stage.id);
  const first = ids[0] ?? '';

  expect(canMove(made, { stage: first, state: 'idle' }, ids[1] ?? '')).toBe(true);
  expect(canMove(made, { stage: first, state: 'idle' }, ids[2] ?? '')).toBe(false);
  expect(canMove(made, { stage: ids.at(-1) ?? '', state: 'idle' }, first)).toBe(true);
  expect(canMove(made, { stage: first, state: 'running' }, ids[1] ?? '')).toBe(false);
});

// Every agent stage starts a phase, and no other stage does. An agent column with no phase is
// one a person drags a card into and nothing happens, with nothing on the screen saying why.
it.each(Object.keys(EXPECTED))('starts a phase on every agent stage of %s and nowhere else', (kind) => {
  const made = boardFor(kind as BoardKind, 'pull-request');

  for (const stage of made.stages) {
    expect(stage.phase === undefined, stage.id).toBe(stage.role !== 'agent');
  }
});

// The forward drop is what starts it, read through the rule rather than off the row, because that
// is the call the board makes. A move back still starts nothing.
it.each(Object.keys(EXPECTED))('starts the stage phase on a forward drop onto %s, and nothing on a move back', (kind) => {
  const made = boardFor(kind as BoardKind, 'pull-request');
  const ids = made.stages.map((stage) => stage.id);

  for (const [at, stage] of made.stages.entries()) {
    if (at === 0) continue;
    expect(phaseOnEnter(made, ids[at - 1] ?? '', stage.id), stage.id).toBe(stage.phase);
    expect(phaseOnEnter(made, ids.at(-1) ?? '', stage.id)).toBeUndefined();
  }
});

// A question or a failure waits for a person, whatever the row says, so neither reads a chain. The
// row itself is held against the table above, and what the app does with a completed run is in
// `apps/local/src/lib/board-phases.test.ts`, where the run is real.
it.each(Object.keys(EXPECTED))('reads no chain on %s for a run that asked something or failed', (kind) => {
  const made = boardFor(kind as BoardKind, 'pull-request');

  for (const stage of made.stages) {
    expect(advanceTo(made, stage.id, 'needs_input'), stage.id).toBeUndefined();
    expect(advanceTo(made, stage.id, 'failed'), stage.id).toBeUndefined();
  }
});

// Send to author is the board's own step from My review, one column forward, and it starts no
// run: the card waits on the author. The next round is a drop on Agent pre-review again, after a new
// push sent the card back to Incoming, so no agent column follows Awaiting author.
it('takes Send to author as a plain step, with no agent column after it', () => {
  const board = boardFor('prreview', 'pull-request');
  const idle = { stage: 'my-review', state: 'idle' as const };

  expect(canMove(board, idle, 'awaiting-author')).toBe(true);
  expect(phaseOnEnter(board, 'my-review', 'awaiting-author')).toBeUndefined();
  expect(nextStage(board, 'awaiting-author')).toMatchObject({ id: 'approved', role: 'you' });
  expect(canMove(board, { stage: 'awaiting-author', state: 'idle' }, 'incoming')).toBe(true);
  expect(phaseOnEnter(board, 'incoming', 'pre-review')).toBe('pr-review');
});

// The line under a column's name. A person's column says what the person does there and an auto
// column says what it waits on. An agent column says what a drop starts, which the models decide,
// so it has no line here; neither has an archive column, which needs nothing from anyone.
describe('stageSays', () => {
  it.each([
    ['delivery', 'inbox', 'you pick what goes next'],
    ['delivery', 'review', 'you read the change, then push'],
    ['delivery', 'pr-watch', 'waits on GitHub'],
    ['epics', 'review', 'you read, then send the tasks'],
    ['epics', 'in-delivery', 'follows its tasks on Delivery'],
    ['prreview', 'incoming', 'you pick what to review'],
    ['prreview', 'my-review', 'you read the findings, then post'],
    ['prreview', 'awaiting-author', 'back to Incoming on a new push, on to Approved when you approve'],
    ['prreview', 'approved', 'waits for the author to merge'],
    ['questions', 'review', 'you read the answer or the report'],
    ['investigations', 'review', 'you read the answer or the report'],
  ] as const)('gives %s %s its line', (kind, id, line) => {
    expect(stageSays(kind, id)).toBe(line);
  });

  it.each(Object.keys(EXPECTED).concat('delivery'))('gives every person and auto column of %s a line, and no other column one', (kind) => {
    for (const stage of boardFor(kind as BoardKind, 'pull-request').stages) {
      const says = stageSays(kind as BoardKind, stage.id);
      if (stage.role === 'you' || stage.role === 'auto') expect(says, stage.id).toMatch(/^[a-z]/);
      else expect(says, stage.id).toBeUndefined();
    }
  });

  it('says nothing for a stage the board does not have', () => {
    expect(stageSays('delivery', 'merge')).toBeUndefined();
    // A name every object carries is no stage either.
    expect(stageSays('delivery', 'constructor')).toBeUndefined();
  });
});
