import { error } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { scoutFindingDetail } from '$lib/scout-detail.ts';
import { scoutPage } from '$lib/scout-page.ts';
import type { PageServerLoad } from './$types';

// The Scout page with this finding selected in the inbox.
export const load: PageServerLoad = ({ params }) => {
  const found = scoutFindingDetail(database(), params.id);
  // An address with no finding behind it is a page that is not there. An empty one would read as a
  // page that broke, so the sentence names what was asked for.
  if (!found.ok) error(found.status, found.message);
  // Named again, so the type says this page always has its finding.
  return { ...scoutPage(found.detail), finding: found.detail };
};

// Every form of the Scout page, because this is the Scout page. After a post the page loads again,
// so it shows the state the write left, with this finding still selected.
export { actions } from '../../+page.server.ts';
