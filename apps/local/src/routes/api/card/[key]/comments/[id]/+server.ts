import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { deleteComment, editComment } from '$lib/diff-comments.ts';
import type { RequestHandler } from './$types';

// Edit a comment's text: { text }.
export const PATCH: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const said = editComment(database(), params.key, params.id, body);
  return json(said.body, { status: said.status });
};

export const DELETE: RequestHandler = ({ params }) => {
  const said = deleteComment(database(), params.key, params.id);
  return json(said.body, { status: said.status });
};
