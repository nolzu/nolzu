import { readFileSync } from 'node:fs';
import type { StageView } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Board from './Board.svelte';
import BoardCard from './BoardCard.svelte';
import BoardColumn from './BoardColumn.svelte';
import { enterColumn, startDrag } from './drag.ts';
import { boardFixture, cardFixture, stageFixture } from './fixture.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const allowOnly =
  (...ids: readonly string[]) =>
  (stage: string): 'forward' | 'back' | false =>
    ids.includes(stage) ? 'forward' : false;

const allowBack =
  (...ids: readonly string[]) =>
  (stage: string): 'forward' | 'back' | false =>
    ids.includes(stage) ? 'back' : false;

const refine = (over: Partial<StageView> = {}): StageView =>
  stageFixture({
    id: 'refine',
    label: 'Refine',
    role: 'agent',
    starts: { phase: 'refine', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null },
    ...over,
  });

const column = (stage: StageView, props: Record<string, unknown>) => render(BoardColumn, { props: { stage, ...props } }).body;
// A drag with the pointer over this column. An empty column opens only then, so its drop box shows.
const over = (stage: string) => enterColumn(startDrag('APP-1'), stage);

// The drop target: "Drop to start Implement", the engine, the model and the effort, then
// the line that says how to back out and that a move back starts nothing.
it('marks a column the card may land on, and says what the drop starts', () => {
  const body = column(refine(), { drag: over('refine'), allowed: allowOnly('refine') });

  expect(body).toContain('data-drop-target="true"');
  expect(body).toMatch(/<div class="drop[^"]*" data-drop="starts" role="status">/);
  expect(text(body)).toContain('Drop to start Refine Claude Code · sonnet · medium Esc cancels. Moving back never starts a run.');
});

// With one engine profile the box names the engine. With more it names the profile the row runs on,
// so the drop says which login it spends.
it('names the profile in the drop box only when more than one is set', () => {
  const work = (severalProfiles?: true) =>
    refine({ starts: { phase: 'refine', model: 'sonnet', effort: 'medium', engine: 'claude-code#work', modelState: 'ok', refusal: null, ...(severalProfiles ? { severalProfiles } : {}) } });

  expect(text(column(work(), { drag: over('refine'), allowed: allowOnly('refine') }))).toContain('Drop to start Refine Claude Code · sonnet · medium Esc cancels.');
  expect(text(column(work(true), { drag: over('refine'), allowed: allowOnly('refine') }))).toContain('Drop to start Refine Claude Code (work) · sonnet · medium Esc cancels.');
});

// The line under the command, "about $0.40 · 6 to 10 min", and none when nothing measured it.
it('writes the estimate under the command in the drop box, when the start has one', () => {
  const measured = refine({
    starts: {
      phase: 'refine',
      model: 'haiku',
      effort: 'low',
      engine: 'claude-code',
      modelState: 'ok',
      refusal: null,
      estimate: { costUsd: 0.053, lowMs: 21_000, highMs: 37_000, from: 'preset', runs: 0 },
    },
  });
  const body = column(measured, { drag: over('refine'), allowed: allowOnly('refine') });

  expect(text(body)).toContain('Claude Code · haiku · low about $0.05 · under a minute Esc cancels.');
  expect(body).toContain('class="estimate');
  expect(column(refine(), { drag: over('refine'), allowed: allowOnly('refine') })).not.toContain('class="estimate');
});

it('draws the drop box at the top of the column body, above the cards', () => {
  // The box sits where the card will land, in the body, not between the header and it.
  const body = column(refine(), { drag: startDrag('APP-1'), allowed: allowOnly('refine'), cards: [cardFixture({ key: 'APP-9', stage: 'refine' })] });
  const inside = body.slice(body.indexOf('class="body'));

  expect(inside.indexOf('data-drop=')).toBeGreaterThan(-1);
  expect(inside.indexOf('data-drop=')).toBeLessThan(inside.indexOf('data-card="APP-9"'));
});

it('names the column for a screen reader, because it takes drops', () => {
  // A plain section carrying drop handlers is announced as nothing at all. The name is the column
  // label, so a person hears which column they are in.
  const body = column(refine(), { drag: null, allowed: allowOnly() });

  expect(body).toContain('role="group"');
  expect(body).toContain('aria-label="Refine"');
});

