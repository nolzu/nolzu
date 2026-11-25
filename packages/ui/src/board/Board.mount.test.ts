import { createRawSnippet } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import Board from './Board.svelte';
import { type Drag, enterColumn, startDrag } from './drag.ts';
import { boardFixture, cardFixture } from './fixture.ts';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
// The card may go on to Refine. Its own column refuses, which is what a drop back there is.
const allowed = (stage: string): 'forward' | 'back' | false => (stage === 'refine' ? 'forward' : false);

// The page holds the drag and the board only reports, so the test plays the page: it clears the drag
// when the board says the drag is over, the way BoardPage does. So the onDragEnd call is what these
// tests prove of the board. An empty marked() only proves it draws the cleared drag; that BoardPage
// clears it is pinned in board-page.test.ts.
function draw() {
  const onMove = vi.fn();
  const onDragEnd = vi.fn(() => page?.set({ drag: null }));
  const drag: Drag = enterColumn(startDrag('APP-1'), 'inbox');
  page = mounted(Board as never, { snapshot, drag, allowed, onMove, onDragEnd, now: new Date(0) });
  const column = (id: string) => page!.target.querySelector<HTMLElement>(`[data-stage="${id}"]`)!;
  const marked = () => [...page!.target.querySelectorAll('[data-drop-target="true"]')].map((one) => one.getAttribute('data-stage'));
  return { column, marked, onMove, onDragEnd };
}

it('leaves no column marked after the card is dropped back on its own column', () => {
  const ui = draw();
  expect(ui.marked()).toEqual(['refine']);

  ui.column('inbox').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

  expect(ui.onMove).not.toHaveBeenCalled();
  expect(ui.onDragEnd).toHaveBeenCalledOnce();
  expect(ui.marked()).toEqual([]);
});

// Esc, or a card let go outside any column, ends the drag with no drop at all.
it('leaves no column marked when the drag ends with no drop', () => {
  const ui = draw();

  page!.target.querySelector('[data-card="APP-1"]')!.dispatchEvent(new Event('dragend', { bubbles: true }));

  expect(ui.onDragEnd).toHaveBeenCalledOnce();
  expect(ui.marked()).toEqual([]);
});

// The column decides first, so a drop on a target still sends the move before the drag is cleared.
it('still sends the move on a drop on a target column, then ends the drag', () => {
  const ui = draw();

  ui.column('refine').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

  expect(ui.onMove).toHaveBeenCalledWith('APP-1', 'refine');
  expect(ui.onDragEnd).toHaveBeenCalledOnce();
  expect(ui.marked()).toEqual([]);
});

// An empty column stays folded when the drag starts, so no column moves under a pointer that has
// not moved. It opens in place once the pointer is over it, the same element with the same handlers,
// so the drop on it still sends the move.
const folded = () => [...page!.target.querySelectorAll('[data-folded="true"]')].map((one) => one.getAttribute('data-stage'));

it('opens a folded column only under the pointer, and takes the drop there', () => {
  const onMove = vi.fn();
  page = mounted(Board as never, { snapshot, drag: null, allowed, onMove, now: new Date(0) });
  const refine = () => page!.target.querySelector<HTMLElement>('[data-stage="refine"]')!;
  const strip = refine();
  const rest = ['plan', 'implement', 'qa', 'review', 'pr-watch', 'wrapup', 'closed'];

  expect(folded()).toEqual(['refine', ...rest]);

  page.set({ drag: enterColumn(startDrag('APP-1'), 'inbox') });
  expect(folded()).toEqual(['refine', ...rest]);
  expect(refine().dataset['dropTarget']).toBe('true');

  page.set({ drag: enterColumn(startDrag('APP-1'), 'refine') });
  expect(refine()).toBe(strip);
  expect(folded()).toEqual(rest);
  refine().dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  expect(onMove).toHaveBeenCalledWith('APP-1', 'refine');
});

// A card in Review may go back to any column before it, or on to Pull request. None of those opens
// when the drag starts, and a drop on Review itself, where the pointer still is, sends nothing.
it('moves no column when a drag starts with every target folded', () => {
  const onMove = vi.fn();
  const order = ['inbox', 'refine', 'plan', 'implement', 'qa', 'review', 'pr-watch', 'wrapup', 'closed'];
  const fromReview = (stage: string): 'forward' | 'back' | false => {
    const at = order.indexOf(stage);
    return at < 5 ? 'back' : at === 6 ? 'forward' : false;
  };
  const one = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'review' })]);
  page = mounted(Board as never, { snapshot: one, drag: null, allowed: fromReview, onMove, now: new Date(0) });
  const before = folded();

  page.set({ drag: enterColumn(startDrag('APP-1'), 'review') });

  expect(folded()).toEqual(before);
  expect([...page.target.querySelectorAll('[data-drop-target="true"]')].map((col) => col.getAttribute('data-stage'))).toEqual([
    'inbox',
    'refine',
    'plan',
    'implement',
    'qa',
    'pr-watch',
  ]);
  page.target.querySelector('[data-stage="review"]')!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
  expect(onMove).not.toHaveBeenCalled();

  page.set({ drag: enterColumn(startDrag('APP-1'), 'pr-watch') });
  expect(folded()).toEqual(before.filter((stage) => stage !== 'pr-watch'));
});

