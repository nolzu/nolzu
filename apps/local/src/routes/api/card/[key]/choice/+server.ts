import { database } from '$lib/db.ts';
import { settleQuestion } from '$lib/gate.ts';
import type { RequestHandler } from './$types';

// The person's choice on a question that blocks the next move: { id } takes the default, { id, answer } answers it.
export const POST: RequestHandler = ({ params, request }) => settleQuestion(database(), params.key, request);
