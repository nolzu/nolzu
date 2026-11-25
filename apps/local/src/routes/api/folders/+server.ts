import { homedir } from 'node:os';
import { json } from '@sveltejs/kit';
import { listFolders } from '$lib/folders.ts';
import type { RequestHandler } from './$types';

// Browse on New project: `?path=<folder>`, or the home folder with none. Read only, and like every
// route it answers only at localhost on Nolzu's own port (`handle` in hooks.server.ts).
export const GET: RequestHandler = async ({ url }) => {
  const listed = await listFolders(url.searchParams.get('path'), homedir());
  const headers = { 'cache-control': 'no-store' };
  return 'problem' in listed ? json({ problem: listed.problem }, { status: listed.status, headers }) : json(listed, { headers });
};
