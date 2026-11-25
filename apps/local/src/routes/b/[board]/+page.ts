import { error, redirect } from '@sveltejs/kit';
import { isResearchKind } from '@nolzu/protocol';
import { boardKind } from '$lib/board-page.ts';
import type { PageLoad } from './$types';

// A name that is not one of the five is a page that is not there, and says so. A board the project
// turned off is there and says it is off, so a saved link does not read as a broken one. The two kinds
// of the Research board had boards of their own, so a saved link to either goes on to Research.
export const load: PageLoad = async ({ params, parent }) => {
  const kind = boardKind(params.board);
  if (kind === null) error(404, `There is no ${params.board} board. The Delivery board is at /b/delivery.`);
  if (isResearchKind(kind)) redirect(308, '/b/research');
  const { offBoards } = await parent();
  return { off: offBoards.includes(kind) ? kind : null };
};
