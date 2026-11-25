import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineEnv, packageCaches } from './engine-env.ts';

const free = { readOnlyTaskDir: null };

// Each of these outranks the flag Nolzu passes, so one left in the person's shell would run the
// card on a model or an effort the card does not show.
it.each([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
])('drops %s, so the choice on the card is the one that runs', (name) => {
  expect(name in engineEnv({ PATH: '/usr/bin', [name]: 'opus' }, free)).toBe(false);
});

// CURSOR_API_KEY replaces the login and CURSOR_API_ENDPOINT sends the run to another server, so a
// value left in the person's shell would make the run something other than the card describes. Both
// go for every engine, not only the Cursor one: they mean nothing to the others, and one place to
// drop them is fewer than two.
it.each(['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'])('drops %s for every engine', (name) => {
  expect(name in engineEnv({ PATH: '/usr/bin', [name]: 'x' }, free)).toBe(false);
});

// A run could push, open a pull request or publish a package with any of these. Nolzu runs gh
// itself, outside the run, so no run needs one.
it.each(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'])('drops %s for every engine', (name) => {
  expect(name in engineEnv({ PATH: '/usr/bin', [name]: 'dummy' }, free)).toBe(false);
});

// Nolzu's own server address. The run has no use for it, and handing it over makes calling the
// local API, which has no token yet, one step easier.
it.each(['ORIGIN', 'PORT', 'HOST'])('drops %s, the address of Nolzu itself', (name) => {
  expect(name in engineEnv({ PATH: '/usr/bin', [name]: 'x' }, free)).toBe(false);
});

// The family grows with the engine, and a name added later must not need a change here.
it.each(['ANTHROPIC_DEFAULT_NEXT_MODEL', 'ANTHROPIC_DEFAULT_NEXT_GEN_MODEL'])('drops %s, a model family this file has never heard of', (name) => {
  expect(name in engineEnv({ [name]: 'x' }, free)).toBe(false);
});

// The login, the proxy and the API key all arrive through the environment. Dropping by a wide
// pattern would sign the person out of their own engine.
it('keeps every other variable', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    ANTHROPIC_API_KEY: 'key',
    ANTHROPIC_BASE_URL: 'https://example.test',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Opus',
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: 'The strong one',
    CLAUDE_CONFIG_DIR: '/home/dev/.claude-work',
  };

  expect(engineEnv(base, free)).toEqual(base);
});

it('drops an undefined value, because spawn refuses one', () => {
  expect('EMPTY' in engineEnv({ PATH: '/usr/bin', EMPTY: undefined }, free)).toBe(false);
});

it('turns the guard on for a read-only phase and names the card folder', () => {
  const env = engineEnv({ PATH: '/usr/bin' }, { readOnlyTaskDir: '/work/app/.tasks/APP-1' });

  expect(env.NOLZU_READ_ONLY).toBe('1');
  expect(env.NOLZU_TASK_DIR).toBe('/work/app/.tasks/APP-1');
});

// Nolzu can itself run inside a read-only run, and then both variables are in its environment.
// Passed on, the guard would refuse every write of an implement run.
it('sets neither for a phase that may write, even when the parent carries both', () => {
  const env = engineEnv({ PATH: '/usr/bin', NOLZU_READ_ONLY: '1', NOLZU_TASK_DIR: '/other/.tasks/APP-9' }, free);

  expect('NOLZU_READ_ONLY' in env).toBe(false);
  expect('NOLZU_TASK_DIR' in env).toBe(false);
});

it('names this card folder and not one the parent carried', () => {
  const env = engineEnv({ NOLZU_TASK_DIR: '/other/.tasks/APP-9' }, { readOnlyTaskDir: '/work/app/.tasks/APP-1' });

  expect(env.NOLZU_TASK_DIR).toBe('/work/app/.tasks/APP-1');
});

// The guard lets every write through when the folder is empty, and resolves a relative one against
// a working directory this function cannot see. Both would be a read-only phase with no limit.
it.each(['', '.tasks/APP-1'])('refuses the card folder %j, because the guard needs an absolute path', (dir) => {
  expect(() => engineEnv({ PATH: '/usr/bin' }, { readOnlyTaskDir: dir })).toThrow(/absolute/);
});

