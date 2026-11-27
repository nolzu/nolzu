import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { knowledgePlace } from '../knowledge.ts';
import { wallHere } from '../wall-detect.ts';
import { removeWorktree } from './cleanup.ts';
import { commitCard } from './commit.ts';
import { git, gitWrite } from './exec.ts';
import { closedGitPaths, CONFIG_WITH_HOOKS, gitWallSpec, HOOK_IN_WALL, linuxHolds, NO_PLACE } from './git-wall.ts';
import { cardPlace } from './places.ts';
import { ensureWorktree } from './worktree.ts';

// The checks before a write are turned off where a test asks, so what it proves is the wall's own
// refusal, and the wall where a test asks, so the same write shows what it does without one.
const off = vi.hoisted(() => ({ linkCheck: false, wall: false }));
vi.mock('./links.ts', async (actual) => {
  const real = await actual<typeof import('./links.ts')>();
  return { ...real, linkBeforeWrite: (...args: Parameters<typeof real.linkBeforeWrite>) => (off.linkCheck ? null : real.linkBeforeWrite(...args)) };
});
// The agent launch is watched: it must come before the call's own temp folder is made, so before the
// walled call starts.
const launches = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('./git-wall.ts', async (actual) => {
  const real = await actual<typeof import('./git-wall.ts')>();
  return { ...real, launchGpgAgent: (env: Record<string, string>) => launches.push(env.TMPDIR) };
});
vi.mock('../wall-detect.ts', async (actual) => {
  const real = await actual<typeof import('../wall-detect.ts')>();
  return { ...real, wallHere: () => (off.wall ? { ready: false, reason: 'turned off by the test' } : real.wallHere()) };
});

// Every folder here sits under the repository's ignored `.vitest` folder, not the system temp
// folder, so the wall sees what it sees in a real project.
const scratch = join(import.meta.dirname, '../../../../.vitest');
mkdirSync(scratch, { recursive: true });

