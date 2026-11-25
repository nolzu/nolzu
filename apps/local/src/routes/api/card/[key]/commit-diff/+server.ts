import { json } from '@sveltejs/kit';
import { commitChanges, repoAsk } from '$lib/changes.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// The files one commit of the card's branch changed: ?commit=<id>, and &repo=<repository> for a child
// repository. The Not committed view of the Changes tab asks for it when the person opens a commit.
export const GET: RequestHandler = async ({ params, url, request }) => {
  const commit = url.searchParams.get('commit');
  if (commit === null || commit === '') return json({ ok: false, reason: 'A commit diff needs a commit id.' }, { status: 400 });
  return json(await commitChanges(database(), params.key, commit, process.env, request.signal, repoAsk(url.searchParams.get('repo'))));
};
