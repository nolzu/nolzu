import type { CardView } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import TicketActions from './TicketActions.svelte';

// What the server render tests cannot reach: the press, the wait that follows it, and the alert.

const stages = boardFixture('pull-request').stages;
const stage = (id: string) => stages.find((found) => found.id === id) ?? null;
const at = (stageId: string, state: CardView['state'] = 'idle', key = 'APP-1') => cardFixture({ key, stage: stageId, state });

// An answer the test gives when it chooses to, so a press can be left waiting.
function pending() {
  const answers: ((said: string | null) => void)[] = [];
  const send = vi.fn<(to: string) => Promise<string | null>>(() => new Promise((resolve) => answers.push(resolve)));
  const answer = async (index: number, said: string | null) => {
    answers[index]?.(said);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
  };
  return { send, answer };
}

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

function draw(card: CardView, next: string | null, onmove: (to: string) => Promise<string | null>, onminimize: (value: boolean) => Promise<string | null> = async () => null) {
  page = mounted(TicketActions as never, { card, next: next === null ? null : stage(next), starts: 'Starts: /refine · haiku · low', onmove, onminimize });
  const move = () => page?.target.querySelector<HTMLButtonElement>('[data-move]') ?? null;
  const press = () => {
    move()?.click();
    flushSync();
  };
  return { move, press, held: () => move()?.getAttribute('aria-disabled') === 'true' };
}

it('sends the move once, holds the button, and takes no second press while it waits', () => {
  const { send } = pending();
  const ui = draw(at('inbox'), 'refine', send);

  ui.press();
  ui.press();

  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('refine');
  expect(ui.held()).toBe(true);
  // Held through aria-disabled. The disabled attribute would take the focus away at the press.
  expect(ui.move()?.disabled).toBe(false);
});

it('keeps holding when the request is answered, because only the board may end the wait', async () => {
  const { send, answer } = pending();
  const ui = draw(at('inbox'), 'refine', send);

  ui.press();
  await answer(0, null);

  expect(ui.held()).toBe(true);
});

it('lets go when the board moves the card on, and stays free when the card comes back', async () => {
  const { send, answer } = pending();
  const ui = draw(at('inbox'), 'refine', send);

  ui.press();
  await answer(0, null);
  page?.set({ card: at('refine', 'queued'), next: stage('plan') });
  expect(ui.held()).toBe(true);
  page?.set({ card: at('refine', 'ready'), next: stage('plan') });
  expect(ui.held()).toBe(false);

  // Dragged back to where the press happened. A click kept past the move would hold the button
  // again here, for good, because nothing is coming that could end it.
  page?.set({ card: at('inbox'), next: stage('refine') });
  expect(ui.held()).toBe(false);
});

it('is not let go by a snapshot that changed nothing about this card', () => {
  const { send } = pending();
  const ui = draw(at('inbox'), 'refine', send);

  ui.press();
  // A new object with the same stage and state, which is what every snapshot about another card
  // hands over.
  page?.set({ card: at('inbox') });

  expect(ui.held()).toBe(true);
});

it('ends the wait on a refusal and shows the sentence as an alert', async () => {
  const { send, answer } = pending();
  const ui = draw(at('inbox'), 'refine', send);

  ui.press();
  await answer(0, 'APP-1 cannot move from inbox to refine while it is queued.');

  expect(ui.held()).toBe(false);
  const alert = page?.target.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('APP-1 cannot move from inbox to refine while it is queued.');
});

it('drops a late answer to an earlier press, so it cannot end the wait of a later one', async () => {
  const { send, answer } = pending();
  const ui = draw(at('inbox'), 'refine', send);

  ui.press();
  page?.set({ card: at('refine', 'ready'), next: stage('plan') });
  ui.press();
  expect(send).toHaveBeenCalledTimes(2);
  await answer(0, 'The first move was refused.');

  expect(ui.held()).toBe(true);
  expect(page?.target.querySelector('[role="alert"]')).toBeNull();
});

it('asks for the opposite of what the snapshot says when Minimize is pressed', () => {
  const minimize = vi.fn<(minimized: boolean) => Promise<string | null>>(async () => null);
  draw({ ...at('inbox'), minimized: true }, 'refine', async () => null, minimize);

  page?.target.querySelector<HTMLButtonElement>('[data-minimize]')?.click();

  expect(minimize).toHaveBeenCalledWith(false);
});