const made: TempRepo[] = [];
const folders: string[] = [];
afterEach(() => {
  launches.splice(0);
  off.linkCheck = false;
  off.wall = false;
  for (const repo of made.splice(0)) repo.remove();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const repo = (): TempRepo => {
  const one = tempRepo('git-wall-', scratch);
  made.push(one);
  one.write('list.ts', 'export const list = [];\n');
  one.commit('first commit');
  return one;
};
const folder = (): string => {
  const at = realpathSync(mkdtempSync(join(scratch, 'git-wall-')));
  folders.push(at);
  return at;
};
const hook = (dir: string, name: string, body: string) => {
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.git', 'hooks', name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, '.git', 'hooks', name), 0o755);
};
const walls = wallHere().ready;
const here = { ready: true as const, binary: '/usr/bin/sandbox-exec' };

it.skipIf(!walls)("refuses a write through a link out of the repository in the wall itself, which the same write unwalled makes", async () => {
  const one = repo();
  const outside = folder();
  // `.git/logs` swapped for a link to a folder outside, as a run racing the check could leave it.
  rmSync(join(one.dir, '.git', 'logs'), { recursive: true });
  symlinkSync(outside, join(one.dir, '.git', 'logs'));
  off.linkCheck = true;
  const place = { project: one.dir, workTree: one.dir };

  await git(['commit', '-q', '--allow-empty', '-m', 'walled'], { cwd: one.dir, env: one.env, repo: place });
  expect(readdirSync(outside)).toEqual([]);

  off.wall = true;
  await git(['commit', '-q', '--allow-empty', '-m', 'unwalled'], { cwd: one.dir, env: one.env, repo: place });
  expect(readdirSync(outside)).toContain('HEAD');
});

it.skipIf(!walls)('runs a hook inside the wall, and says so when the wall refused its write', async () => {
  const one = repo();
  const outside = folder();
  hook(one.dir, 'pre-commit', `echo changed > '${join(outside, 'victim')}'`);
  one.write('more.ts', 'export const more = 1;\n');
  const place = { project: one.dir, workTree: one.dir };
  await git(['add', '--', 'more.ts'], { cwd: one.dir, env: one.env, repo: place });

  const said = await git(['commit', '-q', '-m', 'hooked'], { cwd: one.dir, env: one.env, repo: place, hooks: true });

  expect(said.code).not.toBe(0);
  expect(said.stderr).toContain(HOOK_IN_WALL);
  expect(existsSync(join(outside, 'victim'))).toBe(false);
});

// A ticked hook that runs a script a run planted in the card's checkout: it may not write the shared
// config (a `core.sshCommand` there would run at Nolzu's next fetch, which has no wall) nor plant a
// hook, nor point the checkout elsewhere.
it.skipIf(!walls)("keeps a ticked hook off the repository's config, hooks and pointers", async () => {
  const one = repo();
  const outside = folder();
  const card = join(one.dir, 'worktrees', 'APP-1');
  one.run('worktree', 'add', '-q', '-b', 'APP-1-work', card);
  hook(one.dir, 'pre-commit', 'sh ./precheck.sh');
  const common = join(realpathSync(one.dir), '.git');
  const own = join(common, 'worktrees', 'APP-1');
  writeFileSync(
    join(card, 'precheck.sh'),
    [
      `git config --file '${join(common, 'config')}' core.sshCommand 'touch ${outside}/ran'`,
      `printf '#!/bin/sh\\ntouch ${outside}/later\\n' > '${join(common, 'hooks', 'post-checkout')}'`,
      `echo '[core]' > '${join(common, 'config.worktree')}'`,
      `echo '* filter=x' > '${join(common, 'info', 'attributes')}'`,
      `echo /elsewhere > '${join(own, 'commondir')}'`,
      `echo 'gitdir: /elsewhere' > '${join(card, '.git')}'`,
      'exit 0',
    ].join('\n'),
  );
  const config = readFileSync(join(common, 'config'), 'utf8');

  const said = await git(['commit', '-q', '--allow-empty', '-m', 'hooked'], { cwd: card, env: one.env, repo: cardPlace(one.dir, 'APP-1'), hooks: true });

  expect(said.code).toBe(0);
  expect(readFileSync(join(common, 'config'), 'utf8')).toBe(config);
  expect(existsSync(join(common, 'hooks', 'post-checkout'))).toBe(false);
  expect(existsSync(join(common, 'config.worktree'))).toBe(false);
  expect(existsSync(join(common, 'info', 'attributes'))).toBe(false);
  expect(readFileSync(join(own, 'commondir'), 'utf8').trim()).toBe('../..');
  expect(readFileSync(join(card, '.git'), 'utf8')).toContain(own);
});

it('never runs hooks on a command that writes the config', async () => {
  const one = repo();
  const place = { project: one.dir, workTree: one.dir };
  for (const args of [['config', 'core.x', 'y'], ['remote', 'add', 'o', 'u'], ['branch', '-D', 'x'], ['worktree', 'add', 'w']]) {
    await expect(gitWrite(args, { cwd: one.dir, env: one.env, repo: place, hooks: true }, here)).rejects.toThrow(CONFIG_WITH_HOOKS);
  }
  vi.stubEnv('VITEST', undefined);
  try {
    expect(await git(['config', 'core.x', 'y'], { cwd: one.dir, env: one.env, repo: place, hooks: true })).toEqual({ code: 128, stdout: '', stderr: CONFIG_WITH_HOOKS });
  } finally {
    vi.unstubAllEnvs();
  }
  // Without hooks it writes the config, inside the wall.
  expect((await git(['config', 'core.x', 'y'], { cwd: one.dir, env: one.env, repo: place })).code).toBe(0);
  expect(one.run('config', '--get', 'core.x').trim()).toBe('y');
});

// A card on two repositories, started, committed and removed inside the wall, outside the temp folder.
it('starts, commits in and removes a card on two repositories', async () => {
  const root = repo();
  const project = root.dir;
  for (const name of ['api', 'web']) {
    execFileSync('git', ['init', '-q', '-b', 'main', join(project, name)], { env: root.env });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', name], { cwd: join(project, name), env: root.env });
  }
  for (const name of ['api', 'web']) {
    const made = await ensureWorktree({ projectPath: project, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: name, env: root.env });
    expect(made).toEqual({ path: join(project, 'worktrees', 'APP-1', name), branch: 'APP-1-work', created: true });
  }
  const api = join(project, 'worktrees', 'APP-1', 'api');
  writeFileSync(join(api, 'new.ts'), 'export const x = 1;\n');
  expect(await commitCard({ worktreePath: api, repo: cardPlace(project, 'APP-1', 'api'), message: 'feat: x', include: ['new.ts'], env: root.env })).toMatchObject({ ok: true });
  for (const name of ['api', 'web']) {
    // `web` holds no commit of its own, so it goes unforced and git itself deletes the checkout.
    expect(await removeWorktree({ projectPath: project, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: name, force: name === 'api', env: root.env })).toMatchObject({ ok: true });
    expect(existsSync(join(project, 'worktrees', 'APP-1', name))).toBe(false);
  }
});

it('opens gpg\'s folder for a gpg signature only, and never its config files', async () => {
  const one = repo();
  const home = join(one.dir, '..', 'home');
  mkdirSync(join(home, '.gnupg'), { recursive: true });
  const env = { ...one.env, HOME: home };
  const place = { project: one.dir, workTree: one.dir };
  const gnupg = realpathSync(join(home, '.gnupg'));
  const spec = async (args: string[]) => {
    const prepared = await gitWrite(args, { cwd: one.dir, env, repo: place }, here);
    if (!('spec' in prepared) || prepared.spec === null) throw new Error('no wall');
    if (prepared.temp !== null) rmSync(prepared.temp, { recursive: true });
    return prepared.spec;
  };

  expect((await spec(['commit', '-m', 'x'])).writable).not.toContain(gnupg);
  one.run('config', 'commit.gpgsign', 'true');
  for (const format of ['', 'openpgp', 'x509']) {
    if (format !== '') one.run('config', 'gpg.format', format);
    const commit = await spec(['commit', '-m', 'x']);
    expect(commit.writable).toContain(gnupg);
    if (process.platform === 'darwin') expect(commit.writeDenied).toEqual(expect.arrayContaining([join(gnupg, '*.conf'), join(gnupg, '*.conf.*'), join(gnupg, '*.conf-*')]));
  }
  expect((await spec(['merge', 'main'])).writable).toContain(gnupg);
  // Only a commit and a merge sign, and an ssh signature needs no gpg folder.
  expect((await spec(['branch', 'other'])).writable).not.toContain(gnupg);
  one.run('config', 'gpg.format', 'ssh');
  expect((await spec(['commit', '-m', 'x'])).writable).not.toContain(gnupg);
});

it.skipIf(!walls)("keeps a hook of a signing repository off gpg's config files", async () => {
  const one = repo();
  const gnupg = folder();
  const env = { ...one.env, GNUPGHOME: gnupg };
  one.run('config', 'commit.gpgsign', 'true');
  // gpg also reads a config file named for its version.
  const confs = ['gpg-agent.conf', 'gpg.conf-2', 'gpg.conf-2.4', 'gpg-agent.conf-2', 'common.conf'];
  hook(one.dir, 'pre-commit', [...confs.map((name) => `echo 'agent-program /x' > '${join(gnupg, name)}'`), `echo s > '${join(gnupg, 'random_seed')}'`, 'exit 0'].join('\n'));
  const said = await git(['commit', '-q', '--allow-empty', '-m', 'signed'], { cwd: one.dir, env, repo: { project: one.dir, workTree: one.dir }, hooks: true });
  for (const name of confs) expect(existsSync(join(gnupg, name)), name).toBe(false);
  // The wall itself held them: nothing was left for the check after the call to remove.
  expect(said.stderr).not.toContain('appeared during');
  expect(existsSync(join(gnupg, 'random_seed'))).toBe(true);
});

it.skipIf(!walls)('gives each walled call a temp folder of its own, and no other temp folder', async () => {
  const one = repo();
  const shared = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-shared-')));
  folders.push(shared);
  const seen = join(one.dir, 'temp-seen');
  hook(one.dir, 'pre-commit', `echo "$TMPDIR" > '${seen}'; echo own > "$TMPDIR/own" && cat "$TMPDIR/own" >> '${seen}'; echo x > '${join(shared, 'x')}'; exit 0`);

  expect((await git(['commit', '-q', '--allow-empty', '-m', 'hooked'], { cwd: one.dir, env: one.env, repo: { project: one.dir, workTree: one.dir }, hooks: true })).code).toBe(0);

  const [temp, own] = readFileSync(seen, 'utf8').trim().split('\n');
  expect(own).toBe('own');
  expect(temp).toMatch(/nolzu-git-/);
  expect(existsSync(temp ?? '')).toBe(false);
  expect(existsSync(join(shared, 'x'))).toBe(false);
});

// The agent starts outside the wall, before the call's own temp folder is made, and only for a gpg
// signature.
it('starts the gpg agent outside the wall before a call that signs with gpg', async () => {
  const one = repo();
  const home = join(one.dir, '..', 'home');
  mkdirSync(join(home, '.gnupg'), { recursive: true });
  const env = { ...one.env, HOME: home, TMPDIR: '/given' };
  const prepare = async (args: string[]) => {
    const prepared = await gitWrite(args, { cwd: one.dir, env, repo: { project: one.dir, workTree: one.dir } }, here);
    if ('temp' in prepared && prepared.temp !== null) rmSync(prepared.temp, { recursive: true });
    return prepared;
  };
  await prepare(['commit', '-m', 'x']);
  expect(launches).toEqual([]);
  one.run('config', 'commit.gpgsign', 'true');
  const signed = await prepare(['commit', '-m', 'x']);
  expect(launches).toEqual(['/given']);
  expect('env' in signed && signed.env.TMPDIR).toMatch(/nolzu-git-/);
  one.run('config', 'gpg.format', 'ssh');
  await prepare(['commit', '-m', 'x']);
  expect(launches).toEqual(['/given']);
});

// What a hook may leave where the wall cannot hold a path that is not there yet, as on Linux, or where
// no wall starts: a `commondir` in the shared folder would lead Nolzu's later git to another config.
it('removes a commondir a hook left in the shared git folder, and marks the repository', async () => {
  const one = repo();
  off.wall = true;
  const common = join(realpathSync(one.dir), '.git');
  hook(one.dir, 'pre-commit', `echo /elsewhere > '${join(common, 'commondir')}'; exit 0`);
  const place = { project: one.dir, workTree: one.dir };

  const said = await git(['commit', '-q', '--allow-empty', '-m', 'hooked'], { cwd: one.dir, env: one.env, repo: place, hooks: true });

  expect(said).toMatchObject({ code: 128, stderr: expect.stringContaining(`${join(common, 'commondir')} appeared during Nolzu's git call`) });
  expect(existsSync(join(common, 'commondir'))).toBe(false);
  expect(await git(['branch', 'more'], { cwd: one.dir, env: one.env, repo: place })).toEqual({ code: 128, stdout: '', stderr: said.stderr });
  // So is a later network call that names the repository.
  expect(await git(['ls-remote', '--heads', 'origin'], { cwd: one.dir, env: one.env, repo: place })).toEqual({ code: 128, stdout: '', stderr: said.stderr });
});

it('closes the commondir and the attributes in the spec, and on Linux holds the info folder and empty config.worktree files', () => {
  const one = repo();
  const common = join(realpathSync(one.dir), '.git');
  const places = { workTree: realpathSync(one.dir), gitDir: common, commonDir: common };
  expect(closedGitPaths(places, false, 'darwin')).toEqual(expect.arrayContaining([join(common, 'commondir'), join(common, 'info', 'attributes'), join(common, 'config.worktree')]));
  const linux = closedGitPaths(places, false, 'linux');
  expect(linux).toEqual(expect.arrayContaining([join(common, 'commondir'), join(common, 'info'), join(common, 'config.worktree')]));
  rmSync(join(common, 'info'), { recursive: true, force: true });
  rmSync(join(common, 'hooks'), { recursive: true, force: true });
  linuxHolds(places, false);
  expect(existsSync(join(common, 'info'))).toBe(true);
  expect(existsSync(join(common, 'hooks'))).toBe(true);
  expect(readFileSync(join(common, 'config.worktree'), 'utf8')).toBe('');
  // An empty config.worktree turns nothing on.
  expect(one.run('config', '--list', '--show-origin')).not.toContain('config.worktree');
  // The Linux wall holds the folder and the file, which are there now.
  const spec = gitWallSpec({ writable: [places.workTree, common], closed: linux, temp: common }, 'linux');
  expect(spec.writeDenied).toEqual(expect.arrayContaining([join(common, 'info'), join(common, 'hooks'), join(common, 'config.worktree')]));
});

// A repository with no hooks folder, as `git init --template=` makes one: a ticked hook from
// `core.hooksPath` that plants `.git/hooks/pre-push` would have it run at a later push, outside the wall.
it('removes a hook a ticked hook planted in a shared hooks folder that was not there, and marks the repository', async () => {
  const one = repo();
  off.wall = true;
  const common = join(realpathSync(one.dir), '.git');
  rmSync(join(common, 'hooks'), { recursive: true, force: true });
  const own = join(one.dir, 'own-hooks');
  mkdirSync(own);
  writeFileSync(join(own, 'pre-commit'), `#!/bin/sh
mkdir -p '${join(common, 'hooks')}'; printf '#!/bin/sh\n' > '${join(common, 'hooks', 'pre-push')}'; exit 0
`);
  chmodSync(join(own, 'pre-commit'), 0o755);
  one.run('config', 'core.hooksPath', own);

  const said = await git(['commit', '-q', '--allow-empty', '-m', 'hooked'], { cwd: one.dir, env: one.env, repo: { project: one.dir, workTree: one.dir }, hooks: true });

  expect(said).toMatchObject({ code: 128, stderr: expect.stringContaining('appeared during Nolzu\'s git call') });
  expect(existsSync(join(common, 'hooks', 'pre-push'))).toBe(false);
  expect((await git(['branch', 'more'], { cwd: one.dir, env: one.env, repo: { project: one.dir, workTree: one.dir } })).stderr).toBe(said.stderr);
});

// Network git in a recorded repository is checked and pinned too: a `commondir` planted in its git
// folder, with a copy whose config names another remote, does not lead it there.
it('checks and pins network git in a recorded repository, so a planted commondir does not lead it', async () => {
  const one = repo();
  const mine = join(one.dir, '..', 'mine.git');
  const theirs = join(one.dir, '..', 'theirs.git');
  for (const [bare, branch] of [[mine, 'mine-only'], [theirs, 'theirs-only']] as const) {
    execFileSync('git', ['init', '-q', '--bare', bare], { env: one.env });
    one.run('push', '-q', bare, `HEAD:refs/heads/${branch}`);
  }
  one.run('remote', 'add', 'origin', mine);
  const evil = join(one.dir, 'evil');
  execFileSync('cp', ['-R', join(one.dir, '.git'), evil]);
  execFileSync('git', ['config', '--file', join(evil, 'config'), 'remote.origin.url', theirs], { env: one.env });
  writeFileSync(join(one.dir, '.git', 'commondir'), `${evil}\n`);
  // Unpinned, git follows the commondir to the other remote.
  expect((await git(['ls-remote', '--heads', 'origin'], { cwd: one.dir, env: one.env })).stdout).toContain('theirs-only');

  const said = await git(['ls-remote', '--heads', 'origin'], { cwd: one.dir, env: one.env, repo: { project: one.dir, workTree: one.dir } });

  expect(said).toEqual({ code: 128, stdout: '', stderr: expect.stringContaining('commondir leads git to another git folder') });
});

it('pins git to the checked repository, so a repository a run made in a folder below is not the one it writes', async () => {
  const one = repo();
  const sub = join(one.dir, 'sub');
  mkdirSync(sub);
  execFileSync('git', ['init', '-q', '-b', 'main', sub], { env: one.env });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'sub'], { cwd: sub, env: one.env });

  const said = await git(['commit', '-q', '--allow-empty', '-m', 'pinned'], { cwd: sub, env: one.env, repo: { project: one.dir, workTree: one.dir } });

  expect(said.code).toBe(0);
  expect(one.run('log', '-1', '--format=%s').trim()).toBe('pinned');
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: sub, env: one.env, encoding: 'utf8' }).trim()).toBe('sub');
});

