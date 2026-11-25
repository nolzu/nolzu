import { postTasks } from '$lib/create-card.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// The tasks of an epic: { titles, keys?, descriptions?, steps?, refs?, notes? }, one title per Delivery card.
export const POST: RequestHandler = ({ params, request }) => {
  const live = loop();
  return postTasks(live.db, live.changed, params.key, request);
};
