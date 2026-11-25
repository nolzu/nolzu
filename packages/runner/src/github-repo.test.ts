import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../test/temp-repo.ts';
import { copyToPush, createPrivateRepo, firstCommit, githubOwners, repoNameProblem } from './github-repo.ts';
import { ghRunner } from './tickets/gh.ts';
import type { RunGh } from './tickets/github.ts';

// What gh 2.95.0 prints for each call, in its own shape. The real gh is never spawned here: a test
// gets these answers from a recorded `RunGh`, or from a `gh` script of its own on a PATH of its own.
const USER = JSON.stringify({ login: 'you', id: 1, type: 'User', name: 'You', site_admin: false });
const ORGS = JSON.stringify([{ login: 'recipes-team', id: 2 }, { login: 'kitchen', id: 3 }]);
const NOT_FOUND = "GraphQL: Could not resolve to a Repository with the name 'you/sketchbook'. (repository)\n";

type Answer = { code?: number; stdout?: string; stderr?: string };

// A recorded gh: each call is matched on its arguments joined by spaces, and every call is kept.
function recorded(answers: Record<string, Answer | ((args: readonly string[]) => Answer)>): { run: RunGh; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      const found = answers[args.join(' ')];
      if (found === undefined) throw new Error(`No recorded answer for gh ${args.join(' ')}`);
      const answer = typeof found === 'function' ? found(args) : found;
      return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
}

const made: string[] = [];
const repos: TempRepo[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-gh-repo-'));
  made.push(dir);
  return dir;
};
const repo = (): TempRepo => {
  const one = tempRepo('nolzu-gh-source-');
  repos.push(one);
  return one;
};

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const one of repos.splice(0)) one.remove();
});

const live = (): AbortSignal => AbortSignal.timeout(10_000);

