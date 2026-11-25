import { readFileSync } from 'node:fs';
import type { StageView, StartsDescriptor } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Board from './Board.svelte';
import BoardColumn from './BoardColumn.svelte';
import { enterColumn, startDrag } from './drag.ts';
import { boardFixture, cardFixture, stageFixture } from './fixture.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

it('renders one column per stage, in board order', () => {
  const { body } = render(Board, { props: { snapshot: boardFixture('pull-request') } });
  const labels = [...body.matchAll(/data-stage="([^"]+)"/g)].map((match) => match[1]);

  expect(labels).toEqual(['inbox', 'refine', 'plan', 'implement', 'qa', 'review', 'pr-watch', 'wrapup', 'closed']);
});

it('shows the label, the role word and the count in the header', () => {
  const stage = stageFixture({ id: 'refine', label: 'Refine', role: 'agent', count: 3 });
  const { body } = render(BoardColumn, { props: { stage, cards: [cardFixture({ key: 'APP-1', stage: 'refine' })] } });
  const header = text(/<header[^>]*>([\s\S]*?)<\/header>/.exec(body)?.[1] ?? '');

  expect(header).toContain('Refine');
  // The role is a word and not only a glyph, because status is never colour or shape alone.
  expect(header).toContain('Agent');
  expect(header).toContain('3');
  expect(body).toContain('data-count="3"');
});

it('puts a minimized card in the strip and leaves it out of the body', () => {
  const stage = stageFixture({ id: 'inbox', label: 'Inbox', role: 'you', count: 3 });
  const cards = [
    cardFixture({ key: 'APP-1' }),
    cardFixture({ key: 'APP-2' }),
    cardFixture({ key: 'APP-3', minimized: true }),
  ];
  const { body } = render(BoardColumn, { props: { stage, cards } });

  const strip = body.slice(body.indexOf('data-minimized-strip'));
  expect(strip).toContain('APP-3');
  expect(strip).not.toContain('APP-1');
  expect(body).toContain('data-count="3"');
});

// An empty column folds to a strip, which says its name and count and nothing else. The old line
// "Nothing waiting on you" went with it, and it was wrong on an agent column anyway.
it('folds an empty column and shows no empty line and no illustration', () => {
  const stage = stageFixture({ id: 'inbox', label: 'Inbox', role: 'you' });
  const { body } = render(BoardColumn, { props: { stage, cards: [] } });

  expect(body).toContain('data-folded="true"');
  expect(body).not.toContain('<img');
});

it('marks an agent stage that starts no phase, and says so in words', () => {
  // Without the marker the column would promise a run that never starts.
  const stage = stageFixture({ id: 'merge', label: 'Merge', role: 'agent' });
  const { body } = render(BoardColumn, { props: { stage, cards: [] } });

  expect(text(body)).toContain('starts nothing yet');
  expect(body).toContain('data-starts-nothing="true"');
  // It looks like a human column: no amber line promising a run.
  expect(body).not.toContain('data-accent');
});

it('does not mark an agent stage that does start a phase', () => {
  const stage = stageFixture({
    id: 'refine',
    label: 'Refine',
    role: 'agent',
    starts: { phase: 'refine', model: 'haiku', effort: 'low', engine: 'claude-code', modelState: 'ok', refusal: null },
  });
  const { body } = render(BoardColumn, { props: { stage, cards: [] } });

  expect(text(body)).not.toContain('starts nothing');
  expect(body).toContain('data-accent="true"');
});

it('shows the poll cadence of an auto stage word for word, open and folded', () => {
  const stage = stageFixture({ id: 'pr-watch', label: 'Pull request', role: 'auto', cadence: 'every 25 min, Mon to Fri' });
  const open = render(BoardColumn, { props: { stage, cards: [cardFixture({ key: 'APP-1', stage: 'pr-watch' })] } }).body;

  expect(headLine(open)).toBe('every 25 min, Mon to Fri');
  expect(text(render(BoardColumn, { props: { stage, cards: [] } }).body)).toContain('every 25 min, Mon to Fri');
});

it('shows no cadence line for a stage that polls nothing', () => {
  const stage = stageFixture({ id: 'inbox', label: 'Inbox', role: 'you' });
  expect(text(render(BoardColumn, { props: { stage, cards: [] } }).body)).not.toContain('every');
});

it('marks the archive column, so the styling has something to hang on', () => {
  const stage = stageFixture({ id: 'closed', label: 'Closed', role: 'archive' });
  const { body } = render(BoardColumn, { props: { stage, cards: [] } });

  expect(body).toContain('data-role="archive"');
  expect(body).not.toContain('data-accent');
});

