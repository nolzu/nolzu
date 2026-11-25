import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { findExecutable, mergePath, parseEnvDump, resolveShellPath, startPath } from './shell-env.ts';

// The PATH separator is a colon on macOS and Linux, the two systems Nolzu runs on.
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-path-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('reads a value with spaces, one with quotes and one holding an equals sign', () => {
  const dump = 'HOME=/home/dev\nGREETING=hello there\nQUOTED="keep me"\nFLAGS=-a=1 -b=2\n';
  expect(parseEnvDump(dump)).toEqual({
    HOME: '/home/dev',
    GREETING: 'hello there',
    QUOTED: '"keep me"',
    FLAGS: '-a=1 -b=2',
  });
});

it('ignores a line with no name, such as the tail of a value that spans lines', () => {
  const dump = 'PATH=/usr/bin\nthis line continues the value above\n=orphan\nHOME=/home/dev\n';
  expect(parseEnvDump(dump)).toEqual({ PATH: '/usr/bin', HOME: '/home/dev' });
});

it('keeps the current entries first and appends only what the shell adds', () => {
  expect(mergePath('/usr/bin:/bin', '/opt/tools/bin:/usr/bin:/opt/extra/bin')).toBe(
    '/usr/bin:/bin:/opt/tools/bin:/opt/extra/bin',
  );
});

it('drops duplicates and empty segments', () => {
  expect(mergePath('/usr/bin::/bin:/usr/bin', '/bin:::/opt/tools/bin')).toBe('/usr/bin:/bin:/opt/tools/bin');
});

it('returns the first match and skips a directory that carries the name', () => {
  const first = join(dir, 'first');
  const second = join(dir, 'second');
  mkdirSync(first);
  mkdirSync(second);
  // A directory called claude must not win over the real binary further along the PATH.
  mkdirSync(join(first, 'claude'));
  writeFileSync(join(second, 'claude'), '');
  chmodSync(join(second, 'claude'), 0o755);

  expect(findExecutable('claude', `${first}:${second}`)).toBe(join(second, 'claude'));
});

it('skips a file without the executable bit', () => {
  writeFileSync(join(dir, 'claude'), '');
  chmodSync(join(dir, 'claude'), 0o644);

  expect(findExecutable('claude', dir)).toBeNull();
});

it('returns null when the name is nowhere on the path', () => {
  expect(findExecutable('claude', `${dir}:${join(dir, 'missing')}`)).toBeNull();
});


it('keeps the current PATH when the shell environment cannot be read', () => {
  expect(resolveShellPath({ PATH: '/usr/bin' }, { readDump: () => null })).toBe('/usr/bin');
});

it('keeps the current PATH when reading the shell environment throws, such as a timeout', () => {
  const readDump = () => {
    throw new Error('the login shell did not answer');
  };
  expect(resolveShellPath({ PATH: '/usr/bin' }, { readDump })).toBe('/usr/bin');
});

it('keeps the current PATH when the dump carries no PATH of its own', () => {
  const readDump = () => 'HOME=/home/dev\n';
  expect(resolveShellPath({ PATH: '/usr/bin' }, { readDump })).toBe('/usr/bin');
});

it('appends the login shell PATH behind the one the process already has', () => {
  const readDump = () => 'PATH=/opt/tools/bin:/usr/bin\nHOME=/home/dev\n';
  expect(resolveShellPath({ PATH: '/usr/bin' }, { readDump })).toBe('/usr/bin:/opt/tools/bin');
});

it('takes the shell PATH whole when the process has none', () => {
  const readDump = () => 'PATH=/opt/tools/bin\n';
  expect(resolveShellPath({}, { readDump })).toBe('/opt/tools/bin');
});

// A Nolzu started from a LaunchAgent gets the bare system PATH, and git then cannot run gpg for a
// signed commit: "error: cannot run gpg: No such file or directory".
it('starts with the login shell entries after its own, and drops every relative entry', () => {
  const dump = 'PATH=/opt/homebrew/bin:.:bin:node_modules/.bin:/usr/bin\n';
  expect(startPath({ PATH: '/usr/bin:/bin' }, () => dump)).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  expect(startPath({ PATH: '.:/usr/bin' }, () => null)).toBe('/usr/bin');
});

it("lets git find the person's gpg on the start PATH, and not without it", () => {
  const tools = join(dir, 'tools');
  mkdirSync(tools);
  const ran = join(dir, 'gpg-ran');
  writeFileSync(join(tools, 'gpg'), `#!/bin/sh\necho yes > '${ran}'\nexit 1\n`);
  chmodSync(join(tools, 'gpg'), 0o755);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const gitAt = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const commit = (path: string) => {
    const env = { PATH: path, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
    spawnSync(gitAt, ['init', '-q', repo], { env });
    return spawnSync(gitAt, ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=true', 'commit', '-q', '--allow-empty', '-m', 'x'], { env, encoding: 'utf8' });
  };
  // A PATH that holds git and nothing else, so no gpg is on it on any system: Ubuntu ships one in /usr/bin.
  const bare = join(dir, 'only-git');
  mkdirSync(bare);
  symlinkSync(gitAt, join(bare, 'git'));
  expect(commit(bare).stderr).toContain('cannot run gpg');
  expect(existsSync(ran)).toBe(false);
  commit(startPath({ PATH: bare }, () => `PATH=${tools}\n`));
  expect(readFileSync(ran, 'utf8')).toBe('yes\n');
});

// The launcher sets it before the version checks and before the server loads, so every git, gh and
// agent call inherits it.
it('is set by the launcher before anything starts a tool', () => {
  const start = readFileSync(join(import.meta.dirname, '..', '..', '..', 'apps', 'local', 'bin', 'start.js'), 'utf8');
  const at = start.indexOf('process.env.PATH = startPath(process.env);');
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(start.indexOf('detectEngines('));
  expect(at).toBeLessThan(start.indexOf('await import(server)'));
});
