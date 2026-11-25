import { loopOf } from '../../../../../../lib/loop.ts';
import { deletePullLink, postPullLink } from '../../../../../../lib/pull-list.ts';
import type { RequestHandler } from './$types';

// Attach a pull request to a Delivery card by its link, and detach one a person attached. The attach
// reads it from GitHub first; neither writes to GitHub.
export const POST: RequestHandler = async ({ params, request, url }) => postPullLink(loopOf(url).db, params.key, await request.json().catch(() => null));

export const DELETE: RequestHandler = async ({ params, request, url }) => {
  const live = loopOf(url);
  return deletePullLink(live.db, params.key, await request.json().catch(() => null), live.changed);
};
