import { redirect } from '@sveltejs/kit';
import { TAB_REDIRECT } from '$lib/ticket.ts';
import type { PageServerLoad } from './$types';

// The card's own URL is the overview, so /t/<key> never renders a page of its own.
export const load: PageServerLoad = ({ params }) => {
  redirect(TAB_REDIRECT, `/t/${encodeURIComponent(params.key)}/overview`);
};
