import { database } from '$lib/db.ts';
import { renameThread } from '$lib/discussion.ts';
import type { RequestHandler } from './$types';

// Rename an Ask discussion: { thread, subject }. The name is the person's from then on.
export const PATCH: RequestHandler = ({ params, request }) => renameThread(database(), params.key, request);
