import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// `CODEMAP.md` is what an agent reads instead of exploring, so a stale line sends it to a file or a
// symbol that is gone. This holds every line of the form "- `path`: ... Key symbols: `a`, `b`." to
// the tree: the path exists, and each symbol occurs in that file as a whole word.
const root = import.meta.dirname;
const ENTRY = /^- `([^`]+)`: (.*)$/;
const SYMBOLS = 'Key symbols:';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

it('names only paths that exist and symbols those files hold', () => {
  const lines = readFileSync(join(root, 'CODEMAP.md'), 'utf8').split('\n');
  const stale: string[] = [];
  let entries = 0;

  for (const line of lines) {
    const entry = ENTRY.exec(line);
    if (entry === null) continue;
    entries += 1;
    const [, path = '', rest = ''] = entry;
    const file = join(root, path);
    if (!existsSync(file)) {
      stale.push(`${path}: no such path`);
      continue;
    }
    const at = rest.indexOf(SYMBOLS);
    if (at === -1) continue;
    if (!statSync(file).isFile()) {
      stale.push(`${path}: key symbols on a path that is not a file`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const [, symbol = ''] of rest.slice(at).matchAll(/`([^`]+)`/g)) {
      // A whole word, so `move` cannot pass on the strength of `moveTo`.
      if (!new RegExp(`(?<![\\w$])${escape(symbol)}(?![\\w$])`).test(text)) {
        stale.push(`${path}: no ${symbol}`);
      }
    }
  }

  expect(stale).toEqual([]);
  // A change to the line shape that matched nothing would pass the check above.
  expect(entries).toBeGreaterThan(150);
});
