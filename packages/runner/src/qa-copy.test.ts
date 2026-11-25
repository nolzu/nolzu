import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../test/temp-repo.ts';
import { copyAttempts, makeQaCopy, qaCopyPath, qaCopyRoot, removeQaCopy, sweepQaCopies } from './qa-copy.ts';

const realCp = async (args: readonly string[]) => {
  await promisify(execFile)('cp', [...args]);
};

let repo: TempRepo | null = null;
let scratch = '';

afterEach(() => {
  repo?.remove();
  repo = null;
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

const folder = () => (scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-qa-copy-'))));

describe('the copy method', () => {
  it('clones on macOS, reflinks on Linux, and falls back to a plain copy on both', () => {
    expect(copyAttempts('darwin').map((one) => [one.method, one.flags.join(' ')])).toEqual([
      ['APFS clone', '-c -R'],
      ['plain copy', '-R'],
    ]);
    expect(copyAttempts('linux').map((one) => [one.method, one.flags.join(' ')])).toEqual([
      ['reflink', '--reflink=always -R'],
      ['plain copy', '-R'],
    ]);
    expect(copyAttempts('freebsd').map((one) => one.method)).toEqual(['plain copy']);
  });

  it.each(['darwin', 'linux'])('takes a plain copy on %s when the clone is refused', async (platform) => {
    const root = folder();
    const checkout = join(root, 'recipes');
    mkdirSync(join(checkout, 'src'), { recursive: true });
    writeFileSync(join(checkout, 'src/list.ts'), 'list');
    const seen: string[][] = [];
    const cp = (args: readonly string[]) => {
      seen.push([...args]);
      return args.includes('-c') || args.includes('--reflink=always') ? Promise.reject(new Error('cp: clonefile failed')) : realCp(args);
    };

    const made = await makeQaCopy(checkout, join(root, 'copy'), { platform, cp });

    expect(made.method).toBe('plain copy');
    expect(seen).toHaveLength(2);
    expect(readFileSync(join(root, 'copy/src/list.ts'), 'utf8')).toBe('list');
  });

  it('fails with the reason when even the plain copy is refused, and leaves no half copy', async () => {
    const root = folder();
    const checkout = join(root, 'recipes');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'a.ts'), 'a');
    const cp = () => Promise.reject(Object.assign(new Error('failed'), { stderr: 'cp: No space left on device' }));

    await expect(makeQaCopy(checkout, join(root, 'copy'), { platform: 'darwin', cp })).rejects.toThrow(`Nolzu could not copy ${checkout} for QA. cp: No space left on device`);
    expect(existsSync(join(root, 'copy'))).toBe(false);
  });
});

describe('what the copy holds', () => {
  it('holds the working tree as it is: uncommitted changes, an untracked file and node_modules', async () => {
    repo = tempRepo('nolzu-qa-copy-repo-');
    repo.write('src/list.ts', 'committed');
    repo.commit('first');
    repo.write('src/list.ts', 'changed, not committed');
    repo.write('src/new.ts', 'untracked');
    repo.write('node_modules/pkg/index.js', 'module');
    const dest = join(folder(), 'copy');

    const made = await makeQaCopy(repo.dir, dest);

    expect(readFileSync(join(dest, 'src/list.ts'), 'utf8')).toBe('changed, not committed');
    expect(readFileSync(join(dest, 'src/new.ts'), 'utf8')).toBe('untracked');
    expect(readFileSync(join(dest, 'node_modules/pkg/index.js'), 'utf8')).toBe('module');
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(made.ms).toBeGreaterThanOrEqual(0);
    // The real checkout is as it was.
    expect(readFileSync(join(repo.dir, 'src/list.ts'), 'utf8')).toBe('changed, not committed');
  });

  it.each(['darwin', 'linux'])('keeps uncommitted work, an untracked file and node_modules when the clone is refused on %s', async (platform) => {
    repo = tempRepo('nolzu-qa-copy-repo-');
    repo.write('src/list.ts', 'committed');
    repo.commit('first');
    repo.write('src/list.ts', 'changed, not committed');
    repo.write('src/new.ts', 'untracked');
    repo.write('node_modules/pkg/index.js', 'module');
    const dest = join(folder(), 'copy');
    const cp = (args: readonly string[]) => (args.includes('-c') || args.includes('--reflink=always') ? Promise.reject(new Error('cp: clonefile failed')) : realCp(args));

    const made = await makeQaCopy(repo.dir, dest, { platform, cp });

    expect(made.method).toBe('plain copy');
    expect(readFileSync(join(dest, 'src/list.ts'), 'utf8')).toBe('changed, not committed');
    expect(readFileSync(join(dest, 'src/new.ts'), 'utf8')).toBe('untracked');
    expect(readFileSync(join(dest, 'node_modules/pkg/index.js'), 'utf8')).toBe('module');
  });

  it('leaves out the folders it is told to skip, and a copy folder inside the checkout', async () => {
    const root = folder();
    const project = join(root, 'recipes');
    for (const dir of ['src', '.tasks/APP-1', 'worktrees/APP-1']) mkdirSync(join(project, dir), { recursive: true });
    writeFileSync(join(project, 'src/a.ts'), 'a');
    writeFileSync(join(project, '.env'), 'SECRET=1');
    const dest = join(project, 'qa-copies/qa-APP-1-00000000');

    await makeQaCopy(project, dest, { skip: [join(project, '.tasks'), join(project, 'worktrees')] });

    expect(existsSync(join(dest, 'src/a.ts'))).toBe(true);
    expect(existsSync(join(dest, '.env'))).toBe(true);
    expect(existsSync(join(dest, '.tasks'))).toBe(false);
    expect(existsSync(join(dest, 'worktrees'))).toBe(false);
    expect(existsSync(join(dest, 'qa-copies'))).toBe(false);
  });

  it('replaces a copy an earlier run left at the same place', async () => {
    const root = folder();
    const checkout = join(root, 'recipes');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'a.ts'), 'a');
    const dest = join(root, 'copy');
    mkdirSync(dest);
    writeFileSync(join(dest, 'stale.ts'), 'old');

    await makeQaCopy(checkout, dest);

    expect(existsSync(join(dest, 'stale.ts'))).toBe(false);
    expect(existsSync(join(dest, 'a.ts'))).toBe(true);
  });
});

