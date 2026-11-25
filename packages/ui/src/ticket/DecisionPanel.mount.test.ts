import type { CardView } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import DecisionPanel from './DecisionPanel.svelte';
import { sendBackOf } from './decision.ts';

// What the server render cannot reach: the press, the hold that follows it, and the picker's write.
const stages = boardFixture('pull-request').stages;
const stage = (id: string) => stages.find((found) => found.id === id)!;

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

function draw(card: CardView, props: Record<string, unknown>) {
  page = mounted(DecisionPanel as never, { card, stage: 'Plan', next: stage('implement'), onmove: async () => null, onminimize: async () => null, ...props });
  return (selector: string) => page!.target.querySelector<HTMLElement>(selector)!;
}

it('sends the move once and holds every button until the board shows the card moved', async () => {
  const onmove = vi.fn(async () => null);
  const ready = cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' });
  const find = draw(ready, { onmove, back: { to: 'refine', label: 'Refine' } });

  find('[data-move="implement"]').click();
  await settle();
  find('[data-move="implement"]').click();
  find('[data-move-back]').click();
  await settle();

  expect(onmove).toHaveBeenCalledTimes(1);
  expect(onmove).toHaveBeenCalledWith('implement');
  expect(find('[data-move="implement"]').getAttribute('aria-busy')).toBe('true');

  // The stream moves the card, and that lets go.
  page!.set({ card: { ...ready, stage: 'implement', state: 'queued', runId: 5 }, next: stage('qa') });
  expect(find('[data-run="stop"]').getAttribute('aria-busy')).toBeNull();
});

it('lets go on a refusal and hands the sentence to the toast', async () => {
  const onrefuse = vi.fn();
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { onmove: async () => 'Implement cannot start.', onrefuse });

  find('[data-move="implement"]').click();
  await settle();

  expect(onrefuse).toHaveBeenLastCalledWith('Implement cannot start.');
  expect(find('[data-move="implement"]').getAttribute('aria-busy')).toBeNull();
});

// A question closed with no answer sent nothing, so the button lets go and nothing is said.
it('lets go and says nothing when the page sent nothing', async () => {
  const onrefuse = vi.fn();
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { onmove: async () => undefined, onrefuse });

  find('[data-move="implement"]').click();
  await settle();

  expect(onrefuse).toHaveBeenLastCalledWith(null);
  expect(find('[data-move="implement"]').getAttribute('aria-busy')).toBeNull();
});

it('retries a failed card through the retry callback, not a move', async () => {
  const onretry = vi.fn(async () => null);
  const onmove = vi.fn(async () => null);
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'failed' }), { retry: stage('plan'), onretry, onmove });

  find('[data-run="retry"]').click();
  await settle();

  expect(onretry).toHaveBeenCalledTimes(1);
  expect(onmove).not.toHaveBeenCalled();
});

it('sends nothing from a refused start', async () => {
  const onmove = vi.fn(async () => null);
  const gone = { ...stage('implement'), starts: { ...stage('implement').starts!, modelState: 'gone' as const } };
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { next: gone, onmove });

  find('[data-move="implement"]').click();
  await settle();

  expect(onmove).not.toHaveBeenCalled();
});

it('writes the picked engine and model together to the row the button starts', async () => {
  const onpick = vi.fn(async () => null);
  const picker = { action: 'implement', engine: 'claude-code', model: 'sonnet', effort: 'medium', profiles: [{ id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet'] }] };
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker, onpick });
  const model = page!.target.querySelector<HTMLSelectElement>('.pick select[data-pick="model"]')!;

  model.value = 'haiku';
  model.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();

  expect(onpick).toHaveBeenCalledWith('implement', { engine: 'claude-code', model: 'haiku' });
  expect(find('.pick [role="status"]').textContent).toBe('Saved for this card.');
});

// An engine pick writes a model with it: the same name when the new engine offers it, its first one when not.
it('writes an engine pick with the model it keeps or the first model the engine offers', async () => {
  const onpick = vi.fn(async () => null);
  const profiles = [
    { id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet'] },
    { id: 'claude-code#work', label: 'Claude work', models: ['opus', 'sonnet'] },
    { id: 'cursor#work', label: 'Cursor work', models: ['auto', 'gpt-9'] },
  ];
  const picker = { action: 'implement', engine: 'claude-code', model: 'sonnet', effort: 'medium', profiles };
  draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker, onpick });
  const engine = page!.target.querySelector<HTMLSelectElement>('.pick select[data-pick="engine"]')!;

  engine.value = 'claude-code#work';
  engine.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  engine.value = 'cursor#work';
  engine.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();

  expect(onpick.mock.calls).toEqual([
    ['implement', { engine: 'claude-code#work', model: 'sonnet' }],
    ['implement', { engine: 'cursor#work', model: 'auto' }],
  ]);
});

