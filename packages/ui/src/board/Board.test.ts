import type { BoardSnapshot } from '@nolzu/protocol';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import Board from './Board.svelte';
import { enterColumn, startDrag } from './drag.ts';
import { boardFixture, cardFixture, stageFixture } from './fixture.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const NOW = new Date('2026-09-27T10:00:00.000Z');

// The PR reviews board, with the two stages this test needs. The stage ids are not what is under
// test here; the sentence under the header is.
const prreview = (cards: BoardSnapshot['cards'] = []): BoardSnapshot => ({
  ...boardFixture('pull-request'),
  kind: 'prreview',
  stages: [stageFixture({ id: 'incoming', label: 'Incoming', role: 'you' }), stageFixture({ id: 'closed', label: 'Closed', role: 'archive' })],
  cards,
});

const draw = (snapshot: BoardSnapshot): string => render(Board, { props: { snapshot, now: NOW } }).body;

// The board says it holds no card. Drawing the board reads no pull request list, so this is board
// emptiness and not a read of GitHub that found nothing.
it('says the board is empty when no card is on it', () => {
  const body = draw(prreview());

  expect(text(body)).toContain('This board has no pull request on it.');
  expect(text(body)).toContain('type the pull request as owner/repo#number');
});

// Add card reads a pull request link as well, and a link always names its owner.
it('says a pull request link from GitHub works too', () => {
  expect(text(draw(prreview()))).toContain('type the pull request as owner/repo#number or paste its link from GitHub.');
});

// Delivery's sentence is wrong on this board twice: a card here comes from a pull request,
// and no stage here starts an agent.
it("keeps Delivery's own steps off the PR reviews board", () => {
  expect(text(draw(prreview()))).not.toContain('an agent starts on this machine');
  expect(text(draw(boardFixture('pull-request')))).toContain('an agent starts on this machine');
});

it('says nothing about an empty board once a card is on it', () => {
  const body = draw(prreview([cardFixture({ key: 'recipes#42', stage: 'incoming' })]));

  expect(text(body)).not.toContain('This board has no pull request on it.');
  expect(body).toContain('data-card="recipes#42"');
});

// A Delivery card whose pull request PR watch found has no review rounds to speak of.
it('says the review round on the PR reviews board alone', () => {
  const pull = { author: 'dana', decision: 'APPROVED' as const, headCommittedAt: null, draft: false, round: null };
  const reviews = draw(prreview([cardFixture({ key: 'recipes#42', stage: 'incoming', pull })]));
  const delivery = draw({ ...boardFixture('pull-request'), cards: [cardFixture({ key: 'APP-1', stage: 'pr-watch', pull })] });

  expect(text(reviews)).toContain('No review round yet');
  expect(delivery).toContain('data-pull="APP-1"');
  expect(text(delivery)).not.toContain('No review round yet');
});

// The activity comes beside the snapshot and the quiet time inside it. The board hands both to the
// card the activity is about, and to no other card.
it('hands each card the activity of its own run and the quiet time of the board', () => {
  const running = cardFixture({ key: 'APP-1', stage: 'refine', state: 'running', runId: 7, runState: 'running', runStartedAt: '2026-09-27T09:50:00.000Z' });
  const other = cardFixture({ key: 'APP-2', stage: 'plan', state: 'running', runId: 9, runState: 'running', runStartedAt: '2026-09-27T09:59:00.000Z' });
  const snapshot = { ...boardFixture('pull-request', [running, other]), quietAfterMs: 5 * 60_000 };
  const activity = { 'APP-1': { runId: 7, cardKey: 'APP-1', line: 'Reading services/api/src/recipes/list.ts', outputAt: NOW.getTime() - 7 * 60_000 } };

  const body = render(Board, { props: { snapshot, now: NOW, activity } }).body;

  expect(body.match(/data-activity="([^"]+)"/g)).toEqual(['data-activity="APP-1"']);
  expect(text(body)).toContain('Quiet 7m');
  expect(body.match(/data-quiet="true"/g)).toHaveLength(1);
});

