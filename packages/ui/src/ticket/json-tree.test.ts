import { expect, it } from 'vitest';
import { isJsonFile, jsonCount, jsonEntries, jsonKind, jsonLeaf, JsonNumber, readJson } from './json-tree.ts';

it('knows a JSON file by its name, in any case', () => {
  expect(isJsonFile('scratch-cov.json')).toBe(true);
  expect(isJsonFile('REPORT.JSON')).toBe(true);
  expect(isJsonFile('run.ndjson')).toBe(false);
  expect(isJsonFile('notes.md')).toBe(false);
});

it('reads JSON text as a value, and gives null for text that is not JSON', () => {
  expect(readJson('{"a": [1, true, null]}')).toEqual({ value: { a: [new JsonNumber('1'), true, null] }, lossy: false });
  expect(readJson('0', false)).toEqual({ value: 0, lossy: false });
  expect(readJson('{"a": 1,}')).toBeNull();
  expect(readJson('')).toBeNull();
});

it('names the kind of each value, so each gets its own colour', () => {
  expect([{}, [], 'x', 1, false, null].map(jsonKind)).toEqual(['object', 'array', 'string', 'number', 'boolean', 'null']);
});

it('lists children by name or by place, and none for a leaf', () => {
  expect(jsonEntries({ b: 1, a: 2 })).toEqual([['b', 1], ['a', 2]]);
  expect(jsonEntries(['x', 'y'])).toEqual([[0, 'x'], [1, 'y']]);
  expect(jsonEntries('x')).toEqual([]);
  expect(jsonEntries(null)).toEqual([]);
});

it('counts what a folded node holds, in words', () => {
  expect(jsonCount({ a: 1 })).toBe('1 key');
  expect(jsonCount({})).toBe('0 keys');
  expect(jsonCount([1, 2, 3])).toBe('3 items');
  expect(jsonCount(['a'])).toBe('1 item');
});

it('writes a leaf the way JSON does, so a string keeps its quotes', () => {
  expect(jsonLeaf('1')).toBe('"1"');
  expect(jsonLeaf(1)).toBe('1');
  expect(jsonLeaf(null)).toBe('null');
  expect(jsonLeaf(true)).toBe('true');
});

// A 64-bit id loses its last digits as a double, and the tree must show the id the file holds.
it('keeps each number as the file wrote it, a 64-bit id included', () => {
  const read = readJson('{"id": 1234567890123456789, "pct": 91.50}');
  const [id, pct] = jsonEntries(read?.value).map(([, item]) => item);
  expect(jsonLeaf(id)).toBe('1234567890123456789');
  expect(jsonLeaf(pct)).toBe('91.50');
  expect(jsonKind(id)).toBe('number');
  expect(read?.lossy).toBe(false);
});

// A browser that hands the reviver no source gets the double, and the viewer opens on Raw.
it('says a number lost digits where the source is not handed over', () => {
  expect(readJson('{"id": 1234567890123456789}', false)?.lossy).toBe(true);
  expect(readJson('{"id": 9007199254740991, "pct": 1.5}', false)?.lossy).toBe(false);
});
