import { expect, it } from 'vitest';
import { dropped, enterColumn, keepDrag, leaveColumn, lockReason, startDrag } from './drag.ts';
import { cardFixture } from './fixture.ts';

const allow =
  (stages: readonly string[]) =>
  (stage: string): 'forward' | 'back' | false =>
    stages.includes(stage) ? 'forward' : false;

it('keeps a column marked while the pointer moves over a child element', () => {
  // A dragenter fires again for every child, and a dragleave fires when the pointer crosses into
  // one. Counting them is what stops the target flickering under the card's own text.
  let drag = startDrag('APP-1');
  drag = enterColumn(drag, 'refine');
  drag = enterColumn(drag, 'refine');
  drag = leaveColumn(drag, 'refine');

  expect(drag.over).toBe('refine');
});

it('drops the mark when the last leave arrives', () => {
  let drag = enterColumn(startDrag('APP-1'), 'refine');
  drag = leaveColumn(drag, 'refine');

  expect(drag.over).toBe(null);
});

it('never counts below zero, so a stray leave cannot hide the next enter', () => {
  let drag = leaveColumn(startDrag('APP-1'), 'refine');
  drag = enterColumn(drag, 'refine');

  expect(drag.over).toBe('refine');
});

it('moves the mark from one column to the next as the pointer crosses', () => {
  let drag = enterColumn(startDrag('APP-1'), 'refine');
  drag = enterColumn(drag, 'plan');
  drag = leaveColumn(drag, 'refine');

  expect(drag.over).toBe('plan');
});

it('carries the card the drag started on', () => {
  expect(startDrag('APP-1').key).toBe('APP-1');
});

it('turns a drop on an allowed column into the move to send', () => {
  const drag = enterColumn(startDrag('APP-1'), 'refine');

  expect(dropped(drag, 'refine', allow(['refine']))).toEqual({ key: 'APP-1', stage: 'refine' });
});

it('sends no move when the column refuses the card', () => {
  const drag = enterColumn(startDrag('APP-1'), 'implement');

  // Two stages forward is not a legal move, and a drop there is a mistake, not a request.
  expect(dropped(drag, 'implement', allow(['refine']))).toBe(null);
});

it('sends no move when no card is being dragged', () => {
  expect(dropped(null, 'refine', allow(['refine']))).toBe(null);
});

// A card whose run owns it. The board says so in words, because a card that simply refuses to move
// with no reason reads as a broken page.
it('locks a queued card and says why', () => {
  expect(lockReason(cardFixture({ key: 'PROJ-123', state: 'queued' }))).toBe('PROJ-123 is queued. It cannot move until its run ends.');
});

it('locks a running card in its own words', () => {
  expect(lockReason(cardFixture({ key: 'PROJ-123', state: 'running' }))).toBe('PROJ-123 is running. It cannot move until its run ends.');
});

it.each(['idle', 'ready', 'blocked', 'failed'] as const)('leaves a %s card free to move', (state) => {
  expect(lockReason(cardFixture({ key: 'PROJ-1', state }))).toBe(null);
});

// The snapshot is the truth and it can arrive mid drag. A drag held over a card that has since been
// queued would send a move the server refuses, after the person let go.
it('drops a drag when the card it holds turns queued', () => {
  const drag = enterColumn(startDrag('APP-1'), 'plan');

  expect(keepDrag(drag, [cardFixture({ key: 'APP-1', state: 'queued' })])).toBe(null);
});

it('drops a drag when the card it holds starts running', () => {
  const drag = enterColumn(startDrag('APP-1'), 'plan');

  expect(keepDrag(drag, [cardFixture({ key: 'APP-1', state: 'running' })])).toBe(null);
});

it('keeps the drag while its card is still free to move', () => {
  const drag = enterColumn(startDrag('APP-1'), 'plan');

  expect(keepDrag(drag, [cardFixture({ key: 'APP-1', state: 'idle' })])).toBe(drag);
});

it('drops a drag whose card is no longer on the board', () => {
  const drag = startDrag('APP-1');

  expect(keepDrag(drag, [cardFixture({ key: 'APP-2', state: 'idle' })])).toBe(null);
});

it('keeps no drag when no card is being dragged', () => {
  expect(keepDrag(null, [cardFixture({ key: 'APP-1', state: 'idle' })])).toBe(null);
});

// A drag over Refine, then on over the folded Plan strip it cannot drop on.
// Refine had opened under the pointer, and the strip's text went away under it with no leave, so the
// count stayed up: the box and ring still said "Drop to start Refine" over a column that takes nothing.
// A leave that says where the pointer went outside the column ends the target whatever the count.
it('leaves the last target when the pointer goes out of it, whatever the count says', () => {
  let drag = enterColumn(startDrag('APP-1'), 'refine');
  // Two enters with one leave lost, as when a child went away under the pointer.
  drag = enterColumn(drag, 'refine');
  drag = enterColumn(drag, 'plan');
  drag = leaveColumn(drag, 'refine', true);

  expect(drag.over).toBe('plan');
  expect(drag.depth['refine']).toBe(0);
});

it('counts a leave inside the column as before', () => {
  let drag = enterColumn(startDrag('APP-1'), 'refine');
  drag = enterColumn(drag, 'refine');
  drag = leaveColumn(drag, 'refine', false);

  expect(drag.over).toBe('refine');
});
