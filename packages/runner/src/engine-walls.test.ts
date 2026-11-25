import { ENGINE_NAMES } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { appWallSpec, ENGINE_WALLS, HIDDEN_FOR_EVERY_RUN, linuxStateOf, ownSandbox, sessionFoldersOf, systemHome, wallKind, wallSpecFor, watchedFilesOf, type WallSpecInput } from './engine-walls.ts';
import { bwrapArgs, seatbeltProfile } from './wall.ts';

const base: WallSpecInput = {
  policy: { readOnly: true },
  vendor: 'claude-code',
  cardDir: '/work/app/.tasks/APP-1',
  knowledgeDir: '/work/app/knowledge',
  checkout: '/work/app',
  home: '/home/me',
  tmp: '/tmp/nolzu-run',
  exceptions: [],
};

describe('ENGINE_WALLS', () => {
  it('has one row per engine, every path under the home folder', () => {
    expect(Object.keys(ENGINE_WALLS).sort()).toEqual([...ENGINE_NAMES].sort());
    for (const row of Object.values(ENGINE_WALLS)) {
      for (const path of [...row.writable, ...row.logins, ...row.writeDenied]) expect(path.startsWith('~/')).toBe(true);
    }
  });

  // Exactly one wall per run. Codex's own sandbox still reads ~/.ssh and .env, so Nolzu's wall holds
  // every engine until the wall measurements say a Codex permission profile can deny them.
  it('puts every engine inside this wall, Codex included', () => {
    for (const name of ENGINE_NAMES) expect(ownSandbox(name, { ready: true })).toBe(false);
    expect(ownSandbox('fake', { ready: true })).toBe(false);
    expect(ownSandbox('toString', { ready: true })).toBe(false);
  });

  // Where the wall cannot start, Codex falls back to its own sandbox and the others have none.
  it('hands Codex its own sandbox when the wall cannot start', () => {
    const missing = { ready: false, reason: 'bubblewrap is not installed.' } as const;
    expect(ownSandbox('codex', missing)).toBe(true);
    for (const name of ['claude-code', 'cursor', 'fake']) expect(ownSandbox(name, missing)).toBe(false);
  });

  // What the run row stores, so the card History row can say which wall held the run.
  it('names the wall a run starts in', () => {
    const missing = { ready: false, reason: 'bubblewrap is not installed.' } as const;
    expect(wallKind('cursor', { ready: true }, 'darwin')).toBe('macos');
    expect(wallKind('codex', { ready: true }, 'linux')).toBe('bubblewrap');
    expect(wallKind('codex', missing, 'linux')).toBe('codex');
    expect(wallKind('claude-code', missing, 'linux')).toBe('none');
    expect(wallKind('claude-code', { ready: true }, 'win32')).toBe('none');
  });

  // The wrap-up and optimize on Codex: the card folder and the knowledge folder, ~/.codex for its
  // sessions, and Codex's own config read-only. The wall is ready for these phases.
  it('gives a Codex knowledge phase its two folders and keeps its config read-only', () => {
    const spec = wallSpecFor({ ...base, vendor: 'codex', policy: { readOnly: true, knowledge: true } });
    expect(spec.writable).toEqual(['/tmp/nolzu-run', '/home/me/.codex', '/work/app/.tasks/APP-1', '/work/app/knowledge']);
    expect(spec.hidden).toEqual(expect.arrayContaining(['/home/me/.ssh', '/home/me/.claude/.credentials.json']));
    expect(spec.hidden).not.toContain('/home/me/.codex/auth.json');
    expect(spec.writeDenied).toEqual(expect.arrayContaining(['/home/me/.codex/config.toml', '/home/me/.codex/hooks.json']));
  });

  // The home folder stays read-only, so the package caches live in Nolzu's data folder, open to a run
  // that runs commands and to no other.
  it('opens the package caches to Implement and QA, and to no other phase', () => {
    const caches = '/home/me/.nolzu/caches';
    expect(wallSpecFor({ ...base, caches, policy: { readOnly: false } }).writable).toContain(caches);
    expect(wallSpecFor({ ...base, caches, policy: { readOnly: true, commands: true } }).writable).toContain(caches);
    expect(wallSpecFor({ ...base, caches, policy: { readOnly: true } }).writable).not.toContain(caches);
    expect(wallSpecFor({ ...base, caches, policy: { readOnly: false } }).writable).not.toContain('/home/me/.npm');
  });

  // The Cursor CLI saves cli-config.json and its statsig cache through a temp file beside each, then
  // renames it over. macOS opens that temp name where the whole state folder is not open; Linux binds
  // the file, which cannot be renamed over.
  it('opens the temp name beside each session file on macOS, where the state folder stays closed', () => {
    const cursor = wallSpecFor({ ...base, vendor: 'cursor' });
    expect(cursor.replaced).toEqual(['/home/me/.cursor/cli-config.json', '/home/me/.cursor/statsig-cache.json']);
    expect(seatbeltProfile(cursor)).toContain('(allow file-write* (regex "^/home/me/\\\\.cursor/cli-config\\\\.json\\\\.[0-9]+\\\\.[0-9a-f-]+\\\\.tmp$"))');
    expect(wallSpecFor({ ...base, vendor: 'cursor', platform: 'linux' }).replaced).toEqual([]);
    expect(wallSpecFor({ ...base, vendor: 'codex' }).replaced).toEqual([]);
    expect(wallSpecFor({ ...base, vendor: 'cursor', configDir: '/home/me/profiles/work' }).replaced).toContain('/home/me/profiles/work/cli-config.json');
  });

  // Google's agent CLIs keep their logins in ~/.gemini and read their hooks from it, and a person may
  // run one by hand later. No engine Nolzu runs needs it, so every run has it hidden.
  it('hides the Google agent folder from every run', () => {
    expect(wallSpecFor(base).hidden).toContain('/home/me/.gemini');
  });

  it('keeps every folder a Google agent CLI reads as a project customization root read-only', () => {
    const spec = wallSpecFor({ ...base, policy: { readOnly: false } });
    for (const name of ['.agents', '.agent', '_agents', '_agent']) expect(spec.writeDenied).toContain(`/work/app/${name}`);
  });

  it('hides the cloud and key folders but not the npm setup', () => {
    expect(HIDDEN_FOR_EVERY_RUN).toEqual(expect.arrayContaining(['~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc']));
    expect(HIDDEN_FOR_EVERY_RUN).not.toContain('~/.npmrc');
  });

  it('hides the tokens and history a run could send away, and the Docker socket folders', () => {
    const hidden = wallSpecFor(base).hidden;
    for (const path of ['.config/gh/hosts.yml', '.git-credentials', '.pypirc', '.cargo/credentials.toml', '.docker/run', '.orbstack/run', '.zsh_history', '.bash_history', '.zsh_sessions', '.local/share/fish/fish_history', '.python_history', '.node_repl_history']) {
      expect(hidden).toContain(`/home/me/${path}`);
    }
  });

  it('hides the browser profiles only on the system where they live', () => {
    const mac = wallSpecFor({ ...base, platform: 'darwin' }).hidden;
    const linux = wallSpecFor({ ...base, platform: 'linux' }).hidden;
    expect(mac).toEqual(expect.arrayContaining(['/home/me/Library/Application Support/Google/Chrome', '/home/me/Library/Application Support/Microsoft Edge', '/home/me/Library/Application Support/Arc', '/home/me/Library/Application Support/Firefox', '/home/me/Library/Application Support/BraveSoftware', '/home/me/Library/Safari']));
    expect(linux).toEqual(expect.arrayContaining(['/home/me/.config/google-chrome', '/home/me/.config/chromium', '/home/me/.config/BraveSoftware', '/home/me/.mozilla']));
    expect(mac).not.toContain('/home/me/.mozilla');
    expect(linux).not.toContain('/home/me/Library/Safari');
  });

  it('closes the daemon sockets and the session bus on Linux, and leaves macOS to the profile', () => {
    expect(wallSpecFor({ ...base, platform: 'darwin' }).sockets).toEqual([]);
    const uid = process.getuid?.() ?? 0;
    expect(wallSpecFor({ ...base, platform: 'linux' }).sockets).toEqual(
      expect.arrayContaining(['/var/run/docker.sock', '/run/docker.sock', `/run/user/${uid}/docker.sock`, `/run/user/${uid}/podman/podman.sock`, `/run/user/${uid}/bus`, '/tmp/.X11-unix']),
    );
  });
});