// Both cards have a line. Each draws its own, so the board must look each card up by its own key.
it('draws the line of each running card from its own activity', () => {
  const first = cardFixture({ key: 'APP-1', stage: 'refine', state: 'running', runId: 7, runState: 'running', runStartedAt: '2026-09-27T09:50:00.000Z' });
  const second = cardFixture({ key: 'APP-2', stage: 'plan', state: 'running', runId: 9, runState: 'running', runStartedAt: '2026-09-27T09:59:00.000Z' });
  const snapshot = { ...boardFixture('pull-request', [first, second]), quietAfterMs: 5 * 60_000 };
  const activity = {
    'APP-1': { runId: 7, cardKey: 'APP-1', line: 'Reading a.ts', outputAt: NOW.getTime() - 2000 },
    'APP-2': { runId: 9, cardKey: 'APP-2', line: 'Running pnpm test', outputAt: NOW.getTime() - 2000 },
  };

  const body = render(Board, { props: { snapshot, now: NOW, activity } }).body;

  expect(body.match(/data-activity="([^"]+)"/g)).toEqual(['data-activity="APP-1"', 'data-activity="APP-2"']);
  expect(body).toContain('title="Reading a.ts"');
  expect(body).toContain('title="Running pnpm test"');
});

// A card folded to one line sits in the column's strip, apart from the open cards. A quiet run
// there must not keep the Running dot, so the strip needs the activity and the quiet time too.
it('says Quiet on a quiet card folded to one line', () => {
  const folded = cardFixture({ key: 'APP-1', stage: 'refine', state: 'running', runId: 7, runState: 'running', runStartedAt: '2026-09-27T09:50:00.000Z', minimized: true });
  const snapshot = { ...boardFixture('pull-request', [folded]), quietAfterMs: 5 * 60_000 };
  const activity = { 'APP-1': { runId: 7, cardKey: 'APP-1', line: null, outputAt: NOW.getTime() - 7 * 60_000 } };

  const body = render(Board, { props: { snapshot, now: NOW, activity } }).body;

  expect(body).toContain('data-minimized="true"');
  expect(body).toContain('data-state="quiet"');
  expect(text(body)).not.toContain('Running');
});

// Two folded cards in one strip, one quiet and one busy. Each reads its own run, so the strip must look
// each card up by its own key and not hand the first card's activity to the second.
it('gives each card folded to one line the activity of its own run', () => {
  const run = (key: string, runId: number) =>
    cardFixture({ key, stage: 'refine', state: 'running', runId, runState: 'running', runStartedAt: '2026-09-27T09:50:00.000Z', minimized: true });
  const snapshot = { ...boardFixture('pull-request', [run('APP-1', 7), run('APP-2', 9)]), quietAfterMs: 5 * 60_000 };
  const activity = {
    'APP-1': { runId: 7, cardKey: 'APP-1', line: null, outputAt: NOW.getTime() - 2000 },
    'APP-2': { runId: 9, cardKey: 'APP-2', line: null, outputAt: NOW.getTime() - 7 * 60_000 },
  };

  const body = render(Board, { props: { snapshot, now: NOW, activity } }).body;
  const second = body.slice(body.indexOf('data-card="APP-2"'));

  expect(body.match(/data-state="quiet"/g)).toHaveLength(1);
  expect(second).toContain('data-state="quiet"');
});

// The first drag's coach note goes inside the first agent column, which stays open to hold it while
// every other empty column folds as before. The board draws only what the page hands it.
it('draws an aside inside the column it names, which stays open, and folds the rest', () => {
  const note = createRawSnippet(() => ({ render: () => '<div role="note">Dropping a card here is your approval</div>' }));
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'RECI-1', stage: 'inbox' })]);
  const column = (body: string, stage: string) => new RegExp(`<section[^>]*data-stage="${stage}"[^>]*>[\\s\\S]*?</section>`).exec(body)?.[0] ?? '';

  const body = render(Board, { props: { snapshot, now: NOW, aside: { stage: 'refine', content: note } } }).body;

  expect(column(body, 'refine')).not.toContain('data-folded');
  expect(column(body, 'refine')).toContain('Dropping a card here is your approval');
  expect(column(body, 'qa')).toContain('data-folded="true"');
  expect(body.match(/role="note"/g)).toHaveLength(1);
  expect(column(draw(snapshot), 'refine')).toContain('data-folded="true"');
});

