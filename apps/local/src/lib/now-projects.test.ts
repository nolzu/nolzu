import type { BoardSnapshot, CardView } from '@nolzu/protocol';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { describe, expect, it } from 'vitest';
import { type NowSnapshot, projectPath, waitingCount } from './now.ts';

// The pure half of Now on a machine with several projects. The route and the page are in
// routes/now-projects.test.ts.
const board = (cards: CardView[]): BoardSnapshot => boardFixture('pull-request', cards);

const snapshot = (over: Partial<NowSnapshot> = {}): NowSnapshot => ({
  version: 3,
  boards: [board([])],
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 0, fresh: 0, newest: null },
  ...over,
});

describe('the waiting count', () => {
  it('counts the cards of the current project, which is all Now shows', () => {
    const now = snapshot({ project: 1, boards: [board([cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), cardFixture({ key: 'APP-2', stage: 'plan', state: 'running' })])] });

    expect(waitingCount(now)).toBe(1);
  });

  it('counts nothing before the first snapshot', () => {
    expect(waitingCount(null)).toBeNull();
  });
});

describe('the write address', () => {
  it('names the project when the snapshot knows it, and is the plain address when it does not', () => {
    expect(projectPath('/api/board/move', 2)).toBe('/api/board/move?project=2');
    expect(projectPath('/api/card/APP-1/answer', undefined)).toBe('/api/card/APP-1/answer');
  });
});
