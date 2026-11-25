import { loopOf } from '../../../../../lib/loop.ts';
import { sendBack } from '../../../board/writes.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, url }) => sendBack(loopOf(url), params.key);
