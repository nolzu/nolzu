import { json } from '@sveltejs/kit';
import { messageAsk, messageFor, repoAsk } from '$lib/changes.ts';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// The two message buttons of the composer: { short, repo }. Answers with the message for the box, which
// the person can still change before they commit.
export const POST: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const ask = messageAsk(body);
  if (ask === null) return json({ ok: false, reason: 'A message request says whether it wants the short kind.' }, { status: 400 });
  const done = await messageFor(database(), params.key, ask.short, loop().writeMessage, process.env, request.signal, repoAsk((body as { repo?: unknown }).repo));
  return json(done, { status: done.ok ? 200 : 422 });
};
