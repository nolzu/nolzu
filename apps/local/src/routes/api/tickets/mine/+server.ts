import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { myTickets } from '$lib/my-tickets.ts';
import type { RequestHandler } from './$types';

// Add card's list of the person's tickets with no card yet, asked once each time the dialog opens.
export const GET: RequestHandler = async () => json(await myTickets(database()));
