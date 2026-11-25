import type { RunEvent } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { activityLine } from './activity.ts';

const CWD = '/work/recipes/.nolzu/worktrees/APP-1';
const tool = (name: string, input: unknown): RunEvent => ({ type: 'tool', name, input });

// The shapes the four parsers hand on, as their own tests record them.
it.each([
  ['Claude Code Read', tool('Read', { file_path: 'services/api/src/recipes/list.ts' }), 'Reading services/api/src/recipes/list.ts'],
  ['Claude Code Edit', tool('Edit', { file_path: `${CWD}/web/src/lib/RecipeCard.svelte`, old_string: 'a', new_string: 'b' }), 'Editing web/src/lib/RecipeCard.svelte'],
  ['Claude Code Write', tool('Write', { file_path: 'docs/notes.md', content: 'the whole file body' }), 'Writing docs/notes.md'],
  ['Claude Code Bash', tool('Bash', { command: 'pnpm test', description: 'Run the tests' }), 'Running pnpm test'],
  ['Claude Code Grep', tool('Grep', { pattern: 'listRecipes', path: 'services' }), 'Searching for listRecipes'],
  ['Claude Code Glob', tool('Glob', { pattern: '**/*.svelte' }), 'Finding **/*.svelte'],
  ['Codex command', tool('command_execution', { type: 'command_execution', command: '/bin/zsh -lc "sed -n \'1p\' inside.txt"', exit_code: 0 }), "Running sed -n '1p' inside.txt"],
  ['Codex file change', tool('file_change', { type: 'file_change', changes: [{ path: `${CWD}/api/src/recipes.ts`, kind: 'update' }] }), 'Editing api/src/recipes.ts'],
  ['Cursor read', tool('readToolCall', { args: { path: `${CWD}/a.txt` }, result: { success: { content: 'hello' } } }), 'Reading a.txt'],
  ['Cursor shell', tool('shellToolCall', { args: { command: 'ls -1' } }), 'Running ls -1'],
])('reads a %s as one line', (_name, event, line) => {
  expect(activityLine(event, CWD)).toBe(line);
});

// The body of a write never travels: only the line made from its path does.
it('never carries what a tool wrote', () => {
  const line = activityLine(tool('Write', { file_path: 'a.ts', content: 'export const secret = 1;' }), CWD);

  expect(line).not.toContain('secret');
});

it('names a tool it cannot read a subject from', () => {
  expect(activityLine(tool('TodoWrite', { todos: [{ content: 'step one' }] }), CWD)).toBe('Using TodoWrite');
  expect(activityLine(tool('WebFetch', { url: 'https://example.com' }), CWD)).toBe('Using WebFetch');
  expect(activityLine(tool('globToolCall', {}), CWD)).toBe('Using glob');
});

it('is no line for an event that is not a tool', () => {
  expect(activityLine({ type: 'text', text: 'Reading the recipe list.' }, CWD)).toBeNull();
});

// A card is about 35 characters wide. A long path keeps where it starts and the file it ends in.
it('puts the ellipsis in the middle of a long path', () => {
  const line = activityLine(tool('Read', { file_path: 'services/api/src/recipes/search/filters/by-title/index.ts' }), CWD);

  expect(line).toBe('Reading services/…/by-title/index.ts');
});

it('keeps a path outside the checkout whole up to its length, and cuts a long one the same way', () => {
  expect(activityLine(tool('Read', { file_path: '/etc/hosts' }), CWD)).toBe('Reading /etc/hosts');
  expect(activityLine(tool('Read', { file_path: '/opt/tools/share/recipes/fixtures/large/sample-recipes.json' }), CWD)).toBe('Reading /opt/…/large/sample-recipes.json');
});

// A heredoc or a pasted script is one line on the card, and never the whole script.
it('folds a command onto one line and cuts it at the end', () => {
  const line = activityLine(tool('Bash', { command: `cat <<'EOF' > notes.md\n${'a long line of text '.repeat(20)}\nEOF` }), CWD);

  expect(line).not.toContain('\n');
  expect(line?.length).toBeLessThanOrEqual(130);
  expect(line?.endsWith('…')).toBe(true);
});
