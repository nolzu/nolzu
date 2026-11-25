import type { BoardSnapshot } from '@nolzu/protocol';
import { boardFixture } from '@nolzu/ui/fixture';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import NowRoute from '../routes/+page.svelte';
import type { ChainView } from './chain.ts';
import type { NowSnapshot } from './now.ts';
import { nowLive } from './now-live.svelte.ts';

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

// The chain suggestion's slot on Now, mounted for real: a press posts, and the slot draws only what the
// next snapshot says.

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }));

const posted = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response('{"ok":true}', { status: 200 }));
let parts: { instance: object; target: HTMLElement }[] = [];

beforeEach(() => {
  posted.mockClear();
  vi.stubGlobal('fetch', posted);
});

afterEach(() => {
  for (const part of parts) {
    void unmount(part.instance);
    part.target.remove();
  }
  parts = [];
  vi.unstubAllGlobals();
});

const machine = (chain: ChainView | undefined, version = 1): NowSnapshot => ({
  version,
  boards: [{ ...boardFixture('pull-request', []), version } satisfies BoardSnapshot],
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 0, fresh: 0, newest: null },
  ...(chain === undefined ? {} : { chain }),
});

function send(snapshot: NowSnapshot): void {
  nowLive.state = { snapshot, reconnecting: false, activity: {}, limits: {} };
  flushSync();
}

function open(snapshot: NowSnapshot): void {
  drawnAt('/');
  send(snapshot);
  const target = document.body.appendChild(document.createElement('div'));
  parts.push({ instance: mount(NowRoute as never, { target, props: {} }), target });
  flushSync();
}

const slot = () => document.querySelector<HTMLElement>('[data-chain]');
// Focused first, as a keyboard press leaves it. Flushed, so the held button is drawn before
// `settled` waits for it to come free.
const press = (data: string) => {
  const button = document.querySelector<HTMLButtonElement>(`[${data}]`)!;
  button.focus();
  button.click();
  flushSync();
};
const settled = () => vi.waitFor(() => expect(document.querySelector('[data-chain] [aria-disabled]')).toBeNull());
const bodies = () => posted.mock.calls.map((call) => [call[0], call[1].body]);

it('turns the chain on from the suggestion, and shows the off switch once the snapshot says so', async () => {
  open(machine({ on: false, approved: 9 }));

  expect(slot()?.dataset.chain).toBe('suggest');
  expect(slot()?.textContent).toContain('You approved 9 of the last 9 plans without a change. Let Implement start right after Plan on the cards you tick?');
  press('data-chain-on');
  // A second press while the first is on its way sends nothing more.
  press('data-chain-on');
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(bodies()).toEqual([['./api/chain', JSON.stringify({ board: 'delivery', on: true })]]);

  // The answer alone changes nothing on screen. The snapshot does.
  await vi.waitFor(() => expect(document.querySelector('[data-chain-on]')?.getAttribute('aria-disabled')).toBeNull());
  expect(slot()?.dataset.chain).toBe('suggest');
  send(machine({ on: true, approved: null }, 2));
  expect(slot()?.dataset.chain).toBe('on');
  expect(slot()?.textContent).toContain('Implement after Plan');

  press('data-chain-off');
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
  expect(bodies()[1]).toEqual(['./api/chain', JSON.stringify({ board: 'delivery', on: false })]);
  send(machine({ on: false, approved: null }, 3));
  expect(slot()).toBeNull();
});

it('posts Not now, and the card goes when the snapshot drops it', async () => {
  open(machine({ on: false, approved: 6 }));

  press('data-chain-later');
  await vi.waitFor(() => expect(posted).toHaveBeenCalledOnce());
  expect(bodies()).toEqual([['./api/chain', JSON.stringify({ notNow: true })]]);
  send(machine({ on: false, approved: null }, 2));
  expect(slot()).toBeNull();
});

// The pressed button is gone once the snapshot redraws the slot, so the keyboard would start over
// from the top of the page.
it('keeps the focus in the slot, or moves it on to Scout, when a press redraws it', async () => {
  open(machine({ on: false, approved: 9 }));

  press('data-chain-on');
  await settled();
  send(machine({ on: true, approved: null }, 2));
  expect(document.activeElement).toBe(slot());

  press('data-chain-off');
  await settled();
  send(machine({ on: false, approved: 9 }, 3));
  expect(slot()?.dataset.chain).toBe('suggest');
  expect(document.activeElement).toBe(slot());

  press('data-chain-later');
  await settled();
  send(machine({ on: false, approved: null }, 4));
  expect(document.activeElement).toBe(document.querySelector('a.scout'));
  expect(posted).toHaveBeenCalledTimes(3);
});

it('says a refused press in the slot', async () => {
  posted.mockImplementationOnce(async () => new Response(JSON.stringify({ message: 'The boards with a chain turned on are a list of board names.' }), { status: 400 }));
  open(machine({ on: false, approved: 6 }));

  press('data-chain-on');
  await vi.waitFor(() => expect(slot()?.querySelector('[role="status"]')?.textContent).toBe('The boards with a chain turned on are a list of board names.'));
});

it('draws no slot below the threshold, or from a snapshot that carries no chain', () => {
  open(machine({ on: false, approved: null }));
  expect(slot()).toBeNull();

  send(machine(undefined, 2));
  expect(slot()).toBeNull();
});
