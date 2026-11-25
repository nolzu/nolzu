import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { workspaceCommit, workspaceCommitAsk, workspaceStatus } from '$lib/workspace.ts';
import type { RequestHandler } from './$types';

// { repo, message, paths, hooks } commits the ticked files of one folder. The answer carries the status
// read after it, so the page and the rail count show the folder as it is now.
export const POST: RequestHandler = async ({ request }) => {
  const ask = workspaceCommitAsk(await request.json().catch(() => null));
  if (ask === null) return json({ ok: false, reason: 'A commit names the folder, a message and the ticked files.' }, { status: 400 });
  const done = await workspaceCommit(database(), ask, process.env, request.signal);
  return json({ ...done, status: await workspaceStatus(database(), process.env, request.signal) }, { status: done.ok ? 200 : 422 });
};