// While the coach note shows, the first agent column
// holds a resting "Drop here" box, and Plan and Implement stay open with what a drop there does.
it('draws the first drag: a resting drop box, and Plan and Implement open with their hint lines', () => {
  const note = createRawSnippet(() => ({ render: () => '<div role="note">Dropping a card here is your approval</div>' }));
  const column = (body: string, stage: string) => new RegExp(`<section[^>]*data-stage="${stage}"[^>]*>[\\s\\S]*?</section>`).exec(body)?.[0] ?? '';
  const card = cardFixture({ key: 'REC-1', stage: 'inbox' });
  const plain = boardFixture('pull-request', [card]);
  const coached = (snapshot: BoardSnapshot) => render(Board, { props: { snapshot, now: NOW, aside: { stage: 'refine', content: note } } }).body;

  const body = coached(plain);
  const rest = /<div class="drop rest[^"]*" data-drop="rest">([\s\S]*?)<\/div>/.exec(column(body, 'refine'))?.[1] ?? '';
  expect(text(rest)).toBe('Drop here');
  expect(column(body, 'plan')).not.toContain('data-folded');
  expect(text(column(body, 'plan'))).toContain('Drop a card to plan it');
  expect(column(body, 'implement')).not.toContain('data-folded');
  expect(text(column(body, 'implement'))).toContain('Drop a card to build it');
  expect(column(body, 'qa')).toContain('data-folded="true"');
  // No amber outline and no "Drag me to Refine" chip on the card.
  expect(text(body)).not.toContain('Drag me');
  // Without the note the first board folds them as before.
  expect(column(draw(plain), 'plan')).toContain('data-folded="true"');
  expect(draw(plain)).not.toContain('Drop a card to');

  // The figure only where measured, in the drop box's own "about" words.
  const estimate = { costUsd: 0.053, lowMs: 21_000, highMs: 37_000, from: 'preset' as const, runs: 0 };
  const measured = { ...plain, stages: plain.stages.map((stage) => (stage.id === 'refine' && stage.starts !== null ? { ...stage, starts: { ...stage.starts, estimate } } : stage)) };
  expect(text(column(coached(measured), 'refine'))).toContain('Drop here about $0.05 · under a minute');
});

// Closed folds while it holds cards, and a click on its strip opens it.
it('folds Closed over its cards until it is opened, and keeps its cards out of reach meanwhile', () => {
  const closed = (n: number) => cardFixture({ key: `APP-${n}`, stage: 'closed' });
  const snapshot = { ...boardFixture('pull-request', [closed(1), closed(2)]), stages: boardFixture('pull-request').stages.map((stage) => (stage.id === 'closed' ? { ...stage, count: 2 } : stage)) };
  const column = (body: string) => /<section[^>]*data-stage="closed"[^>]*>[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';

  const shut = draw(snapshot);
  expect(column(shut)).toContain('data-folded="true"');
  expect(column(shut)).toMatch(/<button class="unfold[^"]*" type="button" aria-label="Show Closed, 2 cards">/);
  expect(column(shut)).not.toContain('data-card=');
  // No card is reachable, so no card is the tab stop.
  expect(shut).not.toContain('tabindex="0"');

  const open = render(Board, { props: { snapshot, now: NOW, archiveOpen: true } }).body;
  expect(column(open)).not.toContain('data-folded');
  expect(column(open)).toContain('data-card="APP-1"');
  expect(open).toContain('tabindex="0"');
});

// A failed QA card gets its own amber Fix it.
it('draws Fix it on a QA FAIL card only where the page runs it and the board has an Implement column', () => {
  const failed = cardFixture({ key: 'APP-9', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'Empty list, not the message.' });
  const snapshot = boardFixture('pull-request', [failed, cardFixture({ key: 'APP-1', stage: 'inbox' })]);
  const fix = (body: string) => body.match(/<button[^>]*data-fix="[^"]*"[^>]*>/g) ?? [];

  const body = render(Board, { props: { snapshot, now: NOW, onFix: () => {} } }).body;
  expect(fix(body)).toHaveLength(1);
  expect(fix(body)[0]).toContain('data-fix="APP-9"');
  expect(fix(body)[0]).toMatch(/class="btn go sm/);
  expect(text(body)).toContain('Fix it');
  expect(fix(draw(snapshot))).toEqual([]);
  const noImplement = { ...snapshot, stages: snapshot.stages.filter((stage) => stage.id !== 'implement') };
  expect(fix(render(Board, { props: { snapshot: noImplement, now: NOW, onFix: () => {} } }).body)).toEqual([]);
});

// Mutation round: an empty Closed is a plain folded strip, not a button that opens nothing.
it('folds an empty Closed as a strip without an unfold button', () => {
  const body = draw(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]));
  const closed = /<section[^>]*data-stage="closed"[^>]*>[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';

  expect(closed).toContain('data-folded="true"');
  expect(closed).not.toContain('unfold');
});

// Mutation round: the hint lines belong to the empty columns, and a real drag swaps the resting box out.
it('keeps a hint off a column that holds a card, and draws no resting box under a drag', () => {
  const note = createRawSnippet(() => ({ render: () => '<div role="note">Dropping a card here is your approval</div>' }));
  const column = (body: string, stage: string) => new RegExp(`<section[^>]*data-stage="${stage}"[^>]*>[\\s\\S]*?</section>`).exec(body)?.[0] ?? '';
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'REC-1', stage: 'inbox' }), cardFixture({ key: 'REC-2', stage: 'plan' })]);
  const aside = { stage: 'refine', content: note };

  const body = render(Board, { props: { snapshot, now: NOW, aside } }).body;
  expect(text(column(body, 'plan'))).not.toContain('Drop a card to plan it');
  expect(text(column(body, 'implement'))).toContain('Drop a card to build it');

  const dragging = render(Board, { props: { snapshot, now: NOW, aside, drag: enterColumn(startDrag('REC-1'), 'refine'), allowed: (id: string) => (id === 'refine' ? 'forward' : false) } }).body;
  expect(dragging).not.toContain('data-drop="rest"');
  expect(dragging).toMatch(/data-drop="(?!rest)/);
});

