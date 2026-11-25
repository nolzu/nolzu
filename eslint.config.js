import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';

const packages = ['protocol', 'core', 'runner', 'ui', 'skills'];

// The relative import rule needs one block per folder depth, because the depth decides how
// many `../` stay inside the package. Files deeper than this keep every other boundary rule.
const maxDepth = 8;

const nodeBuiltins = builtinModules.flatMap((name) => (name.startsWith('node:') ? [name] : [name, `node:${name}`]));

const restrict = (names, message) => names.map((name) => ({ name, message }));

// A later block replaces the options of an earlier one for the same rule, so each block
// carries the full list for its files.
function boundary({ root, allow, paths = [], patterns = [], within, ignores }) {
  const refused = packages.filter((name) => !allow.includes(name));
  const shared = [...patterns];
  if (refused.length > 0) {
    shared.push({
      regex: `^@nolzu/(${refused.join('|')})(/|$)`,
      message:
        allow.length > 0
          ? `Only ${allow.map((name) => `@nolzu/${name}`).join(', ')} may be imported here.`
          : 'This package imports no workspace package.',
    });
  }
  const block = (files, extra = []) => ({
    files: [within ? [files, within] : files],
    ...(ignores ? { ignores } : {}),
    rules: { 'no-restricted-imports': ['error', { paths, patterns: [...extra, ...shared] }] },
  });
  const leavesPackage = (depth) => ({
    regex: `^(\\.\\./){${depth + 1},}`,
    message: 'This relative import leaves the package. Import the package by its name.',
  });
  return [
    block(`${root}/**`),
    ...Array.from({ length: maxDepth }, (_, depth) => block(`${root}/${'*/'.repeat(depth)}*`, [leavesPackage(depth)])),
  ];
}

const pureCore = 'Pure core has no Node code. Node code belongs in packages/core/src/node.';
// Core re-exports protocol values, so whatever imports core loads protocol too. A `node:` import
// here breaks pure core, and protocol has no folder to put Node code in.
const pureProtocol = 'Protocol is pure. It holds types and pure functions, no Node code.';
const noSpawn = 'Core never spawns processes. The runner does.';
// Both halves are pure, and packages/core/src/node is the one place Node code may live.
const noNodeGlobals = 'This code is pure. Node globals belong in packages/core/src/node.';
const nodeGlobals = ['process', 'Buffer', '__dirname', '__filename', 'require'];
const noDynamicImport = 'This code is pure, so its imports stay at the top of the file where the boundary rules read them.';

export default defineConfig(
  globalIgnores(['**/.svelte-kit/', '**/build/', '**/dist/', '.vitest/']),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  {
    // ESLint knows no browser or Node globals. svelte-check reports unknown names in .svelte
    // files, and the .js files are config files that fail on load when a name is unknown.
    files: ['**/*.svelte', '**/*.js'],
    rules: { 'no-undef': 'off' },
  },
  boundary({ root: 'packages/protocol', allow: [], paths: restrict(nodeBuiltins, pureProtocol) }),
  boundary({
    root: 'packages/core',
    allow: ['protocol'],
    ignores: ['packages/core/src/node/**'],
    paths: restrict(nodeBuiltins, pureCore),
    patterns: [{ regex: '^\\.{1,2}/(.*/)?node(/|$)', message: pureCore }],
  }),
  boundary({
    root: 'packages/core',
    allow: ['protocol'],
    within: 'packages/core/src/node/**',
    paths: restrict(['child_process', 'node:child_process'], noSpawn),
  }),
  // The runner reads the phase policy and the vendor rules out of core, so the board and the
  // spawn cannot disagree about which vendor runs which phase. Core still imports nothing of the
  // runner, so there is no way back.
  boundary({ root: 'packages/runner', allow: ['protocol', 'core'] }),
  boundary({ root: 'packages/ui', allow: ['protocol'] }),
  boundary({ root: 'packages/skills', allow: ['protocol'] }),
  boundary({ root: 'apps/local', allow: packages }),
  {
    files: ['packages/core/**', 'packages/protocol/**'],
    ignores: ['packages/core/src/node/**'],
    rules: {
      'no-restricted-globals': ['error', ...restrict(nodeGlobals, noNodeGlobals)],
      // `no-restricted-imports` listens to a static import and to nothing else, so `import('node:fs')`
      // walks past it and fails only at run time. `no-restricted-globals` reads a bare name, so
      // `globalThis.process` walks past that one. These two selectors close both shapes.
      // Limit: a computed name such as globalThis['process'] still gets through. Write the check
      // that catches it when something writes one.
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: noDynamicImport },
        { selector: `MemberExpression[object.name="globalThis"][property.name=/^(${nodeGlobals.join('|')})$/]`, message: noNodeGlobals },
      ],
    },
  },
  {
    // The demo project is not part of the workspace. It runs on plain Node and in a browser,
    // the root tsconfig never compiles it, so ESLint knows none of the globals it uses.
    files: ['examples/**'],
    rules: { 'no-undef': 'off' },
  },
);