describe('wallSpecFor', () => {
  it('holds a read-only phase to its card folder, with the checkout read-only', () => {
    const spec = wallSpecFor(base);
    expect(spec.writable).toEqual(expect.arrayContaining(['/tmp/nolzu-run', '/home/me/.claude/projects', '/home/me/.claude.json', '/work/app/.tasks/APP-1']));
    expect(spec.writable).not.toContain('/home/me/.claude');
    expect(spec.writable).not.toContain('/work/app');
    expect(spec.writable).not.toContain('/work/app/knowledge');
    expect(spec.envRoots).toEqual(['/work/app']);
  });

  it('holds QA to the same shape: commands run, the checkout stays read-only', () => {
    expect(wallSpecFor({ ...base, policy: { readOnly: true, commands: true } })).toEqual(wallSpecFor(base));
  });

  it('adds the knowledge folder for the wrap-up, and only when the phase writes knowledge', () => {
    expect(wallSpecFor({ ...base, policy: { readOnly: true, knowledge: true } }).writable).toContain('/work/app/knowledge');
    expect(wallSpecFor({ ...base, policy: { readOnly: true, knowledge: true }, knowledgeDir: null }).writable).not.toContain(null);
  });

  // A repository the run made there would be the one Nolzu's git uses on the Knowledge screen.
  it('lets no run make a repository in the knowledge folder', () => {
    expect(wallSpecFor({ ...base, policy: { readOnly: true, knowledge: true } }).writeDenied).toContain('/work/app/knowledge/.git');
    expect(wallSpecFor({ ...base, policy: { readOnly: false } }).writeDenied).toEqual(expect.arrayContaining(['/work/app/.nolzu/.git', '/work/app/.nolzu/knowledge/.git']));
  });

  it('opens the checkout and its git folder for implement', () => {
    const spec = wallSpecFor({ ...base, policy: { readOnly: false }, checkout: '/work/wt/APP-1', gitCommonDir: '/work/app/.git' });
    expect(spec.writable).toEqual(expect.arrayContaining(['/work/wt/APP-1', '/work/app/.git']));
    expect(spec.writeDenied).toEqual(expect.arrayContaining(['/work/wt/APP-1/.git/hooks', '/work/app/.git/hooks', '/work/app/.git/config']));
  });

  // The shared git folder of a worktree holds every other card's admin folder and Nolzu's own folders,
  // so a run gets only what its git writes there, and its own admin folder.
  it("opens only the objects, refs and the card's own admin folder of a worktree's shared git folder", () => {
    const spec = wallSpecFor({ ...base, policy: { readOnly: false }, checkout: '/work/wt/APP-1', gitCommonDir: '/work/app/.git', gitOwnDir: '/work/app/.git/worktrees/APP-1' });
    expect(spec.writable).not.toContain('/work/app/.git');
    expect(spec.writable.filter((path) => path.startsWith('/work/app/.git'))).toEqual([
      ...['objects', 'refs', 'logs', 'lfs', 'rr-cache', 'packed-refs', 'packed-refs.lock', 'packed-refs.new', 'gc.pid', 'gc.pid.lock', 'gc.log', 'gc.log.lock'].map((name) => `/work/app/.git/${name}`),
      '/work/app/.git/worktrees/APP-1',
    ]);
    // Read-only, so neither the sibling's admin folder nor Nolzu's own folders and files there can be written.
    const profile = seatbeltProfile(spec);
    expect(profile).not.toContain('(allow file-write* (subpath "/work/app/.git"))');
    expect(profile).toContain('(allow file-write* (subpath "/work/app/.git/worktrees/APP-1"))');
  });

  // git writes COMMIT_EDITMSG, FETCH_HEAD, the reflogs and packed-refs by name, so a run may make no link
  // in the git places it may write. The objects and LFS are written through a hard link and a rename.
  it('names every writable git place but the objects and LFS where a run may make no link', () => {
    const worktree = wallSpecFor({ ...base, policy: { readOnly: false }, checkout: '/work/wt/APP-1', gitCommonDir: '/work/app/.git', gitOwnDir: '/work/app/.git/worktrees/APP-1' });
    expect(worktree.noLinks).toEqual([
      ...['refs', 'logs', 'rr-cache', 'packed-refs', 'packed-refs.lock', 'packed-refs.new', 'gc.pid', 'gc.pid.lock', 'gc.log', 'gc.log.lock'].map((name) => `/work/app/.git/${name}`),
      '/work/app/.git/worktrees/APP-1',
    ]);
    const plain = wallSpecFor({ ...base, policy: { readOnly: false }, childRepos: [{ checkout: '/work/app/api', common: '/work/app/api/.git', own: '/work/app/api/.git' }] });
    expect(plain.noLinks).toEqual(['/work/app/.git', '/work/app/api/.git']);
    expect(wallSpecFor({ ...base, policy: { readOnly: true } }).noLinks).toEqual([]);
  });

  it('opens a plain checkout\'s git folder whole, as before', () => {
    expect(wallSpecFor({ ...base, policy: { readOnly: false } }).writable).toContain('/work/app/.git');
    expect(wallSpecFor({ ...base, policy: { readOnly: false }, gitCommonDir: '/work/app/.git', gitOwnDir: '/work/app/.git' }).writable).toContain('/work/app/.git');
  });

  it('holds the git pointers of a plain checkout by exact name', () => {
    const spec = wallSpecFor({ ...base, policy: { readOnly: false } });
    expect(spec.writeDeniedLiteral?.filter((path) => path.startsWith('/work/'))).toEqual(['/work/app', '/work/app/.git', '/work/app/.git/commondir', '/work/app/.git/config.worktree']);
  });

  it("holds a worktree's pointer file, its own git folder and the files in it that name the shared one", () => {
    const spec = wallSpecFor({ ...base, policy: { readOnly: false }, checkout: '/work/wt/APP-1', gitCommonDir: '/work/app/.git', gitOwnDir: '/work/app/.git/worktrees/APP-1' });
    expect(spec.writeDeniedLiteral?.filter((path) => path.startsWith('/work/'))).toEqual([
      '/work/wt/APP-1',
      '/work/wt/APP-1/.git',
      '/work/app/.git',
      '/work/app/.git/commondir',
      '/work/app/.git/config.worktree',
      '/work/app/.git/worktrees',
      '/work/app/.git/worktrees/APP-1',
      '/work/app/.git/worktrees/APP-1/commondir',
      '/work/app/.git/worktrees/APP-1/gitdir',
      '/work/app/.git/worktrees/APP-1/config.worktree',
    ]);
  });

  it('holds the pointers, config and hooks of each repository one folder down', () => {
    const spec = wallSpecFor({
      ...base,
      policy: { readOnly: false },
      checkout: '/work/wt/APP-1',
      childRepos: [
        { checkout: '/work/wt/APP-1/api', own: '/work/api/.git/worktrees/APP-1', common: '/work/api/.git' },
        { checkout: '/work/wt/APP-1/web', own: '/work/wt/APP-1/web/.git', common: '/work/wt/APP-1/web/.git' },
      ],
    });
    expect(spec.writeDeniedLiteral).toEqual(expect.arrayContaining(['/work/wt/APP-1/api', '/work/wt/APP-1/api/.git', '/work/api/.git/worktrees/APP-1/commondir', '/work/wt/APP-1/web/.git/commondir']));
    expect(spec.writeDenied).toEqual(expect.arrayContaining(['/work/api/.git/config', '/work/wt/APP-1/web/.git/config', '/work/wt/APP-1/web/.git/hooks']));
  });

  it('hides the .env files of the main project too when the checkout is a worktree', () => {
    const spec = wallSpecFor({ ...base, checkout: '/work/wt/APP-1', gitCommonDir: '/work/app/.git' });
    expect(spec.envRoots).toEqual(['/work/wt/APP-1', '/work/app']);
  });

  it('hides the secrets in every run, implement included, and the logins of the other engines', () => {
    for (const policy of [{ readOnly: true }, { readOnly: false }]) {
      const spec = wallSpecFor({ ...base, policy });
      expect(spec.hidden).toEqual(expect.arrayContaining(['/home/me/.ssh', '/home/me/.aws', '/home/me/.codex/auth.json']));
      for (const login of ENGINE_WALLS['claude-code'].logins) expect(spec.hidden).not.toContain(login.replace('~', '/home/me'));
    }
  });

  it('write-denies the engine config and the hook files in the checkout', () => {
    const spec = wallSpecFor(base);
    expect(spec.writeDenied).toEqual(
      expect.arrayContaining([
        '/home/me/.claude/settings.json',
        '/home/me/.claude/hooks',
        '/work/app/.git/hooks',
        '/work/app/.claude',
        '/work/app/.cursor',
        '/work/app/.mcp.json',
        '/work/app/.nolzu/mcp-servers.json',
        '/work/app/.nolzu/skills',
      ]),
    );
  });

  // Skills, commands, agents and rules in the checkout's .claude load in a later run, outside this
  // wall, so the whole folder is held and not only its settings and hooks.
  it("holds the checkout's whole .claude folder, for implement too", () => {
    const spec = wallSpecFor({ ...base, policy: { readOnly: false } });
    expect(spec.writable).toContain('/work/app');
    expect(spec.writeDenied).toContain('/work/app/.claude');
    expect(spec.writeDenied.filter((path) => path.startsWith('/work/app/.claude/'))).toEqual([]);
  });

  it('keeps only exceptions inside the checkout, never a home path', () => {
    const spec = wallSpecFor({ ...base, exceptions: ['/work/app/.env.test', '/home/me/.ssh/id_ed25519', '/work/application/.env'] });
    expect(spec.envExceptions).toEqual(['/work/app/.env.test']);
  });

  it('opens the card folder it was given, not a fixed one', () => {
    const other = { ...base, cardDir: '/work/app/.tasks/WEB-7' };
    expect(wallSpecFor(other).writable).toContain('/work/app/.tasks/WEB-7');
    expect(wallSpecFor(other).writable).not.toContain('/work/app/.tasks/APP-1');
    // A worktree run keeps its card folder in the main project, outside the checkout.
    const worktree = { ...other, policy: { readOnly: false }, checkout: '/work/wt/WEB-7', gitCommonDir: '/work/app/.git' };
    expect(wallSpecFor(worktree).writable).toContain('/work/app/.tasks/WEB-7');
    expect(wallSpecFor(worktree).writable).not.toContain('/work/app/.tasks/APP-1');
    expect(wallSpecFor({ ...other, policy: { readOnly: true, knowledge: true }, knowledgeDir: '/work/app/knowledge-web' }).writable).toContain('/work/app/knowledge-web');
  });

  it('takes the state folders and config files of the engine it was given', () => {
    const spec = wallSpecFor({ ...base, vendor: 'codex' });
    expect(spec.writable).toEqual(expect.arrayContaining(['/home/me/.codex']));
    expect(spec.writable).not.toContain('/home/me/.claude');
    expect(spec.writeDenied).toContain('/home/me/.codex/config.toml');
    expect(spec.writeDenied).not.toContain('/home/me/.claude/settings.json');
    expect(spec.hidden).toContain('/home/me/.claude/.credentials.json');
    expect(spec.hidden).not.toContain('/home/me/.codex/auth.json');
  });

  it('lists each write-denied path once', () => {
    const spec = wallSpecFor(base);
    expect(new Set(spec.writeDenied).size).toBe(spec.writeDenied.length);
  });

  it('does not take the checkout folder itself as an exception', () => {
    expect(wallSpecFor({ ...base, exceptions: ['/work/app', '/work/app/.env.test'] }).envExceptions).toEqual(['/work/app/.env.test']);
  });
});