it('marks no column the card may not land on', () => {
  // Two stages forward is not a legal move, so the predicate refuses it and nothing is offered.
  const body = column(refine({ id: 'implement', label: 'Implement' }), {
    drag: over('implement'),
    allowed: allowOnly('refine'),
  });

  expect(body).not.toContain('data-drop-target="true"');
  expect(body).not.toContain('data-drop=');
});

it('marks nothing at all while no card is being dragged', () => {
  const body = column(refine(), { drag: null, allowed: allowOnly('refine') });

  expect(body).not.toContain('data-drop-target="true"');
});

it('says a column starts nothing rather than promising a run', () => {
  const body = column(refine({ id: 'qa', label: 'QA', starts: null }), {
    drag: over('qa'),
    allowed: allowOnly('qa'),
  });

  expect(text(body)).toContain('Move here, starts nothing');
});

it('names a model that is gone, and where to fix it', () => {
  const body = column(refine({ starts: { phase: 'refine', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), {
    drag: over('refine'),
    allowed: allowOnly('refine'),
  });

  expect(body).toContain('data-drop="refused"');
  expect(text(body)).toContain('Refused');
  expect(text(body)).toContain('sonnet is gone');
  expect(text(body)).toContain('Settings, Models');
  expect(text(body)).not.toContain('Drop to start');
});

it('leaves the card where it is while it is dragged over another column', () => {
  // The load bearing one. The drop is the consent and the snapshot is the truth, so nothing moves
  // until a new snapshot says it did. A board that moved the card itself would lie for a moment,
  // and that moment is where busy state stops being honest.
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);

  const { body } = render(Board, {
    props: {
      snapshot,
      now: new Date('2026-09-17T08:00:00Z'),
      drag: enterColumn(startDrag('APP-1'), 'plan'),
      allowed: allowOnly('plan'),
    },
  });

  const parts = body.split('data-stage="');
  expect(parts.find((part) => part.startsWith('inbox'))).toContain('APP-1');
  expect(parts.find((part) => part.startsWith('plan'))).not.toContain('APP-1');
  // The board has to hand the drag and the predicate down, or every column reads as forbidden and
  // the person drags across a board that offers nothing.
  expect(parts.find((part) => part.startsWith('plan'))).toContain('data-drop-target="true"');
});

it('marks a backward column even when it runs no agent', () => {
  // canMove allows any move back, so the inbox takes the card too. A target only on agent columns
  // would hide the commonest drop there is.
  const body = column(stageFixture({ id: 'inbox', label: 'Inbox', role: 'you' }), {
    drag: over('inbox'),
    allowed: allowBack('inbox'),
  });

  expect(body).toContain('data-drop-target="true"');
  expect(text(body)).toContain('Move here, starts nothing');
});

it('promises no run when the card is dragged back onto an agent column', () => {
  const body = column(refine(), { drag: over('refine'), allowed: allowBack('refine') });

  // The column still takes the card, it just does not pretend a run follows.
  expect(body).toContain('data-drop-target="true"');
  expect(body).toContain('data-drop="nothing"');
  expect(text(body)).not.toContain('Drop to start');
  expect(text(body)).toContain('Move here, starts nothing');
});

it('lets a card be picked up, in both the shapes it is drawn in', () => {
  const open = render(BoardCard, { props: { card: cardFixture({ key: 'APP-1' }) } }).body;
  const strip = render(BoardCard, { props: { card: cardFixture({ key: 'APP-2', minimized: true }) } }).body;

  // A card nobody can pick up makes every drop target on the board unreachable, and a card in the
  // strip is the one a person is most likely to be moving on.
  expect(open).toContain('draggable="true"');
  expect(strip).toContain('draggable="true"');
});

it('drops the drag when a snapshot turns the dragged card queued', () => {
  // The snapshot is the truth and it can arrive mid drag. Holding the drag would send a move the
  // server refuses, after the person already let go.
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', state: 'queued', queuePosition: 1 })]);

  const { body } = render(Board, {
    props: {
      snapshot,
      now: new Date('2026-09-17T08:00:00Z'),
      drag: enterColumn(startDrag('APP-1'), 'plan'),
      allowed: allowOnly('plan'),
    },
  });

  expect(body).not.toContain('data-drop-target="true"');
});

it('keeps the drag while the dragged card is still free to move', () => {
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', state: 'idle' })]);

  const { body } = render(Board, {
    props: {
      snapshot,
      now: new Date('2026-09-17T08:00:00Z'),
      drag: enterColumn(startDrag('APP-1'), 'plan'),
      allowed: allowOnly('plan'),
    },
  });

  expect(body).toContain('data-drop-target="true"');
});

it('marks a column that would refuse the drop, so the drop and the label cannot disagree', () => {
  const body = column(refine({ starts: { phase: 'refine', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } }), {
    drag: over('refine'),
    allowed: allowOnly('refine'),
  });

  // The same derived value the column's drop handler reads, so a test can see the rule rather than
  // only the helper that expresses it.
  expect(body).toContain('data-refuses="true"');
  expect(text(body)).toContain('sonnet is gone');
});

it('marks no refusal on a column whose model is there', () => {
  const body = column(refine(), { drag: over('refine'), allowed: allowOnly('refine') });

  expect(body).not.toContain('data-refuses="true"');
});

it('hands every column handler down, or the answer the column computed has nowhere to go', () => {
  const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  const board = read('Board.svelte');
  // The column decides and the board only carries. A handler the board keeps to itself is a decision
  // nobody hears, and onRefuse is the one that owes a person an explanation for a card that stayed
  // put. Written against the whole list rather than one name, so the next handler cannot repeat it.
  const handlers = [...read('BoardColumn.svelte').matchAll(/^\s+(on[A-Z]\w*)\?:/gm)].map((match) => match[1]);

  expect(handlers).toContain('onRefuse');
  expect(handlers.filter((name) => !new RegExp(`\\{${name}\\}|${name}=\\{`).test(board))).toEqual([]);
});

it('writes the drop box text only in the colours tokens.test.ts checks on the tint', () => {
  // An ink tokens.test.ts does not measure on the tint can fall under 4.5:1 there, and no render test would see it.
  // Read the classes out of the starts branch, so a new line in a new colour fails here too.
  const source = readFileSync(new URL('./BoardColumn.svelte', import.meta.url), 'utf8');
  const starts = source.slice(source.indexOf("box.kind === 'starts'"), source.indexOf("box.kind === 'refused'"));
  const style = source.slice(source.indexOf('<style>')).replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selector: rule[1]!.trim(),
    colour: /color:\s*var\(--([a-z0-9-]+)\)/.exec(rule[2]!)?.[1],
  }));
  // The box paints its label through [data-drop='starts'], which beats the bare class. A rule may name
  // several classes at once.
  const names = (selector: string) => selector.split(',').map((one) => one.trim());
  const colour = (name: string) =>
    rules.find((rule) => names(rule.selector).includes(`[data-drop='starts'] .${name}`) && rule.colour !== undefined)?.colour ??
    rules.find((rule) => names(rule.selector).includes(`.${name}`) && rule.colour !== undefined)?.colour;
  const used = [...starts.matchAll(/class="([a-z][a-z0-9- ]*)"/g)].flatMap((tag) => tag[1]!.split(' ')).map(colour);

  // The list tokens.test.ts holds 4.5:1 on the drop box over the hatch, in both themes.
  expect([...new Set(used)].filter((token) => token !== undefined).sort()).toEqual(['amber', 'ink-2', 'muted']);
});

