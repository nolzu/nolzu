import { type Segment, spendOf, type StripRun } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import CardRecord from './CardRecord.svelte';

// Svelte's markers are no space in the browser, so they are dropped before the tags read as one.
const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const run = (id: number, phase: string, over: Partial<StripRun> = {}): StripRun => ({
  id,
  phase,
  state: 'complete',
  model: 'sonnet',
  effort: 'medium',
  costUsd: 0.12,
  durationMs: 130_000,
  tokens: null,
  question: null,
  ...over,
});
const segment = (phase: string, label: string, runs: StripRun[]): Segment => ({ phase, label, run: runs.at(-1) ?? null, count: runs.length, spend: spendOf(runs) });

const RUNS = [run(1, 'plan'), run(2, 'qa', { verdict: 'PASS', costUsd: 0.21, durationMs: 185_000 })];
const STRIP = [segment('plan', 'Plan', [RUNS[0]!]), segment('qa', 'QA', [RUNS[1]!])];
// The page's clock, a Tuesday. The suite runs with TZ=UTC, so the full time on hover is the one written here.
const NOW = new Date('2026-10-20T11:00:00Z');
const MOVES = [
  { label: 'Plan', said: 'moved by you', at: '2026-10-17T14:02:00Z', phase: 'plan' },
  { label: 'Inbox', said: 'moved by you', at: '2026-10-17T14:30:00Z', phase: null },
  { label: 'Plan', said: 'moved by you', at: '2026-10-19T09:40:00Z', phase: 'plan' },
  { label: 'QA', said: 'moved by you', at: '2026-10-20T09:28:00Z', phase: 'qa' },
  { label: 'Review', said: 'moved by Nolzu', at: '2026-10-20T09:31:00Z', phase: null },
  { label: 'Closed', said: 'moved by you', at: '2026-10-20T10:52:00Z', phase: null },
];
const draw = (moves = MOVES, runs = RUNS) => render(CardRecord, { props: { strip: STRIP, spend: spendOf(runs), moves, logBase: '/t/APP-1/log', now: NOW } }).body;
const rows = (body: string) => [...body.matchAll(/<li[\s\S]*?<\/li>/g)].map((match) => text(match[0]));

it('totals the cost, the agent time and the runs of the card', () => {
  expect(text(/<section class="totals[\s\S]*?<\/section>/.exec(draw())?.[0] ?? '')).toBe('$0.33 cost, estimated 5m 15s agent time 2 runs');
});

it('lists every move in order, with who made it and when', () => {
  expect(rows(draw()).map((row) => row.split(' moved by ')[1] ?? row)).toEqual(['you, 3 days ago', 'you, 3 days ago', 'you, yesterday', 'you, 1 hour ago', 'Nolzu, 1 hour ago', 'you, 8 minutes ago']);
});

// A clock time alone does not say the day. The full date and time is on hover.
it('draws each time as a time element with the full date and time on hover', () => {
  expect(draw()).toContain('<time datetime="2026-10-20T10:52:00Z" title="Tuesday, 20 October 2026 at 10:52">8 minutes ago</time>');
});

// Plan was moved into twice. Its run belongs to the newest of the two, so the record shows it once.
it('shows a run with the newest move that started its phase, and only there', () => {
  const [first, , second, qa] = rows(draw());

  expect(first).toBe('Plan moved by you, 3 days ago');
  expect(second).toBe('Plan 2m 10s · $0.12 Log of the Plan run sonnet · medium · moved by you, yesterday');
  expect(qa).toBe('QA pass 3m 05s · $0.21 Log of the QA run sonnet · medium · moved by you, 1 hour ago');
  expect(draw()).toMatch(/<a[^>]*href="\/t\/APP-1\/log\?run=2"/);
});

it('says no cost was reported rather than nought, and claims no estimate', () => {
  const body = text(draw(MOVES, [run(1, 'plan', { costUsd: null })]));

  expect(body).toContain('none cost reported');
  expect(body).not.toContain('estimated values');
});

// Send back from the web or the phone stores its note on the move back, and the trail names it so.
it('shows the note under a move back as sent back, not accepted anyway', () => {
  const moves = [...MOVES.slice(0, 4), { label: 'Implement', said: 'moved by you', at: '2026-10-20T09:31:00Z', phase: null, reason: 'Rename the button to Save recipe.', back: true }];

  expect(rows(draw(moves))[4]).toBe('Implement moved by you, 1 hour ago Sent back: Rename the button to Save recipe.');
});

it('says when no move of the card is recorded', () => {
  expect(text(draw([]))).toContain('No move of this card is recorded.');
});

// The record keeps why a QA FAIL went on anyway, under that move.
it('shows the reason under the move that went on anyway', () => {
  const moves = [...MOVES.slice(0, 4), { label: 'Review', said: 'moved by you', at: '2026-10-20T09:31:00Z', phase: null, reason: 'The empty list is fine for now.' }, MOVES[5]!];

  expect(rows(draw(moves))[4]).toBe('Review moved by you, 1 hour ago Accepted anyway: The empty list is fine for now.');
  expect(draw()).not.toContain('data-reason');
});

// The Pull request row reads the lookup's line in place of who moved the card in.
it('puts a note the page read on the newest move into its stage', () => {
  const moves = [...MOVES.slice(0, 5), { label: 'Pull request', said: 'moved by you', at: '2026-10-20T09:58:00Z', phase: null }, MOVES[5]!];
  const body = render(CardRecord, { props: { strip: STRIP, spend: spendOf(RUNS), moves, logBase: '/t/APP-1/log', now: NOW, notes: { 'Pull request': [{ words: '#42 opened', at: '2026-10-20T10:02:00Z' }, { words: ', merged by you', at: '2026-10-20T10:36:00Z' }] } } }).body;

  // The comma follows the closing time tag, which the text helper reads as a space.
  expect(rows(body)[5]).toBe('Pull request #42 opened 58 minutes ago , merged by you 24 minutes ago');
  expect(rows(body)[6]).toBe('Closed moved by you, 8 minutes ago');
});

// Each row has the done check, and the totals carry the estimate, so no
// footer sentence repeats it.
it('marks every move with the done check, and adds no estimate sentence', () => {
  const body = draw();

  expect(body.match(/class="dot[^"]*"[^>]*><svg/g)).toHaveLength(MOVES.length);
  expect(text(body)).not.toContain('estimated values');
  expect(text(draw(MOVES, [...RUNS, run(3, 'plan', { costUsd: null })]))).toContain('The cost covers 2 of 3 runs.');
});

// The closed card's record says what each run ran on and the wall that held it, as the trail does.
// Cursor reads the effort off the model id, so its row names none.
it('names the engine and the wall of a run, and no wall on an old row', () => {
  const runs = [run(1, 'plan', { engine: 'cursor', wall: 'bubblewrap' }), run(2, 'qa', { engine: 'claude-code' })];
  const strip = [segment('plan', 'Plan', [runs[0]!]), segment('qa', 'QA', [runs[1]!])];
  const shown = rows(render(CardRecord, { props: { strip, spend: spendOf(runs), moves: MOVES, logBase: '/t/APP-1/log' } }).body);

  expect(shown[2]).toContain('Cursor · sonnet · walled by bubblewrap · moved by you');
  expect(shown[3]).toContain('Claude Code · sonnet · medium · moved by you');
});
