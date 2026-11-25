import { describe, expect, it } from 'vitest';
import { fetchPaste } from './scout-paste.ts';
import { dedup, fingerprint } from './scout.ts';

/**
 * The adapter that needs no credential.
 *
 * Two things carry the weight here. Where the text is cut into items, because a cut per log line
 * makes a finding per line and a cut too wide hides the second problem behind the first. And the
 * cursor, because a person who pastes the same text twice has seen the event once.
 */
const trace = [
  'TimeoutError: request to the recipe list timed out',
  '    at listRecipes (recipes/api/list.ts:40:12)',
  '    at handler (recipes/api/route.ts:18:5)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
].join('\n');

const dump = ['ERROR recipes.api request 7f3a1c failed: timeout', 'ERROR recipes.api request 90bb42 failed: timeout', 'WARN queue depth 41'].join('\n');

describe('fetchPaste', () => {
  it('reads a log dump as one item per line', () => {
    const { items } = fetchPaste(dump, null);

    expect(items).toHaveLength(3);
    expect(items.map((one) => one.message)).toEqual(dump.split('\n'));
  });

  // Pasted text names no error class and no place, so both stay empty and the source's own id is
  // left out. A guess at either one costs findings in both directions.
  it("leaves the error type, the location and the source's own id unset", () => {
    const { items } = fetchPaste(dump, null);

    // Pinned, or a change that returned nothing would leave this test green with no assertion run.
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sourceKind).toBe('paste');
      expect(item.errorType).toBe('');
      expect(item.location).toBe('');
      expect(item.sourceId).toBeUndefined();
    }
  });

  // The cut that matters most. A trace read a frame at a time is four findings for one error, and
  // the three frames say nothing on their own.
  it('reads a stack trace as one item and not one per frame', () => {
    const { items } = fetchPaste(trace, null);

    expect(items).toHaveLength(1);
    // The whole message, not a substring of it. The newline between the frames is part of the event,
    // and a message that lost it fingerprints as a different finding.
    expect(items[0]?.message).toBe(trace.split('\n').map((one) => one.trim()).join('\n'));
  });

  // One case per half of the join rule, because either half can be deleted with every other test
  // still green. This one needs the indent clause: the second line is not a stack frame.
  it('joins an indented line that is not a stack frame', () => {
    const { items } = fetchPaste('DatabaseError: connection refused\n  host: db.example.com port: 5432', null);

    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe('DatabaseError: connection refused\nhost: db.example.com port: 5432');
  });

  // And this one needs the frame clause: a collector that stripped the indent leaves the frame at
  // column zero.
  it('joins a stack frame whose indent the paste lost', () => {
    expect(fetchPaste('TimeoutError: timed out\nat listRecipes (recipes/api/list.ts:40:12)', null).items).toHaveLength(1);
  });

  // A Python traceback names its error on the last line, at column zero. A Java one carries a second
  // error behind `Caused by:`. Both are one event.
  it('reads a Python traceback as one item, error line and all', () => {
    const { items } = fetchPaste(
      ['Traceback (most recent call last):', '  File "recipes/api/list.py", line 40, in list_recipes', '    raise ValueError(id)', 'ValueError: bad recipe id'].join('\n'),
      null,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.message).toContain('ValueError: bad recipe id');
  });

  it('reads a Java trace with a cause as one item', () => {
    const { items } = fetchPaste(
      ['java.lang.RuntimeException: could not list recipes', '\tat com.example.Recipes.list(Recipes.java:40)', 'Caused by: java.io.IOException: refused', '\tat com.example.Pool.open(Pool.java:12)'].join('\n'),
      null,
    );

    expect(items).toHaveLength(1);
  });

  // Two tracebacks in one paste stay two, or the wait a traceback opens would swallow the next one.
  it('keeps two pasted tracebacks apart', () => {
    const { items } = fetchPaste(
      ['Traceback (most recent call last):', '  File "a.py", line 1, in one', 'ValueError: first', 'Traceback (most recent call last):', '  File "b.py", line 2, in two', 'KeyError: second'].join('\n'),
      null,
    );

    expect(items).toHaveLength(2);
    expect(items[1]?.message).toContain('KeyError: second');
  });

  // With the item read from the front of the list instead of the back, the frame below the second
  // error would be glued to the first one and neither finding would be right.
  it('keeps two pasted traces apart', () => {
    const { items } = fetchPaste(`${trace}\nDatabaseError: connection refused\n    at connect (recipes/db/pool.ts:12:3)`, null);

    expect(items).toHaveLength(2);
    expect(items[1]?.message).toBe('DatabaseError: connection refused\nat connect (recipes/db/pool.ts:12:3)');
  });

  it('opens an item for a frame with no line above it', () => {
    const { items } = fetchPaste('    at listRecipes (recipes/api/list.ts:40:12)', null);

    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe('at listRecipes (recipes/api/list.ts:40:12)');
  });

  // A zero-width character is invisible and survives a trim, so a line carrying one in front would
  // fingerprint as a second event that can never merge with the first.
  it('reads a line the same with or without a zero-width character in front of it', () => {
    const plain = fetchPaste('ERROR recipes.api timed out', null).items;
    const hidden = fetchPaste('\u200bERROR recipes.api timed out', null).items;

    expect(hidden.map((one) => one.message)).toEqual(plain.map((one) => one.message));
    expect(fingerprint(hidden[0]!)).toBe(fingerprint(plain[0]!));
  });

  it('drops blank lines and whitespace-only lines', () => {
    expect(fetchPaste('ERROR one\n\n \t \nERROR two\n', null).items.map((one) => one.message)).toEqual(['ERROR one', 'ERROR two']);
  });

  // A collector that ends its lines the Windows way would otherwise leave a carriage return on
  // every message, and a message that ends in one is a different event from the same message
  // pasted from somewhere else.
  it('leaves no carriage return on a message pasted with Windows line endings', () => {
    const { items } = fetchPaste('ERROR one\r\nERROR two\r\n', null);

    expect(items.map((one) => one.message)).toEqual(['ERROR one', 'ERROR two']);
    // A carriage return on its own ends a line as well, or the two lines above would arrive as one
    // message with a control character in the middle of it.
    expect(fetchPaste('ERROR one\rERROR two', null).items.map((one) => one.message)).toEqual(['ERROR one', 'ERROR two']);
  });

  it.each([
    ['empty text', ''],
    ['whitespace-only text', '   \t  '],
    ['only blank lines', '\n\n\n'],
  ])('answers no items for %s, and still the digest of that text as the cursor', (_what, text) => {
    const read = fetchPaste(text, null);

    expect(read.items).toEqual([]);
    expect(read.cursor).toMatch(/^[0-9a-f]{16}$/);
    // Three different pastes of nothing, so three different cursors. A shared one would make the
    // second of them look already read.
    expect(read.cursor).not.toBe(fetchPaste(text === '' ? '\n' : '', null).cursor);
  });

  /**
   * The same paste twice is one finding, not two.
   *
   * No findings table exists yet, so this is asserted where the behaviour lives: the fold is what
   * turns occurrences into one group, and the cursor is what keeps the second read from adding to
   * it at all.
   */
  describe('the same paste twice', () => {
    it('folds into one group per event when both reads are counted', () => {
      const once = fetchPaste(dump, null).items;
      const twice = fetchPaste(dump, null).items;

      expect(dedup([...once, ...twice]).map((group) => group.count)).toEqual([4, 2]);
    });

    it('carries nothing on the second read, so nothing is counted twice', () => {
      const first = fetchPaste(dump, null);
      const again = fetchPaste(dump, first.cursor);

      expect(again.items).toEqual([]);
      expect(again.cursor).toBe(first.cursor);
    });

    // The other side. Text that differs by a single character is a new event, because the digest is
    // taken over the text as pasted and not over the normalized text.
    it('carries the new items when the text has changed', () => {
      const first = fetchPaste(dump, null);
      // The same length, one character different, so only a digest over the text itself sees it. A
      // digest over the length, or over the normalized text, would answer that there is nothing new.
      const next = fetchPaste(dump.replace('7f3a1c', '7f3a1d'), first.cursor);

      expect(next.items).toHaveLength(3);
      expect(next.cursor).not.toBe(first.cursor);
    });

    // A read that carried nothing must not move the marker, or the text before it looks new again.
    it('leaves the cursor where it was when the box was empty', () => {
      const first = fetchPaste(dump, null);
      const nothing = fetchPaste('', first.cursor);

      expect(nothing.items).toEqual([]);
      expect(nothing.cursor).toBe(first.cursor);
      expect(fetchPaste(dump, nothing.cursor).items).toEqual([]);
    });
  });

  /**
   * The ceiling on how many lines join one item.
   *
   * One item per pasted blob would be a message nobody can read, so an item holds fifty lines. The
   * lines past that are not dropped: they open the next item.
   */
  describe('the line ceiling', () => {
    const frames = (count: number) => ['TimeoutError: request timed out', ...Array.from({ length: count }, (_, at) => `    at step${at} (recipes/api/list.ts:${at}:1)`)].join('\n');

    it('joins a trace of exactly fifty lines into one item', () => {
      expect(fetchPaste(frames(49), null).items).toHaveLength(1);
    });

    it('starts a second item with the overflow rather than losing it', () => {
      const { items } = fetchPaste(frames(50), null);

      expect(items).toHaveLength(2);
      expect(items[1]?.message).toBe('at step49 (recipes/api/list.ts:49:1)');
    });
  });
});
