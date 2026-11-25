import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The two services of the demo workspace, each its own repository once the copy is split.
export const SPLIT_REPOS = ['api', 'web'] as const;

/**
 * Turns a copy of the demo workspace into a project of two repositories: `services/api` moves to
 * `api/` and `services/web` to `web/`, one level down where the scan looks, with one commit each.
 * With `rootRepo` the project folder is a repository too, and its `.gitignore` lists both, so the
 * scan finds them as child repositories and the root commit leaves their files out.
 *
 * The moves happen in the copy and never in `examples/`, because the fake engine's replays name
 * the `services/` paths. Answers the `repos` setting for the layout, the root first when it is one.
 */
export function splitWorkspace(project: string, options: { rootRepo: boolean; env?: NodeJS.ProcessEnv }): { path: string; base: null }[] {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: options.env ?? process.env, stdio: 'ignore' });
  for (const repo of SPLIT_REPOS) renameSync(join(project, 'services', repo), join(project, repo));
  rmSync(join(project, 'services'), { recursive: true });
  // The docs, the test script and the page's error text name the old paths. Stale ones would send an
  // agent or a person to a folder that is gone.
  for (const entry of readdirSync(project, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, 'utf8');
    if (text.includes('services/')) writeFileSync(file, text.replaceAll('services/', ''));
  }
  for (const repo of SPLIT_REPOS) {
    const at = join(project, repo);
    git(at, 'init', '-q', '-b', 'main');
    git(at, 'add', '-A');
    git(at, 'commit', '-q', '-m', `Recipe ${repo}`);
  }
  if (options.rootRepo) {
    // Anchored, as Nolzu writes them: a bare `api/` would also hide the knowledge folder's `api/`.
    writeFileSync(join(project, '.gitignore'), SPLIT_REPOS.map((repo) => `/${repo}/\n`).join(''));
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'Recipe workspace');
  }
  return [...(options.rootRepo ? ['.'] : []), ...SPLIT_REPOS].map((path) => ({ path, base: null }));
}
