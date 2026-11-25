import { json } from '@sveltejs/kit';
import { openDiscussion } from '../../../../../../lib/feedback.ts';
import { loopOf } from '../../../../../../lib/loop.ts';
import type { RequestHandler } from './$types';

// Discuss on a row of the PRs tab: opens the thread under its ref on the Discussion tab, with the
// discussion and its triage as the first message. Starts no run.
export const POST: RequestHandler = async ({ params, request, url }) => {
  const ref = ((await request.json().catch(() => null)) as { ref?: unknown } | null)?.ref;
  const opened = openDiscussion(loopOf(url).db, params.key, typeof ref === 'string' ? ref : '');
  return opened.ok ? json({ thread: opened.thread }) : json({ message: opened.reason }, { status: 404 });
};
