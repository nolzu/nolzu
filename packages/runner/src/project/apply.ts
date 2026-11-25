import { closeSync, constants, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GUARD_PATH, type ProjectPlan, SETTINGS_PATH } from './plan.ts';
import { writablePath } from './writable.ts';

export interface ApplyResult {
  written: readonly string[];
  // Files the plan took away, as an older Nolzu's WORKSPACE.md.
  removed: readonly string[];
  kept: readonly string[];
  // Files Nolzu may not write, each with the reason. A link is the person's own arrangement, so the
  // run goes on without it and the report says which file was left and what to do about it.
  refused: readonly { path: string; message: string }[];
  // The write that stopped the run, if one did. Everything before it stays written, and the
  // summary has to say so rather than claim nothing happened.
  failed: { path: string; message: string } | null;
}

// Resolved on both sides, because a temp folder and a home folder both reach the same place
// through a symlink, and comparing the paths as written would refuse a folder that is the one.
function samePlace(folder: string, projectPath: string): boolean {
  try {
    return realpathSync(folder) === realpathSync(projectPath);
  } catch {
    return false;
  }
}

export function applyPlan(folder: string, projectPath: string, plan: ProjectPlan): ApplyResult {
  // Nothing is written into a folder the person did not choose. This is the project side of the
  // rule that keeps the database in one place.
  if (!samePlace(folder, projectPath)) {
    return {
      written: [],
      removed: [],
      kept: [],
      refused: [],
      failed: { path: '', message: `${folder} is not the project folder, so nothing was written.` },
    };
  }

  const written: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const refused: { path: string; message: string }[] = [];

  try {
    for (const dir of plan.dirs) {
      mkdirSync(join(folder, dir), { recursive: true });
    }
  } catch (error) {
    return { written, removed, kept, refused, failed: { path: '', message: (error as Error).message } };
  }

  for (const write of plan.writes) {
    if (write.kind === 'keep' || write.kind === 'unchanged') {
      kept.push(write.path);
      continue;
    }
    // The settings name the guard script. Written without it, every Write, Edit and Bash of every run
    // would call a file that is not there, so the two go together or neither goes.
    if (write.path === SETTINGS_PATH && refused.some((one) => one.path === GUARD_PATH)) {
      refused.push({ path: write.path, message: `${SETTINGS_PATH} was left alone, because it would name a guard script Nolzu could not write.` });
      continue;
    }
    // The same rule the skills follow: a symlink is often shared with another project or a dotfiles
    // repository, and writing through it would change a file outside the folder the person chose.
    const target = writablePath(folder, write.path);
    if (target === null) {
      refused.push({ path: write.path, message: `${write.path} is a link, or something other than a plain file, so Nolzu did not write through it. Add the Nolzu part by hand, or move the file away and run this again.` });
      continue;
    }
    if (write.kind === 'remove') {
      try {
        unlinkSync(target);
        removed.push(write.path);
      } catch (error) {
        // Gone already is what the plan wanted.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { written, removed, kept, refused, failed: { path: write.path, message: (error as Error).message } };
      }
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      // O_NOFOLLOW, so the kernel refuses a link in the moment of the write rather than in the check
      // a moment earlier. The parents are still the check's job: Node opens no path one part at a time.
      const handle = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
      try {
        writeFileSync(handle, write.content);
      } finally {
        closeSync(handle);
      }
      written.push(write.path);
    } catch (error) {
      // Stops here on purpose. What was written stays written, and it goes back in the report so
      // the summary can say which files are already there.
      return { written, removed, kept, refused, failed: { path: write.path, message: (error as Error).message } };
    }
  }

  return { written, removed, kept, refused, failed: null };
}
