import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GH_WAIT_MS, waitForGh } from './gh-wait.ts';
import type { GhLogin } from './new-project.ts';

const OUT: GhLogin = { found: true, signedIn: false, account: null };
const IN: GhLogin = { found: true, signedIn: true, account: 'you' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Each read answers with the next login in the list, and the last one again after that.
const reads = (...answers: (GhLogin | Error)[]) => {
  let at = 0;
  return vi.fn(async () => {
    const next = answers[Math.min(at, answers.length - 1)]!;
    at += 1;
    if (next instanceof Error) throw next;
    return next;
  });
};

it('asks every two seconds while gh is signed out, and stops once it is signed in', async () => {
  const read = reads(OUT, OUT, IN);
  const told: GhLogin[] = [];
  waitForGh(read, (login) => told.push(login));

  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(GH_WAIT_MS);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(GH_WAIT_MS * 2);
  expect(read).toHaveBeenCalledTimes(3);
  expect(told).toEqual([OUT, OUT, IN]);

  await vi.advanceTimersByTimeAsync(GH_WAIT_MS * 10);
  expect(read).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

// gh that is not there yet is waited for the same way, and a read that fails is asked again.
it('keeps asking through a missing gh and a failed read', async () => {
  const read = reads({ found: false, signedIn: false, account: null }, new Error('offline'), IN);
  const told: GhLogin[] = [];
  waitForGh(read, (login) => told.push(login));

  await vi.advanceTimersByTimeAsync(GH_WAIT_MS * 5);

  expect(read).toHaveBeenCalledTimes(3);
  expect(told).toEqual([{ found: false, signedIn: false, account: null }, IN]);
});

it('asks nothing more once the page stops it, even with a read on the way', async () => {
  const read = reads(OUT);
  const told: GhLogin[] = [];
  const stop = waitForGh(read, (login) => told.push(login));

  await vi.advanceTimersByTimeAsync(GH_WAIT_MS);
  stop();
  await vi.advanceTimersByTimeAsync(GH_WAIT_MS * 10);

  expect(read).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
