import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCardModels, writeSetting } from '@nolzu/core/node';
import type { CardSize } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { saveCardChain } from './chain-store.ts';
import { createLoop, type Loop } from './loop.ts';

// The chain a person allowed in advance, on the real loop with the fake engine: a small Delivery card
// whose plan ended ready starts Implement once, through the drop's own writer.
let dir = '';
let loop: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-chain-'));
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, size: CardSize | null) =>
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title, size) VALUES (?, 'delivery', 'refine', 'ready', ?, ?)").run(key, `${key} title`, size);

const card = (key: string) => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };
const runs = (key: string) => loop.db.prepare('SELECT phase, state, chain_refused FROM runs WHERE card_key = ? ORDER BY id').all(key) as { phase: string; state: string; chain_refused: string | null }[];
const moves = (key: string) => loop.db.prepare('SELECT from_stage, to_stage, who, started_phase FROM card_events WHERE card_key = ? ORDER BY id').all(key);

// A drop onto Plan, then a queue that stays empty after a turn of the event loop, so a chain that was
// going to start has started and ended by then.
async function planned(key: string): Promise<void> {
  expect(await moveTo(loop, key, 'plan')).toBeNull();
  await vi.waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = loop.scheduler.queue();
    expect(queue.running.length + queue.waiting.length).toBe(0);
  });
}

it('chains nothing until the person turns it on', async () => {
  addCard('APP-1', 'small');

  await planned('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'plan', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['plan']);
});

it('starts Implement once after Plan on a small card, and goes no further', async () => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', 'small');

  await planned('APP-1');

  expect(runs('APP-1').map((run) => [run.phase, run.state])).toEqual([['plan', 'complete'], ['implement', 'complete']]);
  // Implement chains nowhere, so the card waits there for a person.
  expect(card('APP-1')).toEqual({ stage: 'implement', state: 'ready' });
  // The move a drop records, made by Nolzu, so no approval is read into it.
  expect(moves('APP-1')).toEqual([
    { from_stage: 'refine', to_stage: 'plan', who: 'you', started_phase: 'plan' },
    { from_stage: 'plan', to_stage: 'implement', who: 'auto', started_phase: 'implement' },
  ]);
  expect(runs('APP-1')[0]?.chain_refused).toBeNull();
});

it.each(['medium', 'large', null] as const)('leaves a card sized %s on Plan with the chain on', async (size) => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', size);

  await planned('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'plan', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['plan']);
});

// A drop onto Implement would refuse this model before sending anything, so the chain starts nothing
// and the card waits on Plan, as after a refused drop, with the reason on the run that ended.
it('starts nothing when the start is refused, and says why', async () => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', 'small');
  setCardModels(loop.db, 'APP-1', { implement: { engine: 'claude-code', model: 'gpt-9' } });

  await planned('APP-1');

  expect(card('APP-1')).toEqual({ stage: 'plan', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['plan']);
  expect(moves('APP-1')).toHaveLength(1);
  expect(runs('APP-1')[0]?.chain_refused).toMatch(/^Implement did not start on its own\. .*gpt-9.*Pick another model/);
});

// Most tests here use APP-1 alone, so a chain that wrote the wrong key would still pass them. Here the
// second card is the one that chains, and the first card stays put.
it('chains the card whose plan ended, not another card', async () => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', 'medium');
  addCard('APP-2', 'small');

  await planned('APP-1');
  await planned('APP-2');

  expect(card('APP-1')).toEqual({ stage: 'plan', state: 'ready' });
  expect(card('APP-2')).toEqual({ stage: 'implement', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['plan']);
  expect(runs('APP-2').map((run) => run.phase)).toEqual(['plan', 'implement']);
});

it('reads the refusal from the card that chains, not another card', async () => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', 'small');
  addCard('APP-2', 'small');
  setCardModels(loop.db, 'APP-2', { implement: { engine: 'claude-code', model: 'gpt-9' } });

  await planned('APP-1');
  await planned('APP-2');

  expect(card('APP-1').stage).toBe('implement');
  expect(card('APP-2')).toEqual({ stage: 'plan', state: 'ready' });
  expect(runs('APP-2')[0]?.chain_refused).toMatch(/gpt-9/);
});

// One plan run asks for one chain. A refused card must not start Implement later, when some other
// card's run makes the scheduler speak, because no new plan ended.
it('asks for a chain once per plan run, even after the refusal is gone', async () => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', 'small');
  addCard('APP-2', 'medium');
  setCardModels(loop.db, 'APP-1', { implement: { engine: 'claude-code', model: 'gpt-9' } });

  await planned('APP-1');
  setCardModels(loop.db, 'APP-1', {});
  await planned('APP-2');

  expect(card('APP-1')).toEqual({ stage: 'plan', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['plan']);
});

// The tick on the card's Settings tab is what makes a card chain, now that Add card sets no size.
it('chains a card ticked on its Settings tab, and stops once the tick is taken off', async () => {
  writeSetting(loop.db, 'chainBoards', ['delivery']);
  addCard('APP-1', null);
  addCard('APP-2', null);
  const tick = (key: string, on: boolean) => saveCardChain(loop, key, new Request(`http://localhost/api/card/${key}/chain`, { method: 'PATCH', body: JSON.stringify({ on }) }));
  expect((await tick('APP-1', true)).status).toBe(200);
  expect((await tick('APP-2', true)).status).toBe(200);
  expect((await tick('APP-2', false)).status).toBe(200);

  await planned('APP-1');
  await planned('APP-2');

  expect(card('APP-1')).toEqual({ stage: 'implement', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['plan', 'implement']);
  expect(card('APP-2')).toEqual({ stage: 'plan', state: 'ready' });
});
