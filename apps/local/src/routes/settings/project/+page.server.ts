import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail } from '@sveltejs/kit';
import { getSetting, resolveDataDir, writeSetting } from '@nolzu/core/node';
import { createKeychain, runKeychain, writeMcpConfig } from '@nolzu/runner';
import { crossSiteRead } from '$lib/bin.ts';
import { addRepository, cloneMissing, stoppable } from '$lib/add-repo.ts';
import { testBrowser } from '$lib/browser-test.ts';
import { removeClosedCheckouts } from '$lib/checkouts.ts';
import { database } from '$lib/db.ts';
import { startLearnPost } from '$lib/knowledge-learn.ts';
import { loop } from '$lib/loop.ts';
import { machineRepos } from '$lib/new-project.ts';
import { projectName } from '$lib/app-header.ts';
import { applySetup, fillAllowedCommands, proposedCommands, handEditedFiles, keepMine, projectFilesNotice, setupSaid, takeShipped } from '$lib/onboard.ts';
import { addCommands, foundToAdd, projectBranches, projectRow, repoTable, rescanRepos, revealProject, saveProjectField } from '$lib/projects.ts';
import { appKeychain, BROWSER_NAME, commitMcpList, migrateQaBrowser, qaHasBrowser, runMcp } from '$lib/mcp-store.ts';
import { answerQa, clearAnswer, PLAYWRIGHT_FILE, setUpBrowser, turnOffBrowser } from '$lib/qa-setup.ts';
import { removeRepository } from '$lib/remove-repo.ts';
import { markSetup } from '$lib/setup.ts';
import { billingFor, saveBilling } from '$lib/timesheet.ts';
import { checkKeyClash, switchTickets } from '$lib/ticket-system.ts';
import { makeThisAWorkspace } from '$lib/to-workspace.ts';
import type { Actions, PageServerLoad } from './$types';

const keychain = () => createKeychain(process.platform, runKeychain, resolveDataDir(process.env));

// A machine with no project never reaches this load: `+layout.server.ts` runs `onboardRedirect` on
// every load and sends it to New project first. A machine set up before the list of allowed commands
// existed gets its first list here, where the person sees it.
export const load: PageServerLoad = async ({ request }) => {
  const allowed = fillAllowedCommands(database());
  const live = loop();
  const project = await projectRow(database());
  // The QA browser of the old setting moves into the list here too, so a refusal shows on the row.
  // Not for another site's request, which would write the list and commit it unseen.
  project.browser.problem = crossSiteRead(request.headers.get('sec-fetch-site')) ? null : await migrateQaBrowser(live.db, live.project, appKeychain(), join(live.dataDir, PLAYWRIGHT_FILE)).catch((error: Error) => error.message);
  project.browser.on = qaHasBrowser(live.db);
  // Not awaited: the status is read before its first await, so the notice below is fresh, and the
  // patches git makes stream in after the page drew.
  const handEdits = handEditedFiles(database());
  // Not awaited: a git call per repository, which kept a project of many repositories blank. The page
  // draws at once, with grey rows where the table lands.
  const table = repoTable(database());
  return {
    project,
    table,
    // Not awaited: one git call per repository. The base branch boxes wait on it, not the page.
    branches: projectBranches(database()),
    // Not awaited: the scan of the home folder runs git in every repository it finds, and the page
    // draws without it. A project of one repository has no table to add to.
    found: project.repos === null ? [] : Promise.all([table, machineRepos()])
          .then(([rows, found]) => foundToAdd({ path: project.path, table: rows }, found))
          .catch(() => []),
    billing: billingFor(database()),
    // The project files changed by hand, each with its diff, under Write the project files.
    handEdits,
    // The status the read above refreshed. The layout's load runs beside this one and may still read
    // the old one, so this page's status lines take it from here.
    projectFiles: projectFilesNotice(database()),
    // Propose again: what the repositories propose now that the list does not hold yet.
    proposal: proposedCommands(database()).filter((command) => !allowed.includes(command)),
  };
};

const COMMAND_FIELDS = new Set(['addCommand', 'removeCommand', 'allowedCommands']);
const confirmCommands = (): void => {
  markSetup(database(), 'commands', 'done');
  loop().changed();
};

