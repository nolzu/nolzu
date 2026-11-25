import type { CardView } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import { sendBackOf } from './decision.ts';
import SendBackPanel from './SendBackPanel.svelte';

// Next step on the Changes tab while comments are open: Send back to Implement with them, amber,
// holding until the board shows the card moved.
const stages = boardFixture('pull-request').stages;

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

function draw(card: CardView, open: number, props: Record<string, unknown> = {}) {
  page = mounted(SendBackPanel as never, { card, sendBack: sendBackOf(card, stages, open), open, onsend: async () => null, ...props });
  return page.target;
}

const ready = cardFixture({ key: 'APP-1', stage: 'implement', state: 'ready' });
const words = (target: HTMLElement) => target.textContent?.replace(/\s+/g, ' ').trim() ?? '';

it('names the comments in amber, what it runs on, and the session it goes on in', () => {
  const target = draw(ready, 2, { session: '5d82f1e9' });
  const button = target.querySelector<HTMLButtonElement>('[data-run="send-back"]')!;

  expect(button.classList.contains('go')).toBe(true);
  expect(button.textContent).toContain('Send back to Implement with 2 comments');
  expect(words(target)).toContain('Claude Code · sonnet · medium');
  expect(words(target)).toContain('Goes on in the Implement session 5d82f1e9 with your 2 comments and their lines.');
  expect(target.querySelector('section')?.getAttribute('data-go')).toBe('true');
});

// One comment reads as one: "your comment and its line", never "each with its line".
it('names one comment in the singular', () => {
  expect(words(draw(ready, 1, { session: '5d82f1e9' }))).toContain('Goes on in the Implement session 5d82f1e9 with your comment and its line.');
});

it('says Implement starts fresh when no session is left', () => {
  expect(words(draw(ready, 1))).toContain('Starts Implement fresh with your comment, since no Implement session is left.');
});

it('sends once and holds until the board shows the card moved', async () => {
  const onsend = vi.fn(async () => null);
  const target = draw(ready, 1, { onsend });
  const button = () => target.querySelector<HTMLButtonElement>('[data-run="send-back"]')!;

  button().click();
  await settle();
  button().click();
  await settle();

  expect(onsend).toHaveBeenCalledTimes(1);
  expect(button().getAttribute('aria-busy')).toBe('true');
  expect(words(target)).toContain('Sent. Waiting for the board to show it.');
  page!.set({ card: { ...ready, state: 'queued' }, sendBack: null });
  expect(target.querySelector('[data-run="send-back"]')).toBeNull();
});

it('lets go on a refusal and hands the sentence to the toast', async () => {
  const onrefuse = vi.fn();
  const target = draw(ready, 1, { onsend: async () => 'APP-1 is running.', onrefuse });

  target.querySelector<HTMLButtonElement>('[data-run="send-back"]')!.click();
  await settle();

  expect(onrefuse).toHaveBeenLastCalledWith('APP-1 is running.');
  expect(target.querySelector('[data-run="send-back"]')?.getAttribute('aria-busy')).toBeNull();
});

it('says the comments wait while the card cannot go back, and draws nothing with none open', () => {
  const running = cardFixture({ key: 'APP-1', stage: 'qa', state: 'running', runId: 4, runState: 'running' });

  const waiting = draw(running, 3);
  expect(waiting.querySelector('button')).toBeNull();
  expect(words(waiting)).toContain('3 comments wait for a send back. It opens once the card is ready in Implement or after it.');
  page?.remove();

  expect(draw(ready, 0).querySelector('section')).toBeNull();
});

it('loses the amber when the Implement row cannot start, and keeps its words', () => {
  const gone = stages.map((one) => (one.id === 'implement' ? { ...one, starts: { ...one.starts!, modelState: 'gone' as const } } : one));
  page = mounted(SendBackPanel as never, { card: ready, sendBack: sendBackOf(ready, gone, 1), open: 1, onsend: async () => null });
  const button = page.target.querySelector<HTMLButtonElement>('[data-run="send-back"]')!;

  expect(button.classList.contains('go')).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(page.target.querySelector('.refused')).not.toBeNull();
});
