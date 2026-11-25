import { parseRunLine } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { logResponse } from '$lib/run-log.ts';
import type { RequestHandler } from './$types';

// The parser of the engine the run itself ran on, named on its row. The file holds that engine's
// lines, whatever the action table names today.
export const GET: RequestHandler = ({ params, url, request }) =>
  logResponse(database(), parseRunLine, params.key, url.searchParams.get('run') ?? '', request.signal, { raw: false });
