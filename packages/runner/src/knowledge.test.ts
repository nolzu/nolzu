import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { git as realGit, type GitResult } from './git/exec.ts';
import { checkKnowledgeDir, ignoredRepoFolders, insideProject, isolated, knowledgeGit, sweptAfter } from './knowledge.ts';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const answer = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
// `check-ignore` exits 1 for a folder git does not ignore, which is the normal case, so the fakes
// answer by the command and not by one canned result for every call.
const notIgnored: GitResult = { code: 1, stdout: '', stderr: '' };
const git = (insideWorkTree: string) => (args: readonly string[]) =>
  Promise.resolve(args[0] === 'check-ignore' ? notIgnored : answer(insideWorkTree));
const inRepo = git('true');
const notInRepo = git('false');
// git answers non-zero outside a repository on some versions, so the failing shape is covered too.
const gitRefused = () => Promise.resolve({ code: 128, stdout: '', stderr: 'not a git repository' });
const ignoredByGit = (args: readonly string[]) =>
  Promise.resolve(args[0] === 'check-ignore' ? answer('') : answer('true'));

const make = (...parts: string[]): string => {
  const path = join(project, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};

describe('checkKnowledgeDir', () => {
  it('takes a folder that exists inside a repository', async () => {
    const folder = make('.nolzu', 'knowledge');

    expect(await checkKnowledgeDir(folder, { projectPath: project, run: inRepo })).toEqual({
      ok: true,
      problem: null,
      reason: null,
    });
  });

  // Both shapes git uses to say no, because one version answers `false` and another exits 128.
  it('refuses a folder in no repository, however git says so', async () => {
    const folder = make('elsewhere');

    for (const run of [notInRepo, gitRefused]) {
      const checked = await checkKnowledgeDir(folder, { projectPath: project, run });
      expect(checked.problem).toBe('no-repository');
      expect(checked.reason).toContain('git repository');
    }
  });

  // The two that are about the project's own layout. A folder under worktrees belongs to one
  // card's branch and goes when the card closes, taking every knowledge file with it.
  it('refuses a folder inside worktrees', async () => {
    const folder = make('worktrees', 'APP-1', 'knowledge');

    const checked = await checkKnowledgeDir(folder, { projectPath: project, run: inRepo });

    expect(checked.problem).toBe('inside-worktrees');
    expect(checked.ok).toBe(false);
  });

  // The sweep after a knowledge run deletes each new `.git` in the folder. Over the project that
  // would be another card's new checkout or a new clone.
  it('refuses the project folder, a folder above it, and a link to it', async () => {
    const inside = make('code', 'recipes');
    const link = join(project, 'shortcut');
    symlinkSync(inside, link);

    for (const folder of [inside, join(project, 'code'), project, link]) {
      expect((await checkKnowledgeDir(folder, { projectPath: inside, run: inRepo })).problem).toBe('holds-project');
    }
    expect((await checkKnowledgeDir(make('code', 'recipes', '.nolzu', 'knowledge'), { projectPath: link, run: inRepo })).ok).toBe(true);
  });

  it('refuses a folder inside .tasks, which belongs to one card', async () => {
    const folder = make('.tasks', 'APP-1', 'knowledge');

    expect((await checkKnowledgeDir(folder, { projectPath: project, run: inRepo })).problem).toBe('inside-tasks');
  });

  // The separator, which is the bug a `startsWith` without it has.
  it('takes a sibling folder whose name only starts the same way', async () => {
    const folder = make('worktrees-archive');

    expect((await checkKnowledgeDir(folder, { projectPath: project, run: inRepo })).ok).toBe(true);
  });

  it('refuses a path that is not there, and one that is a file', async () => {
    const missing = join(project, 'nowhere');
    const file = join(project, 'notes.md');
    writeFileSync(file, 'hello\n');

    expect((await checkKnowledgeDir(missing, { projectPath: project, run: inRepo })).problem).toBe('missing');
    expect((await checkKnowledgeDir(file, { projectPath: project, run: inRepo })).problem).toBe('not-a-folder');
  });

  it('refuses a relative path, which means something else to every process that reads it', async () => {
    expect((await checkKnowledgeDir('.nolzu/knowledge', { projectPath: project, run: inRepo })).problem).toBe(
      'not-absolute',
    );
  });

  // A folder in .gitignore takes no commit, and git's status never lists what is in it, so a
  // wrap-up there would write knowledge nobody could ever commit or see.
  it('refuses a folder git ignores', async () => {
    const folder = make('.nolzu', 'knowledge');

    const checked = await checkKnowledgeDir(folder, { projectPath: project, run: ignoredByGit });

    expect(checked.problem).toBe('ignored');
    expect(checked.reason).toContain('.gitignore');
  });

  // A .gitignore line such as `api/` with no leading slash matches the api folder in the knowledge
  // folder too, so a note written there could never be committed or seen in git status.
  it('refuses a repository folder of the knowledge folder that git ignores, and names the line', async () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q', project], { env });
    writeFileSync(join(project, '.gitignore'), 'api/\n/web/\n');
    const folder = make('.nolzu', 'knowledge');
    const run = (args: readonly string[]) => realGit(args, { cwd: folder, env });

    const checked = await checkKnowledgeDir(folder, { projectPath: project, run, repos: ['.', 'api', 'web'] });
    expect(checked).toEqual({
      ok: false,
      problem: 'repo-ignored',
      reason: 'git ignores api/ in the knowledge folder, through the .gitignore line api/, so nothing written there can be committed. Start each with a slash, such as /api/, so it holds only the folder at the top of the project.',
    });
    // Anchored, the line holds only the folder at the top of the project.
    writeFileSync(join(project, '.gitignore'), '/api/\n/web/\n');
    expect(await ignoredRepoFolders(run, ['api', 'web'])).toBeNull();
    expect((await checkKnowledgeDir(folder, { projectPath: project, run, repos: ['api', 'web'] })).ok).toBe(true);
  });

  // The other path of the projectPath branch: with no project set, the layout rules cannot be
  // asked and the git rule still holds.
  it('checks the repository even when no project is set', async () => {
    const folder = make('.nolzu', 'knowledge');

    expect((await checkKnowledgeDir(folder, { projectPath: null, run: inRepo })).ok).toBe(true);
    expect((await checkKnowledgeDir(folder, { projectPath: null, run: notInRepo })).problem).toBe('no-repository');
  });
});

