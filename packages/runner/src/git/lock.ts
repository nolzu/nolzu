import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// How long a lock may sit before the next caller takes it. A checkout of a large repository can run
// for a while, so this is generous: the cost of waiting is a pause, and the cost of taking a live
// lock is two callers building one worktree.
const STALE_MS = 2 * 60 * 1000;

// How often a waiting caller looks again. Short enough that a person does not notice the pause,
// long enough that a hundred waiting calls do not spin the disk.
const POLL_MS = 25;

// How often a holder writes its time again while its work runs, so a build that outlasts STALE_MS, such
// as a large checkout or one with hooks, is never judged stale by the next caller.
const REFRESH_MS = 30 * 1000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Held {
  pid: number;
  at: string;
  // This holder and no other, so a release never deletes a lock somebody else took over.
  token?: string;
}

const heldBy = (at: string): Held | null => {
  try {
    const held = JSON.parse(readFileSync(join(at, 'held-by.json'), 'utf8')) as Partial<Held>;
    return typeof held.pid === 'number' && typeof held.at === 'string' ? { pid: held.pid, at: held.at, token: held.token } : null;
  } catch {
    // No file yet, or half written: the holder is mid-write, which is not a stale lock.
    return null;
  }
};

const running = (pid: number): boolean => {
  try {
    // Signal 0 asks the question without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it is there and owned by somebody else, which still counts as running.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const stale = (at: string, now: number): boolean => {
  const held = heldBy(at);
  if (held === null) {
    // Nothing readable in the folder. Either the holder is between making it and writing the file,
    // which lasts microseconds, or it was killed in that window and is never coming back. The
    // folder's own age tells those two apart. Measured: killing a holder in that window left this
    // state sixty times out of sixty, and without an age the card was blocked for ever.
    // `throwIfNoEntry` is load bearing: the holder can release between the collision and this read,
    // and a throw there would turn a caller that should wait into one that fails.
    return now - (statSync(at, { throwIfNoEntry: false })?.mtimeMs ?? now) > STALE_MS;
  }
  if (held.pid !== process.pid && !running(held.pid)) return true;
  return now - Date.parse(held.at) > STALE_MS;
};

/**
 * Makes `path` a real folder and answers it. These folders sit in the repository's git folder, which a
 * run may write when the card's checkout is the project folder itself, and a link put in place of one
 * would aim Nolzu's deletes at the folder it points to. So a link found there is removed, the link
 * only and never what it points to, and anything else that is no folder is refused.
 */
export function ownFolder(path: string): string {
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (found?.isSymbolicLink() === true) unlinkSync(path);
  else if (found !== undefined && !found.isDirectory()) throw new Error(`${path} is no folder, so Nolzu does not use it. Remove it, then try again.`);
  mkdirSync(path, { recursive: true });
  // Read again: a link made between the two steps above.
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} became a link while Nolzu made it, so Nolzu does not use it.`);
  return path;
}

// One lock per card key, on disk rather than in memory, because the second caller can be a second
// process: a retry, a second window, or a command line call next to the app. `mkdir` is the atomic
// part, on every platform Nolzu runs on.
// `signal` ends a wait behind another holder, so a Stop while a card waits for its turn takes effect.
export async function withCardLock<T>(dir: string, key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // The key becomes a folder name this function deletes, on the takeover path and again in the
  // release below. A segment that climbs out of the folder points those deletes at the git directory
  // or at the project root. ensureWorktree checks its own key for the same reason, and the check
  // belongs here as well, because it is these two rmSync calls that do the damage.
  if (key === '' || key === '.' || key === '..' || /[/\\]/.test(key) || key.includes('\0')) {
    throw new Error(`The card key ${JSON.stringify(key)} cannot be used as a folder name, so it cannot be locked.`);
  }
  const at = join(dir, key);
  // A card named literally `<key>.taking` would share this marker with card `<key>`. Card keys are
  // ticket keys, so that is a name nobody has, and the cost of the collision is one card waiting.
  const taking = `${at}.taking`;
  ownFolder(dir);

  for (;;) {
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('The wait for the lock was stopped.');
    try {
      mkdirSync(at);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A link in the lock's place is no holder: it goes, the link only, and is never read or deleted through.
      if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
        unlinkSync(at);
        continue;
      }
      // Taken over rather than waited for ever. A process that died holding this would otherwise
      // stop the card from ever starting again, which is worse than the race the lock prevents.
      //
      // Only one caller may clear an abandoned lock, and `mkdir` is the atomic part again. The
      // staleness is then read a second time inside that gate, which is what actually closes the
      // gap: a caller that judged the dead holder stale re-reads under the marker, sees the live
      // lock the winner has since made, and leaves it alone. Measured without the gate: four to
      // seven of eight callers entered the work together after a holder died. A caller killed while
      // holding the marker leaves it behind, which blocks this card's takeover path until the
      // folder is cleared, not its ordinary path.
      if (stale(at, Date.now())) {
        let clearing = false;
        try {
          mkdirSync(taking);
          clearing = true;
        } catch {
          // Another caller is already clearing it, so this one waits like any other.
        }
        if (clearing) {
          try {
            if (stale(at, Date.now())) rmSync(at, { recursive: true, force: true });
          } finally {
            rmSync(taking, { recursive: true, force: true });
          }
          continue;
        }
      }
      await wait(POLL_MS);
    }
  }

  const token = randomUUID();
  const mine = (): boolean => heldBy(at)?.token === token;
  // Never through a link a run left at the name, which would write this over the file it points to.
  const record = (): void => {
    const fd = openSync(join(at, 'held-by.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
    } finally {
      closeSync(fd);
    }
  };
  try {
    record();
  } catch (error) {
    // The folder is this caller's and holds no record, so it goes at once rather than at its stale age.
    rmSync(at, { recursive: true, force: true });
    throw error;
  }
  // Written again while the work runs, and only while the lock is still this holder's.
  const refresh = setInterval(() => {
    try {
      if (mine()) record();
    } catch {
      // The folder went: the next look at it decides, not this timer.
    }
  }, REFRESH_MS);
  refresh.unref();
  try {
    return await work();
  } finally {
    clearInterval(refresh);
    // Released whatever happened, so a refusal does not lock the card out of its own checkout. Only
    // while it is still this holder's: a caller that took it over holds it now.
    if (mine()) rmSync(at, { recursive: true, force: true });
  }
}

// One lock per repository around everything that adds, removes or prunes its worktrees. git writes a
// new worktree's entry under `.git/worktrees` in several steps, and a second card's add or prune that
// read the folder meanwhile failed with "failed to read .git/worktrees/<key>/commondir", or could prune
// the half made entry. Always taken inside the card lock, so two callers never wait on each other's.
// Limit: one worktree build at a time per repository, so cards of one repository start one after
// another; a lock around only git's own worktree commands if a large checkout makes that slow.
export const withRepoLock = <T>(commonDir: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
  withCardLock(join(commonDir, 'nolzu-repo-lock'), 'worktrees', work, signal);
