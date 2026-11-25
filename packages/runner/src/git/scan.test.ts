import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { MACHINE_ROOTS, scanMachine, scanProject } from './scan.ts';

let repo: TempRepo;
let base: string;

beforeEach(() => {
  repo = tempRepo('nolzu-scan-');
  base = dirname(repo.dir);
});

afterEach(() => {
  repo.remove();
});

const scan = (folder: string, branchTemplate = '{key}-{slug}') =>
  scanProject(folder, { branchTemplate, env: repo.env });

// A plain folder holding repositories one level down, which is the multi repo shape.
function projects(...names: readonly string[]): string {
  const root = join(base, 'projects');
  mkdirSync(root, { recursive: true });
  for (const name of names) {
    const at = join(root, name);
    mkdirSync(at, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', at], { env: repo.env });
  }
  return root;
}

const plain = (name: string): string => {
  const at = join(base, name);
  mkdirSync(at, { recursive: true });
  return at;
};

it('reports a folder with .git as one repository', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos).toHaveLength(1);
  expect(result.repos[0]?.path).toBe('.');
});

// A root repository can hold its own repositories one level down, ignored by it or as submodules.
it('lists a root repository first, then its child repositories in name order, each with its own base', async () => {
  repo.write('.gitignore', 'web/\napi/\n');
  repo.write('notes/a.md', 'a\n');
  repo.commit('first');
  for (const [name, branch] of [['web', 'main'], ['api', 'develop']] as const) {
    execFileSync('git', ['init', '-q', '-b', branch, join(repo.dir, name)], { env: repo.env });
  }

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => [found.path, found.base])).toEqual([
    ['.', { kind: 'branch', name: 'main' }],
    ['api', { kind: 'unborn', name: 'develop' }],
    ['web', { kind: 'unborn', name: 'main' }],
  ]);
});

it('lists a submodule of a root repository, and skips one that was never fetched', async () => {
  const source = join(base, 'lib-source');
  execFileSync('git', ['init', '-q', '-b', 'main', source], { env: repo.env });
  execFileSync('git', ['-C', source, 'commit', '-q', '--allow-empty', '-m', 'first'], { env: repo.env });
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'lib');
  repo.commit('add lib');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => [found.path, found.base])).toEqual([
    ['.', { kind: 'branch', name: 'main' }],
    ['lib', { kind: 'branch', name: 'main' }],
  ]);

  // A clone without its submodules has an empty lib folder, which belongs to the root.
  const clone = join(base, 'clone');
  execFileSync('git', ['clone', '-q', repo.dir, clone], { env: repo.env });
  const cloned = await scan(clone);
  expect(cloned.ok && cloned.repos.map((found) => found.path)).toEqual(['.']);
});

// A child that links back to the root is the root under a second name.
it('does not list a root repository twice through a link to itself', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  symlinkSync('.', join(repo.dir, 'self'));

  const result = await scan(repo.dir);

  expect(result.ok && result.repos.map((found) => found.path)).toEqual(['.']);
});

// A linked worktree of the root has its own top level, but it is the root's repository.
it('does not list a linked worktree of a root repository as a child', async () => {
  repo.write('.gitignore', 'wt/\n');
  repo.commit('first');
  repo.run('worktree', 'add', '-q', '-b', 'feature', join(repo.dir, 'wt'));

  const result = await scan(repo.dir);

  expect(result.ok && result.repos.map((found) => found.path)).toEqual(['.']);
});

it('names every repository one level down', async () => {
  const root = projects('api', 'web', 'docs');

  const result = await scan(root);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => found.path).sort()).toEqual(['api', 'docs', 'web']);
});

// git walks up until it finds a repository, so a plain folder inside one answers with that
// parent. A folder that sits inside a checkout is where trusting the answer turns the folder
// itself, and every plain child of it, into a project.
it('ignores the parent repository git answers with for a plain folder', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  const inside = join(repo.dir, 'projects');
  mkdirSync(join(inside, 'notes'), { recursive: true });
  const nested = join(inside, 'api');
  mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', nested], { env: repo.env });

  const result = await scan(inside);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Not ["."], which is what the outer checkout would make it, and not "notes".
  expect(result.repos.map((found) => found.path)).toEqual(['api']);
});

it('says there is no repository when the folder holds none', async () => {
  const result = await scan(plain('empty'));

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('No git repository here');
});

