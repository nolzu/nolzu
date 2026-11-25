import { cloneStream } from '$lib/add-repo.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// The project's clones as an event stream, for the New project screen. Not async, for the board
// stream's reason: the first event goes out while the stream is built.
export const GET: RequestHandler = ({ request }) => cloneStream(database(), request);
