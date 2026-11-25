import { fail, redirect } from '@sveltejs/kit';
import { estimateShort } from '@nolzu/protocol';
import { ghRunner, githubOwners } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import { ghLogin, projectInProgress, startFromIdea } from '$lib/new-project.ts';
import type { Actions, PageServerLoad } from './$types';

// Start from an idea: a new project whose one repository is a new private repository on GitHub, and
// whose first card is the idea, on the Epics board.
export const load: PageServerLoad = () => {
  const gh = ghLogin();
  const refine = loop()
    .snapshot('epics')
    .stages.find((stage) => stage.id === 'refine')?.starts?.estimate;
  return {
    made: projectInProgress(database()),
    // Not awaited: the page draws at once. The owners are read once gh is signed in, and null says it
    // is not, so the page waits for `gh auth login`.
    gh,
    owners: gh.then((login) => (login.signedIn ? githubOwners(ghRunner()).catch((error: Error) => ({ problem: error.message })) : null)),
    // What the drag to Refine will cost, or null when nothing measured it.
    refine: refine === undefined ? null : estimateShort(refine),
  };
};

const field = (form: FormData, name: string): string => form.get(name)?.toString() ?? '';

export const actions: Actions = {
  // The answer waits for the push and the clone, so the board opens on a project with its repository.
  create: async ({ request }) => {
    const form = await request.formData();
    const started = await startFromIdea(database(), {
      idea: field(form, 'idea'),
      decided: field(form, 'decided'),
      name: field(form, 'name'),
      folder: field(form, 'folder'),
      owner: field(form, 'owner'),
      repo: field(form, 'repo'),
    });
    // The card may be there even when the clone failed, and no run starts to tell the open boards.
    loop().changed();
    // A refusal after the workspace was made leaves the project waiting on New project, and a failed
    // action does not load the page again, so the answer says so for the link.
    if ('problem' in started) return fail(400, { message: started.problem, waiting: projectInProgress(database()) !== null });
    redirect(303, '/b/epics');
  },
};
