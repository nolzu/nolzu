import { database } from '$lib/db.ts';
import { rawLog } from '$lib/run-log.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => rawLog(database(), params.key, url.searchParams, request.signal);
