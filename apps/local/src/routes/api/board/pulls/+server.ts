import { loop } from '../../../../lib/loop.ts';
import { postDeliveryPulls, postPullRefresh } from '../../../../lib/pull-list.ts';
import type { RequestHandler } from './$types';

// The Delivery board names itself. Anything else is the PR reviews board's read, as it always was.
export const POST: RequestHandler = ({ url }) => {
  const live = loop();
  return url.searchParams.get('board') === 'delivery' ? postDeliveryPulls(live.db, live.changed) : postPullRefresh(live.db, live.changed);
};
