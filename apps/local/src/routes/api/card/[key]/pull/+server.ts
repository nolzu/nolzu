import { json } from '@sveltejs/kit';
import { repoAsk } from '$lib/changes.ts';
import { database } from '$lib/db.ts';
import { pullFor } from '$lib/publish.ts';
import type { RequestHandler } from './$types';

// "Pull into the checkout" after a rejected push: { repo } pulls the card's branch of that repository
// into the card's checkout. A conflict answers 409 with the files, and the checkout keeps the merge open.
export const POST: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => null)) as { repo?: unknown } | null;
  const done = await pullFor(database(), params.key, process.env, request.signal, repoAsk(body?.repo));
  return json(done, { status: done.ok ? 200 : done.conflicts.length > 0 ? 409 : 422 });
};
