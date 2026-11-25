import { error, redirect } from '@sveltejs/kit';
import { CLOUD_OPEN } from '@nolzu/protocol';
import { webTeamHref } from '$lib/display.ts';
import type { PageLoad } from './$types';

// Settings hides the Team link without the feature, and a typed address meets the same rule here.
// While the cloud is closed a typed address lands on Now, as Scout and Evidence do.
export const load: PageLoad = async ({ parent }) => {
  if (!CLOUD_OPEN) redirect(303, '/');
  const { display, cloud } = await parent();
  const webTeam = webTeamHref(display, cloud);
  if (webTeam === null) error(404, 'Team is part of a Team account. Your account has no team to show.');
  return { webTeam };
};
