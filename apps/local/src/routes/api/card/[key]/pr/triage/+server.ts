import { loopOf } from '../../../../../../lib/loop.ts';
import { triage } from '../../../../board/writes.ts';
import type { RequestHandler } from './$types';

// "Run triage" and "Triage again" on the PRs tab: a read-only run over the open discussions. It posts
// nothing to GitHub; the drafted replies are copied by the person.
export const POST: RequestHandler = ({ params, url }) => triage(loopOf(url), params.key);
