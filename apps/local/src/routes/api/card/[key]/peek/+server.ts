import { json } from '@sveltejs/kit';
import { parseRunLine } from '@nolzu/runner';
import { crossSiteRead } from '$lib/bin.ts';
import { markStep } from '$lib/coach.ts';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import { peekFor } from '$lib/peek.ts';
import type { RequestHandler } from './$types';

// What the peek sheet shows of one card. Read fresh on each ask, so it carries no cache.
export const GET: RequestHandler = async ({ params, request }) => {
  const view = await peekFor(database(), params.key, parseRunLine);
  if (view === null) return new Response(`The board has no card ${params.key}.`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  // The sheet shows a finished run's plain summary, which is Getting started's "Read what changed" too.
  // Not for another site's request, which could tick the step for a sheet nobody opened.
  if (view.summary !== null && !view.summary.live && !crossSiteRead(request.headers.get('sec-fetch-site')) && markStep(database(), 'summary')) loop().changed();
  return json(view, { headers: { 'cache-control': 'no-store' } });
};
