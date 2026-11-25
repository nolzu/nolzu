import { database } from '$lib/db.ts';
import { fileResponse } from '$lib/files.ts';
import type { RequestHandler } from './$types';

// One file of the card folder at an address shaped like its path, which is what the Files tab frames.
// A design screen links `tokens.css` beside it, and only here does that relative link land on the
// file next to the screen. The query route would drop the path and fetch nothing. The same reader,
// jail and policy answer both.
export const GET: RequestHandler = ({ params }) => {
  if (params.path === '') return new Response('A file needs a path.', { status: 400 });
  return fileResponse(database(), params.key, params.path, false);
};
