import { type BoardSnapshot, type EvidenceBlock, evidenceDays, spendOf } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { dayLabel, dayShift, dayStats, laneStates, timelineOf, weekEvidence, weekLabel, weekTimelineOf } from './evidence-timeline.ts';

// One day, pinned. Every stamp is UTC, the day `evidenceFor` folds by.
const DAY = '2026-03-04';
const at = (clock: string) => `${DAY}T${clock}:00.000Z`;

// A block the way `evidenceFor` hands it over. A run carries its spend, a move and a commit none.
function block(over: Partial<EvidenceBlock> & Pick<EvidenceBlock, 'start' | 'source' | 'ref'>): EvidenceBlock {
  return { card: 'APP-11', cardTitle: 'Sort recipes by cooking time', description: 'A block', durationMs: null, spend: null, running: false, ...over };
}

function run(ref: string, start: string, minutes: number | null, over: Partial<EvidenceBlock> = {}): EvidenceBlock {
  const durationMs = minutes === null ? null : minutes * 60_000;
  return block({ ref, start: at(start), source: 'run', durationMs, spend: spendOf([{ costUsd: over.running ? null : 0.1, durationMs, tokens: null }]), ...over });
}

// The fold the screen gets its day from, so a fixture cannot drift from the real shape.
const dayOf = (blocks: EvidenceBlock[]) => evidenceDays(blocks)[0] ?? { day: DAY, blocks: [], spend: spendOf([]), problem: null };

const APP_9 = { card: 'APP-9', cardTitle: 'Add a search box' };

// The case the plan names: lanes from fixture blocks.
const fixture = () =>
  dayOf([
    block({ ref: '1', start: at('09:28'), source: 'move', description: 'Moved from Implement to QA' }),
    run('11', '09:39', 9, { description: 'QA run, passed' }),
    block({ ref: 'a1b2c3d', start: at('10:12'), source: 'commit', description: 'feat: sort by time' }),
    run('12', '10:49', 5, { description: 'Wrap-up run, finished' }),
    run('13', '12:00', 3.5, { ...APP_9, description: 'Refine run, finished' }),
    run('14', '12:04', 1.2, { ...APP_9, description: 'Plan run, finished' }),
    run('15', '15:00', 5, { card: null, cardTitle: null, description: 'Optimize run for maintenance, finished' }),
  ]);

