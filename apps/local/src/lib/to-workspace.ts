import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type QaApp, recipeMoved, repoKnowledgeFolder, repoKnowledgePath, repoMoved, resolveKnowledgeDir, RUN_RECIPE_FILE, validateSetting } from '@nolzu/core';
import { bumpVersion, ENDED, getSetting, markKnowledgeMoved, pendingKnowledgeChanges, writeSetting } from '@nolzu/core/node';
import { isMaintenanceKey } from '@nolzu/protocol';
import { commitKnowledgeFiles, git, gitEnv, type RunGit, SKILL_FOLDERS, writablePath } from '@nolzu/runner';
import { knowledgeFiles } from './knowledge-page.ts';
import { recordInRoot } from './manifest.ts';
import { createWorkspace, type WorkspaceAnswer, workspaceTarget, writeRepoKnowledge } from './onboard.ts';
import { addToList, cardsWithCheckout, cloneableOrigin } from './projects.ts';

/**
 * Turns a project of one repository into a workspace: a new folder is made the way the setup makes
 * one, and the repository folder is moved into it with one rename.
 *
 * A rename keeps local branches and work that is not pushed, and it is undone by moving the folder
 * back. So every check runs before anything is made, and a failure up to the rename leaves the old
 * project as it was. Nolzu never deletes the old folder: it is the folder that moves.
 */

type Env = Record<string, string | undefined>;
type Answer = { said: string } | { problem: string };

export interface ConvertOptions {
  env?: Env;
  // Tests pass these. A test machine has one disk, so a move across disks cannot happen there.
  rename?: (from: string, to: string) => void;
  device?: (path: string) => number;
}

// The coach note on Now that offers the move once. Got it adds it to `seenNotes`.
export const WORKSPACE_NOTE = 'make-workspace';

/**
 * The note Now shows, or null. New project makes every project a workspace, so a project with no list
 * was made before that, and the offer stands until Got it or until the move gives it a list. A
 * repository with repositories inside has its list already, so it is never offered the move.
 */
export function workspaceNote(db: DatabaseSync): string | null {
  const one = getSetting(db, 'projectPath') !== null && getSetting(db, 'repos') === null;
  return one && !getSetting(db, 'seenNotes').includes(WORKSPACE_NOTE) ? WORKSPACE_NOTE : null;
}

const stays = (why: string): Answer => ({ problem: `${why} Nothing was changed.` });

// A path as the shell reads it, so the move-back command can be pasted as it is.
const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

// Within `folder`, or `folder` itself.
const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + sep);

// What a fresh workspace holds, so the repository folder can never land on one of them. Lower case,
// because the default macOS disk reads names that way.
const WORKSPACE_FILES = ['.git', '.gitignore', ...SKILL_FOLDERS.map((folder) => folder.split('/')[0]), '.nolzu', '.tasks', 'worktrees', 'agents.md', 'claude.md', 'workspace.md'];

// A run that is queued or running, by any card or none. The run rows cover the runs with no card,
// and the card state covers a restart, which marks the card before its run row exists.
function liveRun(db: DatabaseSync): string | null {
  const marks = ENDED.map(() => '?').join(', ');
  const run = db.prepare(`SELECT card_key, state FROM runs WHERE state IS NOT NULL AND state NOT IN (${marks}) ORDER BY id LIMIT 1`).get(...ENDED) as { card_key: string; state: string } | undefined;
  const card = db.prepare("SELECT key, state FROM cards WHERE state IN ('queued', 'running') ORDER BY key LIMIT 1").get() as { key: string; state: string } | undefined;
  const key = run?.card_key ?? card?.key;
  if (key === undefined) return null;
  const who = isMaintenanceKey(key) ? 'A maintenance run' : `A run of ${key}`;
  const state = run?.state ?? card?.state ?? 'running';
  const words: Record<string, string> = { waiting_lane: 'waiting for its lane', waiting_review: 'waiting for Knowledge' };
  return `${who} is ${words[state] ?? state}, and it works in the folder that would move. Make this a workspace once it has ended.`;
}

