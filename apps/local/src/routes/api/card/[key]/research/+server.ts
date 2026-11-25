import { loop } from '$lib/loop.ts';
import { researchAction } from '$lib/research.ts';
import type { RequestHandler } from './$types';

// Make a Delivery card, from the answer on a Research card's page.
export const POST: RequestHandler = ({ params, request }) => researchAction(loop(), params.key, request);