it('draws one lane per card from the blocks, in key order, with the work on no card last', () => {
  const line = timelineOf(fixture(), null);

  // APP-9 before APP-11: keys are read as numbers, the way a person counts them.
  expect(line.lanes.map((lane) => [lane.card, lane.title])).toEqual([
    ['APP-9', 'Add a search box'],
    ['APP-11', 'Sort recipes by cooking time'],
    [null, null],
  ]);
  // The axis runs from the hour of the first block to the hour after the last one ends: 09:00 to
  // 16:00, seven hours, so one minute is 100 / 420 of the width.
  expect(line.hours.map((hour) => hour.label)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  expect(line.hours.at(-1)?.at).toBe(100);

  const app11 = line.lanes[1]!;
  expect(app11.moves.map((mark) => [mark.block.ref, mark.at])).toEqual([['1', 6.667]]);
  expect(app11.commits.map((mark) => [mark.block.ref, mark.at])).toEqual([['a1b2c3d', 17.143]]);
  // Two runs an hour apart are two groups.
  expect(app11.runs.map((group) => [group.at, group.runs.map((one) => one.ref)])).toEqual([
    [9.286, ['11']],
    [25.952, ['12']],
  ]);
  // Refine and Plan four minutes apart sit side by side in one group, and do not overlap.
  expect(line.lanes[0]!.runs.map((group) => [group.at, group.runs.map((one) => one.ref)])).toEqual([[42.857, ['13', '14']]]);
  // The maintenance run has its own lane and keeps its block.
  expect(line.lanes[2]!.runs.map((group) => group.runs.map((one) => one.ref))).toEqual([['15']]);
  // A day that is over has no now line.
  expect(line.now).toBeNull();
});

it('puts now on the axis of today, and lets a running run reach it', () => {
  const day = dayOf([run('1', '14:50', 5), run('2', '15:31', null, { running: true })]);

  const line = timelineOf(day, at('17:40'));

  // The axis reaches the hour after now, so the line sits on it.
  expect(line.hours.map((hour) => hour.label)).toEqual(['14:00', '15:00', '16:00', '17:00', '18:00']);
  expect(line.now).toBe(91.667);
  expect(line.nowLabel).toBe('17:40');
  // A now from another day is not this day's now.
  expect(timelineOf(day, '2026-03-05T09:00:00.000Z').now).toBeNull();
});

it('labels every second hour on a long day, so the ruler does not crowd', () => {
  const line = timelineOf(dayOf([run('1', '01:00', 5), run('2', '22:30', 20)]), null);

  expect(line.hours.map((hour) => hour.label)).toEqual(['01:00', '03:00', '05:00', '07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00']);
});

it('draws no lane for a day with no block', () => {
  expect(timelineOf(dayOf([]), at('10:00')).lanes).toEqual([]);
});

it('fills the four tiles from the day, and says so where there is no figure', () => {
  const day = dayOf([
    block({ ref: '1', start: at('09:00'), source: 'move' }),
    block({ ref: '2', start: at('09:30'), source: 'move' }),
    block({ ref: '3', start: at('10:00'), source: 'move', ...APP_9 }),
    run('4', '09:01', 20),
    run('5', '10:01', 27, APP_9),
    run('6', '11:00', null, { running: true }),
  ]);

  expect(dayStats(day)).toEqual([
    { label: 'Agent time', value: '47m 00s', note: '2 cards', live: false },
    { label: 'Runs', value: '3', note: '1 running', live: true },
    { label: 'Cards moved', value: '2', note: '3 moves', live: false },
    // The running run reported no cost yet, so the figure covers two of three.
    { label: 'Cost', value: '$0.20', note: 'estimated value, not every run reported one', live: false },
  ]);
});

it('makes up no figure on an empty day', () => {
  expect(dayStats(dayOf([]))).toEqual([
    { label: 'Agent time', value: null, note: 'No run on this day', live: false },
    { label: 'Runs', value: '0', note: 'None on this day', live: false },
    { label: 'Cards moved', value: '0', note: 'No card moved', live: false },
    { label: 'Cost', value: null, note: 'No run on this day', live: false },
  ]);
});

it('says tokens only when the engine reported no cost, and no time when no run timed itself', () => {
  const tokens = { input: 1200, output: 300, cacheRead: 0, cacheCreation: 0 };
  const day = dayOf([block({ ref: '1', start: at('09:00'), source: 'run', spend: spendOf([{ costUsd: null, durationMs: null, tokens }]) })]);

  const [time, , , cost] = dayStats(day);
  expect(time).toEqual({ label: 'Agent time', value: null, note: 'No run reported its time', live: false });
  expect(cost).toEqual({ label: 'Cost', value: '1.5k tokens', note: 'tokens only, no cost reported', live: false });
});

it('writes the day and the week the way the top bar and the timesheet head read them', () => {
  expect(dayLabel('2026-10-11')).toBe('Sun 11 Oct');
  expect(weekLabel('2026-10-05', '2026-10-11')).toBe('5 to 11 Oct');
  expect(weekLabel('2026-09-28', '2026-10-04')).toBe('28 Sep to 4 Oct');
  expect(dayShift('2026-03-01', -1)).toBe('2026-02-28');
  expect(dayShift('2026-12-31', 1)).toBe('2027-01-01');
});

it('reads each lane state off the board snapshot, and a card in the archive as closed', () => {
  const card = (key: string, stage: string, state: string, verdict: string | null = null) => ({ key, stage, state, verdict, runStartedAt: null, queuePosition: null, pull: null });
  const boards = [
    {
      stages: [
        { id: 'qa', role: 'agent' },
        { id: 'done', role: 'archive' },
      ],
      cards: [card('APP-11', 'done', 'idle'), card('APP-14', 'qa', 'ready'), card('APP-16', 'qa', 'ready', 'FAIL'), card('APP-18', 'qa', 'running')],
    },
  ] as unknown as BoardSnapshot[];

  const states = laneStates(boards);

  expect(states['APP-11']).toEqual({ state: 'idle', word: 'Closed', closed: true });
  expect(states['APP-14']).toEqual({ state: 'ready', word: 'Ready for you', closed: false });
  // QA's FAIL ends its run as complete, and a person reads a failed card, the way the board says it.
  expect(states['APP-16']).toEqual({ state: 'failed', word: 'QA failed', closed: false });
  expect(states['APP-18']).toEqual({ state: 'running', word: 'Running', closed: false });
});

// The Week view sums the seven days Mon to Sun into one stretch of evidence, and draws its
// timeline over the seven days with one label per day.
it('sums a week of days into one, and draws its timeline over Mon to Sun', () => {
  const monday = { day: '2026-03-02', blocks: [], spend: spendOf([]), problem: null };
  const days = [monday, fixture(), { ...dayOf([run('20', '08:00', 10)].map((one) => ({ ...one, start: '2026-03-06T08:00:00.000Z' }))), day: '2026-03-06' }];
  const week = weekEvidence('2026-03-02', days);

  expect(week.day).toBe('2026-03-02');
  expect(week.blocks).toHaveLength(8);
  expect(week.spend.runs).toBe(6);
  expect(week.problem).toBeNull();
  expect(weekEvidence('2026-03-02', [{ ...monday, problem: 'git said no.' }]).problem).toBe('git said no.');

  const line = weekTimelineOf(week, '2026-03-04T12:00:00.000Z');
  expect(line.hours.map((hour) => hour.label)).toEqual(['Mon 2', 'Tue 3', 'Wed 4', 'Thu 5', 'Fri 6', 'Sat 7', 'Sun 8']);
  expect(line.hours.map((hour) => Math.round(hour.at))).toEqual([0, 14, 29, 43, 57, 71, 86]);
  // Wednesday noon is two and a half days into seven.
  expect(line.now).toBeCloseTo(35.714, 2);
  expect(line.lanes.map((lane) => lane.card)).toEqual(['APP-9', 'APP-11', null]);
  expect(weekTimelineOf(week, '2026-03-20T12:00:00.000Z').now).toBeNull();
  expect(weekTimelineOf(weekEvidence('2026-03-02', [monday]), null).lanes).toEqual([]);
});

it('says this week and not this day on the tiles of an empty week', () => {
  const empty = { day: '2026-03-02', blocks: [], spend: spendOf([]), problem: null };

  expect(dayStats(empty, 'week').map((stat) => stat.note)).toEqual(['No run this week', 'None this week', 'No card moved', 'No run this week']);
  expect(dayStats(empty).map((stat) => stat.note)).toEqual(['No run on this day', 'None on this day', 'No card moved', 'No run on this day']);
});