describe('where the copy goes', () => {
  it('goes in the data folder when the checkout is on the same volume, named by card and checkout', () => {
    const root = folder();
    const data = join(root, 'data');
    mkdirSync(data);
    const checkout = join(root, 'recipes/worktrees/APP-1');

    const path = qaCopyPath(data, checkout, 'APP-1');

    expect(qaCopyRoot(data, checkout)).toBe(join(data, 'qa-copies'));
    expect(path).toMatch(new RegExp(`^${join(data, 'qa-copies')}/qa-APP-1-[0-9a-f]{8}$`));
    expect(qaCopyPath(data, checkout, 'APP-1')).toBe(path);
    expect(qaCopyPath(data, join(root, 'other/worktrees/APP-1'), 'APP-1')).not.toBe(path);
  });
});

describe('deleting', () => {
  it('deletes a copy, and says nothing of one that is not there', async () => {
    const dest = join(folder(), 'copy');
    mkdirSync(join(dest, 'node_modules/.cache'), { recursive: true });
    writeFileSync(join(dest, 'node_modules/.cache/x'), 'x');

    await removeQaCopy(dest);
    await removeQaCopy(dest);

    expect(existsSync(dest)).toBe(false);
  });

  it('sweeps an old copy at start and nothing else', () => {
    const root = folder();
    const copies = join(root, 'qa-copies');
    mkdirSync(join(copies, 'qa-APP-1-0a1b2c3d/src'), { recursive: true });
    mkdirSync(join(copies, 'notes'));
    // Starts like a copy and is none: no hash at the end.
    mkdirSync(join(copies, 'qa-notes'));
    writeFileSync(join(copies, 'readme.txt'), 'kept');
    writeFileSync(join(root, 'nolzu.db'), 'kept');

    expect(sweepQaCopies(copies)).toEqual([join(copies, 'qa-APP-1-0a1b2c3d')]);

    expect(existsSync(join(copies, 'qa-APP-1-0a1b2c3d'))).toBe(false);
    expect(existsSync(join(copies, 'notes'))).toBe(true);
    expect(existsSync(join(copies, 'qa-notes'))).toBe(true);
    expect(existsSync(join(copies, 'readme.txt'))).toBe(true);
    expect(existsSync(join(root, 'nolzu.db'))).toBe(true);
  });

  it('sweeps nothing when there is no copy folder', () => {
    expect(sweepQaCopies(join(folder(), 'qa-copies'))).toEqual([]);
  });
});
