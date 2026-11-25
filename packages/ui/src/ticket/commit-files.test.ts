import type { DiffEntry } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { commitGroups, commitRows, tickedPaths } from './commit-files.ts';

const file = (path: string, status: DiffEntry['status'] = 'changed', oldPath: string | null = null): DiffEntry => ({ path, oldPath, status, added: 1, removed: 0, binary: false });

it('puts new files in their own group and every other change in Changed', () => {
  const files = [file('a.ts'), file('b.ts', 'added'), file('c.ts', 'deleted'), file('d.ts', 'renamed', 'old-d.ts')];
  expect(commitGroups(files)).toEqual({ changed: [files[0], files[2], files[3]], added: [files[1]] });
});

it('names the ticked paths, both paths of a rename, and none of the unticked', () => {
  const files = [file('a.ts'), file('b.ts', 'added'), file('d.ts', 'renamed', 'old-d.ts')];
  expect(tickedPaths(files, ['b.ts'])).toEqual(['a.ts', 'd.ts', 'old-d.ts']);
  expect(tickedPaths(files, ['a.ts', 'b.ts', 'd.ts'])).toEqual([]);
});

it('keeps a short list flat and folds each folder of a long one at its first two levels', () => {
  expect(commitRows([file('src/a.ts'), file('src/b.ts')], 2).map((row) => row.kind)).toEqual(['file', 'file']);
  const rows = commitRows([file('top.ts'), file('src/lib/a.ts'), file('src/lib/deep/b.ts'), file('docs/c.md')], 3);
  expect(rows.map((row) => (row.kind === 'file' ? row.file.path : `${row.path} ${row.files.length}`))).toEqual(['top.ts', 'src/lib 2', 'docs 1']);
});
