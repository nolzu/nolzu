import { closeNote } from '$lib/coach.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request }) => closeNote(database(), request);
