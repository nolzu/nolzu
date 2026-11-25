import { resolveDataDir } from '@nolzu/core/node';
import { createKeychain, runKeychain } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { postJira } from '$lib/ticket-system.ts';
import type { RequestHandler } from './$types';

// Connect Jira from Add card. The token goes to this data folder's keychain entry, and the answer
// carries a sentence or nothing.
export const POST: RequestHandler = ({ request }) => postJira(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), request);
