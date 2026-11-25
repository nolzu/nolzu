import { loopOf } from '../../../../../../lib/loop.ts';
import { fixAll } from '../../../../board/writes.ts';
import type { RequestHandler } from './$types';

// Fix all on the PRs tab: one Implement run over every comment triage wants fixed, which stops after
// its edits. It commits nothing, pushes nothing and posts nothing to GitHub.
export const POST: RequestHandler = ({ params, url }) => fixAll(loopOf(url), params.key);
