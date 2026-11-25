import { json } from '@sveltejs/kit';
import { ghRunner } from '@nolzu/runner';
import { READ_TIMEOUT_MS } from '$lib/create-card.ts';
import { database } from '$lib/db.ts';
import { cardPulls } from '$lib/pull-list.ts';
import type { RequestHandler } from './$types';

// The pull request state of a closed card. The page asks after it has drawn, so a slow or missing gh
// never holds the page load.
export const GET: RequestHandler = async ({ params }) => json(await cardPulls(database(), params.key, ghRunner(), AbortSignal.timeout(READ_TIMEOUT_MS)));