it('closes a profile with no models in the engine list', () => {
  const profiles = [
    { id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet'] },
    { id: 'codex#work', label: 'Codex work', models: [], reason: 'No models answered.' },
  ];
  const picker = { action: 'implement', engine: 'claude-code', model: 'sonnet', effort: 'medium', profiles };
  draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker, onpick: vi.fn(async () => null) });
  const options = (pick: string) =>
    [...page!.target.querySelectorAll<HTMLOptionElement>(`.pick select[data-pick="${pick}"] option`)].map((one) => `${one.textContent}${one.disabled ? ' [closed]' : ''}`);

  expect(options('engine')).toEqual(['Claude Code', 'Codex work (no models) [closed]']);
  expect(options('model')).toEqual(['haiku', 'sonnet']);
});

// Accept anyway asks one line of reason for the trail, and refuses an empty one.
it('asks Accept anyway for a reason, refuses an empty one with a sentence, and sends the line with the move', async () => {
  const onmove = vi.fn(async () => null);
  const failed = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  const find = draw(failed, { stage: 'QA', next: stage('review'), onmove });

  find('[data-accept="review"]').click();
  await settle();
  const field = find('[data-reason]') as HTMLInputElement;
  expect(document.activeElement).toBe(field);

  for (const typed of ['', '   ']) {
    field.value = typed;
    field.dispatchEvent(new Event('input'));
    find('[data-move="review"]').click();
    await settle();
    expect(onmove).not.toHaveBeenCalled();
    expect(page!.target.textContent).toContain('Write one line on why it goes on. The reviewer reads it in the trail.');
  }

  field.value = '  The empty list is fine until the api has a status page. ';
  field.dispatchEvent(new Event('input'));
  find('[data-move="review"]').click();
  await settle();

  expect(onmove).toHaveBeenCalledTimes(1);
  expect(onmove).toHaveBeenCalledWith('review', 'The empty list is fine until the api has a status page.');
  expect(page!.target.textContent).not.toContain('Write one line');
});

