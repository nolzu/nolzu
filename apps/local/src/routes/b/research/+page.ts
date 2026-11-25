import type { PageLoad } from './$types';

// Research, one board over the question and investigation kinds. The two are on or
// off together, so one of them answers for the board. The cards come off the Now stream.
export const load: PageLoad = async ({ parent }) => {
  const { offBoards } = await parent();
  return { off: offBoards.includes('questions') };
};
