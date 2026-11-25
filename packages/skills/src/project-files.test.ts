import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { AGENTS_MD, pointerFile, skillsFolder } from './project-files.ts';
import { readFinishRules } from './text.ts';

it('points at the skills the package ships', () => {
  const folder = skillsFolder();

  expect(existsSync(folder)).toBe(true);
  expect(readdirSync(folder)).toEqual(expect.arrayContaining(['nolzu-refine', 'nolzu-plan', 'nolzu-implement']));
});

// The command sets NOLZU_SKILLS_DIR in a clone too. The skills being edited there must win over the
// copy from the last build.
it('reads the package before the folder the command names', () => {
  const folder = skillsFolder();
  vi.stubEnv('NOLZU_SKILLS_DIR', join(folder, 'no-such-copy'));
  try {
    expect(skillsFolder()).toBe(folder);
  } finally {
    vi.unstubAllEnvs();
  }
});

// One file holds what the project is and the run rules, so there is no WORKSPACE.md to read.
it('says what the two folders of a project are for', () => {
  expect(AGENTS_MD).toContain('worktrees/<card key>/');
  expect(AGENTS_MD).toContain('.tasks/<card key>/');
});

it('tells a run to stay in its checkout and to commit nothing', () => {
  expect(AGENTS_MD).toMatch(/only inside this checkout/);
  expect(AGENTS_MD).toMatch(/Commit nothing/);
});

it('points the entry file at AGENTS.md alone', () => {
  const text = pointerFile('CLAUDE.md');

  expect(text).toContain('# CLAUDE.md');
  expect(text).not.toContain('WORKSPACE.md');
  expect(text).toContain('AGENTS.md');
});

// The files go into the person's own repository, so nothing about this machine may travel in them.
it.each([AGENTS_MD, pointerFile('CLAUDE.md')])('names no path of this machine', (text) => {
  expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\\\/);
});

/**
 * No module of this package reads a packaged file through its own place.
 *
 * These modules are inlined into the app's bundle, and no folder is copied beside them, so
 * `new URL('../shared/finish.md', import.meta.url)` lands next to the bundled file and nothing is
 * there. The built client read the finish rules that way, and every extraction pass in it threw
 * before a person saw a summary. `packageFolder` resolves through the package instead, and this
 * holds the rule for the next file somebody adds.
 */
// `project-files.ts` holds `packageFolder` itself, which needs the module's own place for the
// resolution and for its fallback. `cli.ts` runs from the source tree and is never bundled. Both are
// named here, so the rule below can be wide: any other module that reaches for its own place is a
// file that will not be found in the built client.
const OWN_PLACE_ALLOWED = ['project-files.ts', 'cli.ts'];

it('reads every packaged file through the package and not through a module place', () => {
  const src = fileURLToPath(new URL('.', import.meta.url));
  const offenders = readdirSync(src)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !OWN_PLACE_ALLOWED.includes(name))
    .filter((name) => /import\.meta\.(url|dirname)/.test(readFileSync(join(src, name), 'utf8')));

  expect(offenders).toEqual([]);
});

// The rules themselves, read the way a run reads them, so a resolution that finds nothing is a
// failure here and not a surprise on a card.
it('finds the shared rules the phases end with', () => {
  expect(readFinishRules()).toContain('summary');
});