describe('the config folder of a profile', () => {
  const profile = { id: 'codex-work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/codex-work' } as const;

  it('sets the vendor variable the profile names', () => {
    const env = engineEnv({ PATH: '/usr/bin' }, { readOnlyTaskDir: null, profile });

    expect(env.CODEX_HOME).toBe('/tmp/codex-work');
    // One vendor's variable, not every vendor's.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  // The other path of the same branch, and the one that matters most. A profile that means "the
  // vendor's default place" must leave a variable the person set in their own shell alone, or a
  // run finds no login at all.
  it('leaves the variable as it came when the profile names no folder', () => {
    const env = engineEnv(
      { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/me/.claude-elsewhere' },
      { readOnlyTaskDir: null, profile: { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null } },
    );

    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-elsewhere');
  });

  it('leaves it alone when there is no profile at all', () => {
    const env = engineEnv({ CODEX_HOME: '/home/me/.codex' }, { readOnlyTaskDir: null });

    expect(env.CODEX_HOME).toBe('/home/me/.codex');
  });

  // The vendor resolves a relative folder against the working directory, which is the card's
  // checkout, so a relative one makes a login folder inside somebody's repository.
  it('refuses a folder that is not absolute', () => {
    expect(() => engineEnv({}, { readOnlyTaskDir: null, profile: { ...profile, configDir: '.codex' } })).toThrow(
      /not an absolute path/,
    );
  });
});

describe('the knowledge folder', () => {
  it('is set only for a read-only phase that was given one', () => {
    const withIt = engineEnv({}, { readOnlyTaskDir: '/p/.tasks/APP-1', knowledgeDir: '/p/.nolzu/knowledge' });
    const without = engineEnv({}, { readOnlyTaskDir: '/p/.tasks/APP-1' });

    expect(withIt.NOLZU_KNOWLEDGE_DIR).toBe('/p/.nolzu/knowledge');
    expect(without.NOLZU_KNOWLEDGE_DIR).toBeUndefined();
  });

  // Nolzu can itself be started from inside a run that set it, and an inherited folder would let
  // a phase write knowledge nobody gave it.
  it('drops an inherited one', () => {
    const env = engineEnv({ NOLZU_KNOWLEDGE_DIR: '/somebody/else' }, { readOnlyTaskDir: '/p/.tasks/APP-1' });

    expect(env.NOLZU_KNOWLEDGE_DIR).toBeUndefined();
  });

  // A phase that may write anywhere in the checkout needs no guard at all, so the pair is not set.
  it('is not set for a phase that is not read-only', () => {
    const env = engineEnv({}, { readOnlyTaskDir: null, knowledgeDir: '/p/.nolzu/knowledge' });

    expect(env.NOLZU_KNOWLEDGE_DIR).toBeUndefined();
    expect(env.NOLZU_READ_ONLY).toBeUndefined();
  });

  it('refuses a folder that is not absolute', () => {
    expect(() => engineEnv({}, { readOnlyTaskDir: '/p/.tasks/APP-1', knowledgeDir: '.nolzu/knowledge' })).toThrow(
      /not an absolute path/,
    );
  });
});

describe('running a command in a guarded phase', () => {
  const guarded = { readOnlyTaskDir: '/p/.tasks/APP-1' };

  // Both sides. QA needs a command, and every other guarded phase must not get one, because the
  // guard is the only thing keeping a read-only run out of the project's source.
  it('is allowed only for a phase that says so', () => {
    expect(engineEnv({}, { ...guarded, commands: true }).NOLZU_ALLOW_COMMANDS).toBe('1');
    expect(engineEnv({}, guarded).NOLZU_ALLOW_COMMANDS).toBeUndefined();
    expect(engineEnv({}, { ...guarded, commands: false }).NOLZU_ALLOW_COMMANDS).toBeUndefined();
  });

  // Nolzu can itself be started from inside a QA run, and an inherited flag would hand a refine
  // run the command it was refused.
  it('drops an inherited flag', () => {
    expect(engineEnv({ NOLZU_ALLOW_COMMANDS: '1' }, guarded).NOLZU_ALLOW_COMMANDS).toBeUndefined();
  });

  // A phase that may write anywhere needs no guard, so the pair is not set at all.
  it('is not set for a phase that is not guarded', () => {
    expect(engineEnv({}, { readOnlyTaskDir: null, commands: true }).NOLZU_ALLOW_COMMANDS).toBeUndefined();
  });
});

// The wall keeps ~/.npm read-only, so every package manager's cache points into Nolzu's data folder,
// and the folders are there before the run, for bwrap.
it("points the package managers' caches at the data folder and makes them", () => {
  const data = mkdtempSync(join(tmpdir(), 'nolzu-caches-'));
  try {
    const caches = packageCaches(data);
    expect(caches.dir).toBe(join(data, 'caches'));
    expect(caches.env).toEqual({
      npm_config_cache: join(data, 'caches', 'npm'),
      YARN_CACHE_FOLDER: join(data, 'caches', 'yarn'),
      YARN_GLOBAL_FOLDER: join(data, 'caches', 'yarn-global'),
      pnpm_config_store_dir: join(data, 'caches', 'pnpm-store'),
      pnpm_config_cache_dir: join(data, 'caches', 'pnpm'),
    });
    for (const folder of Object.values(caches.env)) expect(existsSync(folder)).toBe(true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
