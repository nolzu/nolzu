import { json } from '@sveltejs/kit';
import { checkoutsSaid, removeCardCheckouts } from '$lib/checkouts.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// Removes a closed card's checkouts. The answer names what went and each checkout that stayed.
export const POST: RequestHandler = async ({ params }) => {
  const done = await removeCardCheckouts(database(), params.key);
  return done.ok ? json({ ok: true, said: checkoutsSaid(params.key, done) }) : json(done, { status: 422 });
};
