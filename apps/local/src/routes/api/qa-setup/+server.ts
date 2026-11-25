import { json } from '@sveltejs/kit';
import { getSetting } from '@nolzu/core/node';
import { loop } from '$lib/loop.ts';
import { commitMcpList } from '$lib/mcp-store.ts';
import { answerQa, qaSetupFor } from '$lib/qa-setup.ts';
import type { RequestHandler } from './$types';

// What the question shows for one card. The Now stream carries the project's answer, and the dialog
// asks here only when that has no start command, because the card's own copy can have one.
export const GET: RequestHandler = ({ url }) => json(qaSetupFor(loop().db, url.searchParams.get('key')));

// Start QA in the question at the first QA. The press is the consent: this saves the answer for the
// project, and the page then sends the move it held back.
export const POST: RequestHandler = async ({ request }) => {
  const live = loop();
  const refused = answerQa(live.db, await request.json().catch(() => null));
  if (refused !== null) return json({ message: refused }, { status: 422 });
  // Every open page reads the question off the Now stream, so none asks it again.
  live.changed();
  // The browser switch may have changed the MCP list. The answer stands either way, and a refused
  // commit leaves the file for the person to commit.
  await commitMcpList(getSetting(live.db, 'projectPath'));
  return json({ ok: true });
};
