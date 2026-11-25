import { describe, expect, it } from 'vitest';
import { numberedLines, patchLines } from './patch.ts';

const GIT = 'diff --git a/list.ts b/list.ts\nindex e8cce87..ebf94fb 100644\n--- a/list.ts\n+++ b/list.ts\n@@ -1 +1 @@\n-old\n+new\n';

it('starts at the first hunk, and drops the empty last line', () => {
  expect(patchLines(GIT)).toEqual([
    { kind: 'hunk', text: '@@ -1 +1 @@' },
    { kind: 'del', text: '-old' },
    { kind: 'add', text: '+new' },
  ]);
});

it('keeps every line of a patch that has no hunk, such as a mode change', () => {
  const text = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n';
  expect(patchLines(text).map((line) => line.text)).toEqual(['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755']);
});

it('reads a line that starts with three plus or minus signs inside a hunk as a change', () => {
  // The file header is gone by then, so "+++" in a hunk is a line of the file that begins "++".
  expect(patchLines('@@ -1 +1 @@\n---x\n+++y\n').map((line) => line.kind)).toEqual(['hunk', 'del', 'add']);
});

it('reads a context line as unchanged', () => {
  expect(patchLines('@@ -1,2 +1,2 @@\n same\n')[1]).toEqual({ kind: 'same', text: ' same' });
});

describe('numbered lines', () => {
  // A hunk: one line added after line 3, then one line swapped for two.
  const RECIPE = [
    'diff --git a/RecipeCard.svelte b/RecipeCard.svelte',
    '--- a/RecipeCard.svelte',
    '+++ b/RecipeCard.svelte',
    '@@ -2,4 +2,6 @@',
    '   import type { Recipe } from "$lib/types";',
    '+  let failed = false;',
    ' </script>',
    '-  <img src={recipe.imageUrl} />',
    '+  {#if !failed}',
    '+    <img src={recipe.imageUrl} />',
    ' </article>',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('numbers both sides from the hunk header, and only the side a line is on', () => {
    expect(numberedLines(RECIPE).map((line) => [line.kind, line.old, line.new])).toEqual([
      ['hunk', null, null],
      ['same', 2, 2],
      ['add', null, 3],
      ['same', 3, 4],
      ['del', 4, null],
      ['add', null, 5],
      ['add', null, 6],
      ['same', 5, 7],
      // git's marker is no line of the file.
      ['same', null, null],
    ]);
  });

  it('takes the sign off a numbered line, and keeps the hunk header and the marker whole', () => {
    const lines = numberedLines(RECIPE);

    expect(lines[2]).toMatchObject({ sign: '+', code: '  let failed = false;' });
    expect(lines[0]).toMatchObject({ sign: '', code: '@@ -2,4 +2,6 @@' });
    expect(lines[8]).toMatchObject({ sign: '', code: '\\ No newline at end of file' });
  });

  it('numbers a new file from line 1', () => {
    expect(numberedLines('@@ -0,0 +1,2 @@\n+a\n+b\n').map((line) => line.new)).toEqual([null, 1, 2]);
  });

  it('numbers the second hunk from its own header', () => {
    expect(numberedLines('@@ -1 +1 @@\n-a\n+b\n@@ -22,2 +28,2 @@\n x\n y\n').map((line) => line.new)).toEqual([null, null, 1, null, 28, 29]);
  });

  it('gives no number to any line of a patch with no hunk', () => {
    expect(numberedLines('diff --git a/run.sh b/run.sh\nold mode 100644\n').every((line) => line.old === null && line.new === null)).toBe(true);
  });
});
