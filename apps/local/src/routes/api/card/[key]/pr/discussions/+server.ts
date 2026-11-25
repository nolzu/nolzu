import { loopOf } from '../../../../../../lib/loop.ts';
import { patchDiscussion } from '../../../../../../lib/pull-list.ts';
import type { RequestHandler } from './$types';

// Mark done, Reopen and Needs action on a row of the PRs tab. Kept here, GitHub is not told.
export const PATCH: RequestHandler = async ({ params, request, url }) => {
  const live = loopOf(url);
  return patchDiscussion(live.db, params.key, await request.json().catch(() => null), live.changed);
};