// A checkout git knows of outside the card folders, made by hand, holds the old path and breaks in a move.
async function otherCheckout(project: string, env: Env): Promise<string | null> {
  const trees = await git(['worktree', 'list', '--porcelain'], { cwd: project, env: gitEnv(env as Record<string, string>) });
  if (trees.code !== 0) return `git could not list the checkouts of ${project}. ${trees.stderr.trim()}`;
  const other = trees.stdout.split('\n').filter((line) => line.startsWith('worktree ')).slice(1)[0];
  if (other === undefined) return null;
  return `The repository has another checkout at ${other.slice('worktree '.length)}, and a move breaks it. Remove that checkout first, or run git worktree prune when its folder is gone.`;
}

/**
 * Why the project cannot become a workspace at `<parent>/<name>`, or where everything goes.
 *
 * Asked before anything is written, so a refusal leaves nothing behind.
 */
async function refusal(db: DatabaseSync, answer: WorkspaceAnswer, options: ConvertOptions): Promise<{ problem: string } | { old: string; workspace: string; folder: string; base: string }> {
  const env = options.env ?? process.env;
  const old = getSetting(db, 'projectPath');
  if (old === null) return { problem: 'There is no project set, so there is nothing to turn into a workspace.' };
  if (getSetting(db, 'repos') !== null) return { problem: 'This project has a list of repositories already. Add one in Settings, Project.' };
  let gitFolder;
  try {
    // A rename moves the link itself, and the repository it points at stays where it is.
    if (lstatSync(old).isSymbolicLink()) return { problem: `${old} is a link to ${realpathSync(old)}. A move would take the link and leave the repository. Move it by hand.` };
    gitFolder = lstatSync(join(old, '.git'));
  } catch {
    return { problem: `${old} is not a git repository, so there is no repository to move.` };
  }
  // A linked checkout or a submodule keeps its history elsewhere, under a path a move would break.
  if (!gitFolder.isDirectory()) return { problem: `${old} keeps its git history in another folder, and a move would cut it off. Move it by hand.` };

  const pending = pendingKnowledgeChanges(db)[0];
  if (pending !== undefined) return { problem: `A knowledge change of run ${pending.runId} waits for review. Approve or return it on the Knowledge page first.` };
  const live = liveRun(db);
  if (live !== null) return { problem: live };
  const held = cardsWithCheckout(db, old, '.')[0];
  if (held !== undefined) {
    return { problem: `${held} has a checkout in ${join(old, 'worktrees')}, and a move would break it. Remove the checkouts of closed cards first, or finish the card.` };
  }
  const other = await otherCheckout(old, env);
  if (other !== null) return { problem: other };

  const target = workspaceTarget(answer);
  if (!target.ok) return { problem: target.reason };
  const folder = basename(old);
  const base = getSetting(db, 'baseBranch');
  const listed = validateSetting('repos', [{ path: folder, base }], true);
  if (!listed.ok) return { problem: `The repository folder ${folder} cannot be a repository of a workspace. ${listed.message}` };
  if (WORKSPACE_FILES.includes(folder.toLowerCase())) return { problem: `A workspace holds a ${folder} of its own, so the repository folder ${folder} cannot go in one. Rename the folder first.` };
  if (inside(realpathSync(target.parent), realpathSync(old))) return { problem: `${target.parent} is inside the repository, and a folder cannot move into itself. Pick a folder outside ${old}.` };
  const device = options.device ?? ((path: string) => statSync(path).dev);
  if (device(target.parent) !== device(old)) {
    return {
      problem: `${target.parent} is on another disk than ${old}. Nolzu moves the repository with a rename, which works only on one disk. Pick a folder on the same disk, or make a new project at /new and add the repository there by its URL.`,
    };
  }
  return { old, workspace: target.path, folder, base };
}

/**
 * Makes the workspace, moves the repository into it and rewrites what holds the old path.
 *
 * Up to the rename, a failure puts the settings back and removes the new folder, which Nolzu made a
 * moment ago and which holds nothing of the person's. After the rename nothing is removed. A step that
 * fails then is named, the others still run, and the answer says how to move the folder back.
 */
