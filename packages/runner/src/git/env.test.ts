import { expect, it } from 'vitest';
import { gitEnv } from './env.ts';

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
it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'])(
  'drops %s, so git answers about the folder it was asked about',
  (name) => {
    const env = gitEnv({ PATH: '/usr/bin', [name]: '/somewhere/else/.git' });

    expect(name in env).toBe(false);
  },
);

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
