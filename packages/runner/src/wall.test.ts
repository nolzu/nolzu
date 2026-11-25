import { describe, expect, it } from 'vitest';
import { bwrapArgs, seatbeltProfile, wallCommand, type PathKind, type WallSpec } from './wall.ts';

const spec: WallSpec = {
  writable: ['/work/app/.tasks/APP-1', '/home/me/.claude'],
  hidden: ['/home/me/.ssh', '/home/me/.netrc'],
  writeDenied: ['/home/me/.claude/settings.json'],
  envRoots: ['/work/app'],
  envExceptions: ['/work/app/.env.test'],
};

const kinds: Record<string, PathKind> = {
  '/work/app/.tasks/APP-1': 'dir',
  '/home/me/.claude': 'dir',
  '/home/me/.ssh': 'dir',
  '/home/me/.netrc': 'file',
  '/home/me/.claude/settings.json': 'file',
  '/work/app/.env': 'file',
  '/work/app/.env.test': 'file',
};
const kindOf = (path: string): PathKind | null => kinds[path] ?? null;

describe('seatbeltProfile', () => {
  it('denies every write, then allows, then hides, then denies writes again, in that order', () => {
    const lines = seatbeltProfile(spec).split('\n');
    const at = (text: string) => {
      const index = lines.findIndex((line) => line.includes(text));
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    // In SBPL the last matching rule wins, so each later group must come after the one it overrides.
    const denyAll = at('(deny file-write* (subpath "/"))');
    const always = at('(literal "/dev/null")');
    const card = at('(allow file-write* (subpath "/work/app/.tasks/APP-1"))');
    const ssh = at('(deny file-read* file-write* (subpath "/home/me/.ssh"))');
    const env = at('(deny file-read* file-write* (regex "/\\\\.env(\\\\.[^/]*)?$"))');
    const exception = at('(allow file-read* (literal "/work/app/.env.test"))');
    const settings = at('(deny file-write* (subpath "/home/me/.claude/settings.json"))');
    expect(denyAll).toBeLessThan(always);
    expect(always).toBeLessThan(card);
    expect(card).toBeLessThan(ssh);
    expect(ssh).toBeLessThan(env);
    expect(env).toBeLessThan(exception);
    expect(exception).toBeLessThan(settings);
  });

  it('denies writes to the exact git pointer paths last, by name and with nothing under them', () => {
    const lines = seatbeltProfile({ ...spec, writeDeniedLiteral: ['/work/app', '/work/app/.git'] }).split('\n');
    const checkout = lines.indexOf('(deny file-write* (literal "/work/app"))');
    const dotGit = lines.indexOf('(deny file-write* (literal "/work/app/.git"))');
    const settings = lines.indexOf('(deny file-write* (subpath "/home/me/.claude/settings.json"))');
    expect(checkout).toBeGreaterThan(settings);
    expect(dotGit).toBeGreaterThan(settings);
  });

  it('refuses a symbolic link and a hard link made in a no-link place, last, and nothing else there', () => {
    const lines = seatbeltProfile({ ...spec, writable: [...spec.writable, '/work/app/.git'], noLinks: ['/work/app/.git'] }).split('\n');
    const symlink = lines.indexOf('(deny file-write-create (require-all (subpath "/work/app/.git") (vnode-type SYMLINK)))');
    const hard = lines.indexOf('(deny file-link (subpath "/work/app/.git"))');
    const open = lines.indexOf('(allow file-write* (subpath "/work/app/.git"))');
    expect(open).toBeGreaterThan(-1);
    expect(symlink).toBeGreaterThan(open);
    expect(hard).toBeGreaterThan(open);
    expect(lines.filter((line) => line.includes('/work/app/.git'))).toHaveLength(3);
  });

  it('opens a terminal only to the run that made it, and lets no run issue that right itself', () => {
    const lines = seatbeltProfile(spec).split('\n');
    const denyRead = lines.indexOf('(deny file-read-data (regex "^/dev/ttys[0-9]+$"))');
    const denyRevoke = lines.indexOf('(deny file-revoke)');
    const own = lines.indexOf('(allow file-read-data file-write* file-revoke (require-all (regex "^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))');
    expect(denyRead).toBeGreaterThan(lines.indexOf('(deny file-write* (subpath "/"))'));
    expect(denyRevoke).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(denyRead);
    expect(own).toBeGreaterThan(denyRevoke);
    expect(lines).toContain('(deny file-issue-extension (extension-class "com.apple.sandbox.pty"))');
  });

  it('stops app opens and Apple events after the file rules', () => {
    const lines = seatbeltProfile(spec).split('\n');
    // launchd starts an opened app outside the sandbox, and an Apple event drives an app that is outside it.
    const lsopen = lines.indexOf('(deny lsopen)');
    const appleevent = lines.indexOf('(deny appleevent-send)');
    const lastFile = lines.findLastIndex((line) => line.includes('file-'));
    expect(lsopen).toBeGreaterThan(lastFile);
    expect(appleevent).toBeGreaterThan(lastFile);
  });

  it('denies a connect to a Docker or Podman socket wherever it lives', () => {
    const profile = seatbeltProfile(spec);
    expect(profile).toContain('(deny network-outbound (remote unix-socket (regex "/(docker|podman)[^/]*\\\\.sock$")))');
    expect(profile).toContain('(deny file-write* (regex "/(docker|podman)[^/]*\\\\.sock$"))');
    const rule = new RegExp('/(docker|podman)[^/]*\\.sock$');
    for (const path of ['/Users/me/.docker/run/docker.sock', '/Users/me/Library/Containers/com.docker.docker/Data/docker.raw.sock', '/private/var/folders/x/T/podman/podman-machine-default-api.sock', '/Users/me/.colima/default/docker.sock']) {
      expect(rule.test(path)).toBe(true);
    }
    expect(rule.test('/private/tmp/app.sock')).toBe(false);
  });

  it('keeps what every process writes open', () => {
    const profile = seatbeltProfile(spec);
    for (const rule of [
      '(literal "/dev/null")',
      '(literal "/dev/ptmx")',
      '(literal "/dev/tty")',
      '(literal "/dev/dtracehelper")',
      '(subpath "/dev/fd")',
      '(subpath "/private/tmp")',
      '(subpath "/private/var/folders")',
    ]) {
      expect(profile).toContain(rule);
    }
  });

  it('holds a write-denied path with a star as a pattern of one folder name', () => {
    const profile = seatbeltProfile({ ...spec, writeDenied: ['/home/me/.claude/projects/*/memory'] });
    expect(profile).toContain('(deny file-write* (regex "^/home/me/\\\\.claude/projects/[^/]+/memory(/|$)"))');
    const rule = new RegExp('^/home/me/\\.claude/projects/[^/]+/memory(/|$)');
    expect(rule.test('/home/me/.claude/projects/-work-app/memory/m.md')).toBe(true);
    expect(rule.test('/home/me/.claude/projects/-work-app/memory')).toBe(true);
    expect(rule.test('/home/me/.claude/projects/-work-app/session.jsonl')).toBe(false);
    expect(rule.test('/home/me/.claude/projects/a/b/memory')).toBe(false);
  });

  it('holds an exact path with a star against a rename or delete only', () => {
    const profile = seatbeltProfile({ ...spec, writeDeniedLiteral: ['/home/me/.claude/projects/*', '/home/me/.claude/projects'] });
    expect(profile).toContain('(deny file-write-unlink (regex "^/home/me/\\\\.claude/projects/[^/]+$"))');
    expect(profile).toContain('(deny file-write* (literal "/home/me/.claude/projects"))');
  });

  it('escapes a backslash and a double quote inside a string', () => {
    const profile = seatbeltProfile({ ...spec, writable: ['/work/a"b\\c'] });
    expect(profile).toContain('(allow file-write* (subpath "/work/a\\"b\\\\c"))');
  });

  it('hides .env files by name only when there is a root to hide them under', () => {
    expect(seatbeltProfile({ ...spec, envRoots: [] })).not.toContain('.env(');
  });

  it('gives an exception its writes back only inside a writable folder', () => {
    const profile = seatbeltProfile({ ...spec, envExceptions: ['/work/app/.env.test', '/work/app/.tasks/APP-1/.env.local'] });
    expect(profile).toContain('(allow file-read* (literal "/work/app/.env.test"))');
    expect(profile).toContain('(allow file-read* file-write* (literal "/work/app/.tasks/APP-1/.env.local"))');
  });
});

describe('bwrapArgs', () => {
  it('binds the root read-only, then writable paths, then hides, then write-denies', () => {
    expect(bwrapArgs(spec, kindOf, ['/work/app/.env'])).toEqual([
      '--die-with-parent',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--bind', '/work/app/.tasks/APP-1', '/work/app/.tasks/APP-1',
      '--bind', '/home/me/.claude', '/home/me/.claude',
      '--tmpfs', '/home/me/.ssh',
      '--ro-bind', '/dev/null', '/home/me/.netrc',
      '--ro-bind', '/dev/null', '/work/app/.env',
      '--ro-bind', '/home/me/.claude/settings.json', '/home/me/.claude/settings.json',
    ]);
  });

  it('binds a pointer file read-only and a writable pointer folder onto itself, before the write-denied paths', () => {
    const more: Record<string, PathKind> = { '/work/app': 'dir', '/work/app/.git': 'file', '/work/app/.tasks/APP-1/wt': 'dir', '/srv/repo': 'dir' };
    const at = (path: string) => more[path] ?? kindOf(path);
    const args = bwrapArgs({ ...spec, writeDeniedLiteral: ['/work/app/.git', '/work/app/.tasks/APP-1/wt', '/srv/repo', '/work/app/.git/commondir'] }, at, []);
    expect(Array.isArray(args)).toBe(true);
    const text = (args as string[]).join(' ');
    expect(text).toContain('--ro-bind /work/app/.git /work/app/.git');
    // A mount point cannot be renamed or removed, and the writes inside it stay open.
    expect(text).toContain('--bind /work/app/.tasks/APP-1/wt /work/app/.tasks/APP-1/wt');
    // A folder outside the writable places is read-only already, and binding it would open it.
    expect(text).not.toContain('/srv/repo');
    expect(text).not.toContain('commondir');
    expect(text.indexOf('/work/app/.tasks/APP-1/wt')).toBeLessThan(text.indexOf('--ro-bind /home/me/.claude/settings.json'));
  });

  it('binds /dev/null over a closed unix socket', () => {
    const args = bwrapArgs({ ...spec, sockets: ['/run/docker.sock'] }, (path) => (path === '/run/docker.sock' ? 'file' : 'dir'), []);
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', '/run/docker.sock']));
  });

  it('never unshares the network', () => {
    const args = bwrapArgs(spec, kindOf, []);
    expect(Array.isArray(args) && args.some((arg) => arg === '--unshare-net' || arg.startsWith('--unshare-all'))).toBe(false);
  });

  it('refuses a writable path that does not exist rather than creating it', () => {
    expect(bwrapArgs({ ...spec, writable: ['/home/me/.codex'] }, kindOf, [])).toEqual({
      refused: expect.stringContaining('/home/me/.codex does not exist'),
    });
  });

  it('skips hidden and write-denied paths that are not there', () => {
    const args = bwrapArgs({ ...spec, hidden: ['/home/me/.aws'], writeDenied: ['/home/me/.claude/hooks'] }, kindOf, []);
    expect(args).not.toContain('/home/me/.aws');
    expect(args).not.toContain('/home/me/.claude/hooks');
  });

  it('leaves the secret exceptions readable', () => {
    const args = bwrapArgs(spec, kindOf, ['/work/app/.env', '/work/app/.env.test']);
    expect(args).toContain('/work/app/.env');
    expect(args).not.toContain('/work/app/.env.test');
  });

  it('does not bind a write-denied path back into a hidden folder', () => {
    const args = bwrapArgs({ ...spec, writeDenied: ['/home/me/.ssh/config'] }, (path) => (path === '/home/me/.ssh/config' ? 'file' : kindOf(path)), []);
    expect(args).not.toContain('/home/me/.ssh/config');
  });
});

describe('wallCommand', () => {
  it('runs the engine under sandbox-exec on macOS', () => {
    const out = wallCommand('darwin', spec, '/usr/local/bin/claude', ['-p', 'hi']);
    expect(out).toEqual({
      command: '/usr/bin/sandbox-exec',
      args: ['-p', seatbeltProfile(spec), '/usr/local/bin/claude', '-p', 'hi'],
    });
  });

  it('writes the private path macOS resolves /tmp and /var to', () => {
    const out = wallCommand('darwin', { ...spec, writable: ['/var/folders/x/T/run', '/tmp/run'] }, '/bin/sh', []);
    expect('args' in out && out.args[1]).toContain('(allow file-write* (subpath "/private/var/folders/x/T/run"))');
    expect('args' in out && out.args[1]).toContain('(allow file-write* (subpath "/private/tmp/run"))');
  });

  it('runs the engine under bwrap on Linux, after a -- so the command cannot read as a flag', () => {
    const out = wallCommand('linux', spec, '/usr/bin/claude', ['-p'], { kindOf, envFiles: [], bwrap: '/usr/bin/bwrap' });
    expect(out).toEqual({ command: '/usr/bin/bwrap', args: [...(bwrapArgs(spec, kindOf, []) as string[]), '--', '/usr/bin/claude', '-p'] });
  });

  it('keeps the closed sockets on the way to bwrap', () => {
    const out = wallCommand('linux', { ...spec, sockets: ['/run/docker.sock/'] }, '/bin/sh', [], { kindOf: () => 'file', envFiles: [], bwrap: '/usr/bin/bwrap' });
    expect('args' in out && out.args.join(' ')).toContain('--ro-bind /dev/null /run/docker.sock');
  });

  it('refuses on Linux when nobody listed the .env files', () => {
    expect(wallCommand('linux', spec, '/bin/sh', [], { kindOf })).toEqual({ refused: expect.stringContaining('.env') });
  });

  it('refuses on Linux without a way to look at the paths', () => {
    expect('refused' in wallCommand('linux', spec, '/bin/sh', [], { envFiles: [] })).toBe(true);
  });

  // Native Windows never gets here: the nolzu command stops at start there and points to WSL2.
  it('refuses any other system', () => {
    expect(wallCommand('win32', spec, 'claude', [])).toEqual({ refused: expect.stringContaining('macOS and Linux') });
    expect(wallCommand('freebsd', spec, 'claude', [])).toEqual({ refused: expect.stringContaining('freebsd') });
  });

  it('refuses a second wall inside one that is already there', () => {
    expect(wallCommand('darwin', spec, 'codex', [], { alreadyWalled: true })).toEqual({
      refused: expect.stringContaining('already'),
    });
  });

  it('refuses a relative path, which the wall would read against an unknown folder', () => {
    expect(wallCommand('darwin', { ...spec, hidden: ['.ssh'] }, 'claude', [])).toEqual({
      refused: expect.stringContaining('.ssh'),
    });
  });
});

// A Claude Code run's own folder in the hidden `mcp-runs` stays readable, never writable, and no
// other folder there shows.
describe('a folder reopened inside a hidden one', () => {
  const runs = '/data/mcp-runs';
  const own = '/data/mcp-runs/1-1';
  const reopened: WallSpec = { ...spec, hidden: [...spec.hidden, runs], reopened: [own] };

  it('allows reading it again after the deny on macOS, and no write', () => {
    const lines = seatbeltProfile(reopened).split('\n');
    const deny = lines.indexOf(`(deny file-read* file-write* (subpath "${runs}"))`);
    const allow = lines.indexOf(`(allow file-read* (subpath "${own}"))`);
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
    expect(lines.some((line) => line.includes('allow file-write*') && line.includes(own))).toBe(false);
  });

  it('refuses a reopened path that sits inside no hidden folder', () => {
    for (const platform of ['darwin', 'linux']) {
      const refused = wallCommand(platform, { ...spec, reopened: ['/work/app/src'] }, 'claude', [], { kindOf, envFiles: [] });
      expect(refused).toEqual({ refused: 'The wall cannot start: /work/app/src is opened again, but sits inside no hidden folder.' });
      expect(wallCommand(platform, { ...spec, hidden: [...spec.hidden, runs], reopened: [runs] }, 'claude', [], { kindOf, envFiles: [] })).toMatchObject({ refused: expect.stringContaining('sits inside no hidden folder') });
    }
  });

  it('binds it read-only over the tmpfs that hides its parent on Linux', () => {
    const at = (path: string): PathKind | null => (path === runs || path === own ? 'dir' : kindOf(path));
    const args = bwrapArgs(reopened, at, []);
    if (!Array.isArray(args)) throw new Error('refused');
    const tmpfs = args.findIndex((arg, index) => arg === '--tmpfs' && args[index + 1] === runs);
    const bind = args.findIndex((arg, index) => arg === '--ro-bind' && args[index + 1] === own && args[index + 2] === own);
    expect(tmpfs).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(tmpfs);
  });
});