// The page keeps the panel when it shows another card, so a half-written reason never follows it.
it('closes the reason and drops what was typed when another card shows', async () => {
  const failed = (key: string) => cardFixture({ key, stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  const find = draw(failed('APP-1'), { stage: 'QA', next: stage('review') });
  find('[data-accept="review"]').click();
  await settle();
  const field = find('[data-reason]') as HTMLInputElement;
  field.value = 'Fine for APP-1.';
  field.dispatchEvent(new Event('input'));

  page!.set({ card: failed('APP-7') });
  expect(page!.target.querySelector('[data-reason]')).toBeNull();
  find('[data-accept="review"]').click();
  await settle();
  expect((find('[data-reason]') as HTMLInputElement).value).toBe('');
});

it('sends Send back with comments once, and holds every button until the board shows the card moved', async () => {
  const onsendback = vi.fn(async () => null);
  const onmove = vi.fn(async () => null);
  const review = cardFixture({ key: 'APP-1', stage: 'review', state: 'idle' });
  const find = draw(review, { stage: 'Review', next: stage('pr-watch'), sendBack: sendBackOf(review, stages, 1), onsendback, onmove });

  find('[data-run="send-back"]').click();
  await settle();
  find('[data-run="send-back"]').click();
  find('[data-move="pr-watch"]').click();
  await settle();

  expect(onsendback).toHaveBeenCalledTimes(1);
  expect(onmove).not.toHaveBeenCalled();
  expect(find('[data-run="send-back"]').getAttribute('aria-busy')).toBe('true');

  page!.set({ card: { ...review, stage: 'implement', state: 'queued', runId: 6 }, sendBack: null });
  expect(find('[data-run="stop"]').getAttribute('aria-busy')).toBeNull();
});

// The plain move beside Send back starts the next stage's run, so its press must move the card on and
// never send the comments.
it('moves the card on with Move to QA instead, and sends no comment', async () => {
  const onsendback = vi.fn(async () => null);
  const onmove = vi.fn(async () => null);
  const ready = cardFixture({ key: 'APP-1', stage: 'implement', state: 'ready' });
  const find = draw(ready, { stage: 'Implement', next: stage('qa'), sendBack: sendBackOf(ready, stages, 2), onsendback, onmove });

  expect(find('[data-move="qa"]').textContent?.trim()).toBe('Move to QA instead');
  find('[data-move="qa"]').click();
  await settle();

  expect(onmove).toHaveBeenCalledExactlyOnceWith('qa');
  expect(onsendback).not.toHaveBeenCalled();
});

// Copy all findings hands the shown round to the page, which owns the clipboard, and says what
// happened. Nolzu posts nothing to GitHub.
it('hands the round to the page as conventional comments and says it is on the clipboard', async () => {
  const oncopy = vi.fn<(text: string) => Promise<string | null>>(async () => null);
  const text = 'issue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n\npraise: src/recipes/list.ts:14\nThe list reads in one pass.';
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { findings: { text, round: 2 }, oncopy });

  find('[data-copy-all]').click();
  await settle();

  expect(oncopy).toHaveBeenCalledWith(text);
  expect(page!.target.textContent).toContain('Round 2 is on the clipboard. Paste it into the pull request.');
  // A copy writes nothing, so it holds no button.
  expect(find('[data-move="implement"]').getAttribute('aria-busy')).toBeNull();
});

it('shows the sentence a refused copy came back with', async () => {
  const find = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { findings: { text: 'praise:\nFine.', round: 1 }, oncopy: async () => 'The browser refused the clipboard.' });

  find('[data-copy-all]').click();
  await settle();

  expect(page!.target.textContent).toContain('The browser refused the clipboard.');
});

// More actions is a menu button. The arrows open it and move between rows, Escape closes it and
// gives the focus back, and a row's press closes it and does what the row says.
it('opens More actions from the keys, moves with the arrows, and closes on Escape and on a row', async () => {
  const onmove = vi.fn(async () => null);
  const ready = cardFixture({ key: 'APP-1', stage: 'implement', state: 'ready' });
  const find = draw(ready, { stage: 'Implement', next: stage('qa'), sendBack: sendBackOf(ready, stages, 1), back: { to: 'plan', label: 'Plan' }, threadHref: '/t/APP-1/discussion?thread=implement', onmove });
  const button = find('[data-more]');
  const menu = find('[role="menu"]');
  const rows = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

  expect(rows().map((one) => one.textContent?.trim())).toEqual(['Move to QA instead Starts: Claude Code · sonnet · medium', 'Ask about the implement']);
  expect(menu.hidden).toBe(true);
  key(button, 'ArrowDown');
  await settle();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(menu.hidden).toBe(false);
  expect(document.activeElement).toBe(rows()[0]);
  key(rows()[0]!, 'ArrowDown');
  expect(document.activeElement).toBe(rows()[1]);
  key(rows()[1]!, 'ArrowDown');
  expect(document.activeElement).toBe(rows()[0]);
  key(rows()[0]!, 'End');
  expect(document.activeElement).toBe(rows()[1]);
  key(rows()[1]!, 'Escape');
  await settle();
  expect(menu.hidden).toBe(true);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);

  button.click();
  await settle();
  rows()[0]!.click();
  await settle();
  expect(onmove).toHaveBeenCalledExactlyOnceWith('qa');
  expect(menu.hidden).toBe(true);
  // The press holds the rows as it holds the buttons, until the board shows the card moved.
  expect(rows()[0]!.getAttribute('aria-busy')).toBe('true');
});