describe('QA on a throwaway copy', () => {
  const qa = { ...base, policy: { readOnly: true, commands: true }, checkout: '/data/qa-copies/qa-APP-1-0a1b2c3d', copyOf: '/work/app', gitCommonDir: '/work/app/.git' };

  it('opens the copy and the card folder, and keeps the real checkout read-only', () => {
    const spec = wallSpecFor(qa);
    expect(spec.writable).toEqual(expect.arrayContaining(['/data/qa-copies/qa-APP-1-0a1b2c3d', '/work/app/.tasks/APP-1']));
    expect(spec.writable).not.toContain('/work/app');
    expect(spec.writable).not.toContain('/work/app/.git');
  });

  it('hides the .env files of the copy and of the real checkout', () => {
    expect(wallSpecFor(qa).envRoots).toEqual(['/data/qa-copies/qa-APP-1-0a1b2c3d', '/work/app']);
    expect(wallSpecFor({ ...qa, copyOf: '/work/wt/APP-1/api' }).envRoots).toEqual(['/data/qa-copies/qa-APP-1-0a1b2c3d', '/work/wt/APP-1/api', '/work/app']);
  });

  it('maps an exception of the real checkout onto the copy, and keeps both', () => {
    const spec = wallSpecFor({ ...qa, exceptions: ['/work/app/.env.test', '/home/me/.ssh/id_ed25519'] });
    expect(spec.envExceptions).toEqual(['/work/app/.env.test', '/data/qa-copies/qa-APP-1-0a1b2c3d/.env.test']);
  });

  it('keeps the hook files of the copy write-denied', () => {
    expect(wallSpecFor(qa).writeDenied).toEqual(expect.arrayContaining(['/data/qa-copies/qa-APP-1-0a1b2c3d/.git/hooks', '/data/qa-copies/qa-APP-1-0a1b2c3d/.claude']));
  });
});

