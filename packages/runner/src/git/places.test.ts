import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { repoPlaces } from './places.ts';

const made: TempRepo[] = [];
afterEach(() => {
  for (const repo of made.splice(0)) repo.remove();
});

// A project repository with two card checkouts under `worktrees`, as Nolzu makes them, and a second
// repository outside the project.
function setUp() {
  const project = tempRepo('nolzu-places-');
  const other = tempRepo('nolzu-places-other-');
  made.push(project, other);
  for (const repo of [project, other]) {
    repo.write('README.md', 'recipes\n');
    repo.commit('first commit');
  }
  const card = join(project.dir, 'worktrees', 'APP-1');
  project.run('worktree', 'add', '-q', '-b', 'APP-1-work', card);
  project.run('worktree', 'add', '-q', '-b', 'APP-2-work', join(project.dir, 'worktrees', 'APP-2'));
  other.run('worktree', 'add', '-q', '-b', 'x', join(other.dir, '..', 'other-card'));
  const real = realpathSync(project.dir);
  const common = join(real, '.git');
  // What Nolzu's record holds for the card: the paths as the project path names them.
  const want = { project: project.dir, workTree: card, commonDir: join(project.dir, '.git'), gitDir: join(project.dir, '.git', 'worktrees', 'APP-1') };
  return { project, other, card, common, own: join(common, 'worktrees', 'APP-1'), want };
}

it('answers the places of a plain repository and of a card checkout', async () => {
  const s = setUp();
  expect(await repoPlaces({ project: s.project.dir, workTree: s.project.dir }, s.project.env)).toEqual({
    ok: true,
    places: { workTree: realpathSync(s.project.dir), gitDir: s.common, commonDir: s.common },
  });
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: true, places: { workTree: realpathSync(s.card), gitDir: s.own, commonDir: s.common } });
  // A folder whose name starts with two dots is inside the project.
  const odd = join(s.project.dir, '..x');
  mkdirSync(odd);
  execFileSync('git', ['init', '-q', odd], { env: s.project.env });
  expect((await repoPlaces({ project: s.project.dir, workTree: odd }, s.project.env)).ok).toBe(true);
});

it('names the folders as the disk does when the record holds the project in another case', async () => {
  const s = setUp();
  const upper = join(s.project.dir, '..', 'REPO');
  // Only on a file system that folds case, as macOS does by default.
  if (!existsSync(upper)) return;
  expect(await repoPlaces({ project: upper, workTree: upper }, s.project.env)).toEqual({
    ok: true,
    places: { workTree: realpathSync(s.project.dir), gitDir: s.common, commonDir: s.common },
  });
});

it('needs the own git folder from the record for a card checkout', async () => {
  const s = setUp();
  expect(await repoPlaces({ ...s.want, gitDir: undefined }, s.project.env)).toEqual({ ok: false, reason: `Nolzu has no record of the git folder of ${s.card}, so it did not run git there.` });
});

it("refuses a card checkout whose .git file leads into another repository's git folder", async () => {
  const s = setUp();
  const elsewhere = join(realpathSync(s.other.dir), '.git', 'worktrees', 'other-card');
  writeFileSync(join(s.card, '.git'), `gitdir: ${elsewhere}\n`);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining(`names ${elsewhere}, not ${s.want.gitDir}`) });
});

it("refuses a card checkout whose .git file leads to another card's folder, also when that folder's gitdir names it back", async () => {
  const s = setUp();
  writeFileSync(join(s.card, '.git'), `gitdir: ${join(s.common, 'worktrees', 'APP-2')}\n`);
  writeFileSync(join(s.common, 'worktrees', 'APP-2', 'gitdir'), `${join(realpathSync(s.card), '.git')}\n`);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining(`names ${join(s.common, 'worktrees', 'APP-2')}, not ${s.want.gitDir}`) });
});