// The pointer enters a strip before it leaves the column it came from, and drag.ts keeps the first
// column still holding an enter, so the strip is still folded for that moment. A browser fires the drop
// only where the last dragover was cancelled, so the folded strip cancels it too, or a quick let go there
// is lost.
it('lets a folded target strip take the drop before it opens', () => {
  const ui = draw();
  page!.set({ drag: enterColumn(enterColumn(startDrag('APP-1'), 'inbox'), 'refine') });
  expect(ui.column('refine').dataset['folded']).toBe('true');

  const over = new Event('dragover', { bubbles: true, cancelable: true });
  ui.column('refine').dispatchEvent(over);

  expect(over.defaultPrevented).toBe(true);
});

// The page reads `gone` to end the target. The column says so only when the browser names a place
// outside it, so a pointer that crosses onto the column's own text still counts as before.
it('tells the page a leave went outside the column, and a leave onto its own text did not', () => {
  const onDragLeave = vi.fn();
  page = mounted(Board as never, { snapshot, drag: enterColumn(startDrag('APP-1'), 'inbox'), allowed, onDragLeave, now: new Date(0) });
  const inbox = page.target.querySelector<HTMLElement>('[data-stage="inbox"]')!;
  const plan = page.target.querySelector<HTMLElement>('[data-stage="plan"]')!;
  const own = inbox.querySelector<HTMLElement>('[data-card="APP-1"]')!;

  inbox.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: plan }));
  own.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: inbox }));
  inbox.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }));

  expect(onDragLeave.mock.calls).toEqual([
    ['inbox', true],
    ['inbox', false],
    ['inbox', false],
  ]);
});

// The web draws its Move forward on each card through this. A board given none draws nothing new.
const action = createRawSnippet((card: () => { key: string }) => ({ render: () => `<button data-move="${card().key}">Move forward</button>` }));
const three = boardFixture('pull-request', [
  cardFixture({ key: 'APP-1', stage: 'inbox' }),
  cardFixture({ key: 'APP-2', stage: 'inbox' }),
  cardFixture({ key: 'APP-3', stage: 'plan', state: 'ready' }),
]);

it('draws the card action once in each card, with that card', () => {
  page = mounted(Board as never, { snapshot: three, cardAction: action, now: new Date(0) });

  for (const key of ['APP-1', 'APP-2', 'APP-3']) {
    const buttons = page.target.querySelectorAll(`[data-card="${key}"] [data-move]`);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('data-move')).toBe(key);
  }
  expect(page.target.querySelectorAll('[data-move]')).toHaveLength(3);
});

it('keeps a click in the card action from reaching the page, and refuses a drag begun there', () => {
  const onDragStart = vi.fn();
  page = mounted(Board as never, { snapshot: three, cardAction: action, onDragStart, now: new Date(0) });
  // The button hears its own click, and nothing above the board does.
  const heard = vi.fn();
  const own = vi.fn();
  document.addEventListener('click', heard);
  const button = page.target.querySelector<HTMLElement>('[data-move="APP-1"]')!;
  button.addEventListener('click', own);

  button.click();
  document.removeEventListener('click', heard);
  const drag = new Event('dragstart', { bubbles: true, cancelable: true });
  button.dispatchEvent(drag);

  expect(own).toHaveBeenCalledOnce();
  expect(heard).not.toHaveBeenCalled();
  expect(drag.defaultPrevented).toBe(true);
  expect(onDragStart).not.toHaveBeenCalled();
});

// A browser fires dragstart on the draggable card, not on the button the press began on.
it('refuses a drag the browser starts on the card when the press began in the card action', () => {
  const onDragStart = vi.fn();
  page = mounted(Board as never, { snapshot: three, cardAction: action, onDragStart, now: new Date(0) });
  const card = page.target.querySelector<HTMLElement>('[data-card="APP-1"]')!;

  page.target.querySelector('[data-move="APP-1"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  const fromAction = new Event('dragstart', { bubbles: true, cancelable: true });
  card.dispatchEvent(fromAction);
  expect(fromAction.defaultPrevented).toBe(true);
  expect(onDragStart).not.toHaveBeenCalled();

  card.querySelector('.title')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  card.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
  expect(onDragStart).toHaveBeenCalledWith('APP-1');
});

it('draws no card action and keeps every card draggable when the page passes neither prop', () => {
  const onDragStart = vi.fn();
  page = mounted(Board as never, { snapshot: three, onDragStart, now: new Date(0) });

  expect(page.target.querySelectorAll('[data-card-action]')).toHaveLength(0);
  expect([...page.target.querySelectorAll('[data-card]')].map((card) => card.getAttribute('draggable'))).toEqual(['true', 'true', 'true']);
  page.target.querySelector('[data-card="APP-1"]')!.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
  expect(onDragStart).toHaveBeenCalledWith('APP-1');
});

it('leaves no draggable attribute and starts no drag with draggable off', () => {
  const onDragStart = vi.fn();
  const folded = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'inbox', minimized: true })]);
  page = mounted(Board as never, { snapshot: folded, draggable: false, onDragStart, now: new Date(0) });

  for (const key of ['APP-1', 'APP-2']) {
    const card = page.target.querySelector<HTMLElement>(`[data-card="${key}"]`)!;
    expect(card.hasAttribute('draggable')).toBe(false);
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    card.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  }
  expect(onDragStart).not.toHaveBeenCalled();
});

