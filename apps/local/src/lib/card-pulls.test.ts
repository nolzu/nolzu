import { expect, it, vi } from 'vitest';
import { merged, pullTrail, readCardPulls } from './card-pulls.ts';

const answer = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const line = (state: 'open' | 'merged' | null) => ({ repo: 'acme/recipes', branch: 'APP-1-sort', number: 12, url: 'https://example.com/12', state });

// The card head and the closed card's Overview both want the state. One gh read serves both.
it('asks once for two readers of the same card, and again for another card', async () => {
  const get = vi.fn(async () => answer({ pulls: [line('merged')], said: null }));

  const [one, two] = await Promise.all([readCardPulls('/api/card/APP-1/pr', get), readCardPulls('/api/card/APP-1/pr', get)]);
  await readCardPulls('/api/card/APP-2/pr', get);

  expect(one).toBe(two);
  expect(get).toHaveBeenCalledTimes(2);
});

it('says the app is not answering when the read throws or is refused', async () => {
  const said = 'The pull request state could not be read. The local app is not answering.';

  expect(await readCardPulls('/api/card/APP-3/pr', async () => { throw new Error('down'); })).toEqual({ pulls: [], said });
  expect(await readCardPulls('/api/card/APP-4/pr', async () => new Response('', { status: 500 }))).toEqual({ pulls: [], said });
});

// "Changes merged" needs a pull request that reads merged. An unread state claims nothing.
it('reads merged only off a pull request that says so', () => {
  expect(merged({ pulls: [line('merged'), line('merged')], said: null })).toBe(true);
  expect(merged({ pulls: [line('open'), line('merged')], said: null })).toBe(false);
  expect(merged({ pulls: [], said: null })).toBe(false);
  expect(merged({ pulls: [line(null)], said: 'GitHub did not answer.' })).toBe(false);
});

// Parity line 459: the closed card's Pull request row, from the lookup.
it('says when the pull request was opened and who merged it when', () => {
  const opened = '2026-10-20T10:02:00Z';
  const at = '2026-10-20T10:36:00Z';

  expect(pullTrail({ ...line('merged'), number: 42, openedAt: opened, mergedBy: 'you', mergedAt: at })).toEqual([
    { words: '#42 opened', at: opened },
    { words: ', merged by you', at },
  ]);
  expect(pullTrail({ ...line('merged'), mergedBy: 'dana' })).toEqual([{ words: '#12' }, { words: ', merged by dana' }]);
  expect(pullTrail(line('open'))).toEqual([{ words: '#12' }]);
  expect(pullTrail({ ...line(null), number: null })).toBeNull();
});