describe('Retry and Stop', () => {
  function drawRun(card: CardView, onretry: () => Promise<string | null>, onstop: (runId: number) => Promise<string | null> = async () => null, extra: Record<string, unknown> = {}) {
    page = mounted(TicketActions as never, { card, next: stage('plan'), starts: undefined, onmove: async () => null, onminimize: async () => null, onretry, onstop, ...extra });
    const button = () => page!.target.querySelector<HTMLButtonElement>('[data-run]');
    return { button };
  }

  it('retries a failed card once, and stays busy until the board shows it queued', async () => {
    const onretry = vi.fn(async () => null);
    const ui = drawRun({ ...at('refine', 'failed'), runId: 3 }, onretry);

    ui.button()!.click();
    ui.button()!.click();
    await Promise.resolve();
    flushSync();

    expect(onretry).toHaveBeenCalledTimes(1);
    expect(ui.button()!.getAttribute('aria-busy')).toBe('true');
    page!.set({ card: { ...at('refine', 'queued'), runId: 4 } });
    expect(ui.button()!.textContent).toContain('Stop');
    expect(ui.button()!.getAttribute('aria-busy')).not.toBe('true');
  });

  it('stops the run the board names', async () => {
    const onstop = vi.fn(async () => null);
    const ui = drawRun({ ...at('refine', 'running'), runId: 4 }, async () => null, onstop);

    ui.button()!.click();
    await Promise.resolve();
    flushSync();

    expect(onstop).toHaveBeenCalledWith(4);
  });

  // The id is what the server knows a login by. Sending the label would 409 on every press, and a
  // server render cannot tell the two apart, because the button carries both.
  it('starts the phase on the login the button names, by id and not by label', async () => {
    const onrunon = vi.fn(async () => null);
    drawRun({ ...at('refine', 'failed'), runId: 3 }, async () => null, async () => null, {
      runOn: { profiles: [{ id: 'claude-code#work', label: 'Claude work' }], note: null },
      onrunon,
    });
    const button = () => page!.target.querySelector<HTMLButtonElement>('[data-run-on]');

    button()!.click();
    button()!.click();
    await Promise.resolve();
    flushSync();

    expect(onrunon).toHaveBeenCalledTimes(1);
    expect(onrunon).toHaveBeenCalledWith('claude-code#work');
    expect(button()!.getAttribute('aria-busy')).toBe('true');
  });

  it('shows a refused retry and lets the person press again', async () => {
    const ui = drawRun({ ...at('refine', 'failed'), runId: 3 }, async () => 'APP-1 is idle and not failed, so there is nothing to retry.');

    ui.button()!.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(page!.target.textContent).toContain('nothing to retry');
    expect(ui.button()!.getAttribute('aria-busy')).not.toBe('true');
  });
});

// A page with a toast host of its own takes the refusal there, and the row draws no toast of its own,
// so the screen keeps one corner. The next press takes it down again.
it('hands a refusal to the page when the page has a toast host, and draws none itself', async () => {
  const { send, answer } = pending();
  const said: (string | null)[] = [];
  page = mounted(TicketActions as never, { card: at('inbox'), next: stage('refine'), starts: 'Starts: /refine · haiku · low', onmove: send, onminimize: async () => null, onrefuse: (one: string | null) => said.push(one) });
  const press = () => {
    page?.target.querySelector<HTMLButtonElement>('[data-move]')?.click();
    flushSync();
  };

  press();
  await answer(0, 'APP-1 moved on in another tab.');

  expect(said).toEqual([null, 'APP-1 moved on in another tab.']);
  expect(page.target.querySelector('[role="alert"]')).toBeNull();
  expect(page.target.querySelector('[data-move]')?.getAttribute('aria-disabled')).toBeNull();

  press();
  expect(said.at(-1)).toBeNull();
});

// A page that asked a question first and sent nothing, because the person closed it, answers undefined:
// the button lets go and says nothing.
it('lets go with no alert when the page sent nothing after all', async () => {
  let answered: (said: string | null | undefined) => void = () => undefined;
  const send = vi.fn(() => new Promise<string | null | undefined>((resolve) => (answered = resolve)));
  const ui = draw(at('implement'), 'qa', send as never);

  ui.press();
  expect(ui.held()).toBe(true);
  answered(undefined);
  await Promise.resolve();
  await Promise.resolve();
  flushSync();

  expect(ui.held()).toBe(false);
  expect(page?.target.querySelector('[role="alert"]')).toBeNull();
});
