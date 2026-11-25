import type { CardFile, CardFileGroup } from '@nolzu/protocol';

// When the group's own files pass this many, they show as one line with their count and size too.
export const FOLD_OVER = 50;

export type FileRow = { kind: 'file'; file: CardFile } | { kind: 'fold'; path: string; files: CardFile[]; size: number };

// The rows of one group. The group's own files are the ones its phase promises, so they are listed,
// unless there are more than `over` of them. Every folder right under the group, such as `work/` or
// `evidence/`, is one row at the place of its first file, with everything below it, so a person sees
// the expected files first.
export function fileRows(group: CardFileGroup, over = FOLD_OVER): FileRow[] {
  const prefix = group.folder === '' ? '' : `${group.folder}/`;
  const folderOf = (file: CardFile) => {
    const rest = file.path.slice(prefix.length);
    return rest.includes('/') ? `${prefix}${rest.slice(0, rest.indexOf('/'))}` : group.folder;
  };
  const byFolder = new Map<string, CardFile[]>();
  for (const file of group.files) byFolder.set(folderOf(file), [...(byFolder.get(folderOf(file)) ?? []), file]);

  const rows: FileRow[] = [];
  const folded = new Set<string>();
  for (const file of group.files) {
    const path = folderOf(file);
    const files = byFolder.get(path) ?? [];
    if (path === group.folder && files.length <= over) rows.push({ kind: 'file', file });
    else if (!folded.has(path)) {
      folded.add(path);
      rows.push({ kind: 'fold', path, files, size: files.reduce((sum, one) => sum + one.size, 0) });
    }
  }
  return rows;
}

// The folded row that holds this file, or null when the file is listed on its own.
export function foldOf(groups: readonly CardFileGroup[], path: string): string | null {
  for (const row of groups.flatMap((group) => fileRows(group))) {
    if (row.kind === 'fold' && row.files.some((file) => file.path === path)) return row.path;
  }
  return null;
}
