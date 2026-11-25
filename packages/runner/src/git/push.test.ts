import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { pushBranch, pushConfirmation } from './push.ts';

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

// A bare repository in a second folder is a real remote, so none of this needs a network.
const withRemote = (): TempRepo => {
  const made = tempRepo('nolzu-push-');
  repo = made;
  made.write('README.md', 'demo\n');
  made.commit('first commit');
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('checkout', '-q', '-b', 'APP-1-work');
  made.write('work.txt', 'the card did something\n');
  made.commit('the card did something');
  return made;
};

const push = (made: TempRepo, over: Record<string, unknown> = {}) =>
  pushBranch({ worktreePath: made.dir, branch: 'APP-1-work', remote: 'origin', env: made.env, ...over });

it('says exactly what a push would do, for an https remote', () => {
  const said = pushConfirmation('APP-1-work', 'origin', 'https://github.com/nolzu/nolzu.git');

  expect(said).toContain('APP-1-work');
  expect(said).toContain('origin');
  expect(said).toContain('github.com/nolzu/nolzu');
});

it('says the same for an ssh remote', () => {
  const said = pushConfirmation('APP-1-work', 'origin', 'git@github.com:nolzu/nolzu.git');

  expect(said).toContain('APP-1-work');
  expect(said).toContain('github.com:nolzu/nolzu');
});

it('keeps a credential out of the confirmation', () => {
  // The remote URL is what a person is asked to confirm, and a clone made by CI carries its token
  // in that URL. This is the one sentence they read before agreeing.
  const said = pushConfirmation('APP-1-work', 'origin', 'https://x-access-token:ghs_notarealtoken@github.com/nolzu/nolzu.git');

  expect(said).not.toContain('ghs_notarealtoken');
  expect(said).toContain('github.com/nolzu/nolzu');
});

it('pushes the branch and sets its upstream', async () => {
  const made = withRemote();
  // Left on another branch, so the branch asked for is not the one checked out. With them equal, a
  // module that ignored the branch and pushed HEAD would pass every test here.
  made.run('checkout', '-q', 'main');

  const result = await push(made);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.alreadyUpToDate).toBe(false);
  const bare = join(made.dir, '..', 'remote.git');
  expect(made.run('rev-parse', 'APP-1-work').trim()).toBe(made.run('rev-parse', 'origin/APP-1-work').trim());
  expect(made.run('rev-parse', '--abbrev-ref', 'APP-1-work@{upstream}').trim()).toBe('origin/APP-1-work');
  expect(existsSync(bare)).toBe(true);
  // Read the remote itself, not one ref through the local clone: anything else that arrived there
  // is invisible from this side, and a person agreed to one branch.
  expect(made.run('--git-dir', bare, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/APP-1-work');
});

it('refuses a project with no remote before git runs', async () => {
  const made = tempRepo('nolzu-push-none-');
  repo = made;
  made.write('README.md', 'demo\n');
  made.commit('first commit');
  made.run('checkout', '-q', '-b', 'APP-1-work');

  const result = await push(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('no remote called origin');
  expect(result.reason).toContain('git remote add');
});

it('reports a push that adds nothing as already up to date, which is not a failure', async () => {
  const made = withRemote();
  await push(made);

  const again = await push(made);

  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.alreadyUpToDate).toBe(true);
});

it('fails with git own words when the remote moved ahead, and does not force', async () => {
  const made = withRemote();
  await push(made);
  // Another machine pushed in the meantime, so this branch is behind and a plain push is refused.
  const other = join(made.dir, '..', 'other');
  made.run('clone', '-q', join(made.dir, '..', 'remote.git'), other);
  made.run('-C', other, 'checkout', '-q', 'APP-1-work');
  made.run('-C', other, 'commit', '-q', '--allow-empty', '-m', 'from another machine');
  made.run('-C', other, 'push', '-q', 'origin', 'APP-1-work');
  made.write('local.txt', 'and this card kept working\n');
  made.commit('and this card kept working');

  const result = await push(made);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toMatch(/fetch first|non-fast-forward|rejected/i);

  // A second attempt is still a plain push. Forcing here would throw away what the other machine
  // pushed, which is the one thing this must never do on its own.
  const second = await push(made);
  expect(second.ok).toBe(false);
  expect(made.run('rev-parse', 'origin/APP-1-work').trim()).not.toBe(made.run('rev-parse', 'HEAD').trim());
});

it('refuses at once when the caller has already aborted', async () => {
  const made = withRemote();
  const stop = new AbortController();
  stop.abort();

  await expect(push(made, { signal: stop.signal })).rejects.toThrow();
});

it('stops a push in flight when the caller aborts', async () => {
  const made = withRemote();
  const bare = join(made.dir, '..', 'remote.git');
  // The remote holds the push open, so the abort meets the push itself rather than the remote
  // lookup that runs before it. The marker file is the proof that the push is really in flight, so
  // nothing here waits on a guessed delay.
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\ntouch started\nsleep 2\n');
  chmodSync(hook, 0o755);

  const stop = new AbortController();
  const running = push(made, { signal: stop.signal });
  for (let waited = 0; waited < 300 && !existsSync(join(bare, 'started')); waited += 1) {
    await new Promise((wake) => setTimeout(wake, 10));
  }
  stop.abort();

  await expect(running).rejects.toThrow(/abort/i);
  // Stopping is only worth anything if the commits never arrive.
  expect(() => made.run('--git-dir', bare, 'rev-parse', 'APP-1-work')).toThrow();
});

it('never passes a force flag, on any path through the module', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./push.ts', import.meta.url), 'utf8');

  // Read from the source rather than from a run, so a path no test reaches can hide one. The flags
  // are matched as whole arguments: a bare substring would trip over any word holding an f.
  expect(source).not.toMatch(/--force\b/);
  expect(source).not.toMatch(/--force-with-lease\b/);
  expect(source).not.toMatch(/'-f'/);
});

