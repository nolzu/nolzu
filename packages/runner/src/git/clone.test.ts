import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stubBinary, type StubBinary } from '../../test/stub-binary.ts';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { CLONE_TIMEOUT_MS, cloneInto } from './clone-into.ts';
import { cloneRepository, cloneTarget } from './clone.ts';

let repo: TempRepo | null = null;
let stub: StubBinary | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  repo?.remove();
  repo = null;
  stub?.remove();
  stub = null;
});

// A workspace folder next to a bare remote, both inside the temp repository's own temp folder.
const setUp = (withCommit: boolean): { workspace: string; bare: string; env: Record<string, string> } => {
  const made = tempRepo('nolzu-clone-');
  repo = made;
  const bare = join(dirname(made.dir), 'recipes.git');
  if (withCommit) {
    made.write('README.md', 'recipes\n');
    made.commit('first commit');
    made.run('checkout', '-q', '-b', 'develop');
    made.run('clone', '-q', '--bare', made.dir, bare);
    // The remote's default branch is develop, not the main the fixture started on.
    execFileSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/develop'], { env: made.env });
  } else {
    made.run('init', '-q', '--bare', bare);
  }
  const workspace = join(dirname(made.dir), 'workspace');
  mkdirSync(workspace);
  return { workspace, bare, env: made.env };
};

it.each([
  ['https://github.com/nolzu/recipes.git', 'recipes'],
  ['https://gitlab.example.invalid/group/sub/api', 'api'],
  ['https://github.com/nolzu/web/', 'web'],
  ['https://github.com/nolzu/Web.GIT', 'Web'],
  ['git@github.com:nolzu/recipes.git', 'recipes'],
  ['git@gitlab.example.invalid:group/api', 'api'],
  ['  git@github.com:nolzu/recipes.git\n', 'recipes'],
])('names the folder for %s', (url, name) => {
  expect(cloneTarget(url)).toEqual({ ok: true, name });
});

it.each([
  ['', /Type the URL/],
  ['-oProxyCommand=touch x', /starts with "-"/],
  ['--upload-pack=touch x', /starts with "-"/],
  ['ext::sh -c touch% x', /transport/],
  ['transport::https://github.com/a/b', /transport/],
  ['fd::17', /transport/],
  ['file:///tmp/recipes.git', /https:\/\/ or the user@host:path form/],
  ['ssh://git@github.com/a/b.git', /https:\/\/ or the user@host:path form/],
  ['http://github.com/a/b.git', /https:\/\/ or the user@host:path form/],
  ['git://github.com/a/b.git', /https:\/\/ or the user@host:path form/],
  ['/tmp/recipes.git', /https:\/\/ or the user@host:path form/],
  ['./recipes', /https:\/\/ or the user@host:path form/],
  ['../recipes.git', /https:\/\/ or the user@host:path form/],
  ['recipes.git', /https:\/\/ or the user@host:path form/],
  ['C:\\repos\\recipes', /https:\/\/ or the user@host:path form/],
  ['host:recipes.git', /https:\/\/ or the user@host:path form/],
  ['git@-oProxyCommand=x:a/b', /https:\/\/ or the user@host:path form/],
  ['git@github.com:-a/b', /https:\/\/ or the user@host:path form/],
  ['https://github.com', /names no repository/],
  ['https://github.com/a/b?x=1', /query/],
  ['https://github.com/a/worktrees.git', /where Nolzu keeps its own files/],
  ['git@github.com:a/..', /cannot name a folder/],
  ['git@github.com:a/.nolzu', /where Nolzu keeps its own files/],
  ['https://github.com/a/b c', /space/],
])('refuses %j and says why', (url, why) => {
  const target = cloneTarget(url);
  expect(target.ok).toBe(false);
  expect(target.ok ? '' : target.reason).toMatch(why);
});

it('refuses a folder the list holds already, in any case', () => {
  expect(cloneTarget('https://github.com/nolzu/API.git', ['api'])).toEqual({
    ok: false,
    reason: 'There is a repository "api" in this workspace already.',
  });
});

it.each([
  'https://TOKEN_SECRET@github.com/a/b.git',
  'https://user:TOKEN_SECRET@github.com/a/b.git',
  'https://github.com/a/b.git?access_token=TOKEN_SECRET',
  'user:TOKEN_SECRET@github.com:a/b.git',
  'https://TOKEN_SECRET\\@github.com/a/b',
])('refuses a URL with a credential in it, and never repeats it: %s', async (url) => {
  const target = cloneTarget(url);
  expect(target.ok).toBe(false);
  expect(JSON.stringify(target)).not.toContain('TOKEN_SECRET');

  const { workspace, env } = setUp(false);
  const cloned = await cloneRepository({ workspace, url, env });
  expect(cloned.ok).toBe(false);
  expect(JSON.stringify(cloned)).not.toContain('TOKEN_SECRET');
  expect(readdirSync(workspace)).toEqual([]);
});

