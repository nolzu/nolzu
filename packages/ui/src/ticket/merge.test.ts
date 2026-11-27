import type { MergeBlocker } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { blockerChip, blockerLine, blockerText, mergeShown } from './merge.ts';

const failed: MergeBlocker = { kind: 'checks', failed: [{ name: 'build', url: 'https://ci.example.com/build' }, { name: 'test', url: null }] };

describe('blockerLine', () => {
  // Each reason in the words the card page says it, the links that belong to it apart.
  it.each<[MergeBlocker, string]>([
    [failed, '2 checks failed: build, test'],
    [{ kind: 'checks', failed: [{ name: 'build', url: null }] }, '1 check failed: build'],
    [{ kind: 'checks', failed: [] }, 'Checks failed'],
    [{ kind: 'conflict', base: 'main' }, 'It conflicts with main. Resolve the conflicts on GitHub or in your checkout.'],
    [{ kind: 'behind', base: 'main' }, 'main moved on, and this repository wants the branch up to date first'],
    [{ kind: 'behind', base: null }, 'the base branch moved on, and this repository wants the branch up to date first'],
    [{ kind: 'approval' }, 'It needs an approval'],
    [{ kind: 'changes' }, 'A reviewer asked for changes'],
    [{ kind: 'draft' }, 'It is a draft'],
    [{ kind: 'unknown' }, 'GitHub is still working out whether it can merge'],
    [{ kind: 'blocked', url: 'https://github.com/cook/recipes/pull/12' }, 'GitHub blocks the merge for a reason it does not name here'],
  ])('says %j', (blocker, words) => {
    expect(blockerText(blocker)).toBe(words);
  });

  it('links each failed check to its log, and a reason GitHub does not name to the pull request', () => {
    expect(blockerLine(failed)).toEqual({ text: '2 checks failed:', links: failed.failed });
    expect(blockerLine({ kind: 'blocked', url: 'https://github.com/cook/recipes/pull/12' }).links).toEqual([{ name: 'Open the pull request', url: 'https://github.com/cook/recipes/pull/12' }]);
  });
});

describe('blockerChip', () => {
  it('names the first reason and counts the rest, with every reason in full', () => {
    expect(blockerChip([failed, { kind: 'draft' }])).toEqual({ short: 'Checks failed +1', full: 'Cannot merge. 2 checks failed: build, test. It is a draft.' });
    expect(blockerChip([{ kind: 'conflict', base: 'main' }])).toEqual({ short: 'Conflict', full: 'Cannot merge. It conflicts with main. Resolve the conflicts on GitHub or in your checkout.' });
  });

  it('draws no chip when nothing blocks', () => {
    expect(blockerChip([])).toBeNull();
  });
});

it('shows a pull request with a reason or with checks running, and not a clean one', () => {
  const pull = (blockers: MergeBlocker[], running = false) => ({ repo: 'cook/recipes', number: blockers.length + (running ? 10 : 0), url: null, read: { blockers, running }, at: '2026-11-01T10:00:00Z' });
  expect(mergeShown([pull([]), pull([{ kind: 'draft' }]), pull([], true)]).map((one) => one.number)).toEqual([1, 10]);
});