it('pushes to the remote it was asked for, and to no other', async () => {
  const made = withRemote();
  const second = join(made.dir, '..', 'second.git');
  made.run('init', '-q', '--bare', second);
  made.run('remote', 'add', 'upstream', second);

  const result = await push(made, { remote: 'upstream' });

  expect(result.ok).toBe(true);
  expect(made.run('rev-parse', 'upstream/APP-1-work').trim()).toBe(made.run('rev-parse', 'HEAD').trim());
  // Every other test here uses a remote named origin, so a module that ignored the name and always
  // pushed to origin would have passed all of them.
  expect(() => made.run('rev-parse', 'origin/APP-1-work')).toThrow();
});

it('sends only the branch, even when the person config asks for tags too', async () => {
  const made = withRemote();
  // `push.followTags` is an ordinary setting. With it, git sends the branch and a tag together, and
  // a tag the remote refuses makes the whole push exit non-zero although the branch landed.
  writeFileSync(join(made.dir, '..', 'gitconfig-global'), '[push]\n\tfollowTags = true\n');
  made.run('tag', '-a', 'v1', '-m', 'v1');

  const result = await push(made);

  expect(result.ok).toBe(true);
  // Nothing the confirmation did not name left the machine.
  expect(made.run('ls-remote', '--tags', 'origin').trim()).toBe('');
});

// The page offers "Pull into the checkout" only for a push the remote turned down because it holds
// commits the branch has not got. It shows the command that ran above git's own words.
it('marks a push turned down for being behind as rejected, and names the command that ran', async () => {
  const made = withRemote();
  await push(made);
  const other = join(made.dir, '..', 'other');
  made.run('clone', '-q', join(made.dir, '..', 'remote.git'), other);
  made.run('-C', other, 'checkout', '-q', 'APP-1-work');
  made.run('-C', other, 'commit', '-q', '--allow-empty', '-m', 'from another machine');
  made.run('-C', other, 'push', '-q', 'origin', 'APP-1-work');
  made.write('local.txt', 'and this card kept working\n');
  made.commit('and this card kept working');

  const result = await push(made);

  expect(result).toMatchObject({ ok: false, rejected: true, command: 'git -c push.default=current push --no-follow-tags -u origin refs/heads/APP-1-work' });
});