describe('isolated', () => {
  // Strict isolation, in both directions. One project's knowledge folder holding another's, or
  // sitting inside it, is the same mistake seen from either end.
  it('is false when one folder holds the other, whichever way round', () => {
    expect(isolated('/p/one/knowledge', ['/p/two/knowledge'])).toBe(true);
    expect(isolated('/p/one/knowledge', ['/p/one'])).toBe(false);
    expect(isolated('/p/one', ['/p/one/knowledge'])).toBe(false);
    expect(isolated('/p/one/knowledge', ['/p/one/knowledge'])).toBe(false);
  });

  it('is true against a name that only starts the same way', () => {
    expect(isolated('/p/one-archive', ['/p/one'])).toBe(true);
  });

  it('is true when there is nothing else, which is the free client', () => {
    expect(isolated('/p/one/knowledge', [])).toBe(true);
  });
});

describe('insideProject', () => {
  it('reads a folder in the project as its short path', () => {
    expect(insideProject('/p/.nolzu/knowledge', '/p')).toBe(join('.nolzu', 'knowledge'));
  });

  // A string of `..` names nothing a person can act on, so a folder outside stays absolute.
  it('keeps a folder outside the project absolute', () => {
    expect(insideProject('/elsewhere/knowledge', '/p')).toBe('/elsewhere/knowledge');
    expect(insideProject('/p', '/p')).toBe('/p');
  });
});

