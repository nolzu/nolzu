import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_COMMANDS, gitCall, gitKind, madeFolders } from './commands.ts';

describe('the kind of a git command', () => {
  it.each([
    [['status', '--porcelain'], 'read'],
    [['rev-parse', '--show-toplevel'], 'read'],
    [['diff', '--cached'], 'read'],
    [['log', '-1'], 'read'],
    [['add', '-A'], 'write'],
    [['rm', '-q', '--', 'x'], 'write'],
    [['init', '-q', '-b', 'main'], 'write'],
    [['submodule', 'deinit', '-f', '--', 'x'], 'write'],
    [['commit', '-m', 'x'], 'write'],
    [['update-ref', '-d', 'refs/x'], 'write'],
    [['push', 'origin', 'main'], 'network'],
    [['fetch', 'origin'], 'network'],
    [['pull'], 'network'],
    [['clone', '--', 'url', 'dir'], 'network'],
    [['ls-remote', '--tags', 'origin'], 'network-read'],
  ] as const)('%j is %s', (args, kind) => {
    expect(gitKind(args)).toBe(kind);
  });

  it.each([
    [['branch', '--show-current'], 'read'],
    [['branch'], 'read'],
    [['branch', '--all', '--contains', 'abc123'], 'read'],
    [['branch', '--list', 'APP-*'], 'read'],
    [['branch', '-m', 'a', 'b'], 'write'],
    [['branch', '-D', '--', 'x'], 'write'],
    [['branch', '--quiet', '--track', 'main', 'refs/remotes/origin/main'], 'write'],
    [['branch', 'new-one'], 'write'],
    [['branch', '--list', '-d', 'x'], 'write'],
    [['branch', '--set-upstream-to=origin/main'], 'write'],
  ] as const)('branch: %j is %s', (args, kind) => {
    expect(gitKind(args)).toBe(kind);
  });

  it.each([
    [['config', '--get', 'branch.main.remote'], 'read'],
    [['config', 'core.sshCommand'], 'read'],
    [['config', '--list'], 'read'],
    [['config', '--file', '.gitmodules', '--get-regexp', 'path'], 'read'],
    [['config', 'get', 'core.sshCommand'], 'read'],
    [['config', 'core.hooksPath', '/x'], 'write'],
    [['config', '--unset', 'core.hooksPath'], 'write'],
    [['config', '--add', 'x.y', 'z'], 'write'],
    [['config', 'set', 'x.y', 'z'], 'write'],
    [['config', '--file', '.gitmodules', 'x.y', 'z'], 'write'],
  ] as const)('config: %j is %s', (args, kind) => {
    expect(gitKind(args)).toBe(kind);
  });

  it.each([
    [['remote'], 'read'],
    [['remote', '-v'], 'read'],
    [['remote', 'get-url', '--push', 'origin'], 'read'],
    [['remote', 'add', 'origin', 'url'], 'write'],
    [['remote', 'remove', 'origin'], 'write'],
    [['remote', 'set-url', 'origin', 'url'], 'write'],
    [['remote', 'show', 'origin'], 'write'],
  ] as const)('remote: %j is %s', (args, kind) => {
    expect(gitKind(args)).toBe(kind);
  });

  it.each([
    [['symbolic-ref', '-q', 'HEAD'], 'read'],
    [['symbolic-ref', '--short', '--quiet', 'HEAD'], 'read'],
    [['symbolic-ref', 'HEAD', 'refs/heads/x'], 'write'],
    [['symbolic-ref', '-m', 'why', 'HEAD', 'refs/heads/x'], 'write'],
    [['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], 'write'],
    [['worktree', 'list', '--porcelain'], 'read'],
    [['worktree', 'add', '-b', 'x', '../x', 'main'], 'write'],
    [['worktree', 'remove', '--force', 'x'], 'write'],
    [['worktree', 'unlock', 'x'], 'write'],
  ] as const)('%j is %s', (args, kind) => {
    expect(gitKind(args)).toBe(kind);
  });

  it('reads the subcommand past a leading -C and -c, and counts an unlisted one as a write', () => {
    expect(gitKind(['-C', '/x', 'status'])).toBe('read');
    expect(gitKind(['-c', 'push.default=current', 'push', 'origin'])).toBe('network');
    expect(gitKind(['-C', '/x', '-c', 'a.b=c', 'branch', '-D', 'x'])).toBe('write');
    expect(gitKind(['stash'])).toBe('write');
    expect(gitKind(['gc'])).toBe('write');
    expect(gitKind(['--git-dir=/x', 'status'])).toBe('write');
    expect(gitKind([])).toBe('write');
    expect(gitKind(['toString'])).toBe('write');
    expect(gitCall(['-C', 'a', '-C', 'b', 'status'], '/top')).toEqual({ folder: '/top/a/b', moves: ['a', 'b'], command: 'status', rest: [] });
  });

  it('names the folder init, clone and worktree add make, as git names it, as written', () => {
    const made = (args: readonly string[]) => madeFolders(gitCall(args, '/w'));
    expect(made(['init', '-q', '-b', 'main'])).toEqual(['.']);
    expect(made(['init', '-q', '-b', 'main', 'sub'])).toEqual(['sub']);
    expect(made(['init', '--separate-git-dir', '/elsewhere', 'd'])).toEqual(['d', '/elsewhere']);
    expect(made(['init', '--separate-git-dir=../g', 'd'])).toEqual(['d', '../g']);
    expect(made(['clone', '--no-recurse-submodules', '--progress', '--', 'https://h/a/recipes.git', 'web'])).toEqual(['web']);
    expect(made(['clone', '-b', 'main', 'git@h:a/recipes.git'])).toEqual(['recipes']);
    expect(made(['clone', '--', '/r/api/'])).toEqual(['api']);
    expect(made(['clone', 'https://h/a/repo/.git'])).toEqual(['repo']);
    expect(made(['clone', 'https://h/a/repo.bundle'])).toEqual(['repo']);
    expect(made(['clone', '--bare', 'https://h/a/repo'])).toEqual(['repo.git']);
    expect(made(['clone', '--mirror', 'https://h/a/repo.git/'])).toEqual(['repo.git']);
    expect(made(['worktree', 'add', '-b', 'APP-1-x', '/p/worktrees/APP-1', 'main'])).toEqual(['/p/worktrees/APP-1']);
    expect(made(['worktree', 'list'])).toEqual([]);
    expect(made(['commit'])).toEqual([]);
    expect(gitCall(['-C', 'sub', '-c', 'a.b=c', '-C', '../x', 'init'], '/w').moves).toEqual(['sub', '../x']);
  });

  // git takes an abbreviated long option, and a read command has write forms, so only options a read
  // rule names exactly keep a call a read.
  it.each([
    ['branch', '--sort=refname', 'made'],
    ['branch', '--sort', 'refname', 'made'],
    ['branch', '--format=%(refname)', 'made'],
    ['branch', '-v', 'made'],
    ['branch', '-a', 'made'],
    ['branch', '--show-current', 'made'],
    ['config', '--unset-a', 'e.f'],
    ['config', '--remove', 'a'],
    ['config', '--unse', 'x.y'],
    ['config', 'a.b', '--get'],
    ['config', 'a.b', '-l'],
    ['config', 'set', 'a.b', '--get'],
    ['config', 'set', 'c.d', '-l'],
    ['config', 'unset', 'm.n', '--list'],
    ['config', 'a.b', 'c'],
    ['config', 'edit'],
    ['config', '--file', 'x', '--edit'],
    ['symbolic-ref', '--del', 'refs/x'],
    ['symbolic-ref', '--delete', 'refs/x'],
    ['diff', '--output=/tmp/x'],
    ['diff', '--output', '/tmp/x'],
    ['log', '-1', '--output=/tmp/x'],
    ['show', '--output=/tmp/x', 'HEAD'],
    ['status', '--porc'],
    ['rev-parse', '--git'],
    ['worktree', 'list', '--lock'],
    ['remote', 'get-url', 'origin', 'more'],
  ].map((args) => [args]))('%j writes', (args) => {
    expect(gitKind(args)).toBe('write');
  });

  it('reads the version, and counts ls-remote with a program to run as a network write', () => {
    expect(gitKind(['--version'])).toBe('read');
    expect(gitKind(['version'])).toBe('read');
    expect(gitKind(['--version', '--build-options'])).toBe('read');
    expect(gitKind(['ls-remote', '--upload-pack=touch x', 'origin'])).toBe('network');
  });

  it('keeps every read form the runtime code runs a read', () => {
    for (const args of [
      ['log', '--all', '--source', '--no-merges', '--since=2026-01-01T00:00:00Z', '--until=x', '--format=%H%x09%cI%x09%S%x09%s'],
      ['log', '-n', '50', '--format=%x00%H %cI', '--name-only', '--relative', '--', '.'],
      ['log', '-1', '--format=%h %cs', 'HEAD', '--'],
      ['diff', '--numstat', '-M', 'a...b'],
      ['diff', '--name-only', '-z', '--diff-filter=U'],
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', 'x'],
      ['show', '--no-color', '--format=%cI', '--patch', 'abc', '--', ':(top,literal)x'],
      ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      ['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal'],
      ['status', '--porcelain', '-uall', '--', 'x'],
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      ['rev-parse', '--git-path', 'info/exclude'],
      ['rev-parse', '-q', '--verify', 'HEAD^{commit}'],
      ['rev-list', '--count', '--left-right', 'a...b'],
      ['rev-list', '--max-count=1', '--all', '--not', '--remotes', '--exclude=refs/stash'],
      ['for-each-ref', '--format=%(refname)', '--contains', 'abc', 'refs/heads'],
      ['ls-files', '--stage', '-z', '--full-name', '--', ':/'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
      ['ls-tree', '-t', '-z', '--name-only', '--end-of-options', 'main', '--', 'x'],
      ['show-ref', '--tags', '-d'],
      ['check-ignore', '-v', '--no-index', '--', 'x'],
      ['cat-file', '-e', 'abc:x'],
      ['merge-base', '--is-ancestor', 'a', 'b'],
      ['describe', '--tags', '--exact-match'],
      ['var', 'GIT_AUTHOR_IDENT'],
      ['branch', '--contains', 'HEAD', 'APP-*'],
      ['branch', '--no-merged', 'HEAD', 'made'],
      ['branch', '--sort=refname'],
      ['symbolic-ref', '--short', '--quiet', 'HEAD'],
      ['config', '--get', 'branch.main.remote'],
      ['config', 'core.sshCommand'],
      ['config', '--get', 'x.y', '--unset'],
      ['config', '--file', '.gitmodules', '--get-regexp', 'path'],
      ['config', 'get', '--all', 'a.b'],
    ]) {
      expect([args, gitKind(args)]).toEqual([args, 'read']);
    }
  });
});

// Words a scan of the runtime code finds where a git subcommand could be, which are not one: gh
// subcommands, card phases, stdio settings and folder names.
const NOT_GIT = new Set(['api', 'code', 'design', 'hidden', 'ignore', 'implement', 'mockups', 'pr', 'qa', 'rebase-apply', 'rebase-merge', 'repo']);

// A literal argument list, past any `-C` or `-c` pair, not an index such as `options['status']`.
// Limit: an argument list built at run time from variables is not seen.
const LITERAL = /(?<![\w\])'"`.])\[\s*(?:'-[Cc]',\s*[^,[\]]+,\s*)*'([a-z][a-z-]*)'|GIT_FLAGS,\s*'([a-z][a-z-]*)'/g;
// A file that runs git: through `git()`, a wrapper typed `RunGit`, a `.run([...])` helper, or a spawn.
const RUNS_GIT = /\bgit\(|\bRunGit\b|\brunClone\(|\bspawnGit\(|\bGIT_FLAGS\b|\.run\(\s*\[/;

function runtimeFiles(): string[] {
  const root = resolve(import.meta.dirname, '../../../..');
  return ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(root, top)).flatMap((name) => {
      const src = join(root, top, name, 'src');
      let found: string[];
      try {
        found = readdirSync(src, { recursive: true, encoding: 'utf8' });
      } catch {
        return [];
      }
      return found.filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.split('/').includes('node_modules')).map((path) => join(src, path));
    }),
  );
}

it('lists every git subcommand the runtime code runs', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const unlisted: string[] = [];
  const seen = new Set<string>();
  for (const file of runtimeFiles()) {
    const text = readFileSync(file, 'utf8');
    if (!RUNS_GIT.test(text)) continue;
    for (const match of text.matchAll(LITERAL)) {
      const word = match[1] ?? match[2] ?? '';
      seen.add(word);
      if (!Object.hasOwn(GIT_COMMANDS, word) && !NOT_GIT.has(word)) unlisted.push(`${relative(root, file)}: ${word}`);
    }
  }
  expect(unlisted).toEqual([]);
  // The scan reaches the calls it is meant to, so a change that blinds it fails here too.
  for (const word of ['rev-parse', 'push', 'clone', 'ls-remote', 'submodule', 'log']) expect(seen).toContain(word);
});
