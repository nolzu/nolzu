import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The project's settings moved into Settings as its first section. A link or a
// bookmark to the old page lands there, with its fragment, so `/projects#boards` still shows the
// board switches.
export const load: PageServerLoad = () => redirect(308, '/settings/project');
