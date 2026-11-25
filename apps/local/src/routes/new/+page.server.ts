import { join } from 'node:path';
import { fail, redirect } from '@sveltejs/kit';
import { everyPhaseEngines } from '@nolzu/core';
import { getSetting, registeredProjects } from '@nolzu/core/node';
import { isFakeMode } from '@nolzu/protocol';
import { ENGINE_INSTALLS, enginesOnPath, loginShellPath, wallHere } from '@nolzu/runner';
import { stopClone } from '$lib/add-repo.ts';
import { database } from '$lib/db.ts';
import { addToNewProject, finishNewProject, ghLogin, machineRepos, projectInProgress, putOnGitHub } from '$lib/new-project.ts';
import { engineCheck } from '$lib/onboard.ts';
import { remoteBranches, REPO_BASE, saveProjectField } from '$lib/projects.ts';
import { removeRepository } from '$lib/remove-repo.ts';
import type { Actions, PageServerLoad } from './$types';

// New project: the first run, and on a paid plan every later project. The clones themselves reach the
// page on `/api/clones`, and Browse reads `/api/folders`.
export const load: PageServerLoad = async () => {
  const inProgress = projectInProgress(database());
  const path = getSetting(database(), 'projectPath');
  // Each row's base branch select offers what origin had at the clone, read from its refs with no
  // network call.
  const made =
    inProgress === null || path === null
      ? null
      : { ...inProgress, repos: await Promise.all(inProgress.repos.map(async (repo) => ({ ...repo, branches: await remoteBranches(join(path, repo.name)) }))) };
  // Onboarding asks for one engine that runs every phase on this machine: any of
  // the three where the wall starts, Claude Code or Codex where it cannot.
  const wall = wallHere();
  const everyPhase = { engines: everyPhaseEngines(wall), wallProblem: wall.ready ? null : wall.reason };
  const found = enginesOnPath(loginShellPath(process.env));
  return {
    made,
    // The machine's only project, before its folder is made or while it is being made. A later project
    // has a project beside it, so the title says New project.
    first: registeredProjects(database()).length === 1 && (made !== null || getSetting(database(), 'projectPath') === null),
    // Not awaited: the page draws at once and fills each part when git or the tool answers.
    machine: machineRepos(),
    engines: engineCheck(),
    gh: ghLogin(),
    // With no such engine on the PATH the page asks for one first, and looks again on `/api/tools`. The
    // fake engine runs every card in fake mode, so it counts as one there.
    tools: isFakeMode(process.env) || found.some((engine) => everyPhase.engines.includes(engine)) ? null : ENGINE_INSTALLS,
    everyPhase,
    found,
  };
};

const field = (form: FormData, name: string): string => form.get(name)?.toString() ?? '';

export const actions: Actions = {
  // A URL typed, or the remote of a repository found on this machine. The URL is not sent back, so a
  // token pasted into it is not drawn again.
  add: async ({ request }) => {
    const form = await request.formData();
    const typed = { name: field(form, 'name'), folder: field(form, 'folder') };
    const added = await addToNewProject(database(), { ...typed, url: field(form, 'url') });
    return 'problem' in added ? fail(400, { message: added.problem, ...typed }) : { cloning: added.job.name };
  },
  // Put on GitHub: a repository of this machine with no remote goes to a new private repository of the
  // gh account, from a copy, and then clones like any other. The answer waits for the push.
  github: async ({ request }) => {
    const form = await request.formData();
    const typed = { name: field(form, 'name'), folder: field(form, 'folder') };
    const put = await putOnGitHub(database(), { ...typed, path: field(form, 'path') });
    return 'problem' in put ? fail(400, { message: put.problem, ...typed }) : { cloning: put.job.name };
  },
  stop: async ({ request }) => (stopClone(field(await request.formData(), 'id')) ? { stopped: true } : fail(404, { message: 'That clone has ended already.' })),
  // Only a repository of the project being made: Nolzu cloned it a moment ago, so the typed name the
  // Projects page asks for is left out. removeRepository still refuses a clone with work in it.
  remove: async ({ request }) => {
    const repo = field(await request.formData(), 'repo');
    if (projectInProgress(database())?.repos.some((one) => one.name === repo) !== true) return fail(400, { message: `${repo} is not a repository of the project being made.` });
    const removed = await removeRepository(database(), repo, repo);
    return 'problem' in removed ? fail(400, { message: removed.problem }) : { removed: removed.said };
  },
  // A repository's base, picked from origin's branches. One only origin has gets its local tracking
  // branch, the way Settings, Project saves it.
  base: async ({ request }) => {
    const form = await request.formData();
    const repo = field(form, 'repo');
    if (projectInProgress(database())?.repos.some((one) => one.name === repo) !== true) return fail(400, { message: `${repo} is not a repository of the project being made.` });
    const refused = await saveProjectField(database(), `${REPO_BASE}${repo}`, field(form, 'base'));
    return refused === null ? { based: repo } : fail(400, { message: refused });
  },
  // Step 1 of 2 is done, so the first task opens. The first card ends the first run. A base picked in
  // a row and not saved comes as a `base:<repo>` field and is saved first, so the pick is not lost.
  make: async ({ request }) => {
    const form = await request.formData();
    const repos = projectInProgress(database())?.repos ?? [];
    for (const [name, value] of form) {
      const repo = name.startsWith('base:') ? name.slice('base:'.length) : null;
      if (repo === null || !repos.some((one) => one.name === repo)) continue;
      const said = await saveProjectField(database(), `${REPO_BASE}${repo}`, value.toString());
      if (said !== null) return fail(400, { message: said });
    }
    const refused = finishNewProject(database());
    if (refused !== null) return fail(400, { message: refused });
    redirect(303, '/new/task');
  },
};