export const actions: Actions = {
  // One field at a time, the way the settings sections post, so a refused prefix leaves the branch
  // name alone and the box still shows what was typed.
  save: async ({ request }) => {
    const form = await request.formData();
    const field = form.get('field')?.toString() ?? '';
    const typed = form.get('value')?.toString() ?? '';
    const message = await saveProjectField(database(), field, typed);
    // A change to the command list confirms it, which is that step of Set up the project.
    if (message === null && COMMAND_FIELDS.has(field)) confirmCommands();
    // Now's snapshot holds the boards that are on, and the open pages read every board out of it, so
    // they get a board turned on or off now and not at the next change.
    if (message === null && field.startsWith('board:')) loop().changed();
    // A new prefix on a project that reads Jira: Jira is asked whether a project of its has that key.
    if (message === null && field === 'localKeyPrefix') await checkKeyClash(database(), keychain());
    return message === null ? { field, saved: true } : fail(400, { field, typed, message });
  },
  // The commands ticked under Propose again, all in one post.
  addCommands: async ({ request }) => {
    const picked = (await request.formData()).getAll('command').map(String);
    const message = addCommands(database(), picked);
    if (message === null) confirmCommands();
    return message === null ? { field: 'addCommands', saved: true } : fail(400, { field: 'addCommands', message });
  },
  // "The list is right": the step of Set up the project, with the list as it is.
  confirmCommands: () => {
    confirmCommands();
    return { field: 'confirmCommands', saved: true };
  },
  // Edit on a row of Start the app: one repository's answer, or `*`'s, by the rules of the question at
  // the first QA, so a start command is only ever one the repository proposes.
  qaRepo: async ({ request }) => {
    const form = await request.formData();
    const value = (name: string) => form.get(name)?.toString() ?? '';
    const repo = value('repo');
    const live = loop();
    const message = answerQa(live.db, { repo, choice: value('choice'), address: value('address'), scripts: value('scripts'), start: value('start'), stop: value('stop'), status: value('status') });
    if (message !== null) return fail(400, { field: `app:${repo}`, message });
    live.changed();
    return { field: `app:${repo}`, saved: true };
  },
  // Ask again on one row of Start the app: that repository's answer goes, and its next card in QA asks.
  qaClear: async ({ request }) => {
    const repo = (await request.formData()).get('repo')?.toString() ?? '';
    const message = clearAnswer(database(), repo);
    if (message !== null) return fail(400, { field: `app:${repo}`, message });
    loop().changed();
    return { field: `app:${repo}`, saved: true };
  },
  // QA's browser. Each write goes on the Now stream, because the question at the first QA reads it.
  browserSetup: async () => {
    const project = getSetting(database(), 'projectPath');
    const message = setUpBrowser(project) ?? (await commitMcpList(project));
    if (message !== null) return fail(400, { field: 'browser', message });
    loop().changed();
    return { field: 'browser', saved: true };
  },
  // The servers stay in the list, turned off for QA, so turning the browser on again keeps them.
  browserOff: async () => {
    const message = turnOffBrowser(database()) ?? (await commitMcpList(getSetting(database(), 'projectPath')));
    if (message !== null) return fail(400, { field: 'browser', message });
    loop().changed();
    return { field: 'browser', saved: true };
  },
  // Starts the first server QA gets and a browser, so only on the press. Its config holds the
  // secrets, so it lives in a folder of its own that goes right after.
  browserTest: async () => {
    const live = loop();
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-browser-test-'));
    try {
      const legacy = getSetting(live.db, 'qaMcpConfigPath');
      const mcp = await runMcp({ project: getSetting(live.db, 'projectPath'), projectId: live.project, phase: 'qa', vendor: 'claude-code', keychain: appKeychain(), dir, cursorHere: true, legacy });
      // The browser by its name, or the old setting's first server while it is not moved yet.
      const name = mcp.mcp?.stdio[BROWSER_NAME] !== undefined ? BROWSER_NAME : legacy !== null ? Object.keys(mcp.mcp?.stdio ?? {})[0] : undefined;
      const server = name === undefined ? undefined : mcp.mcp?.stdio[name];
      if (name === undefined || server === undefined) return fail(400, { field: 'browser', message: mcp.notes[0] ?? 'QA has no browser to test. Set one up first.' });
      // Its config holds no secret Nolzu's browser needs, and it goes with the folder right after.
      const config = join(dir, 'mcp.json');
      writeMcpConfig(config, { [name]: server }, {});
      const tested = await testBrowser(config);
      return tested.passed ? { field: 'browser', said: tested.said } : fail(400, { field: 'browser', message: tested.said });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  // Local tickets or Jira, both ways. Jira needs the machine's login first, from Settings, Integrations,
  // and a switch to it asks Jira about the key prefix.
  tickets: async ({ request }) => {
    const message = switchTickets(database(), (await request.formData()).get('value')?.toString() ?? '');
    if (message !== null) return fail(400, { field: 'tickets', message });
    await checkKeyClash(database(), keychain());
    return { field: 'tickets', saved: true };
  },
  // Ask again for every repository: every answer under Start the app is taken back, and the next card
  // that enters QA asks it again.
  qa: () => {
    writeSetting(database(), 'qaApp', null);
    loop().changed();
    return { field: 'qa', saved: true };
  },
  // A row of the repository table. The field names the row, so the sentence prints under it. The
  // typed name goes to the server's check, so a post without the form deletes nothing.
  remove: async ({ request }) => {
    const form = await request.formData();
    const repo = form.get('repo')?.toString() ?? '';
    const removed = await removeRepository(database(), repo, form.get('typed')?.toString() ?? '');
    return 'problem' in removed ? fail(400, { field: `remove:${repo}`, message: removed.problem }) : { field: `remove:${repo}`, said: removed.said };
  },
  // The client, the rate and the currency, saved together the way Evidence saves them. A refusal sends
  // back what was typed, so the boxes still show it.
  bill: async ({ request }) => {
    const form = await request.formData();
    const typed = { client: form.get('client')?.toString() ?? '', rate: form.get('rate')?.toString() ?? '', currency: form.get('currency')?.toString() ?? '' };
    const refused = saveBilling(database(), typed);
    return refused === null ? { field: 'bill', saved: true } : fail(400, { field: 'bill', message: refused.message, bill: typed });
  },
  // A clone by URL. The URL is not sent back, so a token pasted into it is not drawn again.
  add: async ({ request }) => {
    const added = await addRepository(database(), (await request.formData()).get('url')?.toString() ?? '', process.env, stoppable());
    // The answer offers Learn this project for the new repository, with one click.
    return 'problem' in added ? fail(400, { field: 'add', message: added.problem }) : { field: 'add', said: added.said, learn: added.added ?? null };
  },
  // Learn this project, from the answer of Add. It never starts by itself, and what it writes waits on Knowledge.
  learn: async ({ request }) => {
    const learned = startLearnPost(loop(), await request.formData());
    return learned.ok ? { field: 'learn', said: learned.message } : fail(400, { field: 'learn', message: learned.message });
  },
  // What the manifest names and the disk has not got, as a teammate who cloned the workspace finds it.
  // A row's Clone names its folder, and a post with none clones every missing one.
  clone: async ({ request }) => {
    const folder = (await request.formData()).get('folder')?.toString();
    const cloned = await cloneMissing(database(), process.env, stoppable(), folder === '' ? undefined : folder);
    return 'problem' in cloned ? fail(400, { field: 'clone', message: cloned.problem }) : { field: 'clone', said: cloned.said };
  },
  // The project folder in the file manager. The location is read only, so this is
  // the way to it.
  reveal: () => {
    const problem = revealProject(database());
    return problem === null ? { field: 'reveal', said: 'Opened the project folder.' } : fail(400, { field: 'reveal', message: problem });
  },
  // A folder a person cloned by hand joins the list here, so it is always a folder the scan found.
  rescan: async () => {
    const scanned = await rescanRepos(database());
    return 'problem' in scanned ? fail(400, { field: 'rescan', message: scanned.problem }) : { field: 'rescan', said: scanned.said };
  },
  // A project of one repository becomes a workspace, and its repository moves into it.
  convert: async ({ request }) => {
    const form = await request.formData();
    const made = await makeThisAWorkspace(database(), { parent: form.get('parent')?.toString() ?? '', name: form.get('name')?.toString() ?? '' });
    return 'problem' in made ? fail(400, { field: 'convert', message: made.problem }) : { field: 'convert', said: made.said };
  },
  // The run guard, the agent rules and the skills, as the first card of a new project writes them, for
  // a project made before them or one whose files went. A file the person changed is kept. The notice
  // in the app posts here too, and reads the counts.
  files: async () => {
    const report = await applySetup(database());
    if (report.failed !== null) return fail(400, { field: 'files', message: report.failed.message });
    const updated = report.written.length + report.removed.length + (report.skills ?? []).reduce((sum, one) => sum + one.copied.length + one.removed.length, 0);
    const handEdited = projectFilesNotice(database())?.yours.length ?? 0;
    const move = report.knowledgeMove;
    return { field: 'files', said: setupSaid(report), updated, handEdited, moved: move?.refused ?? move?.said ?? null, project: projectName(database()) };
  },
  // One file changed by hand, from its row under Project files. A file git does not hold the person's
  // text of is refused with the ask, and the ask's button posts again with `sure`.
  take: async ({ request }) => {
    const form = await request.formData();
    const path = form.get('path')?.toString() ?? '';
    const taken = await takeShipped(database(), path, form.get('sure')?.toString() === '1');
    return 'problem' in taken ? fail(400, { field: `take:${path}`, message: taken.problem, ask: taken.ask === true }) : { field: 'files', said: taken.said };
  },
  keep: async ({ request }) => {
    const path = (await request.formData()).get('path')?.toString() ?? '';
    const kept = keepMine(database(), path);
    return 'problem' in kept ? fail(400, { field: `take:${path}`, message: kept.problem }) : { field: 'files', said: kept.said };
  },
  // Every closed card, one at a time. A checkout stays when git cannot show it is safe to lose. The
  // sentence names it and why.
  checkouts: async () => ({ field: 'checkouts', said: await removeClosedCheckouts(database()) }),
};
