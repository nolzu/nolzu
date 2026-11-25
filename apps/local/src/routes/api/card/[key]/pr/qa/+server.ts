import { loopOf } from '../../../../../../lib/loop.ts';
import { qaFixes } from '../../../../board/writes.ts';
import type { RequestHandler } from './$types';

// QA the fixes on the PRs tab: a QA run over what was fixed since the last QA, while the card stays
// where it is.
export const POST: RequestHandler = ({ params, url }) => qaFixes(loopOf(url), params.key);
