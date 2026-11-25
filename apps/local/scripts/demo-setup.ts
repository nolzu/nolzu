import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLocalTicket, openDatabase, resolveDataDir, writeSetting } from '@nolzu/core/node';
import { isFakeMode } from '@nolzu/protocol';
import { demoUrl, demoWorkspace } from './demo-workspace.ts';
import { SPLIT_REPOS, splitWorkspace } from './split-workspace.ts';
import { TERMS_VERSION } from '../src/lib/terms.ts';

// Sets up a demo: a copy of the demo workspace as a git project, set as the project in a fresh data
// folder, with APP-1 to APP-3 in Inbox.
//
//   NOLZU_FAKE_AGENT=1 HOME=<empty folder> node apps/local/scripts/demo-setup.ts <folder>   fake engine
//   NOLZU_DATA_DIR=<empty folder> node apps/local/scripts/demo-setup.ts <folder>            real engine
//
// With --split the services become two repositories, api/ and web/, in a plain folder. With
// --split --root-repo the folder is a repository too. With --workspace the folder is a new workspace,
// and api and web are added to it by URL, the way a person adds a repository. See
// docs/stack-hook/README.md.

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { split: { type: 'boolean' }, 'root-repo': { type: 'boolean' }, workspace: { type: 'boolean' } } });
} catch {
  console.error('The only flags are --split, --root-repo and --workspace: node apps/local/scripts/demo-setup.ts [--split [--root-repo] | --workspace] <folder>');
  process.exit(1);
}
const { values: flags, positionals } = parsed;
const target = positionals[0];
if (target === undefined) {
  console.error('Name the folder the demo project goes into: node apps/local/scripts/demo-setup.ts [--split [--root-repo] | --workspace] <folder>');
  process.exit(1);
}
if (flags['root-repo'] === true && flags.split !== true) {
  console.error('--root-repo works only with --split. Without --split the folder is one repository already.');
  process.exit(1);
}
if (flags.workspace === true && flags.split === true) {
  console.error('--workspace and --split make two different layouts. Pick one.');
  process.exit(1);
}
const project = resolve(target);
if (existsSync(project)) {
  console.error(`${project} is already there. Name a folder that does not exist yet, so nothing is written over.`);
  process.exit(1);
}
// The person's own data folder holds their real cards. The demo gets a fresh one or the fake engine's.
if (!isFakeMode(process.env) && process.env.NOLZU_DATA_DIR === undefined) {
  console.error('Set NOLZU_DATA_DIR to an empty folder, so the demo cards do not go into your own data folder.');
  process.exit(1);
}

const db = openDatabase(resolveDataDir(process.env));
// The person who runs this has read the terms, and a demo starts on the board, not on the terms page.
writeSetting(db, 'termsAccepted', { version: TERMS_VERSION, at: new Date().toISOString() });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const addTickets = (folder: string) => {
  for (const number of [1, 2, 3]) {
    const [heading = '', , ...body] = readFileSync(join(folder, `APP-${number}.md`), 'utf8').split('\n');
    const title = heading.replace(/^# APP-\d+: /, '');
    const { key } = createLocalTicket(db, { projectId: 1, prefix: 'APP', title, description: body.join('\n').trim() });
    console.log(`${key}  ${title}`);
  }
};

if (flags.workspace === true) {
  // The bare repositories the clones come from are only needed until the clones exist, so they live in
  // a temp folder, and each origin then points at a placeholder, as the split layout's do.
  mkdirSync(dirname(project), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'nolzu-demo-'));
  let failed = false;
  try {
    const made = await demoWorkspace(db, project, scratch, process.env);
    for (const line of made.said) console.log(line);
    for (const repo of SPLIT_REPOS) git(join(project, repo), 'remote', 'set-url', 'origin', demoUrl(repo));
    addTickets(join(made.source, 'tickets'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`${project} may be half made. Delete it and the data folder before you run this again.`);
    failed = true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
} else {
  const demo = join(import.meta.dirname, '..', '..', '..', 'examples', 'recipe-workspace');
  cpSync(demo, project, { recursive: true });
  const split = flags.split === true ? splitWorkspace(project, { rootRepo: flags['root-repo'] === true }) : null;
  // One commit on main and no remote, as a person's small project would start.
  if (split === null) {
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'Recipe workspace');
  }
  // A placeholder GitHub remote, so the Changes tab can show the prefilled pull request page. Nothing is
  // ever pushed to it: the demo stops before the push. A split project gets one per repository.
  if (split === null || flags['root-repo'] === true) git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');
  for (const repo of split === null ? [] : SPLIT_REPOS) git(join(project, repo), 'remote', 'add', 'origin', `https://github.com/example/recipe-${repo}.git`);

  writeSetting(db, 'projectPath', project);
  // What a scan of the folder would save, so the board knows the repositories.
  if (split !== null) writeSetting(db, 'repos', split);
  addTickets(join(project, 'tickets'));
}
db.close();
console.log(`The project is ${project}. Start the app with the same environment and open the board.`);
if (flags.split === true || flags.workspace === true) {
  // Own commands run in the card's checkout, where no copy of the script is, so it is named by its full path.
  const script = join(import.meta.dirname, '..', '..', '..', 'docs', 'stack-hook', 'stack.sh');
  // A new workspace has its run guard already: making it wrote the project files and committed them.
  if (flags.split === true) console.log('Refine and plan need the run guard. Press Write the project files in Project settings.');
  console.log(`For the example app, open Start the app in Project settings, Edit the row Every repository, pick your own commands and set Start to: sh '${script}' load {key}, and the same with unload for Stop and status for Status.`);
}
