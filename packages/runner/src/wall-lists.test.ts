import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHECKOUT_WRITE_DENIED, ENGINE_WALLS, HIDDEN_FOR_EVERY_RUN, HIDDEN_ON, LINUX_SOCKETS } from './engine-walls.ts';
import { checkedWallLists, wallEntryProblem, wallGroups, type WallPlaces } from './wall-lists.ts';
import { resolvedPath } from './wall-detect.ts';

// The places a check reads, on paths that need no disk: `real` leaves them as they are.
const places: WallPlaces = {
  home: '/home/me',
  project: '/home/me/code/recipes',
  gitDir: '/home/me/code/recipes/.git',
  dataDir: '/home/me/.nolzu',
  needed: ['/home/me/code/recipes/.tasks', '/home/me/code/recipes/.nolzu/knowledge', '/tmp/nolzu-run'],
  real: (path) => path,
};

const problem = (list: 'hidden' | 'exceptions' | 'writable', entry: string) => wallEntryProblem(list, entry, places);

describe('wallEntryProblem, exceptions', () => {
  it('takes a .env file of the project', () => {
    expect(problem('exceptions', '.env.test')).toBeNull();
    expect(problem('exceptions', 'api/.env.test')).toBeNull();
  });

  it('refuses a path in the home folder, an absolute path and one that leaves the project', () => {
    expect(problem('exceptions', '~/.env.test')).toBe('Type the path from the project folder, such as .env.test. ~/.env.test is not one.');
    expect(problem('exceptions', '/etc/.env')).toBe('Type the path from the project folder, such as .env.test. /etc/.env is not one.');
    expect(problem('exceptions', '../other/.env.test')).toBe('../other/.env.test is outside the project. An exception can only name a file in the project.');
  });

  it('refuses a file that is not a .env file, because only those are hidden', () => {
    expect(problem('exceptions', 'config/secrets.json')).toBe('config/secrets.json is not a .env file. Only .env files are hidden in the project, so only they can be exceptions.');
  });

  it('refuses an exception inside a fixed secret path', () => {
    const inSsh = { ...places, project: '/home/me/.ssh/recipes', gitDir: '/home/me/.ssh/recipes/.git' };
    expect(wallEntryProblem('exceptions', '.env.test', inSsh)).toBe('.env.test is inside ~/.ssh, which stays hidden from every run.');
    const inLogin = { ...places, project: '/home/me/.codex', gitDir: '/home/me/.codex/.git' };
    expect(wallEntryProblem('exceptions', 'auth.json/.env', inLogin)).toBe('auth.json/.env is inside ~/.codex/auth.json, which stays hidden from every run.');
  });

  it('refuses an exception inside a browser profile of either system', () => {
    for (const folder of ['/home/me/.mozilla', '/home/me/Library/Application Support/Arc']) {
      expect(wallEntryProblem('exceptions', '.env', { ...places, project: `${folder}/app`, gitDir: `${folder}/app/.git` })).toContain('which stays hidden from every run.');
    }
  });

  it('follows a link out of the project', () => {
    const linked = { ...places, real: (path: string) => path.replace('/home/me/code/recipes/shared', '/home/me/shared') };
    expect(wallEntryProblem('exceptions', 'shared/.env.test', linked)).toBe('shared/.env.test is outside the project. An exception can only name a file in the project.');
  });
});

