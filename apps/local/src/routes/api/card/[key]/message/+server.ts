import { database } from '$lib/db.ts';
import { sendMessage } from '$lib/discussion.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request }) =>
  sendMessage(database(), params.key, request, loop().discuss, loop().models());