it('marks each card action with its own card key', () => {
  page = mounted(Board as never, { snapshot: three, cardAction: action, now: new Date(0) });

  expect([...page.target.querySelectorAll('[data-card-action]')].map((one) => one.getAttribute('data-card-action'))).toEqual(['APP-1', 'APP-2', 'APP-3']);
});

it('refuses a drag of a card its run owns', () => {
  const onDragStart = vi.fn();
  const busy = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'implement', state: 'running', runId: 3, runState: 'running' })]);
  page = mounted(Board as never, { snapshot: busy, onDragStart, now: new Date(0) });
  const drag = new Event('dragstart', { bubbles: true, cancelable: true });

  page.target.querySelector('[data-card="APP-1"]')!.dispatchEvent(drag);

  expect(drag.defaultPrevented).toBe(true);
  expect(onDragStart).not.toHaveBeenCalled();
});

// A click on the folded Closed strip opens it, and Hide on its header folds it again.
it('opens Closed on a click on its strip and folds it on Hide', async () => {
  const closed = boardFixture('pull-request', [cardFixture({ key: 'APP-5', stage: 'closed' })]);
  page = mounted(Board as never, { snapshot: closed, now: new Date(0) });
  const column = () => page!.target.querySelector<HTMLElement>('[data-stage="closed"]')!;
  expect(column().getAttribute('data-folded')).toBe('true');

  column().querySelector<HTMLButtonElement>('button.unfold')!.click();
  await Promise.resolve();

  expect(column().hasAttribute('data-folded')).toBe(false);
  expect(column().querySelector('[data-card="APP-5"]')).not.toBeNull();
  await vi.waitFor(() => expect(document.activeElement?.classList.contains('fold')).toBe(true));

  column().querySelector<HTMLButtonElement>('button.fold')!.click();
  await Promise.resolve();

  expect(column().getAttribute('data-folded')).toBe('true');
  await vi.waitFor(() => expect(document.activeElement?.classList.contains('unfold')).toBe(true));
  expect(page.target.querySelector('button.fold')).toBeNull();
});

// Fix it hands the card to the page, which asks first, and the click goes no further.
it('hands Fix it to the page with its card, and keeps the click from the page', () => {
  const failed = boardFixture('pull-request', [cardFixture({ key: 'APP-9', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'Empty list.' })]);
  const onFix = vi.fn();
  page = mounted(Board as never, { snapshot: failed, onFix, now: new Date(0) });
  const heard = vi.fn();
  document.addEventListener('click', heard);

  page.target.querySelector<HTMLButtonElement>('[data-fix="APP-9"]')!.click();
  document.removeEventListener('click', heard);

  expect(onFix).toHaveBeenCalledExactlyOnceWith('APP-9');
  expect(heard).not.toHaveBeenCalled();
});

// The placeholder is no card: nothing picks it up, the keys never reach it, and no count holds it.
// The first column opens to show it while the rest stay folded, and it goes with the first card.
it('draws a placeholder in the open first column of an empty board, and drops it with the first card', () => {
  page = mounted(Board as never, { snapshot: boardFixture('pull-request'), now: new Date(0) });
  const placeholder = () => page!.target.querySelector<HTMLElement>('[data-placeholder]');
  const inbox = () => page!.target.querySelector<HTMLElement>('[data-stage="inbox"]')!;

  expect(placeholder()!.closest('[data-stage]')).toBe(inbox());
  expect(inbox().dataset['folded']).toBeUndefined();
  expect(folded()).toEqual(['refine', 'plan', 'implement', 'qa', 'review', 'pr-watch', 'wrapup', 'closed']);
  expect(placeholder()!.hasAttribute('draggable')).toBe(false);
  expect(placeholder()!.closest('[data-card]')).toBeNull();
  expect(placeholder()!.querySelector('[tabindex], [data-card]')).toBeNull();
  expect(page.target.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  expect(inbox().querySelector('.count')!.textContent).toBe('0');

  page.set({ snapshot: boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'review' })]) });

  expect(placeholder()).toBeNull();
  expect(inbox().dataset['folded']).toBe('true');
  expect(page.target.querySelector('[data-card="APP-1"]')!.getAttribute('tabindex')).toBe('0');
});

// The Epics board opens its Inbox too, where it folded before.
it('opens the Inbox of an empty Epics board with the placeholder', () => {
  page = mounted(Board as never, { snapshot: { ...boardFixture('pull-request'), kind: 'epics' }, now: new Date(0) });

  const placeholder = page.target.querySelector('[data-placeholder]');
  expect(placeholder!.closest<HTMLElement>('[data-stage]')!.dataset['stage']).toBe('inbox');
  expect(placeholder!.textContent).toContain('Press N, or Add epic');
});
