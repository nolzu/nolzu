import { error, redirect } from '@sveltejs/kit';
import { registeredProjects, writeSetting } from '@nolzu/core/node';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import type { RequestHandler } from './$types';

// The selector's pick: the project becomes the current one, which every route works on from then, and
// its Now opens. A plain form post, so the whole page loads again and the Now stream follows the new
// project. Every plan may pick any project.
export const POST: RequestHandler = async ({ request }) => {
  const id = Number((await request.formData()).get('project'));
  const db = database();
  if (!registeredProjects(db).some((one) => one.id === id)) error(400, 'There is no such project on this machine.');
  // Opened before it becomes current, so a project that cannot open is refused here and never left
  // as the one the next start opens.
  try {
    loop(process.env, id);
  } catch (refused) {
    error(409, `That project could not open, so the open one stays: ${refused instanceof Error ? refused.message : String(refused)}`);
  }
  // The streams of a tab still open on the old project hear it, and their page loads again on the new
  // one, so no stale tab keeps showing the old project as the current one.
  const before = loop();
  writeSetting(db, 'currentProject', id);
  before.changed();
  redirect(303, '/');
};
