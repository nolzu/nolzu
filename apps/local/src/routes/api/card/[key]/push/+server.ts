import { json } from '@sveltejs/kit';
import { commitAndPush, commitAsk, repoAsk } from '$lib/changes.ts';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import { pushFor } from '$lib/publish.ts';
import type { RequestHandler } from './$types';

// { confirmed: true, repo } pushes the card's branch of that repository. With { message, only } it
// commits the folder first, which the Changes tab no longer asks for. { hooks: true } runs the
// repository's git hooks on that commit and push. Without the confirmation nothing is sent.
export const POST: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => null)) as { confirmed?: unknown; repo?: unknown; message?: unknown; hooks?: unknown } | null;
  const commit = body?.message === undefined ? null : commitAsk(body);
  if (body?.message !== undefined && commit === null) return json({ ok: false, reason: 'A commit message is text, and only names the files to commit.' }, { status: 400 });
  const confirmed = body?.confirmed === true;
  const repo = repoAsk(body?.repo);
  const done = commit === null ? await pushFor(database(), params.key, confirmed, process.env, request.signal, repo, body?.hooks === true) : await commitAndPush(database(), params.key, confirmed, commit, process.env, request.signal, repo);
  // The rail's Getting started counts the first push, and reads it off the Now stream. The card's pull
  // request is looked for at once, as a push to a branch that has one updates it.
  if (done.ok) {
    loop().changed();
    loop().watchPulls(params.key);
  }
  return json(done, { status: done.ok ? 200 : 422 });
};
