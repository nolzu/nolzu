import { fail, redirect } from '@sveltejs/kit';
import { getSetting } from '@nolzu/core/node';
import { database } from '$lib/db.ts';
import { endFirstRun, firstTask, makeFirstCard, projectInProgress } from '$lib/new-project.ts';
import { revealProject, saveProjectField } from '$lib/projects.ts';
import { setupFor } from '$lib/setup.ts';
import type { Actions, PageServerLoad } from './$types';

// The first task, step 2 of 2 of a new project. Only a project New project made with a repository and
// no card yet has one: with no project the person goes to New project, with a finished one to its board.
export const load: PageServerLoad = () => {
  const task = firstTask(database());
  if (task === null) redirect(307, getSetting(database(), 'projectPath') === null || projectInProgress(database()) !== null ? '/new' : '/b/delivery');
  // Set up the project, as a list in place of the old "Also learn this project" tick.
  return { ...task, setup: setupFor(database()) };
};

export const actions: Actions = {
  // Make card, Ask about the project and "Plan a bigger feature". Each makes one card and starts
  // nothing on it; the board it went on opens next. The task is sent back on a refusal, so nothing typed is lost.
  card: async ({ request }) => {
    const form = await request.formData();
    const task = form.get('task')?.toString() ?? '';
    const made = await makeFirstCard(database(), { task, board: form.get('board')?.toString() ?? 'delivery' });
    if (!('key' in made)) return fail(400, { message: made.problem, task });
    redirect(303, `/b/${made.board}`);
  },
  // The card key prefix in the banner, saved and refused as Settings, Project saves it.
  key: async ({ request }) => {
    const typed = (await request.formData()).get('value')?.toString() ?? '';
    const message = await saveProjectField(database(), 'localKeyPrefix', typed);
    return message === null ? { field: 'key', saved: true } : fail(400, { field: 'key', typed, message });
  },
  // Open the folder, the same as on Settings, Project.
  reveal: () => {
    const problem = revealProject(database());
    return problem === null ? { field: 'reveal', said: 'Opened the project folder.' } : fail(400, { field: 'reveal', message: problem });
  },
  // Skip ends the first run with no card, so the board opens and stays open.
  skip: () => {
    endFirstRun(database());
    redirect(303, '/b/delivery');
  },
};
