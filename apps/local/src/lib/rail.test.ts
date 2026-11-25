import { DEFAULT_PROFILE, type EngineProfile, type ProfileLimit } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { busyOf, homePath, projectLine, type ProjectChoice, railBoards, railCounts, railUsage, repoLine, repoNames, selectorRows } from './rail.ts';

// The pure half of the rail. What it draws is in rail-render.test.ts, because a file system that
// ignores case would read Rail.test.ts as this file.

describe('the boards in the rail', () => {
  // One Research item where Investigations and Questions stood.
  it('lists Delivery first and every board that is on, in the words the product uses', () => {
    expect(railBoards('/knowledge', undefined, null)).toEqual([
      { kind: 'delivery', label: 'Delivery', current: false },
      { kind: 'epics', label: 'Epics', current: false },
      { kind: 'research', label: 'Research', current: false },
      { kind: 'prreview', label: 'PR reviews', current: false },
    ]);
  });

  // A board turned off leaves the rail until it is on again. Delivery is never off, and Research is off
  // with both its kinds.
  it('leaves a board that is off out', () => {
    expect(railBoards('/', undefined, null, ['epics', 'prreview']).map((one) => one.kind)).toEqual(['delivery', 'research']);
    expect(railBoards('/', undefined, null, ['questions', 'investigations']).map((one) => one.kind)).toEqual(['delivery', 'epics', 'prreview']);
  });

  it.each([
    // `/` is Now, which is no board.
    ['/', undefined, null, null],
    ['/b/[board]', 'delivery', null, 'delivery'],
    ['/b/[board]', 'epics', null, 'epics'],
    ['/b/[board]', 'prreview', null, 'prreview'],
    ['/b/research', undefined, null, 'research'],
    // A card page marks the board its card is on, and Research for
    // either of its kinds.
    ['/t/[key]/[tab]', undefined, 'questions', 'research'],
    ['/t/[key]/[tab]', undefined, 'investigations', 'research'],
    ['/t/[key]/[tab]', undefined, 'delivery', 'delivery'],
    ['/knowledge', undefined, null, null],
    [null, undefined, null, null],
  ] as const)('marks on %j with board %j and card board %j the board %j, and only that one', (routeId, board, card, want) => {
    const marked = railBoards(routeId, board, card).filter((one) => one.current);

    expect(marked.map((one) => one.kind)).toEqual(want === null ? [] : [want]);
  });

  // The off page of a board says it is off, and the rail has no link for it to mark.
  it('marks nothing on the page of a board that is off', () => {
    expect(railBoards('/b/[board]', 'epics', null, ['epics']).some((one) => one.current)).toBe(false);
  });
});

// "Delivery 9" and "Epics 2", off the board snapshots the Now stream carries.
describe('the board counts in the rail', () => {
  it('counts the cards not in an archive column, as the board title does', () => {
    const delivery = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' }), cardFixture({ key: 'APP-2', stage: 'plan' }), cardFixture({ key: 'APP-3', stage: 'closed' })]);

    expect(railCounts([delivery])).toEqual({ delivery: 2 });
  });

  // Research is one rail item for its two kinds, so it counts both.
  it('counts Research once for questions and investigations together', () => {
    const board = boardFixture('pull-request', [cardFixture({ key: 'APP-4', stage: 'inbox' })]);
    const epics = { ...board, kind: 'epics' as const, cards: [] };

    expect(railCounts([board, epics, { ...board, kind: 'questions' }, { ...board, kind: 'investigations' }])).toEqual({ delivery: 1, epics: 0, research: 2 });
  });

  // Before the stream's first event there is no number to show.
  it('counts nothing before the stream answers', () => {
    expect(railCounts(null)).toEqual({});
  });
});

describe('the project selector', () => {
  it('names the repositories by folder, and the project folder by the project', () => {
    expect(repoNames([{ path: '.' }], 'recipes')).toEqual(['recipes']);
    expect(repoNames([{ path: 'api' }, { path: 'web' }], 'recipes')).toEqual(['api', 'web']);
    expect(repoNames([], 'recipes')).toEqual([]);
  });

  it('counts the repositories in words', () => {
    expect(repoLine(1)).toBe('1 repository');
    expect(repoLine(2)).toBe('2 repositories');
    // An empty workspace is a real state, and "0 repositories" reads as a fault.
    expect(repoLine(0)).toBe('No repository yet');
  });

  it('writes the home folder as ~, and leaves any other path as it is', () => {
    expect(homePath('/home/cook/nolzu/recipes', '/home/cook')).toBe('~/nolzu/recipes');
    expect(homePath('/home/cook', '/home/cook')).toBe('~');
    expect(homePath('/home/cook/', '/home/cook/')).toBe('~');
    expect(homePath('/home/cooking/recipes', '/home/cook')).toBe('/home/cooking/recipes');
    expect(homePath('/srv/recipes', '/home/cook')).toBe('/srv/recipes');
    expect(homePath('/srv/recipes', '')).toBe('/srv/recipes');
  });
});

