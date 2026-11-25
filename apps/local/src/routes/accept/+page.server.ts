import { fail, redirect } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { acceptTerms, afterAccept, TERMS, termsState } from '$lib/terms.ts';
import type { Actions, PageServerLoad } from './$types';

// The terms, on the first start and after they change. Once accepted the page has nothing to ask, so it
// sends the person on.
export const load: PageServerLoad = ({ url }) => {
  const state = termsState(database());
  if (state === 'accepted') redirect(303, afterAccept(url.searchParams.get('to')));
  return { terms: TERMS, changed: state === 'changed', to: url.searchParams.get('to') };
};

export const actions: Actions = {
  // A plain form post, which the server hook checks for another site as every write. The page then loads
  // whole, with the work this accept started.
  default: async ({ request, url }) => {
    const form = await request.formData();
    const refused = acceptTerms(database(), form.get('accept') === 'on');
    if (refused !== null) return fail(400, { message: refused });
    redirect(303, afterAccept(form.get('to')?.toString() ?? url.searchParams.get('to')));
  },
};
