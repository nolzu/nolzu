import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { cardRepos, createLocalTicket, moveCard, openDatabase, readRun, resolveDataDir, writeSetting } from '@nolzu/core/node';
import { type CardState, isFakeMode, type Job } from '@nolzu/protocol';
import { checkoutRoot, GUARD_PATH } from '@nolzu/runner';
import { changeGroups } from '../src/lib/changes.ts';
import { removeCardCheckouts } from '../src/lib/checkouts.ts';
import { createLoop, type Loop } from '../src/lib/loop.ts';
import { MANIFEST } from '../src/lib/manifest.ts';
import { listedRepos } from '../src/lib/projects.ts';
import { removeRepository } from '../src/lib/remove-repo.ts';
import { demoWorkspace } from './demo-workspace.ts';
import { splitWorkspace } from './split-workspace.ts';

// The whole path a card takes, through the real loop, the queue and the scheduler, on the fake engine,
// in a throwaway copy of the demo workspace. The script is the check: it exits 1 on any mismatch.

if (!isFakeMode(process.env)) {
  console.error('The smoke run works only with the fake engine. Run NOLZU_FAKE_AGENT=1 pnpm smoke.');
  process.exit(1);
}

const repository = realpathSync(join(import.meta.dirname, '..', '..', '..'));
const demo = join(repository, 'examples', 'recipe-workspace');

