import type { RunEvent } from '@nolzu/protocol';

// Long enough to recognise a command, short enough that a pasted script never travels whole.
const LONGEST = 120;
// A path over this keeps its first folder and its last two parts. A card fits about 35 characters.
const LONG_PATH = 48;

// The verb a tool name reads as. Claude Code names its tools (Read, Edit), Codex its item types
// (command_execution, file_change) and Cursor `<tool>ToolCall`, so a word in the name covers all
// three. The first match wins, which is why edit comes before write.
// Limit: matched on words, so a tool none of these name reads "Using <name>". Add a row when a
// real run shows one that deserves a verb.
const VERBS: readonly (readonly [RegExp, string])[] = [
  [/edit|replace|patch|file_change/i, 'Editing'],
  [/write|create/i, 'Writing'],
  [/read|view/i, 'Reading'],
  [/bash|shell|command|exec|terminal/i, 'Running'],
  [/grep|search/i, 'Searching for'],
  [/glob|find|list/i, 'Finding'],
];

// Where each engine keeps the thing a tool acts on. A command or a pattern before a path, because a
// search names the folder it looks in and the pattern is what it looks for.
const SUBJECTS = ['command', 'CommandLine', 'pattern', 'globPattern', 'query', 'Query', 'file_path', 'notebook_path', 'path', 'TargetFile', 'AbsolutePath', 'DirectoryPath'];
const PATHS = new Set(['file_path', 'notebook_path', 'path', 'TargetFile', 'AbsolutePath', 'DirectoryPath']);

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function subject(input: unknown): { text: string; path: boolean } | null {
  const top = record(input);
  // Claude Code and Codex put the fields on the input, Cursor under `args`, and a Codex file change on
  // each of its `changes`.
  const places = [top, record(top?.args), record(Array.isArray(top?.changes) ? top.changes[0] : null)];
  for (const key of SUBJECTS) {
    for (const place of places) {
      const value = place?.[key];
      if (typeof value === 'string' && value.trim() !== '') return { text: value, path: PATHS.has(key) };
    }
  }
  return null;
}

function shortPath(path: string, cwd: string): string {
  const inside = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  if (inside.length <= LONG_PATH) return inside;
  const parts = inside.split('/');
  // An absolute path keeps its first folder too, not only the empty part before the slash.
  const head = parts.slice(0, parts[0] === '' ? 2 : 1).join('/');
  const tail = parts.slice(-2).join('/');
  const short = `${head}/…/${tail}`;
  return short.length < inside.length ? short : inside;
}

function shortCommand(command: string): string {
  // Codex runs every command through a login shell, and the wrapper says nothing about the work.
  const bare = command.replace(/^\S*\b(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/, '$2');
  const one = bare.replace(/\s+/g, ' ').trim();
  return one.length > LONGEST ? `${one.slice(0, LONGEST - 1)}…` : one;
}

// What a tool acted on, short: the path from the checkout, the command on one line, or the pattern.
// Null when the input names none of them. The Discussion tab's tool rows read it too.
export function toolSubject(input: unknown, cwd: string): string | null {
  const found = subject(input);
  if (found === null) return null;
  return found.path ? shortPath(found.text, cwd) : shortCommand(found.text);
}

/**
 * The last tool action of a run as one line, such as "Reading src/recipes/list.ts", or null for an
 * event that is not a tool.
 *
 * Only the path, the command or the pattern is read. A write carries the whole file body in its
 * input, and none of it ever reaches the line.
 */
export function activityLine(event: RunEvent, cwd: string): string | null {
  if (event.type !== 'tool') return null;
  const name = event.name.replace(/ToolCall$/, '');
  const verb = VERBS.find(([pattern]) => pattern.test(name))?.[1];
  const found = toolSubject(event.input, cwd);
  if (verb === undefined || found === null) return `Using ${name}`;
  return `${verb} ${found}`;
}
