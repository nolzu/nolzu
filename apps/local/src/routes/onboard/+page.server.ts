import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The old address of the first run. A link or a bookmark to it lands on New project.
export const load: PageServerLoad = () => redirect(307, '/new');
