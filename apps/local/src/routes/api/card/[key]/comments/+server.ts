import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { addComment } from '$lib/diff-comments.ts';
import type { RequestHandler } from './$types';

// A comment on one line of the card's diff: { repo, file, line, lineText, text }. Nothing runs: the
// comment waits for a send back.
export const POST: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const said = await addComment(database(), params.key, body, process.env, request.signal);
  return json(said.body, { status: said.status });
};