// A card that stores its own model starts on it, so the drop target names that model and not the stage's.
it('says what the dragged card itself starts, when it stores its own model', () => {
  const card = cardFixture({ key: 'APP-1', stage: 'inbox', starts: { refine: { phase: 'refine', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } } });

  const { body } = render(Board, {
    props: { snapshot: boardFixture('pull-request', [card]), now: new Date('2026-09-17T08:00:00Z'), drag: enterColumn(startDrag('APP-1'), 'refine'), allowed: allowOnly('refine') },
  });

  expect(text(body.split('data-stage="').find((part) => part.startsWith('refine')) ?? '')).toContain('Claude Code · opus · high');
});

// The usage window the engine of the row last reported. It is the local board's alone: the readings
// never leave the machine, so a board that hands none draws no line.
describe('the usage window in the drop box', () => {
  const now = new Date('2026-10-12T17:00:00Z');
  const reading = { seenAt: now.getTime() - 60_000, windows: [{ name: 'five_hour', used: 0.62, resetsAt: Date.parse('2026-10-12T19:00:00Z') / 1000, status: 'allowed' }] };
  // Refine carries a measured estimate, so the order of the lines is under test too.
  const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const estimate = { costUsd: 0.053, lowMs: 21_000, highMs: 37_000, from: 'preset' as const, runs: 0 };
  const snapshot = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, estimate } } : stage)) };
  const draw = (limits?: Record<string, typeof reading>) =>
    render(Board, {
      props: { snapshot, now, drag: enterColumn(startDrag('APP-1'), 'refine'), allowed: allowOnly('refine'), ...(limits === undefined ? {} : { limits }) },
    }).body;
  const refineOf = (body: string) => body.slice(body.indexOf('data-stage="refine"'), body.indexOf('data-stage="plan"'));

  it('writes the share and the reset time under the estimate', () => {
    const box = refineOf(draw({ 'claude-code': reading }));

    expect(text(box)).toContain('Claude Code · haiku · low about $0.05 · under a minute 5h window 62% · resets 19:00 Esc cancels.');
    expect(box).toMatch(/<p class="usage[^"]*">5h window 62% · resets 19:00<\/p>/);
  });

  it('writes no window on a board that hands no readings, or for another login', () => {
    expect(refineOf(draw())).not.toContain('5h window');
    expect(refineOf(draw({ 'claude-code#work': reading }))).not.toContain('5h window');
  });

  // The board's clock judges the reading, so a window that reset since, or a reading older than five
  // hours, shows no figure.
  it('writes no window by the board clock once the window reset or the reading is too old', () => {
    const reset = { seenAt: now.getTime() - 3 * 3_600_000, windows: [{ ...reading.windows[0]!, resetsAt: now.getTime() / 1000 - 60 }] };
    const old = { seenAt: now.getTime() - 6 * 3_600_000, windows: [{ ...reading.windows[0]!, resetsAt: now.getTime() / 1000 + 600 }] };

    expect(refineOf(draw({ 'claude-code': reset }))).not.toContain('5h window');
    expect(refineOf(draw({ 'claude-code': old }))).not.toContain('5h window');
  });
});