it('refuses a local path and a file URL before git runs, so nothing is cloned', async () => {
  const { workspace, bare, env } = setUp(true);

  for (const url of [bare, `file://${bare}`]) {
    expect((await cloneRepository({ workspace, url, env })).ok).toBe(false);
  }
  expect(readdirSync(workspace)).toEqual([]);
});

it('clones a local bare repository into the workspace, on its default branch', async () => {
  const { workspace, bare, env } = setUp(true);

  const cloned = await cloneInto({ workspace, url: bare, name: 'recipes', env, protocols: 'file' });

  expect(cloned).toEqual({ ok: true, name: 'recipes', path: join(workspace, 'recipes') });
  const at = join(workspace, 'recipes');
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: at, env, encoding: 'utf8' }).trim()).toBe('develop');
  expect(readFileSync(join(at, 'README.md'), 'utf8')).toBe('recipes\n');
});

// The allow list is what keeps git off the local disk, so the app's own setting must refuse it.
it('refuses the file transport with the allow list the app uses', async () => {
  const { workspace, bare, env } = setUp(true);

  const cloned = await cloneInto({ workspace, url: bare, name: 'recipes', env: { ...env, GIT_ALLOW_PROTOCOL: 'file' }, protocols: 'https:ssh' });

  expect(cloned.ok).toBe(false);
  expect(cloned.ok ? '' : cloned.reason).toMatch(/not allowed/);
  expect(existsSync(join(workspace, 'recipes'))).toBe(false);
});

it('removes the clone of an empty remote again, because it made that folder', async () => {
  const { workspace, bare, env } = setUp(false);

  const cloned = await cloneInto({ workspace, url: bare, name: 'recipes', env, protocols: 'file' });

  expect(cloned).toEqual({ ok: false, reason: 'The repository at that URL is empty, so there is no branch to start from. Push a first commit to it, then add it again.' });
  expect(readdirSync(workspace)).toEqual([]);
});

it('never touches a folder that was there before, even an empty one', async () => {
  const { workspace, bare, env } = setUp(true);
  mkdirSync(join(workspace, 'recipes'));
  writeFileSync(join(workspace, 'recipes', 'notes.txt'), 'mine\n');
  mkdirSync(join(workspace, 'empty'));

  expect(await cloneInto({ workspace, url: bare, name: 'recipes', env, protocols: 'file' })).toEqual({
    ok: false,
    reason: 'There is a folder "recipes" in the workspace already, so nothing was cloned.',
  });
  expect((await cloneInto({ workspace, url: bare, name: 'empty', env, protocols: 'file' })).ok).toBe(false);
  expect(readFileSync(join(workspace, 'recipes', 'notes.txt'), 'utf8')).toBe('mine\n');
  expect(readdirSync(join(workspace, 'empty'))).toEqual([]);
});

it('removes what a stopped clone left, and says it was stopped', async () => {
  const { workspace, bare, env } = setUp(true);
  const stop = new AbortController();
  stop.abort();

  expect(await cloneInto({ workspace, url: bare, name: 'recipes', env, protocols: 'file', signal: stop.signal })).toEqual({
    ok: false,
    reason: 'The clone was stopped, so nothing was added.',
  });
  expect(readdirSync(workspace)).toEqual([]);
});

// The stop has to reach git's helpers too. This git starts a helper that keeps writing into the
// clone folder, as index-pack does, and then waits to be killed.
it('stops a running clone with its helpers, and leaves no folder', async () => {
  const { workspace, bare, env } = setUp(true);
  stub = stubBinary(
    `const { spawn } = require('node:child_process');
if (process.argv.includes('config')) process.exit(1);
const folder = require('node:path').join(process.cwd(), process.argv.at(-1));
spawn(process.execPath, ['-e', 'const fs = require("node:fs"); setInterval(() => { fs.mkdirSync(process.argv[1], { recursive: true }); fs.writeFileSync(process.argv[1] + "/pack", "x"); }, 5);', folder], { stdio: 'ignore' });
setInterval(() => {}, 1000);`,
    'git',
  );
  const stop = new AbortController();
  const running = cloneInto({ workspace, url: bare, name: 'recipes', env: { ...env, PATH: `${dirname(stub.path)}:${env.PATH ?? ''}` }, protocols: 'file', signal: stop.signal });
  for (let tries = 0; !existsSync(join(workspace, 'recipes', 'pack')) && tries < 400; tries += 1) await wait(10);
  expect(existsSync(join(workspace, 'recipes', 'pack'))).toBe(true);

  stop.abort();

  expect(await running).toEqual({ ok: false, reason: 'The clone was stopped, so nothing was added.' });
  // A helper still alive would make the folder again within a few milliseconds.
  await wait(100);
  expect(readdirSync(workspace)).toEqual([]);
});

