import { describe, expect, it } from 'vitest';
import { placeComments } from './comments.ts';
import { numberedLines } from './patch.ts';

const comment = (line: number, lineText: string, id = 1) => ({ id, line, lineText });

// A new file of twelve lines, as git shows it in the card's diff.
const file = (lines: readonly string[]) => numberedLines(`@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`);
const recipe = ['<script>', '  let failed = false;', '</script>', '', '<article>', '  {#if !failed}', '    <img />', '  {:else}', '    <div class="img-missing"></div>', '  {/if}', '</article>', ''];

describe('placing comments in the current diff', () => {
  it('shows a comment under its line when the line is where it was', () => {
    const lines = file(recipe);
    const placed = placeComments(lines, [comment(9, '    <div class="img-missing"></div>')]);

    expect(placed.outdated).toEqual([]);
    const [index] = [...placed.at.keys()];
    expect(lines[index!]?.new).toBe(9);
  });

  // An edit put two lines above it, so line 9 is line 11 now and the comment follows it there.
  it('shows a comment at its new line when an edit moved the line', () => {
    const lines = file(['<script>', '  import Placeholder from "./Placeholder.svelte";', '  import { onMount } from "svelte";', ...recipe.slice(1)]);
    const placed = placeComments(lines, [comment(9, '    <div class="img-missing"></div>')]);

    expect(placed.outdated).toEqual([]);
    const [index] = [...placed.at.keys()];
    expect(lines[index!]?.new).toBe(11);
  });

  // The line itself was rewritten, so its text is in no line of the diff now. The comment is kept
  // and shown as outdated, never dropped.
  it('keeps a comment whose line is gone as outdated, not lost', () => {
    const lines = file(recipe.map((line) => (line.includes('img-missing') ? '    <Placeholder />' : line)));
    const gone = comment(9, '    <div class="img-missing"></div>');
    const placed = placeComments(lines, [gone]);

    expect(placed.at.size).toBe(0);
    expect(placed.outdated).toEqual([gone]);
  });

  it('picks the copy of the line nearest its saved number', () => {
    const lines = file(['}', 'a', 'b', '}', 'c', '}']);
    const placed = placeComments(lines, [comment(5, '}')]);

    const [index] = [...placed.at.keys()];
    expect(lines[index!]?.new).toBe(4);
  });

  it('reads a copy far from the saved number as another line, so the comment is outdated', () => {
    const lines = file([...Array.from({ length: 80 }, (_, at) => `line ${at}`), '}']);

    expect(placeComments(lines, [comment(3, '}')]).outdated).toHaveLength(1);
  });

  it('never pins a comment on a removed line, which has no line in the folder', () => {
    const lines = numberedLines('@@ -1,2 +1,1 @@\n-gone\n kept\n');

    expect(placeComments(lines, [comment(1, 'gone')]).outdated).toHaveLength(1);
    expect(placeComments(lines, [comment(1, 'kept')]).at.size).toBe(1);
  });

  it('keeps two comments on one line in the order they came', () => {
    const lines = file(recipe);
    const placed = placeComments(lines, [comment(2, '  let failed = false;', 1), comment(2, '  let failed = false;', 2)]);

    expect([...placed.at.values()][0]?.map((one) => one.id)).toEqual([1, 2]);
  });
});