// The amber ring marks a target whose drop starts a run, folded or open. A move back and a
// refused start are no agent at work, so they are not amber.
describe('the ring on a drop target', () => {
  const gone = refine({ starts: { phase: 'refine', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } });

  it('rings a target that starts a run, folded and open', () => {
    expect(column(refine(), { drag: over('refine'), allowed: allowOnly('refine') })).toContain('data-drop-starts="true"');
    const folded = column(refine(), { drag: over('inbox'), allowed: allowOnly('refine') });
    expect(folded).toContain('data-folded="true"');
    expect(folded).toContain('data-drop-starts="true"');
  });

  it('rings no target that starts nothing', () => {
    expect(column(refine(), { drag: over('refine'), allowed: allowBack('refine') })).not.toContain('data-drop-starts');
    expect(column(gone, { drag: over('refine'), allowed: allowOnly('refine') })).not.toContain('data-drop-starts');
    expect(column(refine(), { drag: over('refine'), allowed: allowOnly() })).not.toContain('data-drop-starts');
  });

  it('draws the ring in amber only on an agent column whose drop starts, and the dashed line on the other folded targets', () => {
    const source = readFileSync(new URL('./BoardColumn.svelte', import.meta.url), 'utf8');
    const style = source.slice(source.indexOf('<style>')).replaceAll(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((found) => found[1]!.trim() === selector)?.[2] ?? '';

    expect(rule("[data-accent='true'][data-drop-starts='true']")).toContain('box-shadow: inset 0 0 0 1.5px var(--amber);');
    expect(rule("[data-folded='true'][data-drop-target='true']:not([data-drop-starts='true'])")).toContain('outline: 1px dashed var(--faint);');
  });
});
