import { json } from '@sveltejs/kit';
import { commitAsk, commitFor, repoAsk } from '$lib/changes.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// Step one of the composer: { message, only, repo, hooks }, `only` the ticked paths. Nothing leaves the
// machine here.
export const POST: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const ask = commitAsk(body);
  if (ask === null) return json({ ok: false, reason: 'A commit needs a message, and a list of the files to commit.' }, { status: 400 });
  const done = await commitFor(database(), params.key, ask.message, ask.include, process.env, request.signal, repoAsk((body as { repo?: unknown }).repo), ask.hooks, ask.only);
  return json(done, { status: done.ok ? 200 : 422 });
};