it('stops at one level, so a repository two levels down is not found', async () => {
  const root = plain('deep');
  const inner = join(root, 'mid', 'inner');
  mkdirSync(inner, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', inner], { env: repo.env });

  const result = await scan(root);

  expect(result.ok).toBe(false);
});

it('resolves an https and a git@ remote to the same host, owner and repository', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  repo.run('remote', 'add', 'mirror', 'git@github.com:acme/widgets.git');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remotes = result.repos[0]?.remotes ?? [];
  expect(remotes).toHaveLength(2);
  for (const remote of remotes) {
    expect(remote.supported).toBe(true);
    if (!remote.supported) continue;
    expect([remote.host, remote.owner, remote.repo]).toEqual(['github', 'acme', 'widgets']);
  }
  expect(remotes.map((remote) => remote.name).sort()).toEqual(['mirror', 'origin']);
});

// A GitLab group can nest, so everything between the host and the last part is the owner.
// Keeping only the first part would point at a repository that does not exist.
it('keeps a nested GitLab group as the owner', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'ssh://git@gitlab.com/group/sub/widgets.git');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  expect(remote?.supported).toBe(true);
  if (remote?.supported !== true) return;
  expect([remote.host, remote.owner, remote.repo]).toEqual(['gitlab', 'group/sub', 'widgets']);
});

it('reports a remote on an unknown host with its raw URL and not supported', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'git@example.invalid:team/tool.git');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  expect(remote?.supported).toBe(false);
  if (remote?.supported !== false) return;
  expect(remote.name).toBe('origin');
  expect(remote.url).toBe('git@example.invalid:team/tool.git');
});

// The checked out branch is deliberately not the one origin points at, so a scan that read
// the checkout would pass this test by accident.
it('takes the base branch from the origin HEAD reference when it exists', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
  repo.run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  repo.run('checkout', '-q', '-b', 'local-work');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos[0]?.base).toEqual({ kind: 'branch', name: 'main' });
});

it('falls back to the checked out branch when there is no origin HEAD', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('checkout', '-q', '-b', 'feature/demo');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos[0]?.base).toEqual({ kind: 'branch', name: 'feature/demo' });
});

it('reports the commit when HEAD is detached, so the person picks the base', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.write('b.txt', 'b\n');
  repo.commit('second');
  const head = repo.run('rev-parse', 'HEAD').trim();
  repo.run('checkout', '-q', '--detach', 'HEAD');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos[0]?.base).toEqual({ kind: 'detached', commit: head });
});

it('previews the branch name a card would get from the template', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');

  const result = await scan(repo.dir, 'feature/{key}-{slug}');

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.branchPreview.ok).toBe(true);
  if (!result.branchPreview.ok) return;
  expect(result.branchPreview.name).toBe('feature/PROJ-123-example-card');
});

// A folder that is gone reaches git as a bad cwd, and spawn reports that as ENOENT, the same
// code a missing binary gives. Left to the git helper it reads as "git is not installed",
// which sends the person to reinstall a git that works.
it('names the missing folder instead of blaming git', async () => {
  const result = await scan(join(base, 'gone'));

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('gone');
  expect(result.reason).not.toContain('PATH');
});

// A clone made by CI, or one set up with a token, carries the credential in the remote URL. An
// unsupported remote keeps its URL, so without stripping it the secret lands in whatever shows or
// logs the result. Secrets belong in the keychain and never in the repository, the database or a log.
it('keeps a credential out of the URL it reports for an unsupported remote', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://ci:glpat-SECRET123@gitlab.acme.invalid/team/tool.git');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  expect(remote?.supported).toBe(false);
  if (remote?.supported !== false) return;
  expect(remote.url).not.toContain('glpat-SECRET123');
  expect(remote.url).not.toContain('ci:');
  // The rest of the URL still has to be there, or the person cannot tell which remote it was.
  expect(remote.url).toContain('gitlab.acme.invalid/team/tool.git');
});

// This one is a github.com URL that falls through only because its path has a single segment, so
// the unsupported branch is reached on a host that is supported.
it('keeps a credential out of a supported host whose path it cannot read', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://x-access-token:ghs_SECRET456@github.com/acme');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  if (remote?.supported !== false) return;
  expect(remote.url).not.toContain('ghs_SECRET456');
});

// git separates the name from the URL with a tab, so a URL holding a space is ordinary. Splitting
// on whitespace dropped the whole row, and a repository with an origin reported no remote at all.
it('reads a remote whose URL holds a space', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', '/Volumes/My Drive/widgets.git');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  expect(remote?.name).toBe('origin');
  expect(remote?.supported).toBe(false);
  if (remote?.supported !== false) return;
  expect(remote.url).toContain('My Drive');
});

