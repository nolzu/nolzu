import { loopOf } from '../../../../../lib/loop.ts';
import { fixCi } from '../../../board/writes.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, url }) => fixCi(loopOf(url), params.key);
