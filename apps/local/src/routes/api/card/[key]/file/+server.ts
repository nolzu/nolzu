import { database } from '$lib/db.ts';
import { fileResponse } from '$lib/files.ts';
import type { RequestHandler } from './$types';

// One file of the card folder: ?path=<file>, and &download=1 to save it rather than show it.
export const GET: RequestHandler = ({ params, url }) => {
  const path = url.searchParams.get('path');
  if (path === null || path === '') return new Response('A file needs a path.', { status: 400 });
  return fileResponse(database(), params.key, path, url.searchParams.get('download') === '1');
};