// symbolic-ref resolves the pointer without checking that what it points at is still there, which
// is the normal state of a clone after the default branch was renamed.
it('ignores an origin HEAD that points at a branch that is gone', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD');
  repo.run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  repo.run('update-ref', '-d', 'refs/remotes/origin/main');
  repo.run('checkout', '-q', '-b', 'local-work');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The checked out branch, because the name origin points at has no commit behind it.
  expect(result.repos[0]?.base).toEqual({ kind: 'branch', name: 'local-work' });
});

// A repository with no commit yet still names its unborn branch, and a card branched from it fails
// later, away from the cause. The same shape covers a HEAD left on a branch that was deleted.
it('says so when the branch has no commit behind it', async () => {
  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos[0]?.base).toEqual({ kind: 'unborn', name: 'main' });
});

// A token can be the whole user, with no password behind a colon. Stripping only the password
// would leave this one in the result, and both other credential tests would still pass.
it('keeps a credential out of a URL that carries it as the user', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://ghp_TOKENONLY@github.com/acme');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  expect(remote?.supported).toBe(false);
  if (remote?.supported !== false) return;
  expect(remote.url).not.toContain('ghp_TOKENONLY');
  expect(remote.url).toContain('github.com/acme');
});

// stat succeeds on a folder with no permissions, so the guard passes and git is then spawned with
// it as the working directory. spawn reports that as EACCES, which the git helper does not map, so
// the whole scan rejected instead of answering.
it('reports a folder it cannot read, rather than crashing', async () => {
  const root = plain('locked');
  chmodSync(root, 0o000);
  try {
    const result = await scan(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(root);
    // Not "git was not found on the PATH", which is what a bare EACCES reads as.
    expect(result.reason).not.toContain('PATH');
  } finally {
    chmodSync(root, 0o755);
  }
});

// One folder nobody can read must not take the scan down with it. The person is picking a
// repository, and the repository next to the unreadable one is the one they came for.
it('keeps scanning when one child cannot be read', async () => {
  const root = projects('api');
  const locked = join(root, 'private-notes');
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    const result = await scan(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repos.map((found) => found.path)).toEqual(['api']);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// Read without execute is the case that separates the two. The names can be listed, so the folder
// is walked, but nothing in it can be entered. Without checking for execute the scan reports "no
// repository here" about a folder it simply could not go into.
it('says a folder it cannot enter cannot be read, not that it holds no repository', async () => {
  const root = plain('listable');
  mkdirSync(join(root, 'api'), { recursive: true });
  chmodSync(root, 0o444);
  try {
    const result = await scan(root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('cannot be read');
    expect(result.reason).not.toContain('No git repository here');
  } finally {
    chmodSync(root, 0o755);
  }
});

// A dirent for a symlink answers false to isDirectory, so a filter on that alone drops it with no
// mention. A project folder holding symlinks to repositories elsewhere is an ordinary setup.
it('finds a child that is a symlink to a repository', async () => {
  const root = projects('web');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', elsewhere], { env: repo.env });
  symlinkSync(elsewhere, join(root, 'api'));

  const result = await scan(root);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => found.path).sort()).toEqual(['api', 'web']);
});

it('skips a symlink that points nowhere instead of failing the scan', async () => {
  const root = projects('web');
  symlinkSync(join(base, 'not-there'), join(root, 'broken'));

  const result = await scan(root);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => found.path)).toEqual(['web']);
});

// The template is a setting a person can edit. A scan that threw lost the repositories, the base
// branch and the remotes over a preview that is the least important thing it reports.
it('reports a branch template it cannot use, and still reports the repository', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');

  const result = await scan(repo.dir, '{key}-{nope}');

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos).toHaveLength(1);
  expect(result.branchPreview.ok).toBe(false);
  if (result.branchPreview.ok) return;
  expect(result.branchPreview.reason).toContain('{nope}');
});

it('reports a template with no key placeholder the same way', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');

  const result = await scan(repo.dir, 'just-a-slug');

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.branchPreview.ok).toBe(false);
});

// A link to a sibling repository is the same repository under two names. Offering it twice would
// let two cards run against one worktree, which is the thing the card key exists to prevent.
it('reports a repository once when a sibling symlink points at it', async () => {
  const root = projects('web');
  symlinkSync(join(root, 'web'), join(root, 'web-alias'));

  const result = await scan(root);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The real folder wins, because the names are walked in order.
  expect(result.repos.map((found) => found.path)).toEqual(['web']);
});

// The suffix is stripped from the whole path before it is split, so an anchored match never sees
// it when a slash follows. The same URL without .git is handled correctly, so the two disagree.
it('reads the repository name from a URL with a slash after .git', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'https://github.com/acme/widgets.git/');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const remote = result.repos[0]?.remotes[0];
  expect(remote?.supported).toBe(true);
  if (remote?.supported !== true) return;
  expect([remote.owner, remote.repo]).toEqual(['acme', 'widgets']);
});

