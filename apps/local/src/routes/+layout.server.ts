import { homedir } from 'node:os';
import { redirect } from '@sveltejs/kit';
import { DEFAULTS } from '@nolzu/core';
import { getSetting, projectProfiles } from '@nolzu/core/node';
import { projectName } from '$lib/app-header.ts';
import { firstRun } from '$lib/coach.ts';
import { database } from '$lib/db.ts';
import { currentDisplay, heldDisplay, localCloud } from '$lib/display-sync.ts';
import { offlineBanner } from '$lib/cloud-status.ts';
import { dialHubAgain, hubStatus } from '$lib/hub-link.ts';
import { onboardRedirect, projectFilesNotice } from '$lib/onboard.ts';
import { listedRepos } from '$lib/projects.ts';
import { homePath, railUsage, repoNames } from '$lib/rail.ts';
import { projectChoices } from '$lib/selector.ts';
import { ACCEPT_PATH } from '$lib/terms.ts';
import { workspaceNote } from '$lib/to-workspace.ts';
import { workspaceCount } from '$lib/workspace.ts';
import type { LayoutServerLoad } from './$types';

// What the layout hands the terms page: the shape of every other load, with nothing read.
const HELD = {
  project: null,
  prefix: DEFAULTS.localKeyPrefix,
  tickets: DEFAULTS.ticketSystem,
  offBoards: DEFAULTS.offBoards,
  pullsReadAt: null,
  cloud: '',
  projectPath: null,
  repos: [],
  listed: false,
  projects: [],
  usage: null,
  offline: null,
  workspaceNote: null,
  firstRun: null,
  projectFiles: null,
  workspaceChanged: null,
} as const;

// The prefix is here because the Add card dialog reads a typed key the way the server will.
export const load: LayoutServerLoad = async ({ url }) => {
  // The terms page draws no rail, and before the accept nothing may ask git, the cloud or the hub.
  if (url.pathname === ACCEPT_PATH) return { ...HELD, display: heldDisplay() };
  // A first run goes to New project; every later load, and a machine with a project, stays. Before
  // the document, so a machine with no project asks the server nothing.
  const first = onboardRedirect(database(), url.pathname);
  if (first !== null) redirect(307, first);
  const cloud = localCloud();
  // What the menus may show, and where the cloud is, so one place decides both and every screen under
  // this layout reads the same document.
  const display = await currentDisplay(cloud);
  // A plan bought in the browser reaches this machine here. Not awaited, and it awaits nothing itself,
  // so no page load waits for a dial.
  dialHubAgain(display);
  const project = projectName(database());
  const path = getSetting(database(), 'projectPath');
  return {
    project,
    prefix: getSetting(database(), 'localKeyPrefix'),
    // Local or Jira, so Add card says a key is read from Jira. Never the site, the email or the token.
    tickets: getSetting(database(), 'ticketSystem'),
    // Read on every load, so a board turned on or off on /projects leaves or joins the rail at once.
    offBoards: getSetting(database(), 'offBoards'),
    // When Read pull requests last finished, for the PR reviews header. A read calls invalidateAll.
    pullsReadAt: getSetting(database(), 'pullsReadAt'),
    display,
    cloud: cloud.baseUrl,
    // What the rail's project selector shows, from settings alone. Projects asks git for the rest,
    // which is too slow for every page.
    projectPath: path === null ? null : homePath(path, homedir()),
    repos: project === null ? [] : repoNames(listedRepos(database()), project),
    listed: getSetting(database(), 'repos') !== null,
    // Every project the selector lists, with its counts.
    projects: projectChoices(),
    // The usage window the engine last reported, for the rail foot. On every load, as the rail is.
    usage: railUsage(projectProfiles(database()), getSetting(database(), 'engineLimits')),
    // The offline banner of a paid machine whose link to its hub is down. Null on Free.
    offline: offlineBanner(hubStatus(), display),
    // The coach note Now draws for a project of one repository, until Got it or the move.
    workspaceNote: workspaceNote(database()),
    // Getting started and the start-at-login offer for the rail's first paint. The Now stream carries
    // the same, live, once it answers.
    firstRun: firstRun(database()),
    // What a write of the project files would update. Worked out once per project and after each write,
    // since the shipped files change only with a new Nolzu.
    projectFiles: projectFilesNotice(database()),
    // The Workspace rail entry's changed-file count from the last read, or null before one. Never runs
    // git here: the first load starts a read and does not wait for it.
    workspaceChanged: workspaceCount(database()),
  };
};
