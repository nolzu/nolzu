import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardRepos, readRun, setCardRepos, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE, type Job, NEEDS_INPUT_PREFIX } from '@nolzu/protocol';
import { fakeEngine, GUARD_PATH, runLogNote } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

let dir = '';
let project = '';
let live: Loop;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (at: string, ...args: string[]) => execFileSync('git', args, { cwd: at, env: GIT_ENV, encoding: 'utf8' });

// A repository with one commit on the named branch.
const repoAt = (at: string, branch: string): void => {
  mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', branch);
  writeFileSync(join(at, 'README.md'), 'recipes\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', 'first');
};

let seen: { cwd: string; phase: string }[] = [];
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-start-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  writeSetting(live.db, 'projectPath', project);
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes. The fake engine runs no hook.\n');
  seen = [];
  live.engine.spawn = async function* (job: Job) {
    if (job.phase === 'extract-summary') return;
    seen.push({ cwd: job.cwd, phase: job.phase });
    yield RESULT;
  };
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'queued', 'Add a search box')").run();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A root repository that ignores its child repository api, which branches from develop.
const rootWithApi = (apiBase: string | null = 'develop'): void => {
  repoAt(project, 'main');
  writeFileSync(join(project, '.gitignore'), 'api/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'ignore api');
  repoAt(join(project, 'api'), 'develop');
  writeSetting(live.db, 'repos', [{ path: '.', base: null }, { path: 'api', base: apiBase }]);
};

// With a session, the run is a message in that phase's thread, which resumes the session.
async function runToEnd(phase: 'refine' | 'plan' | 'implement', sessionId?: string): Promise<{ state: string | undefined; reason: string | null | undefined }> {
  if (sessionId === undefined) {
    live.db.prepare("UPDATE cards SET state = 'queued' WHERE key = 'APP-1'").run();
    live.start('APP-1', phase);
  } else {
    live.discuss('APP-1', { id: phase, sessionId, engine: null }, 'Look at the api too.');
  }
  const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  for (let tries = 0; tries < 3000; tries += 1) {
    const run = readRun(live.db, runId);
    // Out of the queue too: the summary pass and its git compare still hold the slot.
    if ((run?.state === 'complete' || run?.state === 'failed' || run?.state === 'stopped') && !live.scheduler.queue().running.some((job) => job.runId === runId)) return { state: run.state, reason: run.failureReason };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

const NO_LIST = 'Nothing says which repositories APP-1 changes yet. Run refine or plan on it, or pick them on its Settings tab.';
const root = () => join(project, 'worktrees', 'APP-1');
const branchAt = (at: string) => git(at, 'branch', '--show-current').trim();

it('starts refine of a card with no list in the project folder and makes no checkout', async () => {
  rootWithApi();

  expect((await runToEnd('refine')).state).toBe('complete');

  expect(seen).toEqual([{ cwd: project, phase: 'refine' }]);
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
});

// Plan corrects the list, so it reads the project the way refine does.
it('starts plan of a card with no list in the project folder and makes no checkout', async () => {
  rootWithApi();

  expect((await runToEnd('plan')).state).toBe('complete');

  expect(seen).toEqual([{ cwd: project, phase: 'plan' }]);
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
});

// Refused when the job is built, so nothing is queued for a card that cannot start.
it('refuses to build an implement job for a card with no list', () => {
  rootWithApi();

  expect(() => live.buildJob('APP-1', 'implement', 99)).toThrow(NO_LIST);
  expect(live.buildJob('APP-1', 'refine', 99).cwd).toBe(project);
});

// In the project folder the guard is the only thing that holds refine and plan, which both hold Write.
it('fails a refine that would start in the project folder when the project has no run guard', async () => {
  rootWithApi();
  rmSync(join(project, GUARD_PATH));

  const run = await runToEnd('refine');

  expect(run).toEqual({
    state: 'failed',
    reason: `This project has no run guard at ${GUARD_PATH}, so nothing would hold a refine run to its card folder. Press Write the project files in Project settings.`,
  });
  expect(seen).toEqual([]);
});

// The engine filed the session under the project folder, so a resume after the root exists goes there.
it('resumes a refine in the folder its session was made in, after an implement made the root', async () => {
  rootWithApi();
  expect((await runToEnd('refine')).state).toBe('complete');
  live.db.prepare("UPDATE runs SET session_id = 'session-1' WHERE card_key = 'APP-1' AND phase = 'refine'").run();
  setCardRepos(live.db, 'APP-1', ['api'], 'person');
  expect((await runToEnd('implement')).state).toBe('complete');

  expect((await runToEnd('refine', 'session-1')).state).toBe('complete');
  expect((await runToEnd('plan')).state).toBe('complete');

  expect(seen).toEqual([
    { cwd: project, phase: 'refine' },
    { cwd: root(), phase: 'implement' },
    { cwd: project, phase: 'refine' },
    { cwd: root(), phase: 'plan' },
  ]);
});

it('fails an implement of a card with no list before any spawn, and makes no checkout', async () => {
  rootWithApi();

  const run = await runToEnd('implement');

  expect(run).toEqual({ state: 'failed', reason: NO_LIST });
  expect(seen).toEqual([]);
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
  expect((live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).toBe('failed');
});

it('makes the root and child checkouts on one branch for implement, then plan and a second implement start in the root', async () => {
  rootWithApi();
  setCardRepos(live.db, 'APP-1', ['api'], 'person');

  expect((await runToEnd('implement')).state).toBe('complete');
  const api = join(root(), 'api');
  expect(branchAt(root())).toBe('feature/APP-1/add-a-search-box');
  expect(branchAt(api)).toBe('feature/APP-1/add-a-search-box');
  // Each one cut from its own base: the root from the base branch setting, api from its entry.
  expect(git(project, 'rev-parse', 'feature/APP-1/add-a-search-box').trim()).toBe(git(project, 'rev-parse', 'main').trim());
  expect(git(join(project, 'api'), 'rev-parse', 'feature/APP-1/add-a-search-box').trim()).toBe(git(join(project, 'api'), 'rev-parse', 'develop').trim());
  git(api, 'commit', '-q', '--allow-empty', '-m', 'work of the first run');

  expect((await runToEnd('plan')).state).toBe('complete');
  expect((await runToEnd('implement')).state).toBe('complete');

  expect(seen).toEqual([
    { cwd: root(), phase: 'implement' },
    { cwd: root(), phase: 'plan' },
    { cwd: root(), phase: 'implement' },
  ]);
  // The second implement went on in the same checkouts.
  expect(git(api, 'log', '--format=%s', '-1').trim()).toBe('work of the first run');
  expect(git(project, 'worktree', 'list')).toContain('APP-1');
});

// The list is read when the job gets its slot too, since a person can clear it while the job waits.
it('fails a queued implement whose list was cleared while it waited', async () => {
  rootWithApi();
  setCardRepos(live.db, 'APP-1', ['api'], 'person');
  const job = live.buildJob('APP-1', 'implement', 99);
  setCardRepos(live.db, 'APP-1', [], 'person');
  const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'implement', 'fake', 'queued')").run().lastInsertRowid);
  live.scheduler.add({ ...job, runId });
  for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(readRun(live.db, runId)?.failureReason).toBe(NO_LIST);
  expect(seen).toEqual([]);
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
});

it('makes a plain root folder for a project that is no repository', async () => {
  repoAt(join(project, 'api'), 'main');
  repoAt(join(project, 'web'), 'main');
  writeSetting(live.db, 'repos', [{ path: 'api', base: null }, { path: 'web', base: null }]);
  setCardRepos(live.db, 'APP-1', ['web'], 'person');

  expect((await runToEnd('implement')).state).toBe('complete');

  // One repository on the card, so the run starts in its checkout.
  expect(seen).toEqual([{ cwd: join(root(), 'web'), phase: 'implement' }]);
  expect(readdirSync(root())).toEqual(['web']);
  expect(branchAt(join(root(), 'web'))).toBe('feature/APP-1/add-a-search-box');

  // The plain root has no branch, so the branch is read from the web checkout inside it. Worked out
  // from the new title it would not match that checkout.
  live.db.prepare("UPDATE cards SET title = 'Add a filter' WHERE key = 'APP-1'").run();
  expect((await runToEnd('implement')).state).toBe('complete');
  expect(branchAt(join(root(), 'web'))).toBe('feature/APP-1/add-a-search-box');
  expect(readdirSync(root())).toEqual(['web']);
});

// The list grew a repository that sorts before the one already checked out. Its checkout is not
// there yet, so the branch is read from the next one, and the new checkout joins that branch.
it('keeps the branch of a later checkout when an earlier repository joins the list', async () => {
  repoAt(join(project, 'api'), 'main');
  repoAt(join(project, 'web'), 'main');
  writeSetting(live.db, 'repos', [{ path: 'api', base: null }, { path: 'web', base: null }]);
  setCardRepos(live.db, 'APP-1', ['web'], 'person');
  expect((await runToEnd('implement')).state).toBe('complete');

  live.db.prepare("UPDATE cards SET title = 'Add a filter' WHERE key = 'APP-1'").run();
  setCardRepos(live.db, 'APP-1', ['api', 'web'], 'person');
  expect((await runToEnd('implement')).state).toBe('complete');

  expect(branchAt(join(root(), 'api'))).toBe('feature/APP-1/add-a-search-box');
  expect(branchAt(join(root(), 'web'))).toBe('feature/APP-1/add-a-search-box');
});

// One entry in the list is the whole list, so the card needs no list of its own.
it('makes a plain root holding the one child repository the list names', async () => {
  repoAt(join(project, 'api'), 'main');
  writeSetting(live.db, 'repos', [{ path: 'api', base: null }]);

  expect((await runToEnd('implement')).state).toBe('complete');

  expect(seen).toEqual([{ cwd: join(root(), 'api'), phase: 'implement' }]);
  expect(readdirSync(root())).toEqual(['api']);
  expect(branchAt(join(root(), 'api'))).toBe('feature/APP-1/add-a-search-box');
});

// A plain project folder runs on Claude Code only until the other engines are measured in one. The
// refusal comes where the job is built, so there is no checkout and no spawn.
const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-start-codex' };
const OUTSIDE_GIT = 'APP-1 cannot run implement on codex#work. The project folder is not a git repository, and Claude Code is the one engine known to run in a folder like that. Run this phase on a Claude Code profile.';

it('fails a Codex implement in a project that is not a git repository before any spawn, and makes no checkout', async () => {
  repoAt(join(project, 'api'), 'main');
  writeSetting(live.db, 'repos', [{ path: 'api', base: null }]);
  writeSetting(live.db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(live.db, 'models', { implement: { engine: CODEX.id, model: 'gpt-5.6-terra' } });

  expect(await runToEnd('implement')).toEqual({ state: 'failed', reason: OUTSIDE_GIT });
  expect(seen).toEqual([]);
  expect(existsSync(join(project, 'worktrees'))).toBe(false);
});

// The refusal names the card it was built for, not the first one on the board.
it('names the card a Codex job outside git was refused for', () => {
  repoAt(join(project, 'api'), 'main');
  writeSetting(live.db, 'repos', [{ path: 'api', base: null }]);
  writeSetting(live.db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(live.db, 'models', { implement: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'implement', 'queued', 'Sort the list')").run();

  expect(() => live.buildJob('APP-2', 'implement', 99)).toThrow(OUTSIDE_GIT.replace('APP-1', 'APP-2'));
});

it('marks a job outside git only when the project folder is not a repository', () => {
  repoAt(join(project, 'api'), 'main');
  writeSetting(live.db, 'repos', [{ path: 'api', base: null }]);
  expect(live.buildJob('APP-1', 'implement', 99).outsideGit).toBe(true);
  expect(live.buildJob('APP-1', 'refine', 99).outsideGit).toBe(true);

  // The job builder reads the list, not the disk: a list that names `.` is a root repository.
  writeSetting(live.db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
  setCardRepos(live.db, 'APP-1', ['api'], 'person');
  expect('outsideGit' in live.buildJob('APP-1', 'implement', 99)).toBe(false);
  writeSetting(live.db, 'repos', null);
  expect('outsideGit' in live.buildJob('APP-1', 'implement', 99)).toBe(false);
});

// The same Codex row in a project whose folder is a repository builds the job it always did.
it('builds a Codex implement in a project whose folder is a repository', () => {
  repoAt(project, 'main');
  writeSetting(live.db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(live.db, 'models', { implement: { engine: CODEX.id, model: 'gpt-5.6-terra' } });

  expect(live.buildJob('APP-1', 'implement', 99).engine).toBe(CODEX.id);
});

// With one repository the list is the setting, not the card row, so a job whose card row went while
// it waited still gets its checkout the way it always did.
it('makes the checkout of a one repository project without reading the card row', async () => {
  repoAt(project, 'main');
  const job = live.buildJob('APP-1', 'implement', 99);
  live.db.prepare("DELETE FROM cards WHERE key = 'APP-1'").run();
  const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'implement', 'fake', 'queued')").run().lastInsertRowid);
  live.scheduler.add({ ...job, runId });
  for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(seen).toEqual([{ cwd: root(), phase: 'implement' }]);
  expect(existsSync(join(root(), 'README.md'))).toBe(true);
});

// The base comes from the repository list, which stores a dash at the front.
it('fails the run when a base from the list starts with a dash, before git reads it', async () => {
  rootWithApi('-f');
  setCardRepos(live.db, 'APP-1', ['api'], 'person');

  const run = await runToEnd('implement');

  expect(run.state).toBe('failed');
  expect(run.reason).toContain('The base branch -f starts with a dash, so git would read it as an option.');
  expect(seen).toEqual([]);
  expect(git(join(project, 'api'), 'branch', '--list', 'feature/APP-1/add-a-search-box')).toBe('');
});

// Refine and plan name the card's repositories on the last line of their file, and the loop keeps it.
describe('the list refine and plan name', () => {
  // A root repository that ignores its two child repositories.
  const rootWithApiAndWeb = (): void => {
    repoAt(project, 'main');
    writeFileSync(join(project, '.gitignore'), 'api/\nweb/\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'ignore api and web');
    repoAt(join(project, 'api'), 'main');
    repoAt(join(project, 'web'), 'main');
    writeSetting(live.db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }, { path: 'web', base: null }]);
  };

  const jobs: Job[] = [];
  const ASK = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${NEEDS_INPUT_PREFIX}Should the search box live in web or api?` }] } });

  // The run writes its phase's file ending in this line, then ends the way it is told.
  const writing = (line: string, ...end: string[]): void => {
    live.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      jobs.push(job);
      const file = join(job.taskDir, job.phase, job.phase === 'refine' ? 'refined.md' : 'plan.md');
      mkdirSync(join(job.taskDir, job.phase), { recursive: true });
      writeFileSync(file, `# APP-1\n\nThe search box filters the list.\n\n${line}\n`);
      for (const one of end.length === 0 ? [RESULT] : end) yield one;
    };
  };

  beforeEach(() => {
    jobs.length = 0;
    rootWithApiAndWeb();
  });

  it('lists every repository in the prompt and on the job, with its knowledge file when there is one', async () => {
    mkdirSync(join(project, '.nolzu', 'knowledge', 'api'), { recursive: true });
    writeFileSync(join(project, '.nolzu', 'knowledge', 'api', 'repository.md'), '# api\n');
    writing('Repositories: api');

    expect((await runToEnd('refine')).state).toBe('complete');

    expect(jobs[0]?.repositories).toEqual(['.', 'api', 'web']);
    expect(jobs[0]?.prompt).toContain('- `.` at `./`\n- `api` at `api/`, knowledge in `.nolzu/knowledge/api/repository.md`\n- `web` at `web/`\n');
  });

  it('fills a card with no list from what refine named, and a later plan replaces it', async () => {
    writing('Repositories: api');
    expect((await runToEnd('refine')).state).toBe('complete');
    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['api'], by: 'refine' });

    writing('Repositories: web');
    expect((await runToEnd('plan')).state).toBe('complete');
    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['web'], by: 'plan' });
  });

  it('writes the list of the card that ran, and no other card', async () => {
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'refine', 'queued', 'Sort the recipes')").run();
    writing('Repositories: api');

    live.start('APP-2', 'refine');
    const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
    for (let tries = 0; tries < 3000 && readRun(live.db, runId)?.state !== 'complete'; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(cardRepos(live.db, 'APP-2')).toEqual({ repos: ['api'], by: 'refine' });
    expect(cardRepos(live.db, 'APP-1')).toBeNull();
  });

  it('leaves a list a person picked as it is, after refine and after plan', async () => {
    setCardRepos(live.db, 'APP-1', ['web'], 'person');
    writing('Repositories: api');

    expect((await runToEnd('refine')).state).toBe('complete');
    expect((await runToEnd('plan')).state).toBe('complete');

    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['web'], by: 'person' });
  });

  // Through the fake engine's own plan, which names every repository the job lists.
  it('leaves the pick a person made when a plan on the fake engine completes after it', async () => {
    const fake = fakeEngine(0);
    live.engine.spawn = (job: Job, signal: AbortSignal) => fake.spawn(job, signal);
    expect((await runToEnd('plan')).state).toBe('complete');
    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['.', 'api', 'web'], by: 'plan' });

    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    // Gone before the second plan, so the line read after it is the one that plan wrote.
    const plan = join(project, '.tasks', 'APP-1', 'plan', 'plan.md');
    rmSync(plan);
    expect((await runToEnd('plan')).state).toBe('complete');

    expect(readFileSync(plan, 'utf8')).toContain('Repositories: ., api, web');
    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['api'], by: 'person' });
  });

  it('drops a name the project does not list, and the run log says which', async () => {
    writing('Repositories: api, billing');

    expect((await runToEnd('refine')).state).toBe('complete');

    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['api'], by: 'refine' });
    const run = readRun(live.db, (live.db.prepare("SELECT max(id) AS id FROM runs WHERE phase = 'refine'").get() as { id: number }).id);
    const notes = readFileSync(run?.logPath ?? '', 'utf8').trimEnd().split('\n').map(runLogNote);
    expect(notes).toContain("The refine named billing, which is not a repository of this project, so APP-1's list leaves it out.");
  });

  it('keeps a repository the card has a checkout of when the line leaves it out', async () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    expect((await runToEnd('implement')).state).toBe('complete');
    // The person clears the pick, so the next plan picks again.
    setCardRepos(live.db, 'APP-1', [], 'person');
    writing('Repositories: web');

    expect((await runToEnd('plan')).state).toBe('complete');

    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['.', 'api', 'web'], by: 'plan' });
    // The plan read api in the card's checkout, and web in the project.
    expect(jobs[0]?.prompt).toContain('- `api` at `api/`');
    expect(jobs[0]?.cwd).toBe(root());
    expect(jobs[0]?.prompt).toContain(`- \`web\` at \`../../web/\``);
  });

  it('does not read a file an earlier run left when this run writes none', async () => {
    writing('Repositories: api');
    expect((await runToEnd('refine')).state).toBe('complete');
    setCardRepos(live.db, 'APP-1', [], 'person');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(project, '.tasks', 'APP-1', 'refine', 'refined.md'), old, old);
    live.engine.spawn = async function* (job: Job) {
      if (job.phase !== 'extract-summary') yield RESULT;
    };

    expect((await runToEnd('refine')).state).toBe('complete');

    expect(cardRepos(live.db, 'APP-1')).toBeNull();
  });

  it('keeps the list when a line names only repositories the project does not have', async () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    expect((await runToEnd('implement')).state).toBe('complete');
    setCardRepos(live.db, 'APP-1', [], 'person');
    writing('Repositories: api, web');
    expect((await runToEnd('refine')).state).toBe('complete');
    writing('Repositories: billing');

    expect((await runToEnd('plan')).state).toBe('complete');

    expect(cardRepos(live.db, 'APP-1')).toEqual({ repos: ['.', 'api', 'web'], by: 'refine' });
  });

  it('changes nothing for a file with no line, a run that asks a question, or a failed run', async () => {
    writing('The repositories are api and web.');
    expect((await runToEnd('refine')).state).toBe('complete');

    writing('Repositories: api', ASK, RESULT);
    expect((await runToEnd('refine')).state).toBe('complete');
    expect(live.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get()).toEqual({ state: 'blocked' });

    writing('Repositories: api', JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }));
    expect((await runToEnd('plan')).state).toBe('failed');

    expect(cardRepos(live.db, 'APP-1')).toBeNull();
  });

  it('leaves a project with one repository out of all of it', () => {
    writeSetting(live.db, 'repos', null);
    const job = live.buildJob('APP-1', 'plan', 99);
    expect('repositories' in job).toBe(false);
    expect(job.prompt).not.toContain('several repositories');
  });

  it('keeps no list and writes no note on a project with one repository, whatever the line says', async () => {
    writeSetting(live.db, 'repos', null);
    writing('Repositories: ., billing');

    expect((await runToEnd('refine')).state).toBe('complete');

    expect(cardRepos(live.db, 'APP-1')).toBeNull();
    const run = readRun(live.db, (live.db.prepare("SELECT max(id) AS id FROM runs WHERE phase = 'refine'").get() as { id: number }).id);
    expect(readFileSync(run?.logPath ?? '', 'utf8').trimEnd().split('\n').map(runLogNote).filter((note) => note !== null)).toEqual([]);
  });
});

