import { expect, it } from 'vitest';
import { type EvidenceBlock, type EvidenceDay, evidenceDays, type EvidenceSource } from './evidence.ts';
import { spendOf } from './spend.ts';
import { NO_BLOCKED, NO_STANDUP, NO_TODAY, previousWorkingDay, STANDUP_SHORT, type StandupCard, standupLists, standupText, standupTextOf } from './standup.ts';

// One day, pinned, because the text names the day it was built from. A Wednesday, so the standup
// that reads it is on the Thursday after. The words on a block are the
// gatherer's own, so they are written here the way it writes them and not invented shorter.
const DAY = '2026-03-04';

const block = (at: string, source: EvidenceSource, ref: string, description: string, over: Partial<EvidenceBlock> = {}): EvidenceBlock => ({
  start: `${DAY}T${at}Z`,
  source,
  ref,
  card: 'APP-1',
  cardTitle: 'Add a search box',
  description,
  durationMs: null,
  spend: null,
  running: false,
  ...over,
});

// Through the fold first, so the fixture cannot drift away from the order the screen shows. The fold
// is also what the route hands the panel.
const dayOf = (blocks: readonly EvidenceBlock[], problem: string | null = null): EvidenceDay => ({
  ...(evidenceDays(blocks)[0] ?? { day: DAY, blocks: [], spend: spendOf([]) }),
  problem,
});

const TODAY = '2026-03-05';

// The standup of the day after, with the board as given. Today and Blocked have tests of their own,
// so the Yesterday tests below cut the text at the end of that section.
const standupOf = (day: EvidenceDay, cards: readonly StandupCard[] = []) => standupText({ day: TODAY, yesterday: day, cards });
const yesterdayOf = (day: EvidenceDay) => standupOf(day).split('\n\nToday:')[0] ?? '';

const other = { card: 'APP-2', cardTitle: 'Fix the login redirect' };
const nobody = { card: null, cardTitle: null };

// The main case: the text names the cards that moved and the runs that ran, in the order
// they happened, under the one card they belong to.
it('names both moves, all three runs and the commit of a day', () => {
  const text = yesterdayOf(
    dayOf([
      block('09:00:00.000', 'move', '1', 'Moved from Inbox to Implement'),
      block('09:00:01.000', 'run', '1', 'Implement run, finished'),
      block('12:10:00.000', 'move', '2', 'Moved from Implement to QA'),
      block('12:10:02.000', 'run', '2', 'QA run, passed'),
      block('14:45:00.000', 'run', '3', 'Wrap-up run, finished'),
      block('16:20:00.000', 'commit', 'a1b2c3d', 'feat(search): add the search box'),
    ]),
  );

  expect(text).toBe(
    [
      'Standup, 2026-03-05, the UTC day',
      '',
      'Yesterday (Wednesday 2026-03-04):',
      'APP-1, Add a search box',
      '- move: Moved from Inbox to Implement',
      '- run: Implement run, finished',
      '- move: Moved from Implement to QA',
      '- run: QA run, passed',
      '- run: Wrap-up run, finished',
      '- commit a1b2c3d: feat(search): add the search box',
    ].join('\n'),
  );
});

// A run that failed and a run still going both stay on the list, in place, with the word the gatherer
// wrote on them. A standup that reports either as work delivered is a lie, and one that drops them
// hides work that happened.
it('calls a failed run failed and an unfinished run still going', () => {
  const text = yesterdayOf(
    dayOf([
      block('10:00:00.000', 'run', '1', 'QA run, failed'),
      block('11:00:00.000', 'run', '2', 'Implement run, still going', { ...other, running: true }),
    ]),
  );

  expect(text).toBe(
    [
      'Standup, 2026-03-05, the UTC day',
      '',
      'Yesterday (Wednesday 2026-03-04):',
      'APP-1, Add a search box',
      '- run: QA run, failed',
      'APP-2, Fix the login redirect',
      '- run: Implement run, still going',
    ].join('\n'),
  );
});

