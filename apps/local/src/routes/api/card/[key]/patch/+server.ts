import { json } from '@sveltejs/kit';
import { patchAsk, patchFor, repoAsk } from '$lib/changes.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// One file's patch for the Changes tab: ?path=<file>&group=branch|committed|uncommitted|commit, and
// &commit=<id> with the commit group, &old=<path> for a rename, and &repo=<repository> for a child
// repository. The answer is the runner's own shape,
// the text or the reason there is none.
export const GET: RequestHandler = async ({ params, url, request }) => {
  const ask = patchAsk(url.searchParams);
  if (ask === null) return json({ ok: false, reason: 'A patch needs a file path and a group: branch, committed, uncommitted, or commit with a commit id.' }, { status: 400 });
  return json(await patchFor(database(), params.key, ask, process.env, request.signal, repoAsk(url.searchParams.get('repo'))));
};
