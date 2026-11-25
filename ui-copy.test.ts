import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Text the person reads, wherever it is written. Comments are not UI copy, so they are cut out first.
const ROOTS = ['apps/local/src', 'packages/ui/src', 'packages/core/src', 'packages/runner/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const withoutComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ' '))
    .join('\n');

// No screen promises a feature by a version. The app says what is true today, and a roadmap line on
// a screen is read as a date. The one exception is "Coming soon": it names no version and no date,
// and marks Scout, Evidence, Solo and Team.
it.each(ROOTS)('promises no later version in the copy of %s', (root) => {
  const guilty = files(join(import.meta.dirname, root))
    .map((path) => ({ path, hits: [...withoutComments(readFileSync(path, 'utf8')).matchAll(/[^\n]*\b(?:later version|in a future version|arrives? in phase)\b[^\n]*/gi)] }))
    .filter((file) => file.hits.length > 0)
    .map((file) => `${file.path}: ${file.hits.map((hit) => hit[0].trim()).join(' | ')}`);

  expect(guilty).toEqual([]);
});

// A sentence that sends a person to an address is only worth the ink while that address is there.
// Nothing else in the repository reads these strings, so a renamed route would leave every one of
// them pointing at a 404. Only the app's own phrasing is checked, "the Knowledge screen at
// /knowledge", because that is how a screen is named in the copy.
it.each(ROOTS)('sends a person to a real route in the copy of %s', (root) => {
  const routes = readdirSync(join(import.meta.dirname, 'apps/local/src/routes'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const guilty = files(join(import.meta.dirname, root))
    .flatMap((path) => [...withoutComments(readFileSync(path, 'utf8')).matchAll(/screen at \/([a-z][a-z-]*)/g)].map((hit) => ({ path, name: hit[1] ?? '' })))
    .filter((named) => !routes.includes(named.name))
    .map((named) => `${named.path}: /${named.name}`);

  expect(guilty).toEqual([]);
});
