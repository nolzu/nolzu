import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import type { RunGh } from '@nolzu/runner';
import { afterEach, describe, expect, it } from 'vitest';
import { type Clone, CLONE_STOPPED, cloneJobs, type CloneJob, stopClone } from './add-repo.ts';
import { readManifest } from './manifest.ts';
import { addToNewProject, finishNewProject, ghLogin, machineRepos, madeNotCloned, newPrivateRepository, projectInProgress, putOnGitHub, startFromIdea } from './new-project.ts';
import { createWorkspace } from './onboard.ts';

// What `gh auth status` printed, as the runner hands it back. Newer gh writes to stdout and older gh
// to stderr, and each words the account its own way.
const answer = (code: number | null, stdout: string, stderr = '') => async () => ({ code, stdout, stderr });

it('names the account gh is signed in with, in both wordings', async () => {
  expect(await ghLogin(answer(0, 'github.com\n  ✓ Logged in to github.com account you (keyring)\n  - Token: gho_************\n'))).toEqual({ found: true, signedIn: true, account: 'you' });
  expect(await ghLogin(answer(0, '', 'github.com\n  ✓ Logged in to github.com as cook (oauth_token)\n'))).toEqual({ found: true, signedIn: true, account: 'cook' });
});

it('says signed out when gh answers with an error, and missing when there is no gh', async () => {
  expect(await ghLogin(answer(1, '', 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n'))).toEqual({ found: true, signedIn: false, account: null });
  expect(await ghLogin(async () => ({ code: null, stdout: '', missing: true }))).toEqual({ found: false, signedIn: false, account: null });
});

// The status lines carry a masked token. Only the account name goes on.
it('sends nothing else gh printed to the page', async () => {
  const said = await ghLogin(answer(0, '  ✓ Logged in to github.com account you (keyring)\n  - Token: gho_secret\n'));

  expect(JSON.stringify(said)).not.toMatch(/gho_|Token/);
});

it('asks gh for its login and nothing else', async () => {
  const asked: string[][] = [];
  await ghLogin(async (binary, args) => (asked.push([binary, ...args]), { code: 1, stdout: '' }));

  expect(asked).toEqual([['gh', 'auth', 'status']]);
});

// A project needs a repository, so a workspace whose first clone has not landed
// cannot be made yet. A project set by hand, or one finished, is no project being made.
it('refuses Make the project while the workspace holds no repository', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nolzu-new-project-'));
  const db = openDatabase(join(home, 'data'));
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  try {
    const made = await createWorkspace(db, { parent: home, name: 'recipes', home, env });
    expect(made.ok).toBe(true);

    expect(projectInProgress(db, home)).toEqual({ path: '~/recipes', name: 'recipes', location: '~', repos: [] });
    expect(finishNewProject(db)).toBe('A project needs at least one repository. Add one, or wait until its clone is done.');
    expect(getSetting(db, 'onboarding')).toEqual({ done: false });

    writeSetting(db, 'onboarding', { done: true });
    expect(projectInProgress(db, home)).toBeNull();
    writeSetting(db, 'onboarding', { done: false });
    writeSetting(db, 'repos', null);
    writeSetting(db, 'workspace', null);
    expect(projectInProgress(db, home)).toBeNull();
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Add clones from origin when a repository has one, else from its first remote, and a repository with
// no remote has no URL to clone from.
it('picks origin over an earlier remote, falls back to the first, and gives none for no remote', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nolzu-machine-'));
  try {
    const repo = (name: string, remotes: [string, string][]) => {
      const dir = join(home, 'code', name);
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      for (const [remote, url] of remotes) execFileSync('git', ['-C', dir, 'remote', 'add', remote, url]);
    };
    repo('both', [['upstream', 'https://example.com/up.git'], ['origin', 'https://example.com/own.git']]);
    repo('only', [['mirror', 'https://example.com/mirror.git']]);
    repo('none', []);

    const found = await machineRepos(home, { PATH: process.env.PATH });

    expect(Object.fromEntries(found.map((one) => [one.path, one.url]))).toEqual({
      '~/code/both': 'https://example.com/own.git',
      '~/code/only': 'https://example.com/mirror.git',
      '~/code/none': null,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('Put on GitHub and a new private repository', () => {
  // GitHub stands in as bare repositories under <home>/github/<owner>. The recorded gh answers as gh
  // 2.95.0 does, and its `repo create` does to the source what the real one does: origin in the https
  // form, then a push of the branch it is on. The real gh is never spawned.
  const NOT_FOUND = (slug: string) => `GraphQL: Could not resolve to a Repository with the name '${slug}'. (repository)\n`;
  const homes: string[] = [];
  const dbs: DatabaseSync[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function world() {
    const home = mkdtempSync(join(tmpdir(), 'nolzu-github-'));
    homes.push(home);
    const db = openDatabase(join(home, 'data'));
    dbs.push(db);
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
    const github = (name: string) => join(home, 'github', 'you', `${name}.git`);
    const calls: string[][] = [];
    const taken = new Set<string>();
    const run: RunGh = async (args) => {
      calls.push([...args]);
      const said = args.join(' ');
      if (said === 'api user') return { code: 0, stdout: JSON.stringify({ login: 'you', id: 1 }), stderr: '' };
      if (said === 'api user/orgs') return { code: 0, stdout: '[]', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'view') return taken.has(args[2]!) ? { code: 0, stdout: '{"name":"x"}', stderr: '' } : { code: 1, stdout: '', stderr: NOT_FOUND(args[2]!) };
      if (args[0] === 'repo' && args[1] === 'create') {
        const source = args[args.indexOf('--source') + 1]!;
        const name = args[2]!.split('/')[1]!;
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', github(name)], { env });
        git(source, 'remote', 'add', 'origin', `https://github.com/you/${name}.git`);
        git(source, 'push', '-q', github(name), 'HEAD');
        return { code: 0, stdout: `https://github.com/you/${name}\n`, stderr: '' };
      }
      throw new Error(`No recorded answer for gh ${said}`);
    };
    // The clone of https://github.com/you/<name>.git, from its bare stand-in.
    const clone: Clone = async ({ workspace, url }) => {
      const name = url.split('/').at(-1)!.replace(/\.git$/, '');
      execFileSync('git', ['clone', '-q', github(name), join(workspace, name)], { env });
      return { ok: true, name, path: join(workspace, name) };
    };
    return { home, db, env, git, github, calls, taken, run, clone };
  }

  // A repository of the person's in ~/code with no remote: main with two commits, a branch never
  // pushed, a change not committed and a file git does not track.
  function sketchbook(w: ReturnType<typeof world>): string {
    const own = join(w.home, 'code', 'sketchbook');
    mkdirSync(own, { recursive: true });
    w.git(own, 'init', '-q', '-b', 'main');
    writeFileSync(join(own, 'sketch.txt'), 'one\n');
    w.git(own, 'add', '-A');
    w.git(own, 'commit', '-q', '-m', 'one');
    w.git(own, 'checkout', '-q', '-b', 'idea');
    writeFileSync(join(own, 'idea.txt'), 'later\n');
    w.git(own, 'add', '-A');
    w.git(own, 'commit', '-q', '-m', 'an idea');
    w.git(own, 'checkout', '-q', 'main');
    writeFileSync(join(own, 'sketch.txt'), 'two\n');
    w.git(own, 'commit', '-q', '-am', 'two');
    writeFileSync(join(own, 'sketch.txt'), 'three, not committed\n');
    writeFileSync(join(own, 'notes.txt'), 'not tracked\n');
    return own;
  }

  // Every file and folder under a folder, .git included, with its bytes and mode.
  const snapshot = (dir: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(dir, path), entry.isFile() ? `${statSync(path).mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}` : 'folder'];
      }),
    );

  const ended = async (workspace: string): Promise<readonly CloneJob[]> => {
    for (let tries = 0; tries < 500 && cloneJobs(workspace).some((job) => job.state === 'waiting' || job.state === 'cloning'); tries += 1) await wait(10);
    return cloneJobs(workspace);
  };

  // A clone that holds its turn until the test lets it go, so the next one of the project waits.
  const held = (then: Clone): { clone: Clone; release: () => void } => {
    let release = (): void => undefined;
    const gate = new Promise<void>((done) => (release = done));
    return {
      release: () => release(),
      clone: async (options) => {
        await gate;
        return then(options);
      },
    };
  };

  it('puts a repository with no remote on GitHub from a copy, clones it fresh, and leaves the folder byte for byte as it was', async () => {
    const w = world();
    const own = sketchbook(w);
    const before = snapshot(own);

    const put = await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, { run: w.run, clone: w.clone, home: w.home, env: w.env });

    expect(put).toMatchObject({ job: { name: 'sketchbook', url: 'https://github.com/you/sketchbook.git' } });
    const workspace = join(w.home, 'recipes');
    expect((await ended(workspace)).map((job) => job.state)).toEqual(['added']);
    expect(getSetting(w.db, 'repos')).toEqual([{ path: 'sketchbook', base: 'main' }]);
    expect(w.git(join(workspace, 'sketchbook'), 'log', '--format=%s')).toBe('two\none');
    // Only the branch the person was on went up, and none of the work outside a commit.
    expect(w.git(w.github('sketchbook'), 'branch', '--format=%(refname:short)')).toBe('main');
    expect(readFileSync(join(workspace, 'sketchbook', 'sketch.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(join(workspace, 'sketchbook', 'notes.txt'))).toBe(false);
    // Private, and the push came from a copy and not from the person's folder.
    const create = w.calls.find((call) => call[1] === 'create')!;
    expect(create).toContain('--private');
    expect(create).not.toContain('--public');
    expect(create[create.indexOf('--source') + 1]).not.toBe(own);

    expect(snapshot(own)).toEqual(before);
    expect(readFileSync(join(own, '.git', 'config'), 'utf8')).not.toContain('[remote');
    expect(w.git(own, 'remote')).toBe('');
  });

  it('names the new repository and what to do when it is made and the clone fails', async () => {
    const w = world();
    sketchbook(w);
    const failing: Clone = async () => ({ ok: false, reason: "Git could not clone sketchbook. fatal: could not read Username for 'https://github.com': terminal prompts disabled" });

    const put = await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, { run: w.run, clone: failing, home: w.home, env: w.env });

    expect('job' in put).toBe(true);
    const [job] = await ended(join(w.home, 'recipes'));
    expect(job).toMatchObject({ state: 'failed' });
    expect(job!.said).toBe(
      "The private repository github.com/you/sketchbook is on GitHub now, but it is not in the workspace yet. Git could not clone sketchbook. fatal: could not read Username for 'https://github.com': terminal prompts disabled. Paste https://github.com/you/sketchbook.git into the Git URL field and press Add to clone it again.",
    );
    expect(job!.said).toBe(madeNotCloned('you/sketchbook', 'https://github.com/you/sketchbook.git', "Git could not clone sketchbook. fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
  });

  // Stop on a clone that still waits for its turn ends it before git starts. GitHub has the
  // repository all the same, so the row names it.
  it('names the new repository when its clone is stopped while it waits for its turn', async () => {
    const w = world();
    sketchbook(w);
    const notebook = join(w.home, 'code', 'notebook');
    mkdirSync(notebook, { recursive: true });
    w.git(notebook, 'init', '-q', '-b', 'main');
    writeFileSync(join(notebook, 'notes.txt'), 'one\n');
    w.git(notebook, 'add', '-A');
    w.git(notebook, 'commit', '-q', '-m', 'one');
    const slow = held(w.clone);
    const seams = { run: w.run, clone: slow.clone, home: w.home, env: w.env };

    expect(await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, seams)).toHaveProperty('job');
    const second = await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/notebook' }, seams);
    if (!('job' in second)) throw new Error(second.problem);
    expect(second.job.state).toBe('waiting');
    expect(stopClone(second.job.id)).toBe(true);
    slow.release();

    const jobs = await ended(join(w.home, 'recipes'));
    expect(jobs.map((job) => [job.name, job.state])).toEqual([
      ['sketchbook', 'added'],
      ['notebook', 'failed'],
    ]);
    expect(jobs[1]!.said).toBe(madeNotCloned('you/notebook', 'https://github.com/you/notebook.git', CLONE_STOPPED));
  });

  it('puts it under the gh account itself and not under one of its organisations', async () => {
    const w = world();
    sketchbook(w);
    const withOrgs: RunGh = (args, signal) => (args.join(' ') === 'api user/orgs' ? Promise.resolve({ code: 0, stdout: '[{"login":"acme"}]', stderr: '' }) : w.run(args, signal));

    await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, { run: withOrgs, clone: w.clone, home: w.home, env: w.env });

    expect(w.calls.find((call) => call[1] === 'create')?.[2]).toBe('you/sketchbook');
  });

  it('refuses a name GitHub has already, before anything is made', async () => {
    const w = world();
    sketchbook(w);
    w.taken.add('you/sketchbook');

    const put = await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, { run: w.run, clone: w.clone, home: w.home, env: w.env });

    expect(put).toEqual({ problem: 'github.com/you/sketchbook exists already. Pick another name, or add that repository by its URL.' });
    expect(w.calls.some((call) => call[1] === 'create')).toBe(false);
    expect(existsSync(join(w.home, 'recipes'))).toBe(false);
  });

  it('refuses a folder the scan did not find and one with a remote, and asks gh nothing', async () => {
    const w = world();
    const own = sketchbook(w);
    const seams = { run: w.run, clone: w.clone, home: w.home, env: w.env };

    expect(await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/elsewhere' }, seams)).toEqual({ problem: '~/elsewhere is not a git repository found on this machine.' });
    w.git(own, 'remote', 'add', 'origin', 'https://example.com/team/sketchbook.git');
    expect(await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, seams)).toEqual({ problem: '~/code/sketchbook has a remote already. Press Add to clone it from there.' });
    expect(w.calls).toEqual([]);
  });

  it('says what gh said when it is not signed in, and makes nothing', async () => {
    const w = world();
    sketchbook(w);
    const out: RunGh = () => Promise.reject(new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.'));

    expect(await putOnGitHub(w.db, { name: 'recipes', folder: join(w.home, 'recipes'), path: '~/code/sketchbook' }, { run: out, home: w.home, env: w.env })).toEqual({
      problem: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.',
    });
    expect(existsSync(join(w.home, 'recipes'))).toBe(false);
  });

  it('makes a new private repository from a first commit and clones it into the workspace', async () => {
    const w = world();

    const made = await newPrivateRepository(w.db, { name: 'meal-planner', folder: join(w.home, 'meal-planner') }, { owner: 'you', name: 'meal-planner', readme: '# meal-planner\n' }, { run: w.run, clone: w.clone, env: w.env });

    expect(made).toMatchObject({ job: { name: 'meal-planner' } });
    const workspace = join(w.home, 'meal-planner');
    expect((await ended(workspace)).map((job) => job.state)).toEqual(['added']);
    expect(readFileSync(join(workspace, 'meal-planner', 'README.md'), 'utf8')).toBe('# meal-planner\n');
    expect(w.calls.find((call) => call[1] === 'create')).toContain('--private');
  });

  describe('Start from an idea', () => {
    const IDEA = 'A meal planner\nI pick recipes for the week and it makes one shopping list.';
    const answer = (w: ReturnType<typeof world>) => ({ idea: IDEA, decided: 'SvelteKit, must be free to host', name: 'meal-planner', folder: join(w.home, 'meal-planner'), owner: 'you', repo: 'meal-planner' });
    const cards = (db: DatabaseSync) => db.prepare('SELECT key, board, stage, title, summary, extra_context AS extra FROM cards').all();

    it('makes the workspace, the private repository cloned into it, and the epic in the Epics inbox with what is decided', async () => {
      const w = world();

      const started = await startFromIdea(w.db, answer(w), { run: w.run, clone: w.clone, env: w.env });

      // The key prefix is the last word of the project name, the client's prefix rule.
      expect(started).toEqual({ key: 'PLAN-1' });
      const workspace = join(w.home, 'meal-planner');
      expect(getSetting(w.db, 'projectPath')).toBe(workspace);
      expect(getSetting(w.db, 'workspace')).toBe(true);
      expect(w.git(workspace, 'log', '--format=%s').split('\n').at(-1)).toBe('chore: start the workspace');
      // The one repository is the new private one, cloned with its first commit.
      expect(w.calls.find((call) => call[1] === 'create')?.slice(0, 4)).toEqual(['repo', 'create', 'you/meal-planner', '--private']);
      expect(getSetting(w.db, 'repos')).toEqual([{ path: 'meal-planner', base: 'main' }]);
      expect(readManifest(workspace).repos).toEqual([{ folder: 'meal-planner', url: 'https://github.com/you/meal-planner.git', base: 'main' }]);
      expect(w.git(join(workspace, 'meal-planner'), 'log', '--format=%s')).toBe('chore: first commit');
      expect(readFileSync(join(workspace, 'meal-planner', 'README.md'), 'utf8')).toBe(`# meal-planner\n\n${IDEA}\n`);
      expect(cards(w.db)).toEqual([
        { key: 'PLAN-1', board: 'epics', stage: 'inbox', title: 'A meal planner', summary: 'I pick recipes for the week and it makes one shopping list.', extra: 'SvelteKit, must be free to host' },
      ]);
      // The clone landed, so the project is made and the board opens next.
      expect(getSetting(w.db, 'onboarding')).toEqual({ done: true });
    });

    // The project files go in with the workspace, in its first commit, so they are there whether
    // the clone lands or not, and the epic adds no commit.
    it('writes the project files with the workspace, also when its clone has failed', async () => {
      const w = world();
      await startFromIdea(w.db, answer(w), { run: w.run, clone: w.clone, env: w.env });
      const workspace = join(w.home, 'meal-planner');

      expect(existsSync(join(workspace, '.claude', 'hooks', 'nolzu-phase-guard.mjs'))).toBe(true);
      expect(w.git(workspace, 'log', '--format=%s')).toContain('chore: start the workspace');
      expect(w.git(workspace, 'log', '--format=%s')).not.toContain('chore: add the Nolzu files');
      expect(w.git(workspace, 'status', '--porcelain')).toBe('');

      const failed = world();
      await startFromIdea(failed.db, answer(failed), { run: failed.run, clone: async () => ({ ok: false, reason: 'Git could not clone meal-planner.' }), env: failed.env });
      expect(existsSync(join(failed.home, 'meal-planner', 'AGENTS.md'))).toBe(true);
    });

    it('leaves the extra context empty when nothing is decided', async () => {
      const w = world();

      await startFromIdea(w.db, { ...answer(w), decided: '  ' }, { run: w.run, clone: w.clone, env: w.env });

      expect(cards(w.db)).toMatchObject([{ key: 'PLAN-1', extra: null }]);
    });

    it('refuses a name GitHub has or a folder that is there, and leaves no folder, no repository and no card', async () => {
      const w = world();
      const seams = { run: w.run, clone: w.clone, env: w.env };
      const folder = join(w.home, 'meal-planner');
      w.taken.add('you/meal-planner');

      expect(await startFromIdea(w.db, answer(w), seams)).toEqual({ problem: 'github.com/you/meal-planner exists already. Pick another name, or add that repository by its URL.' });
      expect(existsSync(folder)).toBe(false);

      expect(await startFromIdea(w.db, { ...answer(w), repo: 'meal planner' }, seams)).toEqual({ problem: '"meal planner" cannot be a repository name on GitHub. Use letters, digits, ".", "-" and "_".' });
      expect(existsSync(folder)).toBe(false);

      // An empty folder is used, so the folder that is there has something in it.
      w.taken.clear();
      mkdirSync(folder);
      writeFileSync(join(folder, 'notes.txt'), '');
      expect(await startFromIdea(w.db, answer(w), seams)).toEqual({ problem: `${folder} has files in it already. Type a new folder, or an empty one.` });
      expect(readdirSync(folder)).toEqual(['notes.txt']);

      expect(w.calls.some((call) => call[1] === 'create')).toBe(false);
      expect(existsSync(join(w.home, 'github'))).toBe(false);
      expect(cards(w.db)).toEqual([]);
      expect(getSetting(w.db, 'projectPath')).toBeNull();
    });

    it('refuses an empty idea before asking gh anything, and an owner gh did not offer before making anything', async () => {
      const w = world();
      const seams = { run: w.run, clone: w.clone, env: w.env };

      expect(await startFromIdea(w.db, { ...answer(w), idea: '  \n ' }, seams)).toEqual({ problem: 'Type the idea first. It becomes the first card on the Epics board.' });
      expect(w.calls).toEqual([]);

      expect(await startFromIdea(w.db, { ...answer(w), owner: 'someone-else' }, seams)).toEqual({ problem: 'someone-else is not your GitHub account or one of its organisations. Pick an owner from the list.' });
      expect(w.calls).toEqual([
        ['api', 'user'],
        ['api', 'user/orgs'],
      ]);
      expect(readdirSync(w.home)).toEqual(['data']);
    });

    it('refuses what is decided over the limit before asking gh anything', async () => {
      const w = world();

      const started = await startFromIdea(w.db, { ...answer(w), decided: 'x'.repeat(64_001) }, { run: w.run, clone: w.clone, env: w.env });

      expect(started).toEqual({ problem: 'What is already decided is over 64 kB, which is the limit. Shorten it and press the button again.' });
      expect(w.calls).toEqual([]);
      expect(readdirSync(w.home)).toEqual(['data']);
    });


    it('says what gh said when it is not signed in, and makes nothing', async () => {
      const w = world();
      const out: RunGh = () => Promise.reject(new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.'));

      expect(await startFromIdea(w.db, answer(w), { run: out, env: w.env })).toEqual({ problem: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.' });
      expect(readdirSync(w.home)).toEqual(['data']);
    });

    // GitHub has the repository now, so the card stays and the sentence says how to add the clone on
    // New project, where the project waits for it.
    it('keeps the card and names the new repository when its clone fails, and leaves the project to finish', async () => {
      const w = world();
      const reason = "Git could not clone meal-planner. fatal: could not read Username for 'https://github.com': terminal prompts disabled";
      const failing: Clone = async () => ({ ok: false, reason });

      const started = await startFromIdea(w.db, answer(w), { run: w.run, clone: failing, env: w.env });

      expect(started).toEqual({
        problem: `${madeNotCloned('you/meal-planner', 'https://github.com/you/meal-planner.git', reason)} Your idea is PLAN-1 on the Epics board. The Git URL field is on New project, where the project waits.`,
      });
      expect(cards(w.db)).toMatchObject([{ key: 'PLAN-1', board: 'epics' }]);
      expect(getSetting(w.db, 'onboarding')).toEqual({ done: false });
      expect(projectInProgress(w.db, w.home)).toEqual({ path: '~/meal-planner', name: 'meal-planner', location: '~', repos: [] });
    });

    // Its clone would be refused once GitHub had the repository, and the idea would have no card.
    it('refuses a repository name a running clone of the waiting project goes into, before GitHub makes it', async () => {
      const w = world();
      const slow = held(async () => ({ ok: false, reason: 'Git could not clone meal-planner.' }));
      expect(await addToNewProject(w.db, { name: 'meal-planner', folder: join(w.home, 'meal-planner'), url: 'https://example.com/team/meal-planner.git' }, w.env, slow.clone)).toHaveProperty('job');

      expect(await startFromIdea(w.db, answer(w), { run: w.run, clone: w.clone, env: w.env })).toEqual({ problem: 'There is a repository "meal-planner" in this workspace already.' });
      expect(w.calls.some((call) => call[1] === 'create')).toBe(false);
      expect(cards(w.db)).toEqual([]);
      slow.release();
      await ended(join(w.home, 'meal-planner'));
    });
  });

  it('stores Gitflow branch names on a new project, and keeps a template a project stored already', async () => {
    const w = world();
    const slow = held(async () => ({ ok: false, reason: 'Git could not clone meal-planner.' }));
    expect(await addToNewProject(w.db, { name: 'meal-planner', folder: join(w.home, 'meal-planner'), url: 'https://example.com/team/meal-planner.git' }, w.env, slow.clone)).toHaveProperty('job');

    expect(getSetting(w.db, 'branchTemplate')).toBe('{type}/{key}/{desc}');
    slow.release();
    await ended(join(w.home, 'meal-planner'));

    const kept = world();
    writeSetting(kept.db, 'branchTemplate', 'work/{key}');
    const other = held(async () => ({ ok: false, reason: 'Git could not clone meal-planner.' }));
    expect(await addToNewProject(kept.db, { name: 'meal-planner', folder: join(kept.home, 'meal-planner'), url: 'https://example.com/team/meal-planner.git' }, kept.env, other.clone)).toHaveProperty('job');

    expect(getSetting(kept.db, 'branchTemplate')).toBe('work/{key}');
    other.release();
    await ended(join(kept.home, 'meal-planner'));
  });
});
