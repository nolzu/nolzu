import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, readRun, resolveDataDir, setCardRepos, writeSetting } from '@nolzu/core/node';
import { wallHere } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { createLoop, type Loop } from './loop.ts';
import { nowSnapshot } from './now-snapshot.ts';
import { browserEntry, qaHasBrowser, qaServers, readMcpList, writeMcpList } from './mcp-store.ts';
import { answerQa, chromeFound, qaSetupFor, scriptsHash, setUpBrowser, stackAnswered, startIn, turnOffBrowser } from './qa-setup.ts';
import { retry } from '../routes/api/board/writes.ts';

// The question at the first QA over a real loop on the fake engine: no QA before the answer, the saved
// answer after it, and what each answer loads.

let dir = '';
let project = '';
let live: Loop;

const CLEAN = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...CLEAN }, encoding: 'utf8' });

// A dev server in a few lines, which listens on PORT and says where, the way a recipe app's dev
// script would. It writes the folder it runs in, so a test sees which copy it served, and whether it
// could read the .env beside it, so a test sees the wall.
const SERVER = `import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
writeFileSync(process.env.APP_CWD_FILE, process.cwd());
let env = 'read';
try { readFileSync('.env'); } catch { env = 'hidden'; }
writeFileSync(process.env.APP_CWD_FILE + '.env', env);
createServer((request, response) => response.end('ok')).listen(port, () => console.log('Local: http://localhost:' + port + '/'));
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-qa-ask-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-qa-ask-project-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'recipes', scripts: { dev: 'node server.mjs', test: 'node --test' } }));
  writeFileSync(join(project, 'server.mjs'), SERVER);
  writeFileSync(join(project, '.env'), 'SECRET=1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', APP_CWD_FILE: join(dir, 'app-cwd.txt') });
  writeSetting(live.db, 'projectPath', project);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage = 'implement') =>
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'ready', ?)").run(key, stage, `${key} title`);

const card = (key: string) => live.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };
const qaRuns = (key: string) => live.db.prepare("SELECT id FROM runs WHERE card_key = ? AND phase = 'qa' ORDER BY id").all(key) as { id: number }[];
const addresses = (key: string) => join(project, '.tasks', key, 'qa', 'addresses.md');

// The QA run of a card, once it has ended.
async function ended(key: string): Promise<number> {
  let id = 0;
  await vi.waitFor(
    () => {
      id = qaRuns(key).at(-1)?.id ?? 0;
      expect(['complete', 'failed', 'stopped']).toContain(readRun(live.db, id)?.state);
    },
    { timeout: 20_000, interval: 20 },
  );
  return id;
}

const answers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

// What own commands write, in the order they ran.
const trail = () => join(dir, 'stack-trail.txt');

describe('a move into QA', () => {
  it('does not start QA before the answer, and starts it with the saved answer after', async () => {
    addCard('APP-2');

    const refused = await moveTo(live, 'APP-2', 'qa');

    expect(refused?.status).toBe(409);
    expect(refused?.message).toContain('QA asks how to run the app');
    expect(card('APP-2')).toEqual({ stage: 'implement', state: 'ready' });
    expect(qaRuns('APP-2')).toEqual([]);

    // Start QA: the answer for the project, then the move the board held back.
    expect(answerQa(live.db, { choice: 'dev', address: '', scripts: qaSetupFor(live.db).scripts })).toBeNull();
    expect(getSetting(live.db, 'qaApp')).toEqual({ '.': { mode: 'dev', command: 'npm run dev', repo: '.', scripts: scriptsHash(project) } });
    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    // The app came up in the card's copy on the port Nolzu handed it, QA got its address, and it went
    // down with the run.
    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(readFileSync(join(dir, 'app-cwd.txt'), 'utf8')).toBe(join(realpathSync(project), 'worktrees', 'APP-2'));
    // The start ran inside the wall, which hides the checkout's .env, wherever the wall can start.
    expect(readFileSync(join(dir, 'app-cwd.txt.env'), 'utf8')).toBe(wallHere().ready ? 'hidden' : 'read');
    const [line = ''] = readFileSync(addresses('APP-2'), 'utf8').trim().split('\n');
    expect(line).toMatch(/^app http:\/\/localhost:\d+\/$/);
    expect(await answers(Number(new URL(line.slice('app '.length)).port))).toBe(false);
    expect(readRun(live.db, runId)?.stackReason).toBe('The app Nolzu started for this run was stopped after it.');
  });

  // Implement can change what `npm run dev` runs on the card's branch. QA then starts nothing and asks
  // the question again, with the new script text, before the next start.
  it('asks again and starts nothing when the scripts changed on the card branch', async () => {
    addCard('APP-2');
    expect(answerQa(live.db, { key: 'APP-2', choice: 'dev', address: '', scripts: qaSetupFor(live.db, 'APP-2').scripts })).toBeNull();
    git('worktree', 'add', '-q', '-b', 'feature/APP-2', join(project, 'worktrees', 'APP-2'));
    const copy = join(project, 'worktrees', 'APP-2');
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'recipes', scripts: { dev: 'touch planted && node server.mjs', test: 'node --test' } }));

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    const said = "The package.json scripts on APP-2's branch are not the ones you said yes to, so Nolzu did not run npm run dev. Retry QA to see the new scripts and answer the question again.";
    expect(readRun(live.db, runId)).toMatchObject({ state: 'failed', stackReason: said });
    expect(existsSync(join(copy, 'planted'))).toBe(false);
    expect(existsSync(join(dir, 'app-cwd.txt'))).toBe(false);
    expect(getSetting(live.db, 'qaApp')).toBeNull();
    expect(qaSetupFor(live.db, 'APP-2').scripts).toBe('dev: touch planted && node server.mjs\ntest: node --test');
    // A retry is refused until the question is answered again, which the board asks before it.
    const refused = await retry(live, 'APP-2');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toBe('QA asks how to run the app before it runs again. Retry APP-2 on the board to answer.');
  });

  // The answer is about QA only. A run of any other phase loads and says nothing about a stack.
  it('leaves the runs of other phases alone once the question is answered', async () => {
    addCard('APP-3', 'plan');
    answerQa(live.db, { choice: 'code' });

    expect(await moveTo(live, 'APP-3', 'implement')).toBeNull();
    let run: { id: number; stack_reason: string | null } | undefined;
    await vi.waitFor(
      () => {
        run = live.db.prepare("SELECT id, stack_reason FROM runs WHERE card_key = 'APP-3' ORDER BY id DESC").get() as typeof run;
        expect(['complete', 'failed', 'stopped']).toContain(readRun(live.db, run?.id ?? 0)?.state);
      },
      { timeout: 20_000, interval: 20 },
    );

    expect(run?.stack_reason).toBeNull();
  });

  it('lets a second card go straight in with the saved answer', async () => {
    addCard('APP-1');
    addCard('APP-2');
    answerQa(live.db, { choice: 'code' });

    expect(await moveTo(live, 'APP-1', 'qa')).toBeNull();
    await ended('APP-1');
    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();

    expect(readRun(live.db, await ended('APP-2'))?.state).toBe('complete');
  });

  // The chain calls the same writer as "auto". No chain reaches QA today (it runs Plan to Implement), and
  // this is what keeps any later one from starting QA unasked.
  it('never starts QA on a move Nolzu makes by itself before the answer', async () => {
    addCard('APP-2');

    const refused = await moveTo(live, 'APP-2', 'qa', 'auto');

    expect(refused?.status).toBe(409);
    // The sentence names the card that was moved, not another.
    expect(refused?.message).toContain('Move APP-2 to QA');
    expect(card('APP-2')).toEqual({ stage: 'implement', state: 'ready' });
    expect(qaRuns('APP-2')).toEqual([]);
  });

  // Every open page asks off this key, so it is gone the moment the project has its answer.
  it('carries the question on the Now stream only until it is answered', () => {
    expect(nowSnapshot(live).qaSetup?.project).toBe(project.split('/').at(-1));

    answerQa(live.db, { choice: 'code' });

    expect(nowSnapshot(live).qaSetup).toBeNull();
  });

  // The project-wide stack hook moved to own commands under `*`, which answer every repository.
  it('asks nothing in a project with own commands for every repository', () => {
    expect(stackAnswered(live.db)).toBe(false);
    writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start: 'docker compose up -d', stop: null, status: null } });
    expect(stackAnswered(live.db)).toBe(true);
  });
});

describe('what each answer loads', () => {
  // The app is the person's, so QA checks it and Nolzu leaves it alone, and the
  // card's trail says Nolzu did not load the stack.
  it('starts no stack for an app already running, and says so on the card', async () => {
    addCard('APP-2');
    writeSetting(live.db, 'qaApp', { '.': { mode: 'running', address: 'localhost:5173' } });

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    expect(readFileSync(addresses('APP-2'), 'utf8')).toBe('app http://localhost:5173\n');
    const said = 'Nolzu started no app. QA checks the app already running at http://localhost:5173 and leaves it alone.';
    expect(readRun(live.db, runId)?.stackReason).toBe(said);
    expect(live.db.prepare('SELECT stack_state, stack_reason FROM cards WHERE key = ?').get('APP-2')).toEqual({ stack_state: 'off', stack_reason: said });
  });

  it('loads no stack and points QA at no address when it checks the code only', async () => {
    addCard('APP-1');
    writeSetting(live.db, 'qaApp', { '.': { mode: 'code' } });

    expect(await moveTo(live, 'APP-1', 'qa')).toBeNull();
    const runId = await ended('APP-1');

    expect(existsSync(addresses('APP-1'))).toBe(false);
    expect(readRun(live.db, runId)?.stackReason).toBe('Nolzu started no app. QA checks the code only.');
  });
});

// A workspace answers per repository, and QA starts the apps of the repositories the card changed, each
// in the card's own checkout.
describe('a workspace', () => {
  const repo = (name: string) => {
    const folder = join(project, name);
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, scripts: { dev: 'node server.mjs' } }));
    writeFileSync(join(folder, 'server.mjs'), SERVER);
    const inRepo = (...args: string[]) => execFileSync('git', args, { cwd: folder, env: { ...process.env, ...CLEAN } });
    inRepo('init', '-q', '-b', 'main');
    inRepo('add', '.');
    inRepo('commit', '-q', '-m', 'first');
  };

  beforeEach(() => {
    repo('api');
    repo('web');
    writeSetting(live.db, 'repos', [
      { path: 'api', base: null },
      { path: 'web', base: null },
    ]);
  });

  it('asks for the repository the card changed and starts only its app, in the card checkout', async () => {
    addCard('APP-2');
    setCardRepos(live.db, 'APP-2', ['web'], 'person');
    addCard('APP-3');
    setCardRepos(live.db, 'APP-3', ['api'], 'person');
    writeSetting(live.db, 'qaApp', { api: { mode: 'dev', command: 'npm run dev', repo: 'api', scripts: scriptsHash(join(project, 'api')) } });

    // api has its answer, web has none, so only the card that changed web asks.
    expect(stackAnswered(live.db, 'APP-3')).toBe(true);
    expect(stackAnswered(live.db, 'APP-2')).toBe(false);
    expect(nowSnapshot(live).qaAsks).toEqual(['APP-2']);
    expect((await moveTo(live, 'APP-2', 'qa'))?.status).toBe(409);

    const setup = qaSetupFor(live.db, 'APP-2');
    expect(setup).toMatchObject({ project: 'web', repo: 'web', dev: { command: 'npm run dev', repo: 'web' } });
    expect(answerQa(live.db, { key: 'APP-2', choice: 'dev', address: '', scripts: setup.scripts })).toBeNull();
    expect(Object.keys(getSetting(live.db, 'qaApp') ?? {}).sort()).toEqual(['api', 'web']);
    expect(nowSnapshot(live).qaSetup).toBeNull();

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    // One app, web's, never api's and never in the project's clone.
    expect(readFileSync(join(dir, 'app-cwd.txt'), 'utf8')).toBe(join(realpathSync(project), 'worktrees', 'APP-2', 'web'));
    // The address the app printed, or the one its port answered on first, whichever came first.
    expect(readFileSync(addresses('APP-2'), 'utf8')).toMatch(/^web http:\/\/localhost:\d+\/?\n$/);
  });

  // A repository's own answer wins over the answer for every repository.
  it("starts a repository's own start command over the answer for every repository", async () => {
    addCard('APP-2');
    setCardRepos(live.db, 'APP-2', ['web'], 'person');
    writeSetting(live.db, 'qaApp', { '*': { mode: 'code' }, web: { mode: 'dev', command: 'npm run dev', repo: 'web', scripts: scriptsHash(join(project, 'web')) } });

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(readFileSync(join(dir, 'app-cwd.txt'), 'utf8')).toBe(join(realpathSync(project), 'worktrees', 'APP-2', 'web'));
  });
});

// Your own commands run with no wall in the card's copy of each repository, and an answer under `*` runs
// once for the card in its checkout root, the way the project-wide stack hook ran.
describe('own commands', () => {
  const repo = (name: string) => {
    const folder = join(project, name);
    mkdirSync(folder);
    writeFileSync(join(folder, 'server.mjs'), SERVER);
    const inRepo = (...args: string[]) => execFileSync('git', args, { cwd: folder, env: { ...process.env, ...CLEAN } });
    inRepo('init', '-q', '-b', 'main');
    inRepo('add', '.');
    inRepo('commit', '-q', '-m', 'first');
  };
  const lines = () => readFileSync(trail(), 'utf8').trim().split('\n');

  it('starts each repository in order, runs the shared answer once in the root, and stops them after', async () => {
    for (const name of ['api', 'web', 'admin', 'docs']) repo(name);
    writeSetting(
      live.db,
      'repos',
      ['api', 'web', 'admin', 'docs'].map((path) => ({ path, base: null })),
    );
    writeSetting(live.db, 'qaApp', {
      // Exits once up, and names its address.
      api: { mode: 'own', start: `echo "api {key} $PWD" $NOLZU_REPOS >> ${trail()}; echo "api http://localhost:8787/recipes"`, stop: `echo stop-api >> ${trail()}`, status: null },
      // Keeps running, and answers on the PORT it was handed.
      web: { mode: 'own', start: 'node server.mjs', stop: `echo stop-web >> ${trail()}`, status: null },
      // Covers admin and docs, and runs once, in the root, with no Stop.
      '*': { mode: 'own', start: `echo "root $PWD" >> ${trail()}`, stop: null, status: null },
    });
    addCard('APP-4');
    setCardRepos(live.db, 'APP-4', ['api', 'web', 'admin', 'docs'], 'person');
    expect(stackAnswered(live.db, 'APP-4')).toBe(true);

    expect(await moveTo(live, 'APP-4', 'qa')).toBeNull();
    const runId = await ended('APP-4');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    const root = join(project, 'worktrees', 'APP-4');
    expect(lines()).toEqual([`root ${root}`, `api APP-4 ${join(root, 'api')} api web admin docs`, 'stop-api', 'stop-web']);
    expect(readFileSync(join(dir, 'app-cwd.txt'), 'utf8')).toBe(join(realpathSync(project), 'worktrees', 'APP-4', 'web'));
    const [api, web = ''] = readFileSync(addresses('APP-4'), 'utf8').trim().split('\n');
    expect(api).toBe('api http://localhost:8787/recipes');
    // Own commands that keep running are up on their PORT answering, never on an address they print.
    expect(web).toMatch(/^web http:\/\/localhost:\d+$/);
    expect(await answers(Number(new URL(web.slice('web '.length)).port))).toBe(false);
    // What the shared answer started has no Stop, so the card says it is still up.
    expect(readRun(live.db, runId)?.stackReason).toBe(`No Stop command is set, so what echo "root $PWD" >> ${trail()} started is still up.`);
    expect(live.db.prepare('SELECT stack_state FROM cards WHERE key = ?').get('APP-4')).toEqual({ stack_state: 'up' });
  });

  it('fails QA with the last line of a start that exits with another code', async () => {
    writeSetting(live.db, 'qaApp', { '.': { mode: 'own', start: 'echo "Cannot connect to the Docker daemon" >&2; exit 1', stop: null, status: null } });
    addCard('APP-2');

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    expect(readRun(live.db, runId)).toMatchObject({ state: 'failed', stackReason: expect.stringMatching(/exited 1 before the app answered\. Cannot connect to the Docker daemon$/) });
  });
});

// A repository whose own package.json names no start script, with the app one folder down, as a
// frontend folder beside a backend one.
describe('a start command one folder down', () => {
  const folderWith = (root: string, name: string, scripts: Record<string, string>) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({ scripts }));
  };

  it('proposes frontend, web, client and app first, then any folder by name, and skips node_modules and dot folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'nolzu-start-in-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      folderWith(root, 'node_modules', { dev: 'vite' });
      folderWith(root, '.hidden', { dev: 'vite' });
      expect(startIn(root)).toBeNull();
      folderWith(root, 'zeta', { start: 'node zeta.js' });
      folderWith(root, 'docs', { build: 'vitepress build' });
      expect(startIn(root)).toMatchObject({ sub: 'zeta', proposal: { command: 'npm run start' } });
      folderWith(root, 'beta', { serve: 'serve' });
      expect(startIn(root)?.sub).toBe('beta');
      for (const name of ['app', 'client', 'web', 'frontend']) {
        folderWith(root, name, { dev: 'vite' });
        expect(startIn(root)?.sub).toBe(name);
      }
      // The repository's own start script wins over every folder below it.
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }));
      expect(startIn(root)).toMatchObject({ sub: null, proposal: { command: 'npm run dev' } });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('installs, checks the scripts and starts the app in that folder of the card checkout', async () => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'recipes', scripts: { test: 'node --test' } }));
    mkdirSync(join(project, 'web'));
    writeFileSync(join(project, 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'node server.mjs --port 5175' } }));
    writeFileSync(join(project, 'web', 'server.mjs'), SERVER);
    writeFileSync(join(project, 'web', 'yarn.lock'), '# yarn lockfile v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'web');
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'yarn'), '#!/bin/sh\npwd -P > "$APP_CWD_FILE.install"; mkdir node_modules\n', { mode: 0o755 });
    live.close();
    live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', APP_CWD_FILE: join(dir, 'app-cwd.txt'), PATH: `${bin}:${process.env.PATH ?? ''}` });
    addCard('APP-2');

    const setup = qaSetupFor(live.db);
    expect(setup).toMatchObject({ dev: { command: 'npm run dev', repo: '.', folder: 'web' }, scripts: 'dev: node server.mjs --port 5175', address: 'localhost:5175' });
    expect(answerQa(live.db, { choice: 'dev', scripts: setup.scripts })).toBeNull();
    expect(getSetting(live.db, 'qaApp')).toEqual({ '.': { mode: 'dev', command: 'npm run dev', repo: '.', folder: 'web', scripts: scriptsHash(join(project, 'web')) } });

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    const web = join(realpathSync(project), 'worktrees', 'APP-2', 'web');
    expect(readFileSync(join(dir, 'app-cwd.txt.install'), 'utf8').trim()).toBe(web);
    expect(readFileSync(join(dir, 'app-cwd.txt'), 'utf8')).toBe(web);
  });
});

// A card's checkout is a fresh worktree with no node_modules, so a lock file there gets its install
// first, in the same wall as the start.
describe('the install before the start', () => {
  const bin = () => join(dir, 'bin');
  const fakeYarn = (script: string) => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(bin(), 'yarn'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    live.close();
    live = createLoop(dir, { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', APP_CWD_FILE: join(dir, 'app-cwd.txt'), PATH: `${bin()}:${process.env.PATH ?? ''}` });
  };

  beforeEach(() => {
    writeFileSync(join(project, 'yarn.lock'), '# yarn lockfile v1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'lock');
    writeSetting(live.db, 'qaApp', { '.': { mode: 'dev', command: 'npm run dev', repo: '.', scripts: scriptsHash(project) } });
  });

  it('installs from the lock file in the card checkout, then starts the app', async () => {
    fakeYarn(`echo "$*" > "$APP_CWD_FILE.install"; pwd -P >> "$APP_CWD_FILE.install"; echo "$YARN_CACHE_FOLDER" > "$APP_CWD_FILE.cache"; mkdir node_modules`);
    addCard('APP-2');

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    expect(readRun(live.db, runId)?.state).toBe('complete');
    const checkout = join(realpathSync(project), 'worktrees', 'APP-2');
    expect(readFileSync(join(dir, 'app-cwd.txt.install'), 'utf8')).toBe(`install --frozen-lockfile\n${checkout}\n`);
    expect(existsSync(join(checkout, 'node_modules'))).toBe(true);
    expect(readFileSync(join(dir, 'app-cwd.txt'), 'utf8')).toBe(checkout);
    // Inside the wall the home folder is read-only, so the cache goes to Nolzu's data folder.
    expect(readFileSync(join(dir, 'app-cwd.txt.cache'), 'utf8').trim()).toBe(wallHere().ready ? join(resolveDataDir(process.env), 'caches', 'yarn') : '');
  });

  it('stops with the folder, the command and its last line when the install fails', async () => {
    fakeYarn('echo "resolving packages"; echo "error boom" >&2; exit 1');
    addCard('APP-2');

    expect(await moveTo(live, 'APP-2', 'qa')).toBeNull();
    const runId = await ended('APP-2');

    const said = `yarn install --frozen-lockfile failed in ${join(project, 'worktrees', 'APP-2')}: error boom. Install it by hand in that folder, then move the card into QA again.`;
    expect(readRun(live.db, runId)).toMatchObject({ state: 'failed', stackReason: said });
    expect(existsSync(join(dir, 'app-cwd.txt'))).toBe(false);
  });
});

describe('the question', () => {
  it('reads the start command, the test command and no Playwright from the repository', () => {
    writeSetting(live.db, 'allowedCommands', ['npm install', 'npm test']);

    expect(qaSetupFor(live.db, null, false, { ready: true, binary: '/usr/bin/sandbox-exec' })).toEqual({
      project: project.split('/').at(-1),
      repo: null,
      dev: { command: 'npm run dev', repo: '.' },
      scripts: 'dev: node server.mjs\ntest: node --test',
      unwalled: null,
      address: '',
      test: 'npm test',
      playwright: false,
      chrome: false,
      browser: false,
    });
  });

  it('reads the port a start script names, and Playwright among the dev dependencies', () => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 5174' }, devDependencies: { '@playwright/test': '1.50.0' } }));

    expect(qaSetupFor(live.db)).toMatchObject({ address: 'localhost:5174', playwright: true });
  });

  // One app per repository: with no card, the question is about the project's first repository with no
  // answer, and reads that repository only.
  it('asks about the first repository with no answer among several', () => {
    mkdirSync(join(project, 'api'));
    mkdirSync(join(project, 'web'));
    writeFileSync(join(project, 'api', 'package.json'), JSON.stringify({ scripts: { dev: 'node api.js --port 4000' }, devDependencies: { playwright: '1.50.0' } }));
    writeFileSync(join(project, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 5174' } }));
    writeSetting(live.db, 'repos', [
      { path: 'api', base: null },
      { path: 'web', base: null },
    ]);

    expect(qaSetupFor(live.db)).toMatchObject({ project: 'api', repo: 'api', dev: { command: 'npm run dev', repo: 'api' }, address: 'localhost:4000', playwright: true });
    writeSetting(live.db, 'qaApp', { api: { mode: 'code' } });
    expect(qaSetupFor(live.db)).toMatchObject({ project: 'web', repo: 'web', dev: { command: 'npm run dev', repo: 'web' }, address: 'localhost:5174', playwright: false });
  });

  // A card can be the one that makes the app, so its package.json is on its branch only.
  it("reads a card's own copy when the project folder names no start command", () => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    addCard('APP-1');
    mkdirSync(join(project, 'worktrees', 'APP-1'), { recursive: true });
    writeFileSync(join(project, 'worktrees', 'APP-1', 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 5175' }, devDependencies: { playwright: '1.50.0' } }));

    expect(qaSetupFor(live.db)).toMatchObject({ dev: null, address: '', playwright: false });
    expect(qaSetupFor(live.db, 'APP-1')).toMatchObject({ dev: { command: 'npm run dev', repo: '.' }, address: 'localhost:5175', playwright: true });
    // Only a card on the board, so a posted key cannot point the read at another folder.
    mkdirSync(join(project, 'worktrees', 'APP-9'));
    writeFileSync(join(project, 'worktrees', 'APP-9', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(qaSetupFor(live.db, 'APP-9')).toMatchObject({ dev: null });
    expect(qaSetupFor(live.db, '../APP-1')).toMatchObject({ dev: null });
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('../worktrees/APP-1', 'delivery', 'implement', 'ready', 'odd')").run();
    expect(qaSetupFor(live.db, '../worktrees/APP-1')).toMatchObject({ dev: null });

    expect(answerQa(live.db, { choice: 'dev' })).toContain('nothing to start');
    // Start QA says yes to the scripts the dialog showed, so a block that changed since is refused.
    expect(answerQa(live.db, { key: 'APP-1', choice: 'dev' })).toBe('The package.json scripts changed since this question opened. Read the new ones and pick again.');
    expect(answerQa(live.db, { key: 'APP-1', choice: 'dev', scripts: 'dev: vite' })).toContain('scripts changed');
    expect(getSetting(live.db, 'qaApp')).toBeNull();
    expect(answerQa(live.db, { key: 'APP-1', choice: 'dev', scripts: 'dev: vite --port 5175' })).toBeNull();
    // The hash is of the card's copy, where the start command runs.
    expect(getSetting(live.db, 'qaApp')).toEqual({ '.': { mode: 'dev', command: 'npm run dev', repo: '.', scripts: scriptsHash(join(project, 'worktrees', 'APP-1')) } });
  });

  it("asks about the card's own repository, and reads its copy only when the project folder names no start command", () => {
    mkdirSync(join(project, 'api'));
    mkdirSync(join(project, 'web'));
    writeFileSync(join(project, 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 5174' } }));
    writeSetting(live.db, 'repos', [
      { path: 'api', base: null },
      { path: 'web', base: null },
    ]);
    addCard('APP-1');
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    mkdirSync(join(project, 'worktrees', 'APP-1', 'api'), { recursive: true });
    writeFileSync(join(project, 'worktrees', 'APP-1', 'api', 'package.json'), JSON.stringify({ scripts: { start: 'node api.js --port 4000' } }));

    // The card changed api only, so web's start command is not its question.
    expect(qaSetupFor(live.db, 'APP-1')).toMatchObject({ repo: 'api', dev: { command: 'npm run start', repo: 'api' }, address: 'localhost:4000' });
    writeFileSync(join(project, 'api', 'package.json'), JSON.stringify({ scripts: { dev: 'node api.js --port 4001' } }));
    expect(qaSetupFor(live.db, 'APP-1')).toMatchObject({ repo: 'api', dev: { command: 'npm run dev', repo: 'api' }, address: 'localhost:4001' });
  });

  it('keeps a browser the person set up before, and counts only the browser server as one', () => {
    writeMcpList(project, [{ ...browserEntry(), args: ['their-flag'] }]);
    expect(answerQa(live.db, { choice: 'code', browser: true }, true)).toBeNull();
    expect(readMcpList(project).servers).toEqual([{ ...browserEntry(), args: ['their-flag'] }]);

    // A database on for QA is no browser: the switch adds Nolzu's, and off leaves the database on.
    writeMcpList(project, [{ ...browserEntry(), name: 'db', phases: ['qa'] }]);
    expect(answerQa(live.db, { choice: 'code', browser: true }, true)).toBeNull();
    expect(qaServers(project)).toEqual(['db', 'playwright']);
    expect(answerQa(live.db, { choice: 'code', browser: false }, true)).toBeNull();
    expect(qaServers(project)).toEqual(['db']);
  });

  it('adds the browser to the MCP list for the switch only where Chrome or Playwright is found', () => {
    expect(answerQa(live.db, { choice: 'code', browser: true }, false)).toBeNull();
    expect(qaServers(project)).toEqual([]);

    expect(answerQa(live.db, { choice: 'code', browser: true }, true)).toBeNull();
    expect(readMcpList(project).servers).toEqual([browserEntry()]);
    // Off keeps the server in the list, turned off for QA.
    expect(answerQa(live.db, { choice: 'code', browser: false }, true)).toBeNull();
    expect(readMcpList(project).servers).toEqual([{ ...browserEntry(), phases: [] }]);

    writeFileSync(join(project, 'playwright.config.ts'), 'export default {};\n');
    expect(answerQa(live.db, { choice: 'code', browser: true }, false)).toBeNull();
    expect(qaServers(project)).toEqual(['playwright']);
  });

  it('saves your own commands, and refuses them with no Start', () => {
    expect(answerQa(live.db, { choice: 'own', start: '  ', stop: 'docker compose down' })).toBe('Type the command that starts the app in the Start box.');
    expect(getSetting(live.db, 'qaApp')).toBeNull();

    expect(answerQa(live.db, { choice: 'own', start: ' docker compose up -d ', stop: 'docker compose down', status: '' })).toBeNull();
    expect(getSetting(live.db, 'qaApp')).toEqual({ '.': { mode: 'own', start: 'docker compose up -d', stop: 'docker compose down', status: null } });
  });

  it('refuses an answer it cannot use, and saves nothing', () => {
    expect(answerQa(live.db, { choice: 'running', address: '' })).toBe('Type the address the app runs at, such as localhost:5173.');
    expect(answerQa(live.db, { choice: 'start' })).toContain('Pick how QA gets the app');
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(answerQa(live.db, { choice: 'dev' })).toContain('nothing to start');

    expect(getSetting(live.db, 'qaApp')).toBeNull();
  });
});

// The places Playwright's chrome channel looks, so the tests do not depend on this machine.
describe('Chrome detection', () => {
  const only = (path: string) => (asked: string) => asked === path;

  it('finds Chrome in the system or the home Applications folder on macOS', () => {
    expect(chromeFound('darwin', only('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/Users/dev')).toBe(true);
    expect(chromeFound('darwin', only('/Users/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/Users/dev')).toBe(true);
    expect(chromeFound('darwin', () => false, '/Users/dev')).toBe(false);
  });

  it('finds Chrome in /opt/google on Linux, and nowhere else', () => {
    expect(chromeFound('linux', only('/opt/google/chrome/chrome'))).toBe(true);
    expect(chromeFound('linux', only('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))).toBe(false);
    expect(chromeFound('win32', () => true)).toBe(false);
  });
});

// The QA browser row of Settings, Project. These were the browser field of the stack hook form.
describe('the QA browser row', () => {
  it("adds Nolzu's browser on for QA, and only turns QA on for one the person changed", () => {
    expect(setUpBrowser(project)).toBeNull();
    expect(readMcpList(project).servers).toEqual([browserEntry()]);

    writeMcpList(project, [{ ...browserEntry(), args: ['their-flag'], phases: ['plan'] }]);
    expect(setUpBrowser(project)).toBeNull();
    expect(readMcpList(project).servers).toEqual([{ ...browserEntry(), args: ['their-flag'], phases: ['plan', 'qa'] }]);

    expect(turnOffBrowser(live.db)).toBeNull();
    expect(qaServers(project)).toEqual([]);

    // Off works before the old QA browser path was moved into the list, too.
    writeSetting(live.db, 'qaMcpConfigPath', join(dir, 'their-mcp.json'));
    expect(qaHasBrowser(live.db)).toBe(true);
    expect(turnOffBrowser(live.db)).toBeNull();
    expect(getSetting(live.db, 'qaMcpConfigPath')).toBeNull();
    expect(qaHasBrowser(live.db)).toBe(false);
  });
});
