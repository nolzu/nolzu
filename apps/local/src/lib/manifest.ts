import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isFolderName } from '@nolzu/core';
import { projectPlace, cloneTarget, commitKnowledgeFiles, git, gitEnv, type RunGit, writablePath } from '@nolzu/runner';

/**
 * The tracked list of a project's clones, so a teammate who clones the workspace can clone the rest.
 *
 * The file travels with the workspace, so every entry is read as untrusted: its URL passes the same
 * rules as a URL a person types, and a bad entry is named rather than thrown.
 */

export const MANIFEST = '.nolzu/repositories.json';

export interface ManifestRepo {
  folder: string;
  url: string;
  base: string;
}

// The list in the file, or the sentence that says why there is none. Entries are left as they are.
function entries(text: string): { list: unknown[] } | { why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { why: `${MANIFEST} is not JSON` };
  }
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as { repositories?: unknown }).repositories : undefined;
  return Array.isArray(list) ? { list } : { why: `${MANIFEST} has no list of repositories` };
}

// A base git reads as a branch and never as an option.
const isBase = (value: unknown): value is string => typeof value === 'string' && value !== '' && !value.startsWith('-') && !/\s/.test(value);

/** The good entries of the file, and one sentence for each bad one. No file is no repository. */
export function parseManifest(text: string | null): { repos: ManifestRepo[]; problems: string[] } {
  if (text === null) return { repos: [], problems: [] };
  const read = entries(text);
  if ('why' in read) return { repos: [], problems: [`${read.why}, so Nolzu reads no repository from it.`] };
  const repos: ManifestRepo[] = [];
  const problems: string[] = [];
  for (const [index, row] of read.list.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      problems.push(`Entry ${index + 1} of ${MANIFEST} is not a folder, a URL and a base branch.`);
      continue;
    }
    const { folder, url, base } = row as Record<string, unknown>;
    if (typeof folder !== 'string' || !isFolderName(folder)) {
      problems.push(`Entry ${index + 1} of ${MANIFEST} names no folder Nolzu can clone into.`);
      continue;
    }
    const entry = `In ${MANIFEST}, the entry ${JSON.stringify(folder)}`;
    const target = cloneTarget(typeof url === 'string' ? url : '');
    if (!target.ok) problems.push(`${entry} cannot be cloned. ${target.reason}`);
    // A clone takes its folder from the URL, so a folder the URL does not name could never be cloned.
    else if (target.name !== folder) problems.push(`${entry} has a URL that clones into ${JSON.stringify(target.name)}, not into ${JSON.stringify(folder)}.`);
    else if (!isBase(base)) problems.push(`${entry} has no base branch Nolzu can use.`);
    else if (repos.some((one) => one.folder.toLowerCase() === folder.toLowerCase())) problems.push(`${entry} is there twice.`);
    else repos.push({ folder, url: (url as string).trim(), base });
  }
  return { repos, problems };
}

/**
 * The file with this entry in it, null when it is there already, or why the file was left alone.
 *
 * An entry of the same folder in any case is replaced. Every other entry stays as it is, a bad one
 * included, because it is a person's to fix. A workspace's file says so at the top, because a root
 * repository that holds code keeps a manifest too, and only a workspace drops its root from the list.
 */
export function manifestWith(text: string | null, repo: ManifestRepo, workspace = false): { text: string } | { problem: string } | null {
  const read = text === null ? { list: [] } : entries(text);
  if ('why' in read) return { problem: `${read.why}, so Nolzu left it alone and did not add ${repo.folder} to it.` };
  const kept = (text === null ? {} : JSON.parse(text)) as Record<string, unknown>;
  const same = (row: unknown) => typeof row === 'object' && row !== null && String((row as { folder?: unknown }).folder).toLowerCase() === repo.folder.toLowerCase();
  const was = read.list.find(same) as Record<string, unknown> | undefined;
  const marked = !workspace || kept.workspace === true;
  if (marked && was !== undefined && was.folder === repo.folder && was.url === repo.url && was.base === repo.base) return null;
  const list = was === undefined ? [...read.list, repo] : read.list.map((row) => (row === was ? repo : row));
  return { text: `${JSON.stringify({ ...kept, ...(workspace ? { workspace: true } : {}), repositories: list }, null, 2)}\n` };
}

/** The .gitignore with `/<folder>/` added, or null when a line ignores the folder already. */
export function ignoreWith(text: string | null, folder: string): string | null {
  const forms = [`/${folder}/`, `/${folder}`, `${folder}/`, folder];
  const lines = (text ?? '').split('\n').map((line) => line.trim());
  if (lines.some((line) => forms.includes(line))) return null;
  const start = text === null || text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
  return `${start}/${folder}/\n`;
}