describe('the session folders on Linux', () => {
  it('lists them under the home folder, inside the engine state, never a config or hook path', () => {
    for (const row of Object.values(ENGINE_WALLS)) {
      expect(row.configRoot.startsWith('~/')).toBe(true);
      for (const path of [...row.sessionFolders, ...row.sessionFiles]) {
        expect(path.startsWith('~/')).toBe(true);
        // A pattern names a folder inside a session folder on purpose, such as each project's memory.
        const names = row.writeDenied.filter((denied) => !denied.includes('*'));
        expect(names.some((denied) => path === denied || path.startsWith(`${denied}/`) || denied.startsWith(`${path}/`))).toBe(false);
      }
    }
  });

  it('opens only the session folders and files on Linux, not the whole state folder', () => {
    const spec = wallSpecFor({ ...base, platform: 'linux' });
    expect(spec.writable).not.toContain('/home/me/.claude');
    expect(spec.writable).toEqual(expect.arrayContaining(['/home/me/.claude/projects', '/home/me/.claude.json', '/work/app/.tasks/APP-1']));
    // The write-denied names stay in the spec: they still hold on a path that exists.
    expect(spec.writeDenied).toContain('/home/me/.claude/settings.local.json');
    expect(sessionFoldersOf(base)).toContain('/home/me/.claude/projects');
  });

  // In SBPL the last matching rule wins, so a whole open state folder left every name the row does
  // not close writable: a status line script, rules, output styles, the files CLAUDE.md imports.
  it('opens the same session list for claude-code on macOS as on Linux', () => {
    const mac = wallSpecFor({ ...base, platform: 'darwin' }).writable;
    expect(mac).toEqual(wallSpecFor({ ...base, platform: 'linux' }).writable);
    expect(mac).not.toContain('/home/me/.claude');
    expect(wallSpecFor({ ...base, vendor: 'cursor', platform: 'darwin' }).writable).not.toContain('/home/me/.cursor');
  });

  // bwrap binds a file, and a bound file can be neither renamed over nor given a sibling, which is how
  // the Cursor CLI saves its config. So Linux opens the folder whole, and binds none of the session
  // paths in it again.
  it("opens Cursor's state folder whole on Linux, with its write-denied names still held", () => {
    const linux = wallSpecFor({ ...base, vendor: 'cursor', platform: 'linux' });
    expect(linux.writable).toEqual(expect.arrayContaining(['/home/me/.cursor', '/home/me/.config/cursor']));
    expect(linux.writable).not.toContain('/home/me/.cursor/cli-config.json');
    expect(linux.writable).not.toContain('/home/me/.cursor/projects');
    expect(linux.writeDenied).toEqual(expect.arrayContaining(['/home/me/.cursor/mcp.json', '/home/me/.cursor/hooks.json', '/home/me/.cursor/rules']));
    expect(linuxStateOf({ ...base, vendor: 'cursor', platform: 'linux' })).toEqual({ folder: '/home/me/.cursor', session: ['projects', 'chats', 'ai-tracking', 'cli-config.json', 'statsig-cache.json'] });
    expect(linuxStateOf({ ...base, vendor: 'cursor', platform: 'linux', configDir: '/home/me/profiles/work' })?.folder).toBe('/home/me/profiles/work');
    expect(linuxStateOf({ ...base, vendor: 'cursor', platform: 'darwin' })).toBeNull();
    expect(linuxStateOf({ ...base, platform: 'linux' })).toBeNull();
  });

  it('keeps the memory folder of every Claude Code project read-only', () => {
    expect(wallSpecFor({ ...base, platform: 'darwin' }).writeDenied).toContain('/home/me/.claude/projects/*/memory');
  });

  // Else a run renames the folder away and moves in one of its own, with the file already inside.
  it('keeps the name of every open folder above a write-denied path', () => {
    const claude = wallSpecFor({ ...base, platform: 'darwin' }).writeDeniedLiteral;
    expect(claude).toEqual(expect.arrayContaining(['/home/me/.claude/projects', '/home/me/.claude/projects/*']));
    expect(claude).not.toContain('/home/me/.claude');
    expect(wallSpecFor({ ...base, vendor: 'codex', platform: 'darwin' }).writeDeniedLiteral).toContain('/home/me/.codex');
    // On Linux the state folder is not open, so it needs no hold.
    expect(wallSpecFor({ ...base, vendor: 'codex', platform: 'linux' }).writeDeniedLiteral).not.toContain('/home/me/.codex');
  });

  // Its session files are not all known yet, so macOS still opens the whole state folder.
  it('opens all of the codex state folder on macOS for now', () => {
    expect(wallSpecFor({ ...base, vendor: 'codex', platform: 'darwin' }).writable).toContain('/home/me/.codex');
    expect(wallSpecFor({ ...base, vendor: 'codex', platform: 'linux' }).writable).not.toContain('/home/me/.codex');
  });
});

