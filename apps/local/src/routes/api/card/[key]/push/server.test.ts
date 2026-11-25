import { expect, it, vi } from 'vitest';

const pushFor = vi.fn(async () => ({ ok: false, reason: 'stopped here' }));
const commitAndPush = vi.fn(async () => ({ ok: false, reason: 'stopped here' }));
vi.mock('$lib/publish.ts', () => ({ pushFor }));
vi.mock('$lib/changes.ts', async (actual) => ({ ...(await actual<typeof import('$lib/changes.ts')>()), commitAndPush }));
vi.mock('$lib/db.ts', () => ({ database: () => null }));
const watchPulls = vi.fn();
vi.mock('$lib/loop.ts', () => ({ loop: () => ({ changed: () => undefined, watchPulls }) }));

const { POST } = await import('./+server.ts');
const post = (body: unknown) =>
  (POST as unknown as (event: { params: { key: string }; request: Request }) => Promise<Response>)({
    params: { key: 'APP-1' },
    request: new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }),
  });

// The repository's hooks run on a push only when the body says true, so a missing or odd value keeps
// a hook an agent planted from running outside the wall.
it('runs the hooks on a push only for a literal true', async () => {
  await post({ confirmed: true, hooks: true });
  await post({ confirmed: true });
  await post({ confirmed: true, hooks: 'yes' });

  expect(pushFor.mock.calls.map((call) => (call as unknown[])[6])).toEqual([true, false, false]);
});

it('hands the hooks choice to Commit and push with the message', async () => {
  await post({ confirmed: true, message: 'feat: search', hooks: true });
  await post({ confirmed: true, message: 'feat: search' });

  expect(commitAndPush.mock.calls.map((call) => ((call as unknown[])[3] as { hooks: boolean }).hooks)).toEqual([true, false]);
});
