import { json } from '@sveltejs/kit';
import { knowledgeChange } from '@nolzu/core/node';
import { database } from '$lib/db.ts';
import { knowledgeLane } from '$lib/knowledge-page.ts';
import { revertKnowledge } from '$lib/knowledge-revert.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// Revert on a closed card: the Knowledge screen's revert, for a change this card made. A revert commit
// and no run, so it answers the post itself. The knowledge lane is read off the board snapshot.
export const POST: RequestHandler = async ({ params, request }) => {
  const change = Number(((await request.json().catch(() => null)) as { change?: unknown } | null)?.change);
  const row = Number.isInteger(change) ? knowledgeChange(database(), change) : null;
  if (row !== null && row.cardKey !== params.key) return json({ ok: false, message: `Knowledge change ${change} is not one ${params.key} made.` }, { status: 404 });
  const said = await revertKnowledge(database(), { changeId: change, busy: knowledgeLane(loop().snapshot()) });
  return json(said, { status: said.ok ? 200 : 409 });
};
