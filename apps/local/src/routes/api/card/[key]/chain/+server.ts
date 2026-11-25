import { saveCardChain } from '$lib/chain-store.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request }) => saveCardChain(loop(), params.key, request);