it('never runs a URL that starts with "-" as an option of a real git', async () => {
  const { workspace, env } = setUp(false);
  const marker = join(workspace, '..', 'pwned');

  const cloned = await cloneInto({ workspace, url: `--upload-pack=touch ${marker}`, name: 'recipes', env, protocols: 'file' });

  expect(cloned.ok).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(readdirSync(workspace)).toEqual([]);
});

// A stand-in for git that writes what it was handed, so the test reads the exact argument list and
// environment a real clone gets. A config read goes to the real git, so the test config holds.
const recordingGit = (): { env: (base: Record<string, string>) => Record<string, string>; seen: () => { args: string[]; env: Record<string, string> }[] } => {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  stub = stubBinary(
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('config')) process.exit(require('node:child_process').spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' }).status ?? 1);
fs.appendFileSync(process.env.SEEN_FILE, JSON.stringify({ args, env: process.env }) + '\\n');
process.exit(1);`,
    'git',
  );
  const seenFile = join(dirname(stub.path), 'seen.ndjson');
  return {
    env: (base) => ({ ...base, PATH: `${dirname(stub?.path ?? '')}:${base.PATH ?? ''}`, SEEN_FILE: seenFile, REAL_GIT: realGit }),
    seen: () =>
      existsSync(seenFile)
        ? readFileSync(seenFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> })
        : [],
  };
};

it('never hands git a URL that starts with "-" as an option', async () => {
  const { workspace, env } = setUp(false);
  const fake = recordingGit();

  expect((await cloneRepository({ workspace, url: '-oProxyCommand=touch pwned', env: fake.env(env) })).ok).toBe(false);
  expect(fake.seen()).toEqual([]);

  // Even past the URL rules, the URL comes after "--".
  await cloneInto({ workspace, url: '-oProxyCommand=touch pwned', name: 'recipes', env: fake.env(env), protocols: 'https:ssh' });
  const clone = fake.seen().find((call) => call.args.includes('clone'));
  expect(clone?.args.slice(clone.args.indexOf('clone'))).toEqual(['clone', '--no-recurse-submodules', '--', '-oProxyCommand=touch pwned', 'recipes']);
});

it('clones with no prompt, no askpass helper, ssh in batch mode and only https and ssh allowed', async () => {
  const { workspace, env } = setUp(false);
  const fake = recordingGit();

  await cloneRepository({
    workspace,
    url: 'git@github.com:nolzu/recipes.git',
    env: fake.env({ ...env, GIT_ASKPASS: '/bin/askpass', SSH_ASKPASS: '/bin/askpass', GIT_ALLOW_PROTOCOL: 'file:ext', GIT_SSH_COMMAND: '' }),
  });

  const clone = fake.seen().find((call) => call.args.includes('clone'));
  expect(clone?.env).toMatchObject({
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  });
});

it("keeps the person's own ssh command", async () => {
  const { workspace, env } = setUp(false);
  const fake = recordingGit();

  await cloneRepository({ workspace, url: 'git@github.com:nolzu/recipes.git', env: fake.env({ ...env, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' }) });

  expect(fake.seen().find((call) => call.args.includes('clone'))?.env.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work');
});

it("keeps the ssh command the person set in git's config", async () => {
  const { workspace, env } = setUp(false);
  writeFileSync(env.GIT_CONFIG_GLOBAL ?? '', '[core]\n\tsshCommand = ssh -i ~/.ssh/work\n');
  const fake = recordingGit();

  await cloneRepository({ workspace, url: 'git@github.com:nolzu/recipes.git', env: fake.env(env) });

  const clone = fake.seen().find((call) => call.args.includes('clone'));
  expect(clone).toBeDefined();
  expect(clone?.env.GIT_SSH_COMMAND).toBeUndefined();
});

// The scp form cannot carry a password, but the sentence has to say what is wrong with it.
it('names the password in a user:token@host:path URL as the reason', () => {
  expect(cloneTarget('user:TOKEN_SECRET@github.com:a/b.git')).toEqual({
    ok: false,
    reason: 'The URL holds a user name and password or a token. Type it without them, and let git find the login the way it does for a push.',
  });
});

it('refuses a repository the workspace lists already before git runs', async () => {
  const { workspace, env } = setUp(false);
  const fake = recordingGit();

  const cloned = await cloneRepository({ workspace, url: 'https://github.com/nolzu/Recipes.git', env: fake.env(env), taken: ['recipes'] });

  expect(cloned).toEqual({ ok: false, reason: 'There is a repository "recipes" in this workspace already.' });
  expect(fake.seen()).toEqual([]);
  expect(readdirSync(workspace)).toEqual([]);
});

// Ten minutes is too long to wait for, so the time limit's own signal is the one that fires.
it('stops a clone that runs past the time limit, and leaves no folder', async () => {
  const { workspace, bare, env } = setUp(true);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const asked: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    asked.push(ms);
    return ms === CLONE_TIMEOUT_MS ? AbortSignal.abort() : timeout(ms);
  });

  expect(await cloneInto({ workspace, url: bare, name: 'recipes', env, protocols: 'file' })).toEqual({
    ok: false,
    reason: 'The clone took longer than 10 minutes and was stopped, so nothing was added.',
  });
  expect(asked).toContain(CLONE_TIMEOUT_MS);
  expect(readdirSync(workspace)).toEqual([]);
});

// A file URL, because git clones a plain path by copying files and prints no progress for it.
it("hands on git's own progress from a local bare remote, up to every object received", async () => {
  const { workspace, bare, env } = setUp(true);
  const heard: { step: string; percent: number }[] = [];

  const cloned = await cloneInto({ workspace, url: `file://${bare}`, name: 'recipes', env, protocols: 'file', onProgress: (progress) => heard.push(progress) });

  expect(cloned.ok).toBe(true);
  // How many updates arrive depends on how git's writes fall into chunks, so only the end is fixed.
  // One commit leaves no deltas to resolve, so receiving is the last step.
  expect(heard.at(-1)).toEqual({ step: 'Receiving objects', percent: 100 });
  // Never back: a later step keeps the share received.
  expect(heard.map((progress) => progress.percent)).toEqual([...heard.map((progress) => progress.percent)].sort((a, b) => a - b));
  // Each one is a change, so a page is not told the same thing twice.
  expect(new Set(heard.map((progress) => `${progress.step} ${progress.percent}`)).size).toBe(heard.length);
});

