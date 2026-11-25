import { bumpVersion, markNotificationsRead, notifications } from '@nolzu/core/node';
import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// The bell's panel: the kept list of the current project, newest first.
export const GET: RequestHandler = () => json(notifications(database()));

// Opening the panel reads every item. The count rides on the Now stream, so every open tab drops it.
export const POST: RequestHandler = () => {
  const db = database();
  if (markNotificationsRead(db)) {
    bumpVersion(db);
    loop().changed();
  }
  return json({ ok: true });
};
