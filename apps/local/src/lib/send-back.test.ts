import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineNow, sendBackMessage, type SendBackLine } from './send-back.ts';

// What Send back with comments tells the Implement run: every open comment once, with its repository,
// its file, the line it points at now and that line's text. An outdated one says so and gives the text
// of the line it was made on.
const line = (over: Partial<SendBackLine>): SendBackLine => ({
  repo: '.',
  file: 'src/lib/RecipeCard.svelte',
  line: 14,
  lineText: '  <img src={recipe.image} alt="" />',
  text: 'Use the recipe title as the alt text.',
  now: 14,
  ...over,
});

describe('sendBackMessage', () => {
  it('names the repository, the file, the line and its text, and the comment', () => {
    const message = sendBackMessage([line({}), line({ repo: 'web', file: 'src/app.css', line: 3, lineText: 'img { width: 100%; }', text: 'Keep the width.', now: 3 })]);

    expect(message).toContain('left 2 comments');
    expect(message).toContain('1. In the project folder, src/lib/RecipeCard.svelte, line 14.\n   The line: <img src={recipe.image} alt="" />\n   Comment: Use the recipe title as the alt text.');
    expect(message).toContain('2. In the web repository, src/app.css, line 3.\n   The line: img { width: 100%; }\n   Comment: Keep the width.');
  });

  it('gives the line it points at now, and the one it was made on when an edit moved it', () => {
    expect(sendBackMessage([line({ line: 12, now: 14 })])).toContain('src/lib/RecipeCard.svelte, line 14 (made on line 12).');
  });

  it('says an outdated comment is outdated, and gives the line it was made on', () => {
    const message = sendBackMessage([line({ line: 12, now: null })]);

    expect(message).toContain('src/lib/RecipeCard.svelte, made on line 12. That line has changed since, so the comment is outdated.');
    expect(message).toContain('The line it was made on: <img src={recipe.image} alt="" />');
    expect(message).not.toContain('line 14');
  });

  it('holds each comment once, in file and line order, and one comment reads as one', () => {
    const message = sendBackMessage([line({ line: 30, now: 30, text: 'second' }), line({ line: 2, now: 2, text: 'first' })]);

    expect(message.split('Comment: first')).toHaveLength(2);
    expect(message.split('Comment: second')).toHaveLength(2);
    expect(message.indexOf('first')).toBeLessThan(message.indexOf('second'));
    expect(sendBackMessage([line({})])).toContain('left 1 comment on');
  });

  it('keeps a comment of several lines under its own number, and names an empty line', () => {
    const message = sendBackMessage([line({ lineText: '   ', text: 'One.\nTwo.' })]);

    expect(message).toContain('The line: (an empty line)');
    expect(message).toContain('Comment: One.\n   Two.');
  });
});

describe('lineNow', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nolzu-send-back-'));
    mkdirSync(join(dir, 'checkout', 'src'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = () => join(dir, 'checkout');

  it('finds the line by its text, nearest the number it was made on', () => {
    writeFileSync(join(checkout(), 'src', 'a.ts'), ['one', 'two', 'target', 'four'].join('\n'));

    expect(lineNow(checkout(), { file: 'src/a.ts', line: 3, lineText: 'target' })).toBe(3);
    // Two lines were added above it since.
    writeFileSync(join(checkout(), 'src', 'a.ts'), ['new', 'new', 'one', 'two', 'target', 'four'].join('\n'));
    expect(lineNow(checkout(), { file: 'src/a.ts', line: 3, lineText: 'target' })).toBe(5);
  });

  it('answers null when the line or the file is gone', () => {
    writeFileSync(join(checkout(), 'src', 'a.ts'), 'one\ntwo\n');

    expect(lineNow(checkout(), { file: 'src/a.ts', line: 1, lineText: 'target' })).toBeNull();
    expect(lineNow(checkout(), { file: 'src/gone.ts', line: 1, lineText: 'one' })).toBeNull();
  });

  it('reads no file a link leads to outside the checkout', () => {
    writeFileSync(join(dir, 'outside.txt'), 'target\n');
    symlinkSync(join(dir, 'outside.txt'), join(checkout(), 'src', 'link.txt'));

    expect(lineNow(checkout(), { file: 'src/link.txt', line: 1, lineText: 'target' })).toBeNull();
    expect(lineNow(checkout(), { file: '../outside.txt', line: 1, lineText: 'target' })).toBeNull();
  });
});
