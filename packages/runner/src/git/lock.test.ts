import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withCardLock } from './lock.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-cardlock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A promise the test releases by hand, so the order is decided by the lock and not by a timer.
const held = () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { blocked, release };
};

it('lets two cards hold their locks at the same time', async () => {
  const first = held();
  const inside = held();

  const one = withCardLock(dir, 'APP-1', async () => {
    inside.release();
    await first.blocked;
    return 'one';
  });
  await inside.blocked;

  // A lock for another card must not wait behind this one. Serialising every card would make a
  // board with three cards start them one after another for no reason.
  await expect(withCardLock(dir, 'APP-2', async () => 'two')).resolves.toBe('two');

  first.release();
  await expect(one).resolves.toBe('one');
});

it('makes a second call for one card wait for the first', async () => {
  const order: string[] = [];
  const first = held();
  const inside = held();

  const one = withCardLock(dir, 'APP-1', async () => {
    inside.release();
    await first.blocked;
    order.push('first');
  });
  await inside.blocked;

  const two = withCardLock(dir, 'APP-1', async () => {
    order.push('second');
  });
  // Long enough for a broken lock to have run it: the waiting side looks again every 25ms. A slow
  // machine only makes this emptier, so the test cannot fail for being busy.
  await wait(80);
  expect(order).toEqual([]);

  first.release();
  await Promise.all([one, two]);
  expect(order).toEqual(['first', 'second']);
});

it('takes over a lock whose process is gone, even when it was taken a moment ago', async () => {
  mkdirSync(join(dir, 'APP-1'), { recursive: true });
  // A process id far above what any system hands out, with a timestamp from now, so only the
  // question "is that process alive" can decide this.
  writeFileSync(join(dir, 'APP-1', 'held-by.json'), JSON.stringify({ pid: 4_000_000, at: new Date().toISOString() }));

  await expect(withCardLock(dir, 'APP-1', async () => 'taken')).resolves.toBe('taken');
});

it('releases the lock when the work throws', async () => {
  await expect(
    withCardLock(dir, 'APP-1', async () => {
      throw new Error('the work failed');
    }),
  ).rejects.toThrow('the work failed');

  // The next call must not be locked out by a failure that already ended.
  await expect(withCardLock(dir, 'APP-1', async () => 'after')).resolves.toBe('after');
});