describe('wallEntryProblem, writable', () => {
  it('takes a cache folder in the home folder', () => {
    expect(problem('writable', '~/.gradle')).toBeNull();
    expect(problem('writable', '/opt/cache/cargo')).toBeNull();
  });

  it('refuses the project, its git folder, a folder inside it and one that holds it', () => {
    const sentence = (entry: string) => `${entry} would open the project to a phase that only reads it. Pick a folder outside the project.`;
    expect(problem('writable', '~/code/recipes')).toBe(sentence('~/code/recipes'));
    expect(problem('writable', '~/code/recipes/node_modules')).toBe(sentence('~/code/recipes/node_modules'));
    expect(problem('writable', '~/code')).toBe(sentence('~/code'));
    expect(problem('writable', 'build')).toBe(sentence('build'));
    expect(problem('writable', '.claude/skills')).toBe(sentence('.claude/skills'));
    const outside = { ...places, gitDir: '/srv/git/recipes.git' };
    expect(wallEntryProblem('writable', '/srv/git', outside)).toBe(sentence('/srv/git'));
  });

  it("refuses Nolzu's own data folder, a folder inside it and one that holds it", () => {
    const sentence = (entry: string) => `${entry} would open Nolzu's own data folder. A run could change Nolzu's settings there.`;
    expect(problem('writable', '~/.nolzu')).toBe(sentence('~/.nolzu'));
    expect(problem('writable', '~/.nolzu/qa-copies')).toBe(sentence('~/.nolzu/qa-copies'));
    const deeper = { ...places, dataDir: '/home/me/Library/nolzu' };
    expect(wallEntryProblem('writable', '~/Library', deeper)).toBe(sentence('~/Library'));
  });

  it('refuses the home folder and every folder above it', () => {
    const sentence = (entry: string) => `${entry} would open your whole home folder. Pick one cache folder, such as ~/.gradle.`;
    const elsewhere = { ...places, project: '/srv/recipes', gitDir: '/srv/recipes/.git' };
    expect(wallEntryProblem('writable', '~', elsewhere)).toBe(sentence('~'));
    expect(wallEntryProblem('writable', '/home', elsewhere)).toBe(sentence('/home'));
    expect(wallEntryProblem('writable', '/', elsewhere)).toBe(sentence('/'));
  });

  it('refuses a fixed secret path, inside or around it', () => {
    expect(problem('writable', '~/.ssh')).toBe('~/.ssh would open ~/.ssh, which stays hidden from every run.');
    expect(problem('writable', '~/.aws/cli')).toBe('~/.aws/cli would open ~/.aws, which stays hidden from every run.');
    expect(problem('writable', '~/.config')).toBe('~/.config would open ~/.config/gcloud, which stays hidden from every run.');
  });

  it("refuses an engine's config or hook file, and a folder that holds one", () => {
    expect(problem('writable', '~/.claude')).toBe("~/.claude would open ~/.claude/settings.json, an engine's config or hook file. A run could plant a hook there.");
    expect(problem('writable', '~/.codex/rules')).toBe("~/.codex/rules would open ~/.codex/rules, an engine's config or hook file. A run could plant a hook there.");
    expect(problem('writable', '~/.cursor/hooks.json')).toBe("~/.cursor/hooks.json would open ~/.cursor/hooks.json, an engine's config or hook file. A run could plant a hook there.");
  });
});

describe('wallEntryProblem, hidden', () => {
  it('takes any path inside or outside the project', () => {
    expect(problem('hidden', '~/secrets')).toBeNull();
    expect(problem('hidden', 'secrets')).toBeNull();
    expect(problem('hidden', '/srv/keys')).toBeNull();
  });

  it('refuses a path that would hide a folder the run needs', () => {
    const sentence = (entry: string, what: string) => `${entry} would hide ${what}, which the run needs.`;
    expect(problem('hidden', '.tasks')).toBe(sentence('.tasks', '~/code/recipes/.tasks'));
    expect(problem('hidden', '~/code')).toBe(sentence('~/code', '~/code/recipes/.tasks'));
    expect(problem('hidden', '.nolzu')).toBe(sentence('.nolzu', '~/code/recipes/.nolzu/knowledge'));
    expect(problem('hidden', '/tmp')).toBe(sentence('/tmp', '/tmp/nolzu-run'));
    expect(problem('hidden', '~/.claude/projects')).toBe(sentence('~/.claude/projects', '~/.claude/projects'));
    expect(problem('hidden', '~/.cursor')).toBe(sentence('~/.cursor', '~/.cursor/projects'));
  });

  it('refuses an empty entry in every list', () => {
    expect(problem('hidden', '  ')).toBe('Type a path, such as ~/secrets.');
    expect(problem('exceptions', '')).toBe('Type a path, such as .env.test.');
    expect(problem('writable', '')).toBe('Type a path, such as ~/.gradle.');
  });
});