// A commit on no card branch, a maintenance run and a run whose card was deleted: none of them can be
// put under a card without inventing an owner, so they share the last group.
it('puts the blocks with no card in the last group', () => {
  const text = yesterdayOf(
    dayOf([
      block('08:00:00.000', 'run', '1', 'Optimize run for maintenance, finished', nobody),
      block('09:00:00.000', 'run', '2', 'Implement run, finished'),
      block('10:00:00.000', 'run', '3', 'Implement run for APP-9, finished', nobody),
      block('11:00:00.000', 'commit', '9f8e7d6', 'chore: bump the lockfile', nobody),
    ]),
  );

  expect(text).toBe(
    [
      'Standup, 2026-03-05, the UTC day',
      '',
      'Yesterday (Wednesday 2026-03-04):',
      'APP-1, Add a search box',
      '- run: Implement run, finished',
      // The literal, not the constant. Asserting NO_CARD_GROUP against itself cannot fail, so the
      // words a person reads at the head of that group had no test at all.
      'Not on a card',
      '- run: Optimize run for maintenance, finished',
      '- run: Implement run for APP-9, finished',
      '- commit 9f8e7d6: chore: bump the lockfile',
    ].join('\n'),
  );
});

// Drawn as an empty day the text would tell a team nothing happened on a day somebody worked, so the
// day that could not be read whole says so. The full sentence carries the project folder path and
// stays on the screen, where the one person who can fix it reads it.
it('says the list is short when the day could not be read whole', () => {
  const text = yesterdayOf(dayOf([block('09:00:00.000', 'run', '1', 'Implement run, finished')], 'The commits of this day could not be read from /some/folder. Check the folder is still a git repository.'));

  expect(text).toContain(STANDUP_SHORT);
  expect(text).not.toContain('/some/folder');
  expect(text.split('\n')[3]).toBe(STANDUP_SHORT);
});

// An empty day says so rather than leaving a heading with nothing under it. Each of
// the three sections has its own sentence, so a team reads which one is empty.
it('says so under every heading of an empty standup', () => {
  expect(standupOf({ day: DAY, blocks: [], spend: spendOf([]), problem: null })).toBe(
    [
      'Standup, 2026-03-05, the UTC day',
      '',
      'Yesterday (Wednesday 2026-03-04):',
      'Nothing recorded on this day.',
      '',
      'Today:',
      'No card in progress.',
      '',
      'Blocked:',
      'Nothing is waiting on an answer.',
    ].join('\n'),
  );
});

// The literals, the way the group heading above is written out. Both of the checks that read these
// two build what they expect out of the same constant, so a sentence that told a team nothing would
// pass them, and these two lines are read by people who have never seen Nolzu.
it('writes out the sentences a thin day sends to a team', () => {
  expect(NO_STANDUP).toBe('Nothing recorded on this day.');
  expect(NO_TODAY).toBe('No card in progress.');
  expect(NO_BLOCKED).toBe('Nothing is waiting on an answer.');
  expect(STANDUP_SHORT).toBe('The commits of this day could not be read, so this list is short of them.');
});

// Nothing in the text comes from the clock or from the order the rows arrived in, so the same day
// gives the same words every time a person opens the screen.
it('gives the same text for the same day twice', () => {
  const blocks = [
    block('12:10:00.000', 'move', '2', 'Moved from Implement to QA'),
    block('09:00:00.000', 'run', '1', 'Implement run, finished', nobody),
    block('16:20:00.000', 'commit', 'a1b2c3d', 'feat(search): add the search box'),
  ];

  expect(yesterdayOf(dayOf(blocks))).toBe(yesterdayOf(dayOf([...blocks].reverse())));
});

// A card with no title is a card a hand edit left without one. Its key still names the group, because
// a group heading of nothing names nobody.
it('falls back to the card key when a card has no title', () => {
  const text = yesterdayOf(dayOf([block('09:00:00.000', 'run', '1', 'Implement run, finished', { cardTitle: null })]));

  expect(text).toContain('\nAPP-1\n- run: Implement run, finished');
});

// A title and a commit subject are written outside this module, so neither may add a line to a text
// somebody sends to their team. The forged heading is the case that matters: a subject of its own on
// a fresh line reads as another card.
it('keeps a card title on one line', () => {
  const text = yesterdayOf(
    dayOf([block('09:00:00.000', 'run', '1', 'Implement run, finished', { cardTitle: 'Add a search box\nAPP-9, Ship it' })]),
  );

  expect(text).toContain('APP-1, Add a search box APP-9, Ship it');
  expect(text).not.toContain('\nAPP-9, Ship it');
});

it('keeps a commit subject on one line', () => {
  const text = yesterdayOf(
    dayOf([block('09:00:00.000', 'commit', 'a1b2c3d', 'Add the search box\r\n- run: nothing of the sort happened')]),
  );

  expect(text).toContain('- commit a1b2c3d: Add the search box - run: nothing of the sort happened');
  // Two lines under the heading would be two blocks, and this day holds one.
  expect(text.split('\n').filter((one) => one.startsWith('- '))).toHaveLength(1);
});

