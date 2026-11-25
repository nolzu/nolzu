import type { DiffEntry, FileTreeNode } from '@nolzu/protocol';

// A list of more files than this folds each folder into one row, as the Workspace page folds them.
export const COMMIT_FOLD_OVER = 10;

export type CommitRow = { kind: 'file'; file: DiffEntry } | { kind: 'dir'; path: string; files: DiffEntry[] };

export const entriesOf = (list: readonly FileTreeNode[]): DiffEntry[] => list.flatMap((node) => (node.entry === null ? entriesOf(node.children) : [node.entry]));

// The two groups of Commit and push: files git already tracks that changed, and new ones.
export function commitGroups(files: readonly DiffEntry[]): { changed: DiffEntry[]; added: DiffEntry[] } {
  return { changed: files.filter((file) => file.status !== 'added'), added: files.filter((file) => file.status === 'added') };
}

// The paths a commit of the ticked files names. A rename is two paths to git: without the old one the
// commit would add the new file and keep the old.
export function tickedPaths(files: readonly DiffEntry[], unticked: readonly string[]): string[] {
  return files.filter((file) => !unticked.includes(file.path)).flatMap((file) => (file.oldPath === null ? [file.path] : [file.path, file.oldPath]));
}

// The rows of one group. A short list is flat. A long one puts each file in a folder (its first two
// levels, as the Workspace page does) into that folder's row, at the place of its first file.
export function commitRows(files: readonly DiffEntry[], over = COMMIT_FOLD_OVER): CommitRow[] {
  if (files.length <= over) return files.map((file) => ({ kind: 'file', file }));
  const rows: CommitRow[] = [];
  for (const file of files) {
    const path = file.path.split('/').slice(0, -1).slice(0, 2).join('/');
    const dir = path === '' ? undefined : rows.find((row) => row.kind === 'dir' && row.path === path);
    if (path === '') rows.push({ kind: 'file', file });
    else if (dir?.kind === 'dir') dir.files.push(file);
    else rows.push({ kind: 'dir', path, files: [file] });
  }
  return rows;
}