describe('a profile with its own config folder', () => {
  it('moves the state, the session folders and the write-denied config files there', () => {
    const input = { ...base, configDir: '/home/me/work-claude' };
    const spec = wallSpecFor(input);
    expect(spec.writable).toContain('/home/me/work-claude/projects');
    expect(spec.writable).not.toContain('/home/me/work-claude');
    expect(spec.writable).not.toContain('/home/me/.claude/projects');
    expect(spec.writeDenied).toEqual(expect.arrayContaining(['/home/me/work-claude/settings.json', '/home/me/work-claude/hooks']));
    expect(wallSpecFor({ ...input, platform: 'linux' }).writable).toContain('/home/me/work-claude/projects');
    expect(sessionFoldersOf(input)).toContain('/home/me/work-claude/projects');
    expect(watchedFilesOf(input).map((file) => file.path)).toEqual(['/home/me/.claude.json', '/home/me/work-claude/.claude.json']);
  });

  it('leaves the paths outside the config folder where they are', () => {
    expect(wallSpecFor({ ...base, configDir: '/home/me/work-claude' }).writable).toContain('/home/me/.claude.json');
  });
});

// The project's own lists from Settings, Project, Walls. They widen or narrow the wall, and the
// fixed rules still hold after them.
describe("the project's wall lists", () => {
  const lists = { hidden: ['/work/app/secrets', '/srv/keys'], writable: ['/home/me/.gradle'] };

  it('hides the extra paths in every run, Implement included', () => {
    for (const policy of [{ readOnly: true }, { readOnly: false }, { readOnly: true, commands: true }]) {
      const spec = wallSpecFor({ ...base, policy, lists });
      expect(spec.hidden).toEqual(expect.arrayContaining(['/work/app/secrets', '/srv/keys', '/home/me/.ssh']));
    }
  });

  it('opens the extra writable folders for Implement and QA only', () => {
    expect(wallSpecFor({ ...base, policy: { readOnly: false }, lists }).writable).toContain('/home/me/.gradle');
    expect(wallSpecFor({ ...base, policy: { readOnly: true, commands: true }, lists }).writable).toContain('/home/me/.gradle');
    expect(wallSpecFor({ ...base, policy: { readOnly: true }, lists }).writable).not.toContain('/home/me/.gradle');
    expect(wallSpecFor({ ...base, policy: { readOnly: true, knowledge: true }, lists }).writable).not.toContain('/home/me/.gradle');
  });

  it('keeps the fixed rules after the lists, so they still win', () => {
    // A hand-edited database that slipped past the check still cannot open a hook or show a secret.
    const spec = wallSpecFor({ ...base, policy: { readOnly: false }, lists: { hidden: [], writable: ['/home/me/.claude/hooks', '/home/me/.ssh'] } });
    expect(spec.writeDenied).toContain('/home/me/.claude/hooks');
    expect(spec.hidden).toContain('/home/me/.ssh');
  });

  it('re-allows only .env files, and none inside a fixed secret path', () => {
    const inSsh = { ...base, checkout: '/home/me/.ssh/app', cardDir: '/home/me/.ssh/app/.tasks/APP-1', exceptions: ['/home/me/.ssh/app/.env.test'] };
    expect(wallSpecFor(inSsh).envExceptions).toEqual([]);
    expect(wallSpecFor({ ...base, exceptions: ['/work/app/.env.test', '/work/app/src/recipe.ts'] }).envExceptions).toEqual(['/work/app/.env.test']);
  });

  it('maps a hidden path of the real checkout onto the QA copy', () => {
    const qa = { ...base, policy: { readOnly: true, commands: true }, checkout: '/data/qa-copies/qa-APP-1-0a1b2c3d', copyOf: '/work/app', lists };
    expect(wallSpecFor(qa).hidden).toEqual(expect.arrayContaining(['/work/app/secrets', '/data/qa-copies/qa-APP-1-0a1b2c3d/secrets', '/srv/keys']));
  });
});

