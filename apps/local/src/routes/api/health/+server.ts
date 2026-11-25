import { json } from '@sveltejs/kit';
import { resolveDataDir } from '@nolzu/core/node';
import type { RequestHandler } from './$types';

// What a second `nolzu` asks before it opens this server: the data folder it serves. A server for
// another folder, or another program on the port, must never be opened as if it were this one.
export const GET: RequestHandler = () => json({ dataDir: resolveDataDir(process.env) }, { headers: { 'cache-control': 'no-store' } });
