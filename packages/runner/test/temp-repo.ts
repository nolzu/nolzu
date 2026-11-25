import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempRepo {
  dir: string;
  env: Record<string, string>;
  /** Runs git in the repository and returns stdout. Throws on a non-zero exit, so a test
   *  that sets up the wrong state fails where it happened and not three lines later. */
  run: (...args: string[]) => string;
  write: (relative: string, content: string) => void;
  commit: (message: string) => void;
  remove: () => void;
}

// Every repository a test builds runs with empty config files, a fixed author and committer
// and no hooks. Without that, a developer's name, a global hook or a signing setting reaches
// a fixture, and the suite then passes or fails depending on whose machine runs it.
export function tempRepo(prefix = 'nolzu-git-'): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  // Real empty files, which the test can point git at and remove with the folder.
  const configGlobal = join(dir, 'gitconfig-global');
  const configSystem = join(dir, 'gitconfig-system');
  const hooks = join(dir, 'empty-hooks');
  writeFileSync(configGlobal, '');
  writeFileSync(configSystem, '');
  mkdirSync(hooks, { recursive: true });

  const work = join(dir, 'repo');
  mkdirSync(work, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: configGlobal,
    GIT_CONFIG_SYSTEM: configSystem,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Demo',
    GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'Demo',
    GIT_COMMITTER_EMAIL: 'demo@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };

  const run = (...args: string[]): string =>
    execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.quotepath=false', ...args], {
      cwd: work,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });

  execFileSync('git', ['init', '-q', '-b', 'main', work], { env, encoding: 'utf8' });

  return {
    dir: work,
    env,
    run,
    write(relative, content) {
      const target = join(work, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    },
    commit(message) {
      run('add', '-A');
      run('commit', '-q', '-m', message);
    },
    remove() {
      // Retried, because a killed `worktree add` leaves an orphaned checkout child still writing
      // into this folder, and a plain delete races it and throws ENOTEMPTY. `undo()` in worktree.ts
      // already deletes this way for the same reason; the helper every test tears down through did
      // not, so one test's leftovers could fail an unrelated test's cleanup.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