// A run that may write the knowledge folder can make a repository there, with a filter in its own
// config. git run in the folder after the run would use that repository and run the filter here.
describe('knowledgeGit', () => {
  it('stays on the repository the folder was in, so a repository the run made there is never used', async () => {
    const env = { PATH: process.env.PATH ?? '', HOME: project, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    run(project, 'init', '-q', '-b', 'main');
    const folder = make('.nolzu', 'knowledge');
    writeFileSync(join(folder, 'notes.md'), 'one\n');
    run(project, 'add', '.');
    run(project, 'commit', '-q', '-m', 'one');
    const held = await knowledgeGit(folder, env);

    const marker = join(project, 'filter-ran');
    run(folder, 'init', '-q', '-b', 'main');
    run(folder, 'add', 'notes.md');
    run(folder, 'config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(folder, '.git', 'info', 'attributes'), '* filter=x\n');
    utimesSync(join(folder, 'notes.md'), new Date('2020-01-01'), new Date('2020-01-01'));
    writeFileSync(join(folder, 'new.md'), 'two\n');

    const status = await held.run(['status', '--porcelain', '-uall', '--', '.']);

    expect(existsSync(marker)).toBe(false);
    expect(status.stdout).toContain('new.md');
    expect((await held.run(['rev-parse', '--show-toplevel'])).stdout.trim()).toBe(run(project, 'rev-parse', '--show-toplevel').trim());
    // After the run it goes, so no later git in the folder finds it either.
    expect(held.sweep()).toBe(true);
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });

  it('removes a repository the run made further down the folder too', async () => {
    const env = { PATH: process.env.PATH ?? '', HOME: project, GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });
    const folder = make('.nolzu', 'knowledge');
    const held = await knowledgeGit(folder, env);
    const deep = make('.nolzu', 'knowledge', 'tips', 'more');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: deep, env });
    writeFileSync(join(deep, 'note.md'), 'kept\n');

    expect(held.sweep()).toBe(true);
    expect(existsSync(join(deep, '.git'))).toBe(false);
    expect(existsSync(join(deep, 'note.md'))).toBe(true);
    expect(existsSync(join(project, '.git'))).toBe(true);
  });

  // A knowledge folder inside a linked worktree: git finds the shared git folder through the worktree's
  // `commondir` file. A run that points it at a folder of its own, with a filter in its config, gets
  // nothing run: the shared folder is pinned from before the run.
  it('stays on the shared git folder it found, when a run repoints a worktree at another', async () => {
    const env = { PATH: process.env.PATH ?? '', HOME: project, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    const main = make('main');
    run(main, 'init', '-q', '-b', 'main');
    mkdirSync(join(main, 'knowledge'));
    writeFileSync(join(main, 'knowledge', 'notes.md'), 'one\n');
    run(main, 'add', '.');
    run(main, 'commit', '-q', '-m', 'one');
    const tree = join(project, 'tree');
    run(main, 'worktree', 'add', '-q', '-b', 'side', tree);
    const folder = join(tree, 'knowledge');
    const held = await knowledgeGit(folder, env);

    const marker = join(project, 'filter-ran');
    const admin = join(main, '.git', 'worktrees', 'tree');
    const evil = make('evil');
    mkdirSync(join(evil, 'info'));
    symlinkSync(join(main, '.git', 'objects'), join(evil, 'objects'));
    symlinkSync(join(main, '.git', 'refs'), join(evil, 'refs'));
    writeFileSync(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n`);
    writeFileSync(join(evil, 'info', 'attributes'), '* filter=x\n');
    writeFileSync(join(admin, 'commondir'), `${evil}\n`);
    utimesSync(join(folder, 'notes.md'), new Date('2020-01-01'), new Date('2020-01-01'));

    await held.run(['status', '--porcelain', '--', '.']);

    expect(existsSync(marker)).toBe(false);
  });

  it('sweeps once the events end, also when they throw or the caller stops early', async () => {
    let swept = 0;
    const sweep = () => {
      swept += 1;
    };
    async function* throwing() {
      yield 1;
      throw new Error('the run broke');
    }
    await expect(
      (async () => {
        for await (const _ of sweptAfter(throwing(), sweep)) void _;
      })(),
    ).rejects.toThrow('the run broke');
    expect(swept).toBe(1);
    await expect(
      (async () => {
        for await (const event of sweptAfter(throwing(), sweep)) throw new Error(`the caller broke at ${event}`);
      })(),
    ).rejects.toThrow('the caller broke at 1');
    expect(swept).toBe(2);
  });

  it('never removes a repository the folder was before the run', async () => {
    const env = { PATH: process.env.PATH ?? '', HOME: project, GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });

    expect((await knowledgeGit(project, env)).sweep()).toBe(false);
    expect(existsSync(join(project, '.git'))).toBe(true);
  });
});
