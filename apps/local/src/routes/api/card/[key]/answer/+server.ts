import { loopOf } from '../../../../../lib/loop.ts';
import { answer } from '../../../board/writes.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, url }) => answer(loopOf(url), params.key, request);
