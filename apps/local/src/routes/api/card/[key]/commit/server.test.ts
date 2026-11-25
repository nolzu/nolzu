import { expect, it, vi } from 'vitest';

const commitFor = vi.fn(async () => ({ ok: false, reason: 'stopped here' }));
vi.mock('$lib/changes.ts', async (actual) => ({ ...(await actual<typeof import('$lib/changes.ts')>()), commitFor }));
vi.mock('$lib/db.ts', () => ({ database: () => null }));

const { POST } = await import('./+server.ts');
const post = (body: unknown) =>
  (POST as unknown as (event: { params: { key: string }; request: Request }) => Promise<Response>)({
    params: { key: 'APP-1' },
    request: new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }),
  });

// The repository's hooks run on the commit only when the person ticked Run hooks, sent as true.
it('runs the hooks on a commit only for a literal true', async () => {
  await post({ message: 'feat: search', hooks: true });
  await post({ message: 'feat: search' });
  await post({ message: 'feat: search', hooks: 1 });

  expect(commitFor.mock.calls.map((call) => (call as unknown[])[7])).toEqual([true, false, false]);
});
