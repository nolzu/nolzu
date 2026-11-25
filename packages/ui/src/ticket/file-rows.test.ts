import type { CardFile } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { fileRows, foldOf } from './file-rows.ts';

const file = (path: string, size = 1): CardFile => ({ path, name: path.split('/').pop() ?? path, size, kind: 'markdown', phase: null, modified: 0 });
const shape = (rows: ReturnType<typeof fileRows>) => rows.map((row) => (row.kind === 'file' ? row.file.path : `${row.path} ${row.files.length} ${row.size}`));

// A real card left npm logs and four coverage files in implement/, and the tab listed them beside pr.md.
it('folds every folder right under the group, everything below it too, and lists the group own files', () => {
  const files = [file('implement/pr.md'), file('implement/work/cov.json', 2), file('implement/work/logs/a.log', 2), file('implement/progress.md'), file('implement/x/one.md')];
  expect(shape(fileRows({ folder: 'implement', share: false, files }))).toEqual(['implement/pr.md', 'implement/work 2 4', 'implement/progress.md', 'implement/x 1 1']);
});

it('folds the group own files when they pass the limit, and lists them at the limit', () => {
  const files = [file('notes/a.md'), file('notes/b.md'), file('notes/c.md'), file('notes/sub/d.md')];
  expect(shape(fileRows({ folder: 'notes', share: false, files }, 2))).toEqual(['notes 3 3', 'notes/sub 1 1']);
  expect(shape(fileRows({ folder: '', share: false, files: [file('a.md'), file('b.md')] }, 2))).toEqual(['a.md', 'b.md']);
  expect(shape(fileRows({ folder: '', share: false, files: [file('a.md'), file('b.md'), file('c.md')] }, 2))).toEqual([' 3 3']);
});

it('lists every own file of a group at fifty or fewer', () => {
  const files = Array.from({ length: 50 }, (_, at) => file(`qa/${at}.md`));
  expect(fileRows({ folder: 'qa', share: false, files }).every((row) => row.kind === 'file')).toBe(true);
  expect(fileRows({ folder: 'qa', share: false, files: [...files, file('qa/x.md')] })).toHaveLength(1);
});

it('finds the folded row that holds a file, and none for a listed one', () => {
  const groups = [{ folder: 'qa', share: false, files: [file('qa/report.md'), file('qa/evidence/1-list.png')] }];
  expect(foldOf(groups, 'qa/evidence/1-list.png')).toBe('qa/evidence');
  expect(foldOf(groups, 'qa/report.md')).toBeNull();
});