it('draws the elapsed time from the clock the board passes down', () => {
  // The board never passed a clock, so every card read its own default once and the elapsed time
  // then stood still for the life of the page.
  const cards = [
    cardFixture({ key: 'APP-1', stage: 'refine', state: 'running', runStartedAt: '2026-09-16T10:00:00.000Z' }),
  ];
  const { body } = render(Board, {
    props: { snapshot: boardFixture('pull-request', cards), now: new Date('2026-09-16T10:01:30.000Z') },
  });

  expect(text(body)).toContain('1m 30s');
});

// Five cards, two of them waiting on a person.
const FIVE = boardFixture('pull-request', [
  cardFixture({ key: 'APP-1', stage: 'inbox', state: 'idle' }),
  cardFixture({ key: 'APP-2', stage: 'refine', state: 'ready' }),
  cardFixture({ key: 'APP-3', stage: 'refine', state: 'running' }),
  cardFixture({ key: 'APP-4', stage: 'plan', state: 'blocked', question: 'Titles only?' }),
  cardFixture({ key: 'APP-5', stage: 'plan', state: 'queued' }),
]);
const counted = { ...FIVE, stages: FIVE.stages.map((stage) => ({ ...stage, count: FIVE.cards.filter((card) => card.stage === stage.id).length })) };
const keys = (body: string) => [...body.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1]);

it('shows only the cards waiting on me with the filter on, and every column header still', () => {
  const { body } = render(Board, { props: { snapshot: counted, filtered: true } });

  expect(keys(body)).toEqual(['APP-2', 'APP-4']);
  expect([...body.matchAll(/data-stage="([^"]+)"/g)]).toHaveLength(9);
});

it('counts the shown cards with the filter on, and names the full count in the title', () => {
  const { body } = render(Board, { props: { snapshot: counted, filtered: true } });
  const refine = /data-stage="refine"[\s\S]*?<span class="count[^"]*"([^>]*)>(\d+)/.exec(body);

  expect(refine?.[2]).toBe('1');
  expect(refine?.[1]).toContain('title="1 of 2 cards"');
  // The inbox shows none of its one card, and the word follows the total.
  expect(body).toContain('title="0 of 1 card"');
});

// The empty line, the same words Now uses.
it('says once that nothing is waiting, when the filter matches no card', () => {
  const none = { ...counted, cards: counted.cards.filter((card) => card.state === 'idle') };
  const shown = text(render(Board, { props: { snapshot: none, filtered: true } }).body);

  expect(shown.match(/Nothing waiting on you\./g)).toHaveLength(1);
});

it('says how to add a card, naming N, on a board with no cards', () => {
  const body = render(Board, { props: { snapshot: boardFixture('pull-request') } }).body;

  expect(text(body)).toMatch(/Press N, or Add card/);
});

// Every board kind opens its empty Inbox with a sentence of its own, Epics and the research kinds too.
it.each([
  ['epics', 'no epic on it'],
  ['investigations', 'no question or investigation on it'],
  ['questions', 'no question or investigation on it'],
] as const)('says its own first step on an empty %s board', (kind, words) => {
  const body = render(Board, { props: { snapshot: { ...boardFixture('pull-request'), kind } } }).body;

  expect(body).not.toContain('<ol');
  expect(text(body)).toContain(words);
});

it('shows no hint once the board has a card', () => {
  expect(text(render(Board, { props: { snapshot: counted } }).body)).not.toMatch(/Press N/);
});

it('opens only the first column on a board with no cards, for the placeholder card', () => {
  const body = render(Board, { props: { snapshot: boardFixture('pull-request') } }).body;

  expect(body.match(/data-folded="true"/g)).toHaveLength(8);
  expect(body.match(/<header/g)).toHaveLength(1);
});

// A live region added together with its text is often not read out, so the line is always there.
it('keeps the status line in the page while the filter still matches cards', () => {
  const body = render(Board, { props: { snapshot: counted, filtered: true } }).body;

  expect(body).toMatch(/<p class="nothing[^"]*" role="status"><\/p>/);
});

it('says the full count in words a screen reader reads, not only in the title', () => {
  const body = render(Board, { props: { snapshot: counted, filtered: true } }).body;
  const refine = /data-stage="refine"[\s\S]*?<span class="count[^"]*"[^>]*>([\s\S]*?)<\/header>/.exec(body)?.[1] ?? '';

  expect(text(refine)).toBe('1 of 2');
});

