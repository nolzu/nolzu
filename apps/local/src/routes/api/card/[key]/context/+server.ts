import { database } from '$lib/db.ts';
import { saveContext } from '$lib/overview.ts';
import type { RequestHandler } from './$types';

// The extra context of a card: { text }, where an empty text clears it.
export const PATCH: RequestHandler = ({ params, request }) => saveContext(database(), params.key, request);