describe('checkedWallLists', () => {
  // HOME points at a scratch folder and the account's home is where the project lives. A person's own
  // `~/` hidden entry holds under both, never a writable one, and the second path is held to the same
  // check: `~/code` there would hide the project the run needs, so only the HOME one is kept.
  it('hides a typed ~ entry under the account home too, and checks it there', () => {
    const scratch: WallPlaces = { ...places, home: '/tmp/demo', systemHome: '/home/me' };
    const checked = checkedWallLists({ hidden: ['~/secrets', 'secrets', '~/code', '.tasks'], exceptions: [], writable: ['~/.gradle'] }, scratch);
    expect(checked.hidden).toEqual(['/tmp/demo/secrets', '/home/me/code/recipes/secrets', '/tmp/demo/code', '/home/me/secrets']);
    expect(checked.writable).toEqual(['/tmp/demo/.gradle']);
    // A path from the project is the same under either home, so it is checked and named once.
    expect(checked.dropped).toEqual(['.tasks would hide /home/me/code/recipes/.tasks, which the run needs.', '~/code would hide ~/code/recipes/.tasks, which the run needs.']);
    // The same folder twice is one list, as with HOME alone.
    expect(checkedWallLists({ hidden: ['~/secrets'], exceptions: [], writable: [] }, { ...places, systemHome: '/home/me' }).hidden).toEqual(['/home/me/secrets']);
  });

  it('turns each kept entry into its real path and names each one it leaves out', () => {
    const checked = checkedWallLists({ hidden: ['secrets', '.tasks'], exceptions: ['.env.test', '~/.env'], writable: ['~/.gradle', '~/.claude'] }, places);
    expect(checked.hidden).toEqual(['/home/me/code/recipes/secrets']);
    expect(checked.exceptions).toEqual(['/home/me/code/recipes/.env.test']);
    expect(checked.writable).toEqual(['/home/me/.gradle']);
    expect(checked.dropped).toEqual([
      '.tasks would hide ~/code/recipes/.tasks, which the run needs.',
      'Type the path from the project folder, such as .env.test. ~/.env is not one.',
      "~/.claude would open ~/.claude/settings.json, an engine's config or hook file. A run could plant a hook there.",
    ]);
  });
});

describe('wallGroups', () => {
  it('shows every path the wall hides or holds, each in one group', () => {
    for (const system of ['darwin', 'linux'] as const) {
      const shown = wallGroups(system).flatMap((group) => group.paths);
      const logins = Object.values(ENGINE_WALLS).flatMap((row) => row.logins);
      const configs = Object.values(ENGINE_WALLS).flatMap((row) => row.writeDenied);
      const sockets = system === 'linux' ? LINUX_SOCKETS : [];
      expect(new Set(shown)).toEqual(new Set([...HIDDEN_FOR_EVERY_RUN, ...HIDDEN_ON[system], ...sockets, ...logins, ...configs, ...CHECKOUT_WRITE_DENIED, '.env', '.env.*']));
      expect(shown.length).toBe(new Set(shown).size);
    }
  });

  it('groups the list the way Settings, Wall reads it', () => {
    const groups = wallGroups('darwin');
    const of = (id: string) => groups.find((group) => group.id === id);
    expect(groups.map((group) => group.name)).toEqual(expect.arrayContaining(['Keys and cloud logins', 'Shell history', 'Docker and Podman', 'Browser profiles', 'Card checkout rules']));
    expect(of('logins')?.paths).toContain('~/.ssh');
    expect(of('history')?.paths).toContain('~/.zsh_history');
    // A login filed under history would read as the wrong reason on the page.
    for (const path of of('history')?.paths ?? []) expect(path).toMatch(/_(history|sessions)$/);
    expect(of('docker')?.paths).toEqual(['~/.docker/run', '~/.orbstack/run']);
    expect(of('browsers')?.paths).toContain('~/Library/Safari');
    expect(wallGroups('linux').find((group) => group.id === 'browsers')?.paths).toContain('~/.mozilla');
    expect(wallGroups('linux').find((group) => group.id === 'docker')?.line).toContain('X server');
    expect(of('checkout')?.paths).toEqual(expect.arrayContaining(['.claude', '.mcp.json']));
    expect(of('checkout')?.line).toContain('Implement included');
    // The local server has no token yet, so the rule must not promise more than the engine files.
    expect(of('engine-config')?.line).toContain('can still change your own commands under Start the app');
    for (const group of groups) expect(group.line).toMatch(/^\S.*\.$/);
  });
});

// Seatbelt matches real paths, so a link in the typed path is followed through its nearest parent
// that exists.
describe('resolvedPath', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('follows a link in a parent of a path that does not exist yet', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-wall-lists-')));
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(resolvedPath(join(root, 'link/cache/new'))).toBe(join(root, 'real/cache/new'));
  });
});