// One card is the board's tab stop, so Tab reaches the board once and the arrows do the rest.
const tabStops = (body: string) => [...body.matchAll(/data-card="([^"]+)"[^>]*tabindex="0"|tabindex="0"[^>]*data-card="([^"]+)"/g)].map((match) => match[1] ?? match[2]);

it('makes the first visible card the only tab stop when nothing is selected', () => {
  const body = render(Board, { props: { snapshot: counted } }).body;

  expect(tabStops(body)).toEqual(['APP-1']);
  expect(body.match(/<article[^>]*tabindex="-1"/g)).toHaveLength(4);
});

it('makes the selected card the only tab stop', () => {
  expect(tabStops(render(Board, { props: { snapshot: counted, selected: 'APP-4' } }).body)).toEqual(['APP-4']);
});

// The arrows reach a card folded to one line too, so the strip must compare each card's own key.
it('makes a selected card in the minimized strip the only tab stop', () => {
  const folded = (key: string) => cardFixture({ key, stage: 'refine', minimized: true });
  const snapshot = boardFixture('pull-request', [folded('APP-1'), folded('APP-2')]);

  expect(tabStops(render(Board, { props: { snapshot, selected: 'APP-2' } }).body)).toEqual(['APP-2']);
});

it('falls back to the first visible card when the selected one is hidden by the filter', () => {
  expect(tabStops(render(Board, { props: { snapshot: counted, selected: 'APP-1', filtered: true } }).body)).toEqual(['APP-2']);
});

it('says card, not cards, in the title of a column with one card', () => {
  const stage = (count: number) => stageFixture({ id: 'refine', label: 'Refine', role: 'agent', count });
  const one = render(BoardColumn, { props: { stage: stage(1), cards: [] } }).body;
  const two = render(BoardColumn, { props: { stage: stage(2), cards: [] } }).body;

  expect(one).toContain('title="1 card"');
  expect(two).toContain('title="2 cards"');
});

// The board columns: one stage per role, folded while empty and open with a card.
const haiku: StartsDescriptor = { phase: 'refine', model: 'haiku', effort: 'low', engine: 'claude-code', modelState: 'ok', refusal: null };
const measured = { ...haiku, estimate: { costUsd: 0.053, lowMs: 21_000, highMs: 37_000, from: 'preset' as const, runs: 0 } };
const ROLES: Record<string, StageView> = {
  you: stageFixture({ id: 'inbox', label: 'Inbox', role: 'you', says: 'you pick what goes next' }),
  agent: stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts: measured }),
  auto: stageFixture({ id: 'pr-watch', label: 'Pull request', role: 'auto', says: 'waits on GitHub' }),
  archive: stageFixture({ id: 'closed', label: 'Closed', role: 'archive' }),
};
const holding = (stage: StageView) => [cardFixture({ key: 'APP-1', stage: stage.id })];
const draw = (stage: StageView, props: Record<string, unknown> = {}) => render(BoardColumn, { props: { stage, cards: [], ...props } }).body;
// The line under the column name: everything between the header and the body.
const headLine = (body: string) => text(body.slice(body.indexOf('</header>'), body.indexOf('<div class="body')));
// A card dragged with the pointer over the Refine column, which takes it.
const target = { drag: enterColumn(startDrag('APP-9'), 'refine'), allowed: () => 'forward' as const };

