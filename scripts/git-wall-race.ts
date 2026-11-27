// The two halves of scripts/git-wall-race.sh: a loop of Nolzu's own git writes, and a second process
// that keeps swapping a link into the repository's `.git/logs` while they run.
//
//   node scripts/git-wall-race.ts write <off|on> <commit|worktree> <repo> <count>
//   node scripts/git-wall-race.ts attack <rename|link> <repo> <outside folder> <stop file>
//
// `write off` is Nolzu's git as it was before the wall: the link check, then git with Nolzu's flags.
// `write on` is `git()` as it is now, with the repository named, so the check, the pins and the wall.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnv } from '../packages/runner/src/git/env.ts';
import { git, GIT_FLAGS, gitBinary, NO_HOOKS } from '../packages/runner/src/git/exec.ts';
import { linkBeforeWrite } from '../packages/runner/src/git/links.ts';

const [what, ...given] = process.argv.slice(2);

async function write(): Promise<void> {
  const [mode, shape, repo = '', count] = given;
  const env = gitEnv(process.env);
  const binary = gitBinary(env.PATH);
  if (binary === null) throw new Error('git was not found on the PATH.');
  // How many calls the checks before git stopped, how many git ran and finished, and how many it ran
  // and failed, such as a reflog write the wall refused.
  const seen = { stopped: 0, done: 0, failed: 0 };
  for (let at = 0; at < Number(count); at += 1) {
    const args = shape === 'commit' ? ['commit', '-q', '--allow-empty', '-m', `n${at}`] : ['worktree', 'add', '-q', '-b', `wt-${at}`, join(repo, 'worktrees', `wt-${at}`)];
    if (mode === 'on') {
      const said = await git(args, { cwd: repo, env, repo: { project: repo, workTree: repo } });
      seen[said.code === 0 ? 'done' : said.stderr.includes('Nolzu stopped') ? 'stopped' : 'failed'] += 1;
    } else if (linkBeforeWrite(args, repo, env) === null) {
      seen[spawnSync(binary, [...GIT_FLAGS, ...NO_HOOKS, ...args], { cwd: repo, env, stdio: 'ignore' }).status === 0 ? 'done' : 'failed'] += 1;
    } else {
      seen.stopped += 1;
    }
  }
  process.stdout.write(`stopped-before-git=${seen.stopped} git-done=${seen.done} git-failed=${seen.failed}`);
}

// `rename`: a folder whose `HEAD` and `refs` are links to the outside folder is renamed in over
// `.git/logs`, the case of a folder renamed into place with a link inside. `link`: `.git/logs` itself
// is swapped for a link to the outside folder. Each turn puts the real folder back.
function attack(): void {
  const [shape, repo = '', outside = '', stop = ''] = given;
  const logs = join(repo, '.git', 'logs');
  // Kept in the work tree, where the link check before a write does not look.
  const kept = join(repo, '.kept-logs');
  const evil = join(repo, '.evil-logs');
  if (shape === 'rename') {
    mkdirSync(evil, { recursive: true });
    symlinkSync(join(outside, 'victim'), join(evil, 'HEAD'));
    symlinkSync(outside, join(evil, 'refs'));
  } else {
    symlinkSync(outside, evil);
  }
  while (!existsSync(stop)) {
    try {
      renameSync(logs, kept);
      renameSync(evil, logs);
      for (let spin = 0; spin < 2000; spin += 1);
      renameSync(logs, evil);
      renameSync(kept, logs);
    } catch {
      // git made a new `logs` in the gap; it goes, and the turn starts again.
      putBack(logs, kept);
    }
  }
  putBack(logs, kept);
}

// The real `logs` back in place. git may be writing a new one in the gap, so a failed try is left
// for the next turn.
function putBack(logs: string, kept: string): void {
  try {
    if (!existsSync(kept)) return;
    rmSync(logs, { recursive: true, force: true });
    renameSync(kept, logs);
  } catch {
    // The next turn tries again.
  }
}

if (what === 'write') await write();
else if (what === 'attack') attack();
else throw new Error('Name write or attack first.');
