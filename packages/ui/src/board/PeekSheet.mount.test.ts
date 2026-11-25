import type { CardView } from '@nolzu/protocol';
import { afterEach, expect, it } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { boardFixture, cardFixture } from './fixture.ts';
import type { PeekView } from './peek.ts';
import PeekSheet from './PeekSheet.svelte';

// A server render prints Markdown as its source, so the summary is checked in a real DOM.
let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const CARD = cardFixture({ key: 'APP-16', title: 'Fix the broken image on recipe cards', stage: 'implement', state: 'running', runId: 3, runState: 'running' });
const view = (text: string): PeekView => ({ key: 'APP-16', summary: { text, at: null, live: false }, log: null, tokens: null, trail: [], retry: null, openComments: 0, session: null });

// The run writes its summary in Markdown. The sheet has the card title as h2 and its sections as
// h3, so a heading the run wrote starts at h4.
it('draws the summary so far as Markdown, under the section heading', () => {
  page = mounted(PeekSheet as never, { card: CARD, stage: 'Implement', view: view('# Done\n\nThe path is fixed in **one** place.\n\n- `RecipeCard.svelte`'), clock: new Date(), back: 'Plan', openHref: '/t/APP-16', logHref: '/t/APP-16/log', onclose: () => {} });
  const said = page.target.querySelector('[data-peek-summary]');

  expect(said?.querySelector('strong')?.textContent).toBe('one');
  expect(said?.querySelector('li code')?.textContent).toBe('RecipeCard.svelte');
  expect(said?.querySelector('h4')?.textContent).toBe('Done');
  expect(said?.querySelector('h1')).toBeNull();
});

// The card page's Next step block, at the top of the sheet. The page builds its props with the same
// rule the card page uses, so the sheet draws whatever it is handed.
const board = boardFixture('pull-request');
const label = (id: string) => board.stages.find((one) => one.id === id)!.label;
const decision = (card: CardView) => ({ card, stage: label(card.stage), next: board.stages[board.stages.findIndex((one) => one.id === card.stage) + 1] ?? null, onmove: async () => null, onminimize: async () => null });
const peek = (card: CardView) =>
  mounted(PeekSheet as never, { card, stage: label(card.stage), view: view('Read.'), clock: new Date(), openHref: `/t/${card.key}`, logHref: `/t/${card.key}/log`, decision: decision(card), onclose: () => {} });
const block = () => page?.target.querySelector('.body > [data-decision]') ?? null;

it.each([
  ['waiting', cardFixture({ key: 'APP-16', stage: 'plan', state: 'blocked' }), 'asks', 'The agent is waiting for you'],
  ['running', CARD, 'running', 'Implement is running'],
  ['done', cardFixture({ key: 'APP-16', stage: 'plan', state: 'ready' }), 'start', 'Approve and start Implement'],
])('shows the next step first for a %s card', (_, card, kind, words) => {
  page = peek(card);

  expect(block()?.getAttribute('data-decision')).toBe(kind);
  expect(block()?.textContent).toContain('Next step');
  expect(block()?.textContent).toContain(words);
  // First in the body, over the summary.
  expect(page.target.querySelector('.body')?.firstElementChild).toBe(block());
});

it('draws no block when the page hands none', () => {
  page = mounted(PeekSheet as never, { card: CARD, stage: 'Implement', view: view('Read.'), clock: new Date(), openHref: '/t/APP-16', logHref: '/t/APP-16/log', onclose: () => {} });

  expect(page.target.querySelector('[data-decision]')).toBeNull();
});

// The sheet's foot has Stop with its key and Move back, which stops a running card first. The block
// leaves out its own two in the peek, so each action is drawn once. The card page keeps them.
it.each([
  ['running', CARD, 'Stop'],
  ['waiting', cardFixture({ key: 'APP-16', stage: 'plan', state: 'blocked' }), 'Move back to Inbox'],
])('draws each action once on a %s card in the peek', (_, card, foot) => {
  const back = { to: 'inbox', label: 'Inbox' };
  page = mounted(PeekSheet as never, {
    card,
    stage: label(card.stage),
    view: view('Read.'),
    clock: new Date(),
    back: 'Inbox',
    openHref: `/t/${card.key}`,
    logHref: `/t/${card.key}/log`,
    decision: { ...decision(card), back, inPeek: true },
    onclose: () => {},
  });

  expect(block()?.querySelector('[data-run="stop"]')).toBeNull();
  expect(block()?.querySelector('[data-move-back]')).toBeNull();
  expect(page.target.querySelector('[data-peek-actions]')?.textContent).toContain(foot);

  page.remove();
  page = mounted(PeekSheet as never, { card, stage: label(card.stage), view: view('Read.'), clock: new Date(), openHref: '/t/APP-16', logHref: '/t/APP-16/log', decision: { ...decision(card), back }, onclose: () => {} });
  expect(block()?.querySelector(card.state === 'running' ? '[data-run="stop"]' : '[data-move-back]')).not.toBeNull();
});

// The run's actions sit right under Next step, above the summary, so Stop is in sight without a
// scroll. Open card is a block across the sheet right under Next step, with
// its Enter key, outlined, so the amber start stays the loud button. A card with no run and no way back
// draws no empty row.
it('draws Open card as a block right under Next step, then Stop and Move back', () => {
  page = peek(CARD);
  const body = page.target.querySelector('.body');
  const order = [...(body?.children ?? [])].map((one) =>
    one.matches('[data-decision]') ? 'decision' : one.matches('[data-peek-open]') ? 'open' : one.matches('[data-peek-actions]') ? 'actions' : one.tagName.toLowerCase(),
  );

  expect(order.slice(0, 4)).toEqual(['decision', 'open', 'actions', 'section']);
  expect(page.target.querySelector('footer')).toBeNull();
  const open = page.target.querySelector('[data-peek-open]');
  expect(open?.className).toContain('open');
  expect(open?.className).not.toContain('primary');
  expect(open?.querySelector('kbd')?.textContent).toBe('↵');
  expect(page.target.querySelector('header [data-peek-open]')).toBeNull();

  page.remove();
  page = peek(cardFixture({ key: 'APP-16', stage: 'inbox', state: 'idle' }));
  expect(page.target.querySelector('[data-peek-actions]')).toBeNull();
  expect(page.target.querySelector('.body [data-peek-open]')).not.toBeNull();
});
