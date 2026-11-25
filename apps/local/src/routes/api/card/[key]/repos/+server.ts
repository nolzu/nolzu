import { saveCardRepos } from '$lib/card-repos.ts';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request }) => {
  const answer = await saveCardRepos(database(), params.key, request);
  // The board refuses a run on a card with no list, so it is told when the list changes.
  if (answer.ok) loop().changed();
  return answer;
};