// Refusing a bare repository is right, there is no working copy to run a card in. Saying "no
// repository here" to somebody standing in one is not.
it('says a bare repository is bare, rather than nothing at all', async () => {
  const bare = join(base, 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: repo.env });

  const result = await scan(bare);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toMatch(/bare/i);
  expect(result.reason).not.toContain('No git repository here');
});

// What separates a user from a secret is the colon inside the user info, not the shape of the URL.
// `git@host:path` is a user and has to survive. `user:TOKEN@host:path` is a user and a password.
// Every earlier credential test used a scheme URL, so this form was never looked at.
it('keeps a credential out of an scp URL, and keeps a plain user', async () => {
  repo.write('a.txt', 'a\n');
  repo.commit('first');
  repo.run('remote', 'add', 'origin', 'user:TOKEN_F@gitlab.acme.invalid:team/tool.git');
  repo.run('remote', 'add', 'plain', 'git@example.invalid:team/tool.git');

  const result = await scan(repo.dir);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const byName = new Map((result.repos[0]?.remotes ?? []).map((remote) => [remote.name, remote]));

  const origin = byName.get('origin');
  expect(origin?.supported).toBe(false);
  if (origin?.supported !== false) return;
  expect(origin.url).not.toContain('TOKEN_F');
  // The rest of it still has to be there, or nobody can tell which remote it was.
  expect(origin.url).toContain('gitlab.acme.invalid:team/tool.git');

  const plain = byName.get('plain');
  if (plain?.supported !== false) return;
  expect(plain.url).toContain('git@');
});

// With web and web-alias, sorted order happens to pick the real directory, so the rule was never
// tested. An alias that sorts first takes the top level and the folder the person opened in their
// editor disappears from the list.
it('prefers the real directory when an alias sorts before it', async () => {
  const root = projects('web');
  symlinkSync(join(root, 'web'), join(root, 'alias-web'));

  const result = await scan(root);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => found.path)).toEqual(['web']);
});

// git exports GIT_DIR into every hook it runs, and into rebase --exec and bisect run, and the
// login shell environment is captured and handed to spawn. With it set, rev-parse answers with the
// working directory, so every folder on the disk looks like a repository and the base branch and
// the remotes come from one the person never chose. A card would then commit there.
it('ignores a stray GIT_DIR in the environment', async () => {
  const root = projects('api', 'web');
  const unrelated = join(base, 'unrelated');
  mkdirSync(unrelated, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', unrelated], { env: repo.env });

  const result = await scanProject(root, {
    branchTemplate: '{key}-{slug}',
    env: { ...repo.env, GIT_DIR: join(unrelated, '.git') },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.repos.map((found) => found.path).sort()).toEqual(['api', 'web']);
});

// The temp folder stands in for the home folder. It holds the fixture repository at repo/, which is
// in none of the three folders and so is never found.
it('finds the repositories one level down in ~/code, ~/projects and ~/src, each with its remotes', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { env: repo.env });
  const code = join(base, 'code');
  git('init', '-q', '-b', 'main', join(code, 'api'));
  git('-C', join(code, 'api'), 'remote', 'add', 'origin', 'git@github.com:recipes-app/api.git');
  git('-C', join(code, 'api'), 'remote', 'add', 'mirror', 'https://someone:secret-token@git.example.invalid/recipes/api.git');
  git('init', '-q', '-b', 'main', join(code, 'sketchbook'));
  git('init', '-q', '-b', 'main', join(code, 'group', 'deep'));
  mkdirSync(join(code, 'notes'));
  writeFileSync(join(code, 'readme.txt'), 'not a folder\n');
  projects('web');

  const found = await scanMachine(base, { env: repo.env });

  expect(MACHINE_ROOTS).toEqual(['code', 'projects', 'src']);
  // No src folder, and nothing said about it.
  expect(found).toEqual([
    {
      path: join('code', 'api'),
      remotes: [
        { name: 'mirror', url: 'https://git.example.invalid/recipes/api.git' },
        { name: 'origin', url: 'git@github.com:recipes-app/api.git' },
      ],
    },
    { path: join('code', 'sketchbook'), remotes: [] },
    { path: join('projects', 'web'), remotes: [] },
  ]);
});

it('finds nothing and says nothing on a machine with none of the three folders', async () => {
  expect(await scanMachine(join(base, 'empty-home'), { env: repo.env })).toEqual([]);
});