// The selector lists every project, the busiest first, each with the count of cards waiting on the
// person off its own boards.
describe('the projects in the selector', () => {
  const card = (state: 'idle' | 'queued' | 'running' | 'ready' | 'blocked' | 'failed', finished?: boolean) => ({ state, finished });
  const choice = (id: number, waiting: number | null, running: number | null, current = false): ProjectChoice => ({ id, name: `p${id}`, repos: 1, waiting, running, current });

  it('counts the cards waiting on the person the way Now does, and the cards an agent runs', () => {
    const boards = [{ cards: [card('blocked'), card('ready'), card('running'), card('queued')] }, { cards: [card('failed'), card('idle', true), card('running'), card('idle')] }];

    expect(busyOf(boards)).toEqual({ waiting: 4, running: 2 });
    expect(busyOf([])).toEqual({ waiting: 0, running: 0 });
  });

  it('puts the busiest first: the most waiting, then the most running, then the order they were made', () => {
    const rows = selectorRows([choice(1, 0, 0, true), choice(2, 2, 0), choice(3, 0, 1), choice(4, 3, 0), choice(5, 2, 1), choice(6, 0, 0)]);

    expect(rows.map((one) => one.id)).toEqual([4, 5, 2, 3, 1, 6]);
  });

  // The Now count beside the selector is live, so the current project's row is the same number.
  it('counts the current project off the live Now stream, and the others as the page load read them', () => {
    const live = [{ cards: [card('ready'), card('ready'), card('ready'), card('running')] }];
    const rows = selectorRows([choice(1, 0, 0, true), choice(2, 2, 0)], live);

    expect(rows.map((one) => [one.id, one.waiting, one.running])).toEqual([
      [1, 3, 1],
      [2, 2, 0],
    ]);
    // Before the stream answers, the page load's counts stand.
    expect(selectorRows([choice(1, 1, 0, true)], null)[0]).toMatchObject({ waiting: 1, running: 0 });
  });

  // Free reads no board but the open project's, so its rows carry no counts and stay in the order they
  // were made.
  it('keeps rows with no counts in the order they were made, and lists none when it has none', () => {
    expect(selectorRows([choice(3, null, null), choice(1, null, null, true), choice(2, null, null)], [{ cards: [card('ready')] }]).map((one) => [one.id, one.waiting])).toEqual([
      [1, null],
      [2, null],
      [3, null],
    ]);
    expect(selectorRows()).toEqual([]);
  });

  it('says how many repositories a project has, and how many cards run in it', () => {
    expect(projectLine({ repos: 2, running: 2 })).toBe('2 repositories · 2 running');
    expect(projectLine({ repos: 1, running: 0 })).toBe('1 repository');
    expect(projectLine({ repos: 0, running: null })).toBe('No repository yet');
  });
});

describe('the usage foot', () => {
  const SEEN = Date.UTC(2026, 9, 11, 14, 20);
  const RESET = Date.UTC(2026, 9, 11, 19, 0) / 1000;
  const reading = (windows: ProfileLimit['windows']): Record<string, ProfileLimit> => ({ 'claude-code': { seenAt: SEEN, windows } });
  const five = (used: number | null, resetsAt: number | null = RESET) => ({ name: 'five_hour', used, resetsAt, status: 'allowed' });

  it('shows the five-hour window of the first profile, with when it was seen', () => {
    expect(railUsage([DEFAULT_PROFILE], reading([five(0.62), { name: 'seven_day', used: 0.2, resetsAt: null, status: null }]), 'UTC')).toEqual({
      label: 'Claude Code',
      share: 62,
      resets: '11 Oct, 19:00',
      seen: '11 Oct, 14:20',
    });
  });

  it('says nothing of a reset time the engine did not report', () => {
    expect(railUsage([DEFAULT_PROFILE], reading([five(1, null)]), 'UTC')).toMatchObject({ share: 100, resets: null });
  });

  // The number is the last one seen. With nothing seen there is no number, and a made-up 0% would read
  // as a measurement.
  it.each([
    ['no profile', [], reading([five(0.5)])],
    ['no reading', [DEFAULT_PROFILE], {}],
    ['no five-hour window', [DEFAULT_PROFILE], reading([{ name: 'seven_day', used: 0.2, resetsAt: null, status: null }])],
    ['a window with no share', [DEFAULT_PROFILE], reading([five(null)])],
    ['an engine that reports no window', [{ id: 'claude-code', label: 'Cursor', vendor: 'cursor', configDir: null } satisfies EngineProfile], reading([five(0.5)])],
  ] as const)('shows nothing for %s', (_name, profiles, limits) => {
    expect(railUsage(profiles, limits, 'UTC')).toBeNull();
  });

  it('reads the first profile only, the one a step with no profile of its own runs on', () => {
    const work: EngineProfile = { id: 'claude-code#work', label: 'Work', vendor: 'claude-code', configDir: '/w' };

    expect(railUsage([work, DEFAULT_PROFILE], reading([five(0.5)]), 'UTC')).toBeNull();
  });
});