// Not every card key is shape checked on the way in: `scoutFindingToCard` writes an adapter's own key
// straight through, so a ticket system that answers with a newline in its key reaches this heading.
it('keeps a card key on one line', () => {
  const text = yesterdayOf(
    dayOf([block('09:00:00.000', 'run', '1', 'Implement run, finished', { card: 'APP-1\nAPP-9, Ship it', cardTitle: null })]),
  );

  expect(text).toContain('APP-1 APP-9, Ship it');
  expect(text).not.toContain('\nAPP-9, Ship it');
});

// A standup on Monday is about Friday, and the heading names the weekday so a team
// reads that too. Saturday and Sunday are not working days, so they read Friday as well.
it('reads Friday as yesterday on a Monday and over the weekend', () => {
  expect(previousWorkingDay('2026-03-09')).toBe('2026-03-06');
  expect(previousWorkingDay('2026-03-08')).toBe('2026-03-06');
  expect(previousWorkingDay('2026-03-07')).toBe('2026-03-06');
  expect(previousWorkingDay('2026-03-10')).toBe('2026-03-09');
  expect(previousWorkingDay('2026-03-06')).toBe('2026-03-05');
  // Over a month and a year, where a day count by hand goes wrong.
  expect(previousWorkingDay('2026-03-02')).toBe('2026-02-27');
  expect(previousWorkingDay('2027-01-01')).toBe('2026-12-31');

  const friday = { day: '2026-03-06', blocks: [], spend: spendOf([]), problem: null };
  expect(standupText({ day: '2026-03-09', yesterday: friday, cards: [] })).toContain('\n\nYesterday (Friday 2026-03-06):\n');
});

const card = (key: string, title: string, stage: string, blocked = false): StandupCard => ({ key, title, stage, blocked });

// A card blocked on a question is under Blocked and not under Today. Today keeps the
// order the gatherer gave.
it('puts a card waiting on a question under Blocked and not under Today', () => {
  const text = standupOf(dayOf([block('09:00:00.000', 'run', '1', 'Implement run, finished')]), [
    card('APP-1', 'Add a search box', 'Implement'),
    card('APP-2', 'Fix the login redirect', 'Plan', true),
    card('APP-3', 'Sort the recipes', 'Review'),
  ]);

  expect(text.split('\n\nToday:')[1]).toBe(
    ['', '- APP-1, Add a search box (Implement)', '- APP-3, Sort the recipes (Review)', '', 'Blocked:', '- APP-2, Fix the login redirect (Plan)'].join('\n'),
  );
});

// Every card field is written outside this module, so none of them may add a line to the text.
it('keeps a card on one line under Today and Blocked', () => {
  const text = standupOf(dayOf([]), [card('APP-1', 'Add a box\nAPP-9, Ship it', 'Implement'), card('APP-2\nAPP-8', 'Fix', 'Plan\nDone', true)]);

  expect(text).toContain('- APP-1, Add a box APP-9, Ship it (Implement)');
  expect(text).toContain('- APP-2 APP-8, Fix (Plan Done)');
  expect(text).not.toContain('\nAPP-9');
});

// The screen draws the standup as three labelled lists. They are cut from the same lines as the
// text, and put back together they are the text, so the boxes and Copy can never disagree.
it('cuts the standup into Yesterday, Today and Blocked, and joins them back into the same text', () => {
  const standup = {
    day: '2026-03-09',
    yesterday: { day: '2026-03-06', blocks: [block('09:00:00.000', 'run', '1', 'Implement run, finished', { start: '2026-03-06T09:00:00.000Z' })], spend: spendOf([]), problem: null },
    cards: [card('APP-1', 'Add a search box', 'Implement'), card('APP-2', 'Fix the login redirect', 'Plan', true)],
  };
  const lists = standupLists(standup);

  expect(lists).toEqual({
    day: '2026-03-09',
    yesterdayDay: '2026-03-06',
    yesterdayLabel: 'Fri 6 Mar',
    yesterday: 'APP-1, Add a search box\n- run: Implement run, finished',
    today: '- APP-1, Add a search box (Implement)',
    blocked: '- APP-2, Fix the login redirect (Plan)',
  });
  expect(standupTextOf(lists)).toBe(standupText(standup));
  expect(standupLists({ ...standup, cards: [] })).toMatchObject({ today: NO_TODAY, blocked: NO_BLOCKED });
});
