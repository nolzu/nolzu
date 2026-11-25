import { loopOf } from '../../../../../../lib/loop.ts';
import { postCardDiscussions } from '../../../../../../lib/pull-list.ts';
import type { RequestHandler } from './$types';

// "Read comments" on a Delivery card. Only this press and the board's "Read pull requests" read them.
export const POST: RequestHandler = ({ params, url }) => {
  const live = loopOf(url);
  return postCardDiscussions(live.db, params.key, live.changed);
};