it('does not mark a push the remote refused for another reason as rejected', async () => {
  const made = withRemote();
  const hook = join(made.dir, '..', 'remote.git', 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "pushes are closed today" >&2\nexit 1\n');
  chmodSync(hook, 0o755);

  const result = await push(made);

  expect(result).toMatchObject({ ok: false, rejected: false });
  if (!result.ok) expect(result.reason).toContain('pushes are closed today');
});

it('runs no pre-push hook unless the person turned hooks on', async () => {
  const made = withRemote();
  const mark = join(made.dir, '..', 'pre-push-ran');
  const hook = join(made.dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\ntouch "${mark}"\nexit 1\n`);
  chmodSync(hook, 0o755);

  expect((await push(made)).ok).toBe(true);
  expect(existsSync(mark)).toBe(false);
});

it('runs the pre-push hook when the person turned hooks on for this push', async () => {
  const made = withRemote();
  const mark = join(made.dir, '..', 'pre-push-ran');
  const hook = join(made.dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\ntouch "${mark}"\n`);
  chmodSync(hook, 0o755);

  expect((await push(made, { hooks: true })).ok).toBe(true);
  expect(existsSync(mark)).toBe(true);
});

// git reads `+main` as a forced push of main, and `--mirror` as a mirror push. A run can point the
// card's checkout at either, and the person's Push would then wipe commits a colleague pushed to main.
it.each(['+main', '--mirror'])('refuses the branch %s, and the remote keeps its commits', async (name) => {
  const made = withRemote();
  made.run('push', '-q', 'origin', 'main');
  const other = join(made.dir, '..', 'other');
  made.run('clone', '-q', '-b', 'main', join(made.dir, '..', 'remote.git'), other);
  made.run('-C', other, 'commit', '-q', '--allow-empty', '-m', 'a colleague');
  made.run('-C', other, 'push', '-q', 'origin', 'main');
  const theirs = made.run('-C', other, 'rev-parse', 'main').trim();
  made.run('update-ref', `refs/heads/${name}`, 'HEAD');
  made.run('symbolic-ref', 'HEAD', `refs/heads/${name}`);

  const result = await push(made, { branch: name });

  expect(result).toMatchObject({ ok: false });
  expect(made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'rev-parse', 'main').trim()).toBe(theirs);
});

// A review server takes pushes under its own refs, and the person's config says so. The card's push
// follows it, as a push from the command line would.
it('follows a push refspec in the remote\'s config', async () => {
  const made = withRemote();
  made.run('config', 'remote.origin.push', 'refs/heads/*:refs/heads/review/*');

  const result = await push(made);

  expect(result.ok).toBe(true);
  expect(made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/review/APP-1-work');
});

// git resolves a bare `heads/main` to refs/heads/main. A run can point the checkout at a branch of that
// name, so the push spells out both sides and the remote's main keeps a colleague's commit.
it('pushes a branch named heads/main to that name, never onto main', async () => {
  const made = withRemote();
  made.run('push', '-q', 'origin', 'main');
  const other = join(made.dir, '..', 'other');
  made.run('clone', '-q', '-b', 'main', join(made.dir, '..', 'remote.git'), other);
  made.run('-C', other, 'commit', '-q', '--allow-empty', '-m', 'a colleague');
  made.run('-C', other, 'push', '-q', 'origin', 'main');
  const theirs = made.run('-C', other, 'rev-parse', 'main').trim();
  made.run('update-ref', 'refs/heads/heads/main', 'HEAD');
  made.run('symbolic-ref', 'HEAD', 'refs/heads/heads/main');

  await push(made, { branch: 'heads/main' });

  expect(made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'rev-parse', 'refs/heads/main').trim()).toBe(theirs);
  expect(made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'rev-parse', 'refs/heads/heads/main').trim()).toBe(made.run('rev-parse', 'refs/heads/heads/main').trim());
});

// A card branch made from a remote-tracking base tracks it, so under `push.default=upstream` a push with
// no right side would land on the remote's main. The card's push sets `current` and lands on its name.
it('pushes a branch that tracks the remote main to its own name under push.default=upstream', async () => {
  const made = withRemote();
  made.run('push', '-q', 'origin', 'main');
  made.run('config', 'push.default', 'upstream');
  made.run('branch', '-q', '--set-upstream-to', 'origin/main', 'APP-1-work');
  const main = made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'rev-parse', 'main').trim();

  const result = await push(made);

  expect(result.ok).toBe(true);
  expect(made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'rev-parse', 'main').trim()).toBe(main);
  expect(made.run('--git-dir', join(made.dir, '..', 'remote.git'), 'rev-parse', 'refs/heads/APP-1-work').trim()).toBe(made.run('rev-parse', 'APP-1-work').trim());
});