// An empty board says its first step inside its first column, as a placeholder card, and draws no
// line above the board. The other columns stay folded.
it('puts the first-run words in a placeholder card in the first column of an empty board', () => {
  const body = draw(prreview());
  const board = body.slice(body.indexOf('class="board'));

  expect(body.indexOf('Press N, or Add pull request')).toBeGreaterThan(body.indexOf('class="board'));
  expect(board.match(/data-placeholder/g)).toHaveLength(1);
  expect(board.indexOf('data-placeholder')).toBeLessThan(board.indexOf('data-stage="closed"'));
  expect(text(body)).toContain('Incoming');
  expect(text(body)).toContain('Closed');
});

// Every board says it the same way, in one sentence of its own: what goes here, how to add one and
// the key to press. Epics too, whose Inbox folded with nothing in it.
it.each([
  ['delivery', 'This board has no card on it. Press N, or Add card,'],
  ['epics', 'This board has no epic on it. Press N, or Add epic,'],
] as const)('opens the Inbox of an empty %s board with its own sentence', (kind, sentence) => {
  const body = draw({ ...boardFixture('pull-request'), kind });
  const card = body.slice(body.indexOf('data-placeholder'), body.indexOf('data-stage="refine"'));

  expect(body.match(/data-placeholder/g)).toHaveLength(1);
  expect(body).toMatch(/data-stage="inbox"(?![^>]*data-folded)/);
  expect(text(card)).toContain(sentence);
  expect(card).not.toContain('<li');
});

it('says what a drag on starts on Epics', () => {
  expect(text(draw({ ...boardFixture('pull-request'), kind: 'epics' }))).toContain('an agent plans it into tasks for Delivery');
});

// The sentence is small text on the card's dashed box, so it takes --muted to pass AA in both themes,
// and no margin of its own so the box's padding is the only space around it.
it('draws the empty Inbox sentence in --muted with no margin', () => {
  const style = readFileSync(new URL('./EmptyInbox.svelte', import.meta.url), 'utf8').split('<style>')[1] ?? '';

  expect(style).toContain('color: var(--muted);');
  expect(style).toContain('margin: 0;');
  expect(style).not.toMatch(/--faint|opacity/);
});

// The filter box narrows by key or title on the client, and says so once when nothing matches.
it('shows only the cards the filter matches, and one line when none does', () => {
  const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', title: 'Add tags', stage: 'inbox' }), cardFixture({ key: 'APP-2', title: 'Rate a recipe', stage: 'inbox' })]);
  const narrowed = render(Board, { props: { snapshot, now: NOW, query: 'tags' } }).body;

  expect(narrowed).toContain('data-card="APP-1"');
  expect(narrowed).not.toContain('data-card="APP-2"');
  const none = text(render(Board, { props: { snapshot, now: NOW, query: 'search' } }).body);
  expect(none.match(/No card matches the filter\./g)).toHaveLength(1);
  expect(none).not.toContain('Nothing waiting on you.');
  // The board still has cards, so it gets no first steps.
  expect(none).not.toContain('Press N');
});
