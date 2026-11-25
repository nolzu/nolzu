import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { workspaceStatus } from '$lib/workspace.ts';
import type { RequestHandler } from './$types';

// The Workspace page asks this when it opens and on Check again. It is the only read of git status there.
export const GET: RequestHandler = async ({ request }) => {
  const status = await workspaceStatus(database(), process.env, request.signal);
  return json(status, { status: status.ok ? 200 : 422 });
};