// The session files a run must write that still start something later outside the wall.
describe('the watched engine files', () => {
  const part = (vendor: 'claude-code' | 'cursor', value: unknown) => {
    const [file] = watchedFilesOf({ vendor, home: '/home/me' });
    return file?.part(value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))) ?? '';
  };

  it("reads Claude Code's MCP servers and hooks, at the top and per project, and nothing else", () => {
    const none = part('claude-code', null);
    // Claude Code writes an empty entry for every new folder it runs in, and its own counters.
    expect(part('claude-code', { numStartups: 4, projects: { '/work/app': { mcpServers: {}, allowedTools: [], enabledMcpjsonServers: [] } } })).toBe(none);
    expect(part('claude-code', { mcpServers: { x: { command: 'sh' } } })).not.toBe(none);
    expect(part('claude-code', { projects: { '/work/app': { mcpServers: { x: { command: 'sh' } } } } })).not.toBe(none);
    expect(part('claude-code', { hooks: { Stop: [] }, projects: { '/a': { enableAllProjectMcpServers: true } } })).not.toBe(none);
    expect(part('claude-code', { projects: { '/a': { disabledMcpjsonServers: ['x'] } } })).not.toBe(none);
    // Moved keys read the same.
    expect(part('claude-code', { mcpServers: { a: { command: 'x', args: [] } } })).toBe(part('claude-code', { mcpServers: { a: { args: [], command: 'x' } } }));
    expect(part('claude-code', 'not json')).not.toBe(none);
  });

  it("reads Cursor's permissions", () => {
    expect(part('cursor', { version: 1, editor: { vimMode: true } })).toBe(part('cursor', null));
    expect(part('cursor', { permissions: { allow: ['Shell(*)'], deny: [] } })).not.toBe(part('cursor', null));
  });

  it('watches no Codex file', () => {
    expect(watchedFilesOf({ vendor: 'codex', home: '/home/me' })).toEqual([]);
  });
});