describe('the board columns', () => {
  it.each(Object.entries(ROLES))('folds an empty %s column to a strip that keeps its group, name and count', (_role, stage) => {
    const body = draw(stage);

    expect(body).toContain('data-folded="true"');
    expect(body).toContain('role="group"');
    expect(body).toContain(`aria-label="${stage.label}"`);
    expect(body).toContain(`data-stage="${stage.id}"`);
    // The count is read out as words, because a bare 0 after a name says nothing.
    expect(text(body)).toContain(`${stage.label} 0 cards`);
    expect(body).not.toContain('<header');
    expect(body).not.toContain('class="body');
  });

  // The hatch and the amber glyph mark an agent column that starts work, folded or
  // open, and no other. RoleGlyph paints amber only on an agent glyph not marked as starting nothing.
  it.each(Object.entries(ROLES))('paints the hatch and the amber glyph on a %s column only where an agent starts work', (role, stage) => {
    for (const body of [draw(stage), draw({ ...stage, count: 1 }, { cards: holding(stage) })]) {
      if (role === 'agent') {
        expect(body).toContain('data-accent="true"');
        expect(body).not.toContain('data-starts-nothing="true"');
      } else {
        expect(body).not.toContain('data-accent');
      }
    }
  });

  it.each(Object.entries(ROLES))('opens a %s column that holds a card', (_role, stage) => {
    const body = draw({ ...stage, count: 1 }, { cards: holding(stage) });

    expect(body).not.toContain('data-folded');
    expect(body).toContain('<header');
    expect(body).toContain('data-card="APP-1"');
  });

  it('writes the line each role draws under its name', () => {
    const line = (stage: StageView) => headLine(draw(stage, { cards: holding(stage) }));

    expect(line(ROLES.you!)).toBe('you pick what goes next');
    expect(line(ROLES.auto!)).toBe('waits on GitHub');
    expect(line(ROLES.agent!)).toBe('Claude Code · haiku · low · ~$0.05');
    expect(line(ROLES.archive!)).toBe('');
    // A column that starts nothing promises nothing, and its glyph says why.
    expect(line(stageFixture({ id: 'wrapup', label: 'Wrap-up', role: 'agent' }))).toBe('');
  });

  // A figure only where estimateOf gave one, never a made-up number.
  it('prints no figure in the header of a start nothing measured', () => {
    const stage = stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts: haiku });

    expect(headLine(draw(stage, { cards: holding(stage) }))).toBe('Claude Code · haiku · low');
  });

  it('prints the time in the header when no run reported a cost', () => {
    const stage = stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts: { ...measured, estimate: { ...measured.estimate, costUsd: null } } });

    expect(headLine(draw(stage, { cards: holding(stage) }))).toBe('Claude Code · haiku · low · under a minute');
  });

  // A strip prints its name and count. The open header says what starts.
  it('shows only the name and the count on a folded strip, an agent strip too', () => {
    expect(text(draw(ROLES.agent!))).toMatch(/ Refine 0 cards$/);
    expect(draw(ROLES.agent!)).not.toContain('Starts:');
    expect(text(draw(ROLES.you!))).not.toContain('you pick');
    expect(text(draw(ROLES.auto!))).not.toContain('waits on');
  });

  // A refused start starts no agent, so the column is plain and only its line says why.
  it.each([
    ['a gone model', { ...haiku, model: 'sonnet', modelState: 'gone' as const }],
    ['a missing login', { ...haiku, modelState: 'no-profile' as const }],
    ['a phase the vendor cannot run', { ...haiku, refusal: 'Cursor CLI cannot run refine.' }],
  ])('paints no hatch and no amber glyph on an agent column refused for %s', (_why, starts) => {
    const body = draw(stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts }), { cards: [cardFixture({ key: 'APP-1', stage: 'refine' })] });

    expect(body).not.toContain('data-accent');
    expect(body).toContain('data-starts-nothing="true"');
    expect(headLine(body)).toMatch(/^Refused\. /);
  });

  // Geist Mono is for models and costs. A person's line is words, so it stays in Geist.
  it('sets the Starts line in mono and a person line in words', () => {
    const starts = draw(ROLES.agent!, { cards: holding(ROLES.agent!) });
    const says = draw(ROLES.you!, { cards: holding(ROLES.you!) });

    expect(starts).toMatch(/<p class="line starts[ "]/);
    expect(says).toMatch(/<p class="line[ "]/);
    expect(says).not.toMatch(/<p class="line starts/);
  });

  it('names a refused start in the header, and only the name and count on the strip', () => {
    const gone = stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts: { ...haiku, model: 'sonnet', modelState: 'gone' } });

    expect(headLine(draw(gone, { cards: holding(gone) }))).toBe('Refused. sonnet is gone. Pick another model in the card settings, or in Settings, Models.');
    expect(text(draw(gone))).toMatch(/ Refine 0 cards$/);
    expect(text(draw(gone))).not.toContain('sonnet is gone');
  });

  it('opens an empty column the card may land on once the pointer is over it, so the drop box shows', () => {
    const body = draw(ROLES.agent!, target);

    expect(body).not.toContain('data-folded');
    expect(body).toContain('data-drop-target="true"');
    expect(body).toContain('data-drop="starts"');
  });

  // Opening it at the start of the drag would move the columns under a pointer that has not moved.
  it('keeps an empty column the card may land on folded and marked while the pointer is elsewhere', () => {
    const body = draw(ROLES.agent!, { ...target, drag: enterColumn(startDrag('APP-9'), 'inbox') });

    expect(body).toContain('data-folded="true"');
    expect(body).toContain('data-drop-target="true"');
    expect(body).not.toContain('data-drop=');
  });

  it('keeps an empty column the card may not land on folded, even with the pointer over it', () => {
    const body = draw(ROLES.agent!, { drag: enterColumn(startDrag('APP-9'), 'refine'), allowed: () => false });

    expect(body).toContain('data-folded="true"');
    expect(body).not.toContain('data-drop-target');
  });

  // The header and the drop box read one stage, so they cannot name two models or two figures.
  it('names the model, the effort and the cost the drop box names', () => {
    const body = draw(ROLES.agent!, target);
    const box = /data-drop="starts"[\s\S]*?class="command[^"]*">([^<]*)<[\s\S]*?class="estimate[^"]*">([^<]*)</.exec(body);

    expect(box![1]).toBe('Claude Code · haiku · low');
    // The box keeps "about", and the header takes the short "~".
    expect(box![2]).toBe('about $0.05 · under a minute');
    expect(headLine(body)).toBe('Claude Code · haiku · low · ~$0.05');
  });

  // A row moved to another vendor reads as that vendor, so the header never names a model alone.
  it('names the engine a drop starts on, as the drop box does', () => {
    const stage = stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts: { ...measured, engine: 'cursor', model: 'gpt-5.3-codex-low', effort: 'high' } });

    expect(headLine(draw(stage, { cards: holding(stage) }))).toBe('Cursor · gpt-5.3-codex-low · ~$0.05');
  });

  it("follows the dragged card's own model in the header, as the drop box does", () => {
    const card = cardFixture({ key: 'APP-1', stage: 'inbox', starts: { refine: { ...haiku, model: 'opus', effort: 'high' } } });
    const body = render(Board, {
      props: { snapshot: boardFixture('pull-request', [card]), drag: enterColumn(startDrag('APP-1'), 'refine'), allowed: (id: string) => (id === 'refine' ? 'forward' : false), now: new Date(0) },
    }).body;
    const refine = body.slice(body.indexOf('data-stage="refine"'), body.indexOf('data-stage="plan"'));

    expect(headLine(refine)).toBe('Claude Code · opus · high');
    expect(text(refine)).toContain('Drop to start Refine Claude Code · opus · high');
  });

  // Amber only where an agent starts work. In a column that is the hatch and the
  // glyph of an agent column that starts a run, and the drop box of a drop that starts one.
  it('paints amber and the hatch only on a column or a drop box that starts a run', () => {
    const source = readFileSync(new URL('./BoardColumn.svelte', import.meta.url), 'utf8');
    const style = source.slice(source.indexOf('<style>')).replaceAll(/\/\*[\s\S]*?\*\//g, '');
    const amber = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((rule) => /--(amber|hatch)/.test(rule[2]!)).map((rule) => rule[1]!.trim());

    expect(amber.length).toBeGreaterThan(0);
    expect(amber.filter((selector) => !selector.includes("[data-accent='true']") && !selector.includes("[data-drop='starts']"))).toEqual([]);
  });

  // A strip opens under the pointer. If the element the pointer is on went away with the fold, a
  // browser may send its leave to no column, and the column would stay open after the pointer left.
  it('lets the drag enter a folded target strip itself and none of its children', () => {
    const source = readFileSync(new URL('./BoardColumn.svelte', import.meta.url), 'utf8');
    const style = source.slice(source.indexOf('<style>')).replaceAll(/\/\*[\s\S]*?\*\//g, '');

    expect(style).toMatch(/\[data-folded='true'\]\[data-drop-target='true'\] > \* \{\s*pointer-events: none;\s*\}/);
  });

  it('draws the hatch from the token, with its stripes at 135 degrees', () => {
    const source = readFileSync(new URL('./BoardColumn.svelte', import.meta.url), 'utf8');

    expect(source).toContain('repeating-linear-gradient(135deg, var(--hatch) 0 6px, transparent 6px 12px)');
  });

  // Nine Delivery columns at 1440, beside the rail folded to its 56px on a board: five hold cards and
  // four are empty. The open ones share the width at no less than their minimum and the empty ones
  // fold, so the row fits with no sideways scroll. A fixed column width would not, and is not allowed.
  it('fits nine Delivery columns at 1440, five open and four folded, with no sideways scroll', () => {
    const tokens = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
    const space = (n: string) => Number(new RegExp(`--space-${n}: (\\d+)px;`).exec(tokens)![1]);
    const rules = (name: string) => {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      const style = source.slice(source.indexOf('<style>') + '<style>'.length).replaceAll(/\/\*[\s\S]*?\*\//g, '');
      return new Map([...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => [rule[1]!.trim(), rule[2]!]));
    };
    const column = rules('BoardColumn.svelte').get('.column')!;
    const strip = rules('BoardColumn.svelte').get("[data-folded='true']")!;
    const board = rules('Board.svelte').get('.board')!;

    expect(column).toContain('flex: 1 1 0;');
    expect(column).not.toMatch(/(^|[\s;])width:/);
    expect(board).toContain('overflow-x: auto;');
    const min = Number(/min-width: (\d+)px;/.exec(column)![1]);
    const folded = Number(/flex: 0 0 (\d+)px;/.exec(strip)![1]);
    const gap = space(/gap: var\(--space-(\d)\);/.exec(board)![1]!);
    const side = space(/padding: var\(--space-\d\) var\(--space-(\d)\)/.exec(board)![1]!);

    expect(5 * min + 4 * folded + 8 * gap + 2 * side).toBeLessThanOrEqual(1440 - 56);
  });

  // One open column on a wide screen took the whole row, so a card read as one long line. An open
  // column stops at a maximum no column of a 1440px board reaches, and the row stays packed on the
  // left: the folded strips follow the last open column and the spare width stays empty on the right.
  it('caps an open column at a width no 1440px board reaches, with the row packed on the left', () => {
    const rules = (name: string) => {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      const style = source.slice(source.indexOf('<style>') + '<style>'.length).replaceAll(/\/\*[\s\S]*?\*\//g, '');
      return new Map([...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => [rule[1]!.trim(), rule[2]!]));
    };
    const column = rules('BoardColumn.svelte').get('.column')!;
    const strip = rules('BoardColumn.svelte').get("[data-folded='true']")!;
    const board = rules('Board.svelte').get('.board')!;
    const max = Number(/max-width: (\d+)px;/.exec(column)?.[1]);

    expect(max).toBeGreaterThanOrEqual(360);
    expect(max).toBeLessThanOrEqual(420);
    // The widest open column: Epics at 1440, four open beside five folded and the 56px rail.
    expect(max).toBeGreaterThan((1440 - 56 - 40 - 5 * 40 - 8 * 8) / 4);
    expect(strip).toContain('flex: 0 0 40px;');
    expect(board).not.toMatch(/justify-content:\s*(?!flex-start|start)/);
    expect(board).not.toMatch(/margin:\s*[^;]*auto/);
  });

  it.each(['BoardColumn.svelte', 'Board.svelte'])('sets no colour literal in %s', (name) => {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/oklch\(|rgba?\(|hsla?\(/);
  });

  // Svelte drops the space at the start of an element, so " cards" inside the hidden span read as "0cards"
  // to a screen reader. The space sits between the nodes, which text() cannot see, so this reads the
  // raw markup.
  it('keeps the space before the words a screen reader hears after a count', () => {
    // Hydration comments are no text, in the browser or to a screen reader, so they go first.
    const raw = (body: string) => body.replaceAll(/<!--[\s\S]*?-->/g, '');
    const folded = raw(draw(ROLES.agent!));
    const board = raw(render(Board, { props: { snapshot: counted, filtered: true } }).body);
    const inbox = board.slice(board.indexOf('data-stage="inbox"'), board.indexOf('data-stage="refine"'));
    const refine = board.slice(board.indexOf('data-stage="refine"'), board.indexOf('data-stage="plan"'));

    expect(folded).toMatch(/>0<\/span> <span class="hidden[^"]*">cards<\/span>/);
    expect(inbox).toMatch(/>0<\/span> <span class="hidden[^"]*">of 1<\/span> <span class="hidden[^"]*">card<\/span>/);
    expect(refine).toMatch(/>1<\/span> <span class="hidden[^"]*">of 2<\/span>/);
  });

  it('keeps the filtered count and its title on a folded column', () => {
    const body = render(Board, { props: { snapshot: counted, filtered: true } }).body;
    const inbox = body.slice(body.indexOf('data-stage="inbox"'), body.indexOf('data-stage="refine"'));

    expect(inbox).toContain('data-folded="true"');
    expect(inbox).toContain('title="0 of 1 card"');
    expect(text(inbox)).toContain('Inbox 0 of 1 card');
  });
});
