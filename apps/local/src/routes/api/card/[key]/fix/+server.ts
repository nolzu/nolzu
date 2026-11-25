import { loopOf } from '../../../../../lib/loop.ts';
import { fix } from '../../../board/writes.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, url }) => fix(loopOf(url), params.key);
