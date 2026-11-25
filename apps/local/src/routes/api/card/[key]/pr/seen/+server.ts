import { loopOf } from '../../../../../../lib/loop.ts';
import { postDiscussionsSeen } from '../../../../../../lib/pull-list.ts';
import type { RequestHandler } from './$types';

// The PRs tab sends this as it opens, so the unread dots it shows are gone the next time.
export const POST: RequestHandler = ({ params, url }) => {
  const live = loopOf(url);
  return postDiscussionsSeen(live.db, params.key, live.changed);
};
