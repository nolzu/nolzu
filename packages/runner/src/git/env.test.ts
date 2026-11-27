import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tempRepo } from '../../test/temp-repo.ts';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';

it('stops git from asking for a credential, so a missing one fails instead of hanging', () => {
  expect(gitEnv({ PATH: '/usr/bin' }).GIT_TERMINAL_PROMPT).toBe('0');
});

it('reads without taking the index lock, so a status cannot block a running agent', () => {
  expect(gitEnv({ PATH: '/usr/bin' }).GIT_OPTIONAL_LOCKS).toBe('0');
});

it('keeps the environment it was given', () => {
  const env = gitEnv({ PATH: '/usr/bin', HOME: '/home/dev', SHELL: '/bin/zsh' });
  expect(env.PATH).toBe('/usr/bin');
  expect(env.HOME).toBe('/home/dev');
  expect(env.SHELL).toBe('/bin/zsh');
});

it('points the config files where the caller says, so a test repo reads no real config', () => {
  const env = gitEnv({ PATH: '/usr/bin' }, { configGlobal: '/tmp/empty-global', configSystem: '/tmp/empty-system' });
  expect(env.GIT_CONFIG_GLOBAL).toBe('/tmp/empty-global');
  expect(env.GIT_CONFIG_SYSTEM).toBe('/tmp/empty-system');
});

it('leaves the config files alone when the caller names none, so a real run uses the user config', () => {
  const env = gitEnv({ PATH: '/usr/bin' });
  expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  expect(env.GIT_CONFIG_SYSTEM).toBeUndefined();
});

it('drops an undefined value, because spawn refuses one', () => {
  const env = gitEnv({ PATH: '/usr/bin', EMPTY: undefined });
  expect('EMPTY' in env).toBe(false);
});

// One of these in the environment makes git answer about that repository whatever folder it is
// asked about, so every caller that goes through here is covered at once.
it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE'])(
  'drops %s, so git answers about the folder it was asked about',
  (name) => {
    const env = gitEnv({ PATH: '/usr/bin', [name]: '/somewhere/else/.git' });

    expect(name in env).toBe(false);
  },
);

it.each([
  ['GIT_NAMESPACE', 'so git reads and writes the refs of the repository, not those under another name space'],
  ['GIT_EXEC_PATH', "so git runs its own programs, not ones from another folder"],
  ['GIT_TRACE', 'so git writes no trace to a file it names'],
  ['GIT_TRACE2', 'so git writes no trace to a file it names'],
  ['GIT_TRACE2_EVENT', 'so git writes no trace to a file it names'],
  ['GIT_TRACE2_PERF', 'so git writes no trace to a file it names'],
  ['GIT_TRACE_PACKET', 'so git writes no trace to a file it names'],
  ['GIT_TRACE_PERFORMANCE', 'so git writes no trace to a file it names'],
  ['GIT_TRACE_SETUP', 'so git writes no trace to a file it names'],
  ['GIT_TRACE_CURL', 'so git writes no trace to a file it names'],
])('drops %s, %s', (name) => {
  expect(name in gitEnv({ PATH: '/usr/bin', [name]: '/somewhere/else' })).toBe(false);
});

// Config handed to git through the environment lasts one run and beats the repository's own. One of
// these can turn a plain push into a force, or send it to a URL nobody named.
it.each(['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_12'])(
  'drops %s, so an inherited config cannot change what git does',
  (name) => {
    expect(name in gitEnv({ PATH: '/usr/bin', [name]: 'push.default=matching' })).toBe(false);
  },
);

it('keeps the config files the caller pointed at, which are not injected config', () => {
  const env = gitEnv({ PATH: '/usr/bin' }, { configGlobal: '/tmp/empty-global' });

  expect(env.GIT_CONFIG_GLOBAL).toBe('/tmp/empty-global');
});

// The same with real git: a shared git folder or an object folder named in the environment steers
// git into another repository, and through gitEnv it does not.
it('keeps git in the folder it was asked about when the environment names another git folder or object folder', async () => {
  const mine = tempRepo('nolzu-env-mine-');
  const other = tempRepo('nolzu-env-other-');
  try {
    other.write('a.txt', 'only in the other repository\n');
    other.commit('first');
    const sha = other.run('rev-parse', 'HEAD').trim();
    const otherGit = join(realpathSync(other.dir), '.git');
    const steered = { ...mine.env, GIT_COMMON_DIR: otherGit, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(otherGit, 'objects') };
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: mine.dir, env: gitEnv(steered) });
    expect(common.stdout.trim()).toBe(join(realpathSync(mine.dir), '.git'));
    const seen = await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: mine.dir, env: gitEnv({ ...mine.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(otherGit, 'objects') }) });
    expect(seen.code).not.toBe(0);
  } finally {
    mine.remove();
    other.remove();
  }
});

it("keeps the person's own ssh command, askpass, editor and pager", () => {
  const own = { GIT_SSH: '/bin/ssh', GIT_SSH_COMMAND: 'ssh -i key', GIT_ASKPASS: '/bin/ask', GIT_EDITOR: 'vi', GIT_PAGER: 'less' };
  expect(gitEnv({ PATH: '/usr/bin', ...own })).toMatchObject(own);
});

it('writes no trace file a GIT_TRACE variable names', async () => {
  const mine = tempRepo('nolzu-env-trace-');
  try {
    const trace = join(mine.dir, '..', 'trace.log');
    const said = await git(['status', '--porcelain'], { cwd: mine.dir, env: gitEnv({ ...mine.env, GIT_TRACE: trace, GIT_TRACE2_EVENT: trace }) });
    expect(said.code).toBe(0);
    expect(existsSync(trace)).toBe(false);
  } finally {
    mine.remove();
  }
});
