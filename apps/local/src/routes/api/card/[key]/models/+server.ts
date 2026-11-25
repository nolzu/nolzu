import { saveCardModels } from '$lib/card-models.ts';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request }) => {
  const live = loop();
  const answer = await saveCardModels(database(), params.key, request, live.models());
  // The board and the ticket page show what a move starts, which reads these models, so they are told.
  if (answer.ok) live.changed();
  return answer;
};
