import { flushSync } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import Board from './Board.svelte';
import BoardCard from './BoardCard.svelte';
import { startDrag } from './drag.ts';
import { boardFixture, cardFixture } from './fixture.ts';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

const snapshot = boardFixture('pull-request', [
  cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready', model: 'sonnet', costUsd: 0.15, totalUsd: 0.4 }),
  cardFixture({ key: 'APP-2', stage: 'plan', state: 'idle' }),
  cardFixture({ key: 'APP-3', stage: 'refine', state: 'idle', minimized: true }),
]);

function draw(drag: ReturnType<typeof startDrag> | null) {
  page = mounted(Board as never, { snapshot, drag, now: new Date(0) });
  const card = (key: string) => page!.target.querySelectorAll<HTMLElement>(`[data-card="${key}"]`);
  return { card };
}

// The browser draws the copy under the pointer from the card once the drag starts. So the card turns
// into the ghost a frame later, and the copy is the whole card.
it('draws the dragged card as the ghost a frame after the drag starts', async () => {
  const ui = draw(startDrag('APP-1'));

  expect(ui.card('APP-1')[0]!.hasAttribute('data-ghost')).toBe(false);
  expect(ui.card('APP-1')[0]!.textContent).toContain('Plan ready');

  await frame();
  flushSync();

  const ghost = ui.card('APP-1');
  // The same element, so the focus and every key that finds the card by data-card still reach it.
  expect(ghost).toHaveLength(1);
  expect(ghost[0]!.getAttribute('data-ghost')).toBe('true');
  expect(ghost[0]!.getAttribute('aria-label')).toBe('APP-1 is being moved');
  // The key and the title, and no pill, meta row or cost.
  expect(ghost[0]!.textContent!.replace(/\s+/g, ' ').trim()).toBe('APP-1 Add a search box to the recipe list');
  expect(ui.card('APP-2')[0]!.hasAttribute('data-ghost')).toBe(false);
});

it('draws the whole card again once the drag ends', async () => {
  const ui = draw(startDrag('APP-1'));
  await frame();
  flushSync();

  page!.set({ drag: null });

  expect(ui.card('APP-1')[0]!.hasAttribute('data-ghost')).toBe(false);
  expect(ui.card('APP-1')[0]!.getAttribute('aria-label')).toBe('APP-1');
  expect(ui.card('APP-1')[0]!.textContent).toContain('$0.40');
});

// The strip below the open cards gets the drag too.
it('draws a card folded to one line as the ghost too', async () => {
  const ui = draw(startDrag('APP-3'));
  await frame();
  flushSync();

  expect(ui.card('APP-3')[0]!.getAttribute('data-ghost')).toBe('true');
  expect(ui.card('APP-3')[0]!.getAttribute('aria-label')).toBe('APP-3 is being moved');
});

// The tests above drag APP-1. Dragging APP-2 proves the column and the card read the dragged card's own
// key, and that the card beside it stays whole.
it('draws the ghost on the dragged card and on no other', async () => {
  const ui = draw(startDrag('APP-2'));
  await frame();
  flushSync();

  expect(ui.card('APP-2')[0]!.getAttribute('data-ghost')).toBe('true');
  expect(ui.card('APP-2')[0]!.getAttribute('aria-label')).toBe('APP-2 is being moved');
  expect(ui.card('APP-2')[0]!.textContent!.replace(/\s+/g, ' ').trim()).toBe('APP-2 Add a search box to the recipe list');
  expect(ui.card('APP-1')[0]!.hasAttribute('data-ghost')).toBe(false);
});

// The next drag waits a frame too, or the browser takes the ghost as the copy under the pointer.
it('waits a frame again on the next drag', async () => {
  const ui = draw(startDrag('APP-1'));
  await frame();
  flushSync();
  page!.set({ drag: null });
  page!.set({ drag: startDrag('APP-1') });

  expect(ui.card('APP-1')[0]!.hasAttribute('data-ghost')).toBe(false);

  await frame();
  flushSync();

  expect(ui.card('APP-1')[0]!.getAttribute('data-ghost')).toBe('true');
});

// The card page counts the same runs, so the board shows what the card has spent, not the newest run.
it('shows the card total in the corner, with the newest run in the title', () => {
  const ui = draw(null);
  const cost = ui.card('APP-1')[0]!.querySelector<HTMLElement>('.meta .r')!;

  expect(cost.textContent).toBe('$0.40');
  expect(cost.title).toBe('Total $0.40 · last run $0.15 (estimated)');
  expect(ui.card('APP-2')[0]!.textContent).not.toContain('$');
});

// A pull request card a push sent back to Incoming says which round the next review writes, beside its
// key. Only on Incoming, and only once a round was saved.
it('says Back for round N on an Incoming pull request card with a saved round', () => {
  const pull = (round: number | null) => ({ author: 'dana', decision: 'CHANGES_REQUESTED' as const, headCommittedAt: null, draft: false, round, newCommits: 1 });
  const badge = (stage: string, round: number | null) => {
    page?.remove();
    page = mounted(BoardCard as never, { card: cardFixture({ key: 'recipes#41', stage, state: 'idle', pull: pull(round) }), rounds: true, now: new Date(0) });
    return page.target.querySelector('[data-back-round]')?.textContent ?? null;
  };

  expect(badge('incoming', 2)).toBe('Back for round 3');
  expect(badge('incoming', null)).toBeNull();
  expect(badge('my-review', 2)).toBeNull();
  expect(badge('awaiting-author', 2)).toBeNull();
});
