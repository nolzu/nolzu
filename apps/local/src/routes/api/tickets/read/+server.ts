import { getTicket } from '$lib/create-card.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// Link on an epic's task row: ?ref= a key or a link of the project's ticket system. Reads, writes nothing.
export const GET: RequestHandler = ({ url }) => getTicket(loop().db, url.searchParams.get('ref') ?? '');
