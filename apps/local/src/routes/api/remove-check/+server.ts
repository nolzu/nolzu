import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { removeConfirmNow } from '$lib/projects.ts';
import type { RequestHandler } from './$types';

// `GET ?repo=<folder>`: the Remove confirm of one repository with its checks run now, so the dialog
// does not show what the page found when it loaded. It reads and changes nothing.
export const GET: RequestHandler = async ({ url }) => json(await removeConfirmNow(database(), url.searchParams.get('repo') ?? ''));
