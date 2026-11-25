import { beforeEach, expect, it, vi } from 'vitest';

// Both handlers are stand-ins, so the test sees which one the route picks and nothing reaches gh.
const live = { db: 'the database', changed: () => {} };
const delivery = vi.fn(() => Promise.resolve(new Response('delivery')));
const reviews = vi.fn(() => Promise.resolve(new Response('reviews')));
vi.mock('../../../../lib/loop.ts', () => ({ loop: () => live }));
vi.mock('../../../../lib/pull-list.ts', () => ({ postDeliveryPulls: delivery, postPullRefresh: reviews }));

const { POST } = await import('./+server.ts');
const post = POST as unknown as (event: { url: URL }) => Promise<Response>;

beforeEach(() => {
  delivery.mockClear();
  reviews.mockClear();
});

// The Delivery board names itself, and every other press is the PR reviews read it always was.
it.each([
  ['?board=delivery', 'delivery'],
  ['', 'reviews'],
  ['?board=prreview', 'reviews'],
  ['?board=Delivery', 'reviews'],
])('sends %j to the %s handler', async (query, want) => {
  const response = await post({ url: new URL(`http://localhost/api/board/pulls${query}`) });

  expect(await response.text()).toBe(want);
  expect(delivery.mock.calls.length + reviews.mock.calls.length).toBe(1);
});

it('hands the handler the loop database and its way to tell the boards', async () => {
  await post({ url: new URL('http://localhost/api/board/pulls?board=delivery') });

  expect(delivery).toHaveBeenCalledWith(live.db, live.changed);
});
