import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { execPath } from 'node:process';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, 'examples', 'recipe-workspace');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

it('installs nothing, so the demo runs offline', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.devDependencies).toBeUndefined();
  for (const name of ['node_modules', 'pnpm-lock.yaml', 'package-lock.json']) {
    expect(readdirSync(root)).not.toContain(name);
  }
});

it('carries no git repository, because one cannot nest inside this repository', () => {
  expect(readdirSync(root)).not.toContain('.git');
});

it('stays small enough to belong in the repository', () => {
  const files = walk(root);
  const sizes = files.map((file) => statSync(file).size);
  expect(Math.max(...sizes)).toBeLessThan(64 * 1024);
  expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(200 * 1024);
  const binary = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.pdf', '.ico', '.woff', '.woff2'];
  expect(files.filter((file) => binary.includes(extname(file)))).toEqual([]);
});

it('gives every ticket a local key and a title line', () => {
  const tickets = readdirSync(join(root, 'tickets'));
  expect(tickets.length).toBeGreaterThan(0);
  for (const name of tickets) {
    expect(name).toMatch(/^APP-\d+\.md$/);
    const first = readFileSync(join(root, 'tickets', name), 'utf8').split('\n')[0] ?? '';
    expect(first).toMatch(/^# APP-\d+: .+/);
  }
});

it('leaves the filter for the implement phase to write', () => {
  const source = readFileSync(join(root, 'services/api/src/recipes/list.ts'), 'utf8');
  expect(source).toContain('export function listRecipes');
  // The demo has implement add this. If it were here already, the demo would show
  // an agent writing code that exists.
  expect(source).not.toContain('filterRecipes');
});

it('passes its own tests from a temp copy, with no install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-demo-'));
  try {
    cpSync(root, dir, { recursive: true });
    execFileSync(execPath, ['--test', 'services/api/src/recipes/list.test.ts'], { cwd: dir, stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
