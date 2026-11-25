import { writeChain } from '$lib/chain-store.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// Now's chain suggestion: turn the chain on or off for a board, or Not now.
export const POST: RequestHandler = ({ request }) => writeChain(loop(), request);