// In fake mode the data directory lives in the home directory, so a temp home starts it empty.
const home = mkdtempSync(join(tmpdir(), 'nolzu-smoke-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const dataDir = resolveDataDir(process.env);
if (!dataDir.startsWith(home + sep)) {
  rmSync(home, { recursive: true, force: true });
  console.error(`The data directory ${dataDir} is outside the temp home ${home}. The smoke run stopped before opening it.`);
  process.exit(1);
}

const failures: string[] = [];
const check = (what: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// The demo copy as a person's project: one commit, no remote, and no git config of this machine.
const project = join(home, 'recipes');
cpSync(demo, project, { recursive: true });
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com',
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: gitEnv, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'demo');

// One slot, so the second card has to wait for the first, and the order can be seen. Written before the
// loop opens, because the loop reads the slot count once, when it is built.
const seed = openDatabase(dataDir);
writeSetting(seed, 'agentSlots', 1);
writeSetting(seed, 'projectPath', project);
seed.close();

let live: Loop | null = null;
try {
  live = createLoop(dataDir, { ...gitEnv, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: process.env.NOLZU_FAKE_DELAY_SCALE ?? '0' });
  const loop = live;
  const firstVersion = loop.snapshot().version;

  // Which card the engine started, in order, while the fake engine replays as before.
  const started: string[] = [];
  const replay = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    started.push(`${job.cardKey} ${job.phase}`);
    return replay(job, signal);
  };

  const card = (key: string) => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: CardState };
  const newestRun = (key: string) => (loop.db.prepare('SELECT max(id) AS id FROM runs WHERE card_key = ?').get(key) as { id: number }).id;
  const settled = async (key: string) => {
    for (let tries = 0; tries < 500; tries += 1) {
      if (!['queued', 'running'].includes(card(key).state)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${key} did not settle.`);
  };
  const move = (key: string, to: string) => moveCard(loop.db, loop.boardOf(key), key, to, (at, phase) => {
    loop.start(at, phase);
  });

  const first = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Add a search box to the recipe list', description: 'Filter the list by title.' }).key;
  const second = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Show the cooking time', description: 'Show minutes on each recipe.' }).key;
  console.log(`cards ${first} and ${second}, project ${project}`);

  // Both into refine at once. The second waits for the only slot.
  await move(first, 'refine');
  await move(second, 'refine');
  const waiting = loop.snapshot().cards.find((found) => found.key === second);
  check(`${second} waits in the queue while ${first} runs`, waiting?.state === 'queued' && waiting.queuePosition === 1);
  await settled(first);
  await settled(second);
  check(`${second} ran after ${first}`, started.slice(0, 2).join(', ') === `${first} refine, ${second} refine`);

  // The first card on through plan into implement.
  for (const to of ['plan', 'implement']) {
    await move(first, to);
    await settled(first);
  }
  check(`${first} is ready in implement`, JSON.stringify(card(first)) === JSON.stringify({ stage: 'implement', state: 'ready' }));

  const runs = loop.db.prepare('SELECT * FROM runs WHERE card_key = ? ORDER BY id').all(first) as Record<string, unknown>[];
  check(`${first} has three runs, refine, plan and implement`, runs.map((run) => run.phase).join(' ') === 'refine plan implement');
  for (const run of runs) {
    const counts = ['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_creation'].every((column) => typeof run[column] === 'number');
    const logged = typeof run.log_path === 'string' && existsSync(run.log_path);
    const complete = typeof run.session_id === 'string' && counts && typeof run.cost_estimate === 'number' && logged;
    check(`the ${String(run.phase)} run of ${first} carries a session, four token counts, a cost and a log on disk`, complete);
    check(`the ${String(run.phase)} run of ${first} ends with its plain summary`, typeof run.plain_summary === 'string' && run.plain_summary.trim() !== '');
  }
  check(`${first} got its own checkout in the project`, existsSync(join(project, 'worktrees', first, '.git')));

  // A stop. The second card goes into plan and is stopped while its engine waits, and a stopped card
  // moves again.
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    started.push(`${job.cardKey} ${job.phase}`);
    return (async function* () {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield* [];
    })();
  };
  await move(second, 'plan');
  for (let tries = 0; tries < 500 && card(second).state === 'queued'; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  loop.stop(newestRun(second));
  await settled(second);
  check(`the stopped run of ${second} is saved as stopped`, readRun(loop.db, newestRun(second))?.state === 'stopped');
  let movedBack = true;
  try {
    await move(second, 'refine');
  } catch {
    movedBack = false;
  }
  check(`${second} moves again after the stop`, movedBack && card(second).stage === 'refine');

  check('the board version rose', loop.snapshot().version > firstVersion);
  check('the demo copy has one commit and no remote', git('rev-list', '--count', 'main') === '1' && git('remote') === '');
} finally {
  live?.close();
  rmSync(home, { recursive: true, force: true });
}

check('the temp copy is gone', !existsSync(home));

// The second pass: one card on a project of two repositories, the layout `demo-setup.ts --split
// --root-repo` makes. The root is a repository too, so the card's tree looks like the project and the
// Changes tab has three groups. It runs in a temp home of its own, so the first pass stays as it was.
const splitHome = mkdtempSync(join(tmpdir(), 'nolzu-smoke-'));
process.env.HOME = splitHome;
process.env.USERPROFILE = splitHome;
const splitData = resolveDataDir(process.env);
if (!splitData.startsWith(splitHome + sep)) {
  rmSync(splitHome, { recursive: true, force: true });
  console.error(`The data directory ${splitData} is outside the temp home ${splitHome}. The smoke run stopped before opening it.`);
  process.exit(1);
}
const splitEnv = { ...gitEnv, HOME: splitHome, USERPROFILE: splitHome };
const split = join(splitHome, 'recipes');
cpSync(demo, split, { recursive: true });
const repos = splitWorkspace(split, { rootRepo: true, env: splitEnv });
// Refine and plan start in the project folder here, and refuse to without a guard file. The fake
// engine runs no hook, so any content does.
mkdirSync(join(split, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(split, GUARD_PATH), '// The run guard onboarding writes. The fake engine runs no hook.\n');
const splitSeed = openDatabase(splitData);
writeSetting(splitSeed, 'projectPath', split);
writeSetting(splitSeed, 'repos', repos);
splitSeed.close();

let splitLive: Loop | null = null;
try {
  splitLive = createLoop(splitData, { ...splitEnv, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: process.env.NOLZU_FAKE_DELAY_SCALE ?? '0' });
  const loop = splitLive;
  const key = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Show the cooking time on the page', description: 'The api sends minutes and the page shows them.' }).key;
  console.log(`card ${key}, project ${split} with ${repos.map((repo) => repo.path).join(', ')}`);
  const state = () => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: CardState };
  const step = async (to: string) => {
    await moveCard(loop.db, loop.boardOf(key), key, to, (at, phase) => {
      loop.start(at, phase);
    });
    for (let tries = 0; tries < 500 && ['queued', 'running'].includes(state().state); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  const root = checkoutRoot(split, key);
  await step('refine');
  await step('plan');
  check(`refine and plan on ${key} made no checkout`, state().state === 'ready' && !existsSync(root));
  check(`plan set the list of ${key} to the root, api and web`, JSON.stringify(cardRepos(loop.db, key)) === JSON.stringify({ repos: ['.', 'api', 'web'], by: 'plan' }));

  await step('implement');
  check(`${key} is ready in implement`, JSON.stringify(state()) === JSON.stringify({ stage: 'implement', state: 'ready' }));
  const checkouts = [root, join(root, 'api'), join(root, 'web')];
  const branches = checkouts.map((at) => (existsSync(join(at, '.git')) ? execFileSync('git', ['branch', '--show-current'], { cwd: at, env: splitEnv, encoding: 'utf8' }).trim() : ''));
  check(`${key} has a checkout of the root, api and web on one branch`, branches[0] !== '' && branches.every((branch) => branch === branches[0]));
  const groups = await changeGroups(loop.db, key, splitEnv);
  check(`the Changes loader gives ${key} one group per repository`, JSON.stringify(groups.map((group) => [group.repo, group.changes.ok])) === JSON.stringify([['.', true], ['api', true], ['web', true]]));
} finally {
  splitLive?.close();
  rmSync(splitHome, { recursive: true, force: true });
}
check('the second temp copy is gone', !existsSync(splitHome));

// The third pass: a workspace, the layout `demo-setup.ts --workspace` makes. Nolzu makes the folder,
// api and web are added by URL, one card runs, and then its checkouts and one repository go again.
const spaceHome = mkdtempSync(join(tmpdir(), 'nolzu-smoke-'));
process.env.HOME = spaceHome;
process.env.USERPROFILE = spaceHome;
const spaceData = resolveDataDir(process.env);
if (!spaceData.startsWith(spaceHome + sep)) {
  rmSync(spaceHome, { recursive: true, force: true });
  console.error(`The data directory ${spaceData} is outside the temp home ${spaceHome}. The smoke run stopped before opening it.`);
  process.exit(1);
}
const spaceEnv = { ...gitEnv, HOME: spaceHome, USERPROFILE: spaceHome };
const space = join(spaceHome, 'recipes');
let spaceLive: Loop | null = null;
try {
  const spaceSeed = openDatabase(spaceData);
  try {
    const made = await demoWorkspace(spaceSeed, space, join(spaceHome, 'demo'), spaceEnv);
    check('the workspace is made and api and web are added', made.said.length === 2);
  } finally {
    spaceSeed.close();
  }
  const inSpace = (...args: string[]) => execFileSync('git', args, { cwd: space, env: spaceEnv, encoding: 'utf8' }).trim();

  spaceLive = createLoop(spaceData, { ...spaceEnv, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: process.env.NOLZU_FAKE_DELAY_SCALE ?? '0' });
  const loop = spaceLive;
  // A card that never moves comes first, so the card that runs is not APP-1, and a step that reads the
  // wrong card fails here.
  createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Left in the backlog', description: 'Nothing runs on this card.' });
  const key = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Show the cooking time on the page', description: 'The api sends minutes and the page shows them.' }).key;
  console.log(`card ${key}, workspace ${space} with ${listedRepos(loop.db).map((repo) => repo.path).join(', ')}`);
  const state = () => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: CardState };
  const step = async (to: string) => {
    await moveCard(loop.db, loop.boardOf(key), key, to, (at, phase) => {
      loop.start(at, phase);
    });
    for (let tries = 0; tries < 500 && ['queued', 'running'].includes(state().state); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  const root = checkoutRoot(space, key);
  await step('refine');
  await step('plan');
  check(`refine and plan on ${key} made no checkout`, state().state === 'ready' && !existsSync(root));
  check(`plan set the list of ${key} to api and web, never the workspace`, JSON.stringify(cardRepos(loop.db, key)) === JSON.stringify({ repos: ['api', 'web'], by: 'plan' }));

  await step('implement');
  check(`${key} is ready in implement`, JSON.stringify(state()) === JSON.stringify({ stage: 'implement', state: 'ready' }));
  const branches = ['api', 'web'].map((repo) => join(root, repo)).map((at) => (existsSync(join(at, '.git')) ? execFileSync('git', ['branch', '--show-current'], { cwd: at, env: spaceEnv, encoding: 'utf8' }).trim() : ''));
  check(`${key} has a checkout of api and web on one branch, in a plain folder`, !existsSync(join(root, '.git')) && branches[0] !== '' && branches[0] === branches[1]);
  const groups = await changeGroups(loop.db, key, spaceEnv);
  check(`the Changes loader gives ${key} a group for api and one for web`, JSON.stringify(groups.map((group) => [group.repo, group.changes.ok])) === JSON.stringify([['api', true], ['web', true]]));

  const held = await removeRepository(loop.db, 'web', 'web', spaceEnv);
  // The card's own checkout is the reason, not some other guard that happens to stop the removal too.
  check(`web stays while ${key} has a checkout of it`, 'problem' in held && held.problem.startsWith(`${key} has a checkout of web`) && existsSync(join(space, 'web')));

  // Nothing on the board jumps from implement to closed, so the card is closed the way a person's
  // finished card ends up.
  loop.db.prepare("UPDATE cards SET stage = 'closed', state = 'idle' WHERE key = ?").run(key);
  const cleaned = await removeCardCheckouts(loop.db, key, spaceEnv);
  check(`the checkouts of the closed ${key} are removed, and its folder with them`, cleaned.ok && cleaned.removed.join(' ') === 'api web' && cleaned.kept.length === 0 && cleaned.folder === null && !existsSync(root));

  const removed = await removeRepository(loop.db, 'web', 'web', spaceEnv);
  check('web is removed once no card has a checkout of it', 'said' in removed && !existsSync(join(space, 'web')));
  check('the list holds api only', JSON.stringify(listedRepos(loop.db).map((repo) => repo.path)) === JSON.stringify(['api']));
  const manifest = JSON.parse(readFileSync(join(space, MANIFEST), 'utf8')) as { repositories: { folder: string }[] };
  check('the manifest and the .gitignore no longer name web', manifest.repositories.map((repo) => repo.folder).join(' ') === 'api' && !readFileSync(join(space, '.gitignore'), 'utf8').includes('/web/'));
  check('the knowledge file of web stays', existsSync(join(space, '.nolzu', 'knowledge', 'web', 'repository.md')));
  check('the workspace has nothing left to commit', inSpace('status', '--porcelain') === '');
} finally {
  spaceLive?.close();
  rmSync(spaceHome, { recursive: true, force: true });
}
check('the third temp copy is gone', !existsSync(spaceHome));
const touched = execFileSync('git', ['status', '--porcelain', 'examples/'], { cwd: repository, encoding: 'utf8' }).trim();
check('the demo workspace in the repository is untouched', touched === '');

if (failures.length === 0) {
  console.log('Smoke run passed.');
} else {
  console.error(`Smoke run failed: ${failures.length} check${failures.length === 1 ? '' : 's'}.`);
  process.exitCode = 1;
}
