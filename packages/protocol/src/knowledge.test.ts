import { describe, expect, it } from 'vitest';
import { frontmatterDescription, frontmatterPaths, isMaintenanceKey, KB_MAINTENANCE_KEY, learnRepoKey, repoOfLearnKey } from './knowledge.ts';

const NOTE = `---
description: Read before changing the importer. Why it refuses a row with no id.
source: APP-12 at 1a2b3c4 (2026-10-25)
paths: src/importer/rows.ts, src/importer/
---

The importer refuses a row with no id.
`;

describe('the description of a knowledge file', () => {
  it('reads the description key of the top block', () => {
    expect(frontmatterDescription(NOTE)).toBe('Read before changing the importer. Why it refuses a row with no id.');
  });

  it('answers null for a file with no block, as a file from before the shape has none', () => {
    expect(frontmatterDescription('# Rows\n\nThe importer refuses a row with no id.')).toBeNull();
  });
});

describe('the paths a knowledge file depends on', () => {
  it('reads a comma list, with a folder keeping its slash off', () => {
    expect(frontmatterPaths(NOTE)).toEqual(['src/importer/rows.ts', 'src/importer']);
  });

  it('reads a list under the key, a bracket list, and takes quotes, backticks and line numbers off', () => {
    expect(frontmatterPaths('---\npaths:\n  - "src/a.ts"\n  - `src/b.ts:12`\ndescription: x\n---\n')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(frontmatterPaths("---\npaths: [src/a.ts, 'src/b.ts:3-9']\n---\n")).toEqual(['src/a.ts', 'src/b.ts']);
    expect(frontmatterPaths('---\npaths:\n- src/a.ts\n- ./src/b.ts\ndescription: x\n---\n')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  // The Knowledge screen keys its list by path, and Svelte throws on a key it meets twice.
  it('names each path once, even when two lines of one file differ only in the line number', () => {
    expect(frontmatterPaths('---\npaths: src/a.ts:12, src/a.ts:40, ./src/a.ts\n---\n')).toEqual(['src/a.ts']);
  });

  it('reads no path from a file with no key, "none", or a key in the body', () => {
    expect(frontmatterPaths('---\ndescription: x\n---\n')).toEqual([]);
    expect(frontmatterPaths('---\npaths: none\n---\n')).toEqual([]);
    expect(frontmatterPaths('# Rows\n\n---\npaths: src/a.ts\n---\n')).toEqual([]);
  });
});

describe('the Learn your repositories key', () => {
  it('names the repository and reads it back, the project folder too', () => {
    expect(repoOfLearnKey(learnRepoKey('api'))).toBe('api');
    expect(repoOfLearnKey(learnRepoKey('.'))).toBe('.');
    expect(repoOfLearnKey('kb-learn-')).toBeNull();
    expect(repoOfLearnKey('APP-1')).toBeNull();
  });

  it('counts as a run that belongs to no card, as the reserved key does', () => {
    expect(isMaintenanceKey(learnRepoKey('web'))).toBe(true);
    expect(isMaintenanceKey(KB_MAINTENANCE_KEY)).toBe(true);
    expect(isMaintenanceKey('APP-1')).toBe(false);
    expect(isMaintenanceKey(null)).toBe(false);
  });
});