export async function makeThisAWorkspace(db: DatabaseSync, answer: WorkspaceAnswer, options: ConvertOptions = {}): Promise<Answer> {
  const env = options.env ?? answer.env ?? process.env;
  const checked = await refusal(db, { ...answer, env }, { ...options, env });
  if ('problem' in checked) return stays(checked.problem);
  const { old, workspace, folder, base } = checked;
  const moved = join(workspace, folder);
  const before = { knowledgeDir: getSetting(db, 'knowledgeDir'), qaMcpConfigPath: getSetting(db, 'qaMcpConfigPath') };

  const undo = (why: string, made: boolean): Answer => {
    // The list first, because the flag is refused while a list that needs it is stored.
    writeSetting(db, 'projectPath', old);
    writeSetting(db, 'repos', null);
    writeSetting(db, 'workspace', null);
    writeSetting(db, 'baseBranch', base);
    // Only a workspace that is surely Nolzu's own goes, and only while the repository is still where
    // it was. A half made one stays, because a folder of the same name may have come from elsewhere.
    if (made && existsSync(old) && !existsSync(moved)) {
      rmSync(workspace, { recursive: true, force: true });
      return stays(why);
    }
    const left = existsSync(workspace) ? ` The new folder ${workspace} stays. Remove it before you try again.` : '';
    return { problem: `${why} The project is still ${old}.${left}` };
  };

  // The team stays: it is the same project in a new folder.
  const made = await createWorkspace(db, { ...answer, env }, true);
  if (!made.ok) return undo(made.reason, false);
  try {
    (options.rename ?? renameSync)(old, moved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return undo(
      code === 'EXDEV'
        ? `${workspace} is on another disk than ${old}. Nolzu moves the repository with a rename, which works only on one disk. Pick a folder on the same disk, or make a new project at /new and add the repository there by its URL.`
        : `Nolzu could not move ${old} into ${workspace}. ${(error as Error).message}`,
      true,
    );
  }

  const problems: string[] = [];
  const said: string[] = [`Moved ${old} to ${moved}.`];
  const step = async (name: string, work: () => Promise<string | null> | string | null) => {
    try {
      const failed = await work();
      if (failed !== null) problems.push(failed);
    } catch (error) {
      problems.push(`${name} failed. ${(error as Error).message}`);
    }
  };

  // The .gitignore line first, so nothing in the workspace takes the repository in.
  await step('Recording the repository', async () => {
    const url = await cloneableOrigin(moved, folder, env);
    const recorded = await recordInRoot(workspace, [{ folder, url, base }], true, env);
    if (recorded.recorded || recorded.problem === null) return recorded.problem;
    // A manifest Nolzu cannot read keeps no entry, but the clone still needs its .gitignore line.
    const ignored = await recordInRoot(workspace, [{ folder, url: null, base }], true, env);
    return ignored.problem === null ? recorded.problem : `${recorded.problem} ${ignored.problem}`;
  });

  await step('Saving the settings', () => {
    const listed = addToList(db, [{ path: folder, base }]);
    return listed;
  });

  // Its own step, so a list that failed still leaves no setting pointing into the folder that moved.
  await step('Rewriting the paths', () => {
    // A path under the old folder moved with it. Anything else stays where the person put it.
    const config = before.qaMcpConfigPath;
    if (config !== null && inside(config, old)) writeSetting(db, 'qaMcpConfigPath', join(moved, relative(old, config)));
    if (before.knowledgeDir !== null && inside(before.knowledgeDir, old)) writeSetting(db, 'knowledgeDir', null);
    // The answer for the project folder, which is now one folder in the workspace, moves with it.
    const apps = getSetting(db, 'qaApp');
    const app = apps?.['.'];
    if (apps != null && app !== undefined) {
      const moved: Record<string, QaApp> = { ...apps, [folder]: app.mode === 'dev' ? { ...app, repo: folder } : app };
      delete moved['.'];
      writeSetting(db, 'qaApp', moved);
    }
    return null;
  });

  let tasksMoved = false;
  await step('Moving the card folders', () => {
    const tasks = join(moved, '.tasks');
    if (!existsSync(tasks)) return null;
    renameSync(tasks, join(workspace, '.tasks'));
    tasksMoved = true;
    return null;
  });

  // Every card, a person's pick too: in a project of one repository that pick could only be the
  // project folder, which the workspace has not got. Set by plan, so refine and plan may add to it.
  let cards = 0;
  await step('Giving the cards their repository', () => {
    cards = Number(db.prepare("UPDATE cards SET repos = ?, repos_by = 'plan'").run(JSON.stringify([folder])).changes);
    if (cards > 0) bumpVersion(db);
    return null;
  });

  // A knowledge folder outside the old one is still where it was, with its history.
  const oldKnowledge = resolveKnowledgeDir({ knowledgeDir: before.knowledgeDir, projectPath: old });
  if (oldKnowledge !== null && inside(oldKnowledge, old)) {
    const from = join(moved, relative(old, oldKnowledge));
    await step('Copying the knowledge files', async () => {
      const copied = await copyKnowledge(db, from, folder, env);
      if (copied.count > 0) said.push(`Copied ${copied.count === 1 ? '1 knowledge file' : `${copied.count} knowledge files`} into the workspace's knowledge folder and committed ${copied.count === 1 ? 'it' : 'them'}.`);
      return copied.problem;
    });
    await step('Marking the knowledge history', () => {
      markKnowledgeMoved(db, from);
      return null;
    });
  } else if (oldKnowledge !== null) {
    said.push(`The knowledge folder ${oldKnowledge} stays where it is.`);
  }
  await step('Writing the repository file', async () => (await writeRepoKnowledge(db, [{ path: folder, base }], env)).problem);

  if (tasksMoved) said.push(`Moved the card folders to ${join(workspace, '.tasks')}.`);
  said.push(`${cards === 1 ? '1 card works' : `${cards} cards work`} in ${folder} now.`);
  if (problems.length === 0) return { said: said.join(' ') };
  const back = `To move it back, run mv ${quote(moved)} ${quote(old)}${tasksMoved ? ` and mv ${quote(join(workspace, '.tasks'))} ${quote(join(old, '.tasks'))}` : ''}, then make a new project at /new and add the repository there by its URL. After that, set the team link again. The cards keep ${folder} as their repository, and older knowledge changes cannot be reverted on the Knowledge page.`;
  return { problem: [...said, ...problems, `Nothing was deleted. ${back}`].join(' ') };
}

/**
 * Copies every knowledge file from the folder that moved into the workspace's own, and commits them.
 *
 * A copy and not a move: the old files stay in the repository's history, where the old commits name them.
 */
async function copyKnowledge(db: DatabaseSync, from: string, repo: string, env: Env): Promise<{ count: number; problem: string | null }> {
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  if (folder === null) return { count: 0, problem: 'There is no knowledge folder to copy into.' };
  const files = knowledgeFiles(from);
  if (files.length === 0) return { count: 0, problem: null };
  mkdirSync(folder, { recursive: true });
  const copied: string[] = [];
  const root = repoKnowledgePath('.');
  // The older layout's file of the project folder, in a project that has not moved its knowledge yet.
  const oldRoot = 'repositories/project-root.md';
  for (const path of files) {
    // The project folder's repository file and notes become the moved repository's own: a workspace
    // folder holds no code, so a file for it would send every run to the wrong folder. The run recipe
    // and the files in a folder stay where they are.
    const to = path === oldRoot ? repoKnowledgePath(repo) : path === RUN_RECIPE_FILE || path.includes('/') ? path : `${repoKnowledgeFolder(repo)}${path}`;
    const target = writablePath(folder, to);
    // A file the workspace has already is its own, and a link is never written through.
    if (target === null || existsSync(target)) continue;
    mkdirSync(join(target, '..'), { recursive: true });
    const source = join(from, ...path.split('/'));
    // The run recipe's project folder section now names the folder the repository moved to.
    if (path === RUN_RECIPE_FILE) writeFileSync(target, recipeMoved(readFileSync(source, 'utf8'), repo));
    else if (path === root || path === oldRoot) writeFileSync(target, repoMoved(readFileSync(source, 'utf8'), repo));
    else copyFileSync(source, target);
    copied.push(to);
  }
  if (copied.length === 0) return { count: 0, problem: null };
  const run: RunGit = (args) => git(args, { cwd: folder, env: gitEnv(env as Record<string, string>) });
  try {
    const prefix = (await run(['rev-parse', '--show-prefix'])).stdout.trim();
    await commitKnowledgeFiles(run, 'knowledge: files from the repository', copied.map((path) => prefix + path));
  } catch (error) {
    return { count: copied.length, problem: `The knowledge files are copied to ${folder}, but git could not commit them. ${(error as Error).message}` };
  }
  return { count: copied.length, problem: null };
}
