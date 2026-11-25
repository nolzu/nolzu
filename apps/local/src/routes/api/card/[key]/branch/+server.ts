import { json } from '@sveltejs/kit';
import { renameCardBranch } from '$lib/checkout.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// { name } renames the card's branch in every checkout, while nothing was pushed, and keeps the name
// for a card with no checkout yet.
export const POST: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  if (typeof body?.name !== 'string') return json({ message: 'The branch name is text.' }, { status: 400 });
  const done = await renameCardBranch(database(), params.key, body.name.trim(), process.env);
  return done.ok ? json(done) : json({ message: done.reason }, { status: 422 });
};
