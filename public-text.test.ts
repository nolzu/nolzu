import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Every text file of the repository is public, comments and tests included. A note that only makes
// sense with private material beside it (a design file, a tracker id, a decision record, a private
// repository) tells a reader nothing and points at what they cannot open. The files are the ones git
// would commit, so a temp folder another test makes meanwhile is not read. This file is the one place
// that names the shapes, so it skips itself.
const ROOT = import.meta.dirname;
const TEXT = /\.(ts|js|mjs|cjs|svelte|md|json|ya?ml|css|html|sql|txt|ndjson|sh)$/;

const files = (): string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => TEXT.test(path) && path !== 'public-text.test.ts' && path !== 'pnpm-lock.yaml' && existsSync(join(ROOT, path)));

const SHAPES: readonly [string, RegExp][] = [
  ['a decision record', /owner questions? \d|owner (?:finding|test|idea)\b|\s\(owner\)|\bowner, (?:20\d\d|phase outputs|[A-Z]{2,3}\d)/i],
  ['a tracker id', /\b(?:OF|RD|RV|EW|BF|PRF)\d+[a-z]?\b|\(T\d\d\)|\bfindings? T\d/],
  ['a design file', /\.dc\.html|\bartboards?\b|\bredesign/i],
  ['a private doc or repository', /PROJECT\.md|PRODUCT-BRIEF|nolzu-cloud(?!-closed)|nolzu-old|server repository/],
  ['a private run', /phase outputs question|\bbaseline run|\bbenchmark/i],
  ['a tool tag', /ponytail/i],
];

it('holds no note that needs private material to read', () => {
  const found = files().flatMap((path) =>
    readFileSync(join(ROOT, path), 'utf8')
      .split('\n')
      .flatMap((line, at) => SHAPES.filter(([, shape]) => shape.test(line)).map(([what]) => `${path}:${at + 1} ${what}: ${line.trim().slice(0, 120)}`)),
  );
  expect(found).toEqual([]);
});

it('catches each shape it names', () => {
  for (const line of ['(owner question 12)', 'Owner, 2026-11-03: x', '(owner, OF35)', 'kept on Free (owner)', 'RD46 draws it', 'the old way (T46)', 'as Ticket.dc.html draws it', 'see PROJECT.md', 'the baseline run', '// ponytail: x']) {
    expect(SHAPES.some(([, shape]) => shape.test(line)), line).toBe(true);
  }
  for (const line of ['owner/repo', 'issueKey(owner, ref.repo)', 'includes(owner))', 'the T1 comment', 'nolzu-cloud-closed-x', 'the drawn card']) {
    expect(SHAPES.some(([, shape]) => shape.test(line)), line).toBe(false);
  }
});