describe('appWallSpec', () => {
  const app = { checkout: '/work/app/.worktrees/APP-1', gitCommonDir: '/work/app/.git', gitOwnDir: '/work/app/.git/worktrees/APP-1', home: '/home/me', tmp: '/tmp/nolzu-run', exceptions: [] };

  // The app writes its caches into the checkout, and nothing in the home folder unless the project lists it.
  it('opens the checkout, the temp folder and the listed caches only', () => {
    expect(appWallSpec({ ...app, lists: { hidden: [], writable: ['/home/me/.npm'] } }).writable).toEqual(['/tmp/nolzu-run', '/work/app/.worktrees/APP-1', '/home/me/.npm']);
    expect(appWallSpec({ ...app, caches: '/home/me/.nolzu/caches' }).writable).toEqual(['/tmp/nolzu-run', '/work/app/.worktrees/APP-1', '/home/me/.nolzu/caches']);
  });

  it("holds the checkout's git hooks, config and pointers, and the engine config folders", () => {
    const spec = appWallSpec(app);
    expect(spec.writeDenied).toEqual(expect.arrayContaining(['/work/app/.git/hooks', '/work/app/.git/config', '/work/app/.worktrees/APP-1/.claude', '/work/app/.worktrees/APP-1/.codex']));
    expect(spec.writeDeniedLiteral).toEqual(expect.arrayContaining(['/work/app/.worktrees/APP-1', '/work/app/.worktrees/APP-1/.git', '/work/app/.git/worktrees/APP-1/commondir']));
  });

  // The app is no engine, so it sees no engine's login, and no secret a run would not see.
  it("hides every engine's login, the fixed secrets and the .env files of the checkout and the main project", () => {
    const spec = appWallSpec({ ...app, exceptions: ['/work/app/.worktrees/APP-1/.env.test', '/work/app/.worktrees/APP-1/notes.txt', '/elsewhere/.env'] });
    for (const row of Object.values(ENGINE_WALLS)) for (const login of row.logins) expect(spec.hidden).toContain(`/home/me/${login.slice(2)}`);
    for (const path of HIDDEN_FOR_EVERY_RUN) expect(spec.hidden).toContain(`/home/me/${path.slice(2)}`);
    expect(spec.envRoots).toEqual(['/work/app/.worktrees/APP-1', '/work/app']);
    expect(spec.envExceptions).toEqual(['/work/app/.worktrees/APP-1/.env.test']);
  });

  it("closes Docker's socket on Linux", () => {
    expect(appWallSpec({ ...app, platform: 'linux' }).sockets).toContain('/var/run/docker.sock');
    expect(appWallSpec(app).sockets).toEqual([]);
  });
});

