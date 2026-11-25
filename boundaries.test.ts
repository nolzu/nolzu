import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const eslint = new ESLint({ cwd: import.meta.dirname });

async function ruleIds(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.map((message) => message.ruleId) ?? [];
}

it('refuses core importing runner', async () => {
  expect(await ruleIds('packages/core/src/board.ts', "import '@nolzu/runner';\n")).toContain('no-restricted-imports');
});

it.each(['node:fs', 'fs'])('refuses pure core importing %s', async (name) => {
  expect(await ruleIds('packages/core/src/board.ts', `import '${name}';\n`)).toContain('no-restricted-imports');
});

it('refuses pure core reading process.env', async () => {
  expect(await ruleIds('packages/core/src/board.ts', 'export const home = process.env.HOME;\n')).toContain(
    'no-restricted-globals',
  );
});

it('allows packages/core/src/node/db.ts to import node:sqlite', async () => {
  const code = "import { DatabaseSync } from 'node:sqlite';\n\nexport const open = (file: string) => new DatabaseSync(file);\n";
  expect(await ruleIds('packages/core/src/node/db.ts', code)).toEqual([]);
});

it('refuses core importing child_process, also in src/node', async () => {
  expect(await ruleIds('packages/core/src/node/db.ts', "import 'node:child_process';\n")).toContain('no-restricted-imports');
});

it('refuses a relative import that leaves the package, and allows one that stays', async () => {
  expect(await ruleIds('packages/core/src/node/db.ts', "import '../../../runner/src/index.ts';\n")).toContain(
    'no-restricted-imports',
  );
  expect(await ruleIds('packages/core/src/node/db.ts', "import '../index.ts';\n")).toEqual([]);
});

it('refuses pure core importing src/node through a relative path', async () => {
  expect(await ruleIds('packages/core/src/index.ts', "import './node/index.ts';\n")).toContain('no-restricted-imports');
});

it('keeps the package rules in folders deeper than the relative import blocks', async () => {
  const code = "import '@nolzu/runner';\nimport 'node:fs';\n";
  expect(await ruleIds('packages/core/src/a/b/c/d/e/f/g/h/i/deep.ts', code)).toEqual([
    'no-restricted-imports',
    'no-restricted-imports',
  ]);
});

it('refuses ui importing core, and allows ui importing protocol', async () => {
  expect(await ruleIds('packages/ui/src/pill.ts', "import '@nolzu/core';\n")).toContain('no-restricted-imports');
  expect(await ruleIds('packages/ui/src/pill.ts', "import '@nolzu/protocol';\n")).toEqual([]);
});

it('allows browser globals in a Svelte file and Node globals in a config file', async () => {
  const page = '<script lang="ts">\n  console.log(window.location.href);\n</script>\n';
  expect(await ruleIds('apps/local/src/routes/+page.svelte', page)).toEqual([]);
  expect(await ruleIds('apps/local/svelte.config.js', 'export const port = process.env.PORT;\n')).toEqual([]);
});

/**
 * Protocol is held to the same rule as pure core, because it is part of pure core at runtime.
 *
 * Pure core has no `node:` builtin at all, and `packages/core/src/index.ts` re-exports modules
 * that take values from protocol. So one `node:` import in protocol breaks pure core.
 */
it.each(['node:fs', 'fs'])('refuses protocol importing %s', async (name) => {
  expect(await ruleIds('packages/protocol/src/ticket.ts', `import '${name}';\n`)).toContain('no-restricted-imports');
});

it('refuses protocol reading process.env', async () => {
  expect(await ruleIds('packages/protocol/src/ticket.ts', 'export const home = process.env.HOME;\n')).toContain(
    'no-restricted-globals',
  );
});

it('refuses a Node builtin in a folder under protocol too', async () => {
  expect(await ruleIds('packages/protocol/src/a/b/deep.ts', "import 'node:crypto';\n")).toContain('no-restricted-imports');
});
