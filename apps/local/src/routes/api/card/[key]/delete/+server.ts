import { deleteCard, deleteCheck } from '$lib/delete-card.ts';
import { loopOf } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// `GET`: what Delete card would remove and lose, read now, which the confirm asks for as it opens. It
// changes nothing, and its `seen` is the counts it showed. `POST { seen, folder? }`: deletes the card,
// and its card folder too when folder is true. `seen` is required: a checkout that holds more than it
// says, or one it does not name, refuses the delete.
export const GET: RequestHandler = async ({ params, url }) => deleteCheck(loopOf(url), params.key);

export const POST: RequestHandler = async ({ params, request, url }) => deleteCard(loopOf(url), params.key, await request.json().catch(() => null));
