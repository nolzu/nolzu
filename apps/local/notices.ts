import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Plugin } from 'vite';

// The package has no dependencies: Svelte, SvelteKit, marked, DOMPurify and the rest are copied into
// it by the build, and their licenses want the copyright line and the license text to travel along.
// The app build records each package it puts in its output, the bin build adds its own and writes
// dist/THIRD-PARTY-NOTICES.md. SvelteKit empties .svelte-kit/output at each build, so the list starts
// fresh with it.
const LIST = join(import.meta.dirname, '.svelte-kit', 'output', 'bundled-packages.json');
const MODULES = `${sep}node_modules${sep}`;

// The folder of the package a module sits in, or null for Nolzu's own code.
function packageOf(id: string): string | null {
  const at = id.lastIndexOf(MODULES);
  if (at === -1) return null;
  const [first = '', second = ''] = id.slice(at + MODULES.length).split(sep);
  return id.slice(0, at + MODULES.length) + (first.startsWith('@') ? `${first}${sep}${second}` : first);
}

// A bare import, found the way Node finds it: in node_modules from `from` upward.
function findPackage(name: string, from: string): string | null {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const found = join(dir, 'node_modules', name);
    if (existsSync(join(found, 'package.json'))) return realpathSync(found);
  }
  return null;
}

const isBare = (spec: string): boolean => !/^(\.|\/|node:|\0)/.test(spec);
const nameOf = (spec: string): string => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
const manifest = (dir: string): { name: string; version: string; license?: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string };

// An import the build left out, such as an SSR external, is bundled later by adapter-node with every
// package it depends on. Nolzu's own packages count for their dependencies only.
function withDependencies(dir: string, found: Set<string>, seen = new Set<string>()): void {
  if (seen.has(dir)) return;
  seen.add(dir);
  if (dir.includes(MODULES)) found.add(dir);
  for (const name of Object.keys(manifest(dir).dependencies ?? {})) {
    const at = findPackage(name, dir);
    if (at !== null) withDependencies(at, found, seen);
  }
}

export function recordPackages(): Plugin {
  return {
    name: 'nolzu-record-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const found = new Set<string>(existsSync(LIST) ? (JSON.parse(readFileSync(LIST, 'utf8')) as string[]) : []);
      const own = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const dir = packageOf(id);
          if (dir !== null) found.add(dir);
        }
        for (const spec of [...chunk.imports, ...chunk.dynamicImports].filter(isBare)) own.add(nameOf(spec));
      }
      for (const name of own) {
        const dir = findPackage(name, import.meta.dirname);
        if (dir !== null) withDependencies(dir, found);
      }
      writeFileSync(LIST, JSON.stringify([...found].sort()));
    },
  };
}

// adapter-node ships its server with these inside, already bundled, and installs none of them.
// Limit: a fixed list; check it against adapter-node's devDependencies when it moves a major.
const ADAPTER_INSIDE = ['polka', 'trouter', 'regexparam', 'sirv', '@polka/url', 'mrmime', 'totalist'];

export function writeNotices(out: string): void {
  const listed = existsSync(LIST) ? (JSON.parse(readFileSync(LIST, 'utf8')) as string[]) : [];
  const adapter = findPackage('@sveltejs/adapter-node', import.meta.dirname);
  const dirs = [...new Set([...listed, ...(adapter === null ? [] : [adapter])])];
  const parts = dirs
    .map((dir) => ({ dir, ...manifest(dir) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((one, at, all) => all.findIndex((other) => other.name === one.name && other.version === one.version) === at)
    .map((one) => {
      const file = readdirSync(one.dir).find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name));
      const text = file === undefined ? `The package holds no license file. Its package.json says ${one.license ?? 'nothing'}.` : readFileSync(join(one.dir, file), 'utf8').trim();
      const inside = one.name === '@sveltejs/adapter-node' ? `. Its server files hold these packages, by Luke Edwards under the MIT license: ${ADAPTER_INSIDE.join(', ')}.` : '';
      return `## ${one.name} ${one.version}\n\nLicense: ${one.license ?? 'not stated'}${inside}\n\n\`\`\`\`text\n${text}\n\`\`\`\`\n`;
    });
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), `# Third-party notices\n\nNolzu's package holds code from these packages, each under its own license.\n\n${parts.join('\n')}`);
}