/** The file without the entry of this folder, in any case, null when it has none, or why it was left alone. */
export function manifestWithout(text: string | null, folder: string): { text: string } | { problem: string } | null {
  if (text === null) return null;
  const read = entries(text);
  if ('why' in read) return { problem: `${read.why}, so Nolzu left it alone and did not take ${folder} out of it.` };
  const same = (row: unknown) => typeof row === 'object' && row !== null && String((row as { folder?: unknown }).folder).toLowerCase() === folder.toLowerCase();
  if (!read.list.some(same)) return null;
  const kept = JSON.parse(text) as Record<string, unknown>;
  return { text: `${JSON.stringify({ ...kept, repositories: read.list.filter((row) => !same(row)) }, null, 2)}\n` };
}

/** The .gitignore without the line that ignores the folder at the top, or null when no line does. */
export function ignoreWithout(text: string | null, folder: string): string | null {
  if (text === null) return null;
  // `api` and `api/` match at any depth, so in a root that holds code they can be the person's own rule.
  const forms = [`/${folder}/`, `/${folder}`];
  const lines = text.split('\n');
  const kept = lines.filter((line) => !forms.includes(line.trim()));
  return kept.length === lines.length ? null : kept.join('\n');
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** Whether the project folder's manifest marks it a workspace. A shape 3 root's manifest never does. */
export function manifestSaysWorkspace(project: string): boolean {
  const path = writablePath(project, MANIFEST);
  const text = path === null ? null : readText(path);
  try {
    return text !== null && (JSON.parse(text) as { workspace?: unknown } | null)?.workspace === true;
  } catch {
    return false;
  }
}

/** The manifest of a project folder, read the way `parseManifest` reads it. */
export function readManifest(project: string): { repos: ManifestRepo[]; problems: string[] } {
  const path = writablePath(project, MANIFEST);
  // A link could point at any file on this machine, and its text would land in a sentence.
  if (path === null) return { repos: [], problems: [`${MANIFEST} is a link or sits in a linked folder, so Nolzu reads no repository from it.`] };
  return parseManifest(readText(path));
}

// One manifest commit per project at a time: a clone from a click, New project or a clone of what is
// missing, a Remove and a Scan again. Each ends in a commit in the project's root, and two at once
// would both commit it. In memory, because one server serves a data folder.
const turns = new Map<string, Promise<unknown>>();
export function inTurn<T>(project: string, work: () => Promise<T>): Promise<T> {
  const run = (turns.get(project) ?? Promise.resolve()).then(work);
  turns.set(project, run.catch(() => undefined));
  return run;
}

// What `recordInRoot` did: `recorded` is false when nothing changed on disk and nothing is left to undo.
export interface Recorded {
  recorded: boolean;
  problem: string | null;
}

/**
 * Gives each new clone its .gitignore line and its manifest entry, and commits both in the project
 * folder's own repository. A clone with no URL Nolzu can clone from gets the line only.
 *
 * A project folder that is not its own repository has nothing to commit to, so it gets neither. When
 * the manifest cannot take the entry, nothing is written. A refused commit leaves both files changed
 * on disk, and the sentence says so.
 */
export async function recordInRoot(
  project: string,
  clones: readonly { folder: string; url: string | null; base: string }[],
  workspace: boolean,
  env: Record<string, string | undefined>,
  subject?: string,
): Promise<Recorded> {
  const run: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>), repo: projectPlace(project) });
  const top = await run(['rev-parse', '--show-prefix']);
  if (top.code !== 0 || top.stdout.trim() !== '' || clones.length === 0) return { recorded: false, problem: null };
  const names = clones.map((clone) => clone.folder).join(', ');

  const ignore = writablePath(project, '.gitignore');
  if (ignore === null) return { recorded: false, problem: `.gitignore in the project folder is a link or not a plain file, so Nolzu did not add ${names} to it.` };
  const listed = clones.some((clone) => clone.url !== null);
  const manifest = writablePath(project, MANIFEST);
  if (listed && manifest === null) return { recorded: false, problem: `${MANIFEST} is a link or sits in a linked folder, so Nolzu did not add ${names} to it.` };

  const ignoreBefore = readText(ignore);
  let ignoreText = ignoreBefore;
  const manifestBefore = listed && manifest !== null ? readText(manifest) : null;
  let manifestText = manifestBefore;
  for (const clone of clones) {
    ignoreText = ignoreWith(ignoreText, clone.folder) ?? ignoreText;
    if (clone.url === null) continue;
    const next = manifestWith(manifestText, { folder: clone.folder, url: clone.url, base: clone.base }, workspace);
    if (next !== null && 'problem' in next) return { recorded: false, problem: next.problem };
    if (next !== null) manifestText = next.text;
  }
  const writes = [
    { name: '.gitignore', path: ignore, text: ignoreText, before: ignoreBefore },
    { name: MANIFEST, path: manifest, text: manifestText, before: manifestBefore },
  ].filter((one): one is { name: string; path: string; text: string; before: string | null } => one.path !== null && one.text !== null && one.text !== one.before);
  if (writes.length === 0) return { recorded: true, problem: null };

  // The commit takes the whole file, so an edit of the person's that is not committed would ride along.
  const theirs = await run(['status', '--porcelain', '--', ...writes.map((one) => one.name)]);
  const changed: string[] = [];
  let writing = '';
  try {
    for (const one of writes) {
      writing = one.name;
      mkdirSync(dirname(one.path), { recursive: true });
      writeFileSync(one.path, one.text);
      changed.push(one.name);
    }
  } catch (error) {
    // Put back what the person had, so a half write leaves no file changed.
    if (changed.includes('.gitignore') && ignoreBefore === null) rmSync(ignore, { force: true });
    else if (changed.includes('.gitignore') && ignoreBefore !== null) writeFileSync(ignore, ignoreBefore);
    return { recorded: false, problem: `Nolzu could not write ${writing} in the project folder. ${(error as Error).message}` };
  }
  if (theirs.code !== 0 || theirs.stdout.trim() !== '') {
    return { recorded: true, problem: `${changed.join(' and ')} name ${names} now. Nolzu did not commit them, because they held changes of yours that were not committed.` };
  }
  try {
    await commitKnowledgeFiles(run, subject ?? `chore: add ${names}`, changed);
  } catch (error) {
    return { recorded: true, problem: `${changed.join(' and ')} name ${names} now, but git could not commit them. ${(error as Error).message}` };
  }
  return { recorded: true, problem: null };
}

