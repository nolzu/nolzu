import { postCard } from '../../../lib/create-card.ts';
import { loop } from '../../../lib/loop.ts';
import { endFirstRun } from '../../../lib/new-project.ts';
import { moveTo } from '../board/writes.ts';
import type { RequestHandler } from './$types';

// Add and start hands in the move a drop sends, so the start has the drop's rules and refusals.
export const POST: RequestHandler = async ({ request }) => {
  const live = loop();
  const answer = await postCard(live.db, live.changed, request, undefined, (key, to) => moveTo(live, key, to));
  // A first card made here and not on the first task screen ends the first run of a new project too.
  if (answer.status === 201) endFirstRun(live.db);
  return answer;
};
