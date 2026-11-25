import { hostname } from 'node:os';
import { error, fail, redirect } from '@sveltejs/kit';
import { getSetting } from '@nolzu/core/node';
import { enginesOnPath, findExecutable, hubUrl, keepAwakeCommand, loginShellPath, machineName, wallHere } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { checkProfileLogin, engineTools, profilesFor, saveProfile, wallLine } from '$lib/engine-profiles.ts';
import { loop } from '$lib/loop.ts';
import { hubLastSent, hubStatus, redialHub, resumeSync } from '$lib/hub-link.ts';
import { modelsFor, saveProjectModels } from '$lib/project-models.ts';
import { agentsFor, knowledgeFor, postAgents, postKnowledge } from '$lib/settings-page.ts';
import { movedTo, sectionOf } from '$lib/settings-sections.ts';
import { loginSwitch } from '$lib/start-at-login.ts';
import type { Actions, PageServerLoad } from './$types';

// Only the open section is read. Each one is its own page, so the Runs page no longer waits on the
// engine check or asks the hub, and a name that is no section is a page that is not there. An old
// section's link goes on to where that section went. Project is never read here: its own route wins.
// A hub override that is not an address shows as typed, so a typo in it cannot fail the whole page.
const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

export const load: PageServerLoad = ({ params }) => {
  const moved = movedTo(params.section);
  if (moved !== null) redirect(308, moved);
  const section = sectionOf(params.section);
  if (section === null) error(404, `There is no ${params.section} section in Settings. The sections are listed at /settings.`);
  const on = (id: string) => section.id === id;
  return {
    section: section.id,
    agents: on('runs') ? agentsFor(database()) : null,
    // Whether a run here can hold the machine awake, so the row names the systems that can only where
    // this one cannot. It looks for the tool on PATH and starts nothing.
    awake: on('runs') ? keepAwakeCommand(process.platform, (name) => findExecutable(name, process.env.PATH ?? '') !== null, process.pid) !== null : null,
    // Off the disk, never the database, so the switch shows whether the item is there. A press
    // posts to /api/login-item, the one writer the rail's offer uses too.
    login: on('runs') ? loginSwitch() : null,
    // The one Knowledge switch sits at the foot of Runs.
    knowledge: on('runs') ? knowledgeFor(database()) : null,
    // Asked on every load, so a reload shows a model the engine stopped offering as gone. The engines
    // on PATH are the ones the menu counts, so the engine and preset table lists the same ones.
    models: on('models') ? modelsFor(database(), loop().models(), undefined, enginesOnPath(loginShellPath(process.env))) : null,
    // Not awaited: the page shows at once and the tool rows when the look answers. No login is asked
    // here: Check login is the `login` action, on a click.
    engines: on('engines') ? engineTools() : null,
    profiles: on('engines') ? profilesFor(database()) : null,
    // The wall named once for the section, from the probe the runs read. Null where it cannot start.
    wall: on('engines') ? wallLine(wallHere(), process.platform) : null,
    // Read on every load and never polled. The dial runs in this process, so the screen shows what the
    // connection was doing when the page was built and a reload asks again.
    hub: on('cloud') ? hubStatus() : null,
    // Sync paused after Delete my cloud data, which the row says and offers to turn back on.
    paused: on('cloud') ? getSetting(database(), 'syncPaused') : null,
    // What the Solo panel names beside the state: the hub it dials, the name this machine signs in
    // under (the one `nolzu login` sends), and when a frame last went out. Read once, like the state.
    link: on('cloud') ? { host: hostOf(hubUrl(process.env)), machine: machineName(hostname()), lastSent: hubLastSent() } : null,
    // Whether this project joined a team, so the team list says nothing goes there when it has not.
    team: on('cloud') ? getSetting(database(), 'teamProjectId') !== null : null,
  };
};

// Every answer names its section, so the screen prints the saved line under the section the person
// wrote in. Read off the action that did the work, so no list of field names can drift from it.
export const actions: Actions = {
  // One field at a time, so a refused value never takes the rest of the section down with it.
  runs: async ({ request }) => {
    const answer = postAgents(database(), await request.formData());
    // The board reads the quiet time off its snapshot, so an open board gets the new one now and not
    // at its next change.
    if (answer.ok && answer.field === 'quiet') loop().changed();
    // The scheduler took the slot count when it started, so it is told the new one. The store took
    // the number as typed, so the typed value is the stored one.
    if (answer.ok && answer.field === 'slots') loop().scheduler.resize(Number(answer.typed));
    return answer.ok
      ? { section: 'runs', field: answer.field, saved: true }
      : fail(400, { section: 'runs', field: answer.field, typed: answer.typed, message: answer.message });
  },
  // The switch at the foot of Runs. It keeps its own action, so its saved line prints under it.
  knowledge: async ({ request }) => {
    const answer = postKnowledge(database(), await request.formData());
    return answer.ok
      ? { section: 'knowledge', field: answer.field, saved: true }
      : fail(400, { section: 'knowledge', field: answer.field, typed: answer.typed, message: answer.message });
  },
  models: async ({ request }) => {
    const form = await request.formData();
    const answer = saveProjectModels(database(), form, loop().models());
    // The name form has its own refusal line beside its button, so a refused name is not printed
    // under the table where the person cannot see it.
    const named = form.get('save') !== null;
    const renamed = form.get('rename') !== null;
    if (!answer.ok) return fail(400, { section: 'models', field: named ? 'named' : renamed ? 'renamed' : 'models', message: answer.message });
    // The board column names what each drop starts off its snapshot, so an open board hears of every
    // save here and not at its next change.
    loop().changed();
    // Saving, renaming and removing a named preset change no row, so the screen does not say that
    // cards use it on their next run.
    const field = named ? 'named' : renamed ? 'renamed' : form.get('replace') !== null ? 'replaced' : form.get('remove') === null ? 'models' : 'removed';
    return { section: 'models', field, saved: true };
  },
  // The field is the word the person asked for, because each of add, rename and remove leaves the
  // screen saying something else.
  profiles: async ({ request }) => {
    const answer = saveProfile(database(), await request.formData());
    // A profile that goes or comes changes what a board column starts on.
    if (answer.ok) loop().changed();
    return answer.ok
      ? { section: 'engines', field: answer.did, id: answer.id, saved: true }
      : fail(400, { section: 'engines', field: answer.did, message: answer.message });
  },
  // Check login on one profile row. The answer goes to that row and is stored nowhere.
  login: async ({ request }) => {
    const answer = await checkProfileLogin(database(), await request.formData());
    return answer.ok ? { section: 'engines', field: 'login', check: answer.check } : fail(400, { section: 'engines', field: 'login', message: answer.message });
  },
  // Connect again on Cloud. The one caller of `redialHub`: a load never dials, so the press does.
  redial: async () => ({ section: 'cloud', field: 'redial', dialled: await redialHub() }),
  // Turn sync back on after Delete my cloud data. The one caller of `resumeSync`.
  resume: async () => {
    await resumeSync(database());
    return { section: 'cloud', field: 'resume', saved: true };
  },
};