it('refuses a write in a checkout whose places do not match the record, and every later write in that repository', async () => {
  const one = repo();
  const other = repo();
  const card = join(one.dir, 'worktrees', 'APP-1');
  one.run('worktree', 'add', '-q', '-b', 'APP-1-work', card);
  other.run('worktree', 'add', '-q', '-b', 'x', join(other.dir, '..', 'other-card'));
  const own = readFileSync(join(card, '.git'), 'utf8');
  // The checkout's .git now leads into another repository.
  writeFileSync(join(card, '.git'), `gitdir: ${join(realpathSync(other.dir), '.git', 'worktrees', 'other-card')}\n`);
  const place = { project: one.dir, workTree: card, commonDir: join(one.dir, '.git') };
  const commit = () => git(['commit', '-q', '--allow-empty', '-m', 'here'], { cwd: card, env: one.env, repo: place });

  const first = await commit();
  expect(first).toEqual({ code: 128, stdout: '', stderr: expect.stringContaining('Check the .git file in the work tree') });
  expect(other.run('log', '-1', '--format=%s', 'x').trim()).toBe('first commit');

  // Put right, the repository stays refused until Nolzu starts again.
  writeFileSync(join(card, '.git'), own);
  expect(await commit()).toEqual(first);
  expect(await git(['branch', 'more'], { cwd: one.dir, env: one.env, repo: { project: one.dir, workTree: one.dir } })).toEqual(first);
  expect(one.run('log', '-1', '--format=%s', 'APP-1-work').trim()).toBe('first commit');
});

