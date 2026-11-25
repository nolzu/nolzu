import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cloneTarget } from '@nolzu/runner';
import { addRepository, type Clone } from '../src/lib/add-repo.ts';
import { createWorkspace } from '../src/lib/onboard.ts';
import { SPLIT_REPOS, splitWorkspace } from './split-workspace.ts';

type Env = Record<string, string | undefined>;

// The URL each demo repository is added by. Its last part names the folder, as for any clone.
export const demoUrl = (repo: string): string => `https://github.com/example/${repo}.git`;

/**
 * Makes a new workspace at `project` and adds the demo's api and web to it, the way a person does
 * with "Add a repository". `scratch` must be a new folder. It ends up holding `source`, the split copy
 * of the demo with its tickets, and `remotes`, a bare repository per service that each clone's origin
 * points at.
 *
 * Throws with the app's own sentence when a step is refused.
 */
export async function demoWorkspace(db: DatabaseSync, project: string, scratch: string, env: Env): Promise<{ source: string; said: string[] }> {
  const demo = join(import.meta.dirname, '..', '..', '..', 'examples', 'recipe-workspace');
  const source = join(scratch, 'source');
  const remotes = join(scratch, 'remotes');
  cpSync(demo, source, { recursive: true });
  splitWorkspace(source, { rootRepo: false, env });
  mkdirSync(remotes);
  for (const repo of SPLIT_REPOS) execFileSync('git', ['clone', '-q', '--bare', join(source, repo), join(remotes, `${repo}.git`)], { env, stdio: 'ignore' });

  // The app's clone takes only https and ssh, and refuses a local path. A script is not the app, so it
  // passes its own clone, as the tests do: the URL still goes through the real folder rules, and git
  // clones the local bare repository in its place.
  const clone: Clone = async ({ workspace, url, taken }) => {
    const target = cloneTarget(url, taken);
    if (!target.ok) return target;
    const path = join(workspace, target.name);
    execFileSync('git', ['clone', '-q', join(remotes, `${target.name}.git`), path], { env, stdio: 'ignore' });
    return { ok: true, name: target.name, path };
  };

  const made = await createWorkspace(db, { parent: dirname(project), name: basename(project), env });
  if (!made.ok) throw new Error(made.reason);
  const said: string[] = [];
  for (const repo of SPLIT_REPOS) {
    const added = await addRepository(db, demoUrl(repo), env, clone);
    if ('problem' in added) throw new Error(added.problem);
    said.push(added.said);
  }
  return { source, said };
}
