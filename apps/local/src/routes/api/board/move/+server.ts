import { loopOf } from '../../../../lib/loop.ts';
import { move } from '../writes.ts';
import type { RequestHandler } from './$types';

// `?project=` names the project of the card, as Now sends it. Left out, the current project.
export const POST: RequestHandler = ({ request, url }) => move(loopOf(url), request);
