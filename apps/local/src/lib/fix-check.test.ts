import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readHeads, runMoved } from './fix-check.ts';

// Real repositories: a bare one stands for GitHub, and a clone with an upstream for the card checkout.
let dir = '';
let remote = '';
let api = '';
let web = '';

const ENV = { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: 'pipe' }).trim();
const short = (cwd: string, rev = 'HEAD') => git(cwd, 'rev-parse', '--short=7', rev);
const checkouts = () => [
  { repo: 'services/api', path: api },
  { repo: 'web', path: web },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-fix-check-'));
  remote = join(dir, 'remote.git');
  api = join(dir, 'api');
  web = join(dir, 'web');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, api);
  git(api, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(api, 'push', '-q', '-u', 'origin', 'main');
  // No upstream: only HEAD is compared.
  git(dir, 'init', '-q', '-b', 'main', web);
  git(web, 'commit', '-q', '--allow-empty', '-m', 'base');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('passes when nothing moved', async () => {
  const before = await readHeads(checkouts(), ENV);
  expect(before[0]).toMatchObject({ repo: 'services/api', upstream: { ref: 'refs/remotes/origin/main' } });
  expect(before[1]).toMatchObject({ repo: 'web', upstream: null });
  expect(runMoved(before, await readHeads(checkouts(), ENV), 'fix')).toBeNull();
});

it('names the repository and both short shas when HEAD moved, also where there is no upstream', async () => {
  const before = await readHeads(checkouts(), ENV);
  const from = short(web);
  git(web, 'commit', '-q', '--allow-empty', '-m', 'run');
  expect(runMoved(before, await readHeads(checkouts(), ENV), 'fix')).toBe(
    `The fix run made a commit in web (${from} to ${short(web)}). Nolzu does not commit for you. Look at git log in the checkout, keep or undo it, then commit from Changes.`,
  );
});

it('says the run pushed when the upstream ref moved, and made a commit as well', async () => {
  const before = await readHeads(checkouts(), ENV);
  const from = short(api);
  git(api, 'commit', '-q', '--allow-empty', '-m', 'run');
  git(api, 'push', '-q');
  const said = runMoved(before, await readHeads(checkouts(), ENV), 'fix');
  expect(said).toContain(`The fix run made a commit in services/api (${from} to ${short(api)}).`);
  expect(said).toContain(`The fix run pushed from services/api (origin/main ${from} to ${short(api)}). Nolzu does not push for you.`);
});

it('says the run pushed when only the upstream ref moved', async () => {
  const before = await readHeads(checkouts(), ENV);
  const from = short(api);
  // A push of another commit, with HEAD left where it was.
  git(api, 'commit', '-q', '--allow-empty', '-m', 'run');
  git(api, 'push', '-q');
  git(api, 'reset', '-q', '--soft', 'HEAD~1');
  const said = runMoved(before, await readHeads(checkouts(), ENV), 'fix');
  expect(said).not.toContain('made a commit');
  expect(said).toContain(`pushed from services/api (origin/main ${from} to ${short(api, 'origin/main')})`);
});

it('gives a reason for a checkout that is gone at the end or could not be read at the start', async () => {
  const before = await readHeads(checkouts(), ENV);
  rmSync(web, { recursive: true, force: true });
  expect(runMoved(before, await readHeads(checkouts(), ENV), 'fix')).toBe(
    `Nolzu could not read web when the fix run ended (there is no checkout at ${web}), so it cannot tell whether the run made a commit or pushed. Look at git log in the checkout before you commit from Changes.`,
  );
  expect(runMoved([{ repo: '.', problem: 'git could not read HEAD in x' }], [], 'fix')).toContain('Nolzu could not read the card checkout when the fix run started (git could not read HEAD in x)');
});

it('gives a reason for a start it could not read even when the end reads well, and for an end never read', async () => {
  const after = await readHeads(checkouts(), ENV);
  expect(runMoved([{ repo: 'web', problem: 'x' }], after, 'fix')).toContain('Nolzu could not read web when the fix run started (x)');
  expect(runMoved(after, [], 'fix')).toContain('Nolzu could not read services/api when the fix run ended (it was not read)');
});

it('gives a reason for a checkout with no commit yet', async () => {
  const empty = join(dir, 'empty');
  git(dir, 'init', '-q', '-b', 'main', empty);
  expect(await readHeads([{ repo: 'empty', path: empty }], ENV)).toEqual([{ repo: 'empty', problem: `git could not read HEAD in ${empty}` }]);
});

it('words an Implement run the same way, one sentence per repository that moved', async () => {
  const before = await readHeads(checkouts(), ENV);
  const api0 = short(api);
  const web0 = short(web);
  git(api, 'commit', '-q', '--allow-empty', '-m', 'run');
  git(api, 'push', '-q');
  git(web, 'commit', '-q', '--allow-empty', '-m', 'run');
  expect(runMoved(before, await readHeads(checkouts(), ENV), 'implement')).toBe(
    [
      `The implement run made a commit in services/api (${api0} to ${short(api)}). Nolzu does not commit for you. Look at git log in the checkout, keep or undo it, then commit from Changes.`,
      `The implement run pushed from services/api (origin/main ${api0} to ${short(api)}). Nolzu does not push for you. Look at the branch on GitHub and decide whether that push stays.`,
      `The implement run made a commit in web (${web0} to ${short(web)}). Nolzu does not commit for you. Look at git log in the checkout, keep or undo it, then commit from Changes.`,
    ].join(' '),
  );
});