describe('an empty workspace', () => {
  const NO_REPOSITORY = 'This project has no repository yet. Add one in Project settings.';

  // The workspace folder is a git repository of its own that no card changes, with no repository in it yet.
  beforeEach(() => {
    repoAt(project, 'main');
    writeSetting(live.db, 'workspace', true);
    writeSetting(live.db, 'repos', []);
  });

  it('fails an implement before any spawn with its own sentence, and makes no checkout', async () => {
    expect(() => live.buildJob('APP-1', 'implement', 99)).toThrow(NO_REPOSITORY);

    const run = await runToEnd('implement');

    expect(run).toEqual({ state: 'failed', reason: NO_REPOSITORY });
    expect(seen).toEqual([]);
    expect(existsSync(join(project, 'worktrees'))).toBe(false);
  });

  it('runs refine and plan in the workspace folder and makes no checkout', async () => {
    expect((await runToEnd('refine')).state).toBe('complete');
    expect((await runToEnd('plan')).state).toBe('complete');

    expect(seen).toEqual([
      { cwd: project, phase: 'refine' },
      { cwd: project, phase: 'plan' },
    ]);
    expect(existsSync(join(project, 'worktrees'))).toBe(false);
  });

  it('holds refine to the run guard in the workspace folder', async () => {
    rmSync(join(project, GUARD_PATH));

    expect(await runToEnd('refine')).toEqual({
      state: 'failed',
      reason: `This project has no run guard at ${GUARD_PATH}, so nothing would hold a refine run to its card folder. Press Write the project files in Project settings.`,
    });
    expect(seen).toEqual([]);
  });

  // Null is one repository at the project folder in an ordinary project. Here that would be the workspace itself.
  it('reads a workspace with no list as no repository, and fails an implement the same way', async () => {
    writeSetting(live.db, 'repos', null);

    expect(await runToEnd('implement')).toEqual({ state: 'failed', reason: NO_REPOSITORY });
    expect(seen).toEqual([]);
    expect(existsSync(join(project, 'worktrees'))).toBe(false);
  });

  // The list is read again when the job gets its slot, and the last repository may be gone by then.
  it('fails a queued implement whose workspace lost its last repository while it waited', async () => {
    repoAt(join(project, 'api'), 'main');
    writeSetting(live.db, 'repos', [{ path: 'api', base: null }]);
    const job = live.buildJob('APP-1', 'implement', 99);
    writeSetting(live.db, 'repos', []);
    const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'implement', 'fake', 'queued')").run().lastInsertRowid);
    live.scheduler.add({ ...job, runId });
    for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(readRun(live.db, runId)?.failureReason).toBe(NO_REPOSITORY);
    expect(seen).toEqual([]);
    expect(existsSync(join(project, 'worktrees'))).toBe(false);
  });

  // The folder is read for the card that runs. Another card's root, or its session, says nothing.
  it("picks the folder by the card's own root and session, not another card's", () => {
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'refine', 'queued', 'Add a filter')").run();
    mkdirSync(root(), { recursive: true });

    expect(live.buildJob('APP-2', 'refine', 99).cwd).toBe(project);

    live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, session_id, cwd) VALUES ('APP-2', 'refine', 'fake', 'complete', 'session-2', ?)").run(project);
    mkdirSync(join(project, 'worktrees', 'APP-2'));

    expect(live.buildJob('APP-2', 'refine', 99, null, null, null, 'session-2').cwd).toBe(project);
  });

  // Every other phase needs a checkout too, so it meets the same sentence.
  it.each(['qa', 'wrapup'] as const)('refuses to build a %s job', (phase) => {
    expect(() => live.buildJob('APP-1', phase, 99)).toThrow(NO_REPOSITORY);
  });
});

