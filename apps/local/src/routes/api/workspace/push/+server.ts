import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { workspacePush, workspaceStatus } from '$lib/workspace.ts';
import type { RequestHandler } from './$types';

// { repo, confirmed: true } pushes that folder's branch to its upstream. The page shows the folder's
// confirmation sentence from the status first. { hooks: true } runs the pre-push hook.
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { repo?: unknown; confirmed?: unknown; hooks?: unknown } | null;
  if (typeof body?.repo !== 'string') return json({ ok: false, reason: 'A push names the folder.' }, { status: 400 });
  const done = await workspacePush(database(), body.repo, body.confirmed === true, body.hooks === true, process.env, request.signal);
  return json({ ...done, status: await workspaceStatus(database(), process.env, request.signal) }, { status: done.ok ? 200 : 422 });
};