it('refuses a commondir edited to lead to a git folder elsewhere, or to the right one through a link', async () => {
  const s = setUp();
  const commondir = join(s.own, 'commondir');
  expect(readFileSync(commondir, 'utf8').trim()).toBe('../..');
  writeFileSync(commondir, `${realpathSync(join(s.other.dir, '.git'))}\n`);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('Check the commondir file') });
  // A link outside the project that leads to the right folder: git's own answer is the right folder.
  const link = join(s.project.dir, '..', 'common-link');
  symlinkSync(s.common, link);
  writeFileSync(commondir, `${link}\n`);
  expect(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: s.card, env: s.project.env, encoding: 'utf8' }).trim()).toBe(s.common);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining(`names ${link}, not ${s.common}`) });
  // And one inside the project.
  const inner = join(s.project.dir, 'common-link');
  symlinkSync(s.common, inner);
  writeFileSync(commondir, `${join(realpathSync(s.project.dir), 'common-link')}\n`);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('common-link, not') });
});

it('refuses a .git file that reaches the right git folder through a link', async () => {
  const s = setUp();
  const link = join(s.project.dir, '..', 'worktrees-link');
  symlinkSync(join(s.common, 'worktrees'), link);
  writeFileSync(join(s.card, '.git'), `gitdir: ${join(link, 'APP-1')}\n`);
  expect(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: s.card, env: s.project.env, encoding: 'utf8' }).trim()).toBe(s.own);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('Check the .git file in the work tree') });
  // The same through a link inside the project.
  symlinkSync(join(s.common, 'worktrees'), join(s.project.dir, 'worktrees-link'));
  writeFileSync(join(s.card, '.git'), `gitdir: ${join(realpathSync(s.project.dir), 'worktrees-link', 'APP-1')}\n`);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('Check the .git file in the work tree') });
});

it('refuses a work tree replaced by a link, and a link on the way down from the project', async () => {
  const s = setUp();
  const moved = join(s.project.dir, '..', 'moved-card');
  renameSync(s.card, moved);
  symlinkSync(moved, s.card);
  const at = join(realpathSync(s.project.dir), 'worktrees', 'APP-1');
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: `${at} is a link, on the way to the work tree ${s.card}. Nolzu stopped before running git there. Remove the link, and check what it points to.` });
  rmSync(s.card);
  renameSync(moved, s.card);
  // The `worktrees` folder itself swapped for a link to a copy elsewhere.
  const folder = join(s.project.dir, 'worktrees');
  const away = join(s.project.dir, '..', 'away');
  renameSync(folder, away);
  symlinkSync(away, folder);
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('worktrees is a link') });
});

it("refuses a project whose .git is swapped for a link to another repository's, or holds a commondir", async () => {
  const s = setUp();
  writeFileSync(join(s.common, 'commondir'), `${realpathSync(join(s.other.dir, '.git'))}\n`);
  expect(await repoPlaces({ project: s.project.dir, workTree: s.project.dir }, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('leads git to another git folder') });
  rmSync(join(s.project.dir, '.git'), { recursive: true, force: true });
  symlinkSync(join(s.other.dir, '.git'), join(s.project.dir, '.git'));
  expect(await repoPlaces({ project: s.project.dir, workTree: s.project.dir }, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('.git is a link') });
});

it('refuses a checkout that lost its .git, where git would work in the project repository', async () => {
  const s = setUp();
  rmSync(join(s.card, '.git'));
  expect(await repoPlaces(s.want, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('.git is not there') });
});

it('refuses a work tree outside the project, a missing one, and a plain repository named as a checkout', async () => {
  const s = setUp();
  expect(await repoPlaces({ project: s.project.dir, workTree: s.other.dir }, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('is outside the project folder') });
  expect(await repoPlaces({ project: s.project.dir, workTree: join(s.project.dir, '..x', '..', '..', 'elsewhere') }, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('is outside the project folder') });
  expect(await repoPlaces({ project: s.project.dir, workTree: join(s.project.dir, 'worktrees', 'APP-9') }, s.project.env)).toEqual({ ok: false, reason: expect.stringContaining('is not there') });
  // A card checkout named with no shared folder is held to be a plain repository, which it is not.
  expect((await repoPlaces({ project: s.project.dir, workTree: s.card }, s.project.env)).ok).toBe(false);
  mkdirSync(join(s.project.dir, 'plain'));
  expect((await repoPlaces({ project: s.project.dir, workTree: join(s.project.dir, 'plain') }, s.project.env)).ok).toBe(false);
});
