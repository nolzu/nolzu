// The Files viewer's JSON tree, pure: whether a file is JSON, its text read as a value, and the words
// a folded object or array shows.

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

// How many levels of the tree start open: the root only, so a big file draws one level and no more.
// Deeper ones open on a press.
export const JSON_OPEN_LEVELS = 1;
// How many children an open node draws before a "Show more" press, so an array of thousands of rows
// does not draw them all at once.
export const JSON_PAGE = 200;

export const isJsonFile = (name: string): boolean => name.toLowerCase().endsWith('.json');

// A number as the file wrote it. JSON.parse keeps a number as a double, which loses the digits of a
// 64-bit id past the fifteenth, so the tree shows the source text instead.
export class JsonNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

// Null when the text is not JSON, so the viewer falls back to the plain text with a line that says so.
// Where the browser hands the reviver each number's source, every number keeps its text. Where it does
// not, `lossy` says an integer passed what a double holds exactly, and the viewer opens on the raw text.
// `sources` false reads as such a browser does, for the test of that path.
export function readJson(text: string, sources = true): { value: unknown; lossy: boolean } | null {
  let lossy = false;
  const keep: Reviver = (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (sources && context?.source !== undefined) return new JsonNumber(context.source);
    if (!Number.isSafeInteger(value) && Number.isInteger(value)) lossy = true;
    return value;
  };
  try {
    return { value: JSON.parse(text, keep as Parameters<typeof JSON.parse>[1]) as unknown, lossy };
  } catch {
    return null;
  }
}

export function jsonKind(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (value instanceof JsonNumber) return 'number';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  // JSON.parse makes nothing else, so this is never reached on a parsed file.
  return 'null';
}

// The children of an object or an array, keyed by name or by place. Empty for a leaf.
export function jsonEntries(value: unknown): [string | number, unknown][] {
  const kind = jsonKind(value);
  if (kind === 'array') return (value as unknown[]).map((item, at) => [at, item]);
  if (kind === 'object') return Object.entries(value as Record<string, unknown>);
  return [];
}

// What a folded object or array says about itself, such as "3 keys" or "1 item".
export function jsonCount(value: unknown): string {
  const count = jsonEntries(value).length;
  const word = jsonKind(value) === 'array' ? 'item' : 'key';
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// A leaf as JSON writes it, so a string keeps its quotes and a person can tell "1" from 1. A number
// shows the text the file holds.
export const jsonLeaf = (value: unknown): string => (value instanceof JsonNumber ? value.source : (JSON.stringify(value) ?? 'null'));
