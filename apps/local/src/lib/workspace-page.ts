import type { RepoState, WorkspaceFile } from '@nolzu/runner';
import type { WorkspaceStatus } from './workspace.ts';

// The Workspace page's words, pure, so the page and its tests read one rule. The types come in as types
// only, so nothing of git or the database reaches the browser.

// What a commit of the Nolzu files alone says when the person writes nothing of their own.
export const NOLZU_MESSAGE = 'chore: update the Nolzu files';

// readRepo's words for a folder that is not on disk, which the table shows as Missing.
const GONE = 'The folder is not there.';

/** The sync column: where the branch stands against its upstream as git last knew it. Nothing is fetched. */
export function syncLine(state: RepoState): string {
  if (!state.ok) return state.reason === GONE ? 'Missing' : 'Cannot read';
  if (state.branch === null) return 'Detached';
  if (state.upstream === null) return 'No upstream';
  const parts = [state.ahead > 0 ? `${state.ahead} to push` : null, state.behind > 0 ? `${state.behind} behind` : null].filter((part) => part !== null);
  return parts.length === 0 ? 'Up to date' : parts.join(', ');
}

/** The status column, in words, so it is not the dot's colour alone. */
export const changedLine = (state: RepoState): string => (!state.ok ? '' : state.files.length === 0 ? 'Clean' : `${state.files.length} changed`);

// git's short letter, with a new file shown as added the way the person thinks of it.
const LETTERS: Record<WorkspaceFile['status'], { letter: string; word: string }> = {
  changed: { letter: 'M', word: 'changed' },
  added: { letter: 'A', word: 'added' },
  untracked: { letter: 'A', word: 'new' },
  deleted: { letter: 'D', word: 'deleted' },
  renamed: { letter: 'R', word: 'renamed' },
  conflicted: { letter: '!', word: 'in conflict' },
};
export const fileMark = (file: WorkspaceFile) => LETTERS[file.status];

/** The message box's text until the person types: the short default for Nolzu files alone, else nothing. */
export function defaultMessage(files: readonly WorkspaceFile[], ticked: ReadonlySet<string>): string {
  const chosen = files.filter((file) => ticked.has(file.path));
  return chosen.length > 0 && chosen.every((file) => file.owner === 'nolzu') ? NOLZU_MESSAGE : '';
}

/** Nolzu's own files start ticked. The person's are never ticked for them. */
export const defaultTicks = (state: RepoState): Set<string> => new Set(state.ok ? state.files.filter((file) => file.owner === 'nolzu').map((file) => file.path) : []);

/** One folder with no change and nothing to push. A folder that cannot be read is not clean: it needs a look. */
export const isClean = (state: RepoState): boolean => state.ok && state.files.length === 0 && state.ahead === 0;

/** Nothing changed anywhere and nothing waits to be pushed. */
export const allClean = (status: WorkspaceStatus): boolean => status.ok && status.repos.every((repo) => isClean(repo.state));

export interface FileFolder {
  path: string;
  files: WorkspaceFile[];
}

// The file list by folder: the files at the top of the repository, then one folder per first two path
// parts, so the three skills folders (.claude/skills and the others) each fold into one line.
export function folderTree(files: readonly WorkspaceFile[]): { top: WorkspaceFile[]; folders: FileFolder[] } {
  const top: WorkspaceFile[] = [];
  const folders: FileFolder[] = [];
  for (const file of files) {
    const parts = file.path.split('/').slice(0, -1);
    if (parts.length === 0) {
      top.push(file);
      continue;
    }
    const path = parts.slice(0, 2).join('/');
    const folder = folders.find((one) => one.path === path);
    if (folder === undefined) folders.push({ path, files: [file] });
    else folder.files.push(file);
  }
  // In number order, so s2 comes before s10. Git lists them by byte.
  const byName = (one: WorkspaceFile, other: WorkspaceFile) => one.path.localeCompare(other.path, 'en', { numeric: true });
  top.sort(byName);
  for (const folder of folders) folder.files.sort(byName);
  return { top, folders };
}

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
