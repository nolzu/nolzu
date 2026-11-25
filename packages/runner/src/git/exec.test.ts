import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { cloneInto } from './clone-into.ts';
import { commitAt, exitCode, git, gitBinary } from './exec.ts';

let repo: TempRepo;

beforeEach(() => {
  repo = tempRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('first');
});

afterEach(() => {
  repo.remove();
});

it('returns the output of a call that works', async () => {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd: repo.dir, env: repo.env });
  expect(result.code).toBe(0);
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(result.stderr).toBe('');
});

it('returns the exit code and gitstderr instead of throwing, because git reports normal states that way', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-not-a-repo-'));
  try {
    const result = await git(['rev-parse', '--show-toplevel'], { cwd: outside, env: repo.env });
    // Nothing to commit and a non fast forward push are normal answers that also exit non zero.
    // A helper that threw here would turn every one of them into a crash.
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('returns a large blob whole, not cut at a buffer limit', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  repo.write('big.txt', big);
  repo.commit('add a big file');

  const result = await git(['show', 'HEAD:big.txt'], { cwd: repo.dir, env: repo.env });
  expect(result.code).toBe(0);
  expect(result.stdout.length).toBeGreaterThanOrEqual(big.length);
});

it('ends when the signal aborts and leaves no child behind', async () => {
  const controller = new AbortController();
  const running = git(['rev-parse', '--show-toplevel'], { cwd: repo.dir, env: repo.env, signal: controller.signal });
  controller.abort();
  await expect(running).rejects.toThrow();
});

it('refuses an already aborted signal before it spawns anything', async () => {
  await expect(
    git(['status'], { cwd: repo.dir, env: repo.env, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});

it('names git and the fix when the binary is not on the path', async () => {
  // An empty PATH is what a process started outside a login shell can look like on macOS.
  await expect(git(['status'], { cwd: repo.dir, env: { PATH: '' } })).rejects.toThrow(/git/i);
});

it('does not report a killed child as a clean run', () => {
  // `code ?? 0` read a child that was killed as an exit code of zero, so a caller took empty
  // output for a real answer. The cleanup then read an unreadable worktree list as "nobody owns
  // this", which is the most destructive reading there is.
  const killed = { code: null, signal: 'SIGKILL' as const };

  expect(exitCode(killed.code, killed.signal)).not.toBe(0);
  expect(exitCode(0, null)).toBe(0);
  expect(exitCode(3, null)).toBe(3);
});

it('stops reading once stdout passes the cap it was given', async () => {
  const made = tempRepo('nolzu-exec-cap-');
  try {
    made.write('big.txt', 'x'.repeat(200_000));
    made.commit('a big file');

    const capped = await git(['show', 'HEAD:big.txt'], { cwd: made.dir, env: made.env, maxStdout: 1000 });

    // Without this the whole answer lands in memory first, so a cap on a patch protects nothing.
    expect(capped.stdout.length).toBeLessThan(100_000);
  } finally {
    made.remove();
  }
});

it('says the folder is gone rather than blaming the PATH', async () => {
  const made = tempRepo('nolzu-exec-gone-');
  const gone = join(made.dir, 'no-such-folder');
  made.remove();

  // spawn reports a missing working folder with the same code as a missing binary. Telling a person
  // git is not installed, when it is, sends them after the wrong problem entirely.
  await expect(git(['status'], { cwd: gone, env: made.env })).rejects.toThrow(/is not there/);
});

it('reads the commit and date at a rev, and gives nothing for a folder that is no repository top', async () => {
  const head = (await git(['rev-parse', '--short', 'HEAD'], { cwd: repo.dir, env: repo.env })).stdout.trim();
  expect(commitAt(repo.dir, repo.env)).toEqual({ sha: head, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(commitAt(repo.dir, repo.env, 'no-such-branch')).toBeNull();
  // Inside the repository but not its top: git would answer for the repository above.
  expect(commitAt(join(repo.dir, 'src'), repo.env)).toBeNull();
  expect(commitAt(join(repo.dir, 'not-there'), repo.env)).toBeNull();
});

it('never runs an fsmonitor command a repository config names', async () => {
  const marker = join(repo.dir, '..', 'fsmonitor-ran');
  repo.run('config', 'core.fsmonitor', `touch ${marker}; false`);
  await git(['status', '--porcelain'], { cwd: repo.dir, env: repo.env });
  commitAt(repo.dir, repo.env);
  expect(existsSync(marker)).toBe(false);
});

// A writable run may write the checkout's index and any folder in it. This one made a repository two
// folders down, named a filter in that repository's own config, and staged the folder as a pointer.
it('never runs a filter planted in a nested repository, on status, diff or add', async () => {
  const marker = join(repo.dir, '..', 'filter-ran');
  const sub = join(repo.dir, 'a', 'b', 'sub');
  mkdirSync(sub, { recursive: true });
  const inSub = (...args: string[]) => execFileSync('git', args, { cwd: sub, env: repo.env });
  inSub('init', '-q', '-b', 'main');
  writeFileSync(join(sub, 'f.txt'), 'x\n');
  inSub('add', 'f.txt');
  inSub('commit', '-q', '-m', 'sub');
  inSub('config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`);
  writeFileSync(join(sub, '.git', 'info', 'attributes'), '* filter=x\n');
  // Same size, other time: git has to read the file through the filter to see whether it changed.
  utimesSync(join(sub, 'f.txt'), new Date('2020-01-01'), new Date('2020-01-01'));
  repo.run('add', 'a/b/sub');
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.write('a/new.txt', 'new\n');
  // Its own `.gitmodules` beats a `diff.ignoreSubmodules` setting.
  repo.write('.gitmodules', '[submodule "x"]\n\tpath = a/b/sub\n\turl = ./x\n\tignore = none\n');

  const calls = [['status', '--porcelain'], ['-C', 'a', 'status', '--porcelain'], ['diff', 'HEAD'], ['diff'], ['add', '-u'], ['add', '--', ':(literal)a/'], ['add', '--', ':(literal)a/b/sub']];
  for (const args of calls) {
    utimesSync(join(sub, 'f.txt'), new Date('2020-01-01'), new Date('2020-01-01'));
    await git(args, { cwd: repo.dir, env: repo.env });
  }

  expect(existsSync(marker)).toBe(false);
  // Everything else was still staged.
  expect(repo.run('diff', '--cached', '--name-only').trim().split('\n')).toEqual(['a/b/sub', 'a/new.txt', 'src/a.ts']);
});

// A folder holding HEAD, objects and refs is a repository with no .git name, so the checks for a .git
// never see it. git refuses to use one Nolzu did not name.
it('never runs a filter planted in a repository with no .git name', async () => {
  const marker = join(repo.dir, '..', 'bare-filter-ran');
  const folder = join(repo.dir, 'notes');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'a.md'), 'x\n');
  const plain = { ...repo.env, GIT_DIR: folder, GIT_WORK_TREE: folder };
  execFileSync('git', ['init', '-q', '--bare', folder], { env: repo.env });
  execFileSync('git', ['config', 'core.bare', 'false'], { env: plain });
  execFileSync('git', ['config', 'core.worktree', folder], { env: plain });
  execFileSync('git', ['add', 'a.md'], { cwd: folder, env: plain });
  execFileSync('git', ['config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`], { env: plain });
  writeFileSync(join(folder, 'info', 'attributes'), '* filter=x\n');
  utimesSync(join(folder, 'a.md'), new Date('2020-01-01'), new Date('2020-01-01'));

  const status = await git(['status', '--porcelain'], { cwd: folder, env: repo.env });

  expect(existsSync(marker)).toBe(false);
  expect(status.stderr).toContain('cannot use bare repository');
});

// A textconv or a diff driver is a command the person's own config can name, keyed by a path pattern in
// `.gitattributes`, which a run can write. Nolzu never runs one, on any command that prints a patch.
it('never runs a textconv or an external diff driver a config names', async () => {
  const marker = join(repo.dir, '..', 'driver-ran');
  repo.run('config', 'diff.json.textconv', `sh -c 'touch ${marker}; cat "$0"'`);
  repo.run('config', 'diff.ext.command', `sh -c 'touch ${marker}'`);
  repo.write('.gitattributes', '*.json diff=json\n*.txt diff=ext\n');
  repo.write('data.json', '{"a":1}\n');
  repo.write('notes.txt', 'one\n');
  repo.commit('data');
  repo.write('data.json', '{"a":2}\n');
  repo.write('notes.txt', 'two\n');
  // The drivers are live in plain git, so the test would see one run.
  execFileSync('git', ['diff', '--', 'data.json'], { cwd: repo.dir, env: repo.env });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);

  const calls = [['diff'], ['diff', 'HEAD'], ['diff', '--cached'], ['-C', '.', 'diff', 'HEAD~1', 'HEAD'], ['show', 'HEAD'], ['show', '--patch', 'HEAD'], ['log', '-p', '-1']];
  for (const args of calls) {
    const said = await git(args, { cwd: repo.dir, env: repo.env });
    expect(said.code).toBe(0);
  }

  expect(existsSync(marker)).toBe(false);
});

it('turns pushing into repositories inside the checkout off, whatever a config says', async () => {
  repo.run('config', 'push.recurseSubmodules', 'on-demand');
  expect((await git(['config', '--get', 'push.recurseSubmodules'], { cwd: repo.dir, env: repo.env })).stdout.trim()).toBe('no');
});

// `node_modules/.bin` on the PATH is relative, so it names a folder in whatever folder git starts in,
// which can be a checkout a run wrote. A git planted there never runs.
it('starts git from an absolute PATH entry only, never from a relative one', async () => {
  const marker = join(repo.dir, '..', 'planted-git-ran');
  const planted = join(repo.dir, 'node_modules', '.bin');
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(join(planted, 'git'), 0o755);
  for (const first of ['node_modules/.bin', '.', 'node_modules/../node_modules/.bin']) {
    const env = { ...repo.env, PATH: `${first}:${repo.env.PATH ?? ''}` };
    expect((await git(['rev-parse', '--show-toplevel'], { cwd: repo.dir, env })).code).toBe(0);
    expect(commitAt(repo.dir, env)).not.toBeNull();
  }
  writeFileSync(join(repo.dir, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(join(repo.dir, 'git'), 0o755);
  expect((await git(['status', '--porcelain'], { cwd: repo.dir, env: { ...repo.env, PATH: `.:${repo.env.PATH ?? ''}` } })).code).toBe(0);

  // The clone of a new repository starts git the same way.
  const workspace = join(repo.dir, '..', 'workspace');
  mkdirSync(join(workspace, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(workspace, 'node_modules', '.bin', 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(join(workspace, 'node_modules', '.bin', 'git'), 0o755);
  const cloned = await cloneInto({ workspace, url: repo.dir, name: 'copy', env: { ...repo.env, PATH: `node_modules/.bin:${repo.env.PATH ?? ''}` }, protocols: 'file' });

  expect(cloned.ok).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

it('finds git on an absolute PATH entry, and nothing on a PATH of relative entries only', () => {
  // A relative entry that does hold a git, from where Nolzu runs, is skipped too.
  const planted = join(repo.dir, 'bin');
  mkdirSync(planted);
  writeFileSync(join(planted, 'git'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(planted, 'git'), 0o755);
  const near = relative(process.cwd(), planted);
  expect(gitBinary(`${near}:${process.env.PATH ?? ''}`)).not.toBe(join(near, 'git'));
  expect(gitBinary(near)).toBeNull();
  expect(gitBinary(`node_modules/.bin:${process.env.PATH ?? ''}`)).toMatch(/^\/.*\/git$/);
  expect(gitBinary('node_modules/.bin:.')).toBeNull();
});
