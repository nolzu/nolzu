import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { workspacePatch } from '$lib/workspace.ts';
import type { RequestHandler } from './$types';

// GET ?repo=<id>&path=<file>, one changed file's patch. The path has to be in the folder's status.
export const GET: RequestHandler = async ({ url, request }) => {
  const repo = url.searchParams.get('repo');
  const path = url.searchParams.get('path');
  if (repo === null || path === null) return json({ ok: false, reason: 'Name the folder and the file.' }, { status: 400 });
  const patch = await workspacePatch(database(), repo, path, process.env, request.signal);
  return json(patch, { status: patch.ok ? 200 : 422 });
};