// The record may name the project through a link, as a path a person typed can, while the compare
// after a read-only run names it as git does: both are the one repository.
it('marks a repository named through a link and by its real path as one', async () => {
  const one = repo();
  const card = join(one.dir, 'worktrees', 'APP-1');
  one.run('worktree', 'add', '-q', '-b', 'APP-1-work', card);
  const linked = join(folder(), 'project-link');
  symlinkSync(one.dir, linked);
  const own = readFileSync(join(card, '.git'), 'utf8');
  writeFileSync(join(card, '.git'), 'gitdir: /elsewhere\n');
  const first = await git(['commit', '-q', '--allow-empty', '-m', 'here'], { cwd: card, env: one.env, repo: cardPlace(linked, 'APP-1') });
  expect(first.code).toBe(128);
  writeFileSync(join(card, '.git'), own);
  expect(await git(['commit', '-q', '--allow-empty', '-m', 'here'], { cwd: card, env: one.env, repo: cardPlace(realpathSync(one.dir), 'APP-1') })).toEqual(first);
});

// The knowledge folder's repository as Nolzu found it first: a later answer that names another one,
// such as a repository a run made inside the folder, is refused.
it('refuses a write in a knowledge folder that git now finds in another repository', async () => {
  const one = repo();
  const knowledge = join(one.dir, '.nolzu', 'knowledge');
  mkdirSync(knowledge, { recursive: true });
  const top = realpathSync(one.dir);
  expect((await knowledgePlace(knowledge, one.env, top))?.refuse).toBeUndefined();
  execFileSync('git', ['init', '-q', knowledge], { env: one.env });
  const place = await knowledgePlace(knowledge, one.env, top);
  writeFileSync(join(knowledge, 'note.md'), 'x\n');
  const said = await git(['add', '--', 'note.md'], { cwd: knowledge, env: one.env, repo: place });
  expect(said).toEqual({ code: 128, stdout: '', stderr: expect.stringContaining(`not at ${top}, where Nolzu found it first`) });
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: knowledge, env: one.env, encoding: 'utf8' })).toBe('?? note.md\n');
});

it('throws on a write that names no repository in a test, and refuses it with a sentence otherwise', async () => {
  const one = repo();
  await expect(git(['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: one.dir, env: one.env })).rejects.toThrow(NO_PLACE);
  vi.stubEnv('VITEST', undefined);
  try {
    expect(await git(['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: one.dir, env: one.env })).toEqual({ code: 128, stdout: '', stderr: NO_PLACE });
  } finally {
    vi.unstubAllEnvs();
  }
  // A read names none.
  expect((await git(['log', '-1', '--format=%s'], { cwd: one.dir, env: one.env })).stdout.trim()).toBe('first commit');
});

it('runs git as before, unwalled, where no wall can start', async () => {
  const one = repo();
  off.wall = true;
  const prepared = await gitWrite(['commit', '-m', 'x'], { cwd: one.dir, env: one.env, repo: { project: one.dir, workTree: one.dir } });
  expect(prepared).toMatchObject({ spec: null, temp: null, env: { GIT_DIR: join(realpathSync(one.dir), '.git'), GIT_WORK_TREE: realpathSync(one.dir) } });
});
