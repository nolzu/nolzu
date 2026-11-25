import { expect, it, vi } from 'vitest';
import { tempRepo } from '../../test/temp-repo.ts';
import { scanProject } from './scan.ts';

// Listing a folder can fail after the access check passed, say on a network disk that drops out.
// Only readdir is made to fail, so git still answers for the root.
const fail = vi.hoisted(() => ({ readdir: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readdir: ((...args: Parameters<typeof real.readdir>) =>
      fail.readdir ? Promise.reject(new Error('EIO')) : real.readdir(...args)) as typeof real.readdir,
  };
});

// Before a root repository read its children it never listed the folder, so a listing that fails
// must still answer the root, not refuse a folder that was fine before.
it('answers a root repository alone when its folder cannot be listed', async () => {
  const repo = tempRepo('nolzu-scan-unlisted-');
  try {
    repo.write('a.txt', 'a\n');
    repo.commit('first');
    fail.readdir = true;

    const result = await scanProject(repo.dir, { branchTemplate: '{key}-{slug}', env: repo.env });

    expect(result.ok && result.repos.map((found) => found.path)).toEqual(['.']);
  } finally {
    fail.readdir = false;
    repo.remove();
  }
});