// Research and Investigate answer from what is there, and their boards have no refine or plan to
// pick a list. A card with no list read the project before, so it reads it again; a list a person
// picked still gets a checkout of its own.
describe('the boards with no refine or plan', () => {
  async function runCard(key: string, phase: string): Promise<{ state: string | undefined; reason: string | null | undefined }> {
    live.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run('queued', key);
    live.start(key, phase as 'refine');
    const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
    for (let tries = 0; tries < 3000; tries += 1) {
      const run = readRun(live.db, runId);
      // Out of the queue too: the summary pass and its git compare still hold the slot.
    if ((run?.state === 'complete' || run?.state === 'failed' || run?.state === 'stopped') && !live.scheduler.queue().running.some((job) => job.runId === runId)) return { state: run.state, reason: run.failureReason };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the run did not end');
  }

  it.each([
    ['Q-1', 'questions', 'research', 'research'],
    ['I-1', 'investigations', 'research', 'investigate'],
  ])('starts %s with no list in the project folder and makes no checkout', async (key, board, stage, phase) => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, 'queued', 'What does the api do?')").run(key, board, stage);

    expect(await runCard(key, phase)).toEqual({ state: 'complete', reason: null });

    expect(seen).toEqual([{ cwd: project, phase }]);
    expect(existsSync(join(project, 'worktrees'))).toBe(false);
  });

  it('gives a research card whose list a person picked a checkout of that list', async () => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'questions', 'research', 'queued', 'What does the api do?')").run();
    setCardRepos(live.db, 'Q-1', ['api'], 'person');

    expect((await runCard('Q-1', 'research')).state).toBe('complete');

    expect(seen).toEqual([{ cwd: join(project, 'worktrees', 'Q-1'), phase: 'research' }]);
    expect(branchAt(join(project, 'worktrees', 'Q-1', 'api'))).not.toBe('');
  });

  it('reads an empty workspace in place too', () => {
    writeSetting(live.db, 'workspace', true);
    writeSetting(live.db, 'repos', []);
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'questions', 'research', 'queued', 'What should we build?')").run();

    expect(live.buildJob('Q-1', 'research', 99).cwd).toBe(project);
  });

  // The wrap-up of an answered question writes the knowledge folder, which needs no checkout.
  it('builds the wrap-up of a research card with no list in the project folder', () => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'questions', 'review', 'idle', 'What does the api do?')").run();

    expect(live.buildJob('Q-1', 'wrapup', 99).cwd).toBe(project);
  });

  // The Delivery sentence sends a person to refine or plan, which a PR review card does not have.
  it('tells a card on a board with no refine or plan only about its Settings tab', () => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('api#7', 'prreview', 'pre-review', 'idle', 'Fix the search')").run();

    expect(() => live.buildJob('api#7', 'pr-review', 99)).toThrow(/^Nothing says which repositories api#7 changes yet\. Pick them on its Settings tab\.$/);
    expect(() => live.buildJob('APP-1', 'implement', 99)).toThrow(NO_LIST);
  });

  // A list cleared while the job waited: the root was never made, so the run says what is missing.
  it('fails a queued research whose list was cleared while it waited, before any spawn', async () => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'questions', 'research', 'queued', 'What does the api do?')").run();
    setCardRepos(live.db, 'Q-1', ['api'], 'person');
    const job = live.buildJob('Q-1', 'research', 99);
    setCardRepos(live.db, 'Q-1', [], 'person');
    const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('Q-1', 'research', 'fake', 'queued')").run().lastInsertRowid);
    live.scheduler.add({ ...job, runId });
    for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(job.cwd).toBe(join(project, 'worktrees', 'Q-1'));
    expect(readRun(live.db, runId)?.failureReason).toBe('Nothing says which repositories Q-1 changes yet. Pick them on its Settings tab.');
    expect(seen).toEqual([]);
  });

  // A list picked while the job waited: the run goes where the build chose, not to a refusal.
  it('starts a queued research in the project when a list was picked while it waited', async () => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'questions', 'research', 'queued', 'What does the api do?')").run();
    const job = live.buildJob('Q-1', 'research', 99);
    setCardRepos(live.db, 'Q-1', ['api'], 'person');
    const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('Q-1', 'research', 'fake', 'queued')").run().lastInsertRowid);
    live.scheduler.add({ ...job, runId });
    for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(readRun(live.db, runId)?.state).toBe('complete');
    expect(seen).toEqual([{ cwd: project, phase: 'research' }]);
  });

  // The session was filed under the project folder, so a resume after a list was picked goes there.
  it('resumes a research in the project folder after a person picked a list', async () => {
    rootWithApi();
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'questions', 'research', 'queued', 'What does the api do?')").run();
    expect((await runCard('Q-1', 'research')).state).toBe('complete');
    live.db.prepare("UPDATE runs SET session_id = 'session-1' WHERE card_key = 'Q-1'").run();
    setCardRepos(live.db, 'Q-1', ['api'], 'person');

    expect(live.buildJob('Q-1', 'research', 99, null, null, null, 'session-1').cwd).toBe(project);
  });
});