it('asks git for progress in English only when somebody listens, and the plain clone stays as it was', async () => {
  const { workspace, env } = setUp(false);
  const fake = recordingGit();

  await cloneRepository({ workspace, url: 'https://github.com/nolzu/recipes.git', env: fake.env(env), onProgress: () => undefined });
  await cloneRepository({ workspace, url: 'https://github.com/nolzu/web.git', env: fake.env(env) });

  const [listened, plain] = fake.seen().filter((call) => call.args.includes('clone'));
  expect(listened?.args.slice(listened.args.indexOf('clone'))).toEqual(['clone', '--no-recurse-submodules', '--progress', '--', 'https://github.com/nolzu/recipes.git', 'recipes']);
  expect(listened?.env.LC_ALL).toBe('C');
  expect(plain?.args.slice(plain.args.indexOf('clone'))).toEqual(['clone', '--no-recurse-submodules', '--', 'https://github.com/nolzu/web.git', 'web']);
  expect(plain?.env.LC_ALL).toBe(env.LC_ALL);
});

// A line cut short writes "fatal" after a carriage return, on the line of the last update. The reason
// is the words after it, not the share received.
it('names why a clone with progress failed, and leaves no folder', async () => {
  const { workspace, bare, env } = setUp(true);
  stub = stubBinary(
    `if (process.argv.includes('config')) process.exit(1);
process.stderr.write('Receiving objects:  45% (9/20)\\rfatal: early EOF\\n');
process.exit(128);`,
    'git',
  );

  const cloned = await cloneInto({ workspace, url: `file://${bare}`, name: 'recipes', env: { ...env, PATH: `${dirname(stub.path)}:${env.PATH ?? ''}` }, protocols: 'file', onProgress: () => undefined });

  expect(cloned).toEqual({ ok: false, reason: 'Git could not clone recipes. fatal: early EOF' });
  expect(readdirSync(workspace)).toEqual([]);
});

// ssh says why on the line before git's fatal line, and git ends with advice that is the same for
// every failure, so the sentence takes those two lines and not the last one.
it('names the reason ssh gave for a failed clone, not the advice after it', async () => {
  const { workspace, env } = setUp(false);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  stub = stubBinary(
    `const args = process.argv.slice(2);
if (args.includes('config')) process.exit(require('node:child_process').spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' }).status ?? 1);
process.stderr.write("Cloning into 'recipes'...\\ngit@github.com: Permission denied (publickey).\\nfatal: Could not read from remote repository.\\n\\nPlease make sure you have the correct access rights\\nand the repository exists.\\n");
process.exit(128);`,
    'git',
  );

  const cloned = await cloneInto({ workspace, url: 'git@github.com:me/recipes.git', name: 'recipes', env: { ...env, PATH: `${dirname(stub.path)}:${env.PATH ?? ''}`, REAL_GIT: realGit }, protocols: 'https:ssh' });

  expect(cloned).toMatchObject({ ok: false, reason: expect.stringContaining('git@github.com: Permission denied (publickey). fatal: Could not read from remote repository.') });
  expect(JSON.stringify(cloned)).not.toContain('and the repository exists');
});
