import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BaseBranch, BranchPreview, ProjectScan, ScannedRemote, ScannedRepo } from '@nolzu/protocol';
import { branchName } from './branch-name.ts';
import { gitEnv } from './env.ts';
import { parseRemote, withoutCredentials } from './remote.ts';
import { git, type GitResult } from './exec.ts';

export interface ScanOptions {
  branchTemplate: string;
  // The card the preview is built from. The setup page renders the preview again as the person
  // edits the template, so the scan only has to produce the first one.
  key?: string;
  title?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const PREVIEW_KEY = 'PROJ-123';
const PREVIEW_TITLE = 'Example card';

type Run = (args: readonly string[]) => Promise<GitResult>;

const runner =
  (cwd: string, options: ScanOptions): Run =>
  (args) =>
    // Always built here rather than passed straight through. Left undefined, spawn inherits this
    // process's own environment, and a stray GIT_DIR there points every answer at one repository.
    git(args, { cwd, env: gitEnv(options.env ?? process.env), signal: options.signal });

// git walks up until it finds a repository, so a plain folder inside one answers with the
// parent. Only a folder that is its own top level counts, which is what keeps every
// subfolder of a project from being reported as a project.
async function repoAt(folder: string, options: ScanOptions): Promise<string | null> {
  let top;
  try {
    top = await runner(folder, options)(['rev-parse', '--show-toplevel']);
  } catch {
    // A folder that cannot be entered reaches spawn as EACCES, which throws rather than answering
    // with an exit code. It is not a repository as far as anything here can tell, and one of them
    // must not take the whole scan down with it.
    return null;
  }
  if (top.code !== 0 || top.stdout.trim() === '') return null;
  try {
    const here = await realpath(top.stdout.trim());
    return here === (await realpath(folder)) ? here : null;
  } catch {
    return null;
  }
}

// A linked worktree has its own top level but shares the .git folder of the repository it was
// made from, so the common dir is what tells the two apart.
async function commonDir(folder: string, options: ScanOptions): Promise<string | null> {
  try {
    const found = await runner(folder, options)(['rev-parse', '--git-common-dir']);
    return found.code === 0 ? await realpath(resolve(folder, found.stdout.trim())) : null;
  } catch {
    return null;
  }
}

// The branch a card starts from: what origin points at, else what is checked out. A detached
// HEAD has neither, so the commit goes back and the person picks.
async function baseBranch(run: Run): Promise<BaseBranch> {
  const head = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const pointed = head.stdout.trim();
  if (head.code === 0 && pointed !== '') {
    // symbolic-ref resolves the pointer without checking that what it points at is still there,
    // which is the normal state of a clone whose default branch was renamed. Handing that name on
    // gives onboarding a base no later git call can use.
    const target = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${pointed}`]);
    if (target.code === 0) {
      // origin/main, or origin/release/next. Only the remote name comes off, so a branch with
      // slashes in it survives whole.
      return { kind: 'branch', name: pointed.slice(pointed.indexOf('/') + 1) };
    }
  }

  const current = await run(['branch', '--show-current']);
  // Empty and a zero exit is how git reports a detached HEAD.
  if (current.code === 0 && current.stdout.trim() !== '') {
    const name = current.stdout.trim();
    // A repository before its first commit names its branch here, and so does one whose checked
    // out branch was deleted. Neither has a commit to cut a card branch from.
    const born = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    return born.code === 0 ? { kind: 'branch', name } : { kind: 'unborn', name };
  }

  const commit = await run(['rev-parse', 'HEAD']);
  return { kind: 'detached', commit: commit.stdout.trim() };
}

async function remotes(run: Run): Promise<readonly ScannedRemote[]> {
  return [...(await remoteUrls(run))].map(([name, url]) => parseRemote(name, url));
}

async function remoteUrls(run: Run): Promise<Map<string, string>> {
  const listed = await run(['remote', '-v']);
  if (listed.code !== 0) return new Map();

  // Every remote prints twice, once to fetch and once to push. The fetch row is the one a
  // scan reads, because that is the repository the card is based on.
  const urls = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    // git puts a tab between the name and the URL, so a URL holding a space is ordinary. Splitting
    // on any whitespace dropped the whole row, and a repository with an origin then reported none.
    const row = /^(\S+)\t(.+) \(fetch\)$/.exec(line.trim());
    if (row !== null) urls.set(row[1] ?? '', row[2] ?? '');
  }
  return urls;
}

async function readRepo(dir: string, path: string, options: ScanOptions): Promise<ScannedRepo> {
  const run = runner(dir, options);
  return { path, base: await baseBranch(run), remotes: await remotes(run) };
}

// The repository the folder is, then the repositories one level down. One level is the cap: a project folder
// holds its repositories at the top, and walking deeper turns a scan into a disk crawl.
export async function scanProject(folder: string, options: ScanOptions): Promise<ProjectScan> {
  let here;
  try {
    here = await stat(folder);
  } catch {
    // Checked before git runs. A bad cwd reaches spawn as ENOENT, the same code a missing
    // binary gives, and the git helper reads that as git not being installed.
    return { ok: false, reason: `The folder ${folder} is not there. Pick the folder that holds your project.` };
  }
  if (!here.isDirectory()) {
    return { ok: false, reason: `${folder} is a file, not a folder. Pick the folder that holds your project.` };
  }
  try {
    // Entering and listing a folder need a permission that stat does not check. Without this the
    // folder reaches git as a working directory, spawn fails with EACCES, and the git helper reads
    // that as git not being installed.
    await access(folder, constants.R_OK | constants.X_OK);
  } catch {
    return { ok: false, reason: `The folder ${folder} cannot be read. Check that it is a folder you can open.` };
  }

  // A bare repository has no working copy for a card to run in, so it is refused. Saying there is
  // no repository here to somebody standing in one is what was wrong, not the refusal.
  const bare = await runner(folder, options)(['rev-parse', '--is-bare-repository']);
  // Nolzu's git refuses a bare repository it did not name (`safe.bareRepository` in `git/exec.ts`),
  // and says so in its own words.
  if ((bare.code === 0 && bare.stdout.trim() === 'true') || bare.stderr.includes('cannot use bare repository')) {
    return { ok: false, reason: `${folder} is a bare repository, which has no working copy for a card to run in. Pick a clone with one.` };
  }

  // A template with a placeholder git refuses is a setting somebody typed. Letting it throw lost
  // the repositories, the base branch and the remotes over the least important thing here.
  let branchPreview: BranchPreview;
  try {
    branchPreview = { ok: true, name: branchName(options.branchTemplate, options.key ?? PREVIEW_KEY, options.title ?? PREVIEW_TITLE) };
  } catch (error) {
    branchPreview = { ok: false, reason: (error as Error).message };
  }

  // A root repository comes first, and its child repositories after it: an initialised submodule,
  // or a repository the root ignores. Its plain folders answer with the root and are not listed.
  const root = await repoAt(folder, options);
  const repos: ScannedRepo[] = root === null ? [] : [await readRepo(folder, '.', options)];

  let children;
  try {
    children = await readdir(folder, { withFileTypes: true });
  } catch {
    if (root !== null) return { ok: true, repos, branchPreview };
    return { ok: false, reason: `The folder ${folder} cannot be read. Check that it is a folder you can open.` };
  }

  // One at a time. A project folder holds a handful of repositories, and a scan that spawned
  // a git per child at once would fight the agents already running for the same disk.
  // A symlink dirent answers false to isDirectory, so filtering on that alone dropped a child that
  // is a link to a repository, which is an ordinary way to lay a project folder out. A link that
  // dangles or points at a file is refused by the repository check itself, where git fails to run.
  const candidates = children
    .filter((child) => child.isDirectory() || child.isSymbolicLink())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // One repository can sit under two names when a child is a link to a sibling. Offering it twice
  // would let two cards run against one worktree, so the first name in order wins.
  // The winner per repository is picked before anything is read. A real directory beats a link to
  // the same repository whatever the names sort like, because the folder the person opened is the
  // one they know, and an alias that sorts first would otherwise take its place.
  const rootCommon = root === null ? null : await commonDir(folder, options);
  const chosen = new Map<string, { name: string; link: boolean }>();
  for (const child of candidates) {
    const top = await repoAt(join(folder, child.name), options);
    // A link back to the root, or a linked worktree of it, would list the root a second time.
    if (top === null || top === root) continue;
    if (rootCommon !== null && (await commonDir(top, options)) === rootCommon) continue;
    const link = !child.isDirectory();
    const already = chosen.get(top);
    if (already === undefined || (already.link && !link)) chosen.set(top, { name: child.name, link });
  }

  const inNameOrder = [...chosen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name } of inNameOrder) {
    try {
      repos.push(await readRepo(join(folder, name), name, options));
    } catch {
      // It answered as a repository and then stopped being readable. Skipping it keeps the
      // repositories beside it, which are the ones the person came for.
      continue;
    }
  }

  if (repos.length === 0) {
    return { ok: false, reason: 'No git repository here, and none one level down. Pick the folder that holds the repository.' };
  }
  return { ok: true, repos, branchPreview };
}

// Where people keep their code, under the home folder. New project lists what it finds there.
export const MACHINE_ROOTS = ['code', 'projects', 'src'] as const;

// A repository found on this machine, by its path under the home folder, with the fetch URL of each
// remote, so Add can clone a fresh copy from where it came from. A login in a URL is taken off first,
// because the list goes to the page.
export interface FoundRepo {
  path: string;
  remotes: readonly { name: string; url: string }[];
}

// The repositories one level down in each root, through the scan a project folder gets. A root that is
// not there, cannot be read or holds no repository is left out without a word, because most machines
// have one of the three at most.
export async function scanMachine(home: string, options: Pick<ScanOptions, 'env' | 'signal'>): Promise<FoundRepo[]> {
  const found: FoundRepo[] = [];
  for (const root of MACHINE_ROOTS) {
    const folder = join(home, root);
    // The branch preview is not shown here, so any template that git takes will do.
    const scan = await scanProject(folder, { ...options, branchTemplate: '{key}' });
    if (!scan.ok) continue;
    for (const repo of scan.repos) {
      // Limit: a second `git remote -v` per repository, as the scan keeps no GitHub URL. Fine for a
      // few dozen folders.
      const urls = await remoteUrls(runner(join(folder, repo.path), { ...options, branchTemplate: '{key}' }));
      found.push({ path: join(root, repo.path), remotes: [...urls].map(([name, url]) => ({ name, url: withoutCredentials(url) })) });
    }
  }
  return found;
}