// A workspace card that changes one repository starts in that repository's checkout, so the project's
// commands run without a `cd` in front, which no allowed command matches. Several keep the root, and
// the prompt says to pass each tool's folder option instead.
describe('where a workspace card starts', () => {
  const FLAGS = 'This card changes several repositories.';
  const api = () => join(root(), 'api');

  beforeEach(() => {
    repoAt(join(project, 'api'), 'main');
    repoAt(join(project, 'web'), 'main');
    writeSetting(live.db, 'workspace', true);
    writeSetting(live.db, 'repos', [{ path: 'api', base: null }, { path: 'web', base: null }]);
  });

  it.each(['implement', 'qa'] as const)('starts %s of a card on one repository in its checkout, with no folder flags', (phase) => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');

    const job = live.buildJob('APP-1', phase, 99);

    expect(job.cwd).toBe(api());
    expect(job.prompt).not.toContain(FLAGS);
    // The card folder and the project rules are named by full path, so they hold from the repository too.
    expect(job.taskDir).toBe(join(project, '.tasks', 'APP-1'));
    expect(job.projectDir).toBe(project);
  });

  it('runs an implement in the repository checkout, and a second one goes on there', async () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');

    expect((await runToEnd('implement')).state).toBe('complete');
    expect((await runToEnd('implement')).state).toBe('complete');

    expect(seen).toEqual([
      { cwd: api(), phase: 'implement' },
      { cwd: api(), phase: 'implement' },
    ]);
  });

  // Fix it resumes the newest implement session, and the engine filed it under the folder it ran in.
  it('resumes a session where it was made: the repository, or the root for a session from before', () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, session_id, cwd) VALUES ('APP-1', 'implement', 'fake', 'complete', 'in-repo', ?)").run(api());
    live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, session_id, cwd) VALUES ('APP-1', 'implement', 'fake', 'complete', 'at-root', ?)").run(root());

    expect(live.buildJob('APP-1', 'implement', 99, null, null, null, 'in-repo').cwd).toBe(api());
    expect(live.buildJob('APP-1', 'implement', 99, null, null, null, 'at-root').cwd).toBe(root());
  });

  // A run from before the folder was recorded started in the root, so its session is filed there.
  it('resumes a session with no recorded folder in the root', () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, session_id) VALUES ('APP-1', 'implement', 'fake', 'complete', 'no-folder')").run();

    expect(live.buildJob('APP-1', 'implement', 99, null, null, null, 'no-folder').cwd).toBe(root());
  });

  // Own commands under `*` run in the card's checkout root, as the stack hook they replace did, and a run
  // in one repository keeps that.
  it('runs own commands under * of a QA on one repository in the root, and the engine in the repository', async () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    const trail = join(dir, 'stack.txt');
    writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start: `pwd -P >> ${trail}`, stop: null, status: null } });

    expect((await runToEnd('qa' as 'implement')).state).toBe('complete');

    expect(seen).toEqual([{ cwd: api(), phase: 'qa' }]);
    expect(readFileSync(trail, 'utf8').trim()).toBe(realpathSync(root()));
  });

  // Only a run that may use the shell needs it. Refine, plan and the wrap-up start as before.
  it('leaves refine, plan and the wrap-up where they started before', () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    expect(live.buildJob('APP-1', 'wrapup', 99).cwd).toBe(root());

    expect(live.buildJob('APP-1', 'refine', 99).cwd).toBe(project);
    expect(live.buildJob('APP-1', 'plan', 99).cwd).toBe(project);
    mkdirSync(root(), { recursive: true });
    expect(live.buildJob('APP-1', 'refine', 99).cwd).toBe(root());
  });

  it('fails a queued implement whose repository changed while it waited, before any spawn', async () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    const job = live.buildJob('APP-1', 'implement', 99);
    setCardRepos(live.db, 'APP-1', ['web'], 'person');
    const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'implement', 'fake', 'queued')").run().lastInsertRowid);
    live.scheduler.add({ ...job, runId });
    for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(readRun(live.db, runId)?.failureReason).toBe('The repositories of APP-1 changed while it waited for its turn, so this run would start in the wrong one. Start the card again.');
    expect(seen).toEqual([]);
  });

  it('fails a queued implement whose list grew to several repositories while it waited, before any spawn', async () => {
    setCardRepos(live.db, 'APP-1', ['api'], 'person');
    const job = live.buildJob('APP-1', 'implement', 99);
    setCardRepos(live.db, 'APP-1', ['api', 'web'], 'person');
    const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'implement', 'fake', 'queued')").run().lastInsertRowid);
    live.scheduler.add({ ...job, runId });
    for (let tries = 0; tries < 300 && !['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? ''); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(readRun(live.db, runId)?.failureReason).toContain('changed while it waited for its turn');
    expect(seen).toEqual([]);
  });

  it.each(['implement', 'qa'] as const)('starts %s of a card on several repositories in the root, and names each one with a folder flag', (phase) => {
    setCardRepos(live.db, 'APP-1', ['api', 'web'], 'person');

    const job = live.buildJob('APP-1', phase, 99);

    expect(job.cwd).toBe(root());
    expect(job.prompt).toContain(FLAGS);
    expect(job.prompt).toContain('- `api` in `api/`');
    expect(job.prompt).toContain('- `web` in `web/`');
    expect(job.prompt).toContain('`npm --prefix api test`');
    expect(job.prompt).toContain('Never `cd api && ...`');
  });

  // Every path below is read for the card that runs. A second card must not borrow APP-1's checkout.
  describe('with a second card', () => {
    const second = () => join(project, 'worktrees', 'APP-2');
    const addSecond = (repos: string[]): void => {
      live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'refine', 'queued', 'Add a filter')").run();
      setCardRepos(live.db, 'APP-2', repos, 'person');
    };
    const waitFor = async (runId: number): Promise<void> => {
      for (let tries = 0; tries < 300 && (!['complete', 'failed'].includes(readRun(live.db, runId)?.state ?? '') || live.scheduler.queue().running.some((job) => job.runId === runId)); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    it('starts in the checkout of its own card, and resumes there', () => {
      addSecond(['web']);
      live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, session_id, cwd) VALUES ('APP-2', 'implement', 'fake', 'complete', 'two', ?)").run(join(second(), 'web'));

      expect(live.buildJob('APP-2', 'implement', 99).cwd).toBe(join(second(), 'web'));
      expect(live.buildJob('APP-2', 'implement', 99, null, null, null, 'two').cwd).toBe(join(second(), 'web'));
    });

    it('names the folders of its own card in the folder flags', () => {
      addSecond(['api', 'web']);
      setCardRepos(live.db, 'APP-1', ['api'], 'person');

      const job = live.buildJob('APP-2', 'implement', 99);

      expect(job.cwd).toBe(second());
      expect(job.prompt).toContain('- `web` in `web/`');
    });

    it('lets a queued implement of its own card start in its repository', async () => {
      addSecond(['web']);
      const job = live.buildJob('APP-2', 'implement', 99);
      const runId = Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-2', 'implement', 'fake', 'queued')").run().lastInsertRowid);
      live.scheduler.add({ ...job, runId });
      await waitFor(runId);

      expect(readRun(live.db, runId)?.state).toBe('complete');
      expect(seen).toEqual([{ cwd: join(second(), 'web'), phase: 'implement' }]);
    });

    it('runs its own commands under * in the root of its own card', async () => {
      addSecond(['web']);
      const trail = join(dir, 'stack-two.txt');
      writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start: `pwd -P >> ${trail}`, stop: null, status: null } });
      live.start('APP-2', 'qa' as 'implement');
      await waitFor(Number((live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id));

      expect(seen).toEqual([{ cwd: join(second(), 'web'), phase: 'qa' }]);
      expect(readFileSync(trail, 'utf8').trim()).toBe(realpathSync(second()));
    });
  });

  it('gives refine on several repositories no folder flags', () => {
    setCardRepos(live.db, 'APP-1', ['api', 'web'], 'person');
    expect(live.buildJob('APP-1', 'refine', 99).prompt).not.toContain(FLAGS);
  });
});

// A project of one repository at its own folder starts where it always did, with the prompt it always had.
it('starts an implement of a one repository project in the root, with no folder flags', async () => {
  repoAt(project, 'main');

  const job = live.buildJob('APP-1', 'implement', 99);
  expect(job.cwd).toBe(root());
  expect(job.prompt).not.toContain('several repositories');
  expect((await runToEnd('implement')).state).toBe('complete');
  expect(seen).toEqual([{ cwd: root(), phase: 'implement' }]);
});