describe('githubOwners', () => {
  it('lists the account first, then its organisations, from gh api user and user/orgs', async () => {
    const gh = recorded({ 'api user': { stdout: USER }, 'api user/orgs': { stdout: ORGS } });

    expect(await githubOwners(gh.run, live())).toEqual({ owners: ['you', 'recipes-team', 'kitchen'] });
    expect(gh.calls).toEqual([
      ['api', 'user'],
      ['api', 'user/orgs'],
    ]);
  });

  // The menu still has the person's own account, which is where a repository goes by default.
  it('offers the account alone when the organisations cannot be read', async () => {
    const gh = recorded({ 'api user': { stdout: USER }, 'api user/orgs': { code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' } });

    expect(await githubOwners(gh.run, live())).toEqual({ owners: ['you'] });
  });

  it('says why when the account cannot be read', async () => {
    const gh = recorded({ 'api user': { code: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' } });

    expect(await githubOwners(gh.run, live())).toEqual({ problem: 'gh could not read your GitHub account. gh: Bad credentials (HTTP 401)' });
  });

  // The answer comes from the network, so a login that could break out of an argument is dropped.
  it('drops a login that is no GitHub login', async () => {
    const gh = recorded({ 'api user': { stdout: USER }, 'api user/orgs': { stdout: JSON.stringify([{ login: '--public' }, { login: 'ok-team' }, {}]) } });

    expect(await githubOwners(gh.run, live())).toEqual({ owners: ['you', 'ok-team'] });
  });

  // Through cliRunner, the way the app runs it: the same answers from a gh script on a PATH of its own.
  it('reads the owners through the real runner from a gh on the PATH', async () => {
    const dir = folder();
    const file = join(dir, 'gh');
    writeFileSync(file, `#!/bin/sh\nif [ "$2" = "user" ]; then printf '%s' '${USER}'; else printf '%s' '${ORGS}'; fi\n`);
    chmodSync(file, 0o755);

    expect(await githubOwners(ghRunner({ path: () => dir }), live())).toEqual({ owners: ['you', 'recipes-team', 'kitchen'] });
  });
});

describe('repoNameProblem', () => {
  it('passes a name GitHub has no repository for', async () => {
    const gh = recorded({ 'repo view you/sketchbook --json name': { code: 1, stderr: NOT_FOUND } });

    expect(await repoNameProblem('you', 'sketchbook', gh.run, live())).toBeNull();
    expect(gh.calls).toEqual([['repo', 'view', 'you/sketchbook', '--json', 'name']]);
  });

  it('refuses a name that is taken', async () => {
    const gh = recorded({ 'repo view you/sketchbook --json name': { stdout: '{"name":"sketchbook"}\n' } });

    expect(await repoNameProblem('you', 'sketchbook', gh.run, live())).toBe('github.com/you/sketchbook exists already. Pick another name, or add that repository by its URL.');
  });

  it('says so when gh cannot answer, rather than calling the name free', async () => {
    const gh = recorded({ 'repo view you/sketchbook --json name': { code: 1, stderr: 'error connecting to api.github.com\n' } });

    expect(await repoNameProblem('you', 'sketchbook', gh.run, live())).toBe('gh could not check the name on GitHub. error connecting to api.github.com');
  });

  it.each([['my sketches'], ['a/b'], ['.'], ['..'], ['x'.repeat(101)], ['']])('refuses %j without asking gh', async (name) => {
    const gh = recorded({});

    expect(await repoNameProblem('you', name, gh.run, live())).toMatch(/cannot be a repository name on GitHub/);
    expect(gh.calls).toEqual([]);
  });

  it('refuses an owner that would read as a flag', async () => {
    const gh = recorded({});

    expect(await repoNameProblem('--public', 'sketchbook', gh.run, live())).toBe('"--public" is not a GitHub account name.');
    expect(gh.calls).toEqual([]);
  });
});

describe('createPrivateRepo', () => {
  // A gh that does what `repo create --source --push` does to its source: adds origin in the protocol
  // the person picked, and answers with the repository's page.
  const creating = (url: string) => (args: readonly string[]): Answer => {
    const source = args[args.indexOf('--source') + 1] ?? '';
    writeFileSync(join(source, '.git', 'gh-was-here'), '');
    const config = join(source, '.git', 'config');
    writeFileSync(config, `${readFileSync(config, 'utf8')}[remote "origin"]\n\turl = ${url}\n`);
    return { stdout: 'https://github.com/you/sketchbook\n' };
  };
  const ARGS = (source: string) => `repo create you/sketchbook --private --source ${source} --remote origin --push`;

  it('asks for a private repository from the folder and pushes it, and never a public one', async () => {
    const source = repo();
    source.write('README.md', '# sketchbook\n');
    source.commit('first');
    const gh = recorded({ [ARGS(source.dir)]: creating('https://github.com/you/sketchbook.git') });

    expect(await createPrivateRepo(source.dir, 'you', 'sketchbook', source.env, gh.run, live())).toEqual({ ok: true, url: 'https://github.com/you/sketchbook.git' });
    expect(gh.calls).toEqual([['repo', 'create', 'you/sketchbook', '--private', '--source', source.dir, '--remote', 'origin', '--push']]);
    expect(gh.calls.flat()).not.toContain('--public');
  });

  // gh writes the remote in the protocol picked at gh auth login. That is the one git can clone with.
  it('clones from the remote gh wrote, so an ssh login clones over ssh', async () => {
    const source = repo();
    source.write('README.md', '# sketchbook\n');
    source.commit('first');
    const gh = recorded({ [ARGS(source.dir)]: creating('git@github.com:you/sketchbook.git') });

    expect(await createPrivateRepo(source.dir, 'you', 'sketchbook', source.env, gh.run, live())).toEqual({ ok: true, url: 'git@github.com:you/sketchbook.git' });
  });

  it('names the repository and gh reason when gh fails', async () => {
    const source = repo();
    const gh = recorded({ [ARGS(source.dir)]: { code: 1, stderr: 'HTTP 422: Name already exists on this account\n' } });

    expect(await createPrivateRepo(source.dir, 'you', 'sketchbook', source.env, gh.run, live())).toEqual({
      ok: false,
      reason: 'gh could not make github.com/you/sketchbook or push to it. HTTP 422: Name already exists on this account',
    });
  });
});

describe('copyToPush', () => {
  it('copies the branch the person is on with its history, and no remote and no other branch', async () => {
    const own = repo();
    own.write('a.txt', 'one\n');
    own.commit('one');
    own.run('branch', 'idea');
    own.write('a.txt', 'two\n');
    own.commit('two');
    const to = join(folder(), 'sketchbook');

    expect(await copyToPush(own.dir, to, own.env)).toEqual({ ok: true, branch: 'main' });
    const copy = (...args: string[]) => own.run('-C', to, ...args).trim();
    expect(copy('log', '--format=%s')).toBe('two\none');
    expect(copy('branch', '--all', '--format=%(refname)')).toBe('refs/heads/main');
    expect(copy('remote')).toBe('');
  });

  it('refuses a repository with no commit yet', async () => {
    const own = repo();
    const to = join(folder(), 'sketchbook');

    expect(await copyToPush(own.dir, to, own.env)).toEqual({ ok: false, reason: 'repo has no commit yet, so there is nothing to put on GitHub. Make a first commit in it, then try again.' });
  });

  it('refuses a repository on no branch', async () => {
    const own = repo();
    own.write('a.txt', 'one\n');
    own.commit('one');
    own.write('a.txt', 'two\n');
    own.commit('two');
    // At an older commit: on the tip of main, git's clone would pick main for it.
    own.run('checkout', '-q', '--detach', 'HEAD~1');
    const to = join(folder(), 'sketchbook');

    expect(await copyToPush(own.dir, to, own.env)).toEqual({ ok: false, reason: 'repo is on no branch, so Nolzu cannot tell what to push. Check out a branch in it, then try again.' });
  });
});

describe('firstCommit', () => {
  it('starts a repository on main with one commit that holds the readme', async () => {
    const env = repo().env;
    const to = join(folder(), 'meal-planner');

    expect(await firstCommit(to, '# meal-planner\n\nA meal planner.\n', env)).toBeNull();
    expect(readFileSync(join(to, 'README.md'), 'utf8')).toBe('# meal-planner\n\nA meal planner.\n');
    const log = execFileSync('git', ['-C', to, 'log', '--format=%D %s'], { env, encoding: 'utf8' });
    expect(log.trim()).toBe('HEAD -> main chore: first commit');
  });

  it('says why when git cannot commit, and makes nothing when the folder is there', async () => {
    const env = repo().env;
    const to = folder();

    expect(await firstCommit(to, '# x\n', env)).toMatch(/^Nolzu could not make the folder /);
    expect(existsSync(join(to, '.git'))).toBe(false);
  });
});