/**
 * Takes a removed clone out of the root's .gitignore and manifest, and commits both, in two steps.
 *
 * The check runs before the folder goes, so a file Nolzu cannot change stops the remove while
 * nothing is lost. `finish` writes after the folder went, and answers what it could not do. A
 * project folder that is not its own repository keeps neither file. Edits of the person that are
 * not committed stop the commit, not the write, as they do on an add.
 */
export async function forgetInRoot(
  project: string,
  folder: string,
  env: Record<string, string | undefined>,
): Promise<{ problem: string } | { finish: () => Promise<string | null> }> {
  const nothing = { finish: async () => null };
  // git cannot start in a folder that is gone, and such a folder has nothing to take out.
  if (!existsSync(project)) return nothing;
  const run: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>), repo: projectPlace(project) });
  const top = await run(['rev-parse', '--show-prefix']);
  if (top.code !== 0 || top.stdout.trim() !== '') return nothing;

  const ignore = writablePath(project, '.gitignore');
  if (ignore === null) return { problem: `.gitignore in the project folder is a link or not a plain file, so Nolzu cannot take ${folder} out of it.` };
  const manifest = writablePath(project, MANIFEST);
  if (manifest === null) return { problem: `${MANIFEST} is a link or sits in a linked folder, so Nolzu cannot take ${folder} out of it.` };
  // The text is read here only to refuse a file Nolzu cannot change. finish reads it again, because
  // another add or remove may write these files while this folder is deleted.
  let ignoreBefore: string | null = null;
  const next = (): { problem: string } | { name: string; path: string; text: string }[] => {
    const manifestNext = manifestWithout(readText(manifest), folder);
    if (manifestNext !== null && 'problem' in manifestNext) return manifestNext;
    ignoreBefore = readText(ignore);
    return [
      { name: '.gitignore', path: ignore, text: ignoreWithout(ignoreBefore, folder) },
      { name: MANIFEST, path: manifest, text: manifestNext?.text ?? null },
    ].filter((one): one is { name: string; path: string; text: string } => one.text !== null);
  };
  const first = next();
  if ('problem' in first) return first;

  return {
    finish: async () => {
      if (first.length === 0) return null;
      const theirs = await run(['status', '--porcelain', '--', ...first.map((one) => one.name)]);
      // No await from this read to the last write, so no other request of this server writes in between.
      const writes = next();
      if ('problem' in writes) return writes.problem;
      const changed: string[] = [];
      try {
        for (const one of writes) {
          writeFileSync(one.path, one.text);
          changed.push(one.name);
        }
      } catch (error) {
        if (changed.includes('.gitignore') && ignoreBefore !== null) writeFileSync(ignore, ignoreBefore);
        return `Nolzu could not take ${folder} out of ${writes[changed.length]?.name} in the project folder. ${(error as Error).message}`;
      }
      if (changed.length === 0) return null;
      const names = changed.join(' and ');
      if (theirs.code !== 0 || theirs.stdout.trim() !== '') return `${names} no longer name ${folder}. Nolzu did not commit them, because they held changes of yours that were not committed.`;
      try {
        await commitKnowledgeFiles(run, `chore: remove ${folder}`, changed);
      } catch (error) {
        return `${names} no longer name ${folder}, but git could not commit them. ${(error as Error).message}`;
      }
      return null;
    },
  };
}
