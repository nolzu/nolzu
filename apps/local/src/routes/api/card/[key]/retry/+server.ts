import { loopOf } from '../../../../../lib/loop.ts';
import { retry } from '../../../board/writes.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, url }) => retry(loopOf(url), params.key, request);