// Claude Code's Read resolves `~` from the account's home and not from HOME. Seen with HOME set to a
// scratch folder: a run asked for /Users/<user>/.ssh/config, which the wall did not hold. So every
// fixed hidden path is hidden under both, once when they are the same folder.
describe('the account home and HOME', () => {
  const fixedUnder = (spec: { hidden: readonly string[] }, home: string) => spec.hidden.filter((path) => path.startsWith(`${home}/`));

  it('hides the fixed paths under both homes when HOME is another folder', () => {
    const spec = wallSpecFor({ ...base, home: '/tmp/demo', systemHome: '/Users/me' });
    expect(spec.hidden).toEqual(expect.arrayContaining(['/tmp/demo/.ssh', '/Users/me/.ssh', '/tmp/demo/.aws', '/Users/me/.aws']));
    expect(fixedUnder(spec, '/Users/me').length).toBe(fixedUnder(spec, '/tmp/demo').length);
    const app = appWallSpec({ checkout: '/work/app', home: '/tmp/demo', systemHome: '/Users/me', tmp: '/tmp/nolzu-run', exceptions: [] });
    expect(app.hidden).toEqual(expect.arrayContaining(['/tmp/demo/.ssh', '/Users/me/.ssh']));
  });

  it('hides each path once when HOME is the account home', () => {
    const one = wallSpecFor({ ...base, home: '/Users/me' });
    const both = wallSpecFor({ ...base, home: '/Users/me', systemHome: '/Users/me' });
    expect(both.hidden).toEqual(one.hidden);
    expect(both.hidden.filter((path) => path === '/Users/me/.ssh')).toHaveLength(1);
  });

  // A container can run under an id with no passwd entry, where the account's home cannot be read.
  it('falls back to HOME alone when the account home cannot be read', () => {
    expect(
      systemHome(() => {
        throw new Error('ENOENT: no such file or directory, uv_os_get_passwd');
      }),
    ).toBeUndefined();
    expect(systemHome(() => '')).toBeUndefined();
    expect(systemHome(() => '/Users/me')).toBe('/Users/me');
    expect(wallSpecFor({ ...base, home: '/tmp/demo', systemHome: systemHome(() => { throw new Error('no passwd'); }) }).hidden.some((path) => path.startsWith('/Users/'))).toBe(false);
  });

  // Both backends read the same hidden list, so the account's ~/.ssh closes on macOS and on Linux.
  it('closes the account home\'s ~/.ssh in the macOS profile and in bubblewrap', () => {
    const spec = wallSpecFor({ ...base, home: '/tmp/demo', systemHome: '/Users/me' });
    expect(seatbeltProfile(spec)).toContain('(deny file-read* file-write* (subpath "/Users/me/.ssh"))');
    const args = bwrapArgs(spec, (path) => (path === '/Users/me/.ssh' ? 'dir' : spec.writable.includes(path) ? 'dir' : null), []);
    expect(Array.isArray(args) && args.join(' ').includes('--tmpfs /Users/me/.ssh')).toBe(true);
  });
});
