import { loopOf } from '../../../../../../lib/loop.ts';
import { fixFeedback } from '../../../../board/writes.ts';
import type { RequestHandler } from './$types';

// Fix and Fix again on a row of the PRs tab: the Implement session goes on with that discussion and
// stops after its edits. It commits nothing, pushes nothing and posts nothing to GitHub.
export const POST: RequestHandler = async ({ params, request, url }) => fixFeedback(loopOf(url), params.key, await request.json().catch(() => null));