it('waits rather than taking a lock a living process holds', async () => {
  mkdirSync(join(dir, 'APP-1'), { recursive: true });
  writeFileSync(join(dir, 'APP-1', 'held-by.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  let taken = false;
  const call = withCardLock(dir, 'APP-1', async () => {
    taken = true;
  });
  await wait(80);
  expect(taken).toBe(false);

  // Releasing it by hand is what a finishing holder does, and the waiting call then goes.
  rmSync(join(dir, 'APP-1'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await call;
  expect(taken).toBe(true);
});

it('takes over a folder left with no record in it, once it is past the stated age', async () => {
  const at = join(dir, 'APP-1');
  mkdirSync(at, { recursive: true });
  // A holder killed between making the folder and writing its record leaves exactly this. Aged by
  // hand rather than by sleeping, so the test waits for nothing.
  const anHourAgo = Date.now() / 1000 - 3600;
  utimesSync(at, anHourAgo, anHourAgo);

  await expect(withCardLock(dir, 'APP-1', async () => 'taken')).resolves.toBe('taken');
});

it('still waits on a folder with no record that was made a moment ago', async () => {
  const at = join(dir, 'APP-1');
  mkdirSync(at, { recursive: true });

  let taken = false;
  const call = withCardLock(dir, 'APP-1', async () => {
    taken = true;
  });
  await wait(80);
  // Mid write lasts microseconds, so a folder this new belongs to a holder that is still arriving.
  expect(taken).toBe(false);

  rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await call;
  expect(taken).toBe(true);
});

it('leaves an abandoned lock alone while another caller is clearing it', async () => {
  const at = join(dir, 'APP-1');
  mkdirSync(at, { recursive: true });
  const record = JSON.stringify({ pid: 4_000_000, at: new Date().toISOString() });
  writeFileSync(join(at, 'held-by.json'), record);
  // The marker says a caller already holds the right to clear this one. Two callers clearing it
  // together is how several of them ended up inside the work at once.
  mkdirSync(`${at}.taking`, { recursive: true });

  let taken = false;
  const call = withCardLock(dir, 'APP-1', async () => {
    taken = true;
  });
  await wait(80);

  expect(taken).toBe(false);
  expect(readFileSync(join(at, 'held-by.json'), 'utf8')).toBe(record);

  rmSync(`${at}.taking`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await call;
  expect(taken).toBe(true);
  expect(existsSync(at)).toBe(false);
});

it('clears its marker, so the next abandoned lock can be taken over too', async () => {
  const at = join(dir, 'APP-1');
  const dead = () => {
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'held-by.json'), JSON.stringify({ pid: 4_000_000, at: new Date().toISOString() }));
  };

  dead();
  await expect(withCardLock(dir, 'APP-1', async () => 'first')).resolves.toBe('first');

  // A marker left behind would block this card's takeover path for good, and nothing else clears
  // it: the ordinary path never looks at it.
  dead();
  await expect(withCardLock(dir, 'APP-1', async () => 'second')).resolves.toBe('second');
  expect(existsSync(`${at}.taking`)).toBe(false);
});

// A build can outlast the stale age: a large checkout, hooks, a slow disk. The holder writes its time
// again while it works, so the next caller still waits after the stale age has gone by.
it('keeps a lock whose work outlasts the stale age, and lets the next caller in after it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const first = held();
    const order: string[] = [];
    const one = withCardLock(dir, 'APP-1', async () => {
      order.push('one in');
      await first.blocked;
      order.push('one out');
    });
    await vi.advanceTimersByTimeAsync(0);
    const two = withCardLock(dir, 'APP-1', async () => {
      order.push('two in');
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(order).toEqual(['one in']);

    first.release();
    await one;
    await vi.advanceTimersByTimeAsync(100);
    await two;
    expect(order).toEqual(['one in', 'one out', 'two in']);
  } finally {
    vi.useRealTimers();
  }
});

// A holder whose lock was taken over must not delete the new holder's lock when it ends.
it('leaves a lock another holder took over when its own work ends', async () => {
  const at = join(dir, 'APP-1');
  await withCardLock(dir, 'APP-1', async () => {
    writeFileSync(join(at, 'held-by.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'someone else' }));
  });

  expect(JSON.parse(readFileSync(join(at, 'held-by.json'), 'utf8'))).toMatchObject({ token: 'someone else' });
});

// The lock folders sit in the repository's git folder, which a run may write when the card's checkout
// is the project folder. A link put in place of one would point the takeover's delete at a folder of the
// run's choice: the project's worktrees, or a card's checkout.
it('removes a link left in the place of the lock folder, and deletes nothing it points to', async () => {
  const victim = join(dir, 'worktrees');
  mkdirSync(join(victim, 'APP-1'), { recursive: true });
  writeFileSync(join(victim, 'APP-1', 'unsaved.txt'), 'work\n');
  // Old enough to read as an abandoned lock with no record, which the takeover deletes.
  utimesSync(join(victim, 'APP-1'), new Date('2020-01-01'), new Date('2020-01-01'));
  symlinkSync(victim, join(dir, 'locks'));

  expect(await withCardLock(join(dir, 'locks'), 'APP-1', async () => 'ran')).toBe('ran');

  expect(readFileSync(join(victim, 'APP-1', 'unsaved.txt'), 'utf8')).toBe('work\n');
  expect(lstatSync(join(dir, 'locks')).isDirectory()).toBe(true);
});

// A fresh folder behind the link would read as a lock just taken, and the card would wait for good.
it('removes a link left in the place of one card lock at once, and deletes nothing it points to', async () => {
  const victim = join(dir, 'checkout');
  mkdirSync(victim);
  writeFileSync(join(victim, 'unsaved.txt'), 'work\n');
  mkdirSync(join(dir, 'locks'));
  symlinkSync(victim, join(dir, 'locks', 'APP-1'));

  expect(await withCardLock(join(dir, 'locks'), 'APP-1', async () => 'ran')).toBe('ran');

  expect(readFileSync(join(victim, 'unsaved.txt'), 'utf8')).toBe('work\n');
});

// The record is written again while the work runs. A run that swaps it for a link to a file holding the
// same record would get that file written over.
it('never writes its record through a link left at its name', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  const victim = join(dir, 'victim.json');
  let before = '';
  try {
    await withCardLock(join(dir, 'locks'), 'APP-1', async () => {
      const record = join(dir, 'locks', 'APP-1', 'held-by.json');
      before = readFileSync(record, 'utf8');
      writeFileSync(victim, before);
      rmSync(record);
      symlinkSync(victim, record);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
  } finally {
    vi.useRealTimers();
  }
  expect(readFileSync(victim, 'utf8')).toBe(before);
});
