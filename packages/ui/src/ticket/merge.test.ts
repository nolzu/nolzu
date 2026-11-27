import type { MergeBlocker } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import { blockerChip, blockerLine, blockerText, fixCiOf, type MergePull, mergeShown } from './merge.ts';

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

describe('fixCiOf', () => {
  const board = boardFixture('pull-request');
  const implement = board.stages.find((one) => one.id === 'implement')!;
  const card = cardFixture({ key: 'APP-1', stage: 'pr-watch', state: 'idle' });
  const pull = (failed: { name: string; url: string | null }[], blockers: MergeBlocker[] = []): MergePull => ({
    repo: 'example/recipes',
    number: 12,
    url: null,
    read: { blockers: [{ kind: 'checks', failed }, ...blockers], running: false },
    at: '2026-11-27T10:00:00.000Z',
  });
  const job = { name: 'build', url: 'https://github.com/example/recipes/actions/runs/7/job/8' };

  it('starts Implement with the card\'s own models when a failed check has a log of its own pull request', () => {
    const own = { ...implement.starts!, model: 'opus', effort: 'high' as const };
    expect(fixCiOf({ ...card, starts: { implement: own } }, board.stages, [pull([job])])).toEqual({ implement: { ...implement, starts: own }, refusal: null });
  });

  it('draws nothing with no failed check, before Implement, on the last column, or with no Implement column', () => {
    expect(fixCiOf(card, board.stages, [{ ...pull([]), read: { blockers: [{ kind: 'draft' }], running: false } }])).toBeNull();
    expect(fixCiOf({ ...card, stage: 'plan' }, board.stages, [pull([job])])).toBeNull();
    expect(fixCiOf({ ...card, stage: 'closed' }, board.stages, [pull([job])])).toBeNull();
    expect(fixCiOf(card, board.stages.filter((one) => one.id !== 'implement'), [pull([job])])).toBeNull();
  });

  it('refuses a busy card in the server\'s words', () => {
    expect(fixCiOf({ ...card, state: 'running' }, board.stages, [pull([job])])?.refusal).toBe('APP-1 is running. Wait for the run to end, then press Fix CI.');
    expect(fixCiOf({ ...card, state: 'queued' }, board.stages, [pull([job])])?.refusal).toBe('APP-1 is queued. Wait for the run to start and end, then press Fix CI.');
  });

  it('refuses when no failed check is a GitHub Actions job of its own pull request', () => {
    const none = [pull([{ name: 'lint', url: 'https://ci.example.com/42' }, { name: 'other', url: 'https://github.com/someone/else/actions/runs/1/job/2' }])];
    expect(fixCiOf(card, board.stages, none)?.refusal).toBe('None of the failed checks has a log Nolzu can read. Open them on GitHub.');
  });

  it('refuses an engine that cannot start, with the fix', () => {
    const gone = { ...implement.starts!, modelState: 'no-profile' as const, engine: 'gone-login' };
    expect(fixCiOf({ ...card, starts: { implement: gone } }, board.stages, [pull([job])])?.refusal).toContain('Set the row back to inherit in the card settings, or in Settings, Models.');
  });
});
