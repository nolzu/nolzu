import { expect, it, vi } from 'vitest';

const workspacePush = vi.fn(async () => ({ ok: false, reason: 'stopped here' }));
const workspaceCommit = vi.fn(async () => ({ ok: false, reason: 'stopped here' }));
vi.mock('$lib/workspace.ts', async (actual) => ({ ...(await actual<typeof import('$lib/workspace.ts')>()), workspacePush, workspaceCommit, workspaceStatus: async () => ({ ok: false, reason: 'no project' }) }));
vi.mock('$lib/db.ts', () => ({ database: () => null }));

const push = (await import('./push/+server.ts')).POST as unknown as (event: { request: Request }) => Promise<Response>;
const commit = (await import('./commit/+server.ts')).POST as unknown as (event: { request: Request }) => Promise<Response>;
const post = (handler: typeof push, body: unknown) => handler({ request: new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }) });

// A pre-push or commit hook runs only for a literal true, and a push only with a literal true confirmation.
it('reads the confirmation and the hooks of a push as literal trues', async () => {
  await post(push, { repo: 'api', confirmed: true, hooks: true });
  await post(push, { repo: 'api', confirmed: 'yes', hooks: 'yes' });

  expect(workspacePush.mock.calls.map((call) => (call as unknown[]).slice(1, 4))).toEqual([
    ['api', true, true],
    ['api', false, false],
  ]);
});

it('refuses a body that names no folder or no files', async () => {
  expect((await post(push, { confirmed: true })).status).toBe(400);
  expect((await post(commit, { repo: '.', message: 'm' })).status).toBe(400);
  expect(workspaceCommit).not.toHaveBeenCalled();
});
