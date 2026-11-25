import { json } from '@sveltejs/kit';
import { loop } from '$lib/loop.ts';
import { learnGateOffer, postSetup } from '$lib/setup.ts';
import type { RequestHandler } from './$types';

// What the Learn dialog shows before a press: the repositories not learned yet and what each run starts on.
export const GET: RequestHandler = () => json(learnGateOffer(loop()));

// A step's mark, or Learn and then start, whose held move the loop makes through the same writer as a drag.
export const POST: RequestHandler = ({ request }) => postSetup(loop(), request);
